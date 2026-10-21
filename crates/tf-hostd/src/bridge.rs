//! Companion-extension bridge (architecture §4, wire format: `docs/bridge-protocol.md`).
//!
//! omp sessions that load `host/teleflock-bridge/teleflock-bridge.ts` connect to
//! `~/.teleflock/run/bridge.sock` (Windows: the `bridge_pipe` named pipe, owner-only DACL), receive
//! an `auth` frame carrying the secret from `run/bridge.secret`, say `hello`, push events, and
//! answer control requests. This module owns that socket and exposes:
//!
//! * a registry of connected sessions keyed by omp `sessionId` (pid cross-check via [`BridgeHandle::by_pid`]),
//! * typed async control calls with per-op timeouts and typed errors ([`BridgeError`] → [`ApiError`]),
//! * a broadcast stream of [`BridgeEvent`]s for HostdCore.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use tf_proto::{
    ApiError, CommandList, ContextUsage, Dequeued, ExportResult, ForkPlacement, GoalInfo, GoalOp, Millis,
    ModelRef, OmpMode, QueueInfo, ThinkingLevel, TreeInfo,
};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};

/// Bridge wire protocol version (the `v` field of `hello`).
pub const BRIDGE_PROTOCOL: u32 = 1;
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
    /// Side-question stream: while `done` is false `text` is a delta; the `done` event carries the
    /// full final reply in `text` (or `error`).
    BtwDelta {
        session_id: String,
        btw_id: String,
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
    session: Option<BridgeSession>,
    pending: HashMap<u64, oneshot::Sender<Reply>>,
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
        let id = self.inner.shared.next_req.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        let conn_id = {
            let mut reg = self.reg();
            let Some(&conn_id) = reg.by_session.get(session_id) else {
                return Err(BridgeError::NotConnected {
                    session_id: session_id.to_owned(),
                });
            };
            let conn = reg
                .conns
                .get_mut(&conn_id)
                .expect("by_session points at a live conn");
            let line = json!({ "t": "req", "id": id, "op": op, "params": params }).to_string();
            if conn.tx.send(line).is_err() {
                return Err(BridgeError::Disconnected { op: op.to_owned() });
            }
            conn.pending.insert(id, tx);
            conn_id
        };
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

    /// Starts a side question; the answer streams as [`BridgeEvent::BtwDelta`]. Returns the btw id.
    pub async fn btw(&self, session_id: &str, question: &str) -> Result<String, BridgeError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Started {
            btw_id: String,
        }
        let started: Started = self
            .typed(session_id, "btw", json!({ "question": question }), QUICK)
            .await?;
        Ok(started.btw_id)
    }

    pub async fn btw_cancel(&self, session_id: &str, btw_id: &str) -> Result<(), BridgeError> {
        self.unit(session_id, "btwCancel", json!({ "btwId": btw_id }), QUICK)
            .await
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
            pending: HashMap::new(),
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
        "bye" => debug!(conn_id, "bridge bye"),
        other => debug!(conn_id, "bridge: ignoring frame {other:?}"),
    }
}

fn on_hello(shared: &Shared, conn_id: u64, h: Hello) {
    if h.v != BRIDGE_PROTOCOL {
        warn!(
            conn_id,
            "bridge protocol {} (hostd speaks {BRIDGE_PROTOCOL}); continuing", h.v
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
    };
    let event = {
        let mut reg = lock(&shared.reg);
        let Some(conn) = reg.conns.get_mut(&conn_id) else {
            return;
        };
        let previous = conn.session.replace(session.clone()).map(|s| s.session_id);
        if let Some(prev) = &previous
            && prev != &session.session_id
            && reg.by_session.get(prev) == Some(&conn_id)
        {
            reg.by_session.remove(prev);
        }
        if let Some(old) = reg.by_session.insert(session.session_id.clone(), conn_id)
            && old != conn_id
        {
            // A second process (or a reconnect racing the old socket's EOF) took over this session.
            if let Some(c) = reg.conns.get_mut(&old) {
                c.session = None;
            }
        }
        match previous {
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
                info!(pid = session.pid, session_id = %session.session_id, "bridge connected");
                BridgeEvent::Connected { session }
            }
        }
    };
    let _ = shared.events.send(event);
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixStream;
    use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};

    struct FakeExt {
        lines: tokio::io::Lines<BufReader<OwnedReadHalf>>,
        w: OwnedWriteHalf,
    }

    impl FakeExt {
        /// Connects and consumes hostd's `auth` frame (checking it carries the handle's secret).
        async fn connect(h: &BridgeHandle) -> Self {
            let mut ext = Self::connect_raw(h).await;
            let auth = ext.recv().await;
            assert_eq!(auth["t"], "auth");
            assert_eq!(auth["secret"], h.inner.shared.secret.as_str());
            ext
        }
        async fn connect_raw(h: &BridgeHandle) -> Self {
            let BridgeEndpoint::Unix(p) = h.endpoint();
            let (r, w) = UnixStream::connect(p).await.unwrap().into_split();
            FakeExt {
                lines: BufReader::new(r).lines(),
                w,
            }
        }
        async fn send(&mut self, v: Value) {
            self.w.write_all(format!("{v}\n").as_bytes()).await.unwrap();
        }
        async fn recv(&mut self) -> Value {
            let line = tokio::time::timeout(Duration::from_secs(5), self.lines.next_line())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            serde_json::from_str(&line).unwrap()
        }
        async fn recv_req(&mut self) -> Value {
            loop {
                let v = self.recv().await;
                if v["t"] == "req" {
                    return v;
                }
            }
        }
        async fn hello(&mut self, pid: u32, sid: &str) {
            self.send(json!({
                "t": "hello", "v": 1, "reason": "connect", "pid": pid, "sessionId": sid,
                "sessionFile": format!("/tmp/{sid}.jsonl"), "cwd": "/w", "ompVersion": "18.12.3",
                "bridgeVersion": "1.0.0", "tui": true,
                "state": { "model": { "provider": "openai-codex", "id": "gpt-6-luna", "label": "Luna" },
                           "thinking": "low", "fast": false, "mode": "normal", "idle": true,
                           "queue": { "steering": [], "followUp": [] }, "attached": false }
            }))
            .await;
            // Registration is complete once hostd answers with `welcome`.
            assert_eq!(self.recv().await["t"], "welcome");
        }
    }

    fn handle() -> (BridgeHandle, std::path::PathBuf) {
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "tf-bridge-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let sock = dir.join("run").join("bridge.sock");
        (BridgeHandle::bind(BridgeEndpoint::Unix(sock), "ab".repeat(32)).unwrap(), dir)
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

        for (text, done) in [("Hel", false), ("lo", false), ("Hello", true)] {
            ext.send(
                json!({ "t": "event", "event": "btw_delta", "sessionId": "s1",
                "data": { "btwId": "b1", "text": text, "done": done } }),
            )
            .await;
        }
        let mut got = Vec::new();
        for _ in 0..3 {
            let BridgeEvent::BtwDelta {
                btw_id, text, done, ..
            } = next_event(&mut events).await
            else {
                panic!()
            };
            assert_eq!(btw_id, "b1");
            got.push((text, done));
        }
        assert_eq!(got.last().unwrap(), &("Hello".to_string(), true));
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
}
