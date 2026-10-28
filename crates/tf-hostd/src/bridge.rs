//! Companion-extension bridge (architecture §4, wire format: `docs/bridge-protocol.md`).
//!
//! omp sessions that load `host/teleflock-bridge/teleflock-bridge.ts` connect to
//! `~/.teleflock/run/bridge.sock` (Windows: the `bridge_pipe` named pipe, owner-only DACL), receive
//! an `auth` frame carrying the secret from `run/bridge.secret`, say `hello`, push events, and
//! answer control requests. This module owns that socket and exposes:
//!
//! * a registry of connected sessions keyed by omp `sessionId` (pid cross-check via [`BridgeHandle::by_pid`]),
//! * typed async control calls with per-op timeouts and typed errors ([`BridgeError`] → [`ApiError`]),
//! * a broadcast stream of [`BridgeEvent`]s for HostdCore,
//! * the data plane of bridges ≥ 2.0 (`hello.caps.live`): a lossless, ordered live feed per
//!   session ([`BridgeHandle::live_subscribe`] → [`LiveMsg`]s) that `crate::feed` turns into the
//!   session replica, plus `prompt`, `uiResponse` and `agentCmd`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use tf_collab::{AgentCmdKind, HostFrame, ImageContent};
use tf_proto::methods::Delivery;
use tf_proto::{
    ApiError, BtwHistory, BtwStarted, CommandList, ContextUsage, Dequeued, ExportResult, ForkPlacement, GoalInfo,
    GoalOp, Millis, ModelRef, OmpMode, QueueInfo, ThinkingLevel, TreeInfo,
};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};

/// Bridge wire protocol version (`v` of `auth`, `hello` and `welcome`): 1 is the control plane,
/// 2 adds the data plane (`hello.caps`, the live feed, bridge ≥ 2.0.0). hostd serves both.
pub const BRIDGE_PROTOCOL: u32 = 2;
/// Longest accepted line (plan contents and trees can be large).
const MAX_LINE: usize = 64 * 1024 * 1024;
/// Quick ops (state reads, model/thinking/rename, queue, plan answers).
const QUICK: Duration = Duration::from_secs(10);
/// Ops that go through the TUI composer or switch sessions.
const TUI: Duration = Duration::from_secs(30);
/// Compaction and handoff run a summarisation turn.
const LONG: Duration = Duration::from_secs(600);

// ─────────────────────────────────────────── public types ───────────────────────────────────────────

/// Where the bridge listens.
#[derive(Debug, Clone)]
pub enum BridgeEndpoint {
    #[cfg(unix)]
    Unix(std::path::PathBuf),
    #[cfg(windows)]
    Pipe(String),
}

impl std::fmt::Display for BridgeEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            #[cfg(unix)]
            Self::Unix(p) => write!(f, "{}", p.display()),
            #[cfg(windows)]
            Self::Pipe(p) => f.write_str(p),
        }
    }
}

/// Control-plane state reported by the extension (hello, then `state` events).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CtlState {
    #[serde(default)]
    pub model: Option<ModelRef>,
    #[serde(default, deserialize_with = "lenient")]
    pub thinking: Option<ThinkingLevel>,
    #[serde(default)]
    pub fast: bool,
    #[serde(default = "normal_mode", deserialize_with = "lenient_mode")]
    pub mode: OmpMode,
    #[serde(default)]
    pub goal: Option<GoalInfo>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub idle: bool,
    #[serde(default, deserialize_with = "lenient")]
    pub context: Option<ContextUsage>,
    #[serde(default)]
    pub leaf_id: Option<String>,
    #[serde(default = "empty_queue")]
    pub queue: QueueInfo,
    #[serde(default)]
    pub plan_review: Option<PlanReviewInfo>,
    /// The extension holds a command context (tree/branch/new session work without a round-trip).
    #[serde(default)]
    pub attached: bool,
}

impl Default for CtlState {
    fn default() -> Self {
        Self {
            model: None,
            thinking: None,
            fast: false,
            mode: OmpMode::Normal,
            goal: None,
            title: None,
            idle: true,
            context: None,
            leaf_id: None,
            queue: empty_queue(),
            plan_review: None,
            attached: false,
        }
    }
}

/// An open interactive plan review (omp `plan_review_requested`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanReviewInfo {
    pub review_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub plan_path: Option<String>,
    #[serde(default)]
    pub content: String,
    /// Display order; ids are stable: `execute`, `compact`, `keep`, `refine`, `save`.
    #[serde(default)]
    pub choices: Vec<PlanChoice>,
    /// Execution tiers selectable as `role` on approvals (empty when fewer than two).
    #[serde(default)]
    pub tiers: Vec<PlanTier>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanChoice {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub disabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanTier {
    pub role: String,
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub thinking_level: Option<String>,
}

/// Data-plane features a bridge announces in `hello.caps` (bridge ≥ 2.0.0; all off before).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeCaps {
    /// Live-feed version (`liveSubscribe`, `live` and `resync` frames); 0: none.
    #[serde(default)]
    pub live: u32,
    /// omp's dialogs (ask, tool approvals, selects, editors) reach hostd and take `uiResponse`.
    #[serde(default)]
    pub dialogs: bool,
    /// Subagents take `agentCmd` (chat, kill, revive).
    #[serde(default)]
    pub subagent_ctl: bool,
    /// `prompt` (text, images, delivery).
    #[serde(default)]
    pub prompt: bool,
}

impl BridgeCaps {
    /// The bridge serves the session's transcript and live events itself (no collab room needed).
    pub fn data_plane(&self) -> bool {
        self.live >= 1
    }
}

/// One connected omp session.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSession {
    pub pid: u32,
    pub session_id: String,
    pub session_file: Option<String>,
    pub cwd: String,
    pub omp_version: Option<String>,
    pub bridge_version: String,
    /// Running in the interactive TUI (TUI-only ops need this).
    pub tui: bool,
    pub state: CtlState,
    pub connected_at: Millis,
    pub caps: BridgeCaps,
    /// The connection serving it (a reconnect is a new connection).
    #[serde(skip)]
    pub conn: u64,
}

/// One message of a session's live feed ([`BridgeHandle::live_subscribe`]), in wire order.
#[derive(Debug, Clone, PartialEq)]
pub enum LiveMsg {
    /// Everything in flight, taken between two omp events: the first message of every
    /// subscription, and again after the extension had to drop frames it could not send.
    Resync(Resync),
    /// One live event, shaped exactly like an omp collab host → guest frame.
    Frame { seq: u64, frame: HostFrame },
    /// omp is shutting down (`session_shutdown`); the connection closes next.
    Bye,
}

/// A `resync` frame (`docs/bridge-protocol.md`).
#[derive(Debug, Clone, PartialEq)]
pub struct Resync {
    pub seq: u64,
    pub session_id: String,
    pub session_file: Option<String>,
    pub leaf_id: Option<String>,
    /// Newest entry omp already wrote to the session file (file order); `None` while omp has not
    /// written the file yet (its entries are then among `frames`).
    pub last_entry_id: Option<String>,
    pub streaming: bool,
    /// The in-flight state as collab frames, in order: `entry` frames (only while the file is not
    /// written yet), `state`, `agents`, running events, subagent `bus` frames, pending dialogs.
    pub frames: Vec<HostFrame>,
}

/// A subscription to a session's live feed. `rx` ends when the connection closes, the omp
/// session switches, or a newer subscription replaces this one.
#[derive(Debug)]
pub struct LiveFeed {
    pub rx: mpsc::UnboundedReceiver<LiveMsg>,
    /// The connection the feed belongs to.
    pub conn: u64,
}

/// Events for HostdCore (`BridgeHandle::subscribe`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BridgeEvent {
    /// First `hello` on a connection.
    Connected { session: BridgeSession },
    /// The connection closed (omp exited, `/exit`, or the extension reconnects).
    Disconnected { pid: u32, session_id: String },
    /// Same process, new session (`/new`, `/resume`, fork, branch).
    SessionSwitch {
        pid: u32,
        previous_session_id: String,
        session: BridgeSession,
    },
    /// Model, thinking, fast, mode, goal, title, idle, context, leaf or attachment changed.
    State { session_id: String, state: CtlState },
    PlanReviewRequested {
        session_id: String,
        review: PlanReviewInfo,
    },
    /// `choice` is `None` when dismissed/cancelled; `by` is `local` or `extension`.
    PlanReviewResolved {
        session_id: String,
        review_id: String,
        choice: Option<String>,
        by: String,
    },
    QueueUpdate {
        session_id: String,
        queue: QueueInfo,
    },
    /// Side-question stream, per conversation turn: while `done` is false `text` is a delta; the
    /// `done` event carries the full final reply in `text` (or `error`). `question` comes with the
    /// turn's first event (also for `/btw` asked in omp's TUI).
    BtwDelta {
        session_id: String,
        btw_id: String,
        turn: u32,
        question: Option<String>,
        text: String,
        done: bool,
        error: Option<String>,
    },
}

impl BridgeEvent {
    pub fn session_id(&self) -> &str {
        match self {
            Self::Connected { session } | Self::SessionSwitch { session, .. } => {
                &session.session_id
            }
            Self::Disconnected { session_id, .. }
            | Self::State { session_id, .. }
            | Self::PlanReviewRequested { session_id, .. }
            | Self::PlanReviewResolved { session_id, .. }
            | Self::QueueUpdate { session_id, .. }
            | Self::BtwDelta { session_id, .. } => session_id,
        }
    }
}

/// Typed bridge failure. Convert with `ApiError::from`.
#[derive(Debug, Clone, PartialEq)]
pub enum BridgeError {
    /// No bridge connection for this session.
    NotConnected { session_id: String },
    /// The extension did not answer in time.
    Timeout { op: String, after: Duration },
    /// The connection dropped while the request was in flight.
    Disconnected { op: String },
    /// The extension refused or failed the request (`code` from `docs/bridge-protocol.md`).
    Rejected {
        op: String,
        code: String,
        message: String,
    },
    /// The extension answered with something this hostd cannot decode.
    BadResponse { op: String, message: String },
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotConnected { session_id } => {
                write!(f, "no TeleFlock bridge for session {session_id}")
            }
            Self::Timeout { op, after } => {
                write!(f, "bridge {op} timed out after {}s", after.as_secs())
            }
            Self::Disconnected { op } => write!(f, "bridge disconnected during {op}"),
            Self::Rejected { op, code, message } => {
                write!(f, "bridge {op} failed ({code}): {message}")
            }
            Self::BadResponse { op, message } => write!(f, "bridge {op}: bad response: {message}"),
        }
    }
}

impl std::error::Error for BridgeError {}

impl From<BridgeError> for ApiError {
    fn from(e: BridgeError) -> Self {
        let text = e.to_string();
        match e {
            BridgeError::NotConnected { .. } => ApiError::new("not_connected", text)
                .with_hint("Start the agent from TeleFlock, or install the TeleFlock bridge extension on this host.")
                .retryable(),
            BridgeError::Timeout { .. } => ApiError::new("timeout", text).retryable(),
            BridgeError::Disconnected { .. } => ApiError::new("not_connected", text).retryable(),
            BridgeError::BadResponse { .. } => ApiError::new("omp_error", text),
            BridgeError::Rejected { code, message, .. } => match code.as_str() {
                "invalid_params" | "not_found" | "unsupported" | "auth_required" => ApiError::new(code, message),
                "busy" => ApiError::new("busy", message).retryable(),
                "not_ready" => ApiError::new("not_connected", message).retryable(),
                "unknown_op" => ApiError::new("unsupported", message)
                    .with_hint("The omp session runs an older TeleFlock bridge; restart the agent to update it."),
                _ => ApiError::new("omp_error", message),
            },
        }
    }
}

// ─────────────────────────────────────────── handle ───────────────────────────────────────────

type Reply = Result<Value, BridgeError>;

struct Conn {
    tx: mpsc::UnboundedSender<String>,
    /// The session requests for it are routed to: `None` before `hello`, and after another
    /// connection took the session over (or a newer bridge copy of the same omp process serves it).
    session: Option<BridgeSession>,
    /// `(pid, bridge version)` of the latest `hello`, kept while the connection is not routed.
    hello: Option<(u32, String)>,
    pending: HashMap<u64, oneshot::Sender<Reply>>,
    /// Live feed of `session` ([`BridgeHandle::live_subscribe`]); dropped (ending the feed) when
    /// the session switches or is taken away from this connection.
    feed: Option<mpsc::UnboundedSender<LiveMsg>>,
}

#[derive(Default)]
struct Registry {
    conns: HashMap<u64, Conn>,
    /// sessionId → connection (latest hello wins).
    by_session: HashMap<String, u64>,
}

struct Shared {
    reg: Mutex<Registry>,
    events: broadcast::Sender<BridgeEvent>,
    next_conn: AtomicU64,
    next_req: AtomicU64,
    /// Handshake secret sent as the first frame of every connection (see [`BridgeHandle::start`]).
    secret: String,
}

struct Inner {
    shared: Arc<Shared>,
    accept: JoinHandle<()>,
    endpoint: BridgeEndpoint,
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.accept.abort();
        #[cfg(unix)]
        {
            let BridgeEndpoint::Unix(p) = &self.endpoint;
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Bridge server handle (cheap `Clone`). Dropping the last clone stops listening.
#[derive(Clone)]
pub struct BridgeHandle {
    inner: Arc<Inner>,
}

impl BridgeHandle {
    /// Generates a fresh handshake secret, writes it owner-only to `paths.bridge_secret`, then binds
    /// `paths.bridge_sock` (unix, mode 0600, stale file replaced) or `paths.bridge_pipe` (windows,
    /// DACL current user + SYSTEM). Must be called inside a tokio runtime.
    pub fn start(paths: &crate::paths::Paths) -> std::io::Result<BridgeHandle> {
        paths.ensure_dirs()?;
        let secret = crate::secure::new_secret()?;
        crate::secure::write_secret_file(&paths.bridge_secret, &secret)?;
        #[cfg(unix)]
        let endpoint = BridgeEndpoint::Unix(paths.bridge_sock.clone());
        #[cfg(windows)]
        let endpoint = BridgeEndpoint::Pipe(paths.bridge_pipe.clone());
        Self::bind(endpoint, secret)
    }

    /// Binds an explicit endpoint (tests, lab harnesses). `secret` is presented to every
    /// connection in the `auth` frame; the extension compares it with its secret file.
    pub fn bind(endpoint: BridgeEndpoint, secret: String) -> std::io::Result<BridgeHandle> {
        let shared = Arc::new(Shared {
            reg: Mutex::new(Registry::default()),
            events: broadcast::channel(1024).0,
            next_conn: AtomicU64::new(1),
            next_req: AtomicU64::new(1),
            secret,
        });
        let accept = listen(&endpoint, shared.clone())?;
        info!("bridge listening on {endpoint}");
        Ok(BridgeHandle {
            inner: Arc::new(Inner {
                shared,
                accept,
                endpoint,
            }),
        })
    }

    pub fn endpoint(&self) -> &BridgeEndpoint {
        &self.inner.endpoint
    }

    pub fn subscribe(&self) -> broadcast::Receiver<BridgeEvent> {
        self.inner.shared.events.subscribe()
    }

    /// All sessions that completed `hello`.
    pub fn sessions(&self) -> Vec<BridgeSession> {
        let reg = self.reg();
        reg.by_session
            .values()
            .filter_map(|c| reg.conns.get(c)?.session.clone())
            .collect()
    }

    pub fn by_session(&self, session_id: &str) -> Option<BridgeSession> {
        let reg = self.reg();
        let conn = reg.by_session.get(session_id)?;
        reg.conns.get(conn)?.session.clone()
    }

    /// The most recently connected session of omp process `pid`.
    pub fn by_pid(&self, pid: u32) -> Option<BridgeSession> {
        let reg = self.reg();
        reg.conns
            .values()
            .filter_map(|c| c.session.as_ref())
            .filter(|s| s.pid == pid)
            .max_by_key(|s| s.connected_at)
            .cloned()
    }

    pub fn is_connected(&self, session_id: &str) -> bool {
        self.reg().by_session.contains_key(session_id)
    }

    fn reg(&self) -> std::sync::MutexGuard<'_, Registry> {
        lock(&self.inner.shared.reg)
    }

    /// Sends one request and waits for its `res`.
    pub async fn call(
        &self,
        session_id: &str,
        op: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, BridgeError> {
        let Some(&conn_id) = self.reg().by_session.get(session_id) else {
            return Err(BridgeError::NotConnected {
                session_id: session_id.to_owned(),
            });
        };
        self.call_on(conn_id, session_id, op, params, timeout).await
    }

    /// [`Self::call`] on one connection (the one a live feed was registered on).
    async fn call_on(
        &self,
        conn_id: u64,
        session_id: &str,
        op: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, BridgeError> {
        let id = self.inner.shared.next_req.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut reg = self.reg();
            let Some(conn) = reg.conns.get_mut(&conn_id) else {
                return Err(BridgeError::NotConnected {
                    session_id: session_id.to_owned(),
                });
            };
            let line = json!({ "t": "req", "id": id, "op": op, "params": params }).to_string();
            if conn.tx.send(line).is_err() {
                return Err(BridgeError::Disconnected { op: op.to_owned() });
            }
            conn.pending.insert(id, tx);
        }
        debug!(session_id, op, id, "bridge request");
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(reply)) => reply.map_err(|e| with_op(e, op)),
            Ok(Err(_)) => Err(BridgeError::Disconnected { op: op.to_owned() }),
            Err(_) => {
                if let Some(conn) = self.reg().conns.get_mut(&conn_id) {
                    conn.pending.remove(&id);
                }
                Err(BridgeError::Timeout {
                    op: op.to_owned(),
                    after: timeout,
                })
            }
        }
    }

    // ── data plane (bridge ≥ 2.0, `caps.live`) ──

    /// Starts (or restarts) the live feed of `session_id`: the extension answers with a `resync`
    /// (written before its `res`, so it is the feed's first message after any stale frames of an
    /// earlier subscription), then `live` frames. Replaces an earlier feed of the session.
    pub async fn live_subscribe(&self, session_id: &str) -> Result<LiveFeed, BridgeError> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mine = tx.clone();
        let conn = {
            let mut reg = self.reg();
            let Some(&conn_id) = reg.by_session.get(session_id) else {
                return Err(BridgeError::NotConnected { session_id: session_id.to_owned() });
            };
            let conn = reg.conns.get_mut(&conn_id).expect("by_session points at a live conn");
            conn.feed = Some(tx);
            conn_id
        };
        match self.call_on(conn, session_id, "liveSubscribe", json!({}), QUICK).await {
            Ok(_) => Ok(LiveFeed { rx, conn }),
            Err(e) => {
                if let Some(c) = self.reg().conns.get_mut(&conn)
                    && c.feed.as_ref().is_some_and(|f| f.same_channel(&mine))
                {
                    c.feed = None;
                }
                Err(e)
            }
        }
    }

    /// Prompts through omp's `pi.sendUserMessage`: `auto` steers while omp streams and starts a
    /// turn otherwise. Returns whether omp queued it (a steer or follow-up) instead of starting.
    pub async fn prompt(
        &self,
        session_id: &str,
        text: &str,
        images: &[ImageContent],
        delivery: Delivery,
    ) -> Result<bool, BridgeError> {
        #[derive(Deserialize)]
        struct Queued {
            #[serde(default)]
            queued: bool,
        }
        let params = json!({ "text": text, "images": images, "delivery": delivery });
        let r: Queued = self.typed(session_id, "prompt", params, TUI).await?;
        Ok(r.queued)
    }

    /// Answers dialog `req_id` (a `ui-request` live frame) with an exact option label or editor
    /// text; `None` cancels (the same values a collab guest sends).
    pub async fn ui_response(&self, session_id: &str, req_id: u64, value: Option<&str>) -> Result<(), BridgeError> {
        self.unit(session_id, "uiResponse", json!({ "reqId": req_id, "value": value }), QUICK)
            .await
    }

    /// Subagent control, as omp's collab host does it for guests (chat steers or revives, kill
    /// aborts and tombstones).
    pub async fn agent_cmd(
        &self,
        session_id: &str,
        cmd: AgentCmdKind,
        agent_id: &str,
        text: Option<&str>,
    ) -> Result<(), BridgeError> {
        let params = json!({ "cmd": cmd, "agentId": agent_id, "text": text });
        self.unit(session_id, "agentCmd", params, TUI).await
    }

    async fn typed<T: serde::de::DeserializeOwned>(
        &self,
        session_id: &str,
        op: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<T, BridgeError> {
        let value = self.call(session_id, op, params, timeout).await?;
        serde_json::from_value(value).map_err(|e| BridgeError::BadResponse {
            op: op.to_owned(),
            message: e.to_string(),
        })
    }

    async fn unit(
        &self,
        session_id: &str,
        op: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<(), BridgeError> {
        self.call(session_id, op, params, timeout).await.map(drop)
    }

    // ── typed control calls ──

    pub async fn get_state(&self, session_id: &str) -> Result<CtlState, BridgeError> {
        self.typed(session_id, "getState", json!({}), QUICK).await
    }

    /// `model` is `provider/id` (or anything omp's model resolver accepts, e.g. `@smol`).
    pub async fn set_model(
        &self,
        session_id: &str,
        model: &str,
        thinking: Option<ThinkingLevel>,
    ) -> Result<CtlState, BridgeError> {
        self.typed(
            session_id,
            "setModel",
            json!({ "model": model, "thinking": thinking }),
            QUICK,
        )
        .await
    }

    pub async fn set_thinking(
        &self,
        session_id: &str,
        level: ThinkingLevel,
    ) -> Result<CtlState, BridgeError> {
        self.typed(session_id, "setThinking", json!({ "level": level }), QUICK)
            .await
    }

    pub async fn set_fast(&self, session_id: &str, on: bool) -> Result<CtlState, BridgeError> {
        self.typed(session_id, "setFast", json!({ "on": on }), TUI)
            .await
    }

    /// Turns plan mode on/off (omp's `/plan` is a 3-state cycle; the extension walks it).
    pub async fn set_plan(&self, session_id: &str, on: bool) -> Result<CtlState, BridgeError> {
        self.typed(session_id, "setPlan", json!({ "on": on }), TUI)
            .await
    }

    pub async fn goal(
        &self,
        session_id: &str,
        op: GoalOp,
        objective: Option<&str>,
        budget: Option<u64>,
    ) -> Result<(), BridgeError> {
        self.unit(
            session_id,
            "goal",
            json!({ "op": op, "objective": objective, "budget": budget }),
            TUI,
        )
        .await
    }

    /// Fails with `Rejected { code: "nothing_to_compact" }` on sessions too small to compact.
    pub async fn compact(
        &self,
        session_id: &str,
        instructions: Option<&str>,
    ) -> Result<(), BridgeError> {
        self.unit(
            session_id,
            "compact",
            json!({ "instructions": instructions }),
            LONG,
        )
        .await
    }

    pub async fn rename(&self, session_id: &str, title: &str) -> Result<(), BridgeError> {
        self.unit(session_id, "rename", json!({ "title": title }), QUICK)
            .await
    }

    /// Queues `text` to run after the current turn (starts now when idle). Returns the queue.
    pub async fn follow_up(&self, session_id: &str, text: &str) -> Result<QueueInfo, BridgeError> {
        self.typed(session_id, "followUp", json!({ "text": text }), TUI)
            .await
    }

    pub async fn navigate_tree(
        &self,
        session_id: &str,
        entry_id: &str,
        summarize: bool,
    ) -> Result<(), BridgeError> {
        let timeout = if summarize { LONG } else { TUI };
        self.unit(
            session_id,
            "navigateTree",
            json!({ "entryId": entry_id, "summarize": summarize }),
            timeout,
        )
        .await
    }

    /// Rewinds to before user message `entry_id` (new session file → `SessionSwitch` event).
    pub async fn branch(&self, session_id: &str, entry_id: &str) -> Result<(), BridgeError> {
        self.unit(session_id, "branch", json!({ "entryId": entry_id }), TUI)
            .await
    }

    /// `/fork` (in place → `SessionSwitch`) or `/fork pane` (herdr opens a new pane).
    pub async fn fork(
        &self,
        session_id: &str,
        entry_id: Option<&str>,
        placement: ForkPlacement,
    ) -> Result<(), BridgeError> {
        self.unit(
            session_id,
            "fork",
            json!({ "entryId": entry_id, "placement": placement }),
            TUI,
        )
        .await
    }

    pub async fn new_session(&self, session_id: &str) -> Result<(), BridgeError> {
        self.unit(session_id, "newSession", json!({}), TUI).await
    }

    pub async fn resolve_plan_review(
        &self,
        session_id: &str,
        review_id: &str,
        choice: &str,
        feedback: Option<&str>,
        role: Option<&str>,
    ) -> Result<(), BridgeError> {
        let params =
            json!({ "reviewId": review_id, "choice": choice, "feedback": feedback, "role": role });
        self.unit(session_id, "resolvePlanReview", params, QUICK)
            .await
    }

    /// Asks a side question through omp's own `/btw` (a follow-up when `btw_id` names an existing
    /// conversation); the answer streams as [`BridgeEvent::BtwDelta`].
    pub async fn btw(
        &self,
        session_id: &str,
        question: &str,
        btw_id: Option<&str>,
    ) -> Result<BtwStarted, BridgeError> {
        self.typed(session_id, "btw", json!({ "question": question, "btwId": btw_id }), TUI)
            .await
    }

    /// Cancels the running turn of a side conversation (its final `BtwDelta` carries `error`).
    pub async fn btw_cancel(&self, session_id: &str, btw_id: &str) -> Result<(), BridgeError> {
        self.unit(session_id, "btwCancel", json!({ "btwId": btw_id }), QUICK)
            .await
    }

    /// The session's `/btw` history (omp's `btw-history` sidecar), oldest first.
    pub async fn btw_history(&self, session_id: &str) -> Result<BtwHistory, BridgeError> {
        self.typed(session_id, "getBtwHistory", json!({}), QUICK).await
    }

    /// HTML export. Without `path` the file lands in the session's artifacts dir.
    pub async fn export(
        &self,
        session_id: &str,
        path: Option<&str>,
    ) -> Result<ExportResult, BridgeError> {
        self.typed(session_id, "export", json!({ "path": path }), TUI)
            .await
    }

    pub async fn handoff(&self, session_id: &str, focus: Option<&str>) -> Result<(), BridgeError> {
        self.unit(session_id, "handoff", json!({ "focus": focus }), LONG)
            .await
    }

    pub async fn get_tree(&self, session_id: &str) -> Result<TreeInfo, BridgeError> {
        self.typed(session_id, "getTree", json!({}), QUICK).await
    }

    pub async fn get_queue(&self, session_id: &str) -> Result<QueueInfo, BridgeError> {
        self.typed(session_id, "getQueue", json!({}), QUICK).await
    }

    /// Extension, prompt-template and skill commands of the session (`pi.getCommands()`).
    pub async fn commands(&self, session_id: &str) -> Result<CommandList, BridgeError> {
        self.typed(session_id, "getCommands", json!({}), QUICK).await
    }

    /// Pulls the last queued message back out of the queue (Alt+Up), returning its text.
    pub async fn dequeue(&self, session_id: &str) -> Result<Dequeued, BridgeError> {
        self.typed(session_id, "dequeue", json!({}), QUICK).await
    }

    /// Runs any single-line slash command through the TUI composer (as if typed + Enter).
    pub async fn slash(&self, session_id: &str, command: &str) -> Result<(), BridgeError> {
        self.unit(session_id, "slash", json!({ "command": command }), TUI)
            .await
    }

    pub async fn abort(&self, session_id: &str) -> Result<(), BridgeError> {
        self.unit(session_id, "abort", json!({}), QUICK).await
    }
}

fn with_op(e: BridgeError, op: &str) -> BridgeError {
    match e {
        BridgeError::Rejected { code, message, .. } => BridgeError::Rejected {
            op: op.to_owned(),
            code,
            message,
        },
        other => other,
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn now_ms() -> Millis {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as Millis)
        .unwrap_or(0)
}

fn normal_mode() -> OmpMode {
    OmpMode::Normal
}

fn empty_queue() -> QueueInfo {
    QueueInfo {
        steering: Vec::new(),
        follow_up: Vec::new(),
    }
}

/// Unknown values (a newer omp level, a malformed context) become `None` instead of failing the frame.
fn lenient<'de, D: Deserializer<'de>, T: serde::de::DeserializeOwned>(
    d: D,
) -> Result<Option<T>, D::Error> {
    let v = Option::<Value>::deserialize(d)?;
    Ok(v.and_then(|v| serde_json::from_value(v).ok()))
}

fn lenient_mode<'de, D: Deserializer<'de>>(d: D) -> Result<OmpMode, D::Error> {
    Ok(lenient(d)?.unwrap_or(OmpMode::Normal))
}

// ─────────────────────────────────────────── server ───────────────────────────────────────────

#[cfg(unix)]
fn listen(endpoint: &BridgeEndpoint, shared: Arc<Shared>) -> std::io::Result<JoinHandle<()>> {
    use std::os::unix::fs::PermissionsExt;
    let BridgeEndpoint::Unix(path) = endpoint;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // hostd holds the single-instance lock, so an existing socket file is stale.
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let listener = tokio::net::UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let (r, w) = stream.into_split();
                    spawn_conn(shared.clone(), r, w);
                }
                Err(e) => {
                    warn!("bridge accept: {e}");
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
        }
    }))
}

#[cfg(windows)]
fn listen(endpoint: &BridgeEndpoint, shared: Arc<Shared>) -> std::io::Result<JoinHandle<()>> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let BridgeEndpoint::Pipe(name) = endpoint;
    let name = name.clone();
    // Owner-only DACL (current user + SYSTEM) on every instance; kept alive by the accept task.
    let sd = crate::secure::PrivateSd::new()?;
    let mut server = crate::secure::create_pipe_server(
        ServerOptions::new().first_pipe_instance(true).reject_remote_clients(true),
        &name,
        &sd,
    )?;
    Ok(tokio::spawn(async move {
        loop {
            if let Err(e) = server.connect().await {
                warn!("bridge pipe connect: {e}");
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
            let next = match crate::secure::create_pipe_server(
                ServerOptions::new().reject_remote_clients(true),
                &name,
                &sd,
            ) {
                Ok(n) => n,
                Err(e) => {
                    warn!("bridge pipe create: {e}");
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    continue;
                }
            };
            let connected = std::mem::replace(&mut server, next);
            let (r, w) = tokio::io::split(connected);
            spawn_conn(shared.clone(), r, w);
        }
    }))
}

fn spawn_conn<R, W>(shared: Arc<Shared>, reader: R, writer: W)
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let conn_id = shared.next_conn.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    // First frame on every connection: proves to the extension that this is the real hostd.
    let _ = tx.send(json!({ "t": "auth", "v": BRIDGE_PROTOCOL, "secret": shared.secret }).to_string());
    lock(&shared.reg).conns.insert(
        conn_id,
        Conn {
            tx,
            session: None,
            hello: None,
            pending: HashMap::new(),
            feed: None,
        },
    );
    debug!(conn_id, "bridge connection");

    let writer_task = tokio::spawn(async move {
        let mut writer = writer;
        while let Some(mut line) = rx.recv().await {
            line.push('\n');
            if let Err(e) = writer.write_all(line.as_bytes()).await {
                debug!(conn_id, "bridge write: {e}");
                break;
            }
        }
    });

    tokio::spawn(async move {
        let mut reader = BufReader::new(reader);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match read_line(&mut reader, &mut buf).await {
                Ok(false) => break,
                Ok(true) => match std::str::from_utf8(&buf) {
                    Ok(line) if line.trim().is_empty() => {}
                    Ok(line) => on_line(&shared, conn_id, line),
                    Err(_) => warn!(conn_id, "bridge: non-UTF-8 line dropped"),
                },
                Err(e) => {
                    warn!(conn_id, "bridge read: {e}");
                    break;
                }
            }
        }
        writer_task.abort();
        on_close(&shared, conn_id);
    });
}

/// Reads one `\n`-terminated line (without the terminator) into `buf`, capped at [`MAX_LINE`].
/// `Ok(false)` on EOF; a trailing unterminated line counts as a line.
async fn read_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    buf: &mut Vec<u8>,
) -> std::io::Result<bool> {
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(!buf.is_empty());
        }
        let (chunk, done) = match available.iter().position(|&b| b == b'\n') {
            Some(i) => (&available[..i], Some(i + 1)),
            None => (available, None),
        };
        if buf.len() + chunk.len() > MAX_LINE {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "bridge line too long",
            ));
        }
        buf.extend_from_slice(chunk);
        let used = done.unwrap_or(chunk.len());
        reader.consume(used);
        if done.is_some() {
            if buf.last() == Some(&b'\r') {
                buf.pop();
            }
            return Ok(true);
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Hello {
    #[serde(default)]
    v: u32,
    pid: u32,
    session_id: String,
    #[serde(default)]
    session_file: Option<String>,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    omp_version: Option<String>,
    #[serde(default)]
    bridge_version: String,
    #[serde(default)]
    tui: bool,
    #[serde(default)]
    state: Option<CtlState>,
    #[serde(default)]
    caps: BridgeCaps,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResyncLine {
    seq: u64,
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    session_file: Option<String>,
    #[serde(default)]
    leaf_id: Option<String>,
    #[serde(default)]
    last_entry_id: Option<String>,
    #[serde(default)]
    live: ResyncLive,
}

#[derive(Deserialize, Default)]
struct ResyncLive {
    #[serde(default)]
    streaming: bool,
    #[serde(default)]
    frames: Vec<Value>,
}

#[derive(Deserialize)]
struct ResError {
    code: String,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BtwFrame {
    btw_id: String,
    #[serde(default)]
    turn: u32,
    #[serde(default)]
    question: Option<String>,
    #[serde(default)]
    text: String,
    #[serde(default)]
    done: bool,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedFrame {
    review_id: String,
    #[serde(default)]
    choice: Option<String>,
    #[serde(default)]
    by: String,
}

fn on_line(shared: &Shared, conn_id: u64, line: &str) {
    let msg: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            warn!(conn_id, "bridge: bad json: {e}");
            return;
        }
    };
    match msg.get("t").and_then(Value::as_str).unwrap_or_default() {
        "hello" => match serde_json::from_value::<Hello>(msg) {
            Ok(h) => on_hello(shared, conn_id, h),
            Err(e) => warn!(conn_id, "bridge: bad hello: {e}"),
        },
        "res" => on_res(shared, conn_id, &msg),
        "event" => on_event(shared, conn_id, msg),
        "live" => on_live(shared, conn_id, msg),
        "resync" => match serde_json::from_value::<ResyncLine>(msg) {
            Ok(r) => {
                let resync = Resync {
                    seq: r.seq,
                    session_id: r.session_id,
                    session_file: r.session_file.filter(|f| !f.is_empty()),
                    leaf_id: r.leaf_id,
                    last_entry_id: r.last_entry_id.filter(|id| !id.is_empty()),
                    streaming: r.live.streaming,
                    frames: r.live.frames.into_iter().map(HostFrame::from_value).collect(),
                };
                to_feed(shared, conn_id, LiveMsg::Resync(resync));
            }
            Err(e) => warn!(conn_id, "bridge: bad resync: {e}"),
        },
        "bye" => {
            debug!(conn_id, "bridge bye");
            to_feed(shared, conn_id, LiveMsg::Bye);
        }
        other => debug!(conn_id, "bridge: ignoring frame {other:?}"),
    }
}

/// `{"t":"live","seq":N,"f":<collab host frame>}`.
fn on_live(shared: &Shared, conn_id: u64, mut msg: Value) {
    let Some(seq) = msg.get("seq").and_then(Value::as_u64) else {
        warn!(conn_id, "bridge: live frame without seq");
        return;
    };
    let Some(f) = msg.as_object_mut().and_then(|m| m.remove("f")) else {
        warn!(conn_id, seq, "bridge: live frame without f");
        return;
    };
    to_feed(shared, conn_id, LiveMsg::Frame { seq, frame: HostFrame::from_value(f) });
}

/// Hands a data-plane message to the connection's live feed. Without a subscription (none yet,
/// or one that a session switch ended) it is dropped: the next subscription starts with a resync.
fn to_feed(shared: &Shared, conn_id: u64, msg: LiveMsg) {
    let mut reg = lock(&shared.reg);
    let Some(conn) = reg.conns.get_mut(&conn_id) else { return };
    match &conn.feed {
        Some(tx) if conn.session.is_some() => {
            if tx.send(msg).is_err() {
                // The subscriber is gone (its session ended): stop routing until it re-subscribes.
                conn.feed = None;
            }
        }
        _ => {}
    }
}

fn on_hello(shared: &Shared, conn_id: u64, h: Hello) {
    // v1: control plane (bridge < 2.0); v2 adds the data plane. Anything newer is a newer bridge.
    if !(1..=BRIDGE_PROTOCOL).contains(&h.v) {
        warn!(
            conn_id,
            "bridge protocol {} (hostd speaks 1–{BRIDGE_PROTOCOL}); continuing", h.v
        );
    }
    let session = BridgeSession {
        pid: h.pid,
        session_id: h.session_id,
        session_file: h.session_file,
        cwd: h.cwd,
        omp_version: h.omp_version,
        bridge_version: h.bridge_version,
        tui: h.tui,
        state: h.state.unwrap_or_default(),
        connected_at: now_ms(),
        caps: h.caps,
        conn: conn_id,
    };
    let event = {
        let mut reg = lock(&shared.reg);
        // Several bridge copies in one omp process (the global install and the `-e` copy): 1.4.0+
        // copies elect one among themselves, older ones never negotiate. Only the newest bridge of a
        // process is routed; an older one stays connected without a session, its events ignored.
        let newer = reg.conns.iter().find_map(|(&id, c)| match &c.hello {
            Some((pid, v))
                if id != conn_id
                    && *pid == session.pid
                    && tf_proto::version::cmp_semver(v, &session.bridge_version)
                        .is_some_and(std::cmp::Ordering::is_gt) =>
            {
                Some(v.clone())
            }
            _ => None,
        });
        let Some(conn) = reg.conns.get_mut(&conn_id) else {
            return;
        };
        conn.hello = Some((session.pid, session.bridge_version.clone()));
        if let Some(newer) = newer {
            info!(
                pid = session.pid,
                version = %session.bridge_version,
                %newer,
                "older bridge copy in the same omp process left unrouted"
            );
            // A session it was still routed for (it said hello before the newer copy) goes with it.
            let dropped = conn.session.take();
            conn.feed = None;
            match dropped {
                Some(s) if reg.by_session.get(&s.session_id) == Some(&conn_id) => {
                    reg.by_session.remove(&s.session_id);
                    Some(BridgeEvent::Disconnected { pid: s.pid, session_id: s.session_id })
                }
                _ => None,
            }
        } else {
            let previous = conn.session.replace(session.clone()).map(|s| s.session_id);
            if previous.as_ref().is_some_and(|p| p != &session.session_id) {
                // A session switch ends the feed of the previous session; hostd subscribes anew.
                conn.feed = None;
            }
            if let Some(prev) = &previous
                && prev != &session.session_id
                && reg.by_session.get(prev) == Some(&conn_id)
            {
                reg.by_session.remove(prev);
            }
            if let Some(old) = reg.by_session.insert(session.session_id.clone(), conn_id)
                && old != conn_id
            {
                // A second process, an older bridge copy of this one, or a reconnect racing the old
                // socket's EOF: this hello takes the session over.
                if let Some(c) = reg.conns.get_mut(&old) {
                    c.session = None;
                    c.feed = None;
                }
            }
            Some(match previous {
                Some(prev) if prev != session.session_id => {
                    info!(pid = session.pid, from = %prev, to = %session.session_id, "bridge session switch");
                    BridgeEvent::SessionSwitch {
                        pid: session.pid,
                        previous_session_id: prev,
                        session,
                    }
                }
                Some(_) => BridgeEvent::State {
                    session_id: session.session_id.clone(),
                    state: session.state,
                },
                None => {
                    info!(
                        pid = session.pid,
                        session_id = %session.session_id,
                        version = %session.bridge_version,
                        "bridge connected"
                    );
                    BridgeEvent::Connected { session }
                }
            })
        }
    };
    if let Some(event) = event {
        let _ = shared.events.send(event);
    }
    if let Some(conn) = lock(&shared.reg).conns.get(&conn_id) {
        let _ = conn.tx.send(
            json!({ "t": "welcome", "v": BRIDGE_PROTOCOL, "hostd": crate::HOSTD_VERSION })
                .to_string(),
        );
    }
}

fn on_res(shared: &Shared, conn_id: u64, msg: &Value) {
    let Some(id) = msg.get("id").and_then(Value::as_u64) else {
        warn!(conn_id, "bridge: res without id");
        return;
    };
    let reply = if msg.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(msg.get("result").cloned().unwrap_or(Value::Null))
    } else {
        let err = msg
            .get("error")
            .cloned()
            .and_then(|e| serde_json::from_value::<ResError>(e).ok())
            .unwrap_or(ResError {
                code: "omp_error".into(),
                message: "request failed".into(),
            });
        Err(BridgeError::Rejected {
            op: String::new(),
            code: err.code,
            message: err.message,
        })
    };
    let waiter = lock(&shared.reg)
        .conns
        .get_mut(&conn_id)
        .and_then(|c| c.pending.remove(&id));
    match waiter {
        Some(tx) => {
            let _ = tx.send(reply);
        }
        None => debug!(conn_id, id, "bridge: late or unknown res"),
    }
}

fn on_event(shared: &Shared, conn_id: u64, msg: Value) {
    let name = msg
        .get("event")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let data = msg.get("data").cloned().unwrap_or(Value::Null);
    // Events are attributed to the connection's current session, not the frame's claim.
    let mut reg = lock(&shared.reg);
    let Some(session) = reg.conns.get_mut(&conn_id).and_then(|c| c.session.as_mut()) else {
        debug!(conn_id, "bridge: event {name} before hello");
        return;
    };
    let session_id = session.session_id.clone();
    let event = match name.as_str() {
        "state" => match serde_json::from_value::<CtlState>(data) {
            Ok(state) => {
                session.state = state.clone();
                Some(BridgeEvent::State { session_id, state })
            }
            Err(e) => {
                warn!("bridge: bad state: {e}");
                None
            }
        },
        "queue_update" => match serde_json::from_value::<QueueInfo>(data) {
            Ok(queue) => {
                session.state.queue = queue.clone();
                Some(BridgeEvent::QueueUpdate { session_id, queue })
            }
            Err(e) => {
                warn!("bridge: bad queue_update: {e}");
                None
            }
        },
        "plan_review_requested" => match serde_json::from_value::<PlanReviewInfo>(data) {
            Ok(review) => {
                session.state.plan_review = Some(review.clone());
                Some(BridgeEvent::PlanReviewRequested { session_id, review })
            }
            Err(e) => {
                warn!("bridge: bad plan_review_requested: {e}");
                None
            }
        },
        "plan_review_resolved" => match serde_json::from_value::<ResolvedFrame>(data) {
            Ok(r) => {
                if session
                    .state
                    .plan_review
                    .as_ref()
                    .is_some_and(|p| p.review_id == r.review_id)
                {
                    session.state.plan_review = None;
                }
                Some(BridgeEvent::PlanReviewResolved {
                    session_id,
                    review_id: r.review_id,
                    choice: r.choice,
                    by: r.by,
                })
            }
            Err(e) => {
                warn!("bridge: bad plan_review_resolved: {e}");
                None
            }
        },
        "btw_delta" => match serde_json::from_value::<BtwFrame>(data) {
            Ok(b) => Some(BridgeEvent::BtwDelta {
                session_id,
                btw_id: b.btw_id,
                turn: b.turn,
                question: b.question,
                text: b.text,
                done: b.done,
                error: b.error,
            }),
            Err(e) => {
                warn!("bridge: bad btw_delta: {e}");
                None
            }
        },
        other => {
            debug!("bridge: ignoring event {other}");
            None
        }
    };
    drop(reg);
    if let Some(event) = event {
        let _ = shared.events.send(event);
    }
}

fn on_close(shared: &Shared, conn_id: u64) {
    let (conn, owned) = {
        let mut reg = lock(&shared.reg);
        let Some(conn) = reg.conns.remove(&conn_id) else {
            return;
        };
        let owned = conn
            .session
            .as_ref()
            .is_some_and(|s| reg.by_session.get(&s.session_id) == Some(&conn_id));
        if owned && let Some(s) = &conn.session {
            reg.by_session.remove(&s.session_id);
        }
        (conn, owned)
    };
    for (_, tx) in conn.pending {
        let _ = tx.send(Err(BridgeError::Disconnected { op: String::new() }));
    }
    if let Some(s) = conn.session
        && owned
    {
        info!(pid = s.pid, session_id = %s.session_id, "bridge disconnected");
        let _ = shared.events.send(BridgeEvent::Disconnected {
            pid: s.pid,
            session_id: s.session_id,
        });
    }
}

// ─────────────────────────────────────────── tests ───────────────────────────────────────────

/// A scripted extension for tests (bridge, feed, routing): speaks the bridge protocol over the
/// handle's unix socket.
#[cfg(all(test, unix))]
pub(crate) mod fake {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixStream;
    use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};

    pub(crate) struct FakeExt {
        pub(crate) lines: tokio::io::Lines<BufReader<OwnedReadHalf>>,
        pub(crate) w: OwnedWriteHalf,
    }

    impl FakeExt {
        /// Connects and consumes hostd's `auth` frame (checking it carries the handle's secret).
        pub(crate) async fn connect(h: &BridgeHandle) -> Self {
            let mut ext = Self::connect_raw(h).await;
            let auth = ext.recv().await;
            assert_eq!(auth["t"], "auth");
            assert_eq!(auth["secret"], h.inner.shared.secret.as_str());
            ext
        }
        pub(crate) async fn connect_raw(h: &BridgeHandle) -> Self {
            let BridgeEndpoint::Unix(p) = h.endpoint();
            let (r, w) = UnixStream::connect(p).await.unwrap().into_split();
            FakeExt {
                lines: BufReader::new(r).lines(),
                w,
            }
        }
        pub(crate) async fn send(&mut self, v: Value) {
            self.w.write_all(format!("{v}\n").as_bytes()).await.unwrap();
        }
        pub(crate) async fn recv(&mut self) -> Value {
            let line = tokio::time::timeout(Duration::from_secs(5), self.lines.next_line())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            serde_json::from_str(&line).unwrap()
        }
        pub(crate) async fn recv_req(&mut self) -> Value {
            loop {
                let v = self.recv().await;
                if v["t"] == "req" {
                    return v;
                }
            }
        }
        /// Answers request `req` with `result`.
        pub(crate) async fn ok(&mut self, req: &Value, result: Value) {
            self.send(json!({ "t": "res", "id": req["id"], "ok": true, "result": result })).await;
        }
        pub(crate) async fn hello(&mut self, pid: u32, sid: &str) {
            self.hello_v(pid, sid, "1.0.0").await;
        }
        pub(crate) async fn hello_v(&mut self, pid: u32, sid: &str, bridge_version: &str) {
            self.hello_caps(pid, sid, bridge_version, None).await;
        }
        /// `hello` with `caps` (bridge ≥ 2.0) when given.
        pub(crate) async fn hello_caps(&mut self, pid: u32, sid: &str, bridge_version: &str, caps: Option<Value>) {
            let mut hello = json!({
                "t": "hello", "v": if caps.is_some() { 2 } else { 1 }, "reason": "connect", "pid": pid, "sessionId": sid,
                "sessionFile": format!("/tmp/{sid}.jsonl"), "cwd": "/w", "ompVersion": "18.12.3",
                "bridgeVersion": bridge_version, "tui": true,
                "state": { "model": { "provider": "openai-codex", "id": "gpt-6-luna", "label": "Luna" },
                           "thinking": "low", "fast": false, "mode": "normal", "idle": true,
                           "queue": { "steering": [], "followUp": [] }, "attached": false }
            });
            if let Some(caps) = caps {
                hello["caps"] = caps;
            }
            self.send(hello).await;
            // Registration is complete once hostd answers with `welcome`.
            assert_eq!(self.recv().await["t"], "welcome");
        }
        /// A `state` event titled `title` (tells which connection's events reach HostdCore).
        pub(crate) async fn state_titled(&mut self, sid: &str, title: &str) {
            self.send(json!({ "t": "event", "event": "state", "sessionId": sid, "data": {
                "fast": false, "mode": "normal", "idle": true, "title": title,
                "queue": { "steering": [], "followUp": [] }, "attached": false } }))
            .await;
        }
    }

    /// A handle on a fresh socket under the temp dir (the dir is returned for cleanup).
    pub(crate) fn handle() -> (BridgeHandle, std::path::PathBuf) {
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "tf-bridge-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let sock = dir.join("run").join("bridge.sock");
        (BridgeHandle::bind(BridgeEndpoint::Unix(sock), "ab".repeat(32)).unwrap(), dir)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::fake::{handle, FakeExt};
    use super::*;
    use tokio::io::AsyncWriteExt;

    /// Sends a request for `sid` and answers it on `ext` (which must be the one it is routed to).
    async fn assert_routed(h: &BridgeHandle, sid: &str, ext: &mut FakeExt) {
        let (h2, sid2) = (h.clone(), sid.to_owned());
        let call = tokio::spawn(async move { h2.rename(&sid2, "x").await });
        let req = ext.recv_req().await;
        assert_eq!(req["op"], "rename");
        ext.send(json!({ "t": "res", "id": req["id"], "ok": true, "result": { "title": "x" } }))
            .await;
        call.await.unwrap().unwrap();
    }

    /// The title of the next `State` event (skipping registration events).
    async fn next_state_title(rx: &mut broadcast::Receiver<BridgeEvent>) -> Option<String> {
        loop {
            if let BridgeEvent::State { state, .. } = next_event(rx).await {
                return state.title;
            }
        }
    }

    async fn next_event(rx: &mut broadcast::Receiver<BridgeEvent>) -> BridgeEvent {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .unwrap()
            .unwrap()
    }

    #[tokio::test]
    async fn bridge_hello_registers_session() {
        let (h, _dir) = handle();
        let mut events = h.subscribe();
        let mut ext = FakeExt::connect(&h).await;
        ext.hello(4242, "s1").await;
        let BridgeEvent::Connected { session } = next_event(&mut events).await else {
            panic!("expected Connected")
        };
        assert_eq!(session.pid, 4242);
        assert_eq!(session.state.thinking, Some(ThinkingLevel::Low));
        assert_eq!(session.state.model.as_ref().unwrap().id, "gpt-6-luna");
        assert!(h.is_connected("s1"));
        assert_eq!(h.by_pid(4242).unwrap().session_id, "s1");
        assert_eq!(h.sessions().len(), 1);
    }

    #[tokio::test]
    async fn bridge_socket_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let (h, _dir) = handle();
        let BridgeEndpoint::Unix(p) = h.endpoint();
        assert_eq!(
            std::fs::metadata(p).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[tokio::test]
    async fn bridge_start_writes_private_secret_and_presents_it_first() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let paths = crate::paths::Paths::new(dir.path().to_path_buf(), true);
        let h = BridgeHandle::start(&paths).unwrap();
        let secret = std::fs::read_to_string(&paths.bridge_secret).unwrap();
        assert_eq!(secret.len(), 64);
        assert!(secret.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(
            std::fs::metadata(&paths.bridge_secret).unwrap().permissions().mode() & 0o777,
            0o600
        );
        // Every connection gets the secret as its very first frame, before any hello.
        for _ in 0..2 {
            let mut ext = FakeExt::connect_raw(&h).await;
            assert_eq!(
                ext.recv().await,
                json!({ "t": "auth", "v": BRIDGE_PROTOCOL, "secret": secret })
            );
        }
        // A restart rotates the secret.
        drop(h);
        let _h = BridgeHandle::start(&paths).unwrap();
        assert_ne!(std::fs::read_to_string(&paths.bridge_secret).unwrap(), secret);
    }

    #[tokio::test]
    async fn bridge_typed_call_round_trip() {
        let (h, _dir) = handle();
        let mut ext = FakeExt::connect(&h).await;
        ext.hello(1, "s1").await;
        let h2 = h.clone();
        let call = tokio::spawn(async move {
            h2.set_model("s1", "anthropic/claude-x", Some(ThinkingLevel::High))
                .await
        });
        let req = ext.recv_req().await;
        assert_eq!(req["op"], "setModel");
        assert_eq!(req["params"]["model"], "anthropic/claude-x");
        assert_eq!(req["params"]["thinking"], "high");
        ext.send(json!({ "t": "res", "id": req["id"], "ok": true, "result": {
            "model": { "provider": "anthropic", "id": "claude-x" }, "thinking": "high", "fast": false,
            "mode": "plan", "idle": true, "queue": { "steering": [], "followUp": ["later"] }, "attached": true
        }}))
        .await;
        let state = call.await.unwrap().unwrap();
        assert_eq!(state.thinking, Some(ThinkingLevel::High));
        assert_eq!(state.mode, OmpMode::Plan);
        assert_eq!(state.queue.follow_up, vec!["later".to_string()]);
    }

    #[tokio::test]
    async fn bridge_rejection_maps_to_api_error() {
        let (h, _dir) = handle();
        let mut ext = FakeExt::connect(&h).await;
        ext.hello(1, "s1").await;
        let h2 = h.clone();
        let call = tokio::spawn(async move { h2.compact("s1", None).await });
        let req = ext.recv_req().await;
        ext.send(json!({ "t": "res", "id": req["id"], "ok": false,
            "error": { "code": "nothing_to_compact", "message": "Nothing to compact" } }))
            .await;
        let err = call.await.unwrap().unwrap_err();
        assert_eq!(
            err,
            BridgeError::Rejected {
                op: "compact".into(),
                code: "nothing_to_compact".into(),
                message: "Nothing to compact".into()
            }
        );
        let api = ApiError::from(err);
        assert_eq!(api.code, "omp_error");
        assert_eq!(api.message, "Nothing to compact");

        let busy = ApiError::from(BridgeError::Rejected {
            op: "fork".into(),
            code: "busy".into(),
            message: "x".into(),
        });
        assert_eq!((busy.code.as_str(), busy.retryable), ("busy", true));
    }

    #[tokio::test]
    async fn bridge_not_connected_and_timeout() {
        let (h, _dir) = handle();
        let err = h.get_tree("nope").await.unwrap_err();
        assert!(matches!(err, BridgeError::NotConnected { .. }));
        assert_eq!(ApiError::from(err).code, "not_connected");

        let mut ext = FakeExt::connect(&h).await;
        ext.hello(1, "s1").await;
        let err = h
            .call("s1", "getState", json!({}), Duration::from_millis(150))
            .await
            .unwrap_err();
        assert!(matches!(err, BridgeError::Timeout { .. }));
        // The late answer is dropped quietly and the connection stays usable.
        let late = ext.recv_req().await;
        ext.send(json!({ "t": "res", "id": late["id"], "ok": true, "result": {} }))
            .await;
        let h2 = h.clone();
        let call = tokio::spawn(async move { h2.rename("s1", "x").await });
        let req = ext.recv_req().await;
        assert_eq!(req["op"], "rename");
        ext.send(json!({ "t": "res", "id": req["id"], "ok": true, "result": { "title": "x" } }))
            .await;
        call.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn bridge_rehello_is_a_session_switch() {
        let (h, _dir) = handle();
        let mut events = h.subscribe();
        let mut ext = FakeExt::connect(&h).await;
        ext.hello(7, "old").await;
        assert!(matches!(
            next_event(&mut events).await,
            BridgeEvent::Connected { .. }
        ));
        ext.hello(7, "new").await;
        let BridgeEvent::SessionSwitch {
            pid,
            previous_session_id,
            session,
        } = next_event(&mut events).await
        else {
            panic!("expected SessionSwitch")
        };
        assert_eq!(
            (
                pid,
                previous_session_id.as_str(),
                session.session_id.as_str()
            ),
            (7, "old", "new")
        );
        assert!(!h.is_connected("old"));
        assert!(h.is_connected("new"));
    }

    #[tokio::test]
    async fn bridge_same_process_older_then_newer_copy() {
        // The global 1.1.0 install says hello first, then the `-e` copy of the same omp process.
        let (h, _dir) = handle();
        let mut events = h.subscribe();
        let mut old = FakeExt::connect(&h).await;
        old.hello_v(7, "s1", "1.1.0").await;
        let mut new = FakeExt::connect(&h).await;
        new.hello_v(7, "s1", "1.4.0").await;
        assert_eq!(h.by_session("s1").unwrap().bridge_version, "1.4.0");
        assert_routed(&h, "s1", &mut new).await;
        old.state_titled("s1", "old").await;
        new.state_titled("s1", "new").await;
        assert_eq!(next_state_title(&mut events).await.as_deref(), Some("new"));
        // The older copy's event is dropped, not merely late.
        assert!(tokio::time::timeout(Duration::from_millis(300), next_state_title(&mut events)).await.is_err());
        // Session switch: the older copy's hello can arrive first; it does not take the new session.
        old.hello_v(7, "s2", "1.1.0").await;
        assert!(!h.is_connected("s2"));
        new.hello_v(7, "s2", "1.4.0").await;
        assert!(!h.is_connected("s1"));
        assert_eq!(h.by_session("s2").unwrap().bridge_version, "1.4.0");
        assert_routed(&h, "s2", &mut new).await;
    }

    #[tokio::test]
    async fn bridge_same_process_newer_then_older_copy() {
        let (h, _dir) = handle();
        let mut events = h.subscribe();
        let mut new = FakeExt::connect(&h).await;
        new.hello_v(7, "s1", "1.4.0").await;
        assert!(matches!(next_event(&mut events).await, BridgeEvent::Connected { .. }));
        let mut old = FakeExt::connect(&h).await;
        old.hello_v(7, "s1", "1.3.0").await;
        assert_eq!(h.by_session("s1").unwrap().bridge_version, "1.4.0");
        assert_routed(&h, "s1", &mut new).await;
        old.state_titled("s1", "old").await;
        new.state_titled("s1", "new").await;
        assert_eq!(next_state_title(&mut events).await.as_deref(), Some("new"));
        assert!(tokio::time::timeout(Duration::from_millis(300), next_state_title(&mut events)).await.is_err());
    }

    #[tokio::test]
    async fn bridge_same_process_older_copy_loses_its_stale_session() {
        // The older copy is still routed for the previous session when the newer one (reconnecting
        // after a switch) says hello for the current one; the older copy's own hello then drops it.
        let (h, _dir) = handle();
        let mut events = h.subscribe();
        let mut old = FakeExt::connect(&h).await;
        old.hello_v(9, "a", "1.1.0").await;
        let mut new = FakeExt::connect(&h).await;
        new.hello_v(9, "b", "1.4.0").await;
        old.hello_v(9, "b", "1.1.0").await;
        assert!(!h.is_connected("a"));
        assert_eq!(h.by_session("b").unwrap().bridge_version, "1.4.0");
        assert_routed(&h, "b", &mut new).await;
        let mut gone = None;
        for _ in 0..3 {
            if let BridgeEvent::Disconnected { session_id, .. } = next_event(&mut events).await {
                gone = Some(session_id);
                break;
            }
        }
        assert_eq!(gone.as_deref(), Some("a"));
    }

    #[tokio::test]
    async fn bridge_same_process_equal_versions_latest_hello_wins() {
        let (h, _dir) = handle();
        let mut a = FakeExt::connect(&h).await;
        a.hello_v(7, "s1", "1.3.0").await;
        let mut b = FakeExt::connect(&h).await;
        b.hello_v(7, "s1", "1.3.0").await;
        assert_routed(&h, "s1", &mut b).await;
        a.hello_v(7, "s1", "1.3.0").await;
        assert_routed(&h, "s1", &mut a).await;
    }

    #[tokio::test]
    async fn bridge_other_process_takes_the_session_over_whatever_its_version() {
        let (h, _dir) = handle();
        let mut first = FakeExt::connect(&h).await;
        first.hello_v(7, "s1", "1.4.0").await;
        let mut second = FakeExt::connect(&h).await;
        second.hello_v(8, "s1", "1.1.0").await;
        assert_eq!(h.by_session("s1").unwrap().pid, 8);
        assert_routed(&h, "s1", &mut second).await;
    }

    #[tokio::test]
    async fn bridge_events_update_state_and_stream() {
        let (h, _dir) = handle();
        let mut events = h.subscribe();
        let mut ext = FakeExt::connect(&h).await;
        ext.hello(1, "s1").await;
        let _ = next_event(&mut events).await;
        ext.send(
            json!({ "t": "event", "event": "state", "sessionId": "s1", "data": {
            "thinking": "medium", "fast": true, "mode": "planPaused", "idle": false, "title": "T",
            "context": { "tokens": 1200, "window": 272000, "pct": 0.4 },
            "goal": { "objective": "ship", "status": "active", "tokensUsed": 10 },
            "queue": { "steering": [], "followUp": [] }, "attached": true } }),
        )
        .await;
        let BridgeEvent::State { state, .. } = next_event(&mut events).await else {
            panic!("expected State")
        };
        assert_eq!(state.thinking, Some(ThinkingLevel::Medium));
        assert!(state.fast && !state.idle && state.attached);
        assert_eq!(state.mode, OmpMode::PlanPaused);
        assert_eq!(state.goal.as_ref().unwrap().objective, "ship");
        assert_eq!(
            h.by_session("s1").unwrap().state.title.as_deref(),
            Some("T")
        );

        ext.send(
            json!({ "t": "event", "event": "queue_update", "sessionId": "s1",
            "data": { "steering": ["a"], "followUp": ["b", "c"] } }),
        )
        .await;
        let BridgeEvent::QueueUpdate { queue, .. } = next_event(&mut events).await else {
            panic!("expected QueueUpdate")
        };
        assert_eq!(queue.follow_up.len(), 2);

        ext.send(json!({ "t": "event", "event": "plan_review_requested", "sessionId": "s1", "data": {
            "reviewId": "r1", "title": "Plan", "planPath": "local://PLAN.md", "content": "# do it",
            "choices": [{ "id": "execute", "label": "Approve and execute", "disabled": false }],
            "tiers": [{ "role": "default", "provider": "openai", "model": "gpt", "thinkingLevel": null }] } }))
        .await;
        let BridgeEvent::PlanReviewRequested { review, .. } = next_event(&mut events).await else {
            panic!()
        };
        assert_eq!(review.choices[0].id, "execute");
        assert!(h.by_session("s1").unwrap().state.plan_review.is_some());
        ext.send(
            json!({ "t": "event", "event": "plan_review_resolved", "sessionId": "s1",
            "data": { "reviewId": "r1", "choice": null, "by": "local" } }),
        )
        .await;
        let BridgeEvent::PlanReviewResolved { choice, by, .. } = next_event(&mut events).await
        else {
            panic!()
        };
        assert_eq!((choice, by.as_str()), (None, "local"));
        assert!(h.by_session("s1").unwrap().state.plan_review.is_none());

        for (i, (text, done)) in [("Hel", false), ("lo", false), ("Hello", true)].into_iter().enumerate() {
            let mut data = json!({ "btwId": "b1", "turn": 1, "text": text, "done": done });
            if i == 0 {
                data["question"] = json!("and then?");
            }
            ext.send(json!({ "t": "event", "event": "btw_delta", "sessionId": "s1", "data": data }))
                .await;
        }
        let mut got = Vec::new();
        for _ in 0..3 {
            let BridgeEvent::BtwDelta {
                btw_id, turn, question, text, done, ..
            } = next_event(&mut events).await
            else {
                panic!()
            };
            assert_eq!((btw_id.as_str(), turn), ("b1", 1));
            got.push((question, text, done));
        }
        assert_eq!(got[0].0.as_deref(), Some("and then?"));
        assert_eq!(got[1].0, None);
        assert_eq!((got[2].1.as_str(), got[2].2), ("Hello", true));
        // Frames from older bridges carry no turn: it defaults to the first one.
        ext.send(json!({ "t": "event", "event": "btw_delta", "sessionId": "s1",
            "data": { "btwId": "b2", "text": "x", "done": true } }))
            .await;
        let BridgeEvent::BtwDelta { turn, question, .. } = next_event(&mut events).await else {
            panic!()
        };
        assert_eq!((turn, question), (0, None));
    }

    #[tokio::test]
    async fn bridge_disconnect_fails_pending_and_unregisters() {
        let (h, _dir) = handle();
        let mut events = h.subscribe();
        let mut ext = FakeExt::connect(&h).await;
        ext.hello(9, "s1").await;
        let _ = next_event(&mut events).await;
        let h2 = h.clone();
        let call = tokio::spawn(async move { h2.get_queue("s1").await });
        let _ = ext.recv_req().await;
        drop(ext);
        let err = call.await.unwrap().unwrap_err();
        assert!(matches!(err, BridgeError::Disconnected { .. }));
        let BridgeEvent::Disconnected { pid, session_id } = next_event(&mut events).await else {
            panic!()
        };
        assert_eq!((pid, session_id.as_str()), (9, "s1"));
        assert!(!h.is_connected("s1"));
    }

    #[tokio::test]
    async fn bridge_garbage_is_ignored() {
        let (h, _dir) = handle();
        let mut ext = FakeExt::connect(&h).await;
        ext.w.write_all(b"not json\n{\"t\":\"event\",\"event\":\"state\"}\n{\"t\":\"res\",\"id\":99,\"ok\":true}\n").await.unwrap();
        ext.send(json!({ "t": "hello", "pid": 3, "sessionId": "s1", "state": { "thinking": "ultra-mega", "mode": "warp" } })).await;
        assert_eq!(ext.recv().await["t"], "welcome");
        let s = h.by_session("s1").unwrap();
        assert_eq!((s.state.thinking, s.state.mode), (None, OmpMode::Normal));
    }

    const CAPS: &str = r#"{"live":1,"dialogs":true,"subagentCtl":false,"prompt":true}"#;

    /// Subscribes `sid` on `ext`: the extension writes the resync before its `res`.
    async fn subscribe(h: &BridgeHandle, sid: &str, ext: &mut FakeExt, seq: u64) -> LiveFeed {
        let (h2, sid2) = (h.clone(), sid.to_owned());
        let call = tokio::spawn(async move { h2.live_subscribe(&sid2).await });
        let req = ext.recv_req().await;
        assert_eq!(req["op"], "liveSubscribe");
        ext.send(json!({ "t": "resync", "seq": seq, "sessionId": sid, "sessionFile": "/s.jsonl", "lastEntryId": "e9",
            "live": { "streaming": true, "frames": [{ "t": "state", "state": { "isStreaming": true } }] } }))
            .await;
        ext.ok(&req, json!({})).await;
        call.await.unwrap().unwrap()
    }

    async fn next_live(feed: &mut LiveFeed) -> Option<LiveMsg> {
        tokio::time::timeout(Duration::from_secs(5), feed.rx.recv()).await.unwrap()
    }

    #[tokio::test]
    async fn live_feed_is_ordered_and_ends_with_its_session() {
        let (h, _dir) = handle();
        let mut ext = FakeExt::connect(&h).await;
        ext.hello_caps(5, "s1", "2.0.0", Some(serde_json::from_str(CAPS).unwrap())).await;
        let s = h.by_session("s1").unwrap();
        assert!(s.caps.data_plane() && s.caps.dialogs && !s.caps.subagent_ctl);
        // Frames sent before anyone subscribed are dropped (the subscription starts with a resync).
        ext.send(json!({ "t": "live", "seq": 1, "f": { "t": "event", "event": { "type": "agent_start" } } })).await;
        let mut feed = subscribe(&h, "s1", &mut ext, 2).await;
        // A frame that raced the subscription may come first; the consumer skips it (it precedes
        // the resync). The resync is next, then the frames in order.
        let r = loop {
            match next_live(&mut feed).await {
                Some(LiveMsg::Resync(r)) => break r,
                Some(LiveMsg::Frame { seq: 1, .. }) => continue,
                other => panic!("resync first, got {other:?}"),
            }
        };
        assert_eq!((r.seq, r.last_entry_id.as_deref(), r.streaming, r.frames.len()), (2, Some("e9"), true, 1));
        ext.send(json!({ "t": "live", "seq": 3, "f": { "t": "event", "event": { "type": "message_start" } } })).await;
        ext.send(json!({ "t": "live", "seq": 4, "f": { "t": "ui-request-end", "reqId": 7 } })).await;
        assert!(matches!(next_live(&mut feed).await, Some(LiveMsg::Frame { seq: 3, frame: HostFrame::Event { .. } })));
        assert!(matches!(next_live(&mut feed).await, Some(LiveMsg::Frame { seq: 4, frame: HostFrame::UiRequestEnd { req_id: 7 } })));
        // A session switch on the connection ends the feed of the old session.
        ext.send(json!({ "t": "hello", "v": 2, "reason": "switch", "pid": 5, "sessionId": "s2", "caps": serde_json::from_str::<Value>(CAPS).unwrap() })).await;
        assert_eq!(ext.recv().await["t"], "welcome");
        assert_eq!(next_live(&mut feed).await, None);
        // The new session subscribes anew; `bye`, then the closed connection, end it.
        let mut feed = subscribe(&h, "s2", &mut ext, 5).await;
        assert!(matches!(next_live(&mut feed).await, Some(LiveMsg::Resync(_))));
        ext.send(json!({ "t": "bye", "sessionId": "s2" })).await;
        assert_eq!(next_live(&mut feed).await, Some(LiveMsg::Bye));
        drop(ext);
        assert_eq!(next_live(&mut feed).await, None);
    }

    #[tokio::test]
    async fn data_plane_ops_send_exact_shapes() {
        let (h, _dir) = handle();
        let mut ext = FakeExt::connect(&h).await;
        ext.hello_caps(5, "s1", "2.0.0", Some(serde_json::from_str(CAPS).unwrap())).await;
        let h2 = h.clone();
        let call = tokio::spawn(async move {
            let img = ImageContent::new("aGk=", "image/png");
            h2.prompt("s1", "look", &[img], Delivery::FollowUp).await
        });
        let req = ext.recv_req().await;
        assert_eq!(req["op"], "prompt");
        assert_eq!(req["params"], json!({ "text": "look", "images": [{ "type": "image", "data": "aGk=", "mimeType": "image/png" }], "delivery": "followUp" }));
        ext.ok(&req, json!({ "queued": true })).await;
        assert!(call.await.unwrap().unwrap());

        let h2 = h.clone();
        let call = tokio::spawn(async move { h2.ui_response("s1", 12, Some("Blue")).await });
        let req = ext.recv_req().await;
        assert_eq!((req["op"].clone(), req["params"].clone()), (json!("uiResponse"), json!({ "reqId": 12, "value": "Blue" })));
        ext.ok(&req, json!({})).await;
        call.await.unwrap().unwrap();

        let h2 = h.clone();
        let call = tokio::spawn(async move { h2.ui_response("s1", 13, None).await });
        let req = ext.recv_req().await;
        assert_eq!(req["params"], json!({ "reqId": 13, "value": null }), "a cancel is a null value");
        ext.ok(&req, json!({})).await;
        call.await.unwrap().unwrap();

        let h2 = h.clone();
        let call = tokio::spawn(async move { h2.agent_cmd("s1", AgentCmdKind::Chat, "Sub", Some("go on")).await });
        let req = ext.recv_req().await;
        assert_eq!((req["op"].clone(), req["params"].clone()), (json!("agentCmd"), json!({ "cmd": "chat", "agentId": "Sub", "text": "go on" })));
        ext.ok(&req, json!({})).await;
        call.await.unwrap().unwrap();
    }
}
