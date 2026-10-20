//! `term.*` methods: xterm.js terminals bridged to herdr panes through
//! `herdr terminal session control|observe` (one bridge per open terminal).
//!
//! Flow: `term.open` resolves the [`TermTarget`] to a pane (creating a shell pane when
//! asked), opens a [`tf_herdr::TerminalSession`] and registers it in [`TermRegistry`]. A
//! pump task forwards every frame to the opening client as `ServerMsg::Term` until the
//! stream closes, the client closes it, or the client disconnects. Input arrives on the
//! `ClientMsg::TermIn` fast path ([`input`]).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tf_herdr::{TerminalEvent, TerminalInput, TerminalMode, TerminalOptions};
use tf_proto::{
    ApiError, Empty, HostMethod, ScrollDirection, ServerMsg, Split, TermEvent, TermMode, TermOpenParams, TermOpened,
    TermTarget,
};
use tokio_util::sync::CancellationToken;

use crate::clients::ClientHandle;
use crate::ops::workspace::{existing_dir, map_herdr};
use crate::ops::{herdr_err, to_value, Ctx};

/// Open terminals of one herdr session, keyed by `termId`.
#[derive(Clone, Default)]
pub struct TermRegistry {
    inner: Arc<Mutex<HashMap<String, TermEntry>>>,
}

struct TermEntry {
    client_id: String,
    pane_id: String,
    input: TerminalInput,
    /// Stops the pump (which drops the event receiver and so kills the bridge).
    stop: CancellationToken,
}

impl TermRegistry {
    fn insert(&self, term_id: String, entry: TermEntry) {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).insert(term_id, entry);
    }

    fn remove(&self, term_id: &str) -> Option<TermEntry> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).remove(term_id)
    }

    /// Input handle of a terminal owned by `client_id`.
    fn input_for(&self, term_id: &str, client_id: &str) -> Option<TerminalInput> {
        let map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        map.get(term_id).filter(|e| e.client_id == client_id).map(|e| e.input.clone())
    }

    fn remove_owned(&self, term_id: &str, client_id: &str) -> Option<TermEntry> {
        let mut map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if map.get(term_id).map(|e| e.client_id == client_id).unwrap_or(false) { map.remove(term_id) } else { None }
    }

    fn drain_client(&self, client_id: &str) -> Vec<TermEntry> {
        let mut map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let ids: Vec<String> = map.iter().filter(|(_, e)| e.client_id == client_id).map(|(k, _)| k.clone()).collect();
        ids.into_iter().filter_map(|id| map.remove(&id)).collect()
    }

    /// Number of open terminals (diagnostics).
    pub fn len(&self) -> usize {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Panes that currently have a TeleFlock terminal attached.
    pub fn panes(&self) -> Vec<String> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).values().map(|e| e.pane_id.clone()).collect()
    }
}

impl TermEntry {
    fn shutdown(self) {
        let _ = self.input.release();
        self.stop.cancel();
    }
}

pub async fn handle(ctx: &Ctx, req: HostMethod, client: &ClientHandle) -> Result<Value, ApiError> {
    match req {
        HostMethod::TermOpen(p) => to_value(open(ctx, p, client).await?),
        HostMethod::TermResize(p) => {
            let input = owned_input(ctx, &p.term_id, client)?;
            input.resize(p.cols.max(2), p.rows.max(1)).map_err(term_err)?;
            to_value(Empty {})
        }
        HostMethod::TermScroll(p) => {
            let input = owned_input(ctx, &p.term_id, client)?;
            let dir = match p.direction {
                ScrollDirection::Up => tf_herdr::ScrollDirection::Up,
                ScrollDirection::Down => tf_herdr::ScrollDirection::Down,
            };
            input.scroll(dir, p.lines.max(1)).map_err(term_err)?;
            to_value(Empty {})
        }
        HostMethod::TermClose(p) => {
            if let Some(entry) = ctx.terms.remove_owned(&p.term_id, client.id()) {
                entry.shutdown();
            }
            to_value(Empty {})
        }
        other => Err(ApiError::new("unknown_method", format!("{} is not a term method", other.name()))),
    }
}

fn owned_input(ctx: &Ctx, term_id: &str, client: &ClientHandle) -> Result<TerminalInput, ApiError> {
    ctx.terms
        .input_for(term_id, client.id())
        .ok_or_else(|| ApiError::new("not_found", format!("terminal {term_id} is not open")).with_hint("Re-open the terminal."))
}

fn term_err(e: tf_herdr::HerdrError) -> ApiError {
    if e.code == tf_herdr::code::INVALID_REQUEST || e.message.contains("observe") {
        ApiError::new("unsupported", e.message).with_hint("This terminal is read-only (observe mode).")
    } else {
        herdr_err(e)
    }
}

/// `ClientMsg::TermIn` fast path (no response). Errors are reported on the stream.
pub async fn input(ctx: &Ctx, client: &ClientHandle, term_id: &str, data: &str) {
    let Some(input) = ctx.terms.input_for(term_id, client.id()) else {
        client.send(ServerMsg::Term { term_id: term_id.to_string(), ev: TermEvent::Closed { reason: "not open".into() } });
        return;
    };
    if let Err(e) = input.input(data) {
        client.send(ServerMsg::Term { term_id: term_id.to_string(), ev: TermEvent::Error { message: e.message } });
    }
}

/// Client disconnected: detach every terminal it had open.
pub async fn client_gone(ctx: &Ctx, client_id: &str) {
    for entry in ctx.terms.drain_client(client_id) {
        entry.shutdown();
    }
}

/// Pane to attach to, creating a shell pane for [`TermTarget::Shell`].
async fn resolve_target(ctx: &Ctx, target: &TermTarget) -> Result<String, ApiError> {
    match target {
        TermTarget::Pane { pane_id } => Ok(pane_id.clone()),
        TermTarget::Agent { agent_id } => ctx
            .state
            .agent(agent_id)
            .map(|a| a.pane_id)
            .ok_or_else(|| ApiError::new("not_found", format!("agent {agent_id} not found"))),
        TermTarget::Shell { workspace_id, cwd, split } => {
            let cwd = match cwd.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
                Some(c) => Some(existing_dir(c)?),
                None => None,
            };
            let pane = match (workspace_id, cwd) {
                (Some(ws), cwd) => match split.unwrap_or(Split::Tab) {
                    // A new tab never shrinks the panes (and agent TUIs) already there.
                    Split::Tab => {
                        let tab = ctx
                            .herdr
                            .tab_create(&tf_herdr::TabCreate { workspace_id: Some(ws.clone()), cwd, focus: false, ..Default::default() })
                            .await
                            .map_err(map_herdr)?;
                        tab.root_pane.pane_id
                    }
                    dir => {
                        let direction = if dir == Split::Down { tf_herdr::SplitDirection::Down } else { tf_herdr::SplitDirection::Right };
                        let target_pane_id = focused_pane(ctx, ws);
                        ctx.herdr
                            .pane_split(&tf_herdr::PaneSplit {
                                target_pane_id,
                                workspace_id: Some(ws.clone()),
                                direction,
                                cwd,
                                focus: false,
                                ..Default::default()
                            })
                            .await
                            .map_err(map_herdr)?
                            .pane_id
                    }
                },
                (None, Some(cwd)) => {
                    let created = ctx
                        .herdr
                        .workspace_create(&tf_herdr::WorkspaceCreate { cwd: Some(cwd), focus: false, ..Default::default() })
                        .await
                        .map_err(map_herdr)?;
                    created.root_pane.pane_id
                }
                (None, None) => return Err(ApiError::new("invalid_params", "shell target needs a workspaceId or a cwd")),
            };
            ctx.state.refresh();
            Ok(pane)
        }
    }
}

/// Focused pane of a workspace (from the state snapshot), else its first pane.
fn focused_pane(ctx: &Ctx, workspace_id: &str) -> Option<String> {
    let snap = ctx.state.snapshot();
    let ws = snap.workspaces.iter().find(|w| w.id == workspace_id)?;
    let panes = || ws.tabs.iter().flat_map(|t| t.panes.iter());
    panes().find(|p| p.focused).or_else(|| panes().next()).map(|p| p.id.clone())
}

fn pane_title(ctx: &Ctx, pane_id: &str) -> Option<String> {
    let snap = ctx.state.snapshot();
    snap.workspaces.iter().flat_map(|w| w.tabs.iter()).flat_map(|t| t.panes.iter()).find(|p| p.id == pane_id).and_then(|p| p.title.clone())
}

pub async fn open(ctx: &Ctx, p: TermOpenParams, client: &ClientHandle) -> Result<TermOpened, ApiError> {
    let pane_id = resolve_target(ctx, &p.target).await?;
    let mode = match p.mode {
        TermMode::Control => TerminalMode::Control,
        TermMode::Observe => TerminalMode::Observe,
    };
    let opts = TerminalOptions { target: pane_id.clone(), mode, cols: p.cols.max(2), rows: p.rows.max(1), takeover: p.takeover };
    let session = ctx.herdr.terminal_session(opts).await.map_err(|e| {
        if e.code == tf_herdr::code::STREAM_CONFLICT || e.message.contains("already has an attached client") {
            ApiError::new("busy", "another client controls this terminal")
                .with_hint("Open it with takeover to take control, or open it read-only.")
        } else {
            map_herdr(e)
        }
    })?;
    let (mut events, input) = session.split();
    let term_id = crate::util::new_id("t");
    let stop = CancellationToken::new();
    ctx.terms.insert(term_id.clone(), TermEntry { client_id: client.id().to_string(), pane_id: pane_id.clone(), input, stop: stop.clone() });

    let registry = ctx.terms.clone();
    let client = client.clone();
    let tid = term_id.clone();
    let daemon_cancel = ctx.cancel.clone();
    tokio::spawn(async move {
        let reason = loop {
            tokio::select! {
                _ = stop.cancelled() => break None,
                _ = client.closed() => break None,
                _ = daemon_cancel.cancelled() => break Some("host daemon stopping".to_string()),
                ev = events.recv() => match ev {
                    Some(TerminalEvent::Frame(f)) => {
                        let msg = ServerMsg::Term {
                            term_id: tid.clone(),
                            ev: TermEvent::Frame { seq: f.seq, full: f.full, cols: f.cols, rows: f.rows, data: f.bytes },
                        };
                        if !client.send(msg) {
                            break None;
                        }
                    }
                    Some(TerminalEvent::Closed { reason }) => break Some(reason),
                    None => break Some("terminal stream ended".to_string()),
                },
            }
        };
        if let Some(entry) = registry.remove(&tid) {
            entry.shutdown();
        }
        if let Some(reason) = reason {
            client.send(ServerMsg::Term { term_id: tid, ev: TermEvent::Closed { reason } });
        }
    });

    Ok(TermOpened { term_id, title: pane_title(ctx, &pane_id), pane_id })
}
