//! Launch help for agents TeleFlock starts or brings back (architecture §3.7, §3.25).
//!
//! * [`after_timeout`]: herdr's `agent.start` waits until the new agent is idle and interactive;
//!   an omp that is busy at once (a restored turn, a queued result) or slow to start makes it
//!   time out, and herdr then drops the name it was given (its managed launch's deadline). When
//!   an omp runs in the pane anyway, it gets its name back (`agent.rename`) and the launch counts
//!   as started.
//! * [`restart_in_place`]: an omp running without TeleFlock's launch (herdr's own restore typed a
//!   plain `omp --resume`) is stopped and started again in its pane with it.

use std::time::Duration;

use tracing::{info, warn};

use tf_herdr::{AgentInfo, HerdrClient};
use tf_proto::methods::AgentSpec;
use tf_proto::model::Agent;
use tf_proto::ApiError;

use crate::ops::agent::{derive_handle, start_agent, LaunchPane, SessionArg};
use crate::ops::Ctx;

/// How long a timed-out launch is watched for its omp.
pub const ADOPT_WAIT: Duration = Duration::from_secs(60);
/// How long a stopped omp gets to leave its pane before it starts again there.
const STOP_WAIT: Duration = Duration::from_secs(20);

/// The agent herdr's start timed out on, when `kind` runs in `pane_id` (see the module docs),
/// renamed back to `name`; `None` when nothing runs there within `wait`.
pub async fn after_timeout(herdr: &HerdrClient, pane_id: &str, name: &str, kind: &str, wait: Duration) -> Option<AgentInfo> {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        match herdr.agent_get(pane_id).await {
            // herdr renames nothing while the launch it timed out on is pending.
            Ok(a) if a.agent.as_deref() == Some(kind) && !a.launch_pending => {
                if a.name.as_deref() == Some(name) {
                    return Some(a);
                }
                match herdr.agent_rename(pane_id, Some(name)).await {
                    Ok(renamed) => {
                        info!(pane = pane_id, name, "agent start timed out, but it runs: renamed back");
                        return Some(renamed);
                    }
                    Err(e) if e.is(tf_herdr::code::AGENT_NAME_TAKEN) => {
                        warn!(pane = pane_id, name, "agent start timed out, but it runs; its name is taken now: {e}");
                        return Some(a);
                    }
                    Err(e) => tracing::debug!(pane = pane_id, "rename after a start timeout: {e}"),
                }
            }
            Ok(_) | Err(_) => {}
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(250).min(wait)).await;
    }
}

/// Stops `a`'s omp (SIGTERM: omp records a signal exit, which keeps a cut-off turn as it was) and
/// starts it again in its pane with TeleFlock's launch for session `file` (`--resume`). `argv` is
/// the command line the process was seen with: PIDs get reused, so the signal goes out only while
/// that very process still has it.
pub async fn restart_in_place(ctx: &Ctx, a: &Agent, file: &str, mut spec: AgentSpec, argv: &[String]) -> Result<tf_proto::methods::Started, ApiError> {
    let pid = a
        .omp
        .as_ref()
        .and_then(|o| o.pid)
        .ok_or_else(|| ApiError::new("unsupported", "its omp process is not known").with_hint("Restart omp in its terminal with TeleFlock's launch"))?;
    if !is_that_process(pid, argv) {
        return Err(ApiError::new("busy", format!("the process {pid} is not the omp it was (it ended, or the pid was reused); not stopping it")).retryable());
    }
    super::relaunching(file);
    if !terminate(pid) {
        return Err(ApiError::new("unsupported", "cannot stop its omp on this host").with_hint("Restart omp in its terminal with TeleFlock's launch"));
    }
    info!(agent = %a.id, pid, "stopping omp to start it again with TeleFlock's launch");
    let deadline = tokio::time::Instant::now() + STOP_WAIT;
    loop {
        tokio::time::sleep(Duration::from_millis(250)).await;
        let gone = !alive(pid);
        let free = ctx.herdr.agent_get(&a.pane_id).await.map(|g| g.agent.is_none()).unwrap_or(true);
        if gone && free {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(ApiError::new("busy", format!("omp (pid {pid}) did not exit")).retryable());
        }
    }
    match start_agent(ctx, LaunchPane::New(a.pane_id.clone()), &spec, Some(SessionArg::Resume(file))).await {
        Err(e) if e.message.starts_with(tf_herdr::code::AGENT_NAME_TAKEN) => {
            let taken: Vec<String> = ctx.state.snapshot().agents.into_iter().map(|x| x.name).collect();
            spec.name = Some(derive_handle(&a.name, &taken));
            start_agent(ctx, LaunchPane::New(a.pane_id.clone()), &spec, Some(SessionArg::Resume(file))).await
        }
        other => other,
    }
}

/// Process `pid` lives and still has the command line `argv` (Linux `/proc`); anything unknown
/// counts as no.
fn is_that_process(pid: u32, argv: &[String]) -> bool {
    !argv.is_empty() && super::ledger::alive(Some(pid), argv) == Some(true)
}

#[cfg(unix)]
fn terminate(pid: u32) -> bool {
    // SAFETY: kill(2) with a plain signal number.
    unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) == 0 }
}

#[cfg(not(unix))]
fn terminate(_pid: u32) -> bool {
    false
}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(not(unix))]
fn alive(_pid: u32) -> bool {
    false
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    use serde_json::{json, Value};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    /// A herdr that answers `agent.get` for pane `w1:p1` from `phases` (one per call, the last
    /// repeating) and records every `agent.rename`.
    async fn fake_herdr(dir: &std::path::Path, phases: Vec<Value>, renames: Arc<Mutex<Vec<(String, String)>>>) -> HerdrClient {
        let path = dir.join("herdr.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let calls = Arc::new(Mutex::new(0usize));
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { return };
                let (phases, renames, calls) = (phases.clone(), renames.clone(), calls.clone());
                tokio::spawn(async move {
                    let (r, mut w) = stream.into_split();
                    let mut lines = BufReader::new(r).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        let req: Value = serde_json::from_str(&line).unwrap();
                        let id = req["id"].clone();
                        let reply = match req["method"].as_str().unwrap_or_default() {
                            "ping" => json!({"id": id, "result": {"type": "pong", "version": "0.9.5", "protocol": 22}}),
                            "agent.get" => {
                                let n = {
                                    let mut c = calls.lock().unwrap();
                                    *c += 1;
                                    *c - 1
                                };
                                let agent = phases[n.min(phases.len() - 1)].clone();
                                json!({"id": id, "result": {"type": "agent_info", "agent": agent}})
                            }
                            "agent.rename" => {
                                let (target, name) = (req["params"]["target"].as_str().unwrap().to_string(), req["params"]["name"].as_str().unwrap().to_string());
                                renames.lock().unwrap().push((target, name.clone()));
                                json!({"id": id, "result": {"type": "agent_info", "agent": {"pane_id": "w1:p1", "terminal_id": "t-2", "name": name, "agent": "omp", "agent_status": "working"}}})
                            }
                            other => json!({"id": id, "error": {"code": "unknown_method", "message": other}}),
                        };
                        if w.write_all(format!("{reply}\n").as_bytes()).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });
        let opts = tf_herdr::DiscoverOptions { bin: Some("/bin/false".into()), socket: Some(path), request_timeout: Duration::from_secs(2) };
        HerdrClient::discover_with(Some("tf-lab-lifeboat-unit"), opts).await.unwrap()
    }

    fn agent(name: Option<&str>, kind: Option<&str>, pending: bool) -> Value {
        json!({"pane_id": "w1:p1", "terminal_id": "t-2", "name": name, "agent": kind, "agent_status": "working", "launch_pending": pending})
    }

    #[tokio::test]
    async fn a_start_that_timed_out_on_a_busy_omp_gets_its_name_back() {
        let dir = tempfile::tempdir().unwrap();
        let renames = Arc::new(Mutex::new(Vec::new()));
        // herdr's managed launch is still pending (no rename possible), then its deadline dropped
        // the name while omp runs (busy at once).
        let herdr = fake_herdr(dir.path(), vec![agent(Some("fixer"), None, true), agent(None, Some("omp"), false)], renames.clone()).await;
        let got = after_timeout(&herdr, "w1:p1", "fixer", "omp", Duration::from_secs(5)).await.expect("it runs");
        assert_eq!(got.name.as_deref(), Some("fixer"));
        assert_eq!(*renames.lock().unwrap(), [("w1:p1".to_string(), "fixer".to_string())]);
    }

    #[tokio::test]
    async fn nothing_running_is_a_failed_start() {
        let dir = tempfile::tempdir().unwrap();
        let renames = Arc::new(Mutex::new(Vec::new()));
        let herdr = fake_herdr(dir.path(), vec![agent(None, None, false)], renames.clone()).await;
        assert!(after_timeout(&herdr, "w1:p1", "fixer", "omp", Duration::from_millis(600)).await.is_none());
        assert!(renames.lock().unwrap().is_empty());
        // Still named: nothing to rename.
        let dir2 = tempfile::tempdir().unwrap();
        let herdr = fake_herdr(dir2.path(), vec![agent(Some("fixer"), Some("omp"), false)], renames.clone()).await;
        assert!(after_timeout(&herdr, "w1:p1", "fixer", "omp", Duration::from_secs(2)).await.is_some());
        assert!(renames.lock().unwrap().is_empty());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_reused_pid_is_not_signalled() {
        let me = std::process::id();
        let argv = crate::restart::herdr::cmdline(me).unwrap();
        assert!(is_that_process(me, &argv));
        // Another program under the same pid (what a reused pid looks like), and a pid that is gone.
        assert!(!is_that_process(me, &["omp".to_string(), "--resume=/s/a.jsonl".to_string()]));
        assert!(!is_that_process(u32::MAX - 1, &argv));
        assert!(!is_that_process(me, &[]), "no command line, no certainty");
    }
}
