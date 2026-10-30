//! Per-client sessions (architecture §3.3): hello/welcome with feature negotiation, snapshot +
//! patches, request dispatch, session/term subscriptions, pulses, ping/pong and backpressure.
//!
//! Outbound messages go through a bounded per-client queue. Pulses are dropped first
//! once the queue backs up; a client whose queue overflows entirely is disconnected
//! (it reconnects and gets a fresh snapshot).
//!
//! With the `zstd` feature, everything after `welcome` is one zstd stream per direction: each
//! batch of queued lines is written and flushed as a zstd block, so nothing waits for more input.

use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_compression::tokio::bufread::ZstdDecoder;
use async_compression::tokio::write::ZstdEncoder;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use tf_proto::host::{ClientInfo, ClientMsg, ServerMsg, FEATURE_PRESENCE, FEATURE_SESSION_SYNC, FEATURE_ZSTD};
use tf_proto::{ApiError, PROTOCOL_VERSION};

use crate::daemon::Daemon;
use crate::ipc::{BoxRead, BoxWrite};
use crate::ops::{self, Ctx};

/// Pulses are only queued while fewer than this many lines are pending.
const PULSE_HIGH_WATER: usize = 32;
/// A client with this many pending lines is too slow and gets disconnected.
const HARD_LIMIT: usize = 8192;
/// Either side drops the link after this much silence.
const SILENCE: Duration = Duration::from_secs(45);
/// Client silence is counted in steps of at most this much of the daemon's own running time
/// (`read_or_silence`).
const SILENCE_STEP: Duration = Duration::from_secs(5);
/// Max inbound line (images are base64 inside prompts).
const MAX_LINE: usize = 64 * 1024 * 1024;
/// zstd window of the outbound stream (2 MiB, zstd's own choice for its default level).
const ZSTD_WINDOW_LOG: u32 = 21;
/// Largest window an inbound zstd stream may use (8 MiB): bounds what a client can make the
/// daemon allocate.
const ZSTD_WINDOW_LOG_MAX: u32 = 23;

/// Wire features negotiated with a client: what its `hello` asked for that this hostd speaks.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Features {
    /// Zstd streams after `welcome`.
    pub zstd: bool,
    /// Cached, resumable session subscriptions ([`crate::sync`]).
    pub session_sync: bool,
    /// Presence reports and routed notifications ([`crate::notify`]).
    pub presence: bool,
}

impl Features {
    /// The features of `requested` (`hello`'s `client.features`) this hostd speaks.
    pub fn negotiate(requested: Option<&[String]>) -> Features {
        let has = |f: &str| requested.is_some_and(|r| r.iter().any(|x| x == f));
        Features { zstd: has(FEATURE_ZSTD), session_sync: has(FEATURE_SESSION_SYNC), presence: has(FEATURE_PRESENCE) }
    }

    /// `welcome.features`: the accepted ones (none for a client that asked for none, which then
    /// gets the welcome it always got).
    pub fn welcome(&self, requested: Option<&[String]>) -> Option<Vec<String>> {
        requested?;
        let mut out = Vec::new();
        if self.zstd {
            out.push(FEATURE_ZSTD.to_string());
        }
        if self.session_sync {
            out.push(FEATURE_SESSION_SYNC.to_string());
        }
        if self.presence {
            out.push(FEATURE_PRESENCE.to_string());
        }
        Some(out)
    }
}

struct Queue {
    lines: VecDeque<Arc<str>>,
}

struct Inner {
    id: String,
    info: ClientInfo,
    features: Features,
    queue: Mutex<Queue>,
    wake: Notify,
    closed: CancellationToken,
    overflowed: AtomicBool,
}

/// A connected client. Cheap to clone; all methods are non-blocking.
#[derive(Clone)]
pub struct ClientHandle {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for ClientHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClientHandle").field("id", &self.inner.id).finish()
    }
}

impl ClientHandle {
    /// A client that negotiated no features.
    pub fn new(id: String, info: ClientInfo) -> Self {
        Self::with_features(id, info, Features::default())
    }

    pub fn with_features(id: String, info: ClientInfo, features: Features) -> Self {
        Self {
            inner: Arc::new(Inner {
                id,
                info,
                features,
                queue: Mutex::new(Queue { lines: VecDeque::new() }),
                wake: Notify::new(),
                closed: CancellationToken::new(),
                overflowed: AtomicBool::new(false),
            }),
        }
    }

    pub fn id(&self) -> &str {
        &self.inner.id
    }

    pub fn info(&self) -> &ClientInfo {
        &self.inner.info
    }

    pub fn features(&self) -> Features {
        self.inner.features
    }

    /// Queues a message. Returns false when the client is gone (or the message was a
    /// pulse dropped under backpressure).
    pub fn send(&self, msg: ServerMsg) -> bool {
        let pulse = matches!(msg, ServerMsg::Pulse { .. });
        match serde_json::to_string(&msg) {
            Ok(line) => self.send_line(Arc::from(line), pulse),
            Err(e) => {
                warn!(client = %self.inner.id, "serialize: {e}");
                false
            }
        }
    }

    /// Queues an already serialized line (broadcasts serialize once).
    pub fn send_line(&self, line: Arc<str>, pulse: bool) -> bool {
        if self.is_closed() {
            return false;
        }
        {
            let mut q = self.inner.queue.lock().unwrap_or_else(|p| p.into_inner());
            if pulse && q.lines.len() >= PULSE_HIGH_WATER {
                return false;
            }
            if q.lines.len() >= HARD_LIMIT {
                drop(q);
                warn!(client = %self.inner.id, "outbound queue overflow; disconnecting slow client");
                self.inner.overflowed.store(true, Ordering::Relaxed);
                self.close();
                return false;
            }
            q.lines.push_back(line);
        }
        self.inner.wake.notify_one();
        true
    }

    pub fn is_closed(&self) -> bool {
        self.inner.closed.is_cancelled()
    }

    /// Resolves when the client disconnects.
    pub async fn closed(&self) {
        self.inner.closed.cancelled().await
    }

    pub fn close(&self) {
        self.inner.closed.cancel();
        self.inner.wake.notify_one();
    }

    pub fn pending(&self) -> usize {
        self.inner.queue.lock().unwrap_or_else(|p| p.into_inner()).lines.len()
    }

    pub(crate) fn take_batch(&self, out: &mut Vec<Arc<str>>) {
        let mut q = self.inner.queue.lock().unwrap_or_else(|p| p.into_inner());
        out.extend(q.lines.drain(..));
    }
}

/// Serializes once for many clients.
pub fn line_of(msg: &ServerMsg) -> Option<Arc<str>> {
    serde_json::to_string(msg).ok().map(Arc::from)
}

static NEXT_CLIENT: AtomicU64 = AtomicU64::new(1);

/// Internal control line (`tf-hostd stop` / `attach --replace`). `version` is the sender's
/// `--version` line (older builds send none); `force` stops regardless of the stop policy.
#[derive(serde::Deserialize)]
struct CtlLine {
    ctl: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    force: bool,
}

/// Serves one accepted connection until it closes.
pub async fn serve(daemon: Arc<Daemon>, read: BoxRead, mut write: BoxWrite) {
    let mut reader = BufReader::with_capacity(64 * 1024, read);
    let mut first = String::new();
    match tokio::time::timeout(Duration::from_secs(30), read_line(&mut reader, &mut first)).await {
        Ok(Ok(true)) => {}
        _ => return,
    }
    if let Ok(ctl) = serde_json::from_str::<CtlLine>(&first) {
        let mut reply = daemon.control(&ctl.ctl);
        let mut stop = false;
        if ctl.ctl == "stop" {
            let requester = ctl.version.as_deref().unwrap_or("(unversioned)");
            match daemon.may_stop(ctl.version.as_deref(), ctl.force) {
                Ok(()) => {
                    info!(requester, force = ctl.force, "stop requested");
                    stop = true;
                }
                Err(why) => {
                    warn!(requester, "stop refused: {why}");
                    reply["ok"] = false.into();
                    reply["refused"] = why.into();
                }
            }
        }
        let _ = write.write_all(format!("{reply}\n").as_bytes()).await;
        let _ = write.flush().await;
        if stop {
            daemon.shutdown.cancel();
        }
        return;
    }
    let (client_info, herdr_session) = match serde_json::from_str::<ClientMsg>(&first) {
        Ok(ClientMsg::Hello { protocol, client, herdr_session }) => {
            if protocol != PROTOCOL_VERSION {
                let hint = if protocol < PROTOCOL_VERSION {
                    format!(
                        "This host runs tf-hostd {}, installed by a newer TeleFlock on another device. Update TeleFlock on this device.",
                        crate::HOSTD_VERSION
                    )
                } else {
                    "Reconnect so the app redeploys tf-hostd".to_string()
                };
                let err = ApiError::new(
                    "version_mismatch",
                    format!("client protocol {protocol}, tf-hostd protocol {PROTOCOL_VERSION}"),
                )
                .with_hint(hint);
                write_now(&mut write, &ServerMsg::Error { error: err }).await;
                return;
            }
            (client, herdr_session)
        }
        Ok(_) => {
            write_now(&mut write, &ServerMsg::Error { error: ApiError::new("invalid_params", "expected hello") }).await;
            return;
        }
        Err(e) => {
            write_now(&mut write, &ServerMsg::Error { error: ApiError::new("invalid_params", format!("hello: {e}")) })
                .await;
            return;
        }
    };
    let session = if herdr_session.trim().is_empty() { "default".to_string() } else { herdr_session };
    let ctx = match daemon.ctx_for(&session).await {
        Ok(ctx) => ctx,
        Err(error) => {
            write_now(&mut write, &ServerMsg::Error { error }).await;
            return;
        }
    };

    let client_id = format!("c{}", NEXT_CLIENT.fetch_add(1, Ordering::Relaxed));
    let requested = client_info.features.clone();
    let features = Features::negotiate(requested.as_deref());
    let client = ClientHandle::with_features(client_id.clone(), client_info, features);
    let _counted = daemon.count_client();
    info!(client = %client_id, app = %client.info().app, device = %client.info().device, session = %session, clients = daemon.clients(), ?features, "client connected");

    // The welcome is the last plain line; with `zstd`, both directions are zstd streams after it.
    write_now(
        &mut write,
        &ServerMsg::Welcome {
            protocol: PROTOCOL_VERSION,
            hostd_version: crate::HOSTD_VERSION.to_string(),
            client_id: client_id.clone(),
            features: features.welcome(requested.as_deref()),
        },
    )
    .await;
    ctx.state.attach_client(&client);
    ctx.notify.client_attached(&session, &client);
    ctx.auto_answer.clients_changed();

    let writer = tokio::spawn(write_loop(client.clone(), write));
    let mut reader = framed_reader(reader, features);
    let shutdown = daemon.shutdown.clone();

    let mut line = String::new();
    loop {
        line.clear();
        let next = tokio::select! {
            r = read_or_silence(read_line(&mut reader, &mut line)) => r,
            _ = client.closed() => break,
            _ = shutdown.cancelled() => {
                client.send(ServerMsg::Error {
                    error: ApiError::new("shutting_down", "tf-hostd is restarting").retryable(),
                });
                break;
            }
        };
        match next {
            None => {
                debug!(client = %client_id, "silent for 45 s; dropping");
                break;
            }
            Some(Err(e)) => {
                debug!(client = %client_id, "read: {e}");
                break;
            }
            Some(Ok(false)) => break,
            Some(Ok(true)) => {}
        }
        let msg = match serde_json::from_str::<ClientMsg>(&line) {
            Ok(m) => m,
            Err(e) => {
                warn!(client = %client_id, "bad line: {e}");
                continue;
            }
        };
        match msg {
            ClientMsg::Req { id, method, params } => {
                let ctx = ctx.clone();
                let client = client.clone();
                tokio::spawn(async move {
                    let res = dispatch_req(&ctx, &method, params, &client).await;
                    let msg = match res {
                        Ok(result) => ServerMsg::Res { id, result: Some(result), error: None },
                        Err(error) => {
                            debug!(client = %client.id(), %method, "error: {error}");
                            ServerMsg::Res { id, result: None, error: Some(error) }
                        }
                    };
                    client.send(msg);
                });
            }
            ClientMsg::TermIn { term_id, data } => {
                ops::term::input(&ctx, &client, &term_id, &data).await;
            }
            ClientMsg::Ping { ts } => {
                client.send(ServerMsg::Pong { ts });
            }
            ClientMsg::Presence { presence } => ctx.notify.presence_changed(&client, presence),
            ClientMsg::NotifyRead { ids } => ctx.notify.notify_read(&client, ids),
            ClientMsg::Hello { .. } => {
                client.send(ServerMsg::Error { error: ApiError::new("invalid_params", "duplicate hello") });
            }
            ClientMsg::Bye => break,
        }
    }

    // Give queued messages (e.g. the shutdown error) a moment to flush.
    let _ = tokio::time::timeout(Duration::from_millis(500), async {
        while client.pending() > 0 && !client.is_closed() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    client.close();
    let _ = writer.await;
    ctx.state.detach_client(&client_id);
    ctx.notify.client_detached(&client_id);
    ctx.auto_answer.clients_changed();
    ops::agent::client_gone(&ctx, &client_id);
    ops::term::client_gone(&ctx, &client_id).await;
    info!(client = %client_id, "client disconnected");
}

async fn dispatch_req(ctx: &Arc<Ctx>, method: &str, params: serde_json::Value, client: &ClientHandle) -> Result<serde_json::Value, ApiError> {
    let req = tf_proto::HostMethod::parse(method, params)?;
    ops::dispatch(ctx, req, client).await
}

/// The inbound line stream after `welcome` (`reader` holds whatever followed the hello): plain,
/// or decoded from the client's zstd stream.
pub fn framed_reader<R: AsyncBufRead + Send + Unpin + 'static>(reader: R, features: Features) -> Pin<Box<dyn AsyncBufRead + Send>> {
    if features.zstd {
        let params = [async_compression::zstd::DParameter::window_log_max(ZSTD_WINDOW_LOG_MAX)];
        Box::pin(BufReader::with_capacity(64 * 1024, ZstdDecoder::with_params(reader, &params)))
    } else {
        Box::pin(reader)
    }
}

/// Writes the client's queued lines until it closes: each batch at once, flushed (with `zstd`,
/// as one block of the stream).
pub async fn write_loop<W: AsyncWrite + Send + Unpin + 'static>(client: ClientHandle, write: W) {
    let mut write: Pin<Box<dyn AsyncWrite + Send>> = if client.features().zstd {
        let params = [async_compression::zstd::CParameter::window_log(ZSTD_WINDOW_LOG)];
        Box::pin(ZstdEncoder::with_quality_and_params(write, async_compression::Level::Default, &params))
    } else {
        Box::pin(write)
    };
    let mut batch: Vec<Arc<str>> = Vec::with_capacity(64);
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    loop {
        client.take_batch(&mut batch);
        if batch.is_empty() {
            if client.is_closed() {
                break;
            }
            tokio::select! {
                _ = client.inner.wake.notified() => {}
                _ = tokio::time::sleep(Duration::from_secs(1)) => {}
            }
            continue;
        }
        buf.clear();
        for line in batch.drain(..) {
            buf.extend_from_slice(line.as_bytes());
            buf.push(b'\n');
        }
        let res = tokio::time::timeout(SILENCE, async {
            write.write_all(&buf).await?;
            write.flush().await
        })
        .await;
        match res {
            Ok(Ok(())) => {}
            _ => {
                client.close();
                break;
            }
        }
    }
    let _ = write.shutdown().await;
}

async fn write_now(write: &mut BoxWrite, msg: &ServerMsg) {
    if let Ok(mut s) = serde_json::to_string(msg) {
        s.push('\n');
        let _ = write.write_all(s.as_bytes()).await;
        let _ = write.flush().await;
    }
}

/// Waits for `read`; `None` once [`SILENCE`] of this daemon's running time passed without it.
/// Silence is counted in steps of at most [`SILENCE_STEP`]: after the daemon itself did not run
/// (system sleep, which Windows' clock counts; a stopped process, whose first wake-up on Linux
/// fires overdue timers before it reads the socket), the overdue step counts once, and the line
/// the client queued meanwhile (its ping) is read before silence is judged again.
async fn read_or_silence<T>(read: impl Future<Output = T>) -> Option<T> {
    tokio::pin!(read);
    let mut silent = Duration::ZERO;
    loop {
        let step = tokio::time::Instant::now();
        tokio::select! {
            biased;
            r = &mut read => return Some(r),
            _ = tokio::time::sleep(SILENCE_STEP) => {
                silent += step.elapsed().min(SILENCE_STEP);
                if silent >= SILENCE {
                    return None;
                }
            }
        }
    }
}

/// Reads one `\n`-terminated line (without the terminator). `Ok(false)` on EOF.
pub async fn read_line<R: AsyncBufRead + Unpin + ?Sized>(reader: &mut R, out: &mut String) -> std::io::Result<bool> {
    let mut raw = Vec::new();
    loop {
        let buf = reader.fill_buf().await?;
        if buf.is_empty() {
            if raw.is_empty() {
                return Ok(false);
            }
            break;
        }
        if let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            raw.extend_from_slice(&buf[..pos]);
            reader.consume(pos + 1);
            break;
        }
        let n = buf.len();
        raw.extend_from_slice(buf);
        reader.consume(n);
        if raw.len() > MAX_LINE {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "line too long"));
        }
    }
    if raw.last() == Some(&b'\r') {
        raw.pop();
    }
    *out = String::from_utf8(raw).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tf_proto::model::Pulse;

    fn info() -> ClientInfo {
        ClientInfo { app: "test".into(), version: "0".into(), platform: "linux".into(), device: "dev".into(), features: None }
    }

    #[test]
    fn pulses_dropped_first_then_disconnect() {
        let c = ClientHandle::new("c1".into(), info());
        for i in 0..PULSE_HIGH_WATER {
            assert!(c.send(ServerMsg::Pong { ts: i as i64 }));
        }
        let pulse = ServerMsg::Pulse {
            at: 1,
            pulses: vec![Pulse { agent_id: "a".into(), kind: tf_proto::model::PulseKind::Token, n: 1 }],
        };
        assert!(!c.send(pulse), "pulse must be dropped above the high-water mark");
        assert!(c.send(ServerMsg::Pong { ts: 0 }), "regular messages still queue");
        while c.pending() < HARD_LIMIT {
            c.send(ServerMsg::Pong { ts: 0 });
        }
        assert!(!c.send(ServerMsg::Pong { ts: 0 }));
        assert!(c.is_closed());
    }

    /// Silence counts the daemon's running time: after the clock jumped 2 minutes (the daemon was
    /// suspended) the overdue check counts one step and the ping that waited is still read; a
    /// client that really says nothing is dropped after exactly 45 s.
    #[tokio::test(start_paused = true)]
    async fn silence_counts_running_time_only() {
        let (ping, queued) = tokio::sync::oneshot::channel::<()>();
        let reader = tokio::spawn(read_or_silence(async { queued.await.is_ok() }));
        tokio::time::sleep(Duration::from_secs(3)).await;
        tokio::time::advance(Duration::from_secs(120)).await;
        // The reader wakes first and finds its timer overdue, before the ping is readable.
        tokio::time::sleep(Duration::from_millis(1)).await;
        ping.send(()).unwrap();
        assert_eq!(reader.await.unwrap(), Some(true), "the client is kept and its ping read");

        let t0 = tokio::time::Instant::now();
        assert_eq!(read_or_silence(std::future::pending::<()>()).await, None);
        assert_eq!(t0.elapsed(), SILENCE);
    }

    #[test]
    fn features_are_negotiated_with_old_and_new_clients() {
        // An old client asks for nothing and gets the welcome it always got.
        assert_eq!(Features::negotiate(None), Features::default());
        assert_eq!(Features::default().welcome(None), None);
        let all = vec!["zstd".to_string(), "sessionSync".into(), "presence".into(), "fromTheFuture".into()];
        let f = Features::negotiate(Some(&all));
        assert_eq!(f, Features { zstd: true, session_sync: true, presence: true });
        assert_eq!(f.welcome(Some(&all)), Some(vec!["zstd".to_string(), "sessionSync".into(), "presence".into()]));
        let unknown = vec!["fromTheFuture".to_string()];
        let f = Features::negotiate(Some(&unknown));
        assert_eq!((f, f.welcome(Some(&unknown))), (Features::default(), Some(vec![])));
    }

    /// Delivers at most one byte per read: the zstd stream must cope with any split.
    struct Trickle<R>(R);
    impl<R: tokio::io::AsyncRead + Unpin> tokio::io::AsyncRead for Trickle<R> {
        fn poll_read(mut self: Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &mut tokio::io::ReadBuf<'_>) -> std::task::Poll<std::io::Result<()>> {
            let mut one = [0u8; 1];
            let mut b = tokio::io::ReadBuf::new(&mut one);
            match Pin::new(&mut self.0).poll_read(cx, &mut b) {
                std::task::Poll::Ready(Ok(())) => {
                    buf.put_slice(b.filled());
                    std::task::Poll::Ready(Ok(()))
                }
                other => other,
            }
        }
    }

    /// hostd → client: every batch is decodable on its own (a reader never waits for the next
    /// one), byte-by-byte delivery decodes, many small batches arrive in order, and the stream
    /// compresses repeated JSON.
    #[tokio::test]
    async fn zstd_batches_flush_and_survive_partial_reads() {
        let zstd = Features { zstd: true, ..Features::default() };
        let c = ClientHandle::with_features("c1".into(), info(), zstd);
        let (w, r) = tokio::io::duplex(1 << 20);
        let (counted_tx, counted) = tokio::io::duplex(1 << 20);
        // Count the compressed bytes on their way to the reader.
        let raw = tokio::spawn(async move {
            let mut r = r;
            let mut n = 0usize;
            let mut buf = [0u8; 4096];
            let mut tx = counted_tx;
            loop {
                let k = tokio::io::AsyncReadExt::read(&mut r, &mut buf).await.unwrap();
                if k == 0 {
                    return n;
                }
                n += k;
                tx.write_all(&buf[..k]).await.unwrap();
            }
        });
        let writer = tokio::spawn(write_loop(c.clone(), w));
        let mut lines = framed_reader(BufReader::new(Trickle(counted)), zstd);
        let mut line = String::new();
        // One message, then nothing: it must arrive without more input behind it.
        c.send(ServerMsg::Pong { ts: 1 });
        tokio::time::timeout(Duration::from_secs(5), read_line(&mut lines, &mut line)).await.expect("flushed").unwrap();
        assert_eq!(serde_json::from_str::<ServerMsg>(&line).unwrap(), ServerMsg::Pong { ts: 1 });
        let mut plain = line.len() + 1;
        for i in 0..300 {
            c.send(ServerMsg::Pong { ts: 1000 + i });
            if i % 3 == 0 {
                tokio::task::yield_now().await;
            }
        }
        for i in 0..300 {
            assert!(read_line(&mut lines, &mut line).await.unwrap());
            assert_eq!(serde_json::from_str::<ServerMsg>(&line).unwrap(), ServerMsg::Pong { ts: 1000 + i });
            plain += line.len() + 1;
        }
        c.close();
        writer.await.unwrap();
        assert!(!read_line(&mut lines, &mut line).await.unwrap(), "the stream ends cleanly");
        drop(lines);
        let wire = raw.await.unwrap();
        assert!(wire * 3 < plain, "{wire} compressed bytes for {plain} plain ones");
    }

    /// client → hostd: the reader picks the stream up right after the hello, even when the
    /// compressed bytes arrived in the same read as the hello line.
    #[tokio::test]
    async fn zstd_stream_starts_right_after_the_hello() {
        let mut compressed = ZstdEncoder::new(Vec::new());
        compressed.write_all(b"{\"t\":\"ping\",\"ts\":7}\n{\"t\":\"bye\"}\n").await.unwrap();
        compressed.shutdown().await.unwrap();
        let mut wire = b"{\"t\":\"hello\"}\n".to_vec();
        wire.extend_from_slice(&compressed.into_inner());
        let read: BoxRead = Box::pin(std::io::Cursor::new(wire));
        let mut reader = BufReader::new(read);
        let mut line = String::new();
        assert!(read_line(&mut reader, &mut line).await.unwrap());
        assert_eq!(line, "{\"t\":\"hello\"}");
        let mut rest = framed_reader(reader, Features { zstd: true, ..Features::default() });
        assert!(read_line(&mut rest, &mut line).await.unwrap());
        assert_eq!(serde_json::from_str::<ClientMsg>(&line).unwrap(), ClientMsg::Ping { ts: 7 });
        assert!(read_line(&mut rest, &mut line).await.unwrap());
        assert_eq!(serde_json::from_str::<ClientMsg>(&line).unwrap(), ClientMsg::Bye);
        assert!(!read_line(&mut rest, &mut line).await.unwrap());
    }
}
