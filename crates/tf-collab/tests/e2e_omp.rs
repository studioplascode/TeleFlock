//! Real end-to-end run against a stock omp TUI in the lab herdr session `tf-lab-hc`.
//!
//! ```text
//! CARGO_TARGET_DIR=target/HostdCollab cargo test -p tf-collab --test e2e_omp -- --ignored --nocapture
//! ```
//!
//! 1. starts the Rust relay on a lab port (`TF_HC_RELAY_PORT`, default 47588);
//! 2. starts omp in a lab pane with a per-process overlay pointing at it (cheap model);
//! 3. discovers the room through the registry IPC and joins with the Rust guest;
//! 4. a prompt streams `append` events; 5. a bash tool row renders;
//! 6. an ask is answered through `ui_response`; 7. an abort ends the turn.
//!
//! Never touches the default herdr session or `~/.omp/agent/config.yml`. The lab session is
//! stopped and deleted at the end (also on failure).

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;
use tf_collab::{Access, Guest, GuestEvent, Registry, Relay, RelayConfig, Replica, Signal};
use tf_proto::{Answer, AppendField, SessionEvent, ToolStatus, ToolView, TranscriptItem};

const SESSION: &str = "tf-lab-hc";
const WORK: &str = "/tmp/tf-hc-work";
const RUN: &str = "/tmp/tf-hc-run";
const MODEL: &str = "openai-codex/gpt-6-luna:low";

fn herdr(args: &[&str]) -> Result<Value, String> {
    let out = Command::new("herdr")
        .env_remove("HERDR_SOCKET_PATH")
        .env_remove("HERDR_PANE_ID")
        .env_remove("HERDR_TAB_ID")
        .env_remove("HERDR_WORKSPACE_ID")
        .arg("--session")
        .arg(SESSION)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    if !out.status.success() {
        return Err(format!("herdr {args:?}: {} {}", text, String::from_utf8_lossy(&out.stderr)));
    }
    Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)))
}

struct Lab {
    /// omp pid, to remove its registry publication (herdr kills omp before its exit hook runs).
    omp_pid: std::cell::Cell<Option<u32>>,
}

impl Lab {
    fn start(port: u16) -> Lab {
        std::fs::create_dir_all(WORK).unwrap();
        std::fs::create_dir_all(RUN).unwrap();
        std::fs::write(
            format!("{RUN}/overlay.yml"),
            format!(
                "collab:\n  autoStart: control\n  relayUrl: ws://127.0.0.1:{port}\n  displayName: tf-lab-hc\nmodelRoles:\n  task: {MODEL}\n"
            ),
        )
        .unwrap();
        let running = herdr(&["status", "server", "--json"]).map(|v| v.to_string().contains("\"running\":true")).unwrap_or(false);
        if !running {
            let st = Command::new("setsid")
                .args(["-f", "herdr", "--session", SESSION, "server"])
                .env_remove("HERDR_SOCKET_PATH")
                .env_remove("HERDR_PANE_ID")
                .env_remove("HERDR_TAB_ID")
                .env_remove("HERDR_WORKSPACE_ID")
                .current_dir(std::env::var("HOME").unwrap_or_else(|_| "/".into()))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(st.success());
            std::thread::sleep(Duration::from_secs(2));
        }
        Lab { omp_pid: std::cell::Cell::new(None) }
    }

    fn start_omp(&self) {
        let ws = herdr(&["workspace", "create", "--cwd", WORK, "--label", "hc", "--no-focus"]).unwrap();
        let pane = ws["result"]["root_pane"]["pane_id"].as_str().expect("pane id").to_owned();
        let overlay = format!("{RUN}/overlay.yml");
        herdr(&["agent", "start", "hc-omp", "--kind", "omp", "--pane", &pane, "--timeout", "60000", "--", "--config", &overlay, "--model", MODEL])
            .unwrap();
        eprintln!("[lab] omp started in {SESSION} pane {pane}");
    }
}

impl Drop for Lab {
    fn drop(&mut self) {
        if let Some(pid) = self.omp_pid.get() {
            let dir = tf_collab::registry::default_dir();
            for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                let p = e.path();
                let Ok(raw) = std::fs::read_to_string(&p) else { continue };
                let Ok(meta) = serde_json::from_str::<Value>(&raw) else { continue };
                if p.extension().is_some_and(|x| x == "json") && meta["pid"].as_u64() == Some(pid as u64) {
                    let stem = p.with_extension("");
                    for suffix in [".json", ".sock", ".sock.bind.lock"] {
                        let _ = std::fs::remove_file(format!("{}{suffix}", stem.display()));
                    }
                }
            }
        }
        let _ = Command::new("herdr").env_remove("HERDR_SOCKET_PATH").args(["session", "stop", SESSION, "--json"]).output();
        std::thread::sleep(Duration::from_secs(1));
        let _ = Command::new("herdr").env_remove("HERDR_SOCKET_PATH").args(["session", "delete", SESSION, "--json"]).output();
        eprintln!("[lab] {SESSION} stopped and deleted");
    }
}

struct Session {
    guest: Guest,
    events: tokio::sync::mpsc::UnboundedReceiver<GuestEvent>,
    replica: Replica,
    out_bytes: u64,
    log: Vec<SessionEvent>,
    signals: Vec<Signal>,
}

impl Session {
    /// Pump guest events into the replica until `done` or timeout.
    async fn pump(&mut self, what: &str, secs: u64, mut done: impl FnMut(&Session) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(secs);
        while !done(self) {
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "timed out waiting for {what}");
            let Ok(Some(ev)) = tokio::time::timeout(left, self.events.recv()).await else {
                panic!("timed out / stream ended waiting for {what}");
            };
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
            let up = self.replica.apply(&ev, now);
            for r in &up.replies {
                self.guest.ui_response(r.req_id, r.value.clone()).unwrap();
            }
            for e in &up.events {
                self.out_bytes += serde_json::to_vec(e).unwrap().len() as u64;
            }
            self.log.extend(up.events);
            self.signals.extend(up.signals);
        }
    }

    fn turn_ended(&self, from: usize) -> Option<&Signal> {
        self.signals[from..].iter().find(|s| matches!(s, Signal::TurnEnded { .. }))
    }
}

fn excerpt(e: &SessionEvent) -> String {
    let s = serde_json::to_string(e).unwrap();
    if s.len() > 220 { format!("{}…", &s[..s.floor_char_boundary(220)]) } else { s }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "real omp + herdr lab run; costs a few cheap-model tokens"]
async fn e2e_against_real_omp() {
    let port: u16 = std::env::var("TF_HC_RELAY_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(47588);
    // 1. relay
    let relay = Relay::start(RelayConfig::new(port)).await.expect("bind lab relay port");
    eprintln!("[relay] {}", relay.url());
    // 2. omp in a lab pane
    let lab = Lab::start(port);
    lab.start_omp();
    // 3. registry discovery + join
    let registry = Registry::new();
    let t0 = Instant::now();
    let host = loop {
        let hosts = registry.poll().await.expect("registry poll");
        if let Some(h) = hosts.into_iter().rev().find(|h| h.cwd.as_deref() == Some(WORK) && h.relay_connected) {
            lab.omp_pid.set(Some(h.pid));
            break h;
        }
        assert!(t0.elapsed() < Duration::from_secs(60), "omp never published to the registry");
        tokio::time::sleep(Duration::from_millis(500)).await;
    };
    eprintln!("[registry] {} gen={} pid={} session={:?} after {:?}", host.instance_id, host.generation, host.pid, host.session_id, t0.elapsed());
    let info = registry.link(&host.instance_id, Access::Control).await.expect("registry link");
    assert!(info.link.can_write());
    assert_eq!(info.link.relay_origin(), format!("ws://127.0.0.1:{port}"));
    let (guest, events) = Guest::connect(info.link.clone(), "teleflock").await.expect("guest join");
    let mut s = Session { guest, events, replica: Replica::new("hc-omp"), out_bytes: 0, log: Vec::new(), signals: Vec::new() };
    s.pump("snapshot", 30, |s| s.replica.meta().session_id.is_some()).await;
    eprintln!("[guest] joined: model={:?} thinking={:?}", s.replica.meta().model.as_ref().map(|m| &m.id), s.replica.meta().thinking);
    let raw0 = relay.stats().bytes_h2g;
    let out0 = s.out_bytes;

    // 4 + 5. prompt → streamed appends + bash row
    let mark = (s.log.len(), s.signals.len());
    s.guest.prompt("Use the bash tool to run: echo tf-e2e-ok && uname -s. Then reply with exactly: done".into(), vec![]).unwrap();
    s.pump("bash turn", 180, |s| s.turn_ended(mark.1).is_some()).await;
    let bash = s
        .replica
        .snapshot(usize::MAX)
        .items
        .into_iter()
        .rev()
        .find_map(|i| match i {
            TranscriptItem::Tool(t) if t.tool == "bash" => Some(t),
            _ => None,
        })
        .expect("bash row");
    assert_eq!(bash.status, ToolStatus::Ok);
    assert!(bash.output.as_deref().unwrap_or("").contains("tf-e2e-ok"));
    assert!(matches!(&bash.view, Some(ToolView::Bash(v)) if v.command.contains("echo tf-e2e-ok")));
    eprintln!("[bash] {} → {:?} ({:?} ms)", bash.title, bash.output, bash.duration_ms);
    for e in s.log[mark.0..].iter().filter(|e| !matches!(e, SessionEvent::Meta { .. })).take(14) {
        eprintln!("  {}", excerpt(e));
    }

    // Streaming appends: a longer answer.
    let mark = (s.log.len(), s.signals.len());
    s.guest.prompt("Count from 1 to 40 in English words separated by spaces. No tools.".into(), vec![]).unwrap();
    s.pump("streaming turn", 180, |s| s.turn_ended(mark.1).is_some()).await;
    let appends = s.log[mark.0..].iter().filter(|e| matches!(e, SessionEvent::Append { field: AppendField::Text, .. })).count();
    eprintln!("[stream] {appends} text appends");
    assert!(appends >= 3, "expected streamed appends, got {appends}");

    // 6. ask → ui_response
    let mark = (s.log.len(), s.signals.len());
    s.guest
        .prompt("Use the ask tool to ask me one question: which color do I prefer, with options Red and Blue. Then reply with my answer in one word.".into(), vec![])
        .unwrap();
    s.pump("ask ui-request", 180, |s| s.replica.ui().is_some() || s.turn_ended(mark.1).is_some()).await;
    let req = s.replica.ui().cloned().expect("ask ui-request");
    eprintln!("[ask] {:?} options={:?} allowOther={} allowChat={} callId={:?}", req.title, req.options.iter().map(|o| &o.label).collect::<Vec<_>>(), req.allow_other, req.allow_chat, req.call_id);
    let blue = req.options.iter().find(|o| o.label.eq_ignore_ascii_case("blue")).expect("Blue option").label.clone();
    let replies = s.replica.answer(&req.id, &Answer { choices: vec![blue.clone()], text: None, cancel: false, chat: false }).unwrap();
    for r in replies {
        s.guest.ui_response(r.req_id, r.value).unwrap();
    }
    s.pump("ask turn", 180, |s| s.turn_ended(mark.1).is_some()).await;
    let ask = s
        .replica
        .snapshot(usize::MAX)
        .items
        .into_iter()
        .rev()
        .find_map(|i| match i {
            TranscriptItem::Tool(t) if t.tool == "ask" => Some(t),
            _ => None,
        })
        .expect("ask row");
    assert_eq!(ask.status, ToolStatus::Ok, "{:?}", ask.output);
    let Some(ToolView::Ask(av)) = &ask.view else { panic!("{:?}", ask.view) };
    assert_eq!(av.questions[0].answer.as_deref(), Some(blue.as_str()));
    eprintln!("[ask] answered {blue}; tool output {:?}", ask.output);
    let ui: Vec<Option<String>> = s.log[mark.0..]
        .iter()
        .filter_map(|e| match e {
            SessionEvent::Ui { request } => Some(request.as_ref().map(|r| r.id.clone())),
            _ => None,
        })
        .collect();
    eprintln!("[ask] ui events {ui:?}");
    assert_eq!(ui, [Some(req.id.clone()), None], "ui opened and closed through SessionEvent::Ui");

    // 7. abort mid-stream
    let mark = (s.log.len(), s.signals.len());
    s.guest.prompt("Write the numbers from 1 to 300 in English words, one per line. No tools.".into(), vec![]).unwrap();
    s.pump("stream before abort", 180, |s| {
        s.log[mark.0..].iter().filter(|e| matches!(e, SessionEvent::Append { .. })).count() >= 15 || s.turn_ended(mark.1).is_some()
    })
    .await;
    assert!(s.turn_ended(mark.1).is_none(), "turn ended before abort: {:?}", &s.signals[mark.1..]);
    let t_abort = Instant::now();
    s.guest.abort().unwrap();
    s.pump("abort", 60, |s| s.turn_ended(mark.1).is_some()).await;
    let ended = s.turn_ended(mark.1).cloned().unwrap();
    eprintln!("[abort] {:?} after {:?}", ended, t_abort.elapsed());
    assert_eq!(ended, Signal::TurnEnded { aborted: true, error: None });

    let raw = relay.stats().bytes_h2g - raw0;
    let out = s.out_bytes - out0;
    eprintln!("[bandwidth] relay h2g ciphertext {raw} B → compacted SessionEvents {out} B ({:.1}× smaller)", raw as f64 / out as f64);
    assert!(raw > out * 3);

    s.guest.close();
    drop(lab);
    relay.shutdown().await;
}
