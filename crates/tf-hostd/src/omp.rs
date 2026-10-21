//! omp data plane (architecture §3.4 `omp.rs`): the embedded collab relay, registry
//! polling, and one `tf_collab::Guest` + `Replica` per hosted omp session.
//!
//! Shared by every herdr session of the daemon. Session events are delivered to
//! subscribed clients directly from here (ordered with the snapshot under one lock,
//! coalesced to one flush per 50 ms); board-level changes are announced on a
//! broadcast channel that each state store consumes.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::time::{Duration, Instant};

use tokio::sync::{broadcast, Notify};
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

use tf_collab::{
    Access, EndReason, Guest, GuestEvent, HostEntry, Registry, Relay, RelayConfig, RelayIdentity, Replica, Signal,
};
use tf_proto::host::ServerMsg;
use tf_proto::model::{Answer, CostInfo, LinkState, Liveness, NeedsYou, PulseKind, SetupIssue, Severity, UsageTotals};
use tf_proto::session::{HistoryPage, SessionEvent, SessionMeta, SessionSnapshot, TreeInfo, UiRequest};
use tf_proto::{ApiError, Millis};

use crate::clients::ClientHandle;
use crate::state::persist::Persist;
use crate::util::{local_day, now_ms};

/// Display name of TeleFlock's guest in omp rooms.
pub const GUEST_NAME: &str = "TeleFlock";
/// One flush of session events per 50 ms (architecture §3.3).
const FLUSH_EVERY: Duration = Duration::from_millis(50);
const POLL_EVERY: Duration = Duration::from_millis(1500);
const JOIN_RETRY: Duration = Duration::from_secs(5);

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

/// Snapshot of what the board needs about one omp session.
#[derive(Debug, Clone)]
pub struct OmpView {
    pub session_id: String,
    pub pid: u32,
    pub link: LinkState,
    pub link_error: Option<String>,
    pub meta: SessionMeta,
    pub live: Liveness,
    pub needs: Option<NeedsYou>,
    pub streaming: bool,
    pub first_prompt: Option<String>,
    /// The replica is inside a turn (`agent_start` … `agent_end`).
    pub turn_active: bool,
}

struct SessionState {
    replica: Replica,
    link: LinkState,
    link_error: Option<String>,
    pending: Vec<SessionEvent>,
    last_flush: Instant,
    flush_scheduled: bool,
    subs: Vec<(ClientHandle, String)>,
    last_cost: Option<CostInfo>,
    first_prompt: Option<String>,
    overlay: MetaOverlay,
    /// Raw omp leaf id the cached (or in-flight) session tree was fetched for.
    tree_for: Option<Option<String>>,
}

/// One joined omp collab room.
pub struct OmpSession {
    pub session_id: String,
    pub instance_id: String,
    pub generation: u64,
    pub pid: u32,
    pub guest: Guest,
    st: Mutex<SessionState>,
    closed: AtomicBool,
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
        st.subs.retain(|(c, a)| !(c.id() == client.id() && a == agent_id) && !c.is_closed());
        let mut snap = st.replica.snapshot(limit);
        st.overlay.apply(&mut snap.meta, st.link == LinkState::Live);
        snap.agent_id = agent_id.to_string();
        st.subs.push((client.clone(), agent_id.to_string()));
        snap
    }

    pub fn unsubscribe(&self, client_id: &str, agent_id: &str) {
        self.lock().subs.retain(|(c, a)| !(c.id() == client_id && a == agent_id));
    }

    pub fn unsubscribe_client(&self, client_id: &str) {
        self.lock().subs.retain(|(c, _)| c.id() != client_id);
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

    pub fn meta(&self) -> SessionMeta {
        let st = self.lock();
        let mut meta = st.replica.meta().clone();
        st.overlay.apply(&mut meta, st.link == LinkState::Live);
        meta
    }

    /// Replaces the bridge overlay; subscribers get a `meta` event when it changed. The cached
    /// session tree survives (it is refreshed separately through [`Self::set_tree`]).
    pub fn set_overlay(&self, mut overlay: MetaOverlay) {
        let mut st = self.lock();
        if overlay.tree.is_none() {
            overlay.tree = st.overlay.tree.clone();
        }
        if st.overlay == overlay {
            return;
        }
        st.overlay = overlay;
        emit_meta_locked(&mut st);
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
    pub fn set_tree(&self, tree: Option<TreeInfo>) {
        let mut st = self.lock();
        let Some(tree) = tree else {
            st.tree_for = None;
            return;
        };
        if st.overlay.tree.as_ref() == Some(&tree) {
            return;
        }
        st.overlay.tree = Some(tree);
        emit_meta_locked(&mut st);
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

    pub fn view(&self, now: Millis) -> OmpView {
        let st = self.lock();
        OmpView {
            session_id: self.session_id.clone(),
            pid: self.pid,
            link: st.link,
            link_error: st.link_error.clone(),
            meta: {
                let mut meta = st.replica.meta().clone();
                st.overlay.apply(&mut meta, st.link == LinkState::Live);
                meta
            },
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
        SessionEvent::Upsert { item } => pick(item),
        _ => None,
    })
}

/// Bridge-derived session facts layered over the replica's meta (the companion
/// extension knows model/thinking/mode/queue precisely; collab lags or lacks them).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MetaOverlay {
    pub bridge: bool,
    pub model: Option<tf_proto::model::ModelRef>,
    pub thinking: Option<tf_proto::model::ThinkingLevel>,
    pub fast: Option<bool>,
    pub mode: Option<tf_proto::model::OmpMode>,
    pub title: Option<String>,
    pub context: Option<tf_proto::model::ContextUsage>,
    pub queue: Option<tf_proto::model::QueueInfo>,
    pub tree: Option<tf_proto::session::TreeInfo>,
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
            meta.queue = v.clone();
        }
        if let Some(v) = &self.tree {
            meta.tree = Some(v.clone());
        }
    }
}

/// Queues a `meta` event with the replica meta plus the overlay and flushes.
fn emit_meta_locked(st: &mut SessionState) {
    let mut meta = st.replica.meta().clone();
    st.overlay.apply(&mut meta, st.link == LinkState::Live);
    st.pending.push(SessionEvent::Meta { meta });
    flush_locked(st);
}

/// Sends pending events to the subscribers, merging appends to the same row.
fn flush_locked(st: &mut SessionState) {
    st.last_flush = Instant::now();
    if st.pending.is_empty() {
        return;
    }
    let live = st.link == LinkState::Live;
    let mut events = coalesce(std::mem::take(&mut st.pending));
    for ev in &mut events {
        match ev {
            SessionEvent::Meta { meta } => st.overlay.apply(meta, live),
            SessionEvent::Reset { snapshot } => st.overlay.apply(&mut snapshot.meta, live),
            _ => {}
        }
    }
    st.subs.retain(|(c, _)| !c.is_closed());
    for ev in events {
        for (client, agent_id) in &st.subs {
            let ev = match &ev {
                SessionEvent::Reset { snapshot } => {
                    let mut s = snapshot.clone();
                    s.agent_id = agent_id.clone();
                    SessionEvent::Reset { snapshot: s }
                }
                other => other.clone(),
            };
            client.send(ServerMsg::Session { agent_id: agent_id.clone(), ev });
        }
    }
}

/// Merges `append`s into an earlier `append` of the same row and field when nothing in
/// between touched that row.
pub fn coalesce(events: Vec<SessionEvent>) -> Vec<SessionEvent> {
    let mut out: Vec<SessionEvent> = Vec::with_capacity(events.len());
    'next: for ev in events {
        if let SessionEvent::Append { id, field, text } = &ev {
            for prev in out.iter_mut().rev() {
                match prev {
                    SessionEvent::Append { id: pid, field: pf, text: pt } if pid == id => {
                        if pf == field {
                            pt.push_str(text);
                            continue 'next;
                        }
                    }
                    SessionEvent::Upsert { item } if item.id() == id => break,
                    SessionEvent::Remove { id: rid } if rid == id => break,
                    SessionEvent::Reset { .. } | SessionEvent::Ended { .. } => break,
                    _ => {}
                }
            }
        }
        out.push(ev);
    }
    out
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
/// the port).
async fn verify_room_relay(own: Option<(RelayIdentity, SocketAddr)>, port: u16, ws_url: &str) -> Result<String, String> {
    let (identity, addr) = own.ok_or_else(|| {
        format!("the TeleFlock relay is not running on 127.0.0.1:{port}; not joining a room on a relay tf-hostd does not own")
    })?;
    // omp connects where its URL points: `[::1]` is a different socket from our IPv4 listener.
    let host = ws_url.split_once("://").map_or(ws_url, |(_, r)| r);
    let target = if host.starts_with("[::1]") { SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port) } else { addr };
    identity.verify(target).await.map_err(|e| format!("refusing to join: the relay on {target} failed the identity check ({e})"))?;
    Ok(format!("ws://{target}"))
}

#[derive(Default)]
struct Registryish {
    rows: Vec<HostEntry>,
    /// (instance, generation) shared on another relay.
    foreign: HashSet<(String, u64)>,
    joining: HashSet<String>,
    /// instance → (error, retry after).
    failures: HashMap<String, (String, Instant)>,
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
        match Relay::start(RelayConfig::new(port)).await {
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

    /// Link state of an omp session TeleFlock has not (or not yet) joined.
    pub fn link_without_guest(&self, session_id: Option<&str>) -> (LinkState, Option<String>) {
        let Some(sid) = session_id else { return (LinkState::NotShared, None) };
        let reg = self.inner.reg.lock().unwrap_or_else(|p| p.into_inner());
        let Some(row) = reg.rows.iter().filter(|r| r.session_id.as_deref() == Some(sid)).max_by_key(|r| r.generation)
        else {
            return (LinkState::NotShared, None);
        };
        if reg.foreign.contains(&(row.instance_id.clone(), row.generation)) {
            return (LinkState::NotShared, Some("shared on another relay".into()));
        }
        if row.access != "control" {
            return (LinkState::NotShared, Some(format!("room access is `{}`", row.access)));
        }
        if let Some((err, _)) = reg.failures.get(&row.instance_id) {
            return (LinkState::Error, Some(err.clone()));
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
            let key = (row.instance_id.clone(), row.generation);
            if !row.relay_connected || row.access != "control" || row.session_id.is_none() {
                continue;
            }
            if joined.contains(&key) || reg.foreign.contains(&key) || reg.joining.contains(&row.instance_id) {
                continue;
            }
            if reg.failures.get(&row.instance_id).is_some_and(|(_, retry)| *retry > now) {
                continue;
            }
            reg.joining.insert(row.instance_id.clone());
            to_join.push(row.clone());
        }
        let live: HashSet<&str> = rows.iter().map(|r| r.instance_id.as_str()).collect();
        reg.failures.retain(|k, _| live.contains(k.as_str()));
        reg.foreign.retain(|(i, _)| live.contains(i.as_str()));
        reg.rows = rows;
    }
    if changed {
        let _ = inner.updates.send(OmpUpdate::Registry);
    }
    for row in to_join {
        let inner = inner.clone();
        tokio::spawn(async move {
            let instance = row.instance_id.clone();
            let res = join(&inner, row).await;
            let mut reg = inner.reg.lock().unwrap_or_else(|p| p.into_inner());
            reg.joining.remove(&instance);
            if let Err(e) = res {
                warn!(instance, "join failed: {e}");
                reg.failures.insert(instance, (e, Instant::now() + JOIN_RETRY));
            } else {
                reg.failures.remove(&instance);
            }
            drop(reg);
            let _ = inner.updates.send(OmpUpdate::Registry);
        });
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

async fn join(inner: &Arc<Inner>, row: HostEntry) -> Result<(), String> {
    let session_id = row.session_id.clone().ok_or("no session id")?;
    let link = inner.registry.link(&row.instance_id, Access::Control).await.map_err(|e| e.to_string())?;
    if loopback_port(&link.link.ws_url) != Some(inner.relay_port) {
        debug!(instance = %row.instance_id, url = %link.link.ws_url, "room is on another relay");
        inner.reg.lock().unwrap_or_else(|p| p.into_inner()).foreign.insert((row.instance_id.clone(), link.generation));
        return Ok(());
    }
    let own = inner.relay.lock().await.as_ref().map(|r| (r.identity(), r.local_addr()));
    let relay_url = verify_room_relay(own, inner.relay_port, &link.link.ws_url).await?;
    let room = link.link.with_relay(&relay_url).map_err(|e| e.to_string())?;
    let (guest, rx) = Guest::connect(room, GUEST_NAME).await.map_err(|e| e.to_string())?;
    let session = Arc::new(OmpSession {
        session_id: session_id.clone(),
        instance_id: row.instance_id.clone(),
        generation: link.generation,
        pid: row.pid,
        guest,
        st: Mutex::new(SessionState {
            replica: Replica::new(session_id.clone()),
            link: LinkState::Connecting,
            link_error: None,
            pending: Vec::new(),
            last_flush: Instant::now(),
            flush_scheduled: false,
            subs: Vec::new(),
            last_cost: None,
            first_prompt: None,
            overlay: MetaOverlay::default(),
            tree_for: None,
        }),
        closed: AtomicBool::new(false),
    });
    let old = inner.sessions.write().unwrap_or_else(|p| p.into_inner()).insert(session_id.clone(), session.clone());
    if let Some(old) = old {
        old.end("session moved to a new room");
    }
    info!(session = %session_id, instance = %row.instance_id, generation = link.generation, pid = row.pid, "joined omp session");
    tokio::spawn(pump(Arc::downgrade(inner), session, rx));
    Ok(())
}

async fn pump(weak: Weak<Inner>, session: Arc<OmpSession>, mut rx: tokio::sync::mpsc::UnboundedReceiver<GuestEvent>) {
    let sid = session.session_id.clone();
    while let Some(ev) = rx.recv().await {
        let Some(inner) = weak.upgrade() else { return };
        let now = now_ms();
        let mut ended: Option<String> = None;
        let (update, usage) = {
            let mut st = session.lock();
            match &ev {
                GuestEvent::Snapshot(_) => {
                    st.link = LinkState::Live;
                    st.link_error = None;
                }
                GuestEvent::Reconnecting { reason, .. } => {
                    st.link = LinkState::Connecting;
                    st.link_error = (!reason.is_empty()).then(|| reason.clone());
                }
                GuestEvent::Ended(reason) => {
                    let (state, msg) = match reason {
                        EndReason::Rejected(m) => (LinkState::Unsupported, m.clone()),
                        EndReason::Fatal(m) => (LinkState::Error, m.clone()),
                        other => (LinkState::Connecting, format!("{other:?}")),
                    };
                    st.link = state;
                    st.link_error = Some(msg.clone());
                    ended = Some(msg);
                }
                GuestEvent::Frame(_) => {}
            }
            let update = st.replica.apply(&ev, now);
            st.pending.extend(update.events.iter().cloned());
            schedule_flush(&session, &mut st);
            if st.first_prompt.is_none() {
                st.first_prompt = first_prompt_in(&update.events);
            }
            let usage = st.replica.usage().filter(|c| st.last_cost.as_ref() != Some(c));
            if let Some(c) = &usage {
                st.last_cost = Some(c.clone());
            }
            (update, usage.map(|c| (c, st.replica.meta().model.as_ref().map(|m| format!("{}/{}", m.provider, m.id)))))
        };
        for r in &update.replies {
            if let Err(e) = session.guest.ui_response(r.req_id, r.value.clone()) {
                warn!(session = %sid, "auto ui-response: {e}");
            }
        }
        if let Some((cost, model)) = usage {
            let day = local_day(now);
            inner.persist.update(|d| d.usage.observe(&sid, &cost, model.as_deref(), &day));
        }
        if !update.pulses.is_empty() {
            let _ = inner.updates.send(OmpUpdate::Pulses { session_id: sid.clone(), pulses: update.pulses.clone() });
        }
        if !update.signals.is_empty() {
            let _ = inner.updates.send(OmpUpdate::Signals { session_id: sid.clone(), signals: update.signals.clone() });
        }
        if update.meta_changed || update.liveness_changed || !update.events.is_empty() || ended.is_some()
            || matches!(ev, GuestEvent::Snapshot(_) | GuestEvent::Reconnecting { .. })
        {
            let _ = inner.updates.send(OmpUpdate::Changed { session_id: sid.clone() });
        }
        if let Some(reason) = ended {
            info!(session = %sid, "guest ended: {reason}");
            {
                let mut map = inner.sessions.write().unwrap_or_else(|p| p.into_inner());
                if map.get(&sid).is_some_and(|s| Arc::ptr_eq(s, &session)) {
                    map.remove(&sid);
                }
            }
            session.end(&reason);
            let _ = inner.updates.send(OmpUpdate::Registry);
            inner.repoll.notify_one();
            return;
        }
    }
}

fn schedule_flush(session: &Arc<OmpSession>, st: &mut SessionState) {
    if st.pending.is_empty() {
        return;
    }
    let since = st.last_flush.elapsed();
    if since >= FLUSH_EVERY {
        flush_locked(st);
        return;
    }
    if st.flush_scheduled {
        return;
    }
    st.flush_scheduled = true;
    let s = session.clone();
    let wait = FLUSH_EVERY - since;
    tokio::spawn(async move {
        tokio::time::sleep(wait).await;
        let mut st = s.lock();
        st.flush_scheduled = false;
        flush_locked(&mut st);
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
        SessionEvent::Append { id: id.into(), field: AppendField::Text, text: t.into() }
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
        let out = coalesce(vec![
            app("a", "he"),
            app("b", "1"),
            app("a", "llo"),
            SessionEvent::Upsert { item: notice },
            app("a", "!"),
            app("b", "2"),
        ]);
        assert_eq!(out.len(), 3, "{out:?}");
        assert_eq!(out[0], app("a", "hello!"));
        assert_eq!(out[1], app("b", "12"));
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
        let out = coalesce(vec![app("a", "1"), SessionEvent::Upsert { item }, app("a", "2")]);
        assert_eq!(out.len(), 3);
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

        // The socket answering on our port is someone else's relay (different secret).
        let err = verify_room_relay(Some((ours.identity(), foreign.local_addr())), port, &url).await.unwrap_err();
        assert!(err.contains("identity check"), "{err}");

        // Our relay is not running (another process may hold the port): never join.
        let err = verify_room_relay(None, port, &url).await.unwrap_err();
        assert!(err.contains(&format!("127.0.0.1:{port}")) && err.contains("not running"), "{err}");
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
}
