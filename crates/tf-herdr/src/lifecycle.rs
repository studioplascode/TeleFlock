//! The server's lifecycle as tf-hostd drives it (architecture §3.29): which server process answers
//! ([`HerdrClient::probe`]), starting one with a chosen environment
//! ([`HerdrClient::ensure_server_with`]), stopping it, and replacing it by live handoff.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncWriteExt, BufReader};

use crate::client::HerdrClient;
use crate::error::{HerdrError, Result, code};
use crate::model::Pong;
use crate::transport::{self, Endpoint};

/// How a server TeleFlock starts is launched. Every inherited `HERDR_*` variable is removed (a
/// daemon started from inside a herdr pane would otherwise hand the new server another server's
/// socket, session or config); `env` is set afterwards.
#[derive(Debug, Clone, Default)]
pub struct ServerLaunch {
    pub env: Vec<(String, String)>,
}

/// One answer of [`HerdrClient::probe`]: the process behind the socket and its `ping`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerProbe {
    /// The process listening on the socket (`SO_PEERCRED` / `LOCAL_PEEREPID`); `None` where the
    /// platform does not say (Windows).
    pub pid: Option<u32>,
    pub pong: Pong,
}

/// Why [`HerdrClient::probe`] got no answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeFailure {
    /// No socket: the server shut down (it removes its socket) or never ran.
    Missing,
    /// A socket nobody listens on: the server died without cleaning up.
    Refused,
    /// The socket accepts but the server did not answer in time.
    Silent,
    /// Anything else (permissions, a broken reply).
    Other(String),
}

/// `server.live_handoff` parameters (herdr ≥ 0.9.4 servers with `capabilities.live_handoff`).
#[derive(Debug, Clone, Default, Serialize)]
pub struct LiveHandoff {
    /// The herdr executable the replacement server runs (`None`: the running server's own).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub import_exe: Option<String>,
    /// The replacement refuses to take over unless it is this version.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<String>,
}

/// herdr's own budget for a handoff request (`update.rs` `SERVER_HANDOFF_REQUEST_TIMEOUT`).
pub const HANDOFF_TIMEOUT: Duration = Duration::from_secs(240);
/// How long a stopping server gets to release its socket.
pub const STOP_TIMEOUT: Duration = Duration::from_secs(30);

impl HerdrClient {
    /// Pings the server on a connection whose peer process it identifies first, so the pid and
    /// the answer belong to the same server instance.
    pub async fn probe(&self, timeout: Duration) -> std::result::Result<ServerProbe, ProbeFailure> {
        let ep = self.endpoint().clone();
        let id = self.next_id("ping");
        let fut = async move {
            let (conn, pid) = probe_connect(&ep).await?;
            let line = transport::request_line(&id, "ping", &serde_json::json!({})).map_err(|e| ProbeFailure::Other(e.message))?;
            let mut conn = conn;
            conn.write_all(&line).await.map_err(|e| ProbeFailure::Other(format!("write: {e}")))?;
            conn.flush().await.map_err(|e| ProbeFailure::Other(format!("flush: {e}")))?;
            let mut reader = BufReader::new(conn);
            let mut buf = String::new();
            transport::read_line(&mut reader, &mut buf).await.map_err(|e| ProbeFailure::Other(e.message))?;
            let value = transport::parse_response(buf.trim_end()).map_err(|e| ProbeFailure::Other(e.message))?;
            let pong: Pong = serde_json::from_value(value).map_err(|e| ProbeFailure::Other(format!("decode ping: {e}")))?;
            Ok(ServerProbe { pid, pong })
        };
        match tokio::time::timeout(timeout, fut).await {
            Ok(r) => r,
            Err(_) => Err(ProbeFailure::Silent),
        }
    }

    /// [`ensure_server`](Self::ensure_server) with `launch` applied to the spawned server.
    pub async fn ensure_server_with(&self, launch: &ServerLaunch) -> Result<Pong> {
        self.ensure_server_inner(launch).await
    }

    /// Asks the server to shut down (`server.stop`) and waits until its socket is gone or refuses
    /// connections. Every pane process of the session ends with it.
    pub async fn stop_server(&self) -> Result<()> {
        match self.request::<serde_json::Value>("server.stop", serde_json::json!({})).await {
            Ok(_) => {}
            Err(e) if e.is_server_not_running() => return Ok(()),
            // The server may close the connection before its answer arrives.
            Err(e) if e.code == code::TRANSPORT => {}
            Err(e) => return Err(e),
        }
        let deadline = tokio::time::Instant::now() + STOP_TIMEOUT;
        while tokio::time::Instant::now() < deadline {
            match self.probe(Duration::from_secs(2)).await {
                Err(ProbeFailure::Missing | ProbeFailure::Refused) => return Ok(()),
                _ => tokio::time::sleep(Duration::from_millis(200)).await,
            }
        }
        Err(HerdrError::new(code::TIMEOUT, format!("herdr server still answers {}s after server.stop", STOP_TIMEOUT.as_secs())))
    }

    /// Replaces the running server by live handoff: herdr starts `import_exe` as the new server,
    /// passes it every pane's terminal (processes keep running) and exits. Answers once the old
    /// server committed the handoff; the caller then waits for the new one to answer.
    pub async fn live_handoff(&self, params: &LiveHandoff) -> Result<()> {
        self.request_with_timeout::<serde_json::Value>("server.live_handoff", params, HANDOFF_TIMEOUT).await.map(|_| ())
    }

    /// `herdr integration status`: one line per installed integration with its version, e.g.
    /// `omp: outdated (v9 < v10) (<path>)`. Needs no server.
    pub async fn integration_status(&self) -> Result<String> {
        let out = self.run_cli(&["integration", "status"], Duration::from_secs(10)).await?;
        Ok(String::from_utf8_lossy(&out).into_owned())
    }

    /// `herdr --version` of the binary this client runs, exactly as herdr prints it after `herdr `
    /// (`0.9.5`, `0.9.6-preview.12`): the same text a server of that build answers `ping` with.
    pub async fn installed_version(&self) -> Result<String> {
        let mut cmd = tokio::process::Command::new(self.binary());
        cmd.arg("--version").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).kill_on_drop(true);
        strip_herdr_env(&mut cmd);
        let out = tokio::time::timeout(Duration::from_secs(10), cmd.output())
            .await
            .map_err(|_| HerdrError::new(code::TIMEOUT, "herdr --version: timed out"))?
            .map_err(|e| HerdrError::transport("herdr --version", e))?;
        let text = String::from_utf8_lossy(&out.stdout);
        version_token(&text).ok_or_else(|| HerdrError::protocol("herdr --version", format!("unexpected output {:?}", text.trim())))
    }
}

/// `herdr 0.9.5` → `0.9.5` (the first line's version word; a leading `v` is dropped).
pub fn version_token(text: &str) -> Option<String> {
    let line = text.lines().next()?.trim();
    let word = line.split_whitespace().find(|w| crate::client::parse_version(w).is_some())?;
    Some(word.trim_start_matches('v').to_string())
}

/// Removes every `HERDR_*` variable this process has from `cmd`'s environment.
pub(crate) fn strip_herdr_env<C: EnvRemove>(cmd: &mut C) {
    for (k, _) in std::env::vars_os() {
        if k.to_str().is_some_and(|k| k.starts_with("HERDR_")) {
            cmd.env_remove_os(&k);
        }
    }
}

pub(crate) trait EnvRemove {
    fn env_remove_os(&mut self, key: &std::ffi::OsStr);
}

impl EnvRemove for std::process::Command {
    fn env_remove_os(&mut self, key: &std::ffi::OsStr) {
        self.env_remove(key);
    }
}

impl EnvRemove for tokio::process::Command {
    fn env_remove_os(&mut self, key: &std::ffi::OsStr) {
        self.env_remove(key);
    }
}

#[cfg(unix)]
async fn probe_connect(ep: &Endpoint) -> std::result::Result<(Box<tokio::net::UnixStream>, Option<u32>), ProbeFailure> {
    use std::io::ErrorKind;
    match tokio::net::UnixStream::connect(&ep.socket).await {
        Ok(s) => {
            let pid = s.peer_cred().ok().and_then(|c| c.pid()).and_then(|p| u32::try_from(p).ok()).filter(|p| *p > 0);
            Ok((Box::new(s), pid))
        }
        Err(e) if e.kind() == ErrorKind::NotFound => Err(ProbeFailure::Missing),
        Err(e) if e.kind() == ErrorKind::ConnectionRefused => Err(ProbeFailure::Refused),
        Err(e) => Err(ProbeFailure::Other(format!("connect {}: {e}", ep.socket.display()))),
    }
}

#[cfg(windows)]
async fn probe_connect(ep: &Endpoint) -> std::result::Result<(Box<tokio::net::windows::named_pipe::NamedPipeClient>, Option<u32>), ProbeFailure> {
    use tokio::net::windows::named_pipe::ClientOptions;
    const ERROR_FILE_NOT_FOUND: i32 = 2;
    const ERROR_PIPE_BUSY: i32 = 231;
    let name = ep.pipe_name();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        match ClientOptions::new().open(&name) {
            Ok(p) => return Ok((Box::new(p), None)),
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) && tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(e) if e.raw_os_error() == Some(ERROR_FILE_NOT_FOUND) => return Err(ProbeFailure::Missing),
            Err(e) => return Err(ProbeFailure::Other(format!("open pipe {name}: {e}"))),
        }
    }
}

/// The start time of `pid` in clock ticks since boot (`/proc/<pid>/stat` field 22): with the pid,
/// it names one process even when pids are reused. `None` off Linux, when it is gone, or when it
/// exited and waits to be reaped (a zombie runs nothing).
pub fn process_start_ticks(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    parse_start_ticks(&stat)
}

/// Field 22 of a `/proc/<pid>/stat` line (the command may contain spaces and parentheses);
/// `None` for a zombie (`Z`) or dead (`X`) process.
pub fn parse_start_ticks(stat: &str) -> Option<u64> {
    let rest = &stat[stat.rfind(')')? + 1..];
    let mut fields = rest.split_whitespace();
    if matches!(fields.next()?, "Z" | "X") {
        return None;
    }
    // After the state (field 3): starttime (field 22) is the 19th field from here.
    fields.nth(18)?.parse().ok()
}

/// The value of `name` in `pid`'s environment (Linux `/proc/<pid>/environ`, same user only).
pub fn process_env(pid: u32, name: &str) -> Option<String> {
    let environ = std::fs::read(format!("/proc/{pid}/environ")).ok()?;
    environ_value(&environ, name)
}

pub fn environ_value(environ: &[u8], name: &str) -> Option<String> {
    environ.split(|b| *b == 0).find_map(|kv| {
        let kv = std::str::from_utf8(kv).ok()?;
        let (k, v) = kv.split_once('=')?;
        (k == name).then(|| v.to_string())
    })
}

/// The executable `pid` runs (Linux `/proc/<pid>/exe`).
pub fn process_exe(pid: u32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/exe")).ok()
}

/// True when `path` is an executable herdr binary file.
pub fn is_herdr_binary(path: &Path) -> bool {
    crate::client::is_executable(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_ticks_skip_the_command() {
        let stat = "4242 (herdr (server) x) S 1 4242 4242 0 -1 4194560 1503 0 0 0 10 5 0 0 20 0 3 0 98765 123456 789 18446744073709551615";
        assert_eq!(parse_start_ticks(stat), Some(98765));
        assert_eq!(parse_start_ticks("garbage"), None);
        assert_eq!(parse_start_ticks(&stat.replace(") S ", ") Z ")), None, "a zombie runs nothing");
    }

    #[test]
    fn environ_lookup() {
        let env = b"HOME=/root\0HERDR_CONFIG_PATH=/x/herdr-config.toml\0EMPTY=\0";
        assert_eq!(environ_value(env, "HERDR_CONFIG_PATH").as_deref(), Some("/x/herdr-config.toml"));
        assert_eq!(environ_value(env, "EMPTY").as_deref(), Some(""));
        assert_eq!(environ_value(env, "HERDR"), None);
    }

    #[tokio::test]
    async fn probe_tells_missing_from_refused_and_identifies_the_listener() {
        let dir = std::env::temp_dir().join(format!("tf-herdr-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("herdr.sock");
        let _ = std::fs::remove_file(&sock);
        let opts = crate::DiscoverOptions { bin: Some(PathBuf::from("/bin/true")), socket: Some(sock.clone()), ..Default::default() };
        let client = HerdrClient::discover_with(None, opts).await.unwrap();
        assert_eq!(client.probe(Duration::from_secs(1)).await, Err(ProbeFailure::Missing));

        // A socket file nobody listens on (a server that died without cleaning up).
        {
            let l = std::os::unix::net::UnixListener::bind(&sock).unwrap();
            drop(l);
        }
        assert_eq!(client.probe(Duration::from_secs(1)).await, Err(ProbeFailure::Refused));
        std::fs::remove_file(&sock).unwrap();

        // A listener that answers ping: the pid is ours.
        let listener = tokio::net::UnixListener::bind(&sock).unwrap();
        tokio::spawn(async move {
            while let Ok((s, _)) = listener.accept().await {
                tokio::spawn(async move {
                    use tokio::io::AsyncBufReadExt;
                    let (r, mut w) = s.into_split();
                    let mut line = String::new();
                    let _ = BufReader::new(r).read_line(&mut line).await;
                    let id = serde_json::from_str::<serde_json::Value>(&line).unwrap()["id"].clone();
                    let reply = serde_json::json!({"id": id, "result": {"version": "0.9.5", "protocol": 22, "capabilities": {"live_handoff": true}}});
                    let _ = w.write_all(format!("{reply}\n").as_bytes()).await;
                });
            }
        });
        let p = client.probe(Duration::from_secs(2)).await.unwrap();
        assert_eq!(p.pong.version, "0.9.5");
        assert!(p.pong.capabilities.as_ref().is_some_and(|c| c.live_handoff));
        assert_eq!(p.pid, Some(std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn probe_of_a_silent_server_times_out() {
        let dir = std::env::temp_dir().join(format!("tf-herdr-silent-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("herdr.sock");
        let _ = std::fs::remove_file(&sock);
        // Discovered while nothing listens (discovery pings).
        let opts = crate::DiscoverOptions { bin: Some(PathBuf::from("/bin/true")), socket: Some(sock.clone()), ..Default::default() };
        let client = HerdrClient::discover_with(None, opts).await.unwrap();
        let listener = tokio::net::UnixListener::bind(&sock).unwrap();
        let hold = tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((s, _)) = listener.accept().await {
                held.push(s);
            }
        });
        assert_eq!(client.probe(Duration::from_millis(300)).await, Err(ProbeFailure::Silent));
        hold.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
