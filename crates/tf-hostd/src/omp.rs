//! omp data plane (architecture §3.4 `omp.rs`): the embedded collab relay, registry
//! polling, and one `tf_collab::Guest` + `Replica` per hosted omp session.
//!
//! Shared by every herdr session of the daemon. Session events are delivered to
//! subscribed clients directly from here (ordered with the snapshot under one lock,
//! coalesced to one flush per 50 ms); board-level changes are announced on a
//! broadcast channel that each state store consumes.
//!
//! Link lifecycle (architecture §3.4): a published `control` room on our relay is joined; a
//! failed join is retried with backoff (2 s doubling to 60 s) for as long as the room is
//! published, with join timeouts that grow after each timeout ([`JoinTimeouts::escalated`]) and
//! a room reset once joins keep timing out ([`RESET_AFTER_TIMEOUTS`]). Only failures retrying
//! cannot fix show as `error` / `unsupported`; everything else stays `connecting` with the last
//! failure as `linkError`.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::time::{Duration, Instant};

use tokio::sync::{broadcast, Notify};
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

use tf_collab::{
    Access, EndReason, Guest, GuestError, GuestEvent, HostEntry, JoinTimeouts, Registry, RegistryError, Relay,
    RelayConfig, RelayIdentity, Replica, Signal,
};
use tf_proto::host::ServerMsg;
use tf_proto::model::{
    Answer, ContextUsage, CostInfo, DiffStat, GoalInfo, LinkState, Liveness, ModelRef, NeedsYou, OmpMode, PulseKind, QueueInfo,
    SetupIssue, Severity, SubagentSummary, ThinkingLevel, TodoSummary, UsageTotals,
};
use tf_proto::session::{HistoryPage, SessionEvent, SessionMeta, SessionSnapshot, TreeInfo, UiRequest};
use tf_proto::{ApiError, Millis};

use crate::clients::ClientHandle;
use crate::state::persist::Persist;
use crate::util::{local_day, now_ms};

/// Display name of TeleFlock's guest in omp rooms.
pub const GUEST_NAME: &str = "TeleFlock";
/// One flush of session events per 50 ms (architecture §3.3).
const FLUSH_EVERY: Duration = Duration::from_millis(50);
/// At most one `meta` event per session this often; the latest state always goes out, the ones
/// in between are folded into it.
const META_EVERY: Duration = Duration::from_millis(500);
/// Apps from this version (its pre-releases included) keep a session's tree when a `meta` comes
/// without one, so they get the tree only when it changed; older apps get it in every `meta`.
const TREE_ON_CHANGE_SINCE: &str = "0.5.1-0";
const POLL_EVERY: Duration = Duration::from_millis(1500);
/// A failed join is retried after 2 s, doubled per consecutive failure up to 60 s (±25 %), for as
/// long as the room stays published: a slow host is never given up on.
const JOIN_BACKOFF_BASE: Duration = Duration::from_secs(2);
const JOIN_BACKOFF_MAX: Duration = Duration::from_secs(60);
/// A failure record outlives its registry row this long, so a host that misses polls while busy
/// keeps its backoff and its escalated join timeouts.
const FAILURE_FORGET: Duration = Duration::from_secs(120);
/// From this many consecutive joins (or reconnects) of one room that timed out waiting for the
/// host, hostd resets the room before the next try: the relay closes the host's connection, omp
/// reconnects within ~1 s and the room starts over without any per-guest state. Seen in the
/// field: a resumed session whose room let every join time out for hours, until a relay restart
/// (which is the same reset for every room) fixed it at once.
pub const RESET_AFTER_TIMEOUTS: u32 = 2;
/// How long an omp process that will share (started with TeleFlock's overlay, or global sharing
/// on) shows as `connecting` before its first room appears; a slow host needs minutes to start
/// omp. After that it is `notShared`.
const ROOM_WAIT: Duration = Duration::from_secs(300);
/// Our relay drops a silent peer after this long. omp's event loop (which also answers pings)
/// can block for over a minute while it serializes a large session on a slow machine; a dead
/// loopback peer closes its socket, so silence never needs a short timeout here.
const RELAY_IDLE: Duration = Duration::from_secs(180);

/// Board-relevant change announced to the state stores.
#[derive(Debug, Clone)]
pub enum OmpUpdate {
    /// Meta, liveness, ui or link of this omp session changed.
    Changed { session_id: String },
    Pulses { session_id: String, pulses: Vec<(PulseKind, u32)> },
    Signals { session_id: String, signals: Vec<Signal> },
    /// Registry rows or link states changed (re-map agents).
    Registry,
}

/// What the board needs about one omp session. Rebuilt for every agent on each board rebuild
/// (several a second while agents stream): summaries instead of the session's lists and tree.
#[derive(Debug, Clone)]
pub struct OmpView {
    pub session_id: String,
    pub pid: u32,
    pub link: LinkState,
    pub link_error: Option<String>,
    pub meta: BoardMeta,
    pub live: Liveness,
    pub needs: Option<NeedsYou>,
    pub streaming: bool,
    pub first_prompt: Option<String>,
    /// The replica is inside a turn (`agent_start` … `agent_end`).
    pub turn_active: bool,
}

/// The session meta facts an agent card shows ([`MetaOverlay::board`]).
#[derive(Debug, Clone)]
pub struct BoardMeta {
    pub session_id: Option<String>,
    pub session_file: Option<String>,
    pub title: Option<String>,
    pub model: Option<ModelRef>,
    pub thinking: Option<ThinkingLevel>,
    pub fast: bool,
    pub mode: OmpMode,
    pub goal: Option<GoalInfo>,
    pub context: Option<ContextUsage>,
    pub cost: Option<CostInfo>,
    pub queue: QueueInfo,
    pub started_at: Option<Millis>,
    pub todos: Option<TodoSummary>,
    pub subagents: Option<SubagentSummary>,
    pub diff: Option<DiffStat>,
}

/// A client subscribed to the session (`session.open`) as one of its agents.
struct Sub {
    client: ClientHandle,
    agent_id: String,
    /// The app keeps its tree when a `meta` omits it ([`TREE_ON_CHANGE_SINCE`]).
    tree_on_change: bool,
}

/// Whether an app of `version` keeps its session tree when a `meta` comes without one.
fn keeps_tree(version: &str) -> bool {
    tf_proto::version::cmp_semver(version, TREE_ON_CHANGE_SINCE).is_some_and(|o| o.is_ge())
}

struct SessionState {
    replica: Replica,
    link: LinkState,
    link_error: Option<String>,
    pending: Vec<SessionEvent>,
    last_flush: Instant,
    /// When the armed flush timer fires (one at a time, see [`arm_flush`]).
    flush_at: Option<Instant>,
    subs: Vec<Sub>,
    last_cost: Option<CostInfo>,
    first_prompt: Option<String>,
    overlay: MetaOverlay,
    /// The session tree from the bridge (`getTree`), refreshed when the omp leaf moves.
    tree: Option<TreeInfo>,
    /// Raw omp leaf id the cached (or in-flight) session tree was fetched for.
    tree_for: Option<Option<String>>,
    /// Bumped whenever `tree` changes; `tree_sent` is the value the last `meta` or reset carried.
    tree_rev: u64,
    tree_sent: u64,
    /// Subscribers are owed a `meta` (replica or overlay change): it goes out, rebuilt from the
    /// latest state, with the first flush [`META_EVERY`] allows.
    meta_due: bool,
    meta_sent_at: Option<Instant>,
}

impl SessionState {
    /// When pending events or an owed `meta` are next due (`None`: nothing to send).
    fn next_flush(&self) -> Option<Instant> {
        let events = (!self.pending.is_empty()).then(|| self.last_flush + FLUSH_EVERY);
        let meta = self.meta_due.then(|| self.meta_sent_at.map_or(self.last_flush, |t| t + META_EVERY));
        events.into_iter().chain(meta).min()
    }
}

/// One joined omp collab room.
pub struct OmpSession {
    pub session_id: String,
    pub instance_id: String,
    pub generation: u64,
    pub pid: u32,
    /// Relay room id (for a room reset when reconnects keep timing out).
    room_id: String,
    pub guest: Guest,
    st: Mutex<SessionState>,
    closed: AtomicBool,
    /// Wakes the journal reader (turn boundaries, prompts, snapshots).
    journal_kick: Notify,
}

impl OmpSession {
    fn lock(&self) -> std::sync::MutexGuard<'_, SessionState> {
        self.st.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Subscribes `client` (as `agent_id`) and returns the snapshot the live events
    /// continue from.
    pub fn subscribe(&self, client: &ClientHandle, agent_id: &str, limit: usize) -> SessionSnapshot {
        let mut st = self.lock();
        flush_locked(&mut st);
        st.subs.retain(|s| !(s.client.id() == client.id() && s.agent_id == agent_id) && !s.client.is_closed());
        let mut snap = st.replica.snapshot(limit);
        st.overlay.apply(&mut snap.meta, st.link == LinkState::Live);
        snap.meta.tree = st.tree.clone();
        snap.agent_id = agent_id.to_string();
        st.subs.push(Sub { client: client.clone(), agent_id: agent_id.to_string(), tree_on_change: keeps_tree(&client.info().version) });
        snap
    }

    pub fn unsubscribe(&self, client_id: &str, agent_id: &str) {
        self.lock().subs.retain(|s| !(s.client.id() == client_id && s.agent_id == agent_id));
    }

    pub fn unsubscribe_client(&self, client_id: &str) {
        self.lock().subs.retain(|s| s.client.id() != client_id);
    }

    /// Sends an out-of-band event (bridge: btw stream, plan review) to subscribers of
    /// this session, ordered after everything already replicated.
    pub fn send_extra(&self, ev: SessionEvent) {
        let mut st = self.lock();
        st.pending.push(ev);
        flush_locked(&mut st);
    }

    pub fn history(&self, cursor: Option<&str>, limit: usize) -> HistoryPage {
        self.lock().replica.history(cursor, limit)
    }

    pub fn ui(&self) -> Option<UiRequest> {
        self.lock().replica.ui().cloned()
    }

    pub fn is_streaming(&self) -> bool {
        self.lock().replica.is_streaming()
    }

    /// Replaces the bridge overlay; subscribers get a `meta` event when it changed.
    pub fn set_overlay(self: &Arc<Self>, overlay: MetaOverlay) {
        let mut st = self.lock();
        if st.overlay == overlay {
            return;
        }
        st.overlay = overlay;
        emit_meta(self, &mut st);
    }

    /// Claims a tree refresh for the raw omp leaf `leaf`; `false` when the cached or in-flight
    /// tree already covers it.
    pub fn claim_tree_refresh(&self, leaf: &Option<String>) -> bool {
        let mut st = self.lock();
        if st.tree_for.as_ref() == Some(leaf) {
            return false;
        }
        st.tree_for = Some(leaf.clone());
        true
    }

    /// Stores a fetched tree (`None` = the fetch failed; the next state change retries).
    pub fn set_tree(self: &Arc<Self>, tree: Option<TreeInfo>) {
        let mut st = self.lock();
        let Some(tree) = tree else {
            st.tree_for = None;
            return;
        };
        if st.tree.as_ref() == Some(&tree) {
            return;
        }
        st.tree = Some(tree);
        st.tree_rev += 1;
        emit_meta(self, &mut st);
    }

    pub fn link(&self) -> (LinkState, Option<String>) {
        let st = self.lock();
        (st.link, st.link_error.clone())
    }

    /// Maps an `Answer` to exact ui-response values and sends them.
    pub fn answer(&self, request_id: &str, answer: &Answer) -> Result<(), ApiError> {
        let replies = self.lock().replica.answer(request_id, answer)?;
        for r in replies {
            self.guest.ui_response(r.req_id, r.value).map_err(guest_err)?;
        }
        Ok(())
    }

    /// Attributes the echo of a prompt we're about to send to the sending device.
    pub fn expect_prompt(&self, text: &str, device: &str) {
        self.lock().replica.expect_prompt(text, device);
    }

    /// Links the echo of a prompt we're about to send to the originals kept of its images.
    pub fn expect_originals(&self, text: &str, kept: Vec<tf_collab::replica::KeptOriginal>) {
        self.lock().replica.expect_originals(text, kept);
    }

    /// Lists a prompt sent while omp streams in the queue until it lands (see
    /// [`tf_collab::replica::Replica::expect_queued`]).
    pub fn expect_queued(self: &Arc<Self>, text: &str, follow_up: bool) {
        let mut st = self.lock();
        if st.replica.expect_queued(text, follow_up, crate::util::now_ms()) {
            emit_meta(self, &mut st);
        }
    }

    /// Unlists a queued prompt that was pulled back out of omp's queue.
    pub fn forget_queued(self: &Arc<Self>, text: &str) {
        let mut st = self.lock();
        if st.replica.forget_queued(text) {
            emit_meta(self, &mut st);
        }
    }

    pub fn view(&self, now: Millis) -> OmpView {
        let st = self.lock();
        OmpView {
            session_id: self.session_id.clone(),
            pid: self.pid,
            link: st.link,
            link_error: st.link_error.clone(),
            meta: st.overlay.board(st.replica.meta()),
            live: st.replica.liveness(now),
            needs: st.replica.needs(),
            streaming: st.replica.is_streaming(),
            first_prompt: st.first_prompt.clone(),
            turn_active: st.replica.turn_started_at().is_some(),
        }
    }

    fn end(&self, reason: &str) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut st = self.lock();
        st.pending.push(SessionEvent::Ended { reason: reason.to_string() });
        flush_locked(&mut st);
        st.subs.clear();
        drop(st);
        self.guest.close();
    }
}

/// First real (non-synthetic) user prompt among replicated events.
fn first_prompt_in(events: &[SessionEvent]) -> Option<String> {
    use tf_proto::session::TranscriptItem;
    let pick = |i: &TranscriptItem| match i {
        TranscriptItem::User(u) if !u.synthetic && !u.text.trim().is_empty() => {
            Some(crate::util::clip(u.text.lines().next().unwrap_or_default(), 80))
        }
        _ => None,
    };
    events.iter().find_map(|ev| match ev {
        SessionEvent::Reset { snapshot } => snapshot.items.iter().find_map(pick),
        SessionEvent::Upsert { item, .. } => pick(item),
        _ => None,
    })
}

/// Bridge-derived session facts layered over the replica's meta (the companion
/// extension knows model/thinking/mode/queue precisely; collab lags or lacks them). The session
/// tree, also from the bridge, is kept beside it ([`OmpSession::set_tree`]).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MetaOverlay {
    pub bridge: bool,
    pub model: Option<ModelRef>,
    pub thinking: Option<ThinkingLevel>,
    pub fast: Option<bool>,
    pub mode: Option<OmpMode>,
    pub title: Option<String>,
    pub context: Option<ContextUsage>,
    pub queue: Option<QueueInfo>,
    /// `Some(goal)` when the bridge reports goal state (authoritative: `Some(None)` = no
    /// active goal, e.g. after drop/complete); `None` = keep the replica's value.
    pub goal: Option<Option<GoalInfo>>,
}

impl MetaOverlay {
    pub fn apply(&self, meta: &mut SessionMeta, live: bool) {
        meta.caps = crate::state::build::capabilities(live, self.bridge);
        if let Some(v) = &self.model {
            meta.model = Some(v.clone());
        }
        if let Some(v) = self.thinking {
            meta.thinking = Some(v);
        }
        if let Some(v) = self.fast {
            meta.fast = v;
        }
        if let Some(v) = self.mode {
            meta.mode = v;
        }
        if let Some(v) = &self.title {
            meta.title = Some(v.clone());
        }
        if let Some(v) = &self.context {
            meta.context = Some(v.clone());
        }
        if let Some(v) = &self.queue {
            meta.queue = queue_with(v, &meta.queue);
        }
        if let Some(g) = &self.goal {
            meta.goal = g.clone();
        }
    }

    /// The card facts of `meta` with this overlay: what [`Self::apply`] gives, without copying
    /// the lists the card only summarizes.
    pub fn board(&self, meta: &SessionMeta) -> BoardMeta {
        use crate::state::build;
        BoardMeta {
            session_id: meta.session_id.clone(),
            session_file: meta.session_file.clone(),
            title: self.title.clone().or_else(|| meta.title.clone()),
            model: self.model.clone().or_else(|| meta.model.clone()),
            thinking: self.thinking.or(meta.thinking),
            fast: self.fast.unwrap_or(meta.fast),
            mode: self.mode.unwrap_or(meta.mode),
            goal: match &self.goal {
                Some(g) => g.clone(),
                None => meta.goal.clone(),
            },
            context: self.context.clone().or_else(|| meta.context.clone()),
            cost: meta.cost.clone(),
            queue: match &self.queue {
                Some(v) => queue_with(v, &meta.queue),
                None => meta.queue.clone(),
            },
            started_at: meta.started_at,
            todos: build::todo_summary(&meta.todos),
            subagents: build::subagent_summary(&meta.subagents),
            diff: build::diff_stat(&meta.files),
        }
    }
}

/// The bridge reads omp's TUI band, which omp does not refresh for collab-guest steers: keep the
/// prompts we queued that it doesn't list (yet).
fn queue_with(bridge: &QueueInfo, ours: &QueueInfo) -> QueueInfo {
    tf_collab::replica::merge_queue(bridge, ours)
}

/// Owes subscribers a `meta` event ([`META_EVERY`]).
fn emit_meta(session: &Arc<OmpSession>, st: &mut SessionState) {
    st.meta_due = true;
    schedule_flush(session, st);
}

/// Sends pending events to the subscribers, merging appends to the same row, then the owed `meta`
/// when [`META_EVERY`] allows (else it stays owed: [`schedule_flush`] times it).
fn flush_locked(st: &mut SessionState) {
    st.last_flush = Instant::now();
    st.subs.retain(|s| !s.client.is_closed());
    let (mut events, meta_changed) = coalesce(std::mem::take(&mut st.pending));
    st.meta_due |= meta_changed;
    if st.subs.is_empty() {
        // Nobody listens: a `session.open` starts from a fresh snapshot.
        st.meta_due = false;
        return;
    }
    let live = st.link == LinkState::Live;
    let mut ended = false;
    for ev in &mut events {
        match ev {
            SessionEvent::Reset { snapshot } => {
                st.overlay.apply(&mut snapshot.meta, live);
                snapshot.meta.tree = st.tree.clone();
                st.tree_sent = st.tree_rev;
            }
            SessionEvent::Ended { .. } => ended = true,
            _ => {}
        }
    }
    for ev in events {
        for sub in &st.subs {
            let ev = match &ev {
                SessionEvent::Reset { snapshot } => {
                    let mut s = snapshot.clone();
                    s.agent_id = sub.agent_id.clone();
                    SessionEvent::Reset { snapshot: s }
                }
                other => other.clone(),
            };
            sub.client.send(ServerMsg::Session { agent_id: sub.agent_id.clone(), ev, seq: None });
        }
    }
    if ended {
        st.meta_due = false;
    }
    if !st.meta_due || st.meta_sent_at.is_some_and(|t| t.elapsed() < META_EVERY) {
        return;
    }
    st.meta_due = false;
    st.meta_sent_at = Some(Instant::now());
    let mut meta = st.replica.meta().clone();
    st.overlay.apply(&mut meta, live);
    // Apps that keep their tree get it only when it changed; older ones in every meta.
    let tree_changed = st.tree_rev != st.tree_sent;
    st.tree_sent = st.tree_rev;
    let with_tree = st.tree.as_ref().filter(|_| tree_changed || st.subs.iter().any(|s| !s.tree_on_change)).map(|tree| {
        let mut full = meta.clone();
        full.tree = Some(tree.clone());
        full
    });
    for sub in &st.subs {
        let meta = match &with_tree {
            Some(full) if tree_changed || !sub.tree_on_change => full.clone(),
            _ => meta.clone(),
        };
        sub.client.send(ServerMsg::Session { agent_id: sub.agent_id.clone(), ev: SessionEvent::Meta { meta }, seq: None });
    }
}

/// Merges `append`s into an earlier `append` of the same row and field when nothing in
/// between touched that row, and folds the `meta`s: a meta carries the whole state, so the flush
/// sends one, rebuilt from the latest state, after the other events (`true`: one was there).
pub fn coalesce(events: Vec<SessionEvent>) -> (Vec<SessionEvent>, bool) {
    let mut out: Vec<SessionEvent> = Vec::with_capacity(events.len());
    let mut meta = false;
    'next: for ev in events {
        match &ev {
            SessionEvent::Meta { .. } => {
                meta = true;
                continue;
            }
            SessionEvent::Append { id, field, text, .. } => {
                for prev in out.iter_mut().rev() {
                    match prev {
                        SessionEvent::Append { id: pid, field: pf, text: pt, .. } if pid == id => {
                            if pf == field {
                                pt.push_str(text);
                                continue 'next;
                            }
                        }
                        SessionEvent::Upsert { item, .. } if item.id() == id => break,
                        SessionEvent::Remove { id: rid } if rid == id => break,
                        SessionEvent::Reset { .. } | SessionEvent::Ended { .. } => break,
                        _ => {}
                    }
                }
            }
            _ => {}
        }
        out.push(ev);
    }
    (out, meta)
}

/// Port of a loopback relay URL (`ws://127.0.0.1:47466/...`); `None` for remote relays.
pub fn loopback_port(url: &str) -> Option<u16> {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let hostport = rest.split(['/', '#', '?']).next()?;
    let (host, port) = hostport.rsplit_once(':')?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if !matches!(host, "127.0.0.1" | "localhost" | "::1") {
        return None;
    }
    port.parse().ok()
}

/// Why the embedded relay is not listening (from the last bind attempt).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayDown {
    /// Another process holds `127.0.0.1:<port>`.
    PortInUse,
    Other(String),
}

/// Setup issue ids for a relay that is not listening (never fixable by `host.setupApply`).
pub const ISSUE_RELAY_PORT_IN_USE: &str = "relay-port-in-use";
pub const ISSUE_RELAY_DOWN: &str = "relay-down";
pub const RELAY_ISSUE_IDS: [&str; 2] = [ISSUE_RELAY_PORT_IN_USE, ISSUE_RELAY_DOWN];

/// Setup-checklist entry for a relay that is not listening; `None` while it is.
pub fn relay_issue(port: u16, listening: bool, down: Option<&RelayDown>) -> Option<SetupIssue> {
    if listening {
        return None;
    }
    let (id, title, detail) = match down {
        Some(RelayDown::PortInUse) => (
            ISSUE_RELAY_PORT_IN_USE,
            "Another process holds the TeleFlock relay port".to_string(),
            format!(
                "tf-hostd could not listen on 127.0.0.1:{port} because another process already holds that port. Live omp sessions cannot connect, and TeleFlock will not join rooms on a relay it does not own. Stop that process (find it with `ss -ltnp 'sport = :{port}'`) or restart tf-hostd with a different --relay-port; tf-hostd retries the port every few seconds."
            ),
        ),
        Some(RelayDown::Other(e)) => (
            ISSUE_RELAY_DOWN,
            "The TeleFlock relay is not listening".to_string(),
            format!("tf-hostd could not bind 127.0.0.1:{port} ({e}); live sessions cannot connect. Check ~/.teleflock/hostd.log."),
        ),
        None => (
            ISSUE_RELAY_DOWN,
            "The TeleFlock relay is not listening".to_string(),
            format!("tf-hostd is not serving 127.0.0.1:{port}; live sessions cannot connect. Check ~/.teleflock/hostd.log."),
        ),
    };
    Some(SetupIssue { id: id.into(), severity: Severity::Error, title, detail, fixable: false, recommended: true })
}

/// Proves that the relay a room lives on is the one this process started (fresh nonce, HMAC
/// answered on `/healthz`) and returns the `ws://` origin the guest must connect to. `own` is our
/// relay's identity and bound address; `None` when it is not running (another process may hold
/// the port). Only a foreign answer is final: no answer in time (a starved host) and a relay
/// that is still binding are retried.
async fn verify_room_relay(own: Option<(RelayIdentity, SocketAddr)>, port: u16, ws_url: &str) -> Result<String, JoinError> {
    let (identity, addr) = own.ok_or_else(|| {
        JoinError::new(
            FailKind::Transient,
            format!("the TeleFlock relay is not running on 127.0.0.1:{port}; not joining a room on a relay tf-hostd does not own"),
        )
    })?;
    // omp connects where its URL points: `[::1]` is a different socket from our IPv4 listener.
    let host = ws_url.split_once("://").map_or(ws_url, |(_, r)| r);
    let target = if host.starts_with("[::1]") { SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port) } else { addr };
    identity.verify(target).await.map_err(|e| {
        let kind = if matches!(e, tf_collab::IdentityError::Foreign(_)) { FailKind::Hard } else { FailKind::Transient };
        JoinError::new(kind, format!("refusing to join: the relay on {target} failed the identity check ({e})"))
    })?;
    Ok(format!("ws://{target}"))
}

#[derive(Default)]
struct Registryish {
    rows: Vec<HostEntry>,
    /// (instance, generation) shared on another relay.
    foreign: HashSet<(String, u64)>,
    joining: HashSet<String>,
    /// instance → the failed joins of its current room.
    failures: HashMap<String, JoinFailure>,
    /// omp pids that will share a room but have none yet → (first seen, last seen).
    awaiting: HashMap<u32, (Instant, Instant)>,
}

/// What a failed join means for the next one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FailKind {
    /// Retrying can work: the host is starting, busy, rotating or reconnecting.
    Transient,
    /// The host kept the room open but sent no welcome / snapshot in time: the next join waits
    /// longer, and repeated timeouts reset the room.
    TimedOut,
    /// Retrying alone cannot fix it (another relay answers on our port, a link we cannot use).
    Hard,
    /// The host speaks another collab protocol.
    Unsupported,
}

#[derive(Debug)]
struct JoinError {
    msg: String,
    kind: FailKind,
    /// Room the join targeted (for a reset).
    room_id: Option<String>,
}

impl JoinError {
    fn new(kind: FailKind, msg: impl Into<String>) -> Self {
        Self { msg: msg.into(), kind, room_id: None }
    }

    fn registry(e: RegistryError) -> Self {
        let kind = if matches!(e, RegistryError::BadLink(_)) { FailKind::Hard } else { FailKind::Transient };
        Self::new(kind, e.to_string())
    }

    fn guest(e: GuestError, room_id: &str) -> Self {
        let kind = match &e {
            GuestError::Timeout(_) => FailKind::TimedOut,
            GuestError::Rejected(m) if m.contains("protocol mismatch") => FailKind::Unsupported,
            _ => FailKind::Transient,
        };
        Self { msg: e.to_string(), kind, room_id: Some(room_id.to_string()) }
    }
}

/// Consecutive failed joins of one room (instance + generation).
#[derive(Debug, Clone)]
struct JoinFailure {
    generation: u64,
    error: String,
    kind: FailKind,
    /// Failed joins in a row.
    streak: u32,
    /// Of those, joins that timed out waiting for the host.
    timeouts: u32,
    /// Room of the last attempt (what a reset closes).
    room: Option<String>,
    retry_at: Instant,
    /// Last poll that listed the room.
    seen_at: Instant,
}

impl JoinFailure {
    fn new(generation: u64, now: Instant) -> Self {
        Self { generation, error: String::new(), kind: FailKind::Transient, streak: 0, timeouts: 0, room: None, retry_at: now, seen_at: now }
    }

    /// Counts a failed join and schedules the next one. True when the room should be reset first.
    fn record(&mut self, e: &JoinError, now: Instant) -> bool {
        self.streak += 1;
        if e.kind == FailKind::TimedOut {
            self.timeouts += 1;
        }
        self.error = e.msg.clone();
        self.kind = e.kind;
        if e.room_id.is_some() {
            self.room = e.room_id.clone();
        }
        self.retry_at = now + join_backoff(self.streak);
        self.seen_at = now;
        e.kind == FailKind::TimedOut && self.timeouts >= RESET_AFTER_TIMEOUTS
    }

    fn link(&self) -> (LinkState, Option<String>) {
        match self.kind {
            FailKind::Unsupported => (LinkState::Unsupported, Some(self.error.clone())),
            FailKind::Hard => (LinkState::Error, Some(self.error.clone())),
            FailKind::Transient | FailKind::TimedOut => {
                (LinkState::Connecting, Some(format!("join attempt {} failed: {}; retrying", self.streak, self.error)))
            }
        }
    }
}

/// Delay before the next join after `streak` consecutive failures: 2, 4, 8 … 60 s, ±25 %.
fn join_backoff(streak: u32) -> Duration {
    let base = JOIN_BACKOFF_BASE.saturating_mul(1u32 << streak.saturating_sub(1).min(5)).min(JOIN_BACKOFF_MAX);
    let mut r = [0u8; 2];
    let _ = getrandom::fill(&mut r);
    base.mul_f64(0.75 + f64::from(u16::from_le_bytes(r)) / f64::from(u16::MAX) * 0.5)
}

/// Whether omp process `pid` was started with TeleFlock's settings overlay (`--config
/// …/omp-overlay.yml`, which turns collab sharing on). Linux only (`/proc`); false elsewhere.
fn launched_with_overlay(pid: u32) -> bool {
    std::fs::read(format!("/proc/{pid}/cmdline")).is_ok_and(|raw| overlay_in_cmdline(&raw))
}

/// `--config <…/omp-overlay.yml>` / `--config=<…>` among NUL-separated argv.
fn overlay_in_cmdline(raw: &[u8]) -> bool {
    let mut args = raw.split(|b| *b == 0);
    while let Some(arg) = args.next() {
        let path = match arg.strip_prefix(b"--config=") {
            Some(p) => p,
            None if arg == b"--config" => args.next().unwrap_or_default(),
            None => continue,
        };
        if path.ends_with(b"omp-overlay.yml") {
            return true;
        }
    }
    false
}

struct Inner {
    relay_port: u16,
    relay: tokio::sync::Mutex<Option<Relay>>,
    relay_ok: AtomicBool,
    /// Last bind failure while the relay is down.
    relay_down: Mutex<Option<RelayDown>>,
    registry: Registry,
    reg: Mutex<Registryish>,
    sessions: RwLock<HashMap<String, Arc<OmpSession>>>,
    updates: broadcast::Sender<OmpUpdate>,
    repoll: Notify,
    persist: Arc<Persist>,
    cancel: CancellationToken,
}

/// Shared handle (cheap to clone).
#[derive(Clone)]
pub struct OmpHandle {
    inner: Arc<Inner>,
}

impl OmpHandle {
    /// Starts the relay (retrying in the background if the port is busy) and the
    /// registry poller.
    pub async fn start(relay_port: u16, persist: Arc<Persist>, cancel: CancellationToken) -> Self {
        let (updates, _) = broadcast::channel(4096);
        let inner = Arc::new(Inner {
            relay_port,
            relay: tokio::sync::Mutex::new(None),
            relay_ok: AtomicBool::new(false),
            relay_down: Mutex::new(None),
            registry: Registry::new(),
            reg: Mutex::new(Registryish::default()),
            sessions: RwLock::new(HashMap::new()),
            updates,
            repoll: Notify::new(),
            persist,
            cancel,
        });
        let me = Self { inner };
        me.try_start_relay().await;
        tokio::spawn(relay_keeper(Arc::downgrade(&me.inner)));
        tokio::spawn(poll_loop(Arc::downgrade(&me.inner)));
        me
    }

    async fn try_start_relay(&self) -> bool {
        let mut slot = self.inner.relay.lock().await;
        if slot.is_some() {
            return true;
        }
        let port = self.inner.relay_port;
        let mut cfg = RelayConfig::new(port);
        cfg.idle_timeout = RELAY_IDLE;
        match Relay::start(cfg).await {
            Ok(r) => {
                info!(port = r.port(), "collab relay listening");
                *slot = Some(r);
                self.inner.relay_ok.store(true, Ordering::Relaxed);
                self.inner.relay_down.lock().unwrap_or_else(|p| p.into_inner()).take();
                let _ = self.inner.updates.send(OmpUpdate::Registry);
                true
            }
            Err(e) => {
                let down = if e.kind() == std::io::ErrorKind::AddrInUse {
                    RelayDown::PortInUse
                } else {
                    RelayDown::Other(e.to_string())
                };
                let mut last = self.inner.relay_down.lock().unwrap_or_else(|p| p.into_inner());
                // Logged loudly once per distinct failure; the keeper retries every 5 s.
                if last.as_ref() != Some(&down) {
                    match &down {
                        RelayDown::PortInUse => {
                            error!(port, "collab relay cannot listen: another process holds 127.0.0.1:{port}; not joining rooms until it is free")
                        }
                        RelayDown::Other(_) => error!(port, "collab relay bind failed: {e}"),
                    }
                    *last = Some(down);
                    drop(last);
                    let _ = self.inner.updates.send(OmpUpdate::Registry);
                } else {
                    debug!(port, "collab relay bind still failing: {e}");
                }
                false
            }
        }
    }

    pub fn relay_listening(&self) -> bool {
        self.inner.relay_ok.load(Ordering::Relaxed)
    }

    /// The setup issue for a relay that is not listening (`relay-port-in-use` / `relay-down`).
    pub fn relay_issue(&self) -> Option<SetupIssue> {
        let down = self.inner.relay_down.lock().unwrap_or_else(|p| p.into_inner()).clone();
        relay_issue(self.inner.relay_port, self.relay_listening(), down.as_ref())
    }

    pub fn relay_port(&self) -> u16 {
        self.inner.relay_port
    }

    pub fn subscribe(&self) -> broadcast::Receiver<OmpUpdate> {
        self.inner.updates.subscribe()
    }

    /// Polls the registry now (after `agent.connect`, agent start, rotations).
    pub fn repoll(&self) {
        self.inner.repoll.notify_one();
    }

    /// `agent.connect` on a session that is still connecting: retry its join (or its guest's
    /// reconnect) now instead of after the backoff, and reset the room first when its joins
    /// have been timing out.
    pub async fn retry_now(&self, session_id: &str) {
        let mut reset = None;
        if let Some(s) = self.session(session_id) {
            if s.link().0 != LinkState::Live {
                let _ = s.guest.resync();
            }
        } else {
            let mut reg = self.inner.reg.lock().unwrap_or_else(|p| p.into_inner());
            let row = reg.rows.iter().filter(|r| r.session_id.as_deref() == Some(session_id)).max_by_key(|r| r.generation).cloned();
            if let Some(f) = row.and_then(|r| reg.failures.get_mut(&r.instance_id)) {
                f.retry_at = Instant::now();
                if f.timeouts > 0 {
                    reset = f.room.clone();
                }
            }
        }
        if let Some(room) = reset {
            reset_room(&self.inner, &room).await;
        }
        self.repoll();
    }

    pub fn session(&self, session_id: &str) -> Option<Arc<OmpSession>> {
        self.inner.sessions.read().unwrap_or_else(|p| p.into_inner()).get(session_id).cloned()
    }

    pub fn session_by_pid(&self, pid: u32) -> Option<Arc<OmpSession>> {
        self.inner.sessions.read().unwrap_or_else(|p| p.into_inner()).values().find(|s| s.pid == pid).cloned()
    }

    pub fn sessions(&self) -> Vec<Arc<OmpSession>> {
        self.inner.sessions.read().unwrap_or_else(|p| p.into_inner()).values().cloned().collect()
    }

    /// Latest registry row for an omp session (any relay).
    pub fn registry_row(&self, session_id: &str) -> Option<HostEntry> {
        let reg = self.inner.reg.lock().unwrap_or_else(|p| p.into_inner());
        reg.rows.iter().filter(|r| r.session_id.as_deref() == Some(session_id)).max_by_key(|r| r.generation).cloned()
    }

    pub fn registry_row_by_pid(&self, pid: u32) -> Option<HostEntry> {
        let reg = self.inner.reg.lock().unwrap_or_else(|p| p.into_inner());
        reg.rows.iter().filter(|r| r.pid == pid).max_by_key(|r| r.generation).cloned()
    }

    /// Link state of an omp session TeleFlock has not (or not yet) joined. `pids` are the
    /// pane's foreground processes; `shares_by_default`: omp's global config shares every
    /// session on our relay.
    pub fn link_without_guest(&self, session_id: Option<&str>, pids: &[u32], shares_by_default: bool) -> (LinkState, Option<String>) {
        let mut reg = self.inner.reg.lock().unwrap_or_else(|p| p.into_inner());
        let row = session_id
            .and_then(|sid| reg.rows.iter().filter(|r| r.session_id.as_deref() == Some(sid)).max_by_key(|r| r.generation))
            .cloned();
        let Some(row) = row else {
            // No room yet. An omp that will share is still starting (minutes on a slow host).
            let now = Instant::now();
            reg.awaiting.retain(|_, (_, last)| now.duration_since(*last) < ROOM_WAIT);
            let Some(&pid) = pids.iter().find(|p| shares_by_default || launched_with_overlay(**p)) else {
                return (LinkState::NotShared, None);
            };
            let (first, last) = reg.awaiting.entry(pid).or_insert((now, now));
            *last = now;
            return if now.duration_since(*first) < ROOM_WAIT {
                (LinkState::Connecting, Some("omp is starting; waiting for its collab room".into()))
            } else {
                (LinkState::NotShared, Some("omp has not opened a collab room on the TeleFlock relay".into()))
            };
        };
        if reg.foreign.contains(&(row.instance_id.clone(), row.generation)) {
            return (LinkState::NotShared, Some("shared on another relay".into()));
        }
        if row.access != "control" {
            return (LinkState::NotShared, Some(format!("room access is `{}`", row.access)));
        }
        if let Some(f) = reg.failures.get(&row.instance_id).filter(|f| f.generation == row.generation && f.streak > 0) {
            return f.link();
        }
        (LinkState::Connecting, None)
    }

    /// Today's (host-local) usage across every replica.
    pub fn usage_today(&self) -> UsageTotals {
        let day = local_day(now_ms());
        self.inner.persist.read(|d| d.usage.day(&day))
    }

    pub async fn shutdown(&self) {
        let sessions: Vec<_> = self.inner.sessions.write().unwrap_or_else(|p| p.into_inner()).drain().map(|(_, s)| s).collect();
        for s in sessions {
            s.end("tf-hostd stopped");
        }
        if let Some(relay) = self.inner.relay.lock().await.take() {
            relay.shutdown().await;
        }
        self.inner.relay_ok.store(false, Ordering::Relaxed);
    }
}

async fn relay_keeper(weak: Weak<Inner>) {
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let Some(inner) = weak.upgrade() else { return };
        if inner.cancel.is_cancelled() {
            return;
        }
        if !inner.relay_ok.load(Ordering::Relaxed) {
            let h = OmpHandle { inner };
            h.try_start_relay().await;
        }
    }
}

async fn poll_loop(weak: Weak<Inner>) {
    loop {
        let Some(inner) = weak.upgrade() else { return };
        if inner.cancel.is_cancelled() {
            return;
        }
        poll_once(&inner).await;
        let wait = async {
            tokio::select! {
                _ = inner.repoll.notified() => {}
                _ = tokio::time::sleep(POLL_EVERY) => {}
                _ = inner.cancel.cancelled() => {}
            }
        };
        wait.await;
    }
}

async fn poll_once(inner: &Arc<Inner>) {
    let rows = match inner.registry.poll().await {
        Ok(rows) => rows,
        Err(e) => {
            debug!("registry poll: {e}");
            return;
        }
    };
    let mut to_join = Vec::new();
    let changed;
    {
        let mut reg = inner.reg.lock().unwrap_or_else(|p| p.into_inner());
        changed = !same_rows(&reg.rows, &rows);
        let joined: HashSet<(String, u64)> = inner
            .sessions
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .map(|s| (s.instance_id.clone(), s.generation))
            .collect();
        let now = Instant::now();
        for row in &rows {
            if let Some(f) = reg.failures.get_mut(&row.instance_id).filter(|f| f.generation == row.generation) {
                f.seen_at = now;
            }
            // It has a room: a later gap (a busy host missing polls) starts a fresh room wait.
            reg.awaiting.remove(&row.pid);
            let key = (row.instance_id.clone(), row.generation);
            if !row.relay_connected || row.access != "control" || row.session_id.is_none() {
                continue;
            }
            if joined.contains(&key) || reg.foreign.contains(&key) || reg.joining.contains(&row.instance_id) {
                continue;
            }
            if reg.failures.get(&row.instance_id).is_some_and(|f| f.generation == row.generation && f.retry_at > now) {
                continue;
            }
            reg.joining.insert(row.instance_id.clone());
            to_join.push(row.clone());
        }
        let live: HashSet<&str> = rows.iter().map(|r| r.instance_id.as_str()).collect();
        // A busy host can miss polls: its failures (backoff, escalated timeouts) outlive the row.
        reg.failures.retain(|_, f| now.duration_since(f.seen_at) < FAILURE_FORGET);
        reg.foreign.retain(|(i, _)| live.contains(i.as_str()));
        reg.rows = rows;
    }
    if changed {
        let _ = inner.updates.send(OmpUpdate::Registry);
    }
    for row in to_join {
        let inner = inner.clone();
        tokio::spawn(async move {
            let (instance, generation) = (row.instance_id.clone(), row.generation);
            let timeouts = {
                let reg = inner.reg.lock().unwrap_or_else(|p| p.into_inner());
                reg.failures.get(&instance).filter(|f| f.generation == generation).map_or(0, |f| f.timeouts)
            };
            let res = join(&inner, row, JoinTimeouts::escalated(timeouts)).await;
            let mut reset = None;
            {
                let mut reg = inner.reg.lock().unwrap_or_else(|p| p.into_inner());
                reg.joining.remove(&instance);
                match res {
                    Ok(()) => {
                        reg.failures.remove(&instance);
                    }
                    Err(e) => {
                        let now = Instant::now();
                        let f = reg.failures.entry(instance.clone()).or_insert_with(|| JoinFailure::new(generation, now));
                        if f.generation != generation {
                            *f = JoinFailure::new(generation, now);
                        }
                        if f.record(&e, now) {
                            reset = f.room.clone();
                        }
                        let retry_in = f.retry_at.saturating_duration_since(now);
                        warn!(instance, attempt = f.streak, ?retry_in, "join failed: {}", e.msg);
                    }
                }
            }
            if let Some(room) = reset {
                reset_room(&inner, &room).await;
            }
            let _ = inner.updates.send(OmpUpdate::Registry);
        });
    }
}

/// Resets a room whose host stopped answering joins ([`Relay::reset_room`]).
async fn reset_room(inner: &Inner, room_id: &str) {
    let relay = inner.relay.lock().await;
    if relay.as_ref().is_some_and(|r| r.reset_room(room_id)) {
        info!("collab room reset: its host kept the room open but let {RESET_AFTER_TIMEOUTS}+ joins time out");
    }
}

fn same_rows(a: &[HostEntry], b: &[HostEntry]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(x, y)| {
            x.instance_id == y.instance_id
                && x.generation == y.generation
                && x.session_id == y.session_id
                && x.relay_connected == y.relay_connected
                && x.access == y.access
        })
}

async fn join(inner: &Arc<Inner>, row: HostEntry, timeouts: JoinTimeouts) -> Result<(), JoinError> {
    let session_id = row.session_id.clone().ok_or_else(|| JoinError::new(FailKind::Transient, "no session id"))?;
    let link = inner.registry.link(&row.instance_id, Access::Control).await.map_err(JoinError::registry)?;
    if loopback_port(&link.link.ws_url) != Some(inner.relay_port) {
        debug!(instance = %row.instance_id, url = %link.link.ws_url, "room is on another relay");
        inner.reg.lock().unwrap_or_else(|p| p.into_inner()).foreign.insert((row.instance_id.clone(), link.generation));
        return Ok(());
    }
    let own = inner.relay.lock().await.as_ref().map(|r| (r.identity(), r.local_addr()));
    let relay_url = verify_room_relay(own, inner.relay_port, &link.link.ws_url).await?;
    let room = link.link.with_relay(&relay_url).map_err(|e| JoinError::new(FailKind::Hard, e.to_string()))?;
    let room_id = room.room_id.clone();
    let (guest, rx) = Guest::connect_with(room, GUEST_NAME, timeouts).await.map_err(|e| JoinError::guest(e, &room_id))?;
    let mut replica = Replica::new(session_id.clone());
    for (id, slots) in inner.persist.read(|d| d.originals.get(&session_id).cloned()).unwrap_or_default() {
        replica.keep_originals(&id, slots);
    }
    let session = Arc::new(OmpSession {
        session_id: session_id.clone(),
        instance_id: row.instance_id.clone(),
        generation: link.generation,
        pid: row.pid,
        room_id,
        guest,
        st: Mutex::new(SessionState {
            replica,
            link: LinkState::Connecting,
            link_error: None,
            pending: Vec::new(),
            last_flush: Instant::now(),
            flush_at: None,
            subs: Vec::new(),
            last_cost: None,
            first_prompt: None,
            overlay: MetaOverlay::default(),
            tree: None,
            tree_for: None,
            tree_rev: 0,
            tree_sent: 0,
            meta_due: false,
            meta_sent_at: None,
        }),
        closed: AtomicBool::new(false),
        journal_kick: Notify::new(),
    });
    let old = inner.sessions.write().unwrap_or_else(|p| p.into_inner()).insert(session_id.clone(), session.clone());
    if let Some(old) = old {
        old.end("session moved to a new room");
    }
    info!(session = %session_id, instance = %row.instance_id, generation = link.generation, pid = row.pid, "joined omp session");
    tokio::spawn(pump(Arc::downgrade(inner), session.clone(), rx));
    tokio::spawn(journal_loop(Arc::downgrade(inner), session.clone()));
    tokio::spawn(artifact_loop(Arc::downgrade(inner), session));
    Ok(())
}

/// Keeps the image originals the replica linked across restarts (see [`crate::originals`]).
fn persist_originals(inner: &Inner, session_id: &str, signals: &[Signal]) {
    for signal in signals {
        if let Signal::OriginalsKept { id, originals } = signal {
            inner.persist.update(|d| d.originals.entry(session_id.to_owned()).or_default().insert(id.clone(), originals.clone()));
        }
    }
}

async fn pump(weak: Weak<Inner>, session: Arc<OmpSession>, mut rx: tokio::sync::mpsc::UnboundedReceiver<GuestEvent>) {
    let sid = session.session_id.clone();
    // Reconnects in a row whose welcome/snapshot timed out (a resync resets it).
    let mut timeouts = 0u32;
    while let Some(ev) = rx.recv().await {
        let Some(inner) = weak.upgrade() else { return };
        let now = now_ms();
        // Why the guest ended, and how the rejoin is paced (`None`: rotation or close, at once).
        let mut ended: Option<(String, Option<FailKind>)> = None;
        let mut reset = false;
        let (update, usage) = {
            let mut st = session.lock();
            match &ev {
                GuestEvent::Snapshot(_) => {
                    st.link = LinkState::Live;
                    st.link_error = None;
                    timeouts = 0;
                }
                GuestEvent::Reconnecting { reason, timed_out, .. } => {
                    st.link = LinkState::Connecting;
                    st.link_error = (!reason.is_empty()).then(|| reason.clone());
                    if *timed_out {
                        timeouts += 1;
                        reset = timeouts >= RESET_AFTER_TIMEOUTS;
                    }
                }
                GuestEvent::Ended(reason) => {
                    let (state, msg, pace) = match reason {
                        EndReason::Rejected(m) => (LinkState::Unsupported, m.clone(), Some(FailKind::Unsupported)),
                        EndReason::Fatal(m) => (LinkState::Error, m.clone(), Some(FailKind::Transient)),
                        EndReason::RoomGone => (LinkState::Connecting, "collab room closed".to_string(), Some(FailKind::Transient)),
                        other => (LinkState::Connecting, format!("{other:?}"), None),
                    };
                    st.link = state;
                    st.link_error = Some(msg.clone());
                    ended = Some((msg, pace));
                }
                GuestEvent::Frame(_) => {}
            }
            let update = st.replica.apply(&ev, now);
            st.pending.extend(update.events.iter().cloned());
            schedule_flush(&session, &mut st);
            if st.first_prompt.is_none() {
                st.first_prompt = first_prompt_in(&update.events);
            }
            (update, changed_usage(&mut st))
        };
        for r in &update.replies {
            if let Err(e) = session.guest.ui_response(r.req_id, r.value.clone()) {
                warn!(session = %sid, "auto ui-response: {e}");
            }
        }
        observe_usage(&inner, &sid, usage, now);
        if !update.pulses.is_empty() {
            let _ = inner.updates.send(OmpUpdate::Pulses { session_id: sid.clone(), pulses: update.pulses.clone() });
        }
        if !update.signals.is_empty() {
            persist_originals(&inner, &sid, &update.signals);
            if update.signals.iter().any(|s| matches!(s, Signal::TurnStarted | Signal::TurnEnded { .. } | Signal::Prompted { .. })) {
                session.journal_kick.notify_one();
            }
            let _ = inner.updates.send(OmpUpdate::Signals { session_id: sid.clone(), signals: update.signals.clone() });
        }
        if matches!(ev, GuestEvent::Snapshot(_)) {
            session.journal_kick.notify_one();
        }
        if update.meta_changed || update.liveness_changed || !update.events.is_empty() || ended.is_some()
            || matches!(ev, GuestEvent::Snapshot(_) | GuestEvent::Reconnecting { .. })
        {
            let _ = inner.updates.send(OmpUpdate::Changed { session_id: sid.clone() });
        }
        if reset {
            reset_room(&inner, &session.room_id).await;
        }
        if let Some((reason, pace)) = ended {
            info!(session = %sid, "guest ended: {reason}");
            {
                let mut map = inner.sessions.write().unwrap_or_else(|p| p.into_inner());
                if map.get(&sid).is_some_and(|s| Arc::ptr_eq(s, &session)) {
                    map.remove(&sid);
                }
            }
            session.end(&reason);
            if let Some(kind) = pace {
                // Rejoin through the registry after a backoff: a room that ends right after every
                // join must not spin.
                let now = Instant::now();
                let mut reg = inner.reg.lock().unwrap_or_else(|p| p.into_inner());
                let f = reg.failures.entry(session.instance_id.clone()).or_insert_with(|| JoinFailure::new(session.generation, now));
                if f.generation != session.generation {
                    *f = JoinFailure::new(session.generation, now);
                }
                f.record(&JoinError { msg: reason, kind, room_id: Some(session.room_id.clone()) }, now);
            }
            let _ = inner.updates.send(OmpUpdate::Registry);
            inner.repoll.notify_one();
            return;
        }
    }
}

/// Every ~2 s while a turn streams (goal progress is rewritten each turn).
const JOURNAL_EVERY: Duration = Duration::from_secs(2);

/// Reads the main session journal through the guest: omp does not mirror `mode_change` /
/// `custom` entries on the frame stream, so goal state (and plan mode, user todo edits)
/// only reach the replica this way.
async fn journal_loop(weak: Weak<Inner>, session: Arc<OmpSession>) {
    loop {
        let kicked = tokio::select! {
            _ = session.journal_kick.notified() => true,
            _ = tokio::time::sleep(JOURNAL_EVERY) => false,
        };
        if session.closed.load(Ordering::SeqCst) {
            return;
        }
        let Some(inner) = weak.upgrade() else { return };
        if !kicked && !session.is_streaming() {
            continue;
        }
        if let Err(e) = read_journal(&inner, &session).await {
            debug!(session = %session.session_id, "journal read: {e}");
        }
    }
}

async fn read_journal(inner: &Arc<Inner>, session: &Arc<OmpSession>) -> Result<(), String> {
    // Each reply is capped at 4 MiB; keep reading until caught up.
    for _ in 0..64 {
        let (main, offset) = {
            let st = session.lock();
            let Some(main) = st.replica.main_agent_id().map(str::to_string) else { return Ok(()) };
            (main, st.replica.journal_offset())
        };
        let chunk = session.guest.fetch_transcript(&main, offset).await.map_err(|e| e.to_string())?;
        let done = chunk.text.is_empty() || chunk.error.is_some();
        let (changed, usage) = {
            let mut st = session.lock();
            if st.replica.journal_offset() != offset {
                // Raced with a resync/rotation that reset the offset; start over next time.
                return Ok(());
            }
            let update = st.replica.apply_journal(&chunk);
            st.pending.extend(update.events.iter().cloned());
            schedule_flush(session, &mut st);
            (update.meta_changed || !update.events.is_empty(), changed_usage(&mut st))
        };
        observe_usage(inner, &session.session_id, usage, now_ms());
        if changed {
            let _ = inner.updates.send(OmpUpdate::Changed { session_id: session.session_id.clone() });
        }
        if let Some(err) = chunk.error {
            return Err(err);
        }
        if done {
            return Ok(());
        }
    }
    Ok(())
}

/// The replica's session total when it changed since the last call (for the usage ledger).
fn changed_usage(st: &mut SessionState) -> Option<CostInfo> {
    let c = st.replica.usage().filter(|c| st.last_cost.as_ref() != Some(c))?;
    st.last_cost = Some(c.clone());
    Some(c)
}

fn observe_usage(inner: &Inner, session_id: &str, cost: Option<CostInfo>, now: Millis) {
    if let Some(cost) = cost {
        let day = local_day(now);
        inner.persist.update_usage(|u| u.observe(session_id, &cost, &day));
    }
}

/// Artifact scan cadence while anything in the session may be billing (a turn, a running
/// subagent, a reply being replayed, recent transcript growth), and while it is quiet.
const ARTIFACTS_BUSY: Duration = Duration::from_secs(1);
const ARTIFACTS_IDLE: Duration = Duration::from_secs(5);
/// How long after the last growth the scan stays on the busy cadence.
const ARTIFACTS_LINGER: Duration = Duration::from_secs(30);
/// Retry interval while the session file is not on disk yet (omp writes it lazily).
const ARTIFACTS_LOCATE_EVERY: Duration = Duration::from_secs(10);

/// Tails the session's artifacts dir (subagent and advisor transcripts, which collab never
/// mirrors) into the replica's spend and throughput. See [`crate::artifacts`].
async fn artifact_loop(weak: Weak<Inner>, session: Arc<OmpSession>) {
    // (omp session id the ledger belongs to, artifacts dir, ledger)
    let mut tail: Option<(String, std::path::PathBuf, tf_collab::ArtifactLedger)> = None;
    let mut next_locate = Instant::now();
    let mut last_growth: Option<Instant> = None;
    let mut was_replaying = false;
    loop {
        let (sid, busy) = {
            let st = session.lock();
            let sid = st.replica.header().map(|h| h.id.clone()).filter(|s| !s.is_empty()).unwrap_or_else(|| session.session_id.clone());
            let busy = st.replica.is_streaming()
                || st.replica.replaying(now_ms())
                || st.replica.meta().subagents.iter().any(|s| s.status == tf_proto::session::SubagentStatus::Running)
                || last_growth.is_some_and(|t| t.elapsed() < ARTIFACTS_LINGER);
            (sid, busy)
        };
        tokio::time::sleep(if busy { ARTIFACTS_BUSY } else { ARTIFACTS_IDLE }).await;
        if session.closed.load(Ordering::SeqCst) {
            return;
        }
        let Some(inner) = weak.upgrade() else { return };
        if tail.as_ref().is_some_and(|(id, _, _)| *id != sid) {
            tail = None;
        }
        if tail.is_none() {
            if Instant::now() < next_locate {
                continue;
            }
            next_locate = Instant::now() + ARTIFACTS_LOCATE_EVERY;
            let root = crate::ops::host::omp_agent_dir().join("sessions");
            let id = sid.clone();
            let found = tokio::task::spawn_blocking(move || crate::artifacts::find_session_file(&root, &id)).await.ok().flatten();
            let Some(file) = found else { continue };
            debug!(session = %sid, file = %file.display(), "artifact scan: session file");
            tail = Some((sid.clone(), crate::artifacts::artifacts_dir(&file), tf_collab::ArtifactLedger::default()));
        }
        let Some((id, dir, mut ledger)) = tail.take() else { continue };
        let scanned = tokio::task::spawn_blocking(move || {
            let calls = crate::artifacts::scan(&dir, &mut ledger);
            (dir, ledger, calls)
        })
        .await;
        let calls = match scanned {
            Ok((dir, ledger, calls)) => {
                tail = Some((id, dir, ledger));
                calls
            }
            Err(e) => {
                warn!(session = %sid, "artifact scan: {e}");
                continue;
            }
        };
        let Some((_, _, ledger)) = tail.as_ref() else { continue };
        let now = now_ms();
        let (changed, replaying, usage) = {
            let mut st = session.lock();
            let update = if !calls.is_empty() || st.replica.artifacts_stale(ledger) {
                st.replica.apply_artifacts(ledger, &calls, now)
            } else {
                tf_collab::Update::default()
            };
            st.pending.extend(update.events.iter().cloned());
            schedule_flush(&session, &mut st);
            (update.meta_changed, st.replica.replaying(now), changed_usage(&mut st))
        };
        if !calls.is_empty() {
            last_growth = Some(Instant::now());
        }
        observe_usage(&inner, &session.session_id, usage, now);
        // The board re-reads `Liveness.tps` on every change: keep it ticking while a reply replays.
        if changed || replaying || was_replaying {
            let _ = inner.updates.send(OmpUpdate::Changed { session_id: session.session_id.clone() });
        }
        was_replaying = replaying;
    }
}

/// Flushes now when the cadences allow (events every [`FLUSH_EVERY`], `meta` every
/// [`META_EVERY`]), else arms the flush timer for when they do.
fn schedule_flush(session: &Arc<OmpSession>, st: &mut SessionState) {
    let Some(mut at) = st.next_flush() else { return };
    if at <= Instant::now() {
        flush_locked(st);
        // A `meta` owed but not allowed yet waits for its turn.
        let Some(next) = st.next_flush() else { return };
        at = next;
    }
    arm_flush(session, st, at);
}

/// One flush timer per session: a later one is not armed while an earlier one waits (its flush
/// re-arms for whatever is still due).
fn arm_flush(session: &Arc<OmpSession>, st: &mut SessionState, at: Instant) {
    if st.flush_at.is_some_and(|t| t <= at) {
        return;
    }
    st.flush_at = Some(at);
    let s = session.clone();
    tokio::spawn(async move {
        tokio::time::sleep_until(at.into()).await;
        let mut st = s.lock();
        if st.flush_at == Some(at) {
            st.flush_at = None;
        }
        schedule_flush(&s, &mut st);
    });
}

pub fn guest_err(e: tf_collab::GuestError) -> ApiError {
    ApiError::new("not_connected", format!("collab: {e}")).retryable()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tf_proto::session::{AppendField, NoticeItem, NoticeLevel, TranscriptItem};

    fn app(id: &str, t: &str) -> SessionEvent {
        SessionEvent::Append { id: id.into(), field: AppendField::Text, text: t.into(), at: None }
    }

    #[test]
    fn coalesce_merges_appends_per_row() {
        let notice = TranscriptItem::Notice(NoticeItem {
            id: "n1".into(),
            at: 0,
            level: NoticeLevel::Info,
            text: "x".into(),
            source: None,
        });
        let (out, meta) = coalesce(vec![
            app("a", "he"),
            app("b", "1"),
            app("a", "llo"),
            SessionEvent::Upsert { item: notice, h: None },
            app("a", "!"),
            app("b", "2"),
        ]);
        assert_eq!(out.len(), 3, "{out:?}");
        assert_eq!(out[0], app("a", "hello!"));
        assert_eq!(out[1], app("b", "12"));
        assert!(!meta);
    }

    #[test]
    fn coalesce_respects_upsert_of_same_row() {
        let item = TranscriptItem::Notice(NoticeItem {
            id: "a".into(),
            at: 0,
            level: NoticeLevel::Info,
            text: "x".into(),
            source: None,
        });
        let (out, _) = coalesce(vec![app("a", "1"), SessionEvent::Upsert { item, h: None }, app("a", "2")]);
        assert_eq!(out.len(), 3);
    }

    fn meta_ev() -> SessionEvent {
        SessionEvent::Meta { meta: Replica::new("s").meta().clone() }
    }

    fn state_with(subs: &[(&ClientHandle, bool)]) -> SessionState {
        SessionState {
            replica: Replica::new("s"),
            link: LinkState::Live,
            link_error: None,
            pending: Vec::new(),
            last_flush: Instant::now(),
            flush_at: None,
            subs: subs.iter().map(|(c, keeps)| Sub { client: (*c).clone(), agent_id: "a".into(), tree_on_change: *keeps }).collect(),
            last_cost: None,
            first_prompt: None,
            overlay: MetaOverlay::default(),
            tree: None,
            tree_for: None,
            tree_rev: 0,
            tree_sent: 0,
            meta_due: false,
            meta_sent_at: None,
        }
    }

    fn client(id: &str, version: &str) -> ClientHandle {
        let info = tf_proto::host::ClientInfo { app: "teleflock-desktop".into(), version: version.into(), platform: "linux".into(), device: "d".into(), features: None };
        ClientHandle::new(id.into(), info)
    }

    /// Session events queued for `c`: (kind, whether its meta carried a tree).
    fn sent(c: &ClientHandle) -> Vec<(String, bool)> {
        let mut lines = Vec::new();
        c.take_batch(&mut lines);
        lines
            .iter()
            .map(|l| {
                let v: serde_json::Value = serde_json::from_str(l).unwrap();
                let ev = &v["ev"];
                let meta = if ev["k"] == "reset" { &ev["snapshot"]["meta"] } else { &ev["meta"] };
                (ev["k"].as_str().unwrap_or_default().to_string(), meta.get("tree").is_some())
            })
            .collect()
    }

    fn tree(leaf: &str) -> TreeInfo {
        TreeInfo { nodes: Vec::new(), leaf_id: Some(leaf.into()) }
    }

    #[test]
    fn apps_from_0_5_1_keep_their_tree() {
        for (v, keeps) in [("0.5.0", false), ("0.0.0", false), ("dev", false), ("0.5.1-rc.1", true), ("0.5.1", true), ("0.6.0", true)] {
            assert_eq!(keeps_tree(v), keeps, "{v}");
        }
    }

    #[test]
    fn metas_fold_into_the_latest_and_go_out_at_most_twice_a_second() {
        let (old, new) = (client("old", "0.5.0"), client("new", "0.5.1"));
        let mut st = state_with(&[(&old, false), (&new, true)]);
        st.tree = Some(tree("l1"));
        st.tree_rev = 1;
        let upsert = SessionEvent::Upsert {
            item: TranscriptItem::Notice(NoticeItem { id: "n".into(), at: 0, level: NoticeLevel::Info, text: "x".into(), source: None }),
            h: None,
        };

        // Three metas in one flush: one meta, after the other events; the new tree for everyone.
        st.pending = vec![meta_ev(), upsert.clone(), meta_ev(), meta_ev()];
        flush_locked(&mut st);
        let both = vec![("upsert".to_string(), false), ("meta".to_string(), true)];
        assert_eq!((sent(&old), sent(&new)), (both.clone(), both));

        // Another one right away is owed, timed for META_EVERY after the last.
        st.pending = vec![upsert.clone(), meta_ev()];
        flush_locked(&mut st);
        assert_eq!(sent(&old), vec![("upsert".to_string(), false)]);
        assert!(st.meta_due);
        let sent_at = st.meta_sent_at.unwrap();
        assert_eq!(st.next_flush(), Some(sent_at + META_EVERY));

        // Its turn: the tree did not change, so only the app that would drop it gets it again.
        st.meta_sent_at = sent_at.checked_sub(META_EVERY);
        flush_locked(&mut st);
        assert_eq!(sent(&old), vec![("meta".to_string(), true)]);
        assert_eq!(sent(&new), vec![("upsert".to_string(), false), ("meta".to_string(), false)]);
        assert!(!st.meta_due);
        assert_eq!(st.next_flush(), None);

        // A new tree reaches everyone; a reset carries it too, so the meta after it needn't.
        st.tree = Some(tree("l2"));
        st.tree_rev += 1;
        st.meta_due = true;
        st.meta_sent_at = None;
        flush_locked(&mut st);
        assert_eq!((sent(&old), sent(&new)), (vec![("meta".to_string(), true)], vec![("meta".to_string(), true)]));
        st.tree = Some(tree("l3"));
        st.tree_rev += 1;
        st.pending = vec![SessionEvent::Reset { snapshot: st.replica.snapshot(10) }, meta_ev()];
        st.meta_sent_at = None;
        flush_locked(&mut st);
        assert_eq!(sent(&new), vec![("reset".to_string(), true), ("meta".to_string(), false)]);
        assert_eq!(sent(&old), vec![("reset".to_string(), true), ("meta".to_string(), true)]);

        // Nobody subscribed: nothing is owed (a `session.open` starts from a snapshot).
        st.subs.clear();
        st.pending = vec![meta_ev()];
        flush_locked(&mut st);
        assert!(!st.meta_due);
    }

    #[test]
    fn loopback_ports() {
        assert_eq!(loopback_port("ws://127.0.0.1:47466/r/abc"), Some(47466));
        assert_eq!(loopback_port("ws://localhost:7466"), Some(7466));
        assert_eq!(loopback_port("wss://relay.example.com:443/r/x"), None);
        assert_eq!(loopback_port("ws://[::1]:5/r"), Some(5));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn joins_only_after_own_relay_proves_identity() {
        let ours = Relay::start(RelayConfig::new(0)).await.unwrap();
        let foreign = Relay::start(RelayConfig::new(0)).await.unwrap();
        let port = ours.port();
        let url = format!("ws://127.0.0.1:{port}/r/TfRelayJoinRoom000001");

        let own = Some((ours.identity(), ours.local_addr()));
        assert_eq!(verify_room_relay(own, port, &url).await.unwrap(), format!("ws://127.0.0.1:{port}"));
        let localhost = format!("ws://localhost:{port}/r/TfRelayJoinRoom000001");
        assert_eq!(verify_room_relay(Some((ours.identity(), ours.local_addr())), port, &localhost).await.unwrap(), ours.url());

        // The socket answering on our port is someone else's relay (different secret): final.
        let err = verify_room_relay(Some((ours.identity(), foreign.local_addr())), port, &url).await.unwrap_err();
        assert!(err.msg.contains("identity check"), "{}", err.msg);
        assert_eq!(err.kind, FailKind::Hard);

        // Our relay is not running (another process may hold the port): never join, but retry.
        let err = verify_room_relay(None, port, &url).await.unwrap_err();
        assert!(err.msg.contains(&format!("127.0.0.1:{port}")) && err.msg.contains("not running"), "{}", err.msg);
        assert_eq!(err.kind, FailKind::Transient);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bind_failure_is_a_setup_issue() {
        // A port below Linux's ephemeral range (32768–60999): parallel tests that bind
        // `127.0.0.1:0` can never be handed it after the squatter frees it.
        let (squatter, port) = (20_000 + (std::process::id() % 10_000) as u16..32_000)
            .find_map(|p| std::net::TcpListener::bind(("127.0.0.1", p)).ok().map(|l| (l, p)))
            .expect("a free non-ephemeral port");
        let dir = std::env::temp_dir().join(format!("tf-hostd-relay-bind-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let persist = Persist::load(dir.join("state.json"));
        // Pre-cancelled: only the initial relay bind runs, no registry polling.
        let cancel = CancellationToken::new();
        cancel.cancel();
        let omp = OmpHandle::start(port, persist, cancel).await;

        assert!(!omp.relay_listening());
        let issue = omp.relay_issue().expect("relay issue");
        assert_eq!(issue.id, ISSUE_RELAY_PORT_IN_USE);
        assert_eq!(issue.severity, Severity::Error);
        assert!(!issue.fixable);
        assert!(issue.detail.contains(&format!("127.0.0.1:{port}")) && issue.detail.contains("another process"), "{}", issue.detail);

        // Port freed → the next attempt binds and the issue clears. Parallel tests that
        // fork children (git, gh, …) can hold a duplicate of the squatter's fd for the
        // instant between fork and exec, so allow a few attempts.
        drop(squatter);
        let started = std::time::Instant::now();
        let mut bound = false;
        while !bound && started.elapsed() < Duration::from_secs(3) {
            bound = omp.try_start_relay().await;
            if !bound {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
        assert!(bound, "rebind failed for 3 s: {:?}", omp.relay_issue());
        assert!(omp.relay_listening());
        assert_eq!(omp.relay_issue(), None);
        omp.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn relay_issue_kinds() {
        assert_eq!(relay_issue(1, true, Some(&RelayDown::PortInUse)), None);
        let other = relay_issue(7, false, Some(&RelayDown::Other("permission denied".into()))).unwrap();
        assert_eq!(other.id, ISSUE_RELAY_DOWN);
        assert!(other.detail.contains("permission denied"));
        assert_eq!(relay_issue(7, false, None).unwrap().id, ISSUE_RELAY_DOWN);
    }

    #[test]
    fn join_backoff_doubles_to_a_minute() {
        for (streak, base) in [(1u32, 2u64), (2, 4), (3, 8), (4, 16), (5, 32), (6, 60), (9, 60)] {
            let d = join_backoff(streak).as_millis() as u64;
            assert!(d >= base * 750 && d <= base * 1250, "streak {streak}: {d} ms");
        }
    }

    fn failed(kind: FailKind) -> JoinError {
        JoinError { msg: "boom".into(), kind, room_id: Some("room-1".into()) }
    }

    #[test]
    fn join_failures_stay_connecting_and_reset_after_repeated_timeouts() {
        let now = Instant::now();
        let mut f = JoinFailure::new(1, now);
        assert!(!f.record(&failed(FailKind::Transient), now));
        assert_eq!(f.link(), (LinkState::Connecting, Some("join attempt 1 failed: boom; retrying".into())));
        assert!(f.retry_at > now);
        // A first timeout: the next join waits twice as long, the room is left alone.
        assert!(!f.record(&failed(FailKind::TimedOut), now));
        assert_eq!(JoinTimeouts::escalated(f.timeouts).welcome, Duration::from_secs(60));
        // The second one resets the room before the next try, which waits longer still.
        assert!(f.record(&failed(FailKind::TimedOut), now));
        assert_eq!(f.room.as_deref(), Some("room-1"));
        assert_eq!(f.link().0, LinkState::Connecting);
        assert_eq!(JoinTimeouts::escalated(f.timeouts).welcome, Duration::from_secs(120));
        // Only what retrying cannot fix leaves `connecting`.
        f.record(&failed(FailKind::Hard), now);
        assert_eq!(f.link(), (LinkState::Error, Some("boom".into())));
        f.record(&failed(FailKind::Unsupported), now);
        assert_eq!(f.link().0, LinkState::Unsupported);
    }

    #[test]
    fn overlay_cmdline() {
        assert!(overlay_in_cmdline(b"omp\0--config\0/home/u/.teleflock/omp-overlay.yml\0-e\0/x.ts\0"));
        assert!(overlay_in_cmdline(b"/usr/bin/bun\0omp\0--config=/tmp/lab/omp-overlay.yml\0"));
        assert!(!overlay_in_cmdline(b"omp\0--config\0/home/u/other.yml\0"));
        assert!(!overlay_in_cmdline(b"omp\0--resume=/s.jsonl\0omp-overlay.yml\0"));
        assert!(!overlay_in_cmdline(b"omp\0--config\0"));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test(flavor = "multi_thread")]
    async fn link_states_without_a_guest() {
        let dir = std::env::temp_dir().join(format!("tf-hostd-link-states-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let omp = OmpHandle::start(0, Persist::load(dir.join("state.json")), cancel).await;

        // Started like TeleFlock starts omp (`--config …/omp-overlay.yml`), no room yet.
        let mut child = std::process::Command::new("sh")
            .args(["-c", "sleep 30; :", "omp", "--config", "/tmp/lab/omp-overlay.yml"])
            .spawn()
            .unwrap();
        let pid = child.id();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !launched_with_overlay(pid) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let starting = (LinkState::Connecting, Some("omp is starting; waiting for its collab room".to_string()));
        assert_eq!(omp.link_without_guest(None, &[pid], false), starting);
        // Without the overlay it is not shared, unless omp's global config shares every session.
        let me = std::process::id();
        assert_eq!(omp.link_without_guest(None, &[me], false), (LinkState::NotShared, None));
        assert_eq!(omp.link_without_guest(None, &[me], true), starting);
        // Still no room after the wait: not shared after all.
        for (first, _) in omp.inner.reg.lock().unwrap().awaiting.values_mut() {
            *first = first.checked_sub(ROOM_WAIT).unwrap();
        }
        let (state, err) = omp.link_without_guest(None, &[pid], false);
        assert_eq!(state, LinkState::NotShared);
        assert!(err.unwrap().contains("has not opened a collab room"));
        let _ = child.kill();
        let _ = child.wait();

        // A published room whose joins keep failing stays `connecting`, with the reason.
        let row: HostEntry = serde_json::from_value(serde_json::json!({
            "instanceId": "i1", "generation": 1, "pid": 7, "sessionId": "s1", "relayConnected": true, "access": "control"
        }))
        .unwrap();
        {
            let mut reg = omp.inner.reg.lock().unwrap();
            reg.rows.push(row);
            let mut f = JoinFailure::new(1, Instant::now());
            f.record(&failed(FailKind::TimedOut), Instant::now());
            reg.failures.insert("i1".into(), f);
        }
        assert_eq!(omp.link_without_guest(Some("s1"), &[], false), (LinkState::Connecting, Some("join attempt 1 failed: boom; retrying".into())));
        // A new room generation starts over.
        omp.inner.reg.lock().unwrap().rows[0].generation = 2;
        assert_eq!(omp.link_without_guest(Some("s1"), &[], false), (LinkState::Connecting, None));
        omp.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
