//! Brings MCP config changes into running omp sessions. omp has no MCP config watcher, so hostd
//! runs omp's own `/mcp reload` (disconnect, rediscover, reconnect, refresh the session's tools)
//! through the companion extension's `slash` op in every interactive session the change concerns:
//! at once when the session is idle, else when its turn ends (a reload mid-turn would cut its
//! in-flight MCP calls). Sessions without a bridge (or not interactive) are counted as needing a
//! restart.

use std::collections::HashSet;
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use tf_proto::McpReload;
use tokio::sync::broadcast::error::RecvError;

use crate::bridge::{BridgeEvent, BridgeHandle, BridgeSession};
use crate::ops::Ctx;

const COMMAND: &str = "/mcp reload";
/// A queued reload gives up when the session stays busy this long.
const QUEUE_LIMIT: Duration = Duration::from_secs(2 * 60 * 60);

/// Sessions with a reload waiting for their turn to end (one waiter per session).
static QUEUED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

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

/// Reloads the MCP servers of every running session `folder` concerns (absent: all of them).
pub async fn reload(ctx: &Ctx, folder: Option<&Path>) -> McpReload {
    let sessions: Vec<BridgeSession> = ctx.bridge.sessions().into_iter().filter(|s| concerned(s, folder)).collect();
    let mut out = McpReload { reloaded: 0, queued: 0, restart_needed: 0, errors: vec![] };
    let mut now = Vec::new();
    for s in &sessions {
        if !s.tui {
            out.restart_needed += 1;
        } else if s.state.idle {
            now.push(s);
        } else {
            // Busy: reloaded when its turn ends (or a reload already waits for that).
            queue(ctx.bridge.clone(), s.session_id.clone());
            out.queued += 1;
        }
    }
    let results = futures::future::join_all(now.iter().map(|s| ctx.bridge.slash(&s.session_id, COMMAND))).await;
    for (s, r) in now.iter().zip(results) {
        match r {
            Ok(()) => out.reloaded += 1,
            Err(e) => {
                tracing::warn!(session = %s.session_id, "mcp reload: {e}");
                out.errors.push(format!("{}: {e}", s.state.title.as_deref().unwrap_or(&s.session_id)));
            }
        }
    }
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

/// Reloads `session_id` once it is idle (nothing when a reload already waits for it).
fn queue(bridge: BridgeHandle, session_id: String) {
    if !QUEUED.lock().unwrap_or_else(|p| p.into_inner()).insert(session_id.clone()) {
        return;
    }
    tokio::spawn(async move {
        let mut events = bridge.subscribe();
        let wait = async {
            loop {
                // Checked after subscribing, so a turn ending in between is not missed.
                match bridge.by_session(&session_id) {
                    None => return,
                    Some(s) if s.state.idle => {
                        if let Err(e) = bridge.slash(&session_id, COMMAND).await {
                            tracing::warn!(session = %session_id, "queued mcp reload: {e}");
                        }
                        return;
                    }
                    Some(_) => {}
                }
                match events.recv().await {
                    Ok(ev) if ev.session_id() == session_id => {}
                    Ok(BridgeEvent::SessionSwitch { previous_session_id, .. }) if previous_session_id == session_id => return,
                    Ok(_) | Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => return,
                }
            }
        };
        let _ = tokio::time::timeout(QUEUE_LIMIT, wait).await;
        QUEUED.lock().unwrap_or_else(|p| p.into_inner()).remove(&session_id);
    });
}
