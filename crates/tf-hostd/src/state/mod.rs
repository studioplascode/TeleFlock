//! `HostState` store, one per herdr session (architecture §3.5).
//!
//! Inputs: the herdr snapshot + coalesced events, the omp replicas (via `OmpHandle`),
//! the companion bridge, git repo info (cached), host info/health. Every input change
//! marks the store dirty; a flusher rebuilds the board at most 10×/s, diffs it against
//! what clients have and broadcasts `patch`es (one rev per message). Pulses are
//! aggregated per 100 ms window. Archive, turns, activity and usage persist in
//! `state.json`.

pub mod build;
pub mod persist;
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
    ActivityEvent, ActivityKind, Agent, Column, HerdrState, HostHealth, HostInfo, HostState, Notification, Pulse,
    PulseKind, RepoInfo, SetupStatus, StatePatch, UsageTotals,
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
const REPO_TTL: Duration = Duration::from_secs(20);
const HEALTH_EVERY: Duration = Duration::from_secs(5);
const INFO_EVERY: Duration = Duration::from_secs(60);
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

struct Inner {
    rev: u64,
    published: HostState,
    sinks: Vec<ClientHandle>,
    mirror: Mirror,
    tracks: HashMap<String, Track>,
    /// cwd → repo (None = not a repository), with fetch time.
    repos: HashMap<String, (Option<RepoInfo>, Instant)>,
    /// pane → foreground pids (omp pid cross-check), with fetch time.
    pane_pids: HashMap<String, (Vec<u32>, Instant)>,
    /// agent id → omp session id (current mapping).
    omp_of: HashMap<String, String>,
    pulses: HashMap<(String, PulseKind), u32>,
    health: Option<HostHealth>,
    built_once: bool,
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
                    omp_of: HashMap::new(),
                    pulses: HashMap::new(),
                    health: None,
                    built_once: false,
                }),
                dirty: Notify::new(),
                resnap: Notify::new(),
                repo_kick: Notify::new(),
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
        self.lock().published.agents.iter().find(|a| a.pane_id == pane_id).cloned()
    }

    /// The raw herdr agent record (fresh from the mirror).
    pub fn herdr_agent(&self, agent_id: &str) -> Option<AgentInfo> {
        self.lock().mirror.agents.iter().find(|a| build::agent_id(a) == agent_id).cloned()
    }

    /// omp session id the agent is mapped to.
    pub fn omp_session_of(&self, agent_id: &str) -> Option<String> {
        self.lock().omp_of.get(agent_id).cloned()
    }

    /// Sends `snapshot` + registers the client for patches (on hello).
    pub fn attach_client(&self, client: &ClientHandle) {
        let mut m = self.lock();
        client.send(ServerMsg::Snapshot { rev: m.rev, state: m.published.clone() });
        m.sinks.retain(|c| !c.is_closed() && c.id() != client.id());
        m.sinks.push(client.clone());
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

    pub fn set_info(&self, info: HostInfo) {
        let mut m = self.lock();
        if m.published.info != info {
            m.published.info = info.clone();
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
        let (sid, name) = {
            let m = self.lock();
            if !m.mirror.agents.iter().any(|a| build::agent_id(a) == agent_id) {
                return false;
            }
            (m.omp_of.get(agent_id).cloned(), m.tracks.get(agent_id).map(|t| t.name.clone()))
        };
        let now = now_ms();
        self.inner.persist.session(&self.inner.session, |s| {
            if archived {
                s.archived.insert(agent_id.to_string(), now);
                if let Some(sid) = &sid {
                    s.archived_sessions.insert(sid.clone(), now);
                }
            } else {
                s.archived.remove(agent_id);
                if let Some(sid) = &sid {
                    s.archived_sessions.remove(sid);
                }
            }
        });
        let kind = if archived { ActivityKind::Archived } else { ActivityKind::Unarchived };
        let name = name.unwrap_or_else(|| agent_id.to_string());
        self.push_activity(agent_id, &name, kind, format!("{} {name}", if archived { "Archived" } else { "Un-archived" }), None);
        self.mark_dirty();
        true
    }

    /// Forces a repo refresh for a folder (after commits, turns).
    pub fn refresh_repo(&self, cwd: &str) {
        self.lock().repos.remove(cwd);
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
        let persisted = store.persist.read(|d| d.sessions.get(&store.session).cloned().unwrap_or_default());
        let mut guard = self.lock();
        let m = &mut *guard;

        // Map agents → omp sessions (sessionId from herdr, cross-checked with the pid).
        let mut omp_of = HashMap::new();
        for a in m.mirror.agents.iter().filter(|a| build::is_omp(a)) {
            let id = build::agent_id(a);
            let pids = m.pane_pids.get(&a.pane_id).map(|(p, _)| p.as_slice()).unwrap_or(&[]);
            if let Some(sid) = resolve_omp_session(&store.omp, a, pids) {
                omp_of.insert(id, sid);
            }
        }

        let mut agent_by_pane = HashMap::new();
        let mut agents = Vec::with_capacity(m.mirror.agents.len());
        let mut unarchive = Vec::new();
        let mut transitions: Vec<(Option<Column>, Agent, bool, bool)> = Vec::new();
        let mut seen = HashSet::new();
        let mut new_turns: Vec<String> = Vec::new();
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
            let link = if view.is_none() { store.omp.link_without_guest(sid.as_deref()) } else { (tf_proto::model::LinkState::Live, None) };
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
            });
            track.name = name;
            track.omp_session = sid.clone();
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
            let repo = m.repos.get(&cwd).and_then(|(r, _)| r.as_ref());
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
            let prev_col = track.column;
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
            transitions.push((prev_col, agent.clone(), quiet, needs_note));
            agents.push(agent);
        }
        m.tracks.retain(|k, _| seen.contains(k));
        m.omp_of = omp_of;

        // Persist turns, first-seen, auto-unarchive.
        if !new_turns.is_empty() || !unarchive.is_empty() || seen.iter().any(|id| !persisted.first_seen.contains_key(id)) {
            let sids: HashMap<String, Option<String>> =
                unarchive.iter().map(|id| (id.clone(), m.omp_of.get(id).cloned())).collect();
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

        let repos: HashMap<String, Option<RepoInfo>> = m.repos.iter().map(|(k, (v, _))| (k.clone(), v.clone())).collect();
        let workspaces = if m.mirror.ok || !m.mirror.workspaces.is_empty() {
            build::build_workspaces(&m.mirror.workspaces, &m.mirror.tabs, &m.mirror.panes, &agent_by_pane, &repos)
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
        for (_prev, agent, quiet, needs_note) in transitions {
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
                notes.push(build::finished_notification(&agent, now));
                acts.push((agent.id.clone(), agent.name.clone(), ActivityKind::Finished, agent.title.clone(), agent.live.line.clone()));
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
                m.repos.remove(&cwd);
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
            let started = signals.iter().any(|s| matches!(s, Signal::TurnStarted));
            let now = now_ms();
            ids.into_iter()
                .map(|a| {
                    let track = m.tracks.get_mut(&a);
                    let name = track.as_ref().map(|t| t.name.clone()).unwrap_or_else(|| a.clone());
                    if let (true, Some(t)) = (started, track) {
                        t.turn_signal_at = Some(now);
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
/// pane's foreground pids (after `/new` herdr may lag behind the live room).
fn resolve_omp_session(omp: &OmpHandle, a: &AgentInfo, pids: &[u32]) -> Option<String> {
    let reported = a.agent_session.as_ref().and_then(|s| s.session_id().map(str::to_string));
    let by_pid = pids.iter().find_map(|p| omp.session_by_pid(*p).map(|s| s.session_id.clone()).or_else(|| {
        omp.registry_row_by_pid(*p).and_then(|r| r.session_id)
    }));
    match (reported, by_pid) {
        (Some(r), Some(p)) if r != p => {
            // The pid is authoritative for which process owns the pane.
            let pid_owner = omp.session(&r).map(|s| s.pid);
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
        },
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
        Ok(info) => h.lock().published.info = info,
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
}

fn apply_snapshot(h: &StateHandle, snap: tf_herdr::Snapshot) {
    let mut m = h.lock();
    m.mirror.ok = true;
    m.mirror.workspaces = snap.workspaces;
    m.mirror.tabs = snap.tabs;
    let live: HashSet<String> = snap.panes.iter().map(|p| p.pane_id.clone()).collect();
    m.mirror.panes = snap.panes;
    m.mirror.agents = snap.agents;
    m.mirror.activity.retain(|k, _| live.contains(k));
    m.pane_pids.retain(|k, _| live.contains(k));
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
            h.inner.repo_kick.notify_one();
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
            {
                let mut m = h.lock();
                m.mirror.activity.insert(p.pane_id.clone(), now);
                if let Some(slot) = m.mirror.panes.iter_mut().find(|x| x.pane_id == p.pane_id) {
                    *slot = p.clone();
                } else {
                    resnap = true;
                }
                match m.mirror.agents.iter_mut().find(|a| a.pane_id == p.pane_id) {
                    Some(a) => {
                        if p.agent.is_none() || p.agent != a.agent {
                            resnap = true;
                        }
                        let status_changed = a.agent_status != p.agent_status;
                        a.agent_status = p.agent_status;
                        a.agent_session = p.agent_session.clone();
                        a.cwd = p.cwd.clone();
                        a.foreground_cwd = p.foreground_cwd.clone();
                        a.terminal_title = p.terminal_title.clone();
                        a.terminal_title_stripped = p.terminal_title_stripped.clone();
                        a.title = p.title.clone();
                        a.display_agent = p.display_agent.clone();
                        a.tokens = p.tokens.clone();
                        let id = build::agent_id(a);
                        let linked = m.omp_of.contains_key(&id);
                        pulse_agent = Some((id, linked, status_changed));
                    }
                    None => {
                        if p.agent.is_some() {
                            resnap = true;
                        }
                    }
                }
            }
            let pulse_agent_status_changed = pulse_agent.as_ref().is_some_and(|(_, _, s)| *s);
            if let Some((id, linked, status_changed)) = pulse_agent {
                if status_changed {
                    h.add_pulse(&id, PulseKind::State, 1);
                } else if !linked {
                    h.add_pulse(&id, PulseKind::Event, 1);
                }
            }
            h.mark_dirty();
            // Status changes are applied at once (fast UI) and confirmed by a snapshot: a
            // coalesced `pane_updated` may carry an older status than a per-pane event.
            return resnap || pulse_agent_status_changed;
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

/// Fetches foreground pids for omp panes that lack them (pid cross-check).
async fn fetch_pids(ctx: &Arc<Ctx>) {
    let want: Vec<String> = {
        let m = ctx.state.lock();
        m.mirror
            .agents
            .iter()
            .filter(|a| build::is_omp(a))
            .filter(|a| m.pane_pids.get(&a.pane_id).is_none_or(|(_, at)| at.elapsed() > Duration::from_secs(30)))
            .map(|a| a.pane_id.clone())
            .collect()
    };
    for pane in want {
        if let Ok(info) = ctx.herdr.pane_process_info(&pane).await {
            let pids: Vec<u32> = info.foreground_processes.iter().map(|p| p.pid).chain(info.shell_pid).collect();
            ctx.state.lock().pane_pids.insert(pane, (pids, Instant::now()));
        }
    }
}

async fn flusher(ctx: Arc<Ctx>) {
    let h = ctx.state.clone();
    let mut tick = tokio::time::interval(Duration::from_secs(5));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = ctx.cancel.cancelled() => return,
            // A short settle lets near-simultaneous inputs (herdr status + collab frame) land together.
            _ = h.inner.dirty.notified() => tokio::time::sleep(Duration::from_millis(25)).await,
            // Time-based state (quiet detection, liveness ages) needs periodic rebuilds.
            _ = tick.tick() => {}
        }
        h.rebuild();
        tokio::time::sleep(FLUSH_MIN).await;
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
    // only the not-yet-sent suffix goes out.
    let mut btw_sent: HashMap<String, String> = HashMap::new();
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
            BridgeEvent::BtwDelta { session_id, btw_id, text, done, error } if mapped(session_id) => {
                let sent = btw_sent.entry(btw_id.clone()).or_default();
                let mut delta = if *done {
                    text.strip_prefix(sent.as_str()).map(str::to_string).unwrap_or_default()
                } else {
                    text.clone()
                };
                if !*done {
                    sent.push_str(text);
                } else {
                    btw_sent.remove(btw_id);
                }
                if let (Some(e), true) = (error, *done) {
                    delta.push_str(&format!("\n\n⚠ {e}"));
                }
                if let Some(s) = ctx.omp.session(session_id) {
                    s.send_extra(tf_proto::session::SessionEvent::Btw { btw_id: btw_id.clone(), text: delta, done: *done });
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

async fn fetch_repos(h: &StateHandle) {
    let want: Vec<String> = {
        let m = h.lock();
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
        cwds.into_iter()
            .filter(|c| !c.is_empty())
            .filter(|c| m.repos.get(c).is_none_or(|(_, at)| at.elapsed() > REPO_TTL))
            .collect()
    };
    if want.is_empty() {
        return;
    }
    let mut changed = false;
    for cwd in want {
        let info = crate::ops::git::repo_info(Path::new(&cwd)).await;
        let mut m = h.lock();
        if m.repos.get(&cwd).is_none_or(|(old, _)| *old != info) {
            changed = true;
        }
        m.repos.insert(cwd, (info, Instant::now()));
    }
    if changed {
        h.mark_dirty();
    }
}

async fn repo_loop(ctx: Arc<Ctx>) {
    let h = ctx.state.clone();
    loop {
        tokio::select! {
            _ = ctx.cancel.cancelled() => return,
            _ = h.inner.repo_kick.notified() => {}
            _ = tokio::time::sleep(REPO_TTL) => {}
        }
        fetch_repos(&h).await;
    }
}

async fn host_loop(ctx: Arc<Ctx>) {
    let h = ctx.state.clone();
    let mut last_info = Instant::now();
    loop {
        tokio::select! {
            _ = ctx.cancel.cancelled() => return,
            _ = tokio::time::sleep(HEALTH_EVERY) => {}
        }
        if !h.has_clients() {
            continue;
        }
        let health = tokio::task::spawn_blocking(crate::ops::host::health).await;
        if let Ok(health) = health {
            h.set_health(health);
        }
        if last_info.elapsed() >= INFO_EVERY {
            last_info = Instant::now();
            let info = crate::ops::host::probe_info(&ctx).await;
            h.set_info(info);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            link: (tf_proto::model::LinkState::NotShared, None),
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
