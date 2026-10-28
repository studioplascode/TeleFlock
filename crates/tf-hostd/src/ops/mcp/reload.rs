//! Brings MCP config changes into running omp sessions. omp has no MCP config watcher, so hostd
//! runs omp's own `/mcp reload` (disconnect, rediscover, reconnect, refresh the session's tools)
//! through the companion extension's `slash` op in every interactive session the change concerns:
//! at once when the session is idle, else once it is (a reload mid-turn would cut its in-flight
//! MCP calls). Idle means the session's turn is over **and** none of its subagents runs: they
//! share the session's MCP manager. Sessions without a bridge (or not interactive) are counted as
//! needing a restart.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use tf_proto::session::SubagentStatus;
use tf_proto::McpReload;
use tokio::sync::broadcast::error::RecvError;

use crate::bridge::{BridgeEvent, BridgeHandle, BridgeSession};
use crate::omp::OmpHandle;
use crate::ops::Ctx;

const COMMAND: &str = "/mcp reload";
/// A queued reload gives up when the session stays busy this long.
const QUEUE_LIMIT: Duration = Duration::from_secs(2 * 60 * 60);
/// How often a queued reload looks again while only subagents keep the session busy (their end
/// is no bridge event).
const SUBAGENT_POLL: Duration = if cfg!(test) { Duration::from_millis(50) } else { Duration::from_secs(2) };

/// Whether subagents of the omp session (by id) still run.
pub type SubagentsRunning = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// A reload waiting for its session to be idle: one waiter per session; `asks` counts the changes
/// that asked for it (one arriving while the waiter reloads gets a reload of its own).
struct Queued {
    waiter: u64,
    asks: u64,
}

static QUEUED: LazyLock<Mutex<HashMap<String, Queued>>> = LazyLock::new(Default::default);
static WAITERS: AtomicU64 = AtomicU64::new(0);

fn queued() -> MutexGuard<'static, HashMap<String, Queued>> {
    QUEUED.lock().unwrap_or_else(|p| p.into_inner())
}

/// Whether `session_cwd` is `folder` (omp's project config is `<cwd>/.omp/mcp.json`: exactly the
/// session's folder, not a parent).
pub fn same_folder(session_cwd: &str, folder: &Path) -> bool {
    let a = std::fs::canonicalize(session_cwd).unwrap_or_else(|_| session_cwd.into());
    let b = std::fs::canonicalize(folder).unwrap_or_else(|_| folder.to_path_buf());
    a == b
}

fn concerned(s: &BridgeSession, folder: Option<&Path>) -> bool {
    folder.is_none_or(|f| same_folder(&s.cwd, f))
}

/// Running interactive sessions `/mcp reload` reaches (`folder`: those started there).
pub fn reachable(bridge: &BridgeHandle, folder: Option<&Path>) -> u32 {
    bridge.sessions().iter().filter(|s| s.tui && concerned(s, folder)).count() as u32
}

/// Subagents running in hostd's replica of the session.
fn subagents_running(omp: &OmpHandle) -> SubagentsRunning {
    let omp = omp.clone();
    Arc::new(move |session_id| {
        omp.session(session_id).is_some_and(|s| s.lock().replica.meta().subagents.iter().any(|a| a.status == SubagentStatus::Running))
    })
}

/// Reloads the MCP servers of every running session `folder` concerns (absent: all of them).
pub async fn reload(ctx: &Ctx, folder: Option<&Path>) -> McpReload {
    let mut out = reload_bridged(&ctx.bridge, folder, &subagents_running(&ctx.omp)).await;
    // omp agents on the board whose session has no bridge: only a restart brings the change.
    let state = ctx.state.snapshot();
    for a in &state.agents {
        let running = a.kind == "omp" && a.parked.is_none() && !a.pane_id.is_empty();
        let here = folder.is_none_or(|f| a.cwd.as_deref().is_some_and(|c| same_folder(c, f)));
        if running && here && !ctx.state.omp_session_of(&a.id).is_some_and(|sid| ctx.bridge.is_connected(&sid)) {
            out.restart_needed += 1;
        }
    }
    if out.reloaded + out.queued + out.restart_needed > 0 || !out.errors.is_empty() {
        tracing::info!(reloaded = out.reloaded, queued = out.queued, restart_needed = out.restart_needed, errors = out.errors.len(), "mcp reload");
    }
    out
}

/// The sessions with a bridge: idle ones reload now, busy ones once idle.
async fn reload_bridged(bridge: &BridgeHandle, folder: Option<&Path>, subagents: &SubagentsRunning) -> McpReload {
    let sessions: Vec<BridgeSession> = bridge.sessions().into_iter().filter(|s| concerned(s, folder)).collect();
    let mut out = McpReload { reloaded: 0, queued: 0, restart_needed: 0, errors: vec![] };
    let mut now = Vec::new();
    for s in &sessions {
        if !s.tui {
            out.restart_needed += 1;
        } else if s.state.idle && !subagents(&s.session_id) {
            now.push(s);
        } else {
            // Busy: reloaded once idle (or a reload already waits for that).
            queue(bridge.clone(), s.session_id.clone(), subagents.clone());
            out.queued += 1;
        }
    }
    let results = futures::future::join_all(now.iter().map(|s| bridge.slash(&s.session_id, COMMAND))).await;
    for (s, r) in now.iter().zip(results) {
        match r {
            Ok(()) => out.reloaded += 1,
            Err(e) => {
                tracing::warn!(session = %s.session_id, "mcp reload: {e}");
                out.errors.push(format!("{}: {e}", s.state.title.as_deref().unwrap_or(&s.session_id)));
            }
        }
    }
    out
}

/// Reloads `session_id` once it is idle (a waiter already there takes this change along).
fn queue(bridge: BridgeHandle, session_id: String, subagents: SubagentsRunning) {
    let waiter = {
        let mut q = queued();
        if let Some(e) = q.get_mut(&session_id) {
            e.asks += 1;
            return;
        }
        let waiter = WAITERS.fetch_add(1, Ordering::Relaxed);
        q.insert(session_id.clone(), Queued { waiter, asks: 1 });
        waiter
    };
    tokio::spawn(async move {
        if tokio::time::timeout(QUEUE_LIMIT, wait_and_reload(&bridge, &session_id, waiter, &subagents)).await.is_err() {
            done(&session_id, waiter);
        }
    });
}

/// Forgets the waiter (when it is still the session's).
fn done(session_id: &str, waiter: u64) {
    let mut q = queued();
    if q.get(session_id).is_some_and(|e| e.waiter == waiter) {
        q.remove(session_id);
    }
}

async fn wait_and_reload(bridge: &BridgeHandle, session_id: &str, waiter: u64, subagents: &SubagentsRunning) {
    let mut events = bridge.subscribe();
    loop {
        // Checked after subscribing, so a turn ending in between is not missed.
        let Some(s) = bridge.by_session(session_id) else {
            done(session_id, waiter);
            return;
        };
        let running = subagents(session_id);
        if s.state.idle && !running {
            let asked = queued().get(session_id).map_or(0, |e| e.asks);
            if let Err(e) = bridge.slash(session_id, COMMAND).await {
                tracing::warn!(session = %session_id, "queued mcp reload: {e}");
            }
            // A change asked for meanwhile may have been written after omp read the files: once more.
            let mut q = queued();
            if q.get(session_id).is_some_and(|e| e.waiter == waiter && e.asks > asked) {
                continue;
            }
            if q.get(session_id).is_some_and(|e| e.waiter == waiter) {
                q.remove(session_id);
            }
            return;
        }
        let ev = if running {
            match tokio::time::timeout(SUBAGENT_POLL, events.recv()).await {
                Ok(ev) => ev,
                Err(_) => continue,
            }
        } else {
            events.recv().await
        };
        match ev {
            Ok(BridgeEvent::SessionSwitch { previous_session_id, .. }) if previous_session_id == session_id => {
                done(session_id, waiter);
                return;
            }
            Ok(_) | Err(RecvError::Lagged(_)) => {}
            Err(RecvError::Closed) => {
                done(session_id, waiter);
                return;
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::sync::atomic::AtomicBool;

    use serde_json::{json, Value};

    use super::*;
    use crate::bridge::fake::{handle, FakeExt};

    fn none_running() -> SubagentsRunning {
        Arc::new(|_| false)
    }

    async fn set_idle(ext: &mut FakeExt, sid: &str, idle: bool) {
        ext.send(json!({ "t": "event", "event": "state", "sessionId": sid, "data": {
            "fast": false, "mode": "normal", "idle": idle, "queue": { "steering": [], "followUp": [] }, "attached": false } }))
        .await;
    }

    /// The next `slash` request, answered.
    async fn reload_seen(ext: &mut FakeExt) -> Value {
        let req = ext.recv_req().await;
        assert_eq!((req["op"].as_str(), req["params"]["command"].as_str()), (Some("slash"), Some(COMMAND)));
        ext.send(json!({ "t": "res", "id": req["id"], "ok": true, "result": {} })).await;
        req
    }

    async fn idle_in_hostd(h: &BridgeHandle, sid: &str, idle: bool) {
        for _ in 0..250 {
            if h.by_session(sid).is_some_and(|s| s.state.idle == idle) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("{sid} never became idle={idle}");
    }

    #[tokio::test]
    async fn running_subagents_keep_the_reload_queued_until_they_finish() {
        let (h, _dir) = handle();
        let mut ext = FakeExt::connect(&h).await;
        ext.hello(4101, "rl-sub").await;
        let busy = Arc::new(AtomicBool::new(true));
        let b = busy.clone();
        let subagents: SubagentsRunning = Arc::new(move |_| b.load(Ordering::SeqCst));
        let out = reload_bridged(&h, None, &subagents).await;
        assert_eq!((out.reloaded, out.queued), (0, 1), "the turn is over but a subagent still uses the session's MCP servers");
        // No reload while the subagent runs …
        assert!(tokio::time::timeout(Duration::from_millis(300), ext.recv_req()).await.is_err());
        // … and one as soon as it is done (no bridge event announces that).
        busy.store(false, Ordering::SeqCst);
        reload_seen(&mut ext).await;
        for _ in 0..250 {
            if !queued().contains_key("rl-sub") {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the waiter is forgotten after its reload");
    }

    #[tokio::test]
    async fn a_change_during_a_queued_reload_gets_a_reload_of_its_own() {
        let (h, _dir) = handle();
        let mut ext = FakeExt::connect(&h).await;
        ext.hello(4102, "rl-race").await;
        set_idle(&mut ext, "rl-race", false).await;
        idle_in_hostd(&h, "rl-race", false).await;
        assert_eq!(reload_bridged(&h, None, &none_running()).await.queued, 1);
        // The turn ends: the waiter reloads. While omp runs it, the next turn starts and another
        // change arrives (queued: the session is busy again).
        set_idle(&mut ext, "rl-race", true).await;
        let req = ext.recv_req().await;
        assert_eq!(req["op"], "slash");
        set_idle(&mut ext, "rl-race", false).await;
        idle_in_hostd(&h, "rl-race", false).await;
        assert_eq!(reload_bridged(&h, None, &none_running()).await.queued, 1);
        ext.send(json!({ "t": "res", "id": req["id"], "ok": true, "result": {} })).await;
        // That change still reaches the session when its turn ends.
        assert!(tokio::time::timeout(Duration::from_millis(300), ext.recv_req()).await.is_err(), "not mid-turn");
        set_idle(&mut ext, "rl-race", true).await;
        reload_seen(&mut ext).await;
        assert!(tokio::time::timeout(Duration::from_millis(300), ext.recv_req()).await.is_err(), "and only once");
    }

    #[tokio::test]
    async fn idle_sessions_reload_at_once() {
        let (h, _dir) = handle();
        let mut ext = FakeExt::connect(&h).await;
        ext.hello(4103, "rl-now").await;
        let (h2, s) = (h.clone(), none_running());
        let call = tokio::spawn(async move { reload_bridged(&h2, None, &s).await });
        reload_seen(&mut ext).await;
        let out = call.await.unwrap();
        assert_eq!((out.reloaded, out.queued, out.restart_needed), (1, 0, 0));
    }
}
