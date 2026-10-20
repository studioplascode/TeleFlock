//! `herdr terminal session control|observe`: the JSON-lines terminal bridge
//! (stdout = base64 ANSI frames, stdin = input/resize/scroll/release).

use crate::api::ScrollDirection;
use crate::client::HerdrClient;
use crate::error::{HerdrError, Result, code};
use crate::transport;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

/// How long `terminal_session` waits for the first frame (or a startup error).
pub const TERMINAL_START_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalMode {
    /// The single writable owner: resizes the real PTY and accepts input.
    #[default]
    Control,
    /// Read-only; crops the viewport to its own size from the top-left. Unlimited.
    Observe,
}

/// Options for [`HerdrClient::terminal_session`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalOptions {
    /// Pane id, agent name or terminal id.
    pub target: String,
    pub mode: TerminalMode,
    pub cols: u16,
    pub rows: u16,
    /// Control only: evict the current owner (it gets `Closed{reason:"terminal attach taken over"}`).
    pub takeover: bool,
}

impl TerminalOptions {
    pub fn new(target: impl Into<String>, mode: TerminalMode, cols: u16, rows: u16) -> Self {
        Self { target: target.into(), mode, cols, rows, takeover: false }
    }
}

/// One re-rendered viewport update. `bytes` is base64 ANSI exactly as herdr sent it
/// (CUP + SGR runs inside synchronized output; `full` frames start with a clear).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalFrame {
    pub seq: u64,
    pub full: bool,
    pub cols: u16,
    pub rows: u16,
    pub bytes: String,
}

impl TerminalFrame {
    pub fn decode(&self) -> Result<Vec<u8>> {
        B64.decode(&self.bytes).map_err(|e| HerdrError::protocol("terminal frame base64", e))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalEvent {
    Frame(TerminalFrame),
    /// Terminal end. Always the last event. Reasons from herdr: `detached`,
    /// `terminal attach taken over`, ...; otherwise the process exit / stderr text.
    Closed { reason: String },
}

#[derive(Deserialize)]
struct WireLine {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    seq: u64,
    #[serde(default)]
    full: bool,
    #[serde(default)]
    width: u16,
    #[serde(default)]
    height: u16,
    #[serde(default)]
    bytes: String,
    #[serde(default)]
    reason: Option<String>,
}

/// Parse one stdout line of `terminal session`. `None` for unknown line types.
pub fn parse_terminal_line(line: &str) -> Result<Option<TerminalEvent>> {
    let w: WireLine = serde_json::from_str(line).map_err(|e| HerdrError::protocol("terminal line", e))?;
    Ok(match w.kind.as_str() {
        "terminal.frame" => {
            Some(TerminalEvent::Frame(TerminalFrame { seq: w.seq, full: w.full, cols: w.width, rows: w.height, bytes: w.bytes }))
        }
        "terminal.closed" => Some(TerminalEvent::Closed { reason: w.reason.unwrap_or_else(|| "closed".into()) }),
        _ => None,
    })
}

enum InputMsg {
    Line(Vec<u8>),
    Release,
}

/// Input side of a terminal session. Clone freely; the session detaches when every
/// clone is dropped (stdin EOF) or on [`release`](Self::release).
#[derive(Clone)]
pub struct TerminalInput {
    tx: mpsc::UnboundedSender<InputMsg>,
    mode: TerminalMode,
}

impl TerminalInput {
    fn send(&self, v: serde_json::Value) -> Result<()> {
        if self.mode == TerminalMode::Observe {
            return Err(HerdrError::new(code::INVALID_REQUEST, "observe terminal sessions are read-only"));
        }
        let mut line = serde_json::to_vec(&v).map_err(|e| HerdrError::protocol("encode terminal input", e))?;
        line.push(b'\n');
        self.tx.send(InputMsg::Line(line)).map_err(|_| HerdrError::transport("terminal input", "session closed"))
    }

    /// Typed text / raw keys (Enter is `\r`).
    pub fn input(&self, text: &str) -> Result<()> {
        self.send(json!({ "type": "terminal.input", "text": text }))
    }

    /// Raw bytes (sent base64).
    pub fn input_bytes(&self, bytes: &[u8]) -> Result<()> {
        self.send(json!({ "type": "terminal.input", "bytes": B64.encode(bytes) }))
    }

    /// Resize the real PTY (control holds a resize lock while attached).
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.send(json!({ "type": "terminal.resize", "cols": cols, "rows": rows, "cell_width_px": 0, "cell_height_px": 0 }))
    }

    /// Host scrollback (xterm.js runs with `scrollback: 0`).
    pub fn scroll(&self, direction: ScrollDirection, lines: u16) -> Result<()> {
        self.send(json!({
            "type": "terminal.scroll", "direction": direction, "lines": lines,
            "source": "wheel", "modifiers": 0
        }))
    }

    /// Detach. The session then ends with `Closed{reason:"detached"}`.
    pub fn release(&self) -> Result<()> {
        self.tx.send(InputMsg::Release).map_err(|_| HerdrError::transport("terminal release", "session closed"))
    }

    pub fn mode(&self) -> TerminalMode {
        self.mode
    }
}

/// A running terminal bridge process. Dropping it (and every `TerminalInput` clone)
/// detaches; the child is killed if it lingers.
pub struct TerminalSession {
    /// Frames, then exactly one final `Closed`.
    pub events: mpsc::Receiver<TerminalEvent>,
    pub input: TerminalInput,
}

impl TerminalSession {
    pub fn split(self) -> (mpsc::Receiver<TerminalEvent>, TerminalInput) {
        (self.events, self.input)
    }
}

/// Turn a dead bridge's stderr into an error (JSON envelope when herdr printed one).
fn stderr_error(stderr: &str, status: Option<std::process::ExitStatus>) -> HerdrError {
    if let Some(line) = stderr.lines().find(|l| l.trim_start().starts_with('{'))
        && let Err(e) = transport::parse_response(line.trim())
    {
        return e;
    }
    let text = stderr.trim();
    let code = if text.contains("--takeover") || text.contains("already has an attached client") {
        code::STREAM_CONFLICT
    } else if text.contains("no herdr server") || text.contains("not running") {
        code::SERVER_NOT_RUNNING
    } else if text.contains("not found") {
        code::NOT_FOUND
    } else {
        code::TRANSPORT
    };
    let msg = match (text.is_empty(), status) {
        (false, _) => text.to_owned(),
        (true, Some(s)) => format!("terminal session exited ({s})"),
        (true, None) => "terminal session ended".into(),
    };
    HerdrError::new(code, msg)
}

impl HerdrClient {
    /// Spawn `herdr [--session S] terminal session control|observe <target> --cols C --rows R
    /// [--takeover]` and wait for its first frame. Startup failures (unknown target,
    /// existing owner without `takeover`, ...) come back as `Err`.
    pub async fn terminal_session(&self, opts: TerminalOptions) -> Result<TerminalSession> {
        let mut cmd = self.cli_command();
        let mode = match opts.mode {
            TerminalMode::Control => "control",
            TerminalMode::Observe => "observe",
        };
        cmd.args(["terminal", "session", mode, &opts.target])
            .args(["--cols", &opts.cols.max(1).to_string(), "--rows", &opts.rows.max(1).to_string()]);
        if opts.takeover && opts.mode == TerminalMode::Control {
            cmd.arg("--takeover");
        }
        cmd.stdin(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| HerdrError::transport("spawn herdr terminal session", e))?;
        let mut stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let mut stderr = child.stderr.take().expect("piped stderr");

        // stderr: keep the first 8 KiB for diagnostics.
        let stderr_task = tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = (&mut stderr).take(8192).read_to_end(&mut buf).await;
            let mut sink = [0u8; 4096];
            while matches!(stderr.read(&mut sink).await, Ok(n) if n > 0) {}
            String::from_utf8_lossy(&buf).into_owned()
        });

        let mut lines = BufReader::new(stdout).lines();

        // Wait for the first frame (or the process dying) before handing out the session.
        let first = tokio::time::timeout(TERMINAL_START_TIMEOUT, async {
            loop {
                match lines.next_line().await {
                    Ok(Some(l)) => match parse_terminal_line(&l) {
                        Ok(Some(ev)) => return Ok(Some(ev)),
                        Ok(None) => continue,
                        Err(e) => log::warn!("bad terminal line: {e}"),
                    },
                    Ok(None) => return Ok(None),
                    Err(e) => return Err(HerdrError::transport("terminal read", e)),
                }
            }
        })
        .await;
        let first = match first {
            Ok(Ok(Some(ev @ TerminalEvent::Frame(_)))) => ev,
            Ok(Ok(Some(TerminalEvent::Closed { reason }))) => {
                let _ = child.kill().await;
                return Err(HerdrError::new(code::STREAM_CONFLICT, reason));
            }
            Ok(Ok(None)) => {
                let status = child.wait().await.ok();
                let err = stderr_task.await.unwrap_or_default();
                return Err(stderr_error(&err, status));
            }
            Ok(Err(e)) => {
                let _ = child.kill().await;
                return Err(e);
            }
            Err(_) => {
                let _ = child.kill().await;
                return Err(HerdrError::timeout("terminal session start"));
            }
        };

        let (ev_tx, ev_rx) = mpsc::channel::<TerminalEvent>(256);
        let (in_tx, mut in_rx) = mpsc::unbounded_channel::<InputMsg>();

        // Writer: forwards input lines; release / all senders gone => release + EOF.
        tokio::spawn(async move {
            while let Some(msg) = in_rx.recv().await {
                match msg {
                    InputMsg::Line(l) => {
                        if stdin.write_all(&l).await.is_err() || stdin.flush().await.is_err() {
                            return;
                        }
                    }
                    InputMsg::Release => break,
                }
            }
            let _ = stdin.write_all(b"{\"type\":\"terminal.release\"}\n").await;
            let _ = stdin.flush().await;
            drop(stdin);
        });

        // Reader: frames out; exactly one Closed at the end; owns (and reaps) the child.
        tokio::spawn(async move {
            if ev_tx.send(first).await.is_err() {
                let _ = child.kill().await;
                return;
            }
            let mut closed: Option<String> = None;
            loop {
                tokio::select! {
                    line = lines.next_line() => match line {
                        Ok(Some(l)) => match parse_terminal_line(&l) {
                            Ok(Some(TerminalEvent::Closed { reason })) => { closed = Some(reason); break; }
                            Ok(Some(ev)) => if ev_tx.send(ev).await.is_err() { let _ = child.kill().await; return; },
                            Ok(None) => {}
                            Err(e) => log::warn!("bad terminal line: {e}"),
                        },
                        _ => break,
                    },
                    _ = ev_tx.closed() => { let _ = child.kill().await; return; }
                }
            }
            let status = match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
                Ok(s) => s.ok(),
                Err(_) => {
                    let _ = child.kill().await;
                    None
                }
            };
            let reason = match closed {
                Some(r) => r,
                None => stderr_error(&stderr_task.await.unwrap_or_default(), status).message,
            };
            let _ = ev_tx.send(TerminalEvent::Closed { reason }).await;
        });

        Ok(TerminalSession { events: ev_rx, input: TerminalInput { tx: in_tx, mode: opts.mode } })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stderr_mapping() {
        let e = stderr_error(
            "terminal attach failed: terminal term_1 already has an attached client; retry with --takeover",
            None,
        );
        assert_eq!(e.code, code::STREAM_CONFLICT);
        let e = stderr_error(r#"{"error":{"code":"pane_not_found","message":"pane w9:p9 not found"},"id":"cli"}"#, None);
        assert_eq!(e.code, "pane_not_found");
    }
}
