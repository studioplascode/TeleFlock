//! Protocol client for one `tf-hostd attach` stdio stream (JSON lines,
//! `tf_proto::host::{ClientMsg, ServerMsg}`): hello/welcome, snapshot + patches with
//! revision-gap resync, request correlation with timeouts, liveness by unanswered pings, and
//! passthrough of pulse/session/term/notify messages to a [`LinkSink`].

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tf_proto::{ApiError, ClientMsg, HostState, Millis, ServerMsg, StatePatch};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader, Lines};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant;

use crate::util::now_ms;

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
pub const TERM_OPEN_TIMEOUT: Duration = Duration::from_secs(15);
/// Methods that may start an omp agent: hostd answers once it is launched, which on a slow
/// host means waiting for a new pane's shell (up to 45 s) and for omp to become interactive
/// (up to 90 s), plus the worktree for `worktree.create`.
pub const LAUNCH_TIMEOUT: Duration = Duration::from_secs(180);
pub const PING_EVERY: Duration = Duration::from_secs(15);
/// The link is dead once nothing at all arrived since a ping sent this long ago (`Pings`).
pub const PING_DEADLINE: Duration = Duration::from_secs(30);
/// `attach` waits up to 30 s for a daemon it starts, the daemon then creates the herdr session
/// context (starting herdr waits up to 15 s) before it welcomes the client; slow hosts need it.
pub const WELCOME_TIMEOUT: Duration = Duration::from_secs(60);
pub const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(30);

/// Receives everything the daemon pushes. Called from the link's reader task, in order.
pub trait LinkSink: Send + Sync + 'static {
    /// Full state (initial snapshot or a resync after a revision gap).
    fn snapshot(&self, rev: u64, state: HostState);
    fn patch(&self, rev: u64, ops: Vec<StatePatch>);
    /// `Pulse`, `Session`, `Term`, `Notify`.
    fn push(&self, msg: ServerMsg);
    fn latency(&self, ms: u32);
}

pub fn timeout_for(method: &str) -> Duration {
    match method {
        "term.open" => TERM_OPEN_TIMEOUT,
        // `agent.archive {archived: false}` and `agent.prompt` resume a parked agent.
        "agent.start" | "agent.resume" | "agent.archive" | "agent.prompt" | "host.resume" | "worktree.create"
        | "automation.run" => LAUNCH_TIMEOUT,
        _ => DEFAULT_TIMEOUT,
    }
}

enum Pending {
    Waiter(oneshot::Sender<Result<Value, ApiError>>),
    Resync,
}

type Reader = Lines<BufReader<Box<dyn AsyncRead + Send + Unpin>>>;

pub struct Link {
    out: mpsc::UnboundedSender<String>,
    pending: Mutex<HashMap<u64, Pending>>,
    next_id: AtomicU64,
    /// Messages received so far: did anything arrive since a ping?
    rx_count: AtomicU64,
    /// When the last message arrived, in ms since `born`. tokio's clock: monotonic (unlike the
    /// wall clock, it never jumps), paused in tests.
    last_rx: AtomicU64,
    born: Instant,
    closed_tx: watch::Sender<Option<String>>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    pub hostd_version: String,
    pub client_id: String,
}

fn line(msg: &ClientMsg) -> String {
    serde_json::to_string(msg).expect("ClientMsg serializes")
}

fn not_connected(reason: &str) -> ApiError {
    ApiError::new("not_connected", format!("connection to tf-hostd lost: {reason}")).retryable()
}

/// Reads the next `ServerMsg`, skipping unparsable lines. `Ok(None)` = EOF.
async fn next_msg(lines: &mut Reader) -> std::io::Result<Option<ServerMsg>> {
    loop {
        let Some(l) = lines.next_line().await? else { return Ok(None) };
        let l = l.trim();
        if l.is_empty() {
            continue;
        }
        match serde_json::from_str::<ServerMsg>(l) {
            Ok(m) => return Ok(Some(m)),
            Err(e) => log::warn!("tf-hostd: unparsable line ({e}): {}", l.chars().take(200).collect::<String>()),
        }
    }
}

fn tail_text(tail: &Mutex<VecDeque<String>>) -> String {
    tail.lock().unwrap().iter().cloned().collect::<Vec<_>>().join(" | ")
}

async fn wait_closed(rx: &mut watch::Receiver<Option<String>>) {
    let _ = rx.wait_for(|c| c.is_some()).await.map(|_| ());
}

impl Link {
    /// Performs the handshake (hello → welcome → snapshot) and starts the reader, writer and
    /// ping tasks. The first snapshot is delivered to `sink` before this returns.
    pub async fn establish(
        stdin: Box<dyn AsyncWrite + Send + Unpin>,
        stdout: Box<dyn AsyncRead + Send + Unpin>,
        stderr: Option<Box<dyn AsyncRead + Send + Unpin>>,
        hello: ClientMsg,
        sink: Arc<dyn LinkSink>,
    ) -> Result<Arc<Link>, ApiError> {
        let tail = Arc::new(Mutex::new(VecDeque::new()));
        if let Some(err) = stderr {
            let tail = tail.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(err).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    log::info!("{l}");
                    let mut t = tail.lock().unwrap();
                    if t.len() == 4 {
                        t.pop_front();
                    }
                    t.push_back(l);
                }
            });
        }

        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
        let (closed_tx, closed_rx) = watch::channel::<Option<String>>(None);
        {
            let mut closed = closed_rx.clone();
            let closed_tx = closed_tx.clone();
            let mut w = stdin;
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        m = out_rx.recv() => {
                            let Some(mut m) = m else { break };
                            m.push('\n');
                            // Batch whatever is queued (keystrokes, bursts of requests).
                            while let Ok(more) = out_rx.try_recv() {
                                m.push_str(&more);
                                m.push('\n');
                            }
                            if let Err(e) = async { w.write_all(m.as_bytes()).await?; w.flush().await }.await {
                                closed_tx.send_if_modified(|c| {
                                    c.get_or_insert_with(|| format!("write failed: {e}"));
                                    true
                                });
                                break;
                            }
                        }
                        _ = wait_closed(&mut closed) => break,
                    }
                }
                let _ = w.shutdown().await;
            });
        }

        let mut lines: Reader = BufReader::new(stdout).lines();
        out_tx.send(line(&hello)).ok();

        let eof = |tail: &Mutex<VecDeque<String>>| {
            let t = tail_text(tail);
            ApiError::new(
                "not_connected",
                if t.is_empty() { "tf-hostd attach exited during the handshake".to_string() } else { t },
            )
            .retryable()
        };
        let welcome = tokio::time::timeout(WELCOME_TIMEOUT, async {
            loop {
                match next_msg(&mut lines).await {
                    Ok(Some(ServerMsg::Welcome { hostd_version, client_id, protocol })) => {
                        return Ok((hostd_version, client_id, protocol));
                    }
                    Ok(Some(ServerMsg::Error { error })) => return Err(error),
                    Ok(Some(other)) => log::debug!("tf-hostd: ignoring pre-welcome message {other:?}"),
                    Ok(None) => {
                        // Give the stderr reader a moment to capture the reason.
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        return Err(eof(&tail));
                    }
                    Err(e) => return Err(ApiError::new("io_error", format!("reading tf-hostd: {e}")).retryable()),
                }
            }
        })
        .await;
        let fail = |e: ApiError| {
            closed_tx.send_replace(Some(e.message.clone()));
            e
        };
        let (hostd_version, client_id, protocol) = match welcome {
            Ok(Ok(w)) => w,
            Ok(Err(e)) => return Err(fail(e)),
            Err(_) => {
                let t = tail_text(&tail);
                return Err(fail(
                    ApiError::new(
                        "timeout",
                        format!("no welcome from tf-hostd within {}s{}", WELCOME_TIMEOUT.as_secs(), if t.is_empty() { String::new() } else { format!(": {t}") }),
                    )
                    .retryable(),
                ));
            }
        };
        if protocol != tf_proto::PROTOCOL_VERSION {
            let e = ApiError::new(
                "version_mismatch",
                format!("tf-hostd {hostd_version} speaks protocol {protocol}, this app speaks {}", tf_proto::PROTOCOL_VERSION),
            );
            return Err(fail(if protocol > tf_proto::PROTOCOL_VERSION {
                e.with_hint("A newer TeleFlock on another device installed it. Update TeleFlock on this device.")
            } else {
                e
            }));
        }

        let link = Arc::new(Link {
            out: out_tx,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            rx_count: AtomicU64::new(0),
            last_rx: AtomicU64::new(0),
            born: Instant::now(),
            closed_tx,
            stderr_tail: tail,
            hostd_version,
            client_id,
        });

        // First snapshot.
        let first = tokio::time::timeout(SNAPSHOT_TIMEOUT, async {
            loop {
                match next_msg(&mut lines).await {
                    Ok(Some(ServerMsg::Snapshot { rev, state })) => return Ok((rev, state)),
                    Ok(Some(ServerMsg::Error { error })) => return Err(error),
                    Ok(Some(other)) => link.handle_other(other, &sink),
                    Ok(None) => return Err(eof(&link.stderr_tail)),
                    Err(e) => return Err(ApiError::new("io_error", format!("reading tf-hostd: {e}")).retryable()),
                }
            }
        })
        .await;
        let (rev, state) = match first {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => return Err(link.close_with(e)),
            Err(_) => {
                return Err(link.close_with(
                    ApiError::new("timeout", format!("no snapshot from tf-hostd within {}s", SNAPSHOT_TIMEOUT.as_secs()))
                        .retryable(),
                ));
            }
        };
        link.heard();
        sink.snapshot(rev, state);

        tokio::spawn(link.clone().read_loop(lines, rev, sink.clone()));
        tokio::spawn(link.clone().ping_loop());
        Ok(link)
    }

    fn close_with(&self, e: ApiError) -> ApiError {
        self.close(&e.message);
        e
    }

    /// Closes the link (idempotent). Pending requests fail with `not_connected`.
    pub fn close(&self, reason: &str) {
        self.closed_tx.send_if_modified(|c| {
            if c.is_some() {
                return false;
            }
            *c = Some(reason.to_string());
            true
        });
        let pending: Vec<_> = self.pending.lock().unwrap().drain().collect();
        for (_, p) in pending {
            if let Pending::Waiter(tx) = p {
                let _ = tx.send(Err(not_connected(reason)));
            }
        }
    }

    pub fn is_closed(&self) -> bool {
        self.closed_tx.borrow().is_some()
    }

    /// Resolves with the close reason once the link is down.
    pub async fn closed(&self) -> String {
        let mut rx = self.closed_tx.subscribe();
        let r = rx.wait_for(|c| c.is_some()).await.map(|c| c.clone().unwrap_or_default());
        r.unwrap_or_else(|_| "closed".into())
    }

    pub fn stderr_tail(&self) -> String {
        tail_text(&self.stderr_tail)
    }

    fn send(&self, msg: &ClientMsg) -> Result<(), ApiError> {
        if self.is_closed() {
            return Err(not_connected("closed"));
        }
        self.out.send(line(msg)).map_err(|_| not_connected("writer stopped"))
    }

    /// Something arrived from the host.
    fn heard(&self) {
        self.rx_count.fetch_add(1, Ordering::Relaxed);
        self.last_rx.store(self.born.elapsed().as_millis() as u64, Ordering::Relaxed);
    }

    /// How long ago the host last sent anything: a live link hears at least the pong to the ping
    /// sent every [`PING_EVERY`].
    pub fn silent_for(&self) -> Duration {
        self.born.elapsed().saturating_sub(Duration::from_millis(self.last_rx.load(Ordering::Relaxed)))
    }

    /// Liveness probe (app resumed / network changed): ping and close the link when nothing
    /// arrives within `timeout`.
    pub async fn check(&self, timeout: Duration) {
        let before = self.rx_count.load(Ordering::Relaxed);
        if self.send(&ClientMsg::Ping { ts: now_ms() }).is_err() {
            return;
        }
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.is_closed() || self.rx_count.load(Ordering::Relaxed) != before {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        self.close(&format!("no response from tf-hostd within {}s after resume", timeout.as_secs()));
    }

    /// Sends a request and waits for its response.
    pub async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, ApiError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, Pending::Waiter(tx));
        if let Err(e) = self.send(&ClientMsg::Req { id, method: method.to_string(), params }) {
            self.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err(not_connected("closed")),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(ApiError::new("timeout", format!("{method}: no response from tf-hostd within {}s", timeout.as_secs()))
                    .retryable())
            }
        }
    }

    /// Terminal keystrokes (fire and forget).
    pub fn term_input(&self, term_id: &str, data: String) -> Result<(), ApiError> {
        self.send(&ClientMsg::TermIn { term_id: term_id.to_string(), data })
    }

    /// Graceful goodbye before closing.
    pub fn bye(&self) {
        let _ = self.send(&ClientMsg::Bye);
    }

    fn handle_other(&self, msg: ServerMsg, sink: &Arc<dyn LinkSink>) {
        match msg {
            ServerMsg::Res { id, result, error } => {
                let p = self.pending.lock().unwrap().remove(&id);
                if let Some(Pending::Waiter(tx)) = p {
                    let r = match error {
                        Some(e) => Err(e),
                        None => Ok(result.unwrap_or(Value::Null)),
                    };
                    let _ = tx.send(r);
                }
            }
            ServerMsg::Pong { ts } => {
                let ms = (now_ms() - ts).clamp(0, u32::MAX as Millis) as u32;
                sink.latency(ms);
            }
            ServerMsg::Welcome { .. } => {}
            m @ (ServerMsg::Pulse { .. } | ServerMsg::Session { .. } | ServerMsg::Term { .. } | ServerMsg::Notify { .. }) => {
                sink.push(m)
            }
            ServerMsg::Snapshot { rev, state } => sink.snapshot(rev, state),
            ServerMsg::Patch { rev, ops } => sink.patch(rev, ops),
            ServerMsg::Error { error } => self.close(&error.to_string()),
        }
    }

    async fn read_loop(self: Arc<Self>, mut lines: Reader, mut last_rev: u64, sink: Arc<dyn LinkSink>) {
        let mut closed = self.closed_tx.subscribe();
        let mut resync: Option<u64> = None;
        loop {
            let msg = tokio::select! {
                m = next_msg(&mut lines) => m,
                _ = wait_closed(&mut closed) => return,
            };
            let msg = match msg {
                Ok(Some(m)) => m,
                Ok(None) => {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    let t = self.stderr_tail();
                    self.close(&if t.is_empty() { "tf-hostd attach exited".to_string() } else { t });
                    return;
                }
                Err(e) => {
                    self.close(&format!("read failed: {e}"));
                    return;
                }
            };
            self.heard();
            match msg {
                ServerMsg::Snapshot { rev, state } => {
                    last_rev = rev;
                    resync = None;
                    sink.snapshot(rev, state);
                }
                ServerMsg::Patch { rev, ops } => {
                    if resync.is_some() {
                        last_rev = rev;
                    } else if rev != last_rev + 1 {
                        log::warn!("tf-hostd: revision gap ({last_rev} → {rev}); resyncing");
                        last_rev = rev;
                        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
                        self.pending.lock().unwrap().insert(id, Pending::Resync);
                        if self
                            .send(&ClientMsg::Req { id, method: "state.get".into(), params: serde_json::json!({}) })
                            .is_err()
                        {
                            return;
                        }
                        resync = Some(id);
                    } else {
                        last_rev = rev;
                        sink.patch(rev, ops);
                    }
                }
                ServerMsg::Res { id, result, error } if resync == Some(id) => {
                    self.pending.lock().unwrap().remove(&id);
                    resync = None;
                    match (error, result.map(serde_json::from_value::<HostState>)) {
                        (None, Some(Ok(state))) => sink.snapshot(last_rev, state),
                        (e, r) => {
                            let why = e.map(|e| e.to_string()).or_else(|| r.and_then(|r| r.err()).map(|e| e.to_string()));
                            self.close(&format!("state resync failed: {}", why.unwrap_or_default()));
                            return;
                        }
                    }
                }
                other => self.handle_other(other, &sink),
            }
        }
    }

    /// Pings every [`PING_EVERY`] and closes the link by the rule in [`Pings`]. The ping goes out
    /// before anything is judged: a tick that comes late (the machine slept, the app was stopped)
    /// asks the host first instead of declaring it dead.
    async fn ping_loop(self: Arc<Self>) {
        let mut closed = self.closed_tx.subscribe();
        let mut tick = tokio::time::interval(PING_EVERY);
        // After a stall: one tick now and the next a whole period later, not a burst of them.
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await;
        let mut last = Instant::now();
        let mut pings = Pings::default();
        loop {
            tokio::select! {
                _ = tick.tick() => {}
                _ = wait_closed(&mut closed) => return,
            }
            let now = Instant::now();
            let gap = now - last;
            last = now;
            let stalled = gap >= 2 * PING_EVERY;
            if stalled {
                log::info!("tf-hostd: no ping for {}s (system sleep or a stopped app); asking the host", gap.as_secs());
            }
            let rx = self.rx_count.load(Ordering::Relaxed);
            if self.send(&ClientMsg::Ping { ts: now_ms() }).is_err() {
                return;
            }
            if let Some(unanswered) = pings.sent(now, rx, stalled) {
                self.close(&format!("no answer from tf-hostd for {}s", unanswered.as_secs()));
                return;
            }
        }
    }
}

/// Liveness by unanswered pings: the link is dead once nothing at all arrived since a ping sent
/// [`PING_DEADLINE`] ago. Pings sent before a stall are not judged: while the app did not run
/// (system sleep, which Windows' monotonic clock counts and Linux's does not), the host could not
/// answer either, so the ping sent on waking starts afresh.
#[derive(Default)]
struct Pings {
    /// The oldest ping nothing arrived after: when it was sent, and the receive count before it.
    oldest: Option<(Instant, u64)>,
}

impl Pings {
    /// Records a ping sent at `at` (`rx`: messages received before it; `stalled`: its tick came a
    /// whole period late or more). Returns how long the oldest ping went unanswered once that
    /// reaches [`PING_DEADLINE`].
    fn sent(&mut self, at: Instant, rx: u64, stalled: bool) -> Option<Duration> {
        match self.oldest {
            Some((first, seen)) if seen == rx && !stalled => Some(at - first).filter(|age| *age >= PING_DEADLINE),
            _ => {
                self.oldest = Some((at, rx));
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::fixtures::*;
    use tf_proto::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, DuplexStream};

    #[derive(Default)]
    pub struct Rec(pub Mutex<Vec<String>>);
    impl LinkSink for Rec {
        fn snapshot(&self, rev: u64, state: HostState) {
            self.0.lock().unwrap().push(format!("snap {rev} {}", state.agents.len()));
        }
        fn patch(&self, rev: u64, ops: Vec<StatePatch>) {
            self.0.lock().unwrap().push(format!("patch {rev} {}", ops.len()));
        }
        fn push(&self, msg: ServerMsg) {
            self.0.lock().unwrap().push(format!("push {}", serde_json::to_value(&msg).unwrap()["t"].as_str().unwrap()));
        }
        fn latency(&self, _: u32) {
            self.0.lock().unwrap().push("latency".into());
        }
    }

    async fn send(w: &mut DuplexStream, m: &ServerMsg) {
        let mut s = serde_json::to_string(m).unwrap();
        s.push('\n');
        w.write_all(s.as_bytes()).await.unwrap();
    }

    fn hello() -> ClientMsg {
        ClientMsg::Hello {
            protocol: PROTOCOL_VERSION,
            client: ClientInfo { app: "t".into(), version: "0".into(), platform: "linux".into(), device: "d".into() },
            herdr_session: "s".into(),
        }
    }

    #[tokio::test]
    async fn handshake_requests_gaps_and_close() {
        let (client_w, server_r) = tokio::io::duplex(1 << 16);
        let (mut server_w, client_r) = tokio::io::duplex(1 << 16);
        let rec = Arc::new(Rec::default());
        let server = tokio::spawn(async move {
            let mut lines = BufReader::new(server_r).lines();
            let h: ClientMsg = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert!(matches!(h, ClientMsg::Hello { .. }));
            send(&mut server_w, &ServerMsg::Welcome { protocol: PROTOCOL_VERSION, hostd_version: "0.1.0".into(), client_id: "c1".into() }).await;
            send(&mut server_w, &ServerMsg::Snapshot { rev: 5, state: host_state() }).await;
            // A request.
            let r: ClientMsg = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            let ClientMsg::Req { id, method, .. } = r else { panic!("{r:?}") };
            assert_eq!(method, "fs.home");
            send(&mut server_w, &ServerMsg::Patch { rev: 6, ops: vec![] }).await;
            send(&mut server_w, &ServerMsg::Res { id, result: Some(serde_json::json!({"path": "/root"})), error: None }).await;
            // Error response.
            let r: ClientMsg = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            let ClientMsg::Req { id, .. } = r else { panic!() };
            send(&mut server_w, &ServerMsg::Res { id, result: None, error: Some(ApiError::new("not_found", "nope")) }).await;
            // Gap: 6 → 9 triggers state.get; patches during resync are dropped.
            send(&mut server_w, &ServerMsg::Patch { rev: 9, ops: vec![] }).await;
            send(&mut server_w, &ServerMsg::Patch { rev: 10, ops: vec![] }).await;
            let r: ClientMsg = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            let ClientMsg::Req { id, method, .. } = r else { panic!() };
            assert_eq!(method, "state.get");
            let mut st = host_state();
            st.agents.push(agent("a", Column::Running));
            send(&mut server_w, &ServerMsg::Res { id, result: Some(serde_json::to_value(&st).unwrap()), error: None }).await;
            send(&mut server_w, &ServerMsg::Patch { rev: 11, ops: vec![] }).await;
            send(&mut server_w, &ServerMsg::Pulse { at: 1, pulses: vec![] }).await;
            // Term input arrives as termIn.
            let r: ClientMsg = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert!(matches!(r, ClientMsg::TermIn { ref data, .. } if data == "ls\r"));
            // A request left hanging, then EOF.
            let _ = lines.next_line().await.unwrap().unwrap();
            drop(server_w);
            lines
        });
        let link = Link::establish(Box::new(client_w), Box::new(client_r), None, hello(), rec.clone()).await.unwrap();
        assert_eq!(link.hostd_version, "0.1.0");
        let v = link.request("fs.home", serde_json::json!({}), DEFAULT_TIMEOUT).await.unwrap();
        assert_eq!(v["path"], "/root");
        let e = link.request("fs.list", serde_json::json!({}), DEFAULT_TIMEOUT).await.unwrap_err();
        assert_eq!(e.code, "not_found");
        tokio::time::sleep(Duration::from_millis(50)).await;
        link.term_input("t1", "ls\r".into()).unwrap();
        let hanging = link.request("state.get", serde_json::json!({}), DEFAULT_TIMEOUT).await.unwrap_err();
        assert_eq!(hanging.code, "not_connected");
        let reason = link.closed().await;
        assert!(reason.contains("exited"), "{reason}");
        let _ = server.await.unwrap();
        let log = rec.0.lock().unwrap().clone();
        assert_eq!(log, ["snap 5 0", "patch 6 0", "snap 10 1", "patch 11 0", "push pulse"]);
    }

    #[tokio::test]
    async fn handshake_error_and_eof() {
        let (client_w, _server_r) = tokio::io::duplex(1 << 16);
        let (mut server_w, client_r) = tokio::io::duplex(1 << 16);
        send(&mut server_w, &ServerMsg::Error { error: ApiError::new("version_mismatch", "old") }).await;
        let e = Link::establish(Box::new(client_w), Box::new(client_r), None, hello(), Arc::new(Rec::default()))
            .await
            .err()
            .unwrap();
        assert_eq!(e.code, "version_mismatch");

        let (client_w, _server_r) = tokio::io::duplex(1 << 16);
        let (server_w, client_r) = tokio::io::duplex(1 << 16);
        let (mut err_w, err_r) = tokio::io::duplex(1 << 10);
        err_w.write_all(b"tf-hostd: daemon not ready after 10s\n").await.unwrap();
        drop(server_w);
        let e = Link::establish(Box::new(client_w), Box::new(client_r), Some(Box::new(err_r)), hello(), Arc::new(Rec::default()))
            .await
            .err()
            .unwrap();
        assert_eq!(e.code, "not_connected");
        assert!(e.message.contains("daemon not ready"), "{}", e.message);
    }

    /// The ping rule on tokio's paused clock: a host that answers survives the clock jumping
    /// 2 minutes with no tick in between (Windows counts system sleep), even with a ping left
    /// unanswered just before it; a host that stops answering is dropped once its first
    /// unanswered ping is 30 s old, not sooner.
    #[tokio::test(start_paused = true)]
    async fn unanswered_pings_close_the_link_and_sleep_does_not() {
        use std::sync::atomic::AtomicBool;
        let (client_w, server_r) = tokio::io::duplex(1 << 16);
        let (mut server_w, client_r) = tokio::io::duplex(1 << 16);
        let answer = Arc::new(AtomicBool::new(true));
        let pings = Arc::new(AtomicU64::new(0));
        let (a, p) = (answer.clone(), pings.clone());
        tokio::spawn(async move {
            let mut lines = BufReader::new(server_r).lines();
            lines.next_line().await.unwrap();
            send(&mut server_w, &ServerMsg::Welcome { protocol: PROTOCOL_VERSION, hostd_version: "0.1.0".into(), client_id: "c1".into() }).await;
            send(&mut server_w, &ServerMsg::Snapshot { rev: 1, state: host_state() }).await;
            while let Ok(Some(l)) = lines.next_line().await {
                if let Ok(ClientMsg::Ping { ts }) = serde_json::from_str(&l) {
                    p.fetch_add(1, Ordering::Relaxed);
                    if a.load(Ordering::Relaxed) {
                        send(&mut server_w, &ServerMsg::Pong { ts }).await;
                    }
                }
            }
        });
        let link = Link::establish(Box::new(client_w), Box::new(client_r), None, hello(), Arc::new(Rec::default()))
            .await
            .unwrap();
        // Ticks come at +15 s, +30 s …; every wait below ends between two of them.
        tokio::time::sleep(Duration::from_secs(121)).await;
        assert!(!link.is_closed());
        assert_eq!(pings.load(Ordering::Relaxed), 8);
        assert!(link.silent_for() <= Duration::from_secs(1), "{:?}", link.silent_for());

        // The ping at +135 s goes unanswered, then the machine sleeps for 2 minutes.
        answer.store(false, Ordering::Relaxed);
        tokio::time::sleep(PING_EVERY).await;
        answer.store(true, Ordering::Relaxed);
        tokio::time::advance(Duration::from_secs(120)).await;
        // The late tick (+256 s) pings before it judges anything, and the host answers.
        tokio::time::sleep(Duration::from_secs(61)).await;
        assert!(!link.is_closed(), "{:?}", link.closed_tx.borrow());
        assert_eq!(pings.load(Ordering::Relaxed), 14, "one ping after the jump, no burst");

        // The host stops answering at +317 s: pings at +331, +346, closed at +361.
        answer.store(false, Ordering::Relaxed);
        let t0 = Instant::now();
        let reason = link.closed().await;
        assert_eq!(reason, "no answer from tf-hostd for 30s");
        assert_eq!(t0.elapsed(), Duration::from_secs(44));
    }
}
