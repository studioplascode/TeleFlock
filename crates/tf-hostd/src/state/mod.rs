//! `HostState` store, one per herdr session (architecture §3.5).
//!
//! Inputs: the herdr snapshot + coalesced events, the omp replicas (via `OmpHandle`),
//! the companion bridge, git repo info (cached), host info/health. Every input change
//! marks the store dirty; a flusher rebuilds the board at most 10×/s, diffs it against
//! what clients have and broadcasts `patch`es (one rev per message). Pulses are
//! aggregated per 100 ms window. Archive, turns, activity, parked agents and usage persist in
//! `state.json`; done agents park and prune per [`parked`].

pub mod build;
pub mod parked;
pub mod persist;
pub mod procs;
pub mod subs;

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tokio::sync::{broadcast, Notify};
use tracing::{debug, info, warn};

use tf_collab::Signal;
use tf_herdr::{AgentInfo, PaneInfo, SubscribeOptions, TabInfo, WorkspaceInfo};
use tf_proto::host::ServerMsg;
use tf_proto::model::{
    ActivityEvent, ActivityKind, Agent, Column, HerdrState, HostHealth, HostInfo, HostState, LinkReason, LinkState, LinkVia,
    Notification, Pulse, PulseKind, RepoInfo, SetupStatus, StatePatch, ToolUpdates, UsageTotals,
};
use tf_proto::Millis;

use crate::bridge::{BridgeEvent, BridgeHandle};
use crate::clients::{line_of, ClientHandle};
use crate::omp::{OmpHandle, OmpUpdate};
use crate::ops::Ctx;
use crate::util::{clip, new_id, now_ms};
use persist::{Persist, ACTIVITY_CAP};

const FLUSH_MIN: Duration = Duration::from_millis(100);
const PULSE_EVERY: Duration = Duration::from_millis(100);
const RESNAP_DEBOUNCE: Duration = Duration::from_millis(120);
/// While clients are connected, repo facts older than this are refreshed. Turn ends, cwd
/// changes, a client connecting and TeleFlock's own git operations refresh at once; with no
/// client nothing polls.
const REPO_TTL: Duration = Duration::from_secs(300);
/// How often the repo loop looks for facts past [`REPO_TTL`].
const REPO_TICK: Duration = Duration::from_secs(30);
/// A connecting client refreshes repo facts older than this.
const REPO_CONNECT_FRESH: Duration = Duration::from_secs(10);
const HEALTH_EVERY: Duration = Duration::from_secs(5);
/// Host facts are re-probed when a client connects, after setup fixes and tool installs, and
/// this often while clients stay connected (out-of-band changes: herdr sessions, manual installs).
const INFO_EVERY: Duration = Duration::from_secs(600);
/// A connecting client re-probes host facts older than this.
const INFO_CONNECT_FRESH: Duration = Duration::from_secs(10);
/// How long a linked omp agent may show herdr `blocked` without a visible request
/// before it counts as "needs you (terminal only)".
const BLOCKED_GRACE_MS: Millis = 2_000;

/// Per-agent bookkeeping that is not part of the wire model.
#[derive(Debug, Clone)]
struct Track {
    name: String,
    state: HerdrState,
    state_since: Millis,
    column: Option<Column>,
    needs_key: Option<String>,
    needs_since: Millis,
    quiet_notified: bool,
    working_since: Option<Millis>,
    last_turn_ended_at: Option<Millis>,
    omp_session: Option<String>,
    model: Option<String>,
    /// Needs-you notification sent for the current episode (`Some(answerable)`).
    needs_notified: Option<bool>,
    /// Last collab `TurnStarted` (exact turn boundaries for linked omp agents).
    turn_signal_at: Option<Millis>,
    /// The last collab turn ended with `stopReason: aborted` (someone pressed stop).
    turn_aborted: bool,
    /// The link the board last showed (state, reason, path) and since when (`OmpInfo.linkSince`).
    link_key: Option<(LinkState, Option<LinkReason>, Option<LinkVia>)>,
    link_since: Millis,
}

#[derive(Default)]
struct Mirror {
    ok: bool,
    workspaces: Vec<WorkspaceInfo>,
    tabs: Vec<TabInfo>,
    panes: Vec<PaneInfo>,
    agents: Vec<AgentInfo>,
    /// Last terminal activity per pane (`pane_updated`).
    activity: HashMap<String, Millis>,
}

/// Repository facts of one folder.
struct RepoEntry {
    /// `None`: not in a repository.
    info: Option<RepoInfo>,
    /// Worktree top it was read at: folders in one worktree are refreshed together.
    top: Option<std::path::PathBuf>,
    /// Last refresh; `None`: due at the next round.
    at: Option<Instant>,
}

struct Inner {
    rev: u64,
    published: HostState,
    sinks: Vec<ClientHandle>,
    mirror: Mirror,
    tracks: HashMap<String, Track>,
    /// cwd → repository facts.
    repos: HashMap<String, RepoEntry>,
    /// pane → foreground pids (omp pid cross-check), with fetch time.
    pane_pids: HashMap<String, (Vec<u32>, Instant)>,
    /// pane → foreground process (`PaneInfo.process`).
    pane_procs: procs::PaneProcs,
    /// agent id → omp session id (current mapping).
    omp_of: HashMap<String, String>,
    pulses: HashMap<(String, PulseKind), u32>,
    health: Option<HostHealth>,
    built_once: bool,
    life: parked::Lifecycle,
}

struct Store {
    session: String,
    persist: Arc<Persist>,
    omp: OmpHandle,
    bridge: BridgeHandle,
    m: Mutex<Inner>,
    dirty: Notify,
    resnap: Notify,
    repo_kick: Notify,
    /// A client attached (host facts are re-probed).
    connected: Notify,
}

/// Cheap, cloneable handle to the store of one herdr session.
#[derive(Clone)]
pub struct StateHandle {
    inner: Arc<Store>,
}

impl StateHandle {
    pub fn new(session: &str, persist: Arc<Persist>, omp: OmpHandle, bridge: BridgeHandle) -> Self {
        let info = initial_info(session, omp.relay_port(), omp.relay_listening());
        let usage = omp.usage_today();
        Self {
            inner: Arc::new(Store {
                session: session.to_string(),
                persist,
                omp,
                bridge,
                m: Mutex::new(Inner {
                    rev: 0,
                    published: HostState { info, health: None, workspaces: vec![], agents: vec![], usage },
                    sinks: Vec::new(),
                    mirror: Mirror::default(),
                    tracks: HashMap::new(),
                    repos: HashMap::new(),
                    pane_pids: HashMap::new(),
                    pane_procs: procs::PaneProcs::default(),
                    omp_of: HashMap::new(),
                    pulses: HashMap::new(),
                    health: None,
                    built_once: false,
                    life: parked::Lifecycle::default(),
                }),
                dirty: Notify::new(),
                resnap: Notify::new(),
                repo_kick: Notify::new(),
                connected: Notify::new(),
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.m.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Current board state.
    pub fn snapshot(&self) -> HostState {
        self.lock().published.clone()
    }

    pub fn agent(&self, agent_id: &str) -> Option<Agent> {
        self.lock().published.agents.iter().find(|a| a.id == agent_id).cloned()
    }

    pub fn agent_by_pane(&self, pane_id: &str) -> Option<Agent> {
        self.lock().published.agents.iter().find(|a| a.pane_id == pane_id && a.parked.is_none()).cloned()
    }

    /// The raw herdr agent record (fresh from the mirror).
    pub fn herdr_agent(&self, agent_id: &str) -> Option<AgentInfo> {
        self.lock().mirror.agents.iter().find(|a| build::agent_id(a) == agent_id).cloned()
    }

    /// omp session id the agent is mapped to.
    pub fn omp_session_of(&self, agent_id: &str) -> Option<String> {
        self.lock().omp_of.get(agent_id).cloned()
    }

    /// Sends `snapshot` + registers the client for patches (on hello). A client connecting also
    /// refreshes repo facts and host facts (the patches follow).
    pub fn attach_client(&self, client: &ClientHandle) {
        let mut m = self.lock();
        client.send(ServerMsg::Snapshot { rev: m.rev, state: m.published.clone() });
        m.sinks.retain(|c| !c.is_closed() && c.id() != client.id());
        m.sinks.push(client.clone());
        for e in m.repos.values_mut() {
            if e.at.is_some_and(|at| at.elapsed() >= REPO_CONNECT_FRESH) {
                e.at = None;
            }
        }
        drop(m);
        self.inner.repo_kick.notify_one();
        self.inner.connected.notify_one();
    }

    pub fn detach_client(&self, client_id: &str) {
        self.lock().sinks.retain(|c| c.id() != client_id && !c.is_closed());
    }

    /// `state.get`: re-sends a snapshot at the current rev to this client and returns it.
    pub fn resend_snapshot(&self, client: &ClientHandle) -> HostState {
        let m = self.lock();
        client.send(ServerMsg::Snapshot { rev: m.rev, state: m.published.clone() });
        m.published.clone()
    }

    pub fn activity_page(&self, before: Option<Millis>, limit: usize, agent_id: Option<&str>) -> (Vec<ActivityEvent>, bool) {
        let limit = limit.clamp(1, 500);
        self.inner.persist.read(|d| {
            let Some(s) = d.sessions.get(&self.inner.session) else { return (vec![], false) };
            let mut out = Vec::new();
            let mut more = false;
            for ev in s.activity.iter().rev() {
                if before.is_some_and(|b| ev.at >= b) || agent_id.is_some_and(|a| ev.agent_id != a) {
                    continue;
                }
                if out.len() == limit {
                    more = true;
                    break;
                }
                out.push(ev.clone());
            }
            (out, more)
        })
    }

    pub fn record_activity(&self, agent_id: &str, kind: ActivityKind, title: String, detail: Option<String>) {
        let name = self
            .lock()
            .tracks
            .get(agent_id)
            .map(|t| t.name.clone())
            .unwrap_or_else(|| agent_id.to_string());
        self.push_activity(agent_id, &name, kind, title, detail);
    }

    /// Broadcasts a host notification (an automation run) to every client of this session.
    pub fn broadcast_notification(&self, n: Notification) {
        let mut m = self.lock();
        self.notify(&mut m, n);
    }

    fn push_activity(&self, agent_id: &str, agent_name: &str, kind: ActivityKind, title: String, detail: Option<String>) {
        let ev = ActivityEvent {
            id: new_id("a"),
            at: now_ms(),
            agent_id: agent_id.to_string(),
            agent_name: agent_name.to_string(),
            kind,
            title: clip(&title, 160),
            detail: detail.map(|d| clip(&d, 400)),
        };
        debug!(session = %self.inner.session, agent = agent_id, kind = ?kind, "activity");
        self.inner.persist.session(&self.inner.session, |s| {
            s.activity.push_back(ev);
            while s.activity.len() > ACTIVITY_CAP {
                s.activity.pop_front();
            }
        });
    }

    /// Re-pulls the herdr snapshot soon (after workspace/tab/pane mutations).
    pub fn refresh(&self) {
        self.inner.resnap.notify_one();
    }

    pub fn usage_today(&self) -> UsageTotals {
        self.inner.omp.usage_today()
    }

    /// Replaces the host facts; `tools` stays as [`set_tools`](Self::set_tools) left it and
    /// `pruned` as the prune loop left it.
    pub fn set_info(&self, mut info: HostInfo) {
        let mut m = self.lock();
        info.tools = m.published.info.tools.clone();
        info.pruned = m.published.info.pruned.clone();
        if m.published.info != info {
            m.published.info = info.clone();
            broadcast_patch(&mut m, vec![StatePatch::Info { info }]);
        }
    }

    /// Publishes the tool updater's status (`HostInfo.tools`).
    pub fn set_tools(&self, tools: Option<ToolUpdates>) {
        let mut m = self.lock();
        if m.published.info.tools != tools {
            m.published.info.tools = tools;
            let info = m.published.info.clone();
            broadcast_patch(&mut m, vec![StatePatch::Info { info }]);
        }
    }

    fn set_health(&self, health: HostHealth) {
        let mut m = self.lock();
        m.health = Some(health.clone());
        m.published.health = Some(health.clone());
        if !m.sinks.is_empty() {
            broadcast_patch(&mut m, vec![StatePatch::Health { health }]);
        }
    }

    pub fn has_clients(&self) -> bool {
        self.lock().sinks.iter().any(|c| !c.is_closed())
    }

    /// Archives / un-archives an agent (persisted, also keyed by its omp session).
    pub fn set_archived(&self, agent_id: &str, archived: bool) -> bool {
        let (sids, name) = {
            let m = self.lock();
            if !m.mirror.agents.iter().any(|a| build::agent_id(a) == agent_id) {
                return false;
            }
            // Both the resolved mapping and the session the last build used (herdr's
            // `agentSession` fallback): un-archiving must clear whichever key the build reads,
            // e.g. right after a daemon restart, before the omp registry resolved the pane.
            let mut sids: Vec<String> = m.omp_of.get(agent_id).cloned().into_iter().collect();
            if let Some(s) = m.tracks.get(agent_id).and_then(|t| t.omp_session.clone()).filter(|s| !sids.contains(s)) {
                sids.push(s);
            }
            (sids, m.tracks.get(agent_id).map(|t| t.name.clone()))
        };
        let now = now_ms();
        self.inner.persist.session(&self.inner.session, |s| {
            if archived {
                s.archived.insert(agent_id.to_string(), now);
                for sid in &sids {
                    s.archived_sessions.insert(sid.clone(), now);
                }
            } else {
                s.archived.remove(agent_id);
                for sid in &sids {
                    s.archived_sessions.remove(sid);
                }
            }
        });
        if !archived {
            self.cancel_park(agent_id);
        }
        let kind = if archived { ActivityKind::Archived } else { ActivityKind::Unarchived };
        let name = name.unwrap_or_else(|| agent_id.to_string());
        self.push_activity(agent_id, &name, kind, format!("{} {name}", if archived { "Archived" } else { "Un-archived" }), None);
        self.mark_dirty();
        true
    }

    /// Forces a repo refresh for a folder and the folders in the same worktree (after commits,
    /// turns).
    pub fn refresh_repo(&self, cwd: &str) {
        mark_repos_stale(&mut self.lock(), cwd);
        self.inner.repo_kick.notify_one();
    }

    pub fn persist_now(&self) {
        self.inner.persist.save_now();
    }

    pub fn mark_dirty(&self) {
        self.inner.dirty.notify_one();
    }

    fn add_pulse(&self, agent_id: &str, kind: PulseKind, n: u32) {
        let mut m = self.lock();
        *m.pulses.entry((agent_id.to_string(), kind)).or_default() += n;
    }

    /// Broadcasts a notification to every client of this session.
    fn notify(&self, m: &mut Inner, n: Notification) {
        info!(session = %self.inner.session, agent = %n.agent_id, kind = ?n.kind, "notify: {}", n.title);
        if let Some(line) = line_of(&ServerMsg::Notify { notification: n }) {
            m.sinks.retain(|c| !c.is_closed());
            for c in &m.sinks {
                c.send_line(line.clone(), false);
            }
        }
    }

    // ───────────────────────────── rebuild ─────────────────────────────

    /// Rebuilds the board from all inputs and broadcasts the diff.
    fn rebuild(&self) {
        let now = now_ms();
        let store = &self.inner;
        let persisted = store.persist.read(|d| d.sessions.get(&store.session).map(persist::SessionData::without_activity).unwrap_or_default());
        let mut guard = self.lock();
        let m = &mut *guard;

        // Map agents → omp sessions (sessionId from herdr, cross-checked with the pid).
        let mut omp_of = HashMap::new();
        for a in m.mirror.agents.iter().filter(|a| build::is_omp(a)) {
            let id = build::agent_id(a);
            let pids = m.pane_pids.get(&a.pane_id).map(|(p, _)| p.as_slice()).unwrap_or(&[]);
            if let Some(sid) = resolve_omp_session(&store.omp, &store.bridge, a, pids) {
                omp_of.insert(id, sid);
            }
        }

        let mut agent_by_pane = HashMap::new();
        let mut agents = Vec::with_capacity(m.mirror.agents.len());
        let mut unarchive = Vec::new();
        // Agents with something to report (needs-you, a finished turn, quiet).
        let mut transitions: Vec<(Agent, bool, bool)> = Vec::new();
        let mut seen = HashSet::new();
        let mut new_turns: Vec<String> = Vec::new();
        let mut stopped_turns: HashSet<String> = HashSet::new();
        let mut started: Vec<(String, String)> = Vec::new();
        let mut model_changes: Vec<(String, String, String)> = Vec::new();
        let mut recheck = false;

        for a in &m.mirror.agents {
            let id = build::agent_id(a);
            seen.insert(id.clone());
            agent_by_pane.insert(a.pane_id.clone(), id.clone());
            let state = build::herdr_state(a.agent_status);
            let sid = omp_of.get(&id).cloned().or_else(|| a.agent_session.as_ref().and_then(|s| s.session_id().map(str::to_string)));
            let view = sid.as_deref().and_then(|s| store.omp.session(s)).filter(|s| omp_of.get(&id) == Some(&s.session_id)).map(|s| s.view(now));
            // The replica's link, else (no replica yet) what the registry and the bridge say: an omp
            // that will share but has no room yet (still starting) shows as connecting, and so does
            // one whose pane processes are not read yet (`None`: tf-hostd just started).
            let link = match &view {
                Some(v) => crate::omp::LinkStatus::new(v.link, v.link_reason, v.link_via, v.link_error.clone()),
                None => {
                    let pids = if build::is_omp(a) { m.pane_pids.get(&a.pane_id).map(|(p, _)| p.as_slice()) } else { Some(&[][..]) };
                    store.omp.link_without_guest(sid.as_deref(), pids, m.published.info.setup.global_sharing)
                }
            };
            let row_pid = sid.as_deref().and_then(|s| store.omp.registry_row(s)).map(|r| r.pid);
            let bridge = sid.as_deref().and_then(|s| store.bridge.by_session(s));

            let fresh = !m.tracks.contains_key(&id);
            let name = a.name.clone().or_else(|| a.agent.clone()).unwrap_or_else(|| id.clone());
            let track = m.tracks.entry(id.clone()).or_insert_with(|| Track {
                name: name.clone(),
                state,
                state_since: now,
                column: None,
                needs_key: None,
                needs_since: now,
                quiet_notified: false,
                working_since: (state == HerdrState::Working).then_some(now),
                last_turn_ended_at: None,
                omp_session: sid.clone(),
                model: None,
                needs_notified: None,
                turn_signal_at: None,
                turn_aborted: false,
                link_key: None,
                link_since: now,
            });
            track.name = name;
            track.omp_session = sid.clone();
            let link_key = (link.state, link.reason, link.via);
            if track.link_key != Some(link_key) {
                track.link_key = Some(link_key);
                track.link_since = now;
            }
            let link_since = Some(track.link_since);
            // A structured link makes turn boundaries exact: a turn ends once the replica
            // left its turn (`agent_end`) and herdr left `working`. herdr alone also flips to
            // `working` for omp's background work (titles), so without a link only episodes
            // ≥ 1.5 s count as turns.
            let linked = view.as_ref().is_some_and(|v| v.link == tf_proto::model::LinkState::Live);
            let turn_active = view.as_ref().is_some_and(|v| v.turn_active);
            let mut turn_ended = false;
            if track.state != state {
                if state == HerdrState::Working && track.working_since.is_none() {
                    track.working_since = Some(now);
                    track.quiet_notified = false;
                }
                if track.state == HerdrState::Working && state != HerdrState::Working && state != HerdrState::Blocked {
                    turn_ended = !linked && track.working_since.is_some_and(|w| now - w >= 1_500);
                    track.working_since = None;
                }
                track.state = state;
                track.state_since = now;
            }
            if linked
                && !matches!(state, HerdrState::Working | HerdrState::Blocked)
                && !turn_active
                && track.turn_signal_at.take().is_some()
            {
                turn_ended = true;
            }
            if turn_ended {
                track.last_turn_ended_at = Some(now);
                new_turns.push(id.clone());
                if std::mem::take(&mut track.turn_aborted) {
                    stopped_turns.insert(id.clone());
                }
            }
            let archived_at = persisted
                .archived
                .get(&id)
                .copied()
                .or_else(|| sid.as_deref().and_then(|s| persisted.archived_sessions.get(s).copied()));
            let mut archived = archived_at.is_some();
            if let Some(at) = archived_at.filter(|_| state == HerdrState::Working) {
                let new_turn = linked && track.turn_signal_at.is_some_and(|t| t > at);
                let long_work = !linked && track.working_since.is_some_and(|w| now - w >= 3_000);
                if new_turn || long_work {
                    archived = false;
                    unarchive.push(id.clone());
                }
            }
            // herdr `blocked` without a request TeleFlock can see: for linked omp agents give
            // the collab dialog (or herdr's catch-up after an answer) a moment to settle.
            let has_request = view.as_ref().is_some_and(|v| v.needs.is_some())
                || bridge.as_ref().is_some_and(|b| b.state.plan_review.is_some());
            let blocked_grace = linked && state == HerdrState::Blocked && !has_request && now - track.state_since < BLOCKED_GRACE_MS;
            if blocked_grace {
                recheck = true;
            }
            if fresh && m.built_once {
                started.push((id.clone(), track.name.clone()));
            }
            let first_seen = persisted.first_seen.get(&id).copied();
            let cwd = a.foreground_cwd.clone().or_else(|| a.cwd.clone()).unwrap_or_default();
            let repo = m.repos.get(&cwd).and_then(|e| e.info.as_ref());
            let pre_needs_key = view
                .as_ref()
                .and_then(|v| v.needs.as_ref().map(build::needs_key))
                .or_else(|| bridge.as_ref().and_then(|b| b.state.plan_review.as_ref().map(|r| format!("plan:{}", r.review_id))))
                .or_else(|| (state == HerdrState::Blocked && !blocked_grace).then(|| "blocked".to_string()));
            if pre_needs_key != track.needs_key {
                track.needs_key = pre_needs_key;
                track.needs_since = now;
            }
            let inputs = build::AgentInputs {
                herdr: a,
                omp: view.as_ref(),
                link,
                link_since,
                omp_session_id: sid.clone(),
                omp_pid: row_pid,
                bridge: bridge.as_ref(),
                archived,
                turns: persisted.turns.get(&id).copied().unwrap_or(0) + new_turns.iter().filter(|t| **t == id).count() as u32,
                first_seen: first_seen.or(Some(now)),
                state_since: track.state_since,
                needs_since: track.needs_since,
                pane_activity: m.mirror.activity.get(&a.pane_id).copied(),
                repo,
                turn_started_at: track.working_since,
                last_turn_ended_at: track.last_turn_ended_at,
                blocked_grace,
            };
            let agent = build::build_agent(&inputs);
            let model = agent.omp.as_ref().and_then(|o| o.model.as_ref()).map(|m| format!("{}/{}", m.provider, m.id));
            if let (Some(prev), Some(cur)) = (&track.model, &model) {
                if prev != cur {
                    model_changes.push((id.clone(), track.name.clone(), cur.clone()));
                }
            }
            if model.is_some() {
                track.model = model;
            }
            let silent = agent.live.last_event_at.map(|t| now - t).unwrap_or(0);
            let quiet = state == HerdrState::Working && silent > build::QUIET_MS && !track.quiet_notified;
            if quiet {
                track.quiet_notified = true;
            }
            // Notify on entering Needs, and once more when a terminal-only `blocked`
            // turns into an answerable request (herdr's status can beat the collab frame).
            let mut needs_note = false;
            if agent.column == Column::Needs {
                let answerable = agent.needs.as_ref().is_some_and(|n| n.answerable);
                needs_note = match track.needs_notified {
                    None => true,
                    Some(false) => answerable,
                    Some(true) => false,
                };
                if needs_note {
                    track.needs_notified = Some(answerable);
                }
            } else {
                track.needs_notified = None;
            }
            track.column = Some(agent.column);
            if needs_note || quiet || turn_ended {
                transitions.push((agent.clone(), quiet, needs_note));
            }
            agents.push(agent);
        }
        m.tracks.retain(|k, _| seen.contains(k));
        m.omp_of = omp_of;
        parked::merge_into(self, m, &persisted, &seen, &mut agents);

        // Persist turns, first-seen, auto-unarchive.
        if !new_turns.is_empty() || !unarchive.is_empty() || seen.iter().any(|id| !persisted.first_seen.contains_key(id)) {
            // `track.omp_session` is the key this build read (`omp_of` or herdr's fallback).
            let sids: HashMap<String, Option<String>> = unarchive
                .iter()
                .map(|id| (id.clone(), m.tracks.get(id).and_then(|t| t.omp_session.clone()).or_else(|| m.omp_of.get(id).cloned())))
                .collect();
            store.persist.session(&store.session, |s| {
                for id in &new_turns {
                    *s.turns.entry(id.clone()).or_default() += 1;
                }
                for (id, sid) in &sids {
                    s.archived.remove(id);
                    if let Some(sid) = sid {
                        s.archived_sessions.remove(sid);
                    }
                }
                for id in &seen {
                    s.first_seen.entry(id.clone()).or_insert(now);
                }
                s.first_seen.retain(|k, _| seen.contains(k));
                s.turns.retain(|k, _| seen.contains(k));
            });
        }

        let workspaces = if m.mirror.ok || !m.mirror.workspaces.is_empty() {
            m.pane_procs.refresh();
            let repos = &m.repos;
            build::build_workspaces(&m.mirror.workspaces, &m.mirror.tabs, &m.mirror.panes, &agent_by_pane, |cwd| repos.get(cwd).and_then(|e| e.info.as_ref()), &m.pane_procs)
        } else {
            m.published.workspaces.clone()
        };
        let usage = store.omp.usage_today();
        let mut info = m.published.info.clone();
        info.relay_port = store.omp.relay_port();
        info.setup.relay = store.omp.relay_listening();
        // Bind failures/recoveries show up without waiting for the next full setup probe.
        info.setup.issues.retain(|i| !crate::omp::RELAY_ISSUE_IDS.contains(&i.id.as_str()));
        info.setup.issues.extend(store.omp.relay_issue());
        info.pruned = persisted.pruned.clone();

        // Diff.
        let mut ops = Vec::new();
        if info != m.published.info {
            ops.push(StatePatch::Info { info: info.clone() });
        }
        diff_entities(&m.published.workspaces, &workspaces, |w| &w.id, &mut ops, |id, value| StatePatch::Workspace { id, value });
        diff_entities(&m.published.agents, &agents, |a| &a.id, &mut ops, |id, value| StatePatch::Agent { id, value });
        if usage != m.published.usage {
            ops.push(StatePatch::Usage { usage: usage.clone() });
        }
        m.published.info = info;
        m.published.workspaces = workspaces;
        m.published.agents = agents;
        m.published.usage = usage;
        if !ops.is_empty() {
            broadcast_patch(m, ops);
        }

        // Transitions → notifications + activity (never on the first build).
        let first = !m.built_once;
        m.built_once = true;
        let mut notes = Vec::new();
        let mut acts: Vec<(String, String, ActivityKind, String, Option<String>)> = Vec::new();
        for (agent, quiet, needs_note) in transitions {
            if first {
                continue;
            }
            if needs_note {
                if let Some(n) = build::needs_notification(&agent, now) {
                    notes.push(n);
                }
                let (title, detail) = agent
                    .needs
                    .as_ref()
                    .map(|n| (n.title.clone(), Some(n.question.clone())))
                    .unwrap_or_else(|| ("Needs you".into(), None));
                acts.push((agent.id.clone(), agent.name.clone(), ActivityKind::Asked, title, detail));
            }
            if new_turns.contains(&agent.id) && matches!(agent.column, Column::Review | Column::Done) {
                // A stopped turn isn't "finished": someone pressed stop, so no notification.
                if stopped_turns.contains(&agent.id) {
                    acts.push((agent.id.clone(), agent.name.clone(), ActivityKind::Stopped, "Turn stopped".into(), agent.live.line.clone()));
                } else {
                    notes.push(build::finished_notification(&agent, now));
                    acts.push((agent.id.clone(), agent.name.clone(), ActivityKind::Finished, agent.title.clone(), agent.live.line.clone()));
                }
            }
            if quiet {
                let silent = agent.live.last_event_at.map(|t| now - t).unwrap_or(0);
                notes.push(build::quiet_notification(&agent, now, silent));
            }
        }
        for (id, name) in started {
            acts.push((id, name.clone(), ActivityKind::Started, format!("{name} started"), None));
        }
        for (id, name, model) in model_changes {
            acts.push((id, name, ActivityKind::ModelChanged, format!("Model → {model}"), None));
        }
        for id in &unarchive {
            let name = m.tracks.get(id).map(|t| t.name.clone()).unwrap_or_default();
            acts.push((id.clone(), name.clone(), ActivityKind::Unarchived, format!("{name} is working again"), None));
        }
        let finished_cwds: Vec<String> = new_turns
            .iter()
            .filter_map(|id| m.published.agents.iter().find(|a| &a.id == id).and_then(|a| a.cwd.clone()))
            .collect();
        for n in notes {
            self.notify(m, n);
        }
        if !finished_cwds.is_empty() {
            for cwd in finished_cwds {
                mark_repos_stale(m, &cwd);
            }
            store.repo_kick.notify_one();
        }
        drop(guard);
        if recheck {
            let h = self.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(BLOCKED_GRACE_MS as u64 + 100)).await;
                h.mark_dirty();
            });
        }
        record_acts(acts, self);
    }

    /// Applies omp signals (turn errors, compactions, …) to activity and notifications.
    fn on_signals(&self, session_id: &str, signals: &[Signal]) {
        let agents: Vec<(String, String)> = {
            let mut m = self.lock();
            let ids: Vec<String> =
                m.omp_of.iter().filter(|(_, s)| s.as_str() == session_id).map(|(a, _)| a.clone()).collect();
            let now = now_ms();
            ids.into_iter()
                .map(|a| {
                    let track = m.tracks.get_mut(&a);
                    let name = track.as_ref().map(|t| t.name.clone()).unwrap_or_else(|| a.clone());
                    if let Some(t) = track {
                        for sig in signals {
                            match sig {
                                Signal::TurnStarted => {
                                    t.turn_signal_at = Some(now);
                                    t.turn_aborted = false;
                                }
                                Signal::TurnEnded { aborted, .. } => t.turn_aborted = *aborted,
                                _ => {}
                            }
                        }
                    }
                    (a, name)
                })
                .collect()
        };
        for (agent_id, name) in agents {
            for sig in signals {
                match sig {
                    Signal::TurnEnded { error: Some(err), .. } => {
                        self.push_activity(&agent_id, &name, ActivityKind::Error, "Turn failed".into(), Some(err.clone()));
                        let mut m = self.lock();
                        self.notify(&mut m, build::error_notification(&agent_id, &name, err, now_ms()));
                    }
                    Signal::Notice { level, text } if *level == tf_proto::session::NoticeLevel::Error => {
                        self.push_activity(&agent_id, &name, ActivityKind::Error, clip(text, 120), None);
                        let mut m = self.lock();
                        self.notify(&mut m, build::error_notification(&agent_id, &name, text, now_ms()));
                    }
                    Signal::ToolError { tool, error } => {
                        self.push_activity(&agent_id, &name, ActivityKind::ToolError, format!("{tool} failed"), Some(error.clone()));
                    }
                    Signal::Compacted { tokens_before } => {
                        let detail = tokens_before.map(|t| format!("{t} tokens before"));
                        self.push_activity(&agent_id, &name, ActivityKind::Compacted, "Context compacted".into(), detail);
                    }
                    Signal::Prompted { text, author } => {
                        let detail = author.as_ref().map(|a| format!("from {a}"));
                        self.push_activity(&agent_id, &name, ActivityKind::Prompted, clip(text, 120), detail);
                    }
                    _ => {}
                }
            }
        }
    }
}

/// Records collected activity outside the store lock.
fn record_acts(acts: Vec<(String, String, ActivityKind, String, Option<String>)>, h: &StateHandle) {
    for (id, name, kind, title, detail) in acts {
        h.push_activity(&id, &name, kind, title, detail);
    }
}

fn broadcast_patch(m: &mut Inner, ops: Vec<StatePatch>) {
    m.rev += 1;
    let Some(line) = line_of(&ServerMsg::Patch { rev: m.rev, ops }) else { return };
    m.sinks.retain(|c| !c.is_closed());
    for c in &m.sinks {
        c.send_line(line.clone(), false);
    }
}

/// Emits replace/delete patches for entities keyed by id.
fn diff_entities<T: PartialEq + Clone>(
    old: &[T],
    new: &[T],
    key: impl Fn(&T) -> &String,
    ops: &mut Vec<StatePatch>,
    make: impl Fn(String, Option<T>) -> StatePatch,
) {
    let old_by: HashMap<&String, &T> = old.iter().map(|e| (key(e), e)).collect();
    let new_ids: HashSet<&String> = new.iter().map(&key).collect();
    for e in new {
        if old_by.get(key(e)).is_none_or(|o| *o != e) {
            ops.push(make(key(e).clone(), Some(e.clone())));
        }
    }
    for e in old {
        if !new_ids.contains(key(e)) {
            ops.push(make(key(e).clone(), None));
        }
    }
}

/// omp session of a herdr agent: herdr's `agent_session` id, cross-checked against the
/// pane's foreground pids (after `/new` herdr may lag behind the live session): a replica of
/// that pid, its collab room, or its bridge.
fn resolve_omp_session(omp: &OmpHandle, bridge: &BridgeHandle, a: &AgentInfo, pids: &[u32]) -> Option<String> {
    let reported = a.agent_session.as_ref().and_then(|s| s.session_id().map(str::to_string));
    let by_pid = pids.iter().find_map(|p| {
        omp.session_by_pid(*p)
            .map(|s| s.session_id.clone())
            .or_else(|| omp.registry_row_by_pid(*p).and_then(|r| r.session_id))
            .or_else(|| bridge.by_pid(*p).map(|b| b.session_id))
    });
    match (reported, by_pid) {
        (Some(r), Some(p)) if r != p => {
            // The pid is authoritative for which process owns the pane.
            let pid_owner = omp.session(&r).map(|s| s.pid());
            if pid_owner.is_some_and(|op| pids.contains(&op)) { Some(r) } else { Some(p) }
        }
        (Some(r), _) => Some(r),
        (None, p) => p,
    }
}

fn initial_info(session: &str, relay_port: u16, relay: bool) -> HostInfo {
    HostInfo {
        hostname: hostname(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        home: crate::paths::home_dir().display().to_string(),
        hostd_version: crate::HOSTD_VERSION.to_string(),
        herdr: None,
        omp: None,
        herdr_session: session.to_string(),
        herdr_sessions: vec![session.to_string()],
        relay_port,
        setup: SetupStatus {
            herdr_integration: false,
            global_sharing: false,
            global_bridge: false,
            relay,
            issues: vec![],
            applying: vec![],
            failed: vec![],
        },
        tools: None,
        pruned: Vec::new(),
    }
}

fn hostname() -> String {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        // SAFETY: buf is valid for its length; gethostname NUL-terminates on success.
        if unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0 {
            let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
            return String::from_utf8_lossy(&buf[..end]).into_owned();
        }
    }
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "host".into())
}

// ───────────────────────────── tasks ─────────────────────────────

/// Starts the store's background tasks and waits (bounded) for the first herdr snapshot
/// and host info so the first client snapshot is populated.
pub async fn start(ctx: &Arc<Ctx>) {
    let h = ctx.state.clone();
    match tokio::time::timeout(Duration::from_secs(3), crate::ops::host::probe_info(ctx)).await {
        Ok(mut info) => {
            let mut m = h.lock();
            info.tools = m.published.info.tools.take();
            m.published.info = info;
        }
        Err(_) => warn!(session = %ctx.herdr_session, "host info probe timed out"),
    }
    if let Ok(Ok(snap)) = tokio::time::timeout(Duration::from_secs(3), ctx.herdr.snapshot()).await {
        apply_snapshot(&h, snap);
        fetch_repos(&h).await;
        h.rebuild();
    }
    tokio::spawn(herdr_loop(ctx.arc()));
    tokio::spawn(flusher(ctx.arc()));
    tokio::spawn(pulse_ticker(ctx.arc()));
    tokio::spawn(omp_consumer(ctx.arc(), ctx.omp.subscribe()));
    tokio::spawn(bridge_consumer(ctx.arc(), ctx.bridge.subscribe()));
    tokio::spawn(repo_loop(ctx.arc()));
    tokio::spawn(host_loop(ctx.arc()));
    tokio::spawn(parked::prune_loop(ctx.arc()));
}

fn apply_snapshot(h: &StateHandle, snap: tf_herdr::Snapshot) {
    let mut m = h.lock();
    m.mirror.ok = true;
    m.mirror.workspaces = snap.workspaces;
    m.mirror.tabs = snap.tabs;
    let live: HashSet<String> = snap.panes.iter().map(|p| p.pane_id.clone()).collect();
    m.mirror.panes = snap.panes;
    // Status changes first seen by a snapshot (the per-pane stream pulses its own).
    for a in &snap.agents {
        let id = build::agent_id(a);
        if m.mirror.agents.iter().any(|o| build::agent_id(o) == id && o.agent_status != a.agent_status) {
            *m.pulses.entry((id, PulseKind::State)).or_default() += 1;
        }
    }
    m.mirror.agents = snap.agents;
    m.mirror.activity.retain(|k, _| live.contains(k));
    m.pane_pids.retain(|k, _| live.contains(k));
    m.pane_procs.retain(&live);
}

fn agent_panes(h: &StateHandle) -> Vec<String> {
    h.lock().mirror.agents.iter().map(|a| a.pane_id.clone()).collect()
}

async fn herdr_loop(ctx: Arc<Ctx>) {
    let h = ctx.state.clone();
    let mut stream = ctx.herdr.subscribe(SubscribeOptions::default());
    let mut resnap_at: Option<tokio::time::Instant> = None;
    let mut status_panes: Vec<String> = Vec::new();
    // Safety net: herdr's per-pane and global streams can interleave out of order, and an
    // idle pane is quiet afterwards; a periodic snapshot heals any drift.
    let mut heal = tokio::time::interval(Duration::from_secs(15));
    heal.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let sleep = async {
            match resnap_at {
                Some(t) => tokio::time::sleep_until(t).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            _ = ctx.cancel.cancelled() => return,
            _ = h.inner.resnap.notified() => {
                resnap_at.get_or_insert_with(|| tokio::time::Instant::now() + RESNAP_DEBOUNCE);
            }
            _ = heal.tick() => {
                resnap_at.get_or_insert_with(tokio::time::Instant::now);
            }
            _ = sleep => {
                resnap_at = None;
                snapshot_now(&ctx, &mut status_panes, &stream).await;
            }
            ev = stream.recv() => {
                let Some(ev) = ev else { return };
                if handle_herdr_event(&h, ev) {
                    resnap_at.get_or_insert_with(|| tokio::time::Instant::now() + RESNAP_DEBOUNCE);
                }
            }
        }
    }
}

async fn snapshot_now(ctx: &Arc<Ctx>, status_panes: &mut Vec<String>, stream: &tf_herdr::EventStream) {
    let h = &ctx.state;
    match ctx.herdr.snapshot().await {
        Ok(snap) => {
            apply_snapshot(h, snap);
            let panes = agent_panes(h);
            if panes != *status_panes {
                stream.set_status_panes(panes.clone());
                *status_panes = panes;
            }
            fetch_pids(ctx).await;
            // Folders new to the board (cwd changes) get their repo facts now; known ones keep
            // the repo loop's pace.
            if repos_missing(&h.lock()) {
                h.inner.repo_kick.notify_one();
            }
            h.mark_dirty();
        }
        Err(e) => {
            warn!(session = %ctx.herdr_session, "herdr snapshot: {e}");
            h.lock().mirror.ok = false;
        }
    }
}

/// Applies one herdr event in place. Returns true when a re-snapshot is needed.
fn handle_herdr_event(h: &StateHandle, ev: tf_herdr::HerdrEvent) -> bool {
    use tf_herdr::HerdrEvent as E;
    let now = now_ms();
    match ev {
        E::Resync => return true,
        E::Disconnected { error } => {
            warn!(session = %h.inner.session, "herdr events disconnected: {error}");
            h.lock().mirror.ok = false;
            h.mark_dirty();
        }
        E::SubscriptionError { .. } => return true,
        E::PaneUpdated(p) => {
            let mut resnap = false;
            let mut pulse_agent = None;
            let mut cwd_moved = false;
            let new_folder;
            {
                let mut m = h.lock();
                m.mirror.activity.insert(p.pane_id.clone(), now);
                // herdr's subscription hands out at most one event per poll (~10/s), so busy
                // panes (omp's title spinner) make `pane_updated` lag tens of seconds behind.
                // An update older than what a snapshot already showed is only activity.
                let known_rev = m
                    .mirror
                    .panes
                    .iter()
                    .find(|x| x.pane_id == p.pane_id)
                    .map(|x| (x.terminal_id.as_str(), x.revision))
                    .or_else(|| m.mirror.agents.iter().find(|a| a.pane_id == p.pane_id).map(|a| (a.terminal_id.as_str(), a.revision)));
                let stale = known_rev.is_some_and(|(t, rev)| t == p.terminal_id && p.revision < rev);
                if !stale {
                    if let Some(slot) = m.mirror.panes.iter_mut().find(|x| x.pane_id == p.pane_id) {
                        cwd_moved |= slot.cwd != p.cwd || slot.foreground_cwd != p.foreground_cwd;
                        *slot = p.clone();
                    } else {
                        resnap = true;
                    }
                }
                match m.mirror.agents.iter_mut().find(|a| a.pane_id == p.pane_id) {
                    Some(a) if stale => {
                        let id = build::agent_id(a);
                        let linked = m.omp_of.contains_key(&id);
                        pulse_agent = Some((id, linked, false));
                    }
                    Some(a) => {
                        if p.agent.is_none() || p.agent != a.agent {
                            resnap = true;
                        }
                        // Even a fresh-looking `pane_updated` may predate a per-pane status
                        // event (titles don't bump the revision on status changes), so its
                        // status never overrides: a difference only asks for a snapshot.
                        let status_differs = a.agent_status != p.agent_status;
                        a.revision = p.revision;
                        a.agent_session = p.agent_session.clone();
                        cwd_moved |= a.cwd != p.cwd || a.foreground_cwd != p.foreground_cwd;
                        a.cwd = p.cwd.clone();
                        a.foreground_cwd = p.foreground_cwd.clone();
                        a.terminal_title = p.terminal_title.clone();
                        a.terminal_title_stripped = p.terminal_title_stripped.clone();
                        a.title = p.title.clone();
                        a.display_agent = p.display_agent.clone();
                        a.tokens = p.tokens.clone();
                        let id = build::agent_id(a);
                        let linked = m.omp_of.contains_key(&id);
                        pulse_agent = Some((id, linked, status_differs));
                    }
                    None => {
                        if p.agent.is_some() && !stale {
                            resnap = true;
                        }
                    }
                }
                new_folder = cwd_moved && repos_missing(&m);
            }
            if new_folder {
                h.inner.repo_kick.notify_one();
            }
            let status_differs = pulse_agent.as_ref().is_some_and(|(_, _, s)| *s);
            if let Some((id, linked, _)) = pulse_agent {
                if !linked {
                    h.add_pulse(&id, PulseKind::Event, 1);
                }
            }
            h.mark_dirty();
            // Status comes from per-pane `pane.agent_status_changed` events (prompt and
            // exact) and snapshots; a differing `pane_updated` status is confirmed by one.
            return resnap || status_differs;
        }
        E::AgentStatusChanged { pane_id, agent_status, .. } => {
            let id = {
                let mut m = h.lock();
                match m.mirror.agents.iter_mut().find(|a| a.pane_id == pane_id) {
                    Some(a) => {
                        a.agent_status = agent_status;
                        Some(build::agent_id(a))
                    }
                    None => None,
                }
            };
            match id {
                Some(id) => {
                    h.add_pulse(&id, PulseKind::State, 1);
                    h.mark_dirty();
                    return true;
                }
                None => return true,
            }
        }
        E::PaneFocused { .. } | E::WorkspaceFocused { .. } | E::TabFocused { .. } => return true,
        E::Other { .. } => {}
        _ => return true,
    }
    false
}

/// Fetches `pane.process_info`: foreground pids for omp panes that lack them (pid cross-check),
/// and the shell / foreground process of panes new to `pane_procs` (see `procs`).
async fn fetch_pids(ctx: &Arc<Ctx>) {
    let want: Vec<(String, bool)> = {
        let m = ctx.state.lock();
        let mut want: Vec<(String, bool)> = m
            .mirror
            .agents
            .iter()
            .filter(|a| build::is_omp(a))
            .filter(|a| m.pane_pids.get(&a.pane_id).is_none_or(|(_, at)| at.elapsed() > Duration::from_secs(30)))
            .map(|a| (a.pane_id.clone(), true))
            .collect();
        for pane in m.pane_procs.wanted(&m.mirror.panes) {
            if !want.iter().any(|(p, _)| *p == pane) {
                want.push((pane, false));
            }
        }
        want
    };
    for (pane, omp) in want {
        let info = ctx.herdr.pane_process_info(&pane).await.ok();
        let mut m = ctx.state.lock();
        if let Some(terminal) = m.mirror.panes.iter().find(|p| p.pane_id == pane).map(|p| p.terminal_id.clone()) {
            m.pane_procs.record(&pane, &terminal, info.as_ref());
        }
        if let (Some(info), true) = (&info, omp) {
            let pids: Vec<u32> = info.foreground_processes.iter().map(|p| p.pid).chain(info.shell_pid).collect();
            m.pane_pids.insert(pane, (pids, Instant::now()));
        }
    }
}

async fn flusher(ctx: Arc<Ctx>) {
    let h = ctx.state.clone();
    let mut tick = tokio::time::interval(Duration::from_secs(5));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let rebuild = tokio::select! {
            _ = ctx.cancel.cancelled() => return,
            // A short settle lets near-simultaneous inputs (herdr status + collab frame) land together.
            _ = h.inner.dirty.notified() => {
                tokio::time::sleep(Duration::from_millis(25)).await;
                true
            }
            // Time-based state (quiet detection, liveness ages) only moves while an agent works;
            // the herdr heal rebuilds every 15 s anyway.
            _ = tick.tick() => h.lock().tracks.values().any(|t| t.state == HerdrState::Working),
        };
        if rebuild {
            h.rebuild();
            tokio::time::sleep(FLUSH_MIN).await;
        }
    }
}

async fn pulse_ticker(ctx: Arc<Ctx>) {
    let h = ctx.state.clone();
    let mut tick = tokio::time::interval(PULSE_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = ctx.cancel.cancelled() => return,
            _ = tick.tick() => {}
        }
        let mut m = h.lock();
        if m.pulses.is_empty() {
            continue;
        }
        let pulses: Vec<Pulse> = std::mem::take(&mut m.pulses)
            .into_iter()
            .map(|((agent_id, kind), n)| Pulse { agent_id, kind, n })
            .collect();
        if let Some(line) = line_of(&ServerMsg::Pulse { at: now_ms(), pulses }) {
            m.sinks.retain(|c| !c.is_closed());
            for c in &m.sinks {
                c.send_line(line.clone(), true);
            }
        }
    }
}

async fn omp_consumer(ctx: Arc<Ctx>, mut rx: broadcast::Receiver<OmpUpdate>) {
    let h = ctx.state.clone();
    loop {
        let upd = tokio::select! {
            _ = ctx.cancel.cancelled() => return,
            r = rx.recv() => r,
        };
        match upd {
            Ok(OmpUpdate::Changed { .. }) | Ok(OmpUpdate::Registry) => h.mark_dirty(),
            Ok(OmpUpdate::Pulses { session_id, pulses }) => {
                let agents: Vec<String> =
                    h.lock().omp_of.iter().filter(|(_, s)| **s == session_id).map(|(a, _)| a.clone()).collect();
                for a in agents {
                    for (kind, n) in &pulses {
                        h.add_pulse(&a, *kind, *n);
                    }
                }
            }
            Ok(OmpUpdate::Signals { session_id, signals }) => {
                h.on_signals(&session_id, &signals);
                h.mark_dirty();
            }
            Err(broadcast::error::RecvError::Lagged(n)) => {
                debug!("omp updates lagged by {n}");
                h.mark_dirty();
            }
            Err(broadcast::error::RecvError::Closed) => return,
        }
    }
}

async fn bridge_consumer(ctx: Arc<Ctx>, mut rx: broadcast::Receiver<BridgeEvent>) {
    let h = ctx.state.clone();
    // btw: deltas stream first, then `done` carries the full reply; clients append, so
    // only the not-yet-sent suffix goes out. Keyed per conversation turn.
    let mut btw_sent: HashMap<(String, u32), String> = HashMap::new();
    loop {
        let ev = tokio::select! {
            _ = ctx.cancel.cancelled() => return,
            r = rx.recv() => r,
        };
        let ev = match ev {
            Ok(ev) => ev,
            Err(broadcast::error::RecvError::Lagged(_)) => {
                h.mark_dirty();
                continue;
            }
            Err(broadcast::error::RecvError::Closed) => return,
        };
        let mapped = |sid: &str| h.lock().omp_of.values().any(|s| s == sid);
        match &ev {
            BridgeEvent::PlanReviewRequested { session_id, review } if mapped(session_id) => {
                if let Some(s) = ctx.omp.session(session_id) {
                    s.send_extra(tf_proto::session::SessionEvent::Ui { request: Some(build::plan_review_ui(review)) });
                }
            }
            BridgeEvent::PlanReviewResolved { session_id, .. } if mapped(session_id) => {
                if let Some(s) = ctx.omp.session(session_id) {
                    let ui = s.ui();
                    s.send_extra(tf_proto::session::SessionEvent::Ui { request: ui });
                }
            }
            BridgeEvent::BtwDelta { session_id, btw_id, turn, question, text, done, error } if mapped(session_id) => {
                let key = (btw_id.clone(), *turn);
                let sent = btw_sent.entry(key.clone()).or_default();
                let mut delta = if *done {
                    text.strip_prefix(sent.as_str()).map(str::to_string).unwrap_or_default()
                } else {
                    text.clone()
                };
                if !*done {
                    sent.push_str(text);
                } else {
                    btw_sent.remove(&key);
                }
                if let (Some(e), true) = (error, *done) {
                    delta.push_str(&format!("\n\n⚠ {e}"));
                }
                if let Some(s) = ctx.omp.session(session_id) {
                    s.send_extra(tf_proto::session::SessionEvent::Btw {
                        btw_id: btw_id.clone(),
                        turn: *turn,
                        question: question.clone(),
                        text: delta,
                        done: *done,
                    });
                }
            }
            BridgeEvent::State { session_id, .. } | BridgeEvent::QueueUpdate { session_id, .. } if mapped(session_id) => {
                crate::ops::agent::push_meta_overlay(&ctx, session_id);
            }
            BridgeEvent::Connected { .. } | BridgeEvent::Disconnected { .. } | BridgeEvent::SessionSwitch { .. } => {
                for sid in h.lock().omp_of.values().cloned().collect::<Vec<_>>() {
                    crate::ops::agent::push_meta_overlay(&ctx, &sid);
                }
                ctx.omp.repoll();
            }
            _ => {}
        }
        h.mark_dirty();
    }
}

/// Folders the board shows repo facts for: agent cwds and workspace folders.
fn wanted_cwds(m: &Inner) -> HashSet<String> {
    let mut cwds: HashSet<String> = HashSet::new();
    for a in &m.mirror.agents {
        if let Some(c) = a.foreground_cwd.clone().or_else(|| a.cwd.clone()) {
            cwds.insert(c);
        }
    }
    for w in &m.mirror.workspaces {
        let tabs: Vec<&TabInfo> = m.mirror.tabs.iter().filter(|t| t.workspace_id == w.workspace_id).collect();
        cwds.insert(build::workspace_cwd(w, &tabs, &m.mirror.panes));
    }
    cwds.remove("");
    cwds
}

/// A folder on the board has no repo facts yet.
fn repos_missing(m: &Inner) -> bool {
    wanted_cwds(m).iter().any(|c| !m.repos.contains_key(c))
}

/// Marks the repo facts of `cwd`, and of the folders in its worktree, due.
fn mark_repos_stale(m: &mut Inner, cwd: &str) {
    let top = m.repos.get(cwd).and_then(|e| e.top.clone());
    for (c, e) in m.repos.iter_mut() {
        if c == cwd || (top.is_some() && e.top == top) {
            e.at = None;
        }
    }
}

/// Refreshes the repo facts that are due: folders without facts, facts marked due (turn end,
/// connect, git operations) and, while clients are connected, facts older than [`REPO_TTL`].
/// One `git rev-parse` per folder, one `git status` per worktree.
async fn fetch_repos(h: &StateHandle) {
    let want: Vec<String> = {
        let m = h.lock();
        let periodic = m.sinks.iter().any(|c| !c.is_closed());
        let due = |e: &RepoEntry| e.at.is_none_or(|at| periodic && at.elapsed() >= REPO_TTL);
        wanted_cwds(&m).into_iter().filter(|c| m.repos.get(c).is_none_or(due)).collect()
    };
    if want.is_empty() {
        return;
    }
    let mut worktrees: Vec<(crate::ops::git::RepoTop, Vec<String>)> = Vec::new();
    let mut plain: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    for cwd in want {
        match crate::ops::git::repo_top(Path::new(&cwd)).await {
            Ok(Some(t)) => match worktrees.iter_mut().find(|(w, _)| w.top == t.top) {
                Some((_, cwds)) => cwds.push(cwd),
                None => worktrees.push((t, vec![cwd])),
            },
            Ok(None) => plain.push(cwd),
            Err(e) => {
                debug!(session = %h.inner.session, cwd, "repo facts: {e}");
                failed.push(cwd);
            }
        }
    }
    let mut facts = Vec::with_capacity(worktrees.len());
    for (t, _) in &worktrees {
        facts.push(crate::ops::git::repo_info_at(t).await);
    }
    let mut m = h.lock();
    let now = Instant::now();
    let mut changed = false;
    for cwd in plain {
        changed |= m.repos.get(&cwd).is_none_or(|e| e.info.is_some());
        m.repos.insert(cwd, RepoEntry { info: None, top: None, at: Some(now) });
    }
    // git could not tell (timeout, spawn failure): keep what is known, retry next round.
    for cwd in failed {
        m.repos.entry(cwd).or_insert(RepoEntry { info: None, top: None, at: Some(now) });
    }
    for ((t, cwds), info) in worktrees.into_iter().zip(facts) {
        // Other folders of this worktree take the fresh facts too.
        for e in m.repos.values_mut().filter(|e| e.top.as_ref() == Some(&t.top)) {
            changed |= e.info.as_ref() != Some(&info);
            e.info = Some(info.clone());
            e.at = Some(now);
        }
        for cwd in cwds {
            changed |= m.repos.get(&cwd).is_none_or(|e| e.info.as_ref() != Some(&info));
            m.repos.insert(cwd, RepoEntry { info: Some(info.clone()), top: Some(t.top.clone()), at: Some(now) });
        }
    }
    let wanted = wanted_cwds(&m);
    m.repos.retain(|c, _| wanted.contains(c));
    drop(m);
    if changed {
        h.mark_dirty();
    }
}

async fn repo_loop(ctx: Arc<Ctx>) {
    let h = ctx.state.clone();
    let mut tick = tokio::time::interval(REPO_TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = ctx.cancel.cancelled() => return,
            _ = h.inner.repo_kick.notified() => {}
            _ = tick.tick() => {}
        }
        fetch_repos(&h).await;
    }
}

async fn host_loop(ctx: Arc<Ctx>) {
    let h = ctx.state.clone();
    // `start` probed just before this loop started.
    let mut last_info = Instant::now();
    loop {
        let connected = tokio::select! {
            _ = ctx.cancel.cancelled() => return,
            _ = h.inner.connected.notified() => true,
            _ = tokio::time::sleep(HEALTH_EVERY) => false,
        };
        if !h.has_clients() {
            continue;
        }
        if !connected {
            let health = tokio::task::spawn_blocking(crate::ops::host::health).await;
            if let Ok(health) = health {
                h.set_health(health);
            }
        }
        // A connect re-probes (the app may have just uploaded a new extension), unless the
        // context was created for it a moment ago.
        let every = if connected { INFO_CONNECT_FRESH } else { INFO_EVERY };
        if last_info.elapsed() >= every {
            last_info = Instant::now();
            let info = crate::ops::host::probe_info(&ctx).await;
            h.set_info(info);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Replays the lab capture (herdr 0.9.0, fake omp = hook `blocked` + a title spinner):
    /// the per-pane `pane.agent_status_changed` arrives at once while global
    /// `pane_updated` events trickle in seconds late, still carrying the status from when
    /// they were emitted. Every flush happens between event and re-snapshot (worst case).
    #[cfg(unix)]
    #[tokio::test]
    async fn stale_pane_updates_keep_a_blocked_agent_in_needs() {
        use tf_herdr::{AgentStatus as S, HerdrEvent as E, Snapshot};

        fn pane(status: S, rev: u64) -> PaneInfo {
            PaneInfo {
                pane_id: "w4:p1".into(),
                terminal_id: "term_lab".into(),
                workspace_id: "w4".into(),
                tab_id: "w4:t1".into(),
                agent: Some("omp".into()),
                agent_status: status,
                revision: rev,
                terminal_title_stripped: Some(format!("π ⠋ lab PERM: fake task {rev}")),
                ..Default::default()
            }
        }
        fn snap(status: S, rev: u64) -> Snapshot {
            let p = pane(status, rev);
            let a = AgentInfo {
                pane_id: p.pane_id.clone(),
                terminal_id: p.terminal_id.clone(),
                workspace_id: p.workspace_id.clone(),
                tab_id: p.tab_id.clone(),
                agent: p.agent.clone(),
                agent_status: status,
                revision: rev,
                ..Default::default()
            };
            Snapshot { panes: vec![p], agents: vec![a], ..Default::default() }
        }
        fn status_event(status: S) -> E {
            E::AgentStatusChanged { pane_id: "w4:p1".into(), workspace_id: "w4".into(), agent: Some("omp".into()), agent_status: status }
        }
        fn column(h: &StateHandle) -> Column {
            h.agent("term_lab").expect("agent on the board").column
        }
        /// hostd's loop: apply the event, flush, then re-snapshot herdr's truth if asked
        /// (`None`: the debounced snapshot lands after the next event).
        fn step(h: &StateHandle, ev: E, truth: Option<(S, u64)>) -> (bool, [Column; 2]) {
            let resnap = handle_herdr_event(h, ev);
            h.rebuild();
            let flushed = column(h);
            if let Some((status, rev)) = truth.filter(|_| resnap) {
                apply_snapshot(h, snap(status, rev));
            }
            h.rebuild();
            (resnap, [flushed, column(h)])
        }

        let dir = tempfile::tempdir().unwrap();
        let persist = Persist::load(dir.path().join("state.json"));
        let cancel = tokio_util::sync::CancellationToken::new();
        cancel.cancel();
        let bridge = BridgeHandle::bind(crate::bridge::BridgeEndpoint::Unix(dir.path().join("bridge.sock")), "s".into()).unwrap();
        let omp = OmpHandle::start(0, persist.clone(), cancel, bridge.clone()).await;
        let h = StateHandle::new("lab", persist, omp, bridge);

        // Working with a spinner; the first updates are still current.
        apply_snapshot(&h, snap(S::Working, 3));
        h.rebuild();
        for rev in 4..=5 {
            assert_eq!(step(&h, E::PaneUpdated(pane(S::Working, rev)), Some((S::Working, rev))).1, [Column::Running; 2]);
        }

        // `ask` starts at rev 16: the per-pane event is prompt …
        let (resnap, cols) = step(&h, status_event(S::Blocked), None);
        assert!(resnap);
        assert_eq!(cols, [Column::Needs; 2]);
        // … while `working` updates emitted before it (rev 6..=15) and later `blocked` ones
        // keep trickling in; the spinner moves on 2.5 frames per delivered event. The first
        // lands before the re-snapshot and looks newer than anything seen so far.
        let (resnap, cols) = step(&h, E::PaneUpdated(pane(S::Working, 6)), Some((S::Blocked, 16)));
        assert!(resnap, "a differing status asks for a snapshot");
        assert_eq!(cols, [Column::Needs; 2]);
        let mut truth_rev = 16;
        for rev in 7..=40 {
            truth_rev += 2;
            let emitted = if rev < 16 { S::Working } else { S::Blocked };
            assert_eq!(step(&h, E::PaneUpdated(pane(emitted, rev)), Some((S::Blocked, truth_rev))).1, [Column::Needs; 2], "rev {rev}");
        }

        // Answered at rev 120: Needs clears on the per-pane event; stale `blocked` updates,
        // even one newer than the last snapshot, don't bring it back.
        assert_eq!(step(&h, status_event(S::Working), None).1, [Column::Running; 2]);
        assert_eq!(step(&h, E::PaneUpdated(pane(S::Blocked, 41)), Some((S::Working, 120))).1, [Column::Running; 2]);
        truth_rev = 120;
        for rev in 42..=119 {
            truth_rev += 2;
            assert_eq!(step(&h, E::PaneUpdated(pane(S::Blocked, rev)), Some((S::Working, truth_rev))).1, [Column::Running; 2], "rev {rev}");
        }

        let asked = h.activity_page(None, 500, Some("term_lab")).0.iter().filter(|e| e.kind == ActivityKind::Asked).count();
        assert_eq!(asked, 1, "one Needs notification for the whole question");
    }

    #[test]
    fn diff_emits_replace_and_delete() {
        #[derive(Clone, PartialEq, Debug)]
        struct E {
            id: String,
            v: u32,
        }
        let old = vec![E { id: "a".into(), v: 1 }, E { id: "b".into(), v: 1 }];
        let new = vec![E { id: "a".into(), v: 2 }, E { id: "c".into(), v: 1 }];
        let mut ops = Vec::new();
        diff_entities(&old, &new, |e| &e.id, &mut ops, |id, value| StatePatch::Agent {
            id,
            value: value.map(|_| panic_free_agent()),
        });
        let ids: Vec<(String, bool)> = ops
            .iter()
            .map(|o| match o {
                StatePatch::Agent { id, value } => (id.clone(), value.is_some()),
                _ => unreachable!(),
            })
            .collect();
        assert_eq!(ids, vec![("a".into(), true), ("c".into(), true), ("b".into(), false)]);
    }

    fn panic_free_agent() -> Agent {
        let a = AgentInfo { pane_id: "w1:p1".into(), terminal_id: "t".into(), ..Default::default() };
        build::build_agent(&build::AgentInputs {
            herdr: &a,
            omp: None,
            link: crate::omp::LinkStatus::new(LinkState::NotShared, None, None, None),
            link_since: None,
            omp_session_id: None,
            omp_pid: None,
            bridge: None,
            archived: false,
            turns: 0,
            first_seen: None,
            state_since: 0,
            needs_since: 0,
            pane_activity: None,
            repo: None,
            turn_started_at: None,
            last_turn_ended_at: None,
            blocked_grace: false,
        })
    }
}
