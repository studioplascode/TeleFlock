//! `events.subscribe`: a long-lived push stream, reconnected with backoff, with
//! `pane_updated` floods coalesced per pane.

use crate::client::HerdrClient;
use crate::error::{HerdrError, Result, code};
use crate::model::*;
use crate::transport::{self, BoxConn};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::Instant;

/// Every global (parameterless) subscription type in herdr 0.9.x.
pub const ALL_GLOBAL_SUBSCRIPTIONS: &[&str] = &[
    "workspace.created",
    "workspace.updated",
    "workspace.metadata_updated",
    "workspace.renamed",
    "workspace.moved",
    "workspace.reordered",
    "workspace.closed",
    "workspace.focused",
    "worktree.created",
    "worktree.opened",
    "worktree.removed",
    "tab.created",
    "tab.closed",
    "tab.focused",
    "tab.renamed",
    "tab.moved",
    "pane.created",
    "pane.closed",
    "pane.updated",
    "pane.focused",
    "pane.moved",
    "pane.exited",
    "pane.agent_detected",
    "layout.updated",
];

/// Default coalescing window for `pane_updated`: at most 4 per second per pane.
pub const DEFAULT_COALESCE: Duration = Duration::from_millis(250);
const ACK_TIMEOUT: Duration = Duration::from_secs(10);
const BACKOFF_MIN: Duration = Duration::from_millis(250);
const BACKOFF_MAX: Duration = Duration::from_secs(10);

/// Options for [`HerdrClient::subscribe`].
#[derive(Debug, Clone)]
pub struct SubscribeOptions {
    /// Global subscription types (default: [`ALL_GLOBAL_SUBSCRIPTIONS`]). Drop
    /// `pane.updated` for a status-only stream.
    pub global: Vec<String>,
    /// Panes to watch with per-pane `pane.agent_status_changed` (exact transitions,
    /// held on a second connection). Update later with [`EventStream::set_status_panes`].
    pub status_panes: Vec<String>,
    /// Minimum spacing of `PaneUpdated` per pane. Status, agent and session changes
    /// bypass it; the latest update always wins.
    pub coalesce: Duration,
    /// Channel capacity between the reader task and the consumer.
    pub buffer: usize,
}

impl Default for SubscribeOptions {
    fn default() -> Self {
        Self {
            global: ALL_GLOBAL_SUBSCRIPTIONS.iter().map(|s| (*s).to_owned()).collect(),
            status_panes: Vec::new(),
            coalesce: DEFAULT_COALESCE,
            buffer: 1024,
        }
    }
}

/// A typed herdr event (lifecycle events normalised from snake_case and dot names).
#[derive(Debug, Clone, PartialEq)]
pub enum HerdrEvent {
    /// The subscription is (re)established. Take a fresh `snapshot()` now and apply the
    /// events that follow it: herdr does not replay what happened during a gap. Always
    /// the first event of a stream.
    Resync,
    /// The stream broke (server stopped, socket error, `events_lost`). Reconnecting with
    /// backoff; a `Resync` follows once it is back. Reported once per outage.
    Disconnected { error: HerdrError },
    /// The per-pane subscription was rejected (e.g. `pane_not_found`); the listed panes were
    /// dropped and the rest re-subscribed.
    SubscriptionError { error: HerdrError, dropped_panes: Vec<String> },

    WorkspaceCreated(WorkspaceInfo),
    /// `workspace_updated` and `workspace_metadata_updated`.
    WorkspaceUpdated(WorkspaceInfo),
    WorkspaceRenamed { workspace_id: String, label: String },
    WorkspaceClosed { workspace_id: String, workspace: Option<WorkspaceInfo> },
    WorkspaceFocused { workspace_id: String },
    /// `workspace_moved` / `workspace_reordered`: the full new order.
    WorkspacesReordered { workspaces: Vec<WorkspaceInfo> },

    WorktreeCreated { workspace: WorkspaceInfo, worktree: WorktreeEntry },
    WorktreeOpened { workspace: WorkspaceInfo, worktree: WorktreeEntry, already_open: bool },
    WorktreeRemoved { workspace_id: String, worktree: WorktreeEntry, forced: bool },

    TabCreated(TabInfo),
    TabClosed { tab_id: String, workspace_id: String },
    TabRenamed { tab_id: String, workspace_id: String, label: String },
    TabFocused { tab_id: String, workspace_id: String },
    /// `tab_moved`: the workspace's full new tab order.
    TabsReordered { workspace_id: String, tabs: Vec<TabInfo> },

    PaneCreated(PaneInfo),
    /// Coalesced: at most one per pane per `coalesce` window, except that status, agent and
    /// `agent_session` changes are delivered immediately.
    PaneUpdated(PaneInfo),
    PaneClosed { pane_id: String, workspace_id: String },
    PaneExited { pane_id: String, workspace_id: String },
    PaneFocused { pane_id: String, workspace_id: String },
    PaneMoved { previous_pane_id: String, pane: PaneInfo },
    PaneAgentDetected { pane_id: String, workspace_id: String, agent: Option<String> },
    /// Per-pane `pane.agent_status_changed`.
    AgentStatusChanged { pane_id: String, workspace_id: String, agent: Option<String>, agent_status: AgentStatus },

    LayoutUpdated(PaneLayout),
    /// Any other event, untouched.
    Other { event: String, data: Value },
}

#[derive(Deserialize)]
struct Ws {
    workspace: WorkspaceInfo,
}
#[derive(Deserialize)]
struct WsId {
    workspace_id: String,
    #[serde(default)]
    workspace: Option<WorkspaceInfo>,
    #[serde(default)]
    label: String,
}
#[derive(Deserialize)]
struct WsList {
    #[serde(default)]
    workspaces: Vec<WorkspaceInfo>,
}
#[derive(Deserialize)]
struct Wt {
    #[serde(default)]
    workspace: WorkspaceInfo,
    #[serde(default)]
    workspace_id: String,
    #[serde(default)]
    worktree: WorktreeEntry,
    #[serde(default)]
    already_open: bool,
    #[serde(default)]
    forced: bool,
}
#[derive(Deserialize)]
struct Tab {
    tab: TabInfo,
}
#[derive(Deserialize)]
struct TabId {
    tab_id: String,
    #[serde(default)]
    workspace_id: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    tabs: Vec<TabInfo>,
}
#[derive(Deserialize)]
struct Pane {
    pane: PaneInfo,
    #[serde(default)]
    previous_pane_id: String,
}
#[derive(Deserialize)]
struct PaneId {
    pane_id: String,
    #[serde(default)]
    workspace_id: String,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    agent_status: AgentStatus,
}
#[derive(Deserialize)]
struct Layout {
    layout: PaneLayout,
}

/// Parse one event envelope `{"event": name, "data": {...}}`.
/// Returns `Err` for an error envelope (`{"error":…}`, e.g. 0.9.2's `events_lost`)
/// and `Ok(None)` for lines that are neither (ignored).
pub fn parse_event(line: &str) -> Result<Option<HerdrEvent>> {
    let v: Value = serde_json::from_str(line).map_err(|e| HerdrError::protocol("invalid event line", e))?;
    if v.get("error").is_some() {
        return transport::parse_response(line).map(|_| None);
    }
    let Some(name) = v.get("event").and_then(Value::as_str) else { return Ok(None) };
    let data = v.get("data").cloned().unwrap_or(Value::Null);
    Ok(Some(event_from(name, data)))
}

fn event_from(name: &str, data: Value) -> HerdrEvent {
    fn de<T: serde::de::DeserializeOwned>(d: &Value) -> Option<T> {
        T::deserialize(d).ok()
    }
    let norm = name.replace('.', "_");
    let ev = match norm.as_str() {
        "workspace_created" => de::<Ws>(&data).map(|x| HerdrEvent::WorkspaceCreated(x.workspace)),
        "workspace_updated" | "workspace_metadata_updated" => {
            de::<Ws>(&data).map(|x| HerdrEvent::WorkspaceUpdated(x.workspace))
        }
        "workspace_renamed" => {
            de::<WsId>(&data).map(|x| HerdrEvent::WorkspaceRenamed { workspace_id: x.workspace_id, label: x.label })
        }
        "workspace_closed" => de::<WsId>(&data)
            .map(|x| HerdrEvent::WorkspaceClosed { workspace_id: x.workspace_id, workspace: x.workspace }),
        "workspace_focused" => de::<WsId>(&data).map(|x| HerdrEvent::WorkspaceFocused { workspace_id: x.workspace_id }),
        "workspace_moved" | "workspace_reordered" => {
            de::<WsList>(&data).map(|x| HerdrEvent::WorkspacesReordered { workspaces: x.workspaces })
        }
        "worktree_created" => {
            de::<Wt>(&data).map(|x| HerdrEvent::WorktreeCreated { workspace: x.workspace, worktree: x.worktree })
        }
        "worktree_opened" => de::<Wt>(&data).map(|x| HerdrEvent::WorktreeOpened {
            workspace: x.workspace,
            worktree: x.worktree,
            already_open: x.already_open,
        }),
        "worktree_removed" => de::<Wt>(&data).map(|x| HerdrEvent::WorktreeRemoved {
            workspace_id: if x.workspace_id.is_empty() { x.workspace.workspace_id } else { x.workspace_id },
            worktree: x.worktree,
            forced: x.forced,
        }),
        "tab_created" => de::<Tab>(&data).map(|x| HerdrEvent::TabCreated(x.tab)),
        "tab_closed" => de::<TabId>(&data).map(|x| HerdrEvent::TabClosed { tab_id: x.tab_id, workspace_id: x.workspace_id }),
        "tab_renamed" => de::<TabId>(&data).map(|x| HerdrEvent::TabRenamed {
            tab_id: x.tab_id,
            workspace_id: x.workspace_id,
            label: x.label,
        }),
        "tab_focused" => {
            de::<TabId>(&data).map(|x| HerdrEvent::TabFocused { tab_id: x.tab_id, workspace_id: x.workspace_id })
        }
        "tab_moved" => {
            de::<TabId>(&data).map(|x| HerdrEvent::TabsReordered { workspace_id: x.workspace_id, tabs: x.tabs })
        }
        "pane_created" => de::<Pane>(&data).map(|x| HerdrEvent::PaneCreated(x.pane)),
        "pane_updated" => de::<Pane>(&data).map(|x| HerdrEvent::PaneUpdated(x.pane)),
        "pane_moved" => {
            de::<Pane>(&data).map(|x| HerdrEvent::PaneMoved { previous_pane_id: x.previous_pane_id, pane: x.pane })
        }
        "pane_closed" => de::<PaneId>(&data).map(|x| HerdrEvent::PaneClosed { pane_id: x.pane_id, workspace_id: x.workspace_id }),
        "pane_exited" => de::<PaneId>(&data).map(|x| HerdrEvent::PaneExited { pane_id: x.pane_id, workspace_id: x.workspace_id }),
        "pane_focused" => {
            de::<PaneId>(&data).map(|x| HerdrEvent::PaneFocused { pane_id: x.pane_id, workspace_id: x.workspace_id })
        }
        "pane_agent_detected" => de::<PaneId>(&data).map(|x| HerdrEvent::PaneAgentDetected {
            pane_id: x.pane_id,
            workspace_id: x.workspace_id,
            agent: x.agent,
        }),
        "pane_agent_status_changed" => de::<PaneId>(&data).map(|x| HerdrEvent::AgentStatusChanged {
            pane_id: x.pane_id,
            workspace_id: x.workspace_id,
            agent: x.agent,
            agent_status: x.agent_status,
        }),
        "layout_updated" => de::<Layout>(&data).map(|x| HerdrEvent::LayoutUpdated(x.layout)),
        _ => None,
    };
    ev.unwrap_or(HerdrEvent::Other { event: name.to_owned(), data })
}

// ---------------------------------------------------------------------------
// Coalescing
// ---------------------------------------------------------------------------

struct Slot {
    last_emit: Instant,
    status: AgentStatus,
    agent: Option<String>,
    session: Option<AgentSession>,
    pending: Option<PaneInfo>,
}

/// Per-pane `pane_updated` rate limiter. The latest update always wins; changes of
/// `agent_status`, `agent` or `agent_session` pass immediately.
pub(crate) struct Coalescer {
    interval: Duration,
    slots: HashMap<String, Slot>,
}

impl Coalescer {
    pub(crate) fn new(interval: Duration) -> Self {
        Self { interval, slots: HashMap::new() }
    }

    /// Returns the update to emit now, if any; otherwise it is parked until its deadline.
    pub(crate) fn offer(&mut self, pane: PaneInfo, now: Instant) -> Option<PaneInfo> {
        match self.slots.get_mut(&pane.pane_id) {
            Some(s)
                if s.status == pane.agent_status
                    && s.agent == pane.agent
                    && s.session == pane.agent_session
                    && now.duration_since(s.last_emit) < self.interval =>
            {
                s.pending = Some(pane);
                None
            }
            Some(s) => {
                s.last_emit = now;
                s.status = pane.agent_status;
                s.agent.clone_from(&pane.agent);
                s.session.clone_from(&pane.agent_session);
                s.pending = None;
                Some(pane)
            }
            None => {
                self.slots.insert(
                    pane.pane_id.clone(),
                    Slot {
                        last_emit: now,
                        status: pane.agent_status,
                        agent: pane.agent.clone(),
                        session: pane.agent_session.clone(),
                        pending: None,
                    },
                );
                Some(pane)
            }
        }
    }

    pub(crate) fn next_deadline(&self) -> Option<Instant> {
        self.slots.values().filter(|s| s.pending.is_some()).map(|s| s.last_emit + self.interval).min()
    }

    /// Parked updates whose window elapsed.
    pub(crate) fn due(&mut self, now: Instant) -> Vec<PaneInfo> {
        let interval = self.interval;
        let mut out = Vec::new();
        for s in self.slots.values_mut() {
            if s.pending.is_some() && now >= s.last_emit + interval {
                s.last_emit = now;
                out.extend(s.pending.take());
            }
        }
        out
    }

    /// Every parked update, regardless of deadline (before any other event, to keep order).
    pub(crate) fn drain(&mut self, now: Instant) -> Vec<PaneInfo> {
        let mut out = Vec::new();
        for s in self.slots.values_mut() {
            if let Some(p) = s.pending.take() {
                s.last_emit = now;
                out.push(p);
            }
        }
        out
    }

    pub(crate) fn forget(&mut self, pane_id: &str) {
        self.slots.remove(pane_id);
    }

    pub(crate) fn clear(&mut self) {
        self.slots.clear();
    }
}

// ---------------------------------------------------------------------------
// Stream + worker
// ---------------------------------------------------------------------------

enum Control {
    SetStatusPanes(Vec<String>),
}

/// A live event stream. Dropping it closes the connections.
pub struct EventStream {
    rx: mpsc::Receiver<HerdrEvent>,
    ctl: mpsc::UnboundedSender<Control>,
    task: JoinHandle<()>,
}

impl EventStream {
    /// Next event; `None` only after the worker stopped (never on its own while the
    /// stream is alive: outages surface as `Disconnected` + `Resync`).
    pub async fn recv(&mut self) -> Option<HerdrEvent> {
        self.rx.recv().await
    }

    /// Replace the set of panes watched with per-pane `pane.agent_status_changed`.
    /// The new subscription is acknowledged before the old one closes, so no
    /// transition is lost; unknown panes are dropped with a `SubscriptionError`.
    pub fn set_status_panes(&self, panes: Vec<String>) {
        let _ = self.ctl.send(Control::SetStatusPanes(panes));
    }
}

impl Drop for EventStream {
    fn drop(&mut self) {
        self.task.abort();
    }
}

type LineStream = Lines<BufReader<BoxConn>>;

async fn open_subscription(client: &HerdrClient, subs: Vec<Value>) -> Result<LineStream> {
    let id = client.next_id("events.subscribe");
    let line = transport::request_line(&id, "events.subscribe", &json!({ "subscriptions": subs }))?;
    let ep = client.endpoint().clone();
    let fut = async move {
        let mut conn = transport::connect(&ep).await?;
        conn.write_all(&line).await.map_err(|e| HerdrError::transport("subscribe write", e))?;
        conn.flush().await.map_err(|e| HerdrError::transport("subscribe flush", e))?;
        let mut lines = BufReader::new(conn).lines();
        let ack = lines
            .next_line()
            .await
            .map_err(|e| HerdrError::transport("subscribe read", e))?
            .ok_or_else(|| HerdrError::transport("subscribe", "connection closed before ack"))?;
        transport::parse_response(&ack)?;
        Ok(lines)
    };
    tokio::time::timeout(ACK_TIMEOUT, fut).await.map_err(|_| HerdrError::timeout("events.subscribe"))?
}

struct Backoff(Duration);

impl Backoff {
    fn next(&mut self) -> Duration {
        let d = self.0;
        self.0 = (self.0 * 2).min(BACKOFF_MAX);
        // ±20 % jitter without an RNG dependency.
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|t| t.subsec_nanos()).unwrap_or(0);
        let frac = (nanos % 400) as f64 / 1000.0 + 0.8;
        d.mul_f64(frac)
    }
    fn reset(&mut self) {
        self.0 = BACKOFF_MIN;
    }
}

struct Worker {
    client: HerdrClient,
    global: Vec<String>,
    status_panes: Vec<String>,
    tx: mpsc::Sender<HerdrEvent>,
    ctl: mpsc::UnboundedReceiver<Control>,
    co: Coalescer,
}

/// Why `pump` returned.
enum Exit {
    /// Consumer gone: stop.
    Stop,
    /// Global stream failed: reconnect.
    Broken(HerdrError),
}

impl Worker {
    async fn emit(&self, ev: HerdrEvent) -> bool {
        self.tx.send(ev).await.is_ok()
    }

    async fn run(mut self) {
        let mut backoff = Backoff(BACKOFF_MIN);
        let mut outage_reported = false;
        loop {
            let subs: Vec<Value> = self.global.iter().map(|t| json!({ "type": t })).collect();
            match open_subscription(&self.client, subs).await {
                Ok(global) => {
                    backoff.reset();
                    self.co.clear();
                    if !self.emit(HerdrEvent::Resync).await {
                        return;
                    }
                    let status = self.open_status().await;
                    let Some(status) = status else { return };
                    match self.pump(global, status).await {
                        Exit::Stop => return,
                        Exit::Broken(error) => {
                            log::warn!("herdr event stream broke: {error}");
                            if !self.emit(HerdrEvent::Disconnected { error }).await {
                                return;
                            }
                            outage_reported = true;
                        }
                    }
                }
                Err(error) => {
                    log::debug!("herdr subscribe failed: {error}");
                    if !outage_reported {
                        outage_reported = true;
                        if !self.emit(HerdrEvent::Disconnected { error }).await {
                            return;
                        }
                    }
                }
            }
            let wait = tokio::time::sleep(backoff.next());
            tokio::pin!(wait);
            loop {
                tokio::select! {
                    _ = &mut wait => break,
                    _ = self.tx.closed() => return,
                    cmd = self.ctl.recv() => match cmd {
                        Some(Control::SetStatusPanes(p)) => self.status_panes = p,
                        None => return,
                    },
                }
            }
        }
    }

    /// Open the per-pane status subscription. Unknown panes are pruned (via `pane.list`)
    /// and reported. `Some(None)` = nothing to watch / gave up; outer `None` = consumer gone.
    async fn open_status(&mut self) -> Option<Option<LineStream>> {
        for _attempt in 0..3 {
            if self.status_panes.is_empty() {
                return Some(None);
            }
            let subs: Vec<Value> = self
                .status_panes
                .iter()
                .map(|p| json!({ "type": "pane.agent_status_changed", "pane_id": p }))
                .collect();
            match open_subscription(&self.client, subs).await {
                Ok(l) => return Some(Some(l)),
                Err(error) => {
                    let dropped = if error.is_not_found() || error.is(code::INVALID_REQUEST) {
                        match self.client.pane_list(None).await {
                            Ok(panes) => {
                                let live: std::collections::HashSet<_> = panes.into_iter().map(|p| p.pane_id).collect();
                                let (keep, drop): (Vec<_>, Vec<_>) =
                                    self.status_panes.drain(..).partition(|p| live.contains(p));
                                self.status_panes = keep;
                                drop
                            }
                            Err(_) => Vec::new(),
                        }
                    } else {
                        Vec::new()
                    };
                    let give_up = dropped.is_empty();
                    if !self.emit(HerdrEvent::SubscriptionError { error, dropped_panes: dropped }).await {
                        return None;
                    }
                    if give_up {
                        return Some(None);
                    }
                }
            }
        }
        Some(None)
    }

    async fn pump(&mut self, mut global: LineStream, mut status: Option<LineStream>) -> Exit {
        let mut status_retry: Option<Instant> = None;
        loop {
            let flush_at = self.co.next_deadline();
            tokio::select! {
                line = global.next_line() => {
                    let line = match line {
                        Ok(Some(l)) => l,
                        Ok(None) => return Exit::Broken(HerdrError::transport("events", "connection closed by herdr")),
                        Err(e) => return Exit::Broken(HerdrError::transport("events read", e)),
                    };
                    match parse_event(&line) {
                        Ok(Some(ev)) => if !self.dispatch(ev).await { return Exit::Stop },
                        Ok(None) => {}
                        Err(e) if e.is(code::PROTOCOL) => log::warn!("ignoring bad herdr event line: {e}"),
                        Err(e) => return Exit::Broken(e),
                    }
                }
                line = next_opt(&mut status) => {
                    match line {
                        Ok(Some(l)) => match parse_event(&l) {
                            Ok(Some(ev)) => if !self.dispatch(ev).await { return Exit::Stop },
                            Ok(None) => {}
                            Err(e) => {
                                log::debug!("status subscription error: {e}");
                                status = None;
                                status_retry = Some(Instant::now() + BACKOFF_MIN);
                            }
                        },
                        _ => {
                            // Closed (e.g. a watched pane went away): re-open with pruning.
                            status = None;
                            status_retry = Some(Instant::now() + BACKOFF_MIN);
                        }
                    }
                }
                _ = sleep_opt(status_retry) => {
                    status_retry = None;
                    match self.open_status().await {
                        Some(s) => status = s,
                        None => return Exit::Stop,
                    }
                }
                _ = sleep_opt(flush_at) => {
                    for p in self.co.due(Instant::now()) {
                        if !self.emit(HerdrEvent::PaneUpdated(p)).await { return Exit::Stop }
                    }
                }
                cmd = self.ctl.recv() => match cmd {
                    Some(Control::SetStatusPanes(p)) => {
                        self.status_panes = p;
                        // New subscription is acked before the old one is dropped.
                        match self.open_status().await {
                            Some(s) => status = s,
                            None => return Exit::Stop,
                        }
                    }
                    None => return Exit::Stop,
                },
                _ = self.tx.closed() => return Exit::Stop,
            }
        }
    }

    /// Route one event through the coalescer, preserving order.
    async fn dispatch(&mut self, ev: HerdrEvent) -> bool {
        let now = Instant::now();
        if let HerdrEvent::PaneUpdated(p) = ev {
            return match self.co.offer(p, now) {
                Some(p) => self.emit(HerdrEvent::PaneUpdated(p)).await,
                None => true,
            };
        }
        for p in self.co.drain(now) {
            if !self.emit(HerdrEvent::PaneUpdated(p)).await {
                return false;
            }
        }
        if let HerdrEvent::PaneClosed { pane_id, .. } | HerdrEvent::PaneExited { pane_id, .. } = &ev {
            self.co.forget(pane_id);
        }
        self.emit(ev).await
    }
}

async fn next_opt(s: &mut Option<LineStream>) -> std::io::Result<Option<String>> {
    match s {
        Some(l) => l.next_line().await,
        None => std::future::pending().await,
    }
}

async fn sleep_opt(at: Option<Instant>) {
    match at {
        Some(t) => tokio::time::sleep_until(t).await,
        None => std::future::pending().await,
    }
}

impl HerdrClient {
    /// Open a coalesced, self-reconnecting `events.subscribe` stream. The first event is
    /// always [`HerdrEvent::Resync`]: snapshot then, and again after every later `Resync`.
    /// Must be called inside a tokio runtime.
    pub fn subscribe(&self, opts: SubscribeOptions) -> EventStream {
        let (tx, rx) = mpsc::channel(opts.buffer.max(16));
        let (ctl_tx, ctl_rx) = mpsc::unbounded_channel();
        let worker = Worker {
            client: self.clone(),
            global: opts.global,
            status_panes: opts.status_panes,
            tx,
            ctl: ctl_rx,
            co: Coalescer::new(opts.coalesce),
        };
        let task = tokio::spawn(worker.run());
        EventStream { rx, ctl: ctl_tx, task }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane(id: &str, status: AgentStatus, rev: u64) -> PaneInfo {
        PaneInfo { pane_id: id.into(), agent_status: status, revision: rev, ..Default::default() }
    }

    #[test]
    fn coalesces_title_churn_but_not_status() {
        let mut c = Coalescer::new(Duration::from_millis(250));
        let t0 = Instant::now();
        assert!(c.offer(pane("p", AgentStatus::Working, 1), t0).is_some());
        // Spinner churn within the window is parked; the latest wins.
        for (i, ms) in [50u64, 100, 150].iter().enumerate() {
            assert!(c.offer(pane("p", AgentStatus::Working, 2 + i as u64), t0 + Duration::from_millis(*ms)).is_none());
        }
        assert_eq!(c.next_deadline(), Some(t0 + Duration::from_millis(250)));
        assert!(c.due(t0 + Duration::from_millis(200)).is_empty());
        let due = c.due(t0 + Duration::from_millis(250));
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].revision, 4);
        // A status change passes immediately even inside the window.
        let s = c.offer(pane("p", AgentStatus::Idle, 9), t0 + Duration::from_millis(260));
        assert_eq!(s.map(|p| p.revision), Some(9));
        // Other panes are independent.
        assert!(c.offer(pane("q", AgentStatus::Working, 1), t0 + Duration::from_millis(261)).is_some());
    }

    #[test]
    fn drain_flushes_everything() {
        let mut c = Coalescer::new(Duration::from_secs(1));
        let t0 = Instant::now();
        c.offer(pane("a", AgentStatus::Working, 1), t0);
        c.offer(pane("a", AgentStatus::Working, 2), t0);
        c.offer(pane("b", AgentStatus::Idle, 1), t0);
        c.offer(pane("b", AgentStatus::Idle, 3), t0);
        let mut d = c.drain(t0);
        d.sort_by(|x, y| x.pane_id.cmp(&y.pane_id));
        assert_eq!(d.iter().map(|p| p.revision).collect::<Vec<_>>(), vec![2, 3]);
        assert!(c.next_deadline().is_none());
    }

    #[test]
    fn error_envelope_is_error() {
        let e = parse_event(r#"{"id":"s","error":{"code":"events_lost","message":"subscriber lagged"}}"#).unwrap_err();
        assert_eq!(e.code, code::EVENTS_LOST);
        let e = parse_event(r#"{"id":"sx:sub:0:probe","error":{"code":"pane_not_found","message":"pane w9:p9 not found"}}"#)
            .unwrap_err();
        assert!(e.is_not_found());
    }
}
