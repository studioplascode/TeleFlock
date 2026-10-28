//! omp data plane (architecture §3.4 `omp.rs`): one session replica per omp session, served by
//! TeleFlock's bridge (≥ 2.0: live frames + the session file, see [`crate::feed`]) or, for
//! sessions without one, by a `tf_collab::Guest` in omp's collab room on the embedded relay.
//!
//! Shared by every herdr session of the daemon. Session events are delivered to
//! subscribed clients directly from here (ordered with the snapshot under one lock,
//! coalesced to one flush per 50 ms); board-level changes are announced on a
//! broadcast channel that each state store consumes.
//!
//! Link lifecycle (architecture §3.4): a bridge that announces `caps.live` serves its session and
//! no room of it is joined; when it goes away the replica stays (`connecting`, `bridgeLost`) and a
//! published room takes over only if the bridge is not back within [`BRIDGE_RETURN`]. Rooms of
//! sessions without such a bridge are joined; a failed join is retried with backoff (2 s doubling
//! to 60 s) for as long as the room is published, with join timeouts that grow after each timeout
//! ([`JoinTimeouts::escalated`]) and a room reset once joins keep timing out
//! ([`RESET_AFTER_TIMEOUTS`]). Only failures retrying cannot fix show as `error` /
//! `unsupported`; everything else stays `connecting` with the precise reason (`linkReason`) and
//! the last failure as `linkError`.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::time::Duration;

use tokio::sync::{broadcast, Notify};
// Every timer here runs on tokio's clock, so tests can pause it (bridge return, join grace).
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

use tf_collab::{
    Access, AgentCmdKind, EndReason, Guest, GuestError, GuestEvent, HostEntry, ImageContent, JoinTimeouts, Registry,
    RegistryError, Relay, RelayConfig, RelayIdentity, Replica, Signal, UiReply,
};
use tf_proto::methods::Delivery;
use tf_proto::session::{AppendField, HistoryPage, SessionEvent, SessionHave, SessionMeta, SessionSnapshot, TreeInfo, UiRequest};
use tf_proto::model::{
    Answer, ContextUsage, CostInfo, DiffStat, GoalInfo, LinkReason, LinkState, LinkVia, Liveness, ModelRef, NeedsYou, OmpMode,
    PulseKind, QueueInfo, SetupIssue, Severity, SubagentSummary, ThinkingLevel, TodoSummary, UsageTotals,
};
use tf_proto::{ApiError, Millis};

use crate::bridge::{BridgeCaps, BridgeHandle};
use crate::clients::ClientHandle;
use crate::sync::Fanout;
use crate::state::persist::Persist;
use crate::util::{local_day, now_ms};

/// Display name of TeleFlock's guest in omp rooms.
pub const GUEST_NAME: &str = "TeleFlock";
/// One flush of session events per 50 ms (architecture §3.3).
const FLUSH_EVERY: Duration = Duration::from_millis(50);
/// At most one `meta` event per session this often; the latest state always goes out, the ones
/// in between are folded into it.
const META_EVERY: Duration = Duration::from_millis(500);
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
/// A session whose bridge (≥ 2.0) went away keeps its replica and waits this long for it to come
/// back (an extension reload, a hostd restart) before a published collab room takes over.
pub const BRIDGE_RETURN: Duration = Duration::from_secs(10);
/// A room is joined only once it was listed this long, unless the bridge of its omp process is
/// known to lack the data plane: bridges reconnect within 5 s of a hostd restart, and a room
/// whose session the bridge serves must not be joined (a join makes omp serialize the session).
const JOIN_GRACE: Duration = Duration::from_secs(8);
/// A session whose bridge is gone, with no room to fall back to, is dropped once its omp process
/// is gone (Linux), or after this long elsewhere.
pub(crate) const DETACHED_FORGET: Duration = Duration::from_secs(600);

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
    pub link_reason: Option<LinkReason>,
    pub link_via: Option<LinkVia>,
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

pub(crate) struct SessionState {
    pub(crate) replica: Replica,
    pub(crate) link: LinkState,
    pub(crate) link_error: Option<String>,
    /// Why the link is in its state (`OmpInfo.linkReason`; `None` while live on its normal path).
    pub(crate) link_reason: Option<LinkReason>,
    /// What serves (or is being brought up for) the session.
    pub(crate) link_via: Option<LinkVia>,
    /// The bridge feed or collab guest feeding the replica.
    pub(crate) transport: Transport,
    /// The bridge that served the session went away at this time (collab may take over after
    /// [`BRIDGE_RETURN`]); `bye`: omp said it was shutting down.
    pub(crate) bridge_lost: Option<(Instant, bool)>,
    /// The bridge feed driver running for the session: `(connection, token)` ([`crate::feed`]).
    pub(crate) driver: Option<(u64, u64)>,
    /// omp's session file, as the bridge named it (subagent transcripts live next to it).
    pub(crate) session_file: Option<std::path::PathBuf>,
    pending: Vec<SessionEvent>,
    last_flush: Instant,
    /// When the armed flush timer fires (one at a time, see [`arm_flush`]).
    flush_at: Option<Instant>,
    /// Clients subscribed to the session (`session.open`), and what each was sent.
    fanout: Fanout,
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
    pub(crate) fn new(replica: Replica) -> SessionState {
        SessionState {
            replica,
            link: LinkState::Connecting,
            link_error: None,
            link_reason: None,
            link_via: None,
            transport: Transport::Detached,
            bridge_lost: None,
            driver: None,
            session_file: None,
            pending: Vec::new(),
            last_flush: Instant::now(),
            flush_at: None,
            fanout: Fanout::default(),
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

    /// When pending events or an owed `meta` are next due (`None`: nothing to send).
    fn next_flush(&self) -> Option<Instant> {
        let events = (!self.pending.is_empty()).then(|| self.last_flush + FLUSH_EVERY);
        let meta = self.meta_due.then(|| self.meta_sent_at.map_or(self.last_flush, |t| t + META_EVERY));
        events.into_iter().chain(meta).min()
    }

    pub(crate) fn link_status(&self) -> LinkStatus {
        LinkStatus { state: self.link, reason: self.link_reason, via: self.link_via, error: self.link_error.clone() }
    }

    /// Sets the link; `true` when anything the board shows changed.
    pub(crate) fn set_link(&mut self, link: LinkStatus) -> bool {
        if self.link_status() == link {
            return false;
        }
        self.link = link.state;
        self.link_reason = link.reason;
        self.link_via = link.via;
        self.link_error = link.error;
        true
    }
}

/// What feeds a session's replica right now.
pub(crate) enum Transport {
    /// Nothing (yet, or any more): the bridge is being brought up, or it went away.
    Detached,
    /// A guest in omp's collab room.
    Collab(CollabRoom),
    /// TeleFlock's bridge: its live feed plus the session file ([`crate::feed`]); `token` tells
    /// its driver from a later one, `caps` what the bridge's data plane can do.
    Bridge { token: u64, caps: BridgeCaps },
}

pub(crate) struct CollabRoom {
    pub(crate) guest: Guest,
    pub(crate) instance_id: String,
    pub(crate) generation: u64,
    /// Relay room id (for a room reset when reconnects keep timing out).
    pub(crate) room_id: String,
    /// Tells this guest's pump from a later one.
    pub(crate) token: u64,
}

/// A process-unique id for a transport (a guest's pump, a bridge feed driver).
pub(crate) fn next_token() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// A session's link as the board shows it (`OmpInfo.link`, `linkReason`, `linkVia`, `linkError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkStatus {
    pub state: LinkState,
    pub reason: Option<LinkReason>,
    pub via: Option<LinkVia>,
    pub error: Option<String>,
}

impl LinkStatus {
    pub fn new(state: LinkState, reason: Option<LinkReason>, via: Option<LinkVia>, error: Option<String>) -> LinkStatus {
        LinkStatus { state, reason, via, error }
    }

    pub fn live(via: LinkVia) -> LinkStatus {
        Self::new(LinkState::Live, None, Some(via), None)
    }

    pub fn connecting(reason: LinkReason, via: Option<LinkVia>, error: impl Into<String>) -> LinkStatus {
        Self::new(LinkState::Connecting, Some(reason), via, Some(error.into()))
    }

    pub fn not_shared(reason: LinkReason, error: impl Into<String>) -> LinkStatus {
        Self::new(LinkState::NotShared, Some(reason), None, Some(error.into()))
    }
}

/// One omp session: its replica, subscribers and link, fed by a bridge or a collab guest.
pub struct OmpSession {
    pub session_id: String,
    /// The omp process (a bridge `hello` or the room's registry row).
    pid: AtomicU32,
    st: Mutex<SessionState>,
    closed: AtomicBool,
    /// Wakes the collab journal reader (turn boundaries, prompts, snapshots).
    journal_kick: Notify,
    /// Wakes the bridge feed driver: subscribe again now (`agent.connect`, a new connection).
    pub(crate) feed_kick: Notify,
    pub(crate) bridge: BridgeHandle,
}

/// What carries a session's controls right now ([`OmpSession::route`]).
enum Route {
    Bridge(BridgeCaps),
    Collab(Guest),
}

impl OmpSession {
    /// A session nothing feeds yet; [`crate::feed::attach`] or [`join`] gives it its transport.
    pub(crate) fn new(session_id: &str, pid: u32, persist: &Persist, bridge: BridgeHandle) -> OmpSession {
        let mut replica = Replica::new(session_id.to_owned());
        for (id, slots) in persist.read(|d| d.originals.get(session_id).cloned()).unwrap_or_default() {
            replica.keep_originals(&id, slots);
        }
        OmpSession {
            session_id: session_id.to_owned(),
            pid: AtomicU32::new(pid),
            st: Mutex::new(SessionState::new(replica)),
            closed: AtomicBool::new(false),
            journal_kick: Notify::new(),
            feed_kick: Notify::new(),
            bridge,
        }
    }

    pub(crate) fn lock(&self) -> std::sync::MutexGuard<'_, SessionState> {
        self.st.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn pid(&self) -> u32 {
        self.pid.load(Ordering::Relaxed)
    }

    pub(crate) fn set_pid(&self, pid: u32) {
        self.pid.store(pid, Ordering::Relaxed);
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Subscribes `client` (as `agent_id`) and returns the snapshot the live events continue
    /// from: the newest `limit` rows, or what the client lacks of them when it speaks
    /// `sessionSync` and says what it holds (`have`, see [`crate::sync`]).
    pub fn subscribe(&self, client: &ClientHandle, agent_id: &str, limit: usize, have: Option<&SessionHave>) -> SessionSnapshot {
        let mut st = self.lock();
        flush_locked(&mut st);
        let mut snap = st.replica.snapshot(limit);
        st.overlay.apply(&mut snap.meta, st.link == LinkState::Live);
        snap.meta.tree = st.tree.clone();
        st.fanout.subscribe(client, agent_id, snap, have, &self.session_id)
    }

    pub fn unsubscribe(&self, client_id: &str, agent_id: &str) {
        self.lock().fanout.unsubscribe(client_id, agent_id);
    }

    pub fn unsubscribe_client(&self, client_id: &str) {
        self.lock().fanout.unsubscribe_client(client_id);
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

    /// Replaces the bridge overlay (its `data_plane` stays the session's); subscribers get a
    /// `meta` event when it changed.
    pub fn set_overlay(self: &Arc<Self>, mut overlay: MetaOverlay) {
        let mut st = self.lock();
        overlay.data_plane = st.overlay.data_plane;
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

    pub fn link_status(&self) -> LinkStatus {
        self.lock().link_status()
    }

    /// What serves the session (`None` while nothing does).
    pub fn via(&self) -> Option<LinkVia> {
        match self.lock().transport {
            Transport::Bridge { .. } => Some(LinkVia::Bridge),
            Transport::Collab(_) => Some(LinkVia::Collab),
            Transport::Detached => None,
        }
    }

    /// The collab guest feeding the session, when one does.
    pub(crate) fn guest(&self) -> Option<Guest> {
        match &self.lock().transport {
            Transport::Collab(r) => Some(r.guest.clone()),
            _ => None,
        }
    }

    /// The path controls take: the bridge when its live feed serves the session, else the
    /// collab guest. Fails (retryably, with the link's reason) while neither is live.
    fn route(&self) -> Result<Route, ApiError> {
        let st = self.lock();
        match &st.transport {
            Transport::Bridge { caps, .. } if st.link == LinkState::Live => Ok(Route::Bridge(*caps)),
            Transport::Collab(r) if st.link == LinkState::Live => Ok(Route::Collab(r.guest.clone())),
            _ => Err(ApiError::new("not_connected", st.link_error.clone().unwrap_or_else(|| "reconnecting to the session".into()))
                .retryable()),
        }
    }

    /// Prompts the session (text and images): through the bridge with `delivery`, else as a collab
    /// guest (which always steers while omp streams; follow-ups go through the caller's v1 path).
    pub async fn prompt(&self, text: &str, images: Vec<ImageContent>, delivery: Delivery) -> Result<(), ApiError> {
        match self.route()? {
            Route::Bridge(caps) if caps.prompt => {
                self.bridge.prompt(&self.session_id, text, &images, delivery).await.map(drop).map_err(ApiError::from)
            }
            Route::Bridge(_) => Err(ApiError::new("unsupported", "this omp's TeleFlock bridge cannot send prompts")
                .with_hint("Restart the agent so it loads the current bridge.")),
            Route::Collab(guest) => guest.prompt(text.to_owned(), images).map_err(guest_err),
        }
    }

    /// Whether prompts take a follow-up delivery (and images with it) on the current path.
    pub fn follow_up_prompts(&self) -> bool {
        matches!(self.route(), Ok(Route::Bridge(caps)) if caps.prompt)
    }

    /// Aborts the running turn.
    pub async fn abort(&self) -> Result<(), ApiError> {
        match self.route()? {
            Route::Bridge(_) => self.bridge.abort(&self.session_id).await.map_err(ApiError::from),
            Route::Collab(guest) => guest.abort().map_err(guest_err),
        }
    }

    /// Maps an `Answer` to exact ui-response values and sends them.
    pub async fn answer(&self, request_id: &str, answer: &Answer) -> Result<(), ApiError> {
        if let Route::Bridge(caps) = self.route()?
            && !caps.dialogs
        {
            return Err(ApiError::new("unsupported", "this omp cannot take answers from TeleFlock (its bridge has no dialog support)")
                .with_hint("Answer in the terminal."));
        }
        let replies = self.lock().replica.answer(request_id, answer)?;
        self.send_replies(replies).await
    }

    /// Sends ui-responses (an answer, or the replica's own follow-ups such as multi-select loops).
    pub(crate) async fn send_replies(&self, replies: Vec<UiReply>) -> Result<(), ApiError> {
        for r in replies {
            match self.route()? {
                Route::Bridge(_) => {
                    self.bridge.ui_response(&self.session_id, r.req_id, r.value.as_deref()).await.map_err(ApiError::from)?
                }
                Route::Collab(guest) => guest.ui_response(r.req_id, r.value).map_err(guest_err)?,
            }
        }
        Ok(())
    }

    /// Subagent control: chat (steer, or revive a parked one), kill, revive.
    pub async fn agent_cmd(&self, cmd: AgentCmdKind, agent_id: &str, text: Option<String>) -> Result<(), ApiError> {
        match self.route()? {
            Route::Bridge(caps) if caps.subagent_ctl => {
                self.bridge.agent_cmd(&self.session_id, cmd, agent_id, text.as_deref()).await.map_err(ApiError::from)
            }
            Route::Bridge(_) => Err(ApiError::new("unsupported", "this omp cannot control subagents from TeleFlock (its bridge lacks omp's agent registry)")
                .with_hint("Use the terminal (omp's Agent Hub).")),
            Route::Collab(guest) => guest.agent_cmd(cmd, agent_id, text).map_err(guest_err),
        }
    }

    /// A subagent's transcript as rows: read from its file for bridge-backed sessions, fetched
    /// from omp for collab ones.
    pub async fn transcript(&self, agent_id: &str) -> Result<HistoryPage, ApiError> {
        match self.route()? {
            Route::Bridge(_) => {
                let (named, main) = {
                    let st = self.lock();
                    (st.replica.agent_session_file(agent_id).map(std::path::PathBuf::from), st.session_file.clone())
                };
                let id = agent_id.to_owned();
                tokio::task::spawn_blocking(move || crate::feed::subagent_transcript(named.as_deref(), main.as_deref(), &id))
                    .await
                    .map_err(|e| ApiError::new("internal", e.to_string()))?
            }
            Route::Collab(guest) => {
                let mut text = String::new();
                let mut from = 0u64;
                // Pull the whole transcript (chunked by the host at line boundaries).
                for _ in 0..64 {
                    let chunk = guest.fetch_transcript(agent_id, from).await.map_err(guest_err)?;
                    if let Some(err) = chunk.error {
                        return Err(ApiError::new("omp_error", format!("transcript: {err}")));
                    }
                    let done = chunk.text.is_empty() || chunk.new_size <= from;
                    text.push_str(&chunk.text);
                    from = chunk.new_size;
                    if done {
                        break;
                    }
                }
                Ok(tf_collab::replica::transcript_page(&text))
            }
        }
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
            pid: self.pid(),
            link: st.link,
            link_error: st.link_error.clone(),
            link_reason: st.link_reason,
            link_via: st.link_via,
            meta: st.overlay.board(st.replica.meta()),
            live: st.replica.liveness(now),
            needs: st.replica.needs(),
            streaming: st.replica.is_streaming(),
            first_prompt: st.first_prompt.clone(),
            turn_active: st.replica.turn_started_at().is_some(),
        }
    }

    /// Folds a replica update into the session (under its lock): events for the subscribers,
    /// the first prompt. Returns the new session total when it changed (for the usage ledger).
    pub(crate) fn absorb(self: &Arc<Self>, st: &mut SessionState, update: &tf_collab::Update) -> Option<CostInfo> {
        st.pending.extend(update.events.iter().cloned());
        schedule_flush(self, st);
        if st.first_prompt.is_none() {
            st.first_prompt = first_prompt_in(&update.events);
        }
        changed_usage(st)
    }

    /// The bridge (or no data plane) now serves the session: the meta caps follow.
    pub(crate) fn set_data_plane(self: &Arc<Self>, st: &mut SessionState, caps: Option<BridgeCaps>) {
        if st.overlay.data_plane != caps {
            st.overlay.data_plane = caps;
            emit_meta(self, st);
        }
    }

    /// Ends the session for its subscribers (`ended` event) and leaves its room.
    pub(crate) fn end(&self, reason: &str) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut st = self.lock();
        st.pending.push(SessionEvent::Ended { reason: reason.to_string() });
        flush_locked(&mut st);
        st.fanout.clear();
        let transport = std::mem::replace(&mut st.transport, Transport::Detached);
        drop(st);
        if let Transport::Collab(room) = transport {
            room.guest.close();
        }
        self.feed_kick.notify_one();
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
    /// The bridge's data-plane features while its live feed serves the session (`None`: a collab
    /// guest serves it, or nothing). Kept by the session itself, not by [`OmpSession::set_overlay`].
    pub data_plane: Option<BridgeCaps>,
}

impl MetaOverlay {
    pub fn apply(&self, meta: &mut SessionMeta, live: bool) {
        meta.caps = crate::state::build::capabilities(live, self.bridge, self.data_plane);
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
    st.fanout.prune();
    let (mut events, meta_changed) = coalesce(std::mem::take(&mut st.pending));
    st.meta_due |= meta_changed;
    if st.fanout.is_empty() {
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
    let replica = &st.replica;
    let field_len = |id: &str, field: AppendField| replica.item(id).and_then(|i| crate::sync::field_len(i, field));
    st.fanout.send_events(&events, &field_len);
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
    // Plain subscribers of apps that keep their tree get it only when it changed; older ones in
    // every meta; `sessionSync` ones as a patch when it changed.
    let tree_changed = st.tree_rev != st.tree_sent;
    st.tree_sent = st.tree_rev;
    st.fanout.send_meta(&meta, st.tree.as_ref(), tree_changed);
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
    /// (instance, generation) → when a poll first listed the room ([`JOIN_GRACE`]).
    first_seen: HashMap<(String, u64), Instant>,
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

    fn link(&self) -> LinkStatus {
        match self.kind {
            FailKind::Unsupported => LinkStatus::new(LinkState::Unsupported, None, Some(LinkVia::Collab), Some(self.error.clone())),
            FailKind::Hard => LinkStatus::new(LinkState::Error, None, Some(LinkVia::Collab), Some(self.error.clone())),
            FailKind::Transient | FailKind::TimedOut => LinkStatus::connecting(
                LinkReason::JoinFailed,
                Some(LinkVia::Collab),
                format!("join attempt {} failed: {}; retrying", self.streak, self.error),
            ),
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

pub(crate) struct Inner {
    relay_port: u16,
    relay: tokio::sync::Mutex<Option<Relay>>,
    relay_ok: AtomicBool,
    /// Last bind failure while the relay is down.
    relay_down: Mutex<Option<RelayDown>>,
    registry: Registry,
    reg: Mutex<Registryish>,
    pub(crate) sessions: RwLock<HashMap<String, Arc<OmpSession>>>,
    pub(crate) updates: broadcast::Sender<OmpUpdate>,
    repoll: Notify,
    pub(crate) persist: Arc<Persist>,
    pub(crate) cancel: CancellationToken,
    /// The companion-extension server: bridges ≥ 2.0 serve their sessions ([`crate::feed`]).
    pub(crate) bridge: BridgeHandle,
}

impl Inner {
    pub(crate) fn session(&self, session_id: &str) -> Option<Arc<OmpSession>> {
        self.sessions.read().unwrap_or_else(|p| p.into_inner()).get(session_id).cloned()
    }

    /// Drops `session` from the map (unless a newer one took its id) and ends it.
    pub(crate) fn forget(&self, session: &Arc<OmpSession>, reason: &str) {
        {
            let mut map = self.sessions.write().unwrap_or_else(|p| p.into_inner());
            if map.get(&session.session_id).is_some_and(|s| Arc::ptr_eq(s, session)) {
                map.remove(&session.session_id);
            }
        }
        session.end(reason);
        let _ = self.updates.send(OmpUpdate::Registry);
    }

    /// The registry row of the newest room of `session_id`.
    pub(crate) fn room_of(&self, session_id: &str) -> Option<HostEntry> {
        let reg = self.reg.lock().unwrap_or_else(|p| p.into_inner());
        reg.rows.iter().filter(|r| r.session_id.as_deref() == Some(session_id)).max_by_key(|r| r.generation).cloned()
    }

    pub(crate) fn repoll(&self) {
        self.repoll.notify_one();
    }
}

/// Shared handle (cheap to clone).
#[derive(Clone)]
pub struct OmpHandle {
    inner: Arc<Inner>,
}

impl OmpHandle {
    /// Starts the relay (retrying in the background if the port is busy), the registry poller
    /// and the bridge data plane ([`crate::feed`]).
    pub async fn start(relay_port: u16, persist: Arc<Persist>, cancel: CancellationToken, bridge: BridgeHandle) -> Self {
        Self::start_with(relay_port, persist, cancel, bridge, Registry::new()).await
    }

    /// [`Self::start`] polling `registry` (tests: a registry dir of their own).
    pub(crate) async fn start_with(relay_port: u16, persist: Arc<Persist>, cancel: CancellationToken, bridge: BridgeHandle, registry: Registry) -> Self {
        let (updates, _) = broadcast::channel(4096);
        let events = bridge.subscribe();
        let inner = Arc::new(Inner {
            relay_port,
            relay: tokio::sync::Mutex::new(None),
            relay_ok: AtomicBool::new(false),
            relay_down: Mutex::new(None),
            registry,
            reg: Mutex::new(Registryish::default()),
            sessions: RwLock::new(HashMap::new()),
            updates,
            repoll: Notify::new(),
            persist,
            cancel,
            bridge,
        });
        let me = Self { inner };
        me.try_start_relay().await;
        tokio::spawn(relay_keeper(Arc::downgrade(&me.inner)));
        tokio::spawn(poll_loop(Arc::downgrade(&me.inner)));
        tokio::spawn(crate::feed::bridge_events(Arc::downgrade(&me.inner), events));
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

    /// `agent.connect` on a session that is still connecting: subscribe its bridge feed again, or
    /// retry its join (or its guest's reconnect) now instead of after the backoff, and reset the
    /// room first when its joins have been timing out.
    pub async fn retry_now(&self, session_id: &str) {
        let mut reset = None;
        if let Some(s) = self.session(session_id) {
            if s.link().0 != LinkState::Live {
                if let Some(guest) = s.guest() {
                    let _ = guest.resync();
                }
                s.feed_kick.notify_one();
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
        if let Some(b) = self.inner.bridge.by_session(session_id).filter(|b| b.caps.data_plane()) {
            crate::feed::attach(&self.inner, &b);
        }
        if let Some(room) = reset {
            reset_room(&self.inner, &room).await;
        }
        self.repoll();
    }

    pub fn session(&self, session_id: &str) -> Option<Arc<OmpSession>> {
        self.inner.session(session_id)
    }

    pub fn session_by_pid(&self, pid: u32) -> Option<Arc<OmpSession>> {
        self.inner.sessions.read().unwrap_or_else(|p| p.into_inner()).values().find(|s| s.pid() == pid).cloned()
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

    /// Link of an omp session no replica serves (yet). `pids` are the pane's foreground
    /// processes; `shares_by_default`: omp's global config shares every session on our relay.
    pub fn link_without_guest(&self, session_id: Option<&str>, pids: &[u32], shares_by_default: bool) -> LinkStatus {
        let bridge = &self.inner.bridge;
        let bridged = session_id.and_then(|sid| bridge.by_session(sid)).or_else(|| pids.iter().find_map(|p| bridge.by_pid(*p)));
        if bridged.as_ref().is_some_and(|b| b.caps.data_plane()) {
            return LinkStatus::connecting(LinkReason::Syncing, Some(LinkVia::Bridge), "TeleFlock's bridge in omp is connected; loading the session");
        }
        let port = self.inner.relay_port;
        let relay_down = !self.relay_listening();
        let mut reg = self.inner.reg.lock().unwrap_or_else(|p| p.into_inner());
        let row = session_id
            .and_then(|sid| reg.rows.iter().filter(|r| r.session_id.as_deref() == Some(sid)).max_by_key(|r| r.generation))
            .cloned();
        let Some(row) = row else {
            // No room yet. An omp that will share is still starting (minutes on a slow host).
            let now = Instant::now();
            reg.awaiting.retain(|_, (_, last)| now.duration_since(*last) < ROOM_WAIT);
            let Some(&pid) = pids.iter().find(|p| shares_by_default || launched_with_overlay(**p)) else {
                return LinkStatus::not_shared(
                    LinkReason::NoRoom,
                    "this omp session is not shared with TeleFlock: it has no collab room on the TeleFlock relay and no TeleFlock bridge 2.0",
                );
            };
            let (first, last) = reg.awaiting.entry(pid).or_insert((now, now));
            *last = now;
            return if relay_down {
                LinkStatus::connecting(LinkReason::RelayDown, Some(LinkVia::Collab), format!("the TeleFlock relay is not listening on 127.0.0.1:{port}, so omp cannot open its collab room"))
            } else if now.duration_since(*first) < ROOM_WAIT {
                LinkStatus::connecting(LinkReason::Starting, None, "omp is starting; waiting for its TeleFlock bridge or collab room")
            } else {
                LinkStatus::not_shared(LinkReason::NoRoom, "omp has not opened a collab room on the TeleFlock relay")
            };
        };
        if reg.foreign.contains(&(row.instance_id.clone(), row.generation)) {
            return LinkStatus::not_shared(LinkReason::SharedElsewhere, "omp shares this session on another relay, not on TeleFlock's");
        }
        if row.access != "control" {
            return LinkStatus::not_shared(
                LinkReason::ViewOnly,
                format!("omp's collab room for this session grants `{}` access; TeleFlock needs control", row.access),
            );
        }
        if relay_down {
            return LinkStatus::connecting(LinkReason::RelayDown, Some(LinkVia::Collab), format!("the TeleFlock relay is not listening on 127.0.0.1:{port}"));
        }
        if let Some(f) = reg.failures.get(&row.instance_id).filter(|f| f.generation == row.generation && f.streak > 0) {
            return f.link();
        }
        // Its omp's bridge may still say hello (omp starting, or tf-hostd restarted and the
        // bridge reconnecting): the room is not joined before JOIN_GRACE ([`poll_once`]).
        let listed = reg.first_seen.get(&(row.instance_id.clone(), row.generation)).copied();
        if bridged.is_none() && bridge.by_pid(row.pid).is_none() && listed.is_none_or(|t| t.elapsed() < JOIN_GRACE) {
            return LinkStatus::connecting(LinkReason::Starting, None, "waiting for TeleFlock's bridge in omp to connect before joining its collab room");
        }
        LinkStatus::connecting(LinkReason::Joining, Some(LinkVia::Collab), "joining omp's collab room")
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
    crate::feed::reconcile(inner);
    let rows = match inner.registry.poll().await {
        Ok(rows) => rows,
        Err(e) => {
            debug!("registry poll: {e}");
            return;
        }
    };
    // What the sessions are fed by, read before the registry lock (sessions lock first).
    let mut joined: HashSet<(String, u64)> = HashSet::new();
    // Sessions the bridge serves, brings up or may get back within BRIDGE_RETURN: never joined.
    let mut held: HashSet<String> = HashSet::new();
    for s in inner.sessions.read().unwrap_or_else(|p| p.into_inner()).values() {
        let st = s.lock();
        match &st.transport {
            Transport::Collab(r) => {
                joined.insert((r.instance_id.clone(), r.generation));
            }
            Transport::Bridge { .. } => {
                held.insert(s.session_id.clone());
            }
            Transport::Detached => {
                if st.bridge_lost.is_none_or(|(at, _)| at.elapsed() < BRIDGE_RETURN) {
                    held.insert(s.session_id.clone());
                }
            }
        }
    }
    let mut to_join = Vec::new();
    let changed;
    {
        let mut reg = inner.reg.lock().unwrap_or_else(|p| p.into_inner());
        changed = !same_rows(&reg.rows, &rows);
        let now = Instant::now();
        for row in &rows {
            if let Some(f) = reg.failures.get_mut(&row.instance_id).filter(|f| f.generation == row.generation) {
                f.seen_at = now;
            }
            // It has a room: a later gap (a busy host missing polls) starts a fresh room wait.
            reg.awaiting.remove(&row.pid);
            let key = (row.instance_id.clone(), row.generation);
            let first_seen = *reg.first_seen.entry(key.clone()).or_insert(now);
            let Some(sid) = row.session_id.as_deref() else { continue };
            if !row.relay_connected || row.access != "control" {
                continue;
            }
            if joined.contains(&key) || reg.foreign.contains(&key) || reg.joining.contains(&row.instance_id) {
                continue;
            }
            // A bridge ≥ 2.0 serves this omp process: its room stays unjoined (omp only mirrors
            // into a room while a guest is in it).
            let pid_bridge = inner.bridge.by_pid(row.pid);
            if held.contains(sid)
                || pid_bridge.as_ref().is_some_and(|b| b.caps.data_plane())
                || inner.bridge.by_session(sid).is_some_and(|b| b.caps.data_plane())
            {
                continue;
            }
            // Its bridge may still be (re)connecting: give it the grace, unless the process's
            // bridge already said it cannot serve sessions.
            if pid_bridge.is_none() && now.duration_since(first_seen) < JOIN_GRACE {
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
        reg.first_seen.retain(|(i, _), _| live.contains(i.as_str()));
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
    let token = next_token();
    let room = CollabRoom { guest: guest.clone(), instance_id: row.instance_id.clone(), generation: link.generation, room_id, token };
    let joining = LinkStatus::connecting(LinkReason::Joining, Some(LinkVia::Collab), "joining omp's collab room");
    // A session whose bridge went away keeps its replica and subscribers: the room takes over.
    if let Some(s) = inner.session(&session_id).filter(|s| !s.is_closed()) {
        let mut st = s.lock();
        match st.transport {
            Transport::Detached => {
                st.transport = Transport::Collab(room);
                st.set_link(LinkStatus::connecting(
                    LinkReason::Joining,
                    Some(LinkVia::Collab),
                    "TeleFlock's bridge in omp is gone; showing the session through omp's collab room instead",
                ));
                s.set_data_plane(&mut st, None);
                drop(st);
                s.set_pid(row.pid);
                info!(session = %session_id, instance = %row.instance_id, generation = link.generation, "collab room takes over from the bridge");
                tokio::spawn(pump(Arc::downgrade(inner), s, rx, token));
                let _ = inner.updates.send(OmpUpdate::Registry);
                return Ok(());
            }
            Transport::Bridge { .. } => {
                // The bridge came back while the join ran: it keeps serving the session.
                drop(st);
                guest.close();
                return Ok(());
            }
            Transport::Collab(_) => {}
        }
    }
    let session = Arc::new(OmpSession::new(&session_id, row.pid, &inner.persist, inner.bridge.clone()));
    {
        let mut st = session.lock();
        st.transport = Transport::Collab(room);
        st.set_link(joining);
    }
    let old = inner.sessions.write().unwrap_or_else(|p| p.into_inner()).insert(session_id.clone(), session.clone());
    if let Some(old) = old {
        old.end("session moved to a new room");
    }
    info!(session = %session_id, instance = %row.instance_id, generation = link.generation, pid = row.pid, "joined omp session");
    tokio::spawn(pump(Arc::downgrade(inner), session.clone(), rx, token));
    spawn_session_loops(inner, &session);
    Ok(())
}

/// The loops every session runs for its lifetime, whatever feeds it: the collab journal reader
/// (idle while a bridge serves it) and the artifacts tail.
pub(crate) fn spawn_session_loops(inner: &Arc<Inner>, session: &Arc<OmpSession>) {
    tokio::spawn(journal_loop(Arc::downgrade(inner), session.clone()));
    tokio::spawn(artifact_loop(Arc::downgrade(inner), session.clone()));
}

/// Keeps the image originals the replica linked across restarts (see [`crate::originals`]).
fn persist_originals(inner: &Inner, session_id: &str, signals: &[Signal]) {
    for signal in signals {
        if let Signal::OriginalsKept { id, originals } = signal {
            inner.persist.update(|d| d.originals.entry(session_id.to_owned()).or_default().insert(id.clone(), originals.clone()));
        }
    }
}

/// The link a collab guest's reconnect shows: omp closing its room (4001, then 4004 while the
/// relay waits for the host to come back) is not a network problem.
pub(crate) fn reconnect_status(code: u16, reason: &str, timed_out: bool) -> LinkStatus {
    let via = Some(LinkVia::Collab);
    match code {
        4001 | 4004 => LinkStatus::connecting(LinkReason::RoomClosed, via, "omp closed its collab room; waiting for omp to reopen it"),
        _ if timed_out => LinkStatus::connecting(
            LinkReason::Reconnecting,
            via,
            format!("omp did not send the session in time ({reason}); rejoining its collab room with a longer wait"),
        ),
        1012 => LinkStatus::connecting(LinkReason::Reconnecting, via, "rejoining omp's collab room after resetting it"),
        _ if reason.is_empty() => LinkStatus::connecting(LinkReason::Reconnecting, via, "lost the connection to omp's collab room; reconnecting"),
        _ => LinkStatus::connecting(LinkReason::Reconnecting, via, format!("lost the connection to omp's collab room ({reason}); reconnecting")),
    }
}

/// What a replica update means outside the session lock: the replica's own ui-responses, the
/// usage ledger, pulses and signals for the boards, persisted image originals. `changed`: the
/// link or the feed changed (the boards re-read the session).
pub(crate) async fn publish(inner: &Inner, session: &Arc<OmpSession>, update: &tf_collab::Update, usage: Option<CostInfo>, now: Millis, changed: bool) {
    let sid = &session.session_id;
    if !update.replies.is_empty()
        && let Err(e) = session.send_replies(update.replies.clone()).await
    {
        warn!(session = %sid, "auto ui-response: {}", e.message);
    }
    observe_usage(inner, sid, usage, now);
    if !update.pulses.is_empty() {
        let _ = inner.updates.send(OmpUpdate::Pulses { session_id: sid.clone(), pulses: update.pulses.clone() });
    }
    if !update.signals.is_empty() {
        persist_originals(inner, sid, &update.signals);
        if update.signals.iter().any(|s| matches!(s, Signal::TurnStarted | Signal::TurnEnded { .. } | Signal::Prompted { .. })) {
            session.journal_kick.notify_one();
        }
        let _ = inner.updates.send(OmpUpdate::Signals { session_id: sid.clone(), signals: update.signals.clone() });
    }
    if changed || update.meta_changed || update.liveness_changed || !update.events.is_empty() {
        let _ = inner.updates.send(OmpUpdate::Changed { session_id: sid.clone() });
    }
}

async fn pump(weak: Weak<Inner>, session: Arc<OmpSession>, mut rx: tokio::sync::mpsc::UnboundedReceiver<GuestEvent>, token: u64) {
    let sid = session.session_id.clone();
    // Reconnects in a row whose welcome/snapshot timed out (a resync resets it).
    let mut timeouts = 0u32;
    while let Some(ev) = rx.recv().await {
        let Some(inner) = weak.upgrade() else { return };
        let now = now_ms();
        // Why the guest ended, and how the rejoin is paced (`None`: rotation or close, at once).
        let mut ended: Option<(String, Option<FailKind>)> = None;
        let mut reset = None;
        let (update, usage, room) = {
            let mut st = session.lock();
            // The bridge (back) or a newer room feeds the replica now: this guest is done.
            let room = match &st.transport {
                Transport::Collab(r) if r.token == token => (r.instance_id.clone(), r.generation, r.room_id.clone()),
                _ => return,
            };
            match &ev {
                GuestEvent::Snapshot(_) => {
                    // Live through the room; after the bridge went away, say why it is the room.
                    let status = match st.bridge_lost {
                        Some(_) => LinkStatus::new(
                            LinkState::Live,
                            Some(LinkReason::FallbackCollab),
                            Some(LinkVia::Collab),
                            Some("TeleFlock's bridge in omp is gone; showing the session through omp's collab room".into()),
                        ),
                        None => LinkStatus::live(LinkVia::Collab),
                    };
                    st.set_link(status);
                    timeouts = 0;
                }
                GuestEvent::Reconnecting { code, reason, timed_out, .. } => {
                    st.set_link(reconnect_status(*code, reason, *timed_out));
                    if *timed_out {
                        timeouts += 1;
                        if timeouts >= RESET_AFTER_TIMEOUTS {
                            reset = Some(room.2.clone());
                        }
                    }
                }
                GuestEvent::Ended(reason) => {
                    let via = Some(LinkVia::Collab);
                    let (status, msg, pace) = match reason {
                        EndReason::Rejected(m) => (LinkStatus::new(LinkState::Unsupported, None, via, Some(m.clone())), m.clone(), Some(FailKind::Unsupported)),
                        EndReason::Fatal(m) => (LinkStatus::new(LinkState::Error, None, via, Some(m.clone())), m.clone(), Some(FailKind::Transient)),
                        EndReason::RoomGone => {
                            let msg = "omp closed its collab room; waiting for omp to reopen it".to_string();
                            (LinkStatus::connecting(LinkReason::RoomClosed, via, msg.clone()), msg, Some(FailKind::Transient))
                        }
                        EndReason::Bye(r) => {
                            let msg = if r.is_empty() { "omp switched to another session".to_string() } else { r.clone() };
                            (LinkStatus::connecting(LinkReason::Joining, via, msg.clone()), msg, None)
                        }
                        EndReason::Closed => (LinkStatus::connecting(LinkReason::Joining, via, "left the collab room"), "left the collab room".into(), None),
                    };
                    st.set_link(status);
                    ended = Some((msg, pace));
                }
                GuestEvent::Frame(_) => {}
            }
            let update = st.replica.apply(&ev, now);
            let usage = session.absorb(&mut st, &update);
            (update, usage, room)
        };
        let link_changed = ended.is_some() || matches!(ev, GuestEvent::Snapshot(_) | GuestEvent::Reconnecting { .. });
        publish(&inner, &session, &update, usage, now, link_changed).await;
        if matches!(ev, GuestEvent::Snapshot(_)) {
            session.journal_kick.notify_one();
        }
        if let Some(room_id) = reset {
            reset_room(&inner, &room_id).await;
        }
        if let Some((reason, pace)) = ended {
            info!(session = %sid, "guest ended: {reason}");
            let (instance, generation, room_id) = room;
            inner.forget(&session, &reason);
            if let Some(kind) = pace {
                // Rejoin through the registry after a backoff: a room that ends right after every
                // join must not spin.
                let now = Instant::now();
                let mut reg = inner.reg.lock().unwrap_or_else(|p| p.into_inner());
                let f = reg.failures.entry(instance).or_insert_with(|| JoinFailure::new(generation, now));
                if f.generation != generation {
                    *f = JoinFailure::new(generation, now);
                }
                f.record(&JoinError { msg: reason, kind, room_id: Some(room_id) }, now);
            }
            inner.repoll.notify_one();
            return;
        }
    }
}

/// Every ~2 s while a turn streams (goal progress is rewritten each turn).
const JOURNAL_EVERY: Duration = Duration::from_secs(2);

/// Reads the main session journal through the collab guest: omp does not mirror `mode_change` /
/// `custom` entries on the frame stream, so goal state (and plan mode, user todo edits)
/// only reach the replica this way. Idle while the bridge serves the session ([`crate::feed`]
/// reads the file itself).
async fn journal_loop(weak: Weak<Inner>, session: Arc<OmpSession>) {
    loop {
        let kicked = tokio::select! {
            _ = session.journal_kick.notified() => true,
            _ = tokio::time::sleep(JOURNAL_EVERY) => false,
        };
        if session.is_closed() {
            return;
        }
        let Some(inner) = weak.upgrade() else { return };
        if !kicked && !session.is_streaming() {
            continue;
        }
        let Some(guest) = session.guest() else { continue };
        if let Err(e) = read_journal(&inner, &session, &guest).await {
            debug!(session = %session.session_id, "journal read: {e}");
        }
    }
}

async fn read_journal(inner: &Arc<Inner>, session: &Arc<OmpSession>, guest: &Guest) -> Result<(), String> {
    // Each reply is capped at 4 MiB; keep reading until caught up.
    for _ in 0..64 {
        let (main, offset) = {
            let st = session.lock();
            let Some(main) = st.replica.main_agent_id().map(str::to_string) else { return Ok(()) };
            (main, st.replica.journal_offset())
        };
        let chunk = guest.fetch_transcript(&main, offset).await.map_err(|e| e.to_string())?;
        let done = chunk.text.is_empty() || chunk.error.is_some();
        let (changed, usage) = {
            let mut st = session.lock();
            if st.replica.journal_offset() != offset || !matches!(&st.transport, Transport::Collab(r) if r.guest.ptr_eq(guest)) {
                // Raced with a resync/rotation that reset the offset, or the bridge took over.
                return Ok(());
            }
            let update = st.replica.apply_journal(&chunk);
            let usage = session.absorb(&mut st, &update);
            (update.meta_changed || !update.events.is_empty(), usage)
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
        let (sid, busy, named) = {
            let st = session.lock();
            let sid = st.replica.header().map(|h| h.id.clone()).filter(|s| !s.is_empty()).unwrap_or_else(|| session.session_id.clone());
            let busy = st.replica.is_streaming()
                || st.replica.replaying(now_ms())
                || st.replica.meta().subagents.iter().any(|s| s.status == tf_proto::session::SubagentStatus::Running)
                || last_growth.is_some_and(|t| t.elapsed() < ARTIFACTS_LINGER);
            (sid, busy, st.session_file.clone())
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
            // The bridge names the file (omp's agent dir need not be hostd's); else look it up.
            let file = match named {
                Some(file) => file,
                None => {
                    let root = crate::ops::host::omp_agent_dir().join("sessions");
                    let id = sid.clone();
                    let found = tokio::task::spawn_blocking(move || crate::artifacts::find_session_file(&root, &id)).await.ok().flatten();
                    let Some(file) = found else { continue };
                    file
                }
            };
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

#[cfg(all(test, unix))]
mod session_tests;

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

    fn state_with(subs: &[&ClientHandle]) -> SessionState {
        let mut fanout = Fanout::default();
        for c in subs {
            fanout.subscribe(c, "a", Replica::new("s").snapshot(10), None, "s");
        }
        let mut st = SessionState::new(Replica::new("s"));
        st.link = LinkState::Live;
        st.fanout = fanout;
        st
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
    fn metas_fold_into_the_latest_and_go_out_at_most_twice_a_second() {
        let (old, new) = (client("old", "0.5.0"), client("new", "0.5.1"));
        let mut st = state_with(&[&old, &new]);
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
        st.fanout.clear();
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
        let (bridge, _sock) = crate::bridge::fake::handle();
        let omp = OmpHandle::start(port, persist, cancel, bridge).await;

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
        assert_eq!(
            f.link(),
            LinkStatus::connecting(LinkReason::JoinFailed, Some(LinkVia::Collab), "join attempt 1 failed: boom; retrying")
        );
        assert!(f.retry_at > now);
        // A first timeout: the next join waits twice as long, the room is left alone.
        assert!(!f.record(&failed(FailKind::TimedOut), now));
        assert_eq!(JoinTimeouts::escalated(f.timeouts).welcome, Duration::from_secs(60));
        // The second one resets the room before the next try, which waits longer still.
        assert!(f.record(&failed(FailKind::TimedOut), now));
        assert_eq!(f.room.as_deref(), Some("room-1"));
        assert_eq!(f.link().state, LinkState::Connecting);
        assert_eq!(JoinTimeouts::escalated(f.timeouts).welcome, Duration::from_secs(120));
        // Only what retrying cannot fix leaves `connecting`.
        f.record(&failed(FailKind::Hard), now);
        assert_eq!(f.link(), LinkStatus::new(LinkState::Error, None, Some(LinkVia::Collab), Some("boom".into())));
        f.record(&failed(FailKind::Unsupported), now);
        assert_eq!(f.link().state, LinkState::Unsupported);
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
        let (bridge, _sock) = crate::bridge::fake::handle();
        let omp = OmpHandle::start(0, Persist::load(dir.join("state.json")), cancel, bridge.clone()).await;

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
        let starting = LinkStatus::connecting(LinkReason::Starting, None, "omp is starting; waiting for its TeleFlock bridge or collab room");
        assert_eq!(omp.link_without_guest(None, &[pid], false), starting);
        // Without the overlay it is not shared, unless omp's global config shares every session.
        let me = std::process::id();
        let unshared = omp.link_without_guest(None, &[me], false);
        assert_eq!((unshared.state, unshared.reason, unshared.via), (LinkState::NotShared, Some(LinkReason::NoRoom), None));
        assert_eq!(omp.link_without_guest(None, &[me], true), starting);
        // Still no room after the wait: not shared after all.
        for (first, _) in omp.inner.reg.lock().unwrap().awaiting.values_mut() {
            *first = first.checked_sub(ROOM_WAIT).unwrap();
        }
        let late = omp.link_without_guest(None, &[pid], false);
        assert_eq!((late.state, late.reason), (LinkState::NotShared, Some(LinkReason::NoRoom)));
        assert!(late.error.unwrap().contains("has not opened a collab room"));
        let _ = child.kill();
        let _ = child.wait();

        // A published room: its omp's bridge gets JOIN_GRACE to say hello (omp starting, hostd
        // restarted), then the room is joined; failed joins stay `connecting`, with the reason.
        let row: HostEntry = serde_json::from_value(serde_json::json!({
            "instanceId": "i1", "generation": 1, "pid": 7, "sessionId": "s1", "relayConnected": true, "access": "control"
        }))
        .unwrap();
        omp.inner.reg.lock().unwrap().rows.push(row);
        assert_eq!(
            omp.link_without_guest(Some("s1"), &[], false),
            LinkStatus::connecting(LinkReason::Starting, None, "waiting for TeleFlock's bridge in omp to connect before joining its collab room")
        );
        let long_ago = Instant::now().checked_sub(JOIN_GRACE).unwrap();
        omp.inner.reg.lock().unwrap().first_seen.insert(("i1".into(), 1), long_ago);
        assert_eq!(
            omp.link_without_guest(Some("s1"), &[], false),
            LinkStatus::connecting(LinkReason::Joining, Some(LinkVia::Collab), "joining omp's collab room")
        );
        {
            let mut reg = omp.inner.reg.lock().unwrap();
            let mut f = JoinFailure::new(1, Instant::now());
            f.record(&failed(FailKind::TimedOut), Instant::now());
            reg.failures.insert("i1".into(), f);
        }
        let failing = omp.link_without_guest(Some("s1"), &[], false);
        assert_eq!((failing.state, failing.reason), (LinkState::Connecting, Some(LinkReason::JoinFailed)));
        assert_eq!(failing.error.as_deref(), Some("join attempt 1 failed: boom; retrying"));
        // A new room generation starts over.
        {
            let mut reg = omp.inner.reg.lock().unwrap();
            reg.rows[0].generation = 2;
            reg.first_seen.insert(("i1".into(), 2), long_ago);
        }
        assert_eq!(omp.link_without_guest(Some("s1"), &[], false).reason, Some(LinkReason::Joining));
        // A view-only room and one on another relay are not shared, each with its reason.
        omp.inner.reg.lock().unwrap().rows[0].access = "view".into();
        assert_eq!(omp.link_without_guest(Some("s1"), &[], false).reason, Some(LinkReason::ViewOnly));
        {
            let mut reg = omp.inner.reg.lock().unwrap();
            reg.rows[0].access = "control".into();
            reg.foreign.insert(("i1".into(), 2));
        }
        assert_eq!(omp.link_without_guest(Some("s1"), &[], false).reason, Some(LinkReason::SharedElsewhere));

        // A bridge that serves sessions itself (≥ 2.0) says hello: the session is syncing through
        // it, whatever the room says; an older bridge changes nothing.
        let mut old = crate::bridge::fake::FakeExt::connect(&bridge).await;
        old.hello_caps(7, "s1", "1.4.0", None).await;
        assert_eq!(omp.link_without_guest(Some("s1"), &[], false).reason, Some(LinkReason::SharedElsewhere));
        let mut ext = crate::bridge::fake::FakeExt::connect(&bridge).await;
        ext.hello_caps(8, "s2", "2.0.0", Some(serde_json::json!({ "live": 1, "dialogs": true, "subagentCtl": true, "prompt": true })))
            .await;
        let syncing = omp.link_without_guest(Some("s2"), &[], false);
        assert_eq!((syncing.state, syncing.reason, syncing.via), (LinkState::Connecting, Some(LinkReason::Syncing), Some(LinkVia::Bridge)));
        assert_eq!(omp.link_without_guest(None, &[8], false).reason, Some(LinkReason::Syncing));
        omp.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
