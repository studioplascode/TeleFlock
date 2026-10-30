//! Done-agent lifecycle (architecture §3.5): parking, resume bookkeeping and pruning.
//!
//! *Mark done* with `close` archives an agent and, after [`PARK_GRACE`] (the app's Undo window),
//! closes its herdr pane once it is idle. Its board card survives as a parked agent built from a
//! persisted [`ParkedRecord`] (same agent id, no pane). Resuming starts `omp --resume=<file>` in a
//! new pane; the parked card is swapped for the live agent in the same patch. A parked agent whose
//! omp session file is deleted is pruned (also archived live agents whose known file vanished):
//! removed from the board, its activity dropped, and listed in `HostInfo.pruned`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use tf_proto::model::{
    Agent, Column, HerdrState, LinkState, LinkedWorktree, Liveness, OmpInfo, OmpMode, Parked, PrunedAgent, QueueInfo, Workspace,
};
use tf_proto::session::SessionMeta;
use tf_proto::Millis;

use super::persist::{ParkedRecord, ParkedWorktree, SessionData};
use super::StateHandle;
use crate::ops::Ctx;
use crate::util::now_ms;

/// Undo window between *Mark done* and closing the pane.
pub const PARK_GRACE: Duration = Duration::from_secs(10);
/// How often session files of parked / archived agents are checked.
pub const PRUNE_EVERY: Duration = Duration::from_secs(60);
/// A sessions root that stays without a verdict is logged again after this long.
const PRUNE_REWARN: Duration = Duration::from_secs(3600);
/// `HostInfo.pruned`: at most this many entries …
pub const PRUNED_CAP: usize = 200;
/// … none older than 30 days.
pub const PRUNED_MAX_AGE_MS: Millis = 30 * 24 * 3600 * 1000;
/// A resume whose new agent never showed up releases the parked card again after this long.
const RESUME_TIMEOUT: Duration = Duration::from_secs(90);

// ───────────────────────────── pure mapping ─────────────────────────────

/// The session file of an agent that may be parked now: archived, idle (not working, nothing
/// pending), an omp agent with a known session file, not parked already.
pub fn parkable(a: &Agent) -> Option<&str> {
    let idle = matches!(a.state, HerdrState::Idle | HerdrState::Done) && a.needs.is_none();
    if !a.archived || a.column != Column::Done || !idle || a.kind != "omp" || a.parked.is_some() {
        return None;
    }
    a.omp.as_ref()?.session_file.as_deref().filter(|f| !f.is_empty())
}

/// Snapshot of a live agent for its parked card.
pub fn record_from_agent(
    a: &Agent,
    archived_at: Millis,
    now: Millis,
    worktree: Option<ParkedWorktree>,
    workspace_cwd: Option<String>,
) -> Option<ParkedRecord> {
    let omp = a.omp.as_ref()?;
    let session_file = omp.session_file.clone().filter(|f| !f.is_empty())?;
    Some(ParkedRecord {
        agent_id: a.id.clone(),
        name: a.name.clone(),
        kind: a.kind.clone(),
        title: a.title.clone(),
        cwd: a.cwd.clone(),
        repo: a.repo.clone(),
        branch: a.branch.clone(),
        session_id: omp.session_id.clone(),
        session_file,
        model: omp.model.clone(),
        thinking: omp.thinking,
        started_at: a.started_at,
        archived_at,
        parked_at: now,
        turns: a.turns,
        diff: a.diff.clone(),
        cost: omp.cost.clone(),
        last_turn_ended_at: omp.last_turn_ended_at,
        line: a.live.line.clone(),
        worktree,
        workspace_id: Some(a.workspace_id.clone()).filter(|w| !w.is_empty()),
        workspace_cwd,
        moved: None,
        ended: None,
    })
}

/// The board card of a parked agent (column Done, archived, no pane, `link: notShared`). An
/// ended one (its omp ended without anyone closing it, `crate::restart`) sits in Review, not archived.
pub fn parked_agent(r: &ParkedRecord) -> Agent {
    let omp = OmpInfo {
        session_id: r.session_id.clone(),
        session_file: Some(r.session_file.clone()),
        pid: None,
        version: None,
        link: LinkState::NotShared,
        link_error: None,
        link_reason: None,
        link_via: None,
        link_since: None,
        bridge: false,
        model: r.model.clone(),
        thinking: r.thinking,
        fast: false,
        mode: OmpMode::Normal,
        goal: None,
        context: None,
        cost: r.cost.clone(),
        todos: None,
        subagents: None,
        jobs: None,
        retry: None,
        queue: QueueInfo { steering: vec![], follow_up: vec![] },
        turn_started_at: None,
        last_turn_ended_at: r.last_turn_ended_at,
        // Filled by the state store from omp's recap journal (`crate::recaps`).
        recap: None,
    };
    Agent {
        id: r.agent_id.clone(),
        name: r.name.clone(),
        kind: r.kind.clone(),
        pane_id: String::new(),
        tab_id: String::new(),
        workspace_id: String::new(),
        state: HerdrState::Idle,
        state_since: r.parked_at,
        column: if r.ended.is_some() { Column::Review } else { Column::Done },
        archived: r.ended.is_none(),
        turns: r.turns,
        title: r.title.clone(),
        cwd: r.cwd.clone(),
        repo: r.repo.clone(),
        branch: r.branch.clone(),
        started_at: r.started_at,
        omp: Some(omp),
        live: Liveness { last_event_at: None, streaming: false, thinking: false, tool: None, tps: None, tps_split: None, line: r.line.clone() },
        needs: None,
        diff: r.diff.clone(),
        parked: Some(Parked {
            at: r.parked_at,
            session_file: r.session_file.clone(),
            worktree: r.worktree.as_ref().map(|w| LinkedWorktree { path: w.path.clone(), repo_root: w.repo_root.clone() }),
            moved: r.moved.clone(),
            ended: r.ended.clone(),
        }),
        auto_resume: None,
        // The state store's rebuild fills it (an agent's own policy carries over to its resume).
        auto_answer: None,
    }
}

/// Read-only session meta of a parked agent (`session.open`): no controls except prompting,
/// which resumes it.
pub fn parked_meta(r: &ParkedRecord) -> SessionMeta {
    let mut meta = tf_collab::Replica::new(&r.agent_id).meta().clone();
    meta.session_id = r.session_id.clone();
    meta.session_file = Some(r.session_file.clone());
    meta.title = Some(r.title.clone());
    meta.cwd = r.cwd.clone();
    meta.model = r.model.clone();
    meta.thinking = r.thinking;
    meta.cost = r.cost.clone();
    meta.started_at = r.started_at;
    meta.caps = super::build::capabilities(false, false, None);
    meta.caps.prompt = true;
    for c in [
        &mut meta.caps.model,
        &mut meta.caps.thinking,
        &mut meta.caps.fast,
        &mut meta.caps.plan,
        &mut meta.caps.goal,
        &mut meta.caps.compact,
        &mut meta.caps.rename,
        &mut meta.caps.fork,
        &mut meta.caps.export,
        &mut meta.caps.handoff,
    ] {
        *c = false;
    }
    meta
}

/// A live agent runs the parked agent's omp session (resumed elsewhere, or by `agent.resume`).
pub fn same_session(live: &Agent, r: &ParkedRecord) -> bool {
    let Some(o) = &live.omp else { return false };
    (r.session_id.is_some() && o.session_id == r.session_id) || (!r.session_file.is_empty() && o.session_file.as_deref() == Some(r.session_file.as_str()))
}

/// Why a parked record leaves the board during a rebuild.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gone {
    /// `agent.resume` started its replacement and that agent is on the board now.
    Resumed,
    /// Another live agent runs the same omp session.
    Superseded,
}

/// Adds parked cards to the live agents built from herdr. A record whose agent id is still live
/// (the pane is being closed) stays hidden; a record whose session runs live again is dropped.
pub fn merge(
    parked: &BTreeMap<String, ParkedRecord>,
    live_ids: &HashSet<String>,
    resumed_as: &HashMap<String, String>,
    agents: &mut Vec<Agent>,
) -> Vec<(String, Gone)> {
    let mut drops = Vec::new();
    let mut cards = Vec::new();
    for r in parked.values() {
        if resumed_as.get(&r.agent_id).is_some_and(|new| live_ids.contains(new)) {
            drops.push((r.agent_id.clone(), Gone::Resumed));
        } else if live_ids.contains(&r.agent_id) {
            continue;
        } else if agents.iter().any(|a| a.id != r.agent_id && a.parked.is_none() && same_session(a, r)) {
            drops.push((r.agent_id.clone(), Gone::Superseded));
        } else {
            cards.push(parked_agent(r));
        }
    }
    agents.extend(cards);
    drops
}

/// How *Mark done* closes an agent's pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseScope {
    /// The workspace holds nothing but this pane (a Dispatch / worktree workspace): close it.
    Workspace(String),
    /// Close just the pane.
    Pane(String),
    /// The pane is the only one of a primary workspace that groups linked worktrees: closing it
    /// would take the group down, so a shell tab keeps the workspace open first.
    PaneKeepWorkspace { pane_id: String, workspace_id: String },
}

pub fn close_scope(a: &Agent, workspaces: &[Workspace]) -> CloseScope {
    let pane = || CloseScope::Pane(a.pane_id.clone());
    let Some(ws) = workspaces.iter().find(|w| w.id == a.workspace_id) else { return pane() };
    let mut panes = ws.tabs.iter().flat_map(|t| t.panes.iter());
    let exclusive = panes.next().is_some_and(|p| p.id == a.pane_id) && panes.next().is_none();
    if !exclusive {
        return pane();
    }
    let groups_worktrees = ws.worktree.is_none()
        && workspaces.iter().any(|o| o.id != ws.id && o.worktree.as_ref().and_then(|w| w.primary_workspace_id.as_deref()) == Some(ws.id.as_str()));
    if groups_worktrees {
        CloseScope::PaneKeepWorkspace { pane_id: a.pane_id.clone(), workspace_id: ws.id.clone() }
    } else {
        CloseScope::Workspace(ws.id.clone())
    }
}

/// Adds a prune entry (newest first) and applies the cap and age limit.
pub fn push_pruned(list: &mut Vec<PrunedAgent>, entry: PrunedAgent, now: Millis) {
    list.retain(|p| p.agent_id != entry.agent_id);
    list.insert(0, entry);
    trim_pruned(list, now);
}

/// Drops entries past the cap or older than 30 days. True when something was dropped.
pub fn trim_pruned(list: &mut Vec<PrunedAgent>, now: Millis) -> bool {
    let before = list.len();
    list.retain(|p| now - p.at <= PRUNED_MAX_AGE_MS);
    list.truncate(PRUNED_CAP);
    list.len() != before
}

/// Removes every trace of an agent from the session data (archive, counters, activity).
fn forget(s: &mut SessionData, agent_id: &str, session_id: Option<&str>) {
    s.parked.remove(agent_id);
    s.archived.remove(agent_id);
    if let Some(sid) = session_id {
        s.archived_sessions.remove(sid);
    }
    s.turns.remove(agent_id);
    s.first_seen.remove(agent_id);
    s.activity.retain(|e| e.agent_id != agent_id);
}

// ───────────────────────────── store side ─────────────────────────────

/// In-memory lifecycle bookkeeping of one store (not persisted).
#[derive(Default)]
pub(super) struct Lifecycle {
    /// Pending *Mark done* closes: agent id → (generation, cancel).
    waits: HashMap<String, (u64, CancellationToken)>,
    next_gen: u64,
    /// Parked agents being resumed (claimed), with the new agent id once started.
    resuming: HashMap<String, (Option<String>, Instant)>,
}

/// Exclusive claim on resuming one parked agent; released on drop.
pub struct ResumeClaim {
    state: StateHandle,
    agent_id: String,
}

impl Drop for ResumeClaim {
    fn drop(&mut self) {
        let mut m = self.state.lock();
        if m.life.resuming.get(&self.agent_id).is_some_and(|(new, _)| new.is_none()) {
            m.life.resuming.remove(&self.agent_id);
        }
    }
}

impl StateHandle {
    /// Starts the undo window of a *Mark done* with close (replacing a pending one).
    pub fn schedule_park(&self, agent_id: &str) -> (u64, CancellationToken) {
        let mut m = self.lock();
        m.life.next_gen += 1;
        let entry = (m.life.next_gen, CancellationToken::new());
        if let Some((_, old)) = m.life.waits.insert(agent_id.to_string(), entry.clone()) {
            old.cancel();
        }
        entry
    }

    /// Cancels a pending close (un-archive / Undo). True when one was pending.
    pub fn cancel_park(&self, agent_id: &str) -> bool {
        match self.lock().life.waits.remove(agent_id) {
            Some((_, t)) => {
                t.cancel();
                true
            }
            None => false,
        }
    }

    /// The undo window ended: true when this wait is still the pending one (not cancelled or
    /// replaced meanwhile). The entry stays until [`finish_park_wait`](Self::finish_park_wait),
    /// so an Undo arriving while the pane is being closed still finds and cancels it.
    pub fn park_due(&self, agent_id: &str, generation: u64) -> bool {
        let m = self.lock();
        matches!(m.life.waits.get(agent_id), Some((g, t)) if *g == generation && !t.is_cancelled())
    }

    /// The close after the undo window is over: drops the wait if it is still the given one.
    pub fn finish_park_wait(&self, agent_id: &str, generation: u64) {
        let mut m = self.lock();
        if m.life.waits.get(agent_id).is_some_and(|(g, _)| *g == generation) {
            m.life.waits.remove(agent_id);
        }
    }

    pub fn parked(&self, agent_id: &str) -> Option<ParkedRecord> {
        self.inner.persist.read(|d| d.sessions.get(&self.inner.session).and_then(|s| s.parked.get(agent_id).cloned()))
    }

    pub fn parked_all(&self) -> Vec<ParkedRecord> {
        self.inner.persist.read(|d| d.sessions.get(&self.inner.session).map(|s| s.parked.values().cloned().collect()).unwrap_or_default())
    }

    /// Activity under an explicit name (an agent the board has not built yet).
    pub fn record_activity_as(&self, agent_id: &str, name: &str, kind: tf_proto::model::ActivityKind, title: String, detail: Option<String>) {
        self.push_activity(agent_id, name, kind, title, detail);
    }

    /// When the agent was archived (persisted, by agent id or omp session).
    pub fn archived_at(&self, agent_id: &str) -> Option<Millis> {
        let sid = self.omp_session_of(agent_id).or_else(|| self.lock().tracks.get(agent_id).and_then(|t| t.omp_session.clone()));
        self.inner.persist.read(|d| {
            let s = d.sessions.get(&self.inner.session)?;
            s.archived.get(agent_id).copied().or_else(|| sid.and_then(|sid| s.archived_sessions.get(&sid).copied()))
        })
    }

    /// Stores a parked record (the card shows once the agent's pane is gone).
    pub fn park(&self, rec: ParkedRecord) {
        info!(session = %self.inner.session, agent = %rec.agent_id, file = %rec.session_file, "parked");
        self.inner.persist.session(&self.inner.session, |s| {
            s.parked.insert(rec.agent_id.clone(), rec);
        });
        self.inner.persist.save_now();
        self.mark_dirty();
    }

    /// Drops a parked record whose pane could not be closed.
    pub fn unpark(&self, agent_id: &str) {
        self.inner.persist.session(&self.inner.session, |s| {
            s.parked.remove(agent_id);
        });
        self.mark_dirty();
    }

    /// herdr reuses agent ids at once: a different agent now lives under the id of a parked card.
    /// The card moves to `new_id` (its archive mark with it), persisted, so both show on the board.
    /// False: no such parked card. A card already under `new_id` (made again from the ledger) wins.
    pub fn rekey_parked(&self, old_id: &str, new_id: &str) -> bool {
        let mut found = false;
        self.inner.persist.session(&self.inner.session, |s| {
            let Some(mut r) = s.parked.remove(old_id) else { return };
            found = true;
            r.agent_id = new_id.to_string();
            s.parked.entry(new_id.to_string()).or_insert(r);
            if let Some(at) = s.archived.remove(old_id) {
                s.archived.entry(new_id.to_string()).or_insert(at);
            }
        });
        if found {
            info!(session = %self.inner.session, old = %old_id, new = %new_id, "parked card moved to a new key: its agent id is used by another agent");
            self.inner.persist.save_now();
            self.mark_dirty();
        }
        found
    }

    /// Sets (or clears) a parked agent's move mark (`ops::moves`). False: no such parked agent.
    pub fn set_parked_move(&self, agent_id: &str, mv: Option<tf_proto::ParkedMove>) -> bool {
        let mut found = false;
        self.inner.persist.session(&self.inner.session, |s| {
            if let Some(r) = s.parked.get_mut(agent_id) {
                r.moved = mv;
                found = true;
            }
        });
        if found {
            self.inner.persist.save_now();
            self.mark_dirty();
        }
        found
    }

    /// An ended parked agent (`crate::restart`) that will not be brought back (Dismiss, Mark done)
    /// becomes an ordinary parked one: archived, in Done. False: no such ended agent.
    pub fn finish_ended(&self, agent_id: &str) -> bool {
        let now = now_ms();
        let mut found = false;
        self.inner.persist.session(&self.inner.session, |s| {
            let Some(r) = s.parked.get_mut(agent_id).filter(|r| r.ended.is_some()) else { return };
            r.ended = None;
            r.archived_at = now;
            let sid = r.session_id.clone();
            s.archived.insert(agent_id.to_string(), now);
            if let Some(sid) = sid {
                s.archived_sessions.insert(sid, now);
            }
            found = true;
        });
        if found {
            self.inner.persist.save_now();
            self.mark_dirty();
        }
        found
    }

    /// The linked worktree at `path` is gone (removed on request): parked records that ran there
    /// forget it, so their cards stop offering to delete it. `same` compares two paths.
    pub fn forget_parked_worktree(&self, same: impl Fn(&str) -> bool) {
        let mut changed = false;
        self.inner.persist.session(&self.inner.session, |s| {
            for r in s.parked.values_mut() {
                if r.worktree.as_ref().is_some_and(|w| same(&w.path)) {
                    r.worktree = None;
                    changed = true;
                }
            }
        });
        if changed {
            self.inner.persist.save_now();
            self.mark_dirty();
        }
    }

    /// Claims resuming a parked agent; `None` while another resume of it is in flight.
    pub fn claim_resume(&self, agent_id: &str) -> Option<ResumeClaim> {
        let mut m = self.lock();
        if m.life.resuming.contains_key(agent_id) {
            return None;
        }
        m.life.resuming.insert(agent_id.to_string(), (None, Instant::now()));
        Some(ResumeClaim { state: self.clone(), agent_id: agent_id.to_string() })
    }

    /// The replacement of a parked agent started: clears its archive marks (it lands
    /// un-archived) and swaps the card for `new_id` as soon as that agent is on the board.
    pub fn resumed(&self, claim: ResumeClaim, new_id: &str) {
        let id = claim.agent_id.clone();
        let sid = self.parked(&id).and_then(|r| r.session_id);
        self.inner.persist.session(&self.inner.session, |s| {
            s.archived.remove(&id);
            if let Some(sid) = &sid {
                s.archived_sessions.remove(sid);
            }
        });
        self.lock().life.resuming.insert(id, (Some(new_id.to_string()), Instant::now()));
        drop(claim);
        self.mark_dirty();
    }

    /// Every agent id the board knows (live, parked, being resumed) once it is built from a
    /// loaded herdr snapshot; `None` before that or while herdr is unreachable (an empty board
    /// then says nothing about which agents are gone).
    pub fn agent_ids_in_use(&self) -> Option<HashSet<String>> {
        let m = self.lock();
        if !(m.mirror.ok && m.built_once) {
            return None;
        }
        let mut ids: HashSet<String> = m.published.agents.iter().map(|a| a.id.clone()).collect();
        for (old, (new, _)) in &m.life.resuming {
            ids.insert(old.clone());
            ids.extend(new.clone());
        }
        Some(ids)
    }

    /// Removes a parked agent whose session file is gone.
    pub fn prune_parked(&self, agent_id: &str) -> bool {
        let Some(rec) = self.parked(agent_id) else { return false };
        self.prune(agent_id, rec.session_id.as_deref());
        true
    }

    /// Forgets an agent whose omp session file was deleted and lists it in `HostInfo.pruned`.
    pub fn prune(&self, agent_id: &str, session_id: Option<&str>) {
        info!(session = %self.inner.session, agent = agent_id, "pruned: session file deleted");
        let now = now_ms();
        self.inner.persist.session(&self.inner.session, |s| {
            forget(s, agent_id, session_id);
            push_pruned(&mut s.pruned, PrunedAgent { agent_id: agent_id.to_string(), session_id: session_id.map(str::to_string), at: now }, now);
        });
        self.lock().life.resuming.remove(agent_id);
        self.mark_dirty();
    }

    /// Ages out old prune entries (published with the next rebuild).
    fn trim_pruned(&self) {
        let now = now_ms();
        let changed = self.inner.persist.read(|d| {
            d.sessions.get(&self.inner.session).is_some_and(|s| s.pruned.iter().any(|p| now - p.at > PRUNED_MAX_AGE_MS))
        });
        if changed {
            self.inner.persist.session(&self.inner.session, |s| {
                trim_pruned(&mut s.pruned, now);
            });
            self.mark_dirty();
        }
    }
}

/// Rebuild step: merges parked cards into `agents` and applies the drops to `state.json`.
pub(super) fn merge_into(h: &StateHandle, m: &mut super::Inner, persisted: &SessionData, live_ids: &HashSet<String>, agents: &mut Vec<Agent>) {
    if persisted.parked.is_empty() {
        return;
    }
    // A resume whose agent never appeared gives the card back.
    m.life.resuming.retain(|_, (new, at)| new.is_none() || at.elapsed() < RESUME_TIMEOUT);
    let resumed_as: HashMap<String, String> =
        m.life.resuming.iter().filter_map(|(id, (new, _))| new.clone().map(|n| (id.clone(), n))).collect();
    let drops = merge(&persisted.parked, live_ids, &resumed_as, agents);
    if drops.is_empty() {
        return;
    }
    for (id, _) in &drops {
        m.life.resuming.remove(id);
    }
    let sids: Vec<(String, Option<String>)> =
        drops.iter().map(|(id, _)| (id.clone(), persisted.parked.get(id).and_then(|r| r.session_id.clone()))).collect();
    info!(session = %h.inner.session, ?drops, "parked agents live again");
    h.inner.persist.session(&h.inner.session, |s| {
        for (id, sid) in &sids {
            s.parked.remove(id);
            s.archived.remove(id);
            if let Some(sid) = sid {
                s.archived_sessions.remove(sid);
            }
        }
    });
}

// ───────────────────────────── herdr side ─────────────────────────────

/// Checks the board's [`close_scope`] against herdr itself right before closing (the board may
/// lag: a pane opened seconds ago, or the agent's pane id reused). `pane`: `pane.get` of the
/// agent's pane; `ws`: `workspace.get` of the workspace the scope names. `None`: the pane is no
/// longer the agent's (or herdr could not say), so nothing is closed. A workspace is closed only
/// when herdr reports exactly one tab with one pane: this one; otherwise just the pane.
pub fn verify_close(
    scope: CloseScope,
    agent_id: &str,
    pane: Option<&tf_herdr::PaneInfo>,
    ws: Option<&tf_herdr::WorkspaceInfo>,
) -> Option<CloseScope> {
    let pane = pane?;
    let owner = if pane.terminal_id.is_empty() { &pane.pane_id } else { &pane.terminal_id };
    if owner != agent_id {
        return None;
    }
    let alone_in = |id: &str| ws.is_some_and(|w| w.workspace_id == id && pane.workspace_id == id && w.pane_count == 1 && w.tab_count == 1);
    Some(match scope {
        CloseScope::Workspace(id) if alone_in(&id) => CloseScope::Workspace(id),
        CloseScope::PaneKeepWorkspace { workspace_id, .. } if ws.is_some_and(|w| w.workspace_id == workspace_id && w.pane_count > 1) => {
            CloseScope::Pane(pane.pane_id.clone())
        }
        keep @ CloseScope::PaneKeepWorkspace { .. } => keep,
        CloseScope::Workspace(_) | CloseScope::Pane(_) => CloseScope::Pane(pane.pane_id.clone()),
    })
}

/// Closes a done agent's pane per [`close_scope`], verified against herdr ([`verify_close`]).
/// Re-checks right before closing that the agent is still archived and, with `undo`, that the
/// *Mark done* was not undone meanwhile. `Ok(false)`: nothing was closed.
pub async fn close_agent(ctx: &Ctx, a: &Agent, undo: Option<&CancellationToken>) -> Result<bool, tf_herdr::HerdrError> {
    let board = close_scope(a, &ctx.state.snapshot().workspaces);
    let pane = ctx.herdr.pane_get(&a.pane_id).await.ok();
    let ws = match &board {
        CloseScope::Workspace(w) | CloseScope::PaneKeepWorkspace { workspace_id: w, .. } => ctx.herdr.workspace_get(w).await.ok(),
        CloseScope::Pane(_) => None,
    };
    let Some(scope) = verify_close(board.clone(), &a.id, pane.as_ref(), ws.as_ref()) else {
        info!(agent = %a.id, pane = %a.pane_id, "done agent's pane is gone or reused; closing nothing");
        return Ok(false);
    };
    if undo.is_some_and(CancellationToken::is_cancelled) || ctx.state.archived_at(&a.id).is_none() {
        info!(agent = %a.id, "done agent un-archived meanwhile; keeping its pane");
        return Ok(false);
    }
    info!(agent = %a.id, ?board, ?scope, "closing done agent");
    match scope {
        CloseScope::Workspace(ws) => ctx.herdr.workspace_close(&ws, false).await?,
        CloseScope::Pane(p) => ctx.herdr.pane_close(&p).await?,
        CloseScope::PaneKeepWorkspace { pane_id, workspace_id } => {
            ctx.herdr.tab_create(&tf_herdr::TabCreate { workspace_id: Some(workspace_id), focus: false, ..Default::default() }).await?;
            ctx.herdr.pane_close(&pane_id).await?;
        }
    }
    ctx.state.refresh();
    Ok(true)
}

/// What a stat says about a session file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileCheck {
    Present,
    /// `NotFound` while its folder (or, the folder deleted too, the sessions root above it)
    /// stats fine: deleted.
    Missing,
    /// Anything else (permissions, I/O, a stale or unmounted file system): no verdict, never
    /// prunes.
    Unknown(String),
}

pub fn check_file(path: &Path) -> FileCheck {
    match std::fs::metadata(path) {
        Ok(m) if m.is_file() => FileCheck::Present,
        Ok(_) => FileCheck::Unknown(format!("{} is not a file", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // omp keeps sessions in `<sessions>/<folder slug>/<file>`: the file's folder must be
            // a folder, or, when that is gone too, the sessions root a folder that still holds
            // something (an unmounted mount point is an empty folder).
            for (level, dir) in path.ancestors().skip(1).take(2).enumerate() {
                match std::fs::metadata(dir) {
                    Ok(d) if d.is_dir() && level == 0 => return FileCheck::Missing,
                    Ok(d) if d.is_dir() => {
                        return match std::fs::read_dir(dir).map(|mut it| it.next().is_some()) {
                            Ok(true) => FileCheck::Missing,
                            Ok(false) => FileCheck::Unknown(format!("{} is empty (unmounted?)", dir.display())),
                            Err(e) => FileCheck::Unknown(format!("{}: {e}", dir.display())),
                        };
                    }
                    Ok(_) => return FileCheck::Unknown(format!("{} is not a folder", dir.display())),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(e) => return FileCheck::Unknown(format!("{}: {e}", dir.display())),
                }
            }
            FileCheck::Unknown(format!("{}: its folders are gone too (unmounted?)", path.display()))
        }
        Err(e) => FileCheck::Unknown(format!("{}: {e}", path.display())),
    }
}

/// Prune bookkeeping across passes (not persisted).
#[derive(Debug, Default)]
pub struct PruneMemory {
    /// Session files of live agents seen on disk: omp writes a session file lazily, so a live
    /// agent is pruned only once its file existed and then vanished.
    known: HashSet<String>,
    /// Consecutive passes a known live agent's file was missing.
    misses: HashMap<String, u32>,
    /// Sessions roots skipped for lack of a verdict → (reason, when it was logged).
    warned: HashMap<String, (String, Instant)>,
}

impl PruneMemory {
    /// The skipped roots worth a log line: new ones, ones whose reason changed and ones last logged
    /// [`PRUNE_REWARN`] ago. Roots no longer skipped are forgotten, so a relapse logs again.
    pub fn problems_to_log(&mut self, skipped: &[(String, String)], now: Instant) -> Vec<(String, String)> {
        self.warned.retain(|root, _| skipped.iter().any(|(r, _)| r == root));
        let mut out = Vec::new();
        for (root, why) in skipped {
            let fresh = self.warned.get(root).is_none_or(|(w, at)| w != why || now.duration_since(*at) >= PRUNE_REWARN);
            if fresh {
                self.warned.insert(root.clone(), (why.clone(), now));
                out.push((root.clone(), why.clone()));
            }
        }
        out
    }
}

/// Misses in a row before an archived live agent's pane is closed.
pub const LIVE_MISSES: u32 = 2;

/// The sessions root a session file is judged with: omp keeps sessions in
/// `<sessions>/<folder slug>/<file>`, and one file system answers for a whole root.
fn sessions_root(file: &str) -> String {
    let p = Path::new(file);
    p.ancestors().nth(2).or_else(|| p.parent()).unwrap_or(p).to_string_lossy().into_owned()
}

/// One pass's verdicts ([`plan_prune`]).
#[derive(Debug, Default, PartialEq)]
pub struct PrunePlan {
    /// Parked agents whose session file is gone.
    pub parked: Vec<String>,
    /// Archived live agents whose known file was missing on [`LIVE_MISSES`] passes in a row.
    pub live: Vec<String>,
    /// Sessions roots without a verdict this pass, each with the first reason, by root.
    pub skipped: Vec<(String, String)>,
}

/// Which agents one pass prunes: parked agents whose file is missing, archived live agents
/// whose known file was missing on [`LIVE_MISSES`] passes in a row. A file without a verdict
/// skips every file under its sessions root ([`sessions_root`]) for this pass, memory untouched:
/// a file system that errs may err for all its files. Other roots are judged as usual.
pub fn plan_prune(parked: &[(String, String)], live: &[(String, String)], checks: &HashMap<String, FileCheck>, mem: &mut PruneMemory) -> PrunePlan {
    let check = |f: &str| checks.get(f).cloned().unwrap_or_else(|| FileCheck::Unknown(format!("{f}: not checked")));
    let mut skipped: BTreeMap<String, String> = BTreeMap::new();
    for (_, f) in parked.iter().chain(live) {
        if let FileCheck::Unknown(why) = check(f) {
            skipped.entry(sessions_root(f)).or_insert(why);
        }
    }
    let judged = |f: &str| !skipped.contains_key(&sessions_root(f));
    let gone_parked = parked.iter().filter(|(_, f)| judged(f) && check(f) == FileCheck::Missing).map(|(id, _)| id.clone()).collect();
    let mut gone_live = Vec::new();
    let mut known = HashSet::new();
    let mut misses = HashMap::new();
    for (id, f) in live {
        if !judged(f) {
            if mem.known.contains(f) {
                known.insert(f.clone());
            }
            if let Some(n) = mem.misses.get(f) {
                misses.insert(f.clone(), *n);
            }
        } else if check(f) == FileCheck::Present {
            known.insert(f.clone());
        } else if mem.known.contains(f) {
            let n = mem.misses.get(f).copied().unwrap_or(0) + 1;
            if n >= LIVE_MISSES {
                gone_live.push(id.clone());
            }
            // Kept until the pane is gone (a failed close retries next pass).
            known.insert(f.clone());
            misses.insert(f.clone(), n);
        }
    }
    mem.known = known;
    mem.misses = misses;
    PrunePlan { parked: gone_parked, live: gone_live, skipped: skipped.into_iter().collect() }
}

/// Checks session files at start and every [`PRUNE_EVERY`].
pub(super) async fn prune_loop(ctx: Arc<Ctx>) {
    let mut mem = PruneMemory::default();
    loop {
        prune_pass(&ctx, &mut mem).await;
        tokio::select! {
            _ = ctx.cancel.cancelled() => return,
            _ = tokio::time::sleep(PRUNE_EVERY) => {}
        }
    }
}

async fn prune_pass(ctx: &Ctx, mem: &mut PruneMemory) {
    let h = &ctx.state;
    h.trim_pruned();
    // Per-agent omp overlays (§3.7) of agents the board no longer knows.
    if let Some(keep) = h.agent_ids_in_use() {
        let store = crate::agentcfg::Store::new(&ctx.paths);
        let session = ctx.herdr_session.clone();
        let _ = tokio::task::spawn_blocking(move || store.sweep(&session, &keep, now_ms())).await;
    }
    // Ended cards (`crate::restart`) stay until they are back or dismissed: one that ended in its
    // first turn has no session file yet (omp writes it with the first reply) and comes back fresh.
    let parked: Vec<(String, String)> = h.parked_all().into_iter().filter(|r| r.ended.is_none()).map(|r| (r.agent_id, r.session_file)).collect();
    let live: Vec<Agent> = h
        .snapshot()
        .agents
        .into_iter()
        .filter(|a| a.parked.is_none() && parkable(a).is_some())
        .collect();
    let live_files: Vec<(String, String)> = live.iter().filter_map(|a| Some((a.id.clone(), parkable(a)?.to_string()))).collect();
    let files: Vec<String> = parked.iter().chain(&live_files).map(|(_, f)| f.clone()).collect();
    let checks: HashMap<String, FileCheck> = match tokio::task::spawn_blocking(move || files.into_iter().map(|f| { let c = check_file(Path::new(&f)); (f, c) }).collect()).await {
        Ok(c) => c,
        Err(_) => return,
    };
    let plan = plan_prune(&parked, &live_files, &checks, mem);
    for (root, why) in mem.problems_to_log(&plan.skipped, Instant::now()) {
        warn!(%root, "prune: no verdict for session files under {root} ({why}); agents whose files live there are not pruned until that changes");
    }
    for id in plan.parked {
        if !h.lock().life.resuming.contains_key(&id) {
            h.prune_parked(&id);
        }
    }
    for a in live.iter().filter(|a| plan.live.contains(&a.id)) {
        let sid = a.omp.as_ref().and_then(|o| o.session_id.clone());
        match close_agent(ctx, a, None).await {
            Ok(true) => h.prune(&a.id, sid.as_deref()),
            Ok(false) => {}
            Err(e) => warn!(agent = %a.id, "prune: closing the pane failed: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tf_proto::model::{CostInfo, DiffStat, ModelRef, PaneInfo as WirePane, Tab, ThinkingLevel, WorktreeInfo};

    fn live_agent() -> Agent {
        let mut a = parked_agent(&ParkedRecord { agent_id: "x".into(), kind: "omp".into(), session_file: "f".into(), ..Default::default() });
        a.id = "term_7".into();
        a.name = "lab".into();
        a.title = "Fix the parser".into();
        a.pane_id = "w2:p1".into();
        a.tab_id = "w2:t1".into();
        a.workspace_id = "w2".into();
        a.parked = None;
        a.archived = false;
        a.column = Column::Review;
        a.turns = 4;
        a.cwd = Some("/tmp/lab".into());
        a.repo = Some("lab".into());
        a.branch = Some("feat".into());
        a.started_at = Some(100);
        a.diff = Some(DiffStat { added: 3, removed: 1, files: 2 });
        a.live.line = Some("All tests pass.".into());
        let o = a.omp.as_mut().unwrap();
        o.session_id = Some("sid-1".into());
        o.session_file = Some("/s/a.jsonl".into());
        o.link = LinkState::Live;
        o.pid = Some(42);
        o.model = Some(ModelRef { provider: "anthropic".into(), id: "claude-x".into(), label: None });
        o.thinking = Some(ThinkingLevel::High);
        o.cost = Some(CostInfo { usd: 1.5, input: 10, output: 20, cache_read: 0, cache_write: 0, split: None });
        o.last_turn_ended_at = Some(900);
        a
    }

    #[test]
    fn record_roundtrips_to_a_parked_card() {
        let a = live_agent();
        let wt = ParkedWorktree { path: "/tmp/lab".into(), repo_root: "/tmp/main".into() };
        let rec = record_from_agent(&a, 500, 1000, Some(wt.clone()), Some("/tmp/lab".into())).unwrap();
        // Through state.json and back.
        let rec: ParkedRecord = serde_json::from_str(&serde_json::to_string(&rec).unwrap()).unwrap();
        assert_eq!(rec.worktree, Some(wt));
        assert_eq!((rec.archived_at, rec.parked_at, rec.workspace_id.as_deref()), (500, 1000, Some("w2")));
        let card = parked_agent(&rec);
        assert_eq!(card.id, a.id);
        assert_eq!((card.name.as_str(), card.title.as_str(), card.turns), ("lab", "Fix the parser", 4));
        assert_eq!((card.cwd.clone(), card.repo.clone(), card.branch.clone()), (a.cwd.clone(), a.repo.clone(), a.branch.clone()));
        assert_eq!((card.started_at, card.diff.clone()), (Some(100), a.diff.clone()));
        assert_eq!((card.pane_id.as_str(), card.tab_id.as_str(), card.workspace_id.as_str()), ("", "", ""));
        assert_eq!((card.column, card.state, card.archived, card.state_since), (Column::Done, HerdrState::Idle, true, 1000));
        // The card carries the worktree, so Delete worktree works once Mark done closed its workspace.
        let checkout = Some(LinkedWorktree { path: "/tmp/lab".into(), repo_root: "/tmp/main".into() });
        assert_eq!(card.parked, Some(Parked { at: 1000, session_file: "/s/a.jsonl".into(), worktree: checkout, moved: None, ended: None }));
        assert_eq!(card.live.line.as_deref(), Some("All tests pass."));
        let o = card.omp.unwrap();
        let src = a.omp.unwrap();
        assert_eq!((o.link, o.pid, o.bridge), (LinkState::NotShared, None, false));
        assert_eq!((o.session_id, o.session_file), (src.session_id, src.session_file));
        assert_eq!((o.model, o.thinking, o.cost, o.last_turn_ended_at), (src.model, src.thinking, src.cost, src.last_turn_ended_at));
        // Old state.json without the new fields still loads.
        let old: SessionData = serde_json::from_str(r#"{"archived":{"t":1},"activity":[]}"#).unwrap();
        assert!(old.parked.is_empty() && old.pruned.is_empty());
    }

    #[test]
    fn only_idle_archived_omp_agents_park() {
        let mut a = live_agent();
        assert_eq!(parkable(&a), None, "not archived");
        a.archived = true;
        a.column = Column::Done;
        assert_eq!(parkable(&a), Some("/s/a.jsonl"));
        a.state = HerdrState::Working;
        a.column = Column::Running;
        a.archived = false;
        assert_eq!(parkable(&a), None, "working");
        let mut b = live_agent();
        (b.archived, b.column) = (true, Column::Done);
        b.omp.as_mut().unwrap().session_file = None;
        assert_eq!(parkable(&b), None, "no session file");
        let mut c = live_agent();
        (c.archived, c.column) = (true, Column::Done);
        c.kind = "claude".into();
        assert_eq!(parkable(&c), None, "not omp");
    }

    fn pane(id: &str) -> WirePane {
        WirePane { id: id.into(), terminal_id: None, title: None, cwd: None, agent_id: None, focused: false, process: None }
    }

    fn ws(id: &str, panes: &[&str], worktree: Option<WorktreeInfo>) -> Workspace {
        Workspace {
            id: id.into(),
            label: id.into(),
            cwd: "/tmp".into(),
            repo: None,
            worktree,
            tabs: vec![Tab { id: format!("{id}:t1"), label: "t".into(), panes: panes.iter().map(|p| pane(p)).collect() }],
            rollup: HerdrState::Idle,
            order: 0,
        }
    }

    #[test]
    fn closes_the_workspace_only_when_it_is_exclusive() {
        let mut a = live_agent();
        a.workspace_id = "w2".into();
        a.pane_id = "w2:p1".into();
        let linked = |primary: Option<&str>| Some(WorktreeInfo { path: "/wt".into(), branch: None, primary_workspace_id: primary.map(str::to_string) });

        // Dispatch / worktree workspace with only the agent: close the workspace.
        assert_eq!(close_scope(&a, &[ws("w2", &["w2:p1"], linked(Some("w1")))]), CloseScope::Workspace("w2".into()));
        // A shell next to it: close just the pane.
        assert_eq!(close_scope(&a, &[ws("w2", &["w2:p1", "w2:p2"], None)]), CloseScope::Pane("w2:p1".into()));
        // Primary workspace of a worktree group: never close the group.
        let group = [ws("w2", &["w2:p1"], None), ws("w3", &["w3:p1"], linked(Some("w2")))];
        assert_eq!(close_scope(&a, &group), CloseScope::PaneKeepWorkspace { pane_id: "w2:p1".into(), workspace_id: "w2".into() });
        // Workspace unknown (snapshot lag): just the pane.
        assert_eq!(close_scope(&a, &[]), CloseScope::Pane("w2:p1".into()));
    }

    #[test]
    fn prune_list_is_capped_and_ages_out() {
        let day = 24 * 3600 * 1000;
        let now = 40 * day;
        let mut list: Vec<PrunedAgent> =
            (0..PRUNED_CAP as i64).map(|i| PrunedAgent { agent_id: format!("a{i}"), session_id: None, at: now - day - i }).collect();
        push_pruned(&mut list, PrunedAgent { agent_id: "new".into(), session_id: Some("s".into()), at: now }, now);
        assert_eq!(list.len(), PRUNED_CAP);
        assert_eq!(list[0].agent_id, "new", "newest first");
        assert_eq!(list.last().unwrap().agent_id, format!("a{}", PRUNED_CAP - 2), "oldest dropped");
        // Re-pruning the same id keeps one entry.
        push_pruned(&mut list, PrunedAgent { agent_id: "new".into(), session_id: None, at: now }, now);
        assert_eq!(list.iter().filter(|p| p.agent_id == "new").count(), 1);
        // 31 days later everything older than 30 days is gone.
        list.push(PrunedAgent { agent_id: "old".into(), session_id: None, at: now - 31 * day });
        assert!(trim_pruned(&mut list, now));
        assert!(list.iter().all(|p| p.agent_id != "old"));
        assert!(!trim_pruned(&mut list, now));
    }

    #[test]
    fn live_session_supersedes_the_parked_card() {
        let rec = record_from_agent(&live_agent(), 1, 2, None, None).unwrap();
        let parked: BTreeMap<String, ParkedRecord> = [(rec.agent_id.clone(), rec.clone())].into();
        let none = HashMap::new();

        // Pane still closing (same id live): neither card nor drop.
        let mut agents = vec![live_agent()];
        assert!(merge(&parked, &["term_7".to_string()].into(), &none, &mut agents).is_empty());
        assert_eq!(agents.len(), 1);

        // Pane gone: the parked card shows.
        let mut agents = vec![];
        assert!(merge(&parked, &HashSet::new(), &none, &mut agents).is_empty());
        assert_eq!(agents[0].parked.as_ref().map(|p| p.at), Some(2));

        // Someone resumed the session by hand: a new live agent with the same session.
        let mut other = live_agent();
        other.id = "term_9".into();
        let mut agents = vec![other.clone()];
        assert_eq!(merge(&parked, &["term_9".to_string()].into(), &none, &mut agents), vec![("term_7".into(), Gone::Superseded)]);
        assert_eq!(agents.len(), 1, "no parked card next to the live one");

        // Same file, different session id field missing: still the same session.
        other.omp.as_mut().unwrap().session_id = None;
        let mut agents = vec![other];
        assert_eq!(merge(&parked, &["term_9".to_string()].into(), &none, &mut agents).len(), 1);

        // agent.resume: swapped once the new agent is live, even before its session resolved.
        let mut fresh = live_agent();
        fresh.id = "term_10".into();
        fresh.omp.as_mut().unwrap().session_id = None;
        fresh.omp.as_mut().unwrap().session_file = None;
        let resumed: HashMap<String, String> = [("term_7".to_string(), "term_10".to_string())].into();
        let mut agents = vec![];
        assert!(merge(&parked, &HashSet::new(), &resumed, &mut agents).is_empty(), "still starting");
        assert_eq!(agents.len(), 1);
        let mut agents = vec![fresh];
        assert_eq!(merge(&parked, &["term_10".to_string()].into(), &resumed, &mut agents), vec![("term_7".into(), Gone::Resumed)]);
        assert_eq!(agents.len(), 1);
    }

    #[test]
    fn parked_meta_only_allows_prompting() {
        let rec = record_from_agent(&live_agent(), 1, 2, None, None).unwrap();
        let meta = parked_meta(&rec);
        assert!(meta.caps.prompt);
        assert!(!meta.caps.abort && !meta.caps.model && !meta.caps.steer && !meta.caps.export);
        assert_eq!(meta.session_file.as_deref(), Some("/s/a.jsonl"));
        assert_eq!(meta.title.as_deref(), Some("Fix the parser"));
    }

    #[cfg(unix)]
    async fn store(dir: &Path, tag: &str) -> StateHandle {
        let persist = super::super::persist::Persist::load(dir.join("state.json"));
        let cancel = CancellationToken::new();
        cancel.cancel();
        let sock = dir.join(format!("bridge-{tag}.sock"));
        let bridge = crate::bridge::BridgeHandle::bind(crate::bridge::BridgeEndpoint::Unix(sock), "s".into()).unwrap();
        let omp = crate::omp::OmpHandle::start(0, persist.clone(), cancel, bridge.clone()).await;
        StateHandle::new("lab", persist, omp, bridge)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unarchive_cancels_a_pending_close() {
        let dir = tempfile::tempdir().unwrap();
        let h = store(dir.path(), "a").await;
        let a = tf_herdr::AgentInfo {
            pane_id: "w1:p1".into(),
            terminal_id: "term_1".into(),
            workspace_id: "w1".into(),
            tab_id: "w1:t1".into(),
            agent: Some("omp".into()),
            agent_status: tf_herdr::AgentStatus::Idle,
            ..Default::default()
        };
        super::super::apply_snapshot(&h, tf_herdr::Snapshot { agents: vec![a], ..Default::default() });
        h.rebuild();
        assert!(h.set_archived("term_1", true));
        let (first, token) = h.schedule_park("term_1");
        // Undo within the window.
        assert!(h.set_archived("term_1", false));
        assert!(token.is_cancelled());
        assert!(!h.park_due("term_1", first), "a cancelled window never parks");
        // Marked done twice: only the latest window may park.
        let (g1, t1) = h.schedule_park("term_1");
        let (g2, t2) = h.schedule_park("term_1");
        assert!(t1.is_cancelled());
        assert!(!h.park_due("term_1", g1));
        assert!(h.park_due("term_1", g2));
        // Undo right after the window, while the pane is being closed: still cancels it.
        assert!(h.set_archived("term_1", false));
        assert!(t2.is_cancelled() && h.archived_at("term_1").is_none());
        h.finish_park_wait("term_1", g2);
        // A window that ran its course is gone once the close is done.
        h.set_archived("term_1", true);
        let (g3, _t3) = h.schedule_park("term_1");
        assert!(h.park_due("term_1", g3));
        h.finish_park_wait("term_1", g3);
        assert!(!h.cancel_park("term_1"), "nothing pending after the close");
    }

    fn herdr_pane(pane: &str, terminal: &str, ws: &str) -> tf_herdr::PaneInfo {
        tf_herdr::PaneInfo { pane_id: pane.into(), terminal_id: terminal.into(), workspace_id: ws.into(), ..Default::default() }
    }

    fn herdr_ws(id: &str, panes: u32, tabs: u32) -> tf_herdr::WorkspaceInfo {
        tf_herdr::WorkspaceInfo { workspace_id: id.into(), pane_count: panes, tab_count: tabs, ..Default::default() }
    }

    #[test]
    fn closes_only_what_herdr_confirms() {
        let ws_scope = || CloseScope::Workspace("w2".into());
        let mine = herdr_pane("w2:p1", "term_7", "w2");
        // herdr agrees: one tab, one pane, ours.
        assert_eq!(verify_close(ws_scope(), "term_7", Some(&mine), Some(&herdr_ws("w2", 1, 1))), Some(ws_scope()));
        // A pane (or tab) opened since the board was built: just our pane.
        assert_eq!(verify_close(ws_scope(), "term_7", Some(&mine), Some(&herdr_ws("w2", 2, 1))), Some(CloseScope::Pane("w2:p1".into())));
        assert_eq!(verify_close(ws_scope(), "term_7", Some(&mine), Some(&herdr_ws("w2", 1, 2))), Some(CloseScope::Pane("w2:p1".into())));
        // herdr could not describe the workspace: never close it whole.
        assert_eq!(verify_close(ws_scope(), "term_7", Some(&mine), None), Some(CloseScope::Pane("w2:p1".into())));
        // The pane moved to another workspace.
        let moved = herdr_pane("w2:p1", "term_7", "w5");
        assert_eq!(verify_close(ws_scope(), "term_7", Some(&moved), Some(&herdr_ws("w2", 1, 1))), Some(CloseScope::Pane("w2:p1".into())));
        // The pane id now belongs to another terminal, or is gone: close nothing.
        let reused = herdr_pane("w2:p1", "term_9", "w2");
        assert_eq!(verify_close(ws_scope(), "term_7", Some(&reused), Some(&herdr_ws("w2", 1, 1))), None);
        assert_eq!(verify_close(CloseScope::Pane("w2:p1".into()), "term_7", Some(&reused), None), None);
        assert_eq!(verify_close(ws_scope(), "term_7", None, Some(&herdr_ws("w2", 1, 1))), None);
        // Agents without a terminal id go by pane id.
        assert_eq!(verify_close(CloseScope::Pane("w2:p1".into()), "w2:p1", Some(&herdr_pane("w2:p1", "", "w2")), None), Some(CloseScope::Pane("w2:p1".into())));
        // Group primary: the keep-open tab only when ours is still the only pane.
        let keep = || CloseScope::PaneKeepWorkspace { pane_id: "w2:p1".into(), workspace_id: "w2".into() };
        assert_eq!(verify_close(keep(), "term_7", Some(&mine), Some(&herdr_ws("w2", 1, 1))), Some(keep()));
        assert_eq!(verify_close(keep(), "term_7", Some(&mine), None), Some(keep()));
        assert_eq!(verify_close(keep(), "term_7", Some(&mine), Some(&herdr_ws("w2", 3, 2))), Some(CloseScope::Pane("w2:p1".into())));
    }

    #[cfg(unix)]
    #[test]
    fn only_not_found_in_a_healthy_folder_counts_as_deleted() {
        use std::os::unix::fs::PermissionsExt;
        let td = tempfile::tempdir().unwrap();
        let sessions = td.path().join("sessions");
        let slug = sessions.join("-tmp-lab");
        std::fs::create_dir_all(&slug).unwrap();
        let file = slug.join("a.jsonl");
        std::fs::write(&file, "{}").unwrap();
        assert_eq!(check_file(&file), FileCheck::Present);
        std::fs::remove_file(&file).unwrap();
        assert_eq!(check_file(&file), FileCheck::Missing);
        // The folder deleted too, the sessions root still holds others: deleted.
        std::fs::create_dir_all(sessions.join("-tmp-other")).unwrap();
        std::fs::remove_dir(&slug).unwrap();
        assert_eq!(check_file(&file), FileCheck::Missing);
        // An empty root (an unmounted mount point) or no root at all: no verdict.
        std::fs::remove_dir(sessions.join("-tmp-other")).unwrap();
        assert!(matches!(check_file(&file), FileCheck::Unknown(_)));
        assert!(matches!(check_file(&td.path().join("gone/x/y/a.jsonl")), FileCheck::Unknown(_)));
        // A folder that cannot be read (root ignores permissions: skip there).
        std::fs::create_dir_all(&slug).unwrap();
        std::fs::set_permissions(&slug, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read_dir(&slug).is_err() {
            assert!(matches!(check_file(&file), FileCheck::Unknown(_)));
        }
        std::fs::set_permissions(&slug, std::fs::Permissions::from_mode(0o700)).unwrap();
        // Not a file.
        assert!(matches!(check_file(&slug), FileCheck::Unknown(_)));
    }

    fn plan(parked: &[&str], live: &[&str], skipped: &[(&str, &str)]) -> PrunePlan {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect();
        PrunePlan { parked: s(parked), live: s(live), skipped: skipped.iter().map(|(r, w)| (r.to_string(), w.to_string())).collect() }
    }

    fn checks(v: &[(&str, FileCheck)]) -> HashMap<String, FileCheck> {
        v.iter().map(|(f, c)| (f.to_string(), c.clone())).collect()
    }

    fn pair(id: &str, f: &str) -> (String, String) {
        (id.to_string(), f.to_string())
    }

    #[test]
    fn prune_needs_verdicts_and_two_misses_for_live_agents() {
        let parked = vec![pair("p1", "/s/a/p1"), pair("p2", "/s/a/p2")];
        let live = vec![pair("l1", "/s/b/l1"), pair("l2", "/s/b/l2")];
        use FileCheck::{Missing, Present};
        let mut mem = PruneMemory::default();

        // l2 has no file yet (omp writes it lazily): never pruned on that.
        let all = checks(&[("/s/a/p1", Present), ("/s/a/p2", Missing), ("/s/b/l1", Present), ("/s/b/l2", Missing)]);
        assert_eq!(plan_prune(&parked, &live, &all, &mut mem), plan(&["p2"], &[], &[]));
        // l1's file vanished: one miss is not enough…
        let gone = checks(&[("/s/a/p1", Present), ("/s/a/p2", Present), ("/s/b/l1", Missing), ("/s/b/l2", Missing)]);
        assert_eq!(plan_prune(&parked, &live, &gone, &mut mem), plan(&[], &[], &[]));
        // …an unreadable file in the same sessions root skips the root (nothing pruned, nothing
        // forgotten)…
        let flaky = checks(&[("/s/a/p1", FileCheck::Unknown("EIO".into())), ("/s/a/p2", Missing), ("/s/b/l1", Missing), ("/s/b/l2", Missing)]);
        assert_eq!(plan_prune(&parked, &live, &flaky, &mut mem), plan(&[], &[], &[("/s", "EIO")]));
        // …the second miss in a row closes it.
        assert_eq!(plan_prune(&parked, &live, &gone, &mut mem), plan(&[], &["l1"], &[]));

        // A file that comes back resets the count.
        let mut mem = PruneMemory::default();
        plan_prune(&[], &live, &checks(&[("/s/b/l1", Present), ("/s/b/l2", Present)]), &mut mem);
        plan_prune(&[], &live, &checks(&[("/s/b/l1", Missing), ("/s/b/l2", Present)]), &mut mem);
        plan_prune(&[], &live, &checks(&[("/s/b/l1", Present), ("/s/b/l2", Present)]), &mut mem);
        assert_eq!(plan_prune(&[], &live, &checks(&[("/s/b/l1", Missing), ("/s/b/l2", Present)]), &mut mem), plan(&[], &[], &[]));
        // A file never checked is no verdict either.
        assert_eq!(plan_prune(&parked, &[], &HashMap::new(), &mut mem), plan(&[], &[], &[("/s", "/s/a/p1: not checked")]));
    }

    #[test]
    fn a_file_without_verdict_only_blocks_its_sessions_root() {
        use FileCheck::{Missing, Present};
        let (p1, l2) = ("/home/u/.omp/agent/sessions/-repo/p1.jsonl", "/home/u/.omp/agent/sessions/-repo/l2.jsonl");
        // The field case: an archived agent whose session lived in a deleted lab folder.
        let lab = "/tmp/tf-lab-resume/sessions/2026-10-22T11-44-46-293Z_x.jsonl";
        let parked = vec![pair("p1", p1), pair("p2", "/tmp/tf-lab-resume/sessions/p2.jsonl")];
        let live = vec![pair("l1", lab), pair("l2", l2)];
        let mut mem = PruneMemory::default();
        let why = format!("{lab}: its folders are gone too (unmounted?)");
        let pass = |l2_check: FileCheck| {
            checks(&[(p1, Missing), ("/tmp/tf-lab-resume/sessions/p2.jsonl", Missing), (lab, FileCheck::Unknown(why.clone())), (l2, l2_check)])
        };
        // omp's own root is judged as usual; the lab root (p2 included) is not.
        assert_eq!(plan_prune(&parked, &live, &pass(Present), &mut mem), plan(&["p1"], &[], &[("/tmp/tf-lab-resume", &why)]));
        assert_eq!(plan_prune(&parked, &live, &pass(Missing), &mut mem), plan(&["p1"], &[], &[("/tmp/tf-lab-resume", &why)]));
        assert_eq!(plan_prune(&parked, &live, &pass(Missing), &mut mem), plan(&["p1"], &["l2"], &[("/tmp/tf-lab-resume", &why)]));
    }

    #[test]
    fn prune_problems_are_logged_once_per_change_or_hour() {
        let mut mem = PruneMemory::default();
        let t0 = Instant::now();
        let skip = |v: &[(&str, &str)]| v.iter().map(|(r, w)| (r.to_string(), w.to_string())).collect::<Vec<_>>();
        let a = skip(&[("/a", "gone")]);
        assert_eq!(mem.problems_to_log(&a, t0), a);
        assert!(mem.problems_to_log(&a, t0 + PRUNE_EVERY).is_empty());
        // Another root joins: only it is new.
        let ab = skip(&[("/a", "gone"), ("/b", "EIO")]);
        assert_eq!(mem.problems_to_log(&ab, t0 + 2 * PRUNE_EVERY), skip(&[("/b", "EIO")]));
        // A changed reason, and the hourly reminder.
        let ab2 = skip(&[("/a", "gone"), ("/b", "EACCES")]);
        assert_eq!(mem.problems_to_log(&ab2, t0 + 3 * PRUNE_EVERY), skip(&[("/b", "EACCES")]));
        assert_eq!(mem.problems_to_log(&ab2, t0 + PRUNE_REWARN), skip(&[("/a", "gone")]));
        // Recovered, then broken again: logged again.
        assert!(mem.problems_to_log(&[], t0 + PRUNE_REWARN + PRUNE_EVERY).is_empty());
        assert_eq!(mem.problems_to_log(&a, t0 + PRUNE_REWARN + 2 * PRUNE_EVERY), a);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn parked_agents_survive_a_restart_and_prune_into_host_info() {
        let dir = tempfile::tempdir().unwrap();
        let h = store(dir.path(), "a").await;
        h.park(record_from_agent(&live_agent(), 1, 2, None, None).unwrap());
        h.rebuild();
        assert!(h.agent("term_7").is_some_and(|a| a.parked.is_some()));
        drop(h);

        // A new daemon reads the record back from state.json.
        let h = store(dir.path(), "b").await;
        h.rebuild();
        let card = h.agent("term_7").expect("parked card after restart");
        assert_eq!((card.column, card.parked.map(|p| p.session_file)), (Column::Done, Some("/s/a.jsonl".to_string())));
        assert!(h.agent_by_pane("").is_none(), "parked cards have no pane");

        // Resume claims are exclusive until released.
        let claim = h.claim_resume("term_7").unwrap();
        assert!(h.claim_resume("term_7").is_none());
        drop(claim);
        assert!(h.claim_resume("term_7").is_some());

        // Session file deleted: gone from the board, listed in HostInfo.pruned.
        h.record_activity_as("term_7", "lab", tf_proto::model::ActivityKind::Finished, "done".into(), None);
        assert!(h.prune_parked("term_7"));
        h.rebuild();
        assert!(h.agent("term_7").is_none());
        let pruned = h.snapshot().info.pruned;
        assert_eq!((pruned.len(), pruned[0].agent_id.as_str(), pruned[0].session_id.as_deref()), (1, "term_7", Some("sid-1")));
        assert!(h.activity_page(None, 50, Some("term_7")).0.is_empty(), "its activity is dropped");
        // A host info re-probe (built with an empty list) keeps it.
        let mut info = h.snapshot().info;
        info.pruned.clear();
        info.hostname = "reprobed".into();
        h.set_info(info);
        assert_eq!(h.snapshot().info.pruned.len(), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_parked_card_moves_to_a_new_key_and_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let h = store(dir.path(), "a").await;
        h.park(record_from_agent(&live_agent(), 1, 2, None, None).unwrap());
        assert!(!h.rekey_parked("nope", "nope~1"));
        assert!(h.rekey_parked("term_7", "term_7~1"));
        h.rebuild();
        let card = h.agent("term_7~1").expect("the card under its new key");
        assert_eq!((card.id.as_str(), card.parked.map(|p| p.session_file)), ("term_7~1", Some("/s/a.jsonl".to_string())));
        assert!(h.agent("term_7").is_none(), "the old key is free for the agent that took it");
        assert_eq!(h.parked("term_7~1").map(|r| r.agent_id), Some("term_7~1".to_string()));
        drop(h);
        let h = store(dir.path(), "b").await;
        h.rebuild();
        assert!(h.agent("term_7~1").is_some_and(|a| a.parked.is_some()), "persisted in one step");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn finishing_a_move_after_a_crash_leaves_one_card() {
        let dir = tempfile::tempdir().unwrap();
        let h = store(dir.path(), "a").await;
        let rec = record_from_agent(&live_agent(), 1, 2, None, None).unwrap();
        h.park(rec.clone());
        // The card was already made again under the new key (`stale`), then the move is repeated.
        h.park(ParkedRecord { agent_id: "term_7~ab".into(), ..rec });
        assert!(h.rekey_parked("term_7", "term_7~ab"));
        assert!(!h.rekey_parked("term_7", "term_7~ab"), "repeating it changes nothing");
        assert_eq!(h.parked_all().len(), 1);
        assert_eq!(h.parked_all()[0].agent_id, "term_7~ab");
    }
}
