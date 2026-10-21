//! Per-client sessions (architecture §3.3): hello/welcome, snapshot + patches, request
//! dispatch, session/term subscriptions, pulses, ping/pong and backpressure.
//!
//! Outbound messages go through a bounded per-client queue. Pulses are dropped first
//! once the queue backs up; a client whose queue overflows entirely is disconnected
//! (it reconnects and gets a fresh snapshot).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use tf_proto::host::{ClientInfo, ClientMsg, ServerMsg};
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
/// Max inbound line (images are base64 inside prompts).
const MAX_LINE: usize = 64 * 1024 * 1024;

struct Queue {
    lines: VecDeque<Arc<str>>,
}

struct Inner {
    id: String,
    info: ClientInfo,
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
    pub fn new(id: String, info: ClientInfo) -> Self {
        Self {
            inner: Arc::new(Inner {
                id,
                info,
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

    fn take_batch(&self, out: &mut Vec<Arc<str>>) {
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
    let client = ClientHandle::new(client_id.clone(), client_info);
    let _counted = daemon.count_client();
    info!(client = %client_id, app = %client.info().app, device = %client.info().device, session = %session, clients = daemon.clients(), "client connected");

    client.send(ServerMsg::Welcome {
        protocol: PROTOCOL_VERSION,
        hostd_version: crate::HOSTD_VERSION.to_string(),
        client_id: client_id.clone(),
    });
    ctx.state.attach_client(&client);

    let writer = tokio::spawn(write_loop(client.clone(), write));
    let shutdown = daemon.shutdown.clone();

    let mut line = String::new();
    loop {
        line.clear();
        let next = tokio::select! {
            r = tokio::time::timeout(SILENCE, read_line(&mut reader, &mut line)) => r,
            _ = client.closed() => break,
            _ = shutdown.cancelled() => {
                client.send(ServerMsg::Error {
                    error: ApiError::new("shutting_down", "tf-hostd is restarting").retryable(),
                });
                break;
            }
        };
        match next {
            Err(_) => {
                debug!(client = %client_id, "silent for 45 s; dropping");
                break;
            }
            Ok(Err(e)) => {
                debug!(client = %client_id, "read: {e}");
                break;
            }
            Ok(Ok(false)) => break,
            Ok(Ok(true)) => {}
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
    ops::agent::client_gone(&ctx, &client_id);
    ops::term::client_gone(&ctx, &client_id).await;
    info!(client = %client_id, "client disconnected");
}

async fn dispatch_req(ctx: &Arc<Ctx>, method: &str, params: serde_json::Value, client: &ClientHandle) -> Result<serde_json::Value, ApiError> {
    let req = tf_proto::HostMethod::parse(method, params)?;
    ops::dispatch(ctx, req, client).await
}

async fn write_loop(client: ClientHandle, mut write: BoxWrite) {
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

/// Reads one `\n`-terminated line (without the terminator). `Ok(false)` on EOF.
async fn read_line(reader: &mut BufReader<BoxRead>, out: &mut String) -> std::io::Result<bool> {
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
        ClientInfo { app: "test".into(), version: "0".into(), platform: "linux".into(), device: "dev".into() }
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
}
