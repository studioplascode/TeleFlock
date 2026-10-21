//! Loopback collab relay (`omp-collab.md` §4), wire-compatible with omp's `local-relay.ts`.
//!
//! * `GET /r/<roomId>?role=host|guest` + WebSocket upgrade. Wrong path/role → 404, no upgrade → 426.
//! * `GET /healthz` → `{"ok":true,"rooms":N,"guests":M}`. With `?nonce=<n>` the body also carries
//!   `"proof":hex(HMAC-SHA256(secret, n))` keyed by a per-process random secret, so the process
//!   that started the relay can tell it apart from anything else on the port ([`RelayIdentity`]).
//! * Requests carrying an `Origin` header get 403: omp (Bun's `WebSocket`) and hostd's guest
//!   (tungstenite) never send one, browsers always do.
//! * Room state: first host creates the room; a second live host gets close 4009. A guest for a
//!   missing room gets close 4004 *after* the upgrade. Guests get peer ids 1, 2, … per room
//!   incarnation; the host is told `{"t":"peer-joined","peer":N}` / `peer-left`.
//! * Host BINARY `[u32 BE peer][sealed]`: 0 broadcasts, N targets guest N. Guest BINARY gets its
//!   first 4 bytes rewritten to the sender's id and goes to the host. TEXT from clients is ignored.
//! * Host leaves → each guest gets TEXT `{"t":"room-closed"}` then close 4001.
//! * Liveness: ping every `ping_interval` (20 s), drop after `idle_timeout` (60 s) of silence.
//! * Limits: max message `max_message` (16 MiB); per-room guest cap → close 4029; room cap → close
//!   1013; connection cap → 503 before the upgrade; `max_queued_bytes` of outbound data per
//!   connection (a guest over budget is dropped with close 1008, guest → host frames wait).

use std::collections::{BTreeMap, HashMap};
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore, mpsc, watch};
use tokio::task::JoinSet;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::frame::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Bytes, Message};

use crate::link::is_room_id;

pub const CLOSE_ROOM_CLOSED: u16 = 4001;
pub const CLOSE_NO_SUCH_ROOM: u16 = 4004;
pub const CLOSE_DUPLICATE_HOST: u16 = 4009;
pub const CLOSE_ROOM_FULL: u16 = 4029;
/// RFC 6455 "try again later": the relay already holds `max_rooms` rooms.
pub const CLOSE_TOO_MANY_ROOMS: u16 = 1013;
/// RFC 6455 policy violation: a guest exceeded its outbound byte budget.
pub const CLOSE_BACKLOG: u16 = 1008;

const ROOM_CLOSED_TEXT: &str = r#"{"t":"room-closed"}"#;
const MAX_HEAD: usize = 16 * 1024;
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
/// Bytes charged per queued message on top of its payload, so tiny frames cannot pile up unbounded.
const QUEUE_OVERHEAD: usize = 64;
const BUSY_RESPONSE: &[u8] =
    b"HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nContent-Length: 4\r\nConnection: close\r\n\r\nbusy";
const MAX_NONCE: usize = 128;
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_PROBE_RESPONSE: usize = 4096;

#[derive(Debug, Clone)]
pub struct RelayConfig {
    /// Bind address; loopback only (omp refuses plain `ws://` to anything else).
    pub bind: IpAddr,
    /// `0` picks a free port.
    pub port: u16,
    pub ping_interval: Duration,
    pub idle_timeout: Duration,
    pub max_message: usize,
    /// `0` = unlimited.
    pub max_guests_per_room: usize,
    /// Concurrent rooms; further hosts get close 1013. `0` = unlimited.
    pub max_rooms: usize,
    /// Concurrent TCP connections (peers and HTTP probes); excess sockets get 503. `0` = unlimited.
    pub max_connections: usize,
    /// Outbound bytes queued per connection. Raised to fit at least one `max_message` frame.
    pub max_queued_bytes: usize,
}

impl RelayConfig {
    pub fn new(port: u16) -> Self {
        Self {
            bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port,
            ping_interval: Duration::from_secs(20),
            idle_timeout: Duration::from_secs(60),
            // omp bounds every replicated entry/event to 1 MiB of JSON and transcript replies to
            // 4 MiB, but Bun's server default is 16 MiB and omp-collab.md §4 asks for at least that.
            max_message: 16 * 1024 * 1024,
            max_guests_per_room: 16,
            max_rooms: 256,
            max_connections: 512,
            max_queued_bytes: 32 * 1024 * 1024,
        }
    }

    /// Per-connection budget actually enforced: one maximal frame must always fit.
    fn queue_budget(&self) -> usize {
        self.max_queued_bytes.max(self.max_message + QUEUE_OVERHEAD).min(Semaphore::MAX_PERMITS)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RelayStats {
    pub rooms: usize,
    pub guests: usize,
    pub frames_h2g: u64,
    pub bytes_h2g: u64,
    pub frames_g2h: u64,
    pub bytes_g2h: u64,
}

/// The relay's per-process identity: a random HMAC key answered on `/healthz?nonce=`.
#[derive(Clone)]
pub struct RelayIdentity {
    secret: Arc<[u8; 32]>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityError {
    /// Nothing answered at the address (connect/read failure or timeout).
    Unreachable(String),
    /// Something answered, but not with a valid proof for our secret.
    Foreign(String),
}

impl std::fmt::Display for IdentityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IdentityError::Unreachable(e) => write!(f, "relay unreachable: {e}"),
            IdentityError::Foreign(e) => write!(f, "not this process's relay: {e}"),
        }
    }
}

impl std::error::Error for IdentityError {}

impl RelayIdentity {
    fn generate() -> io::Result<Self> {
        let mut secret = [0u8; 32];
        getrandom::fill(&mut secret).map_err(|e| io::Error::other(format!("OS random source unavailable: {e}")))?;
        Ok(Self { secret: Arc::new(secret) })
    }

    fn mac(&self, nonce: &str) -> Hmac<Sha256> {
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(self.secret.as_slice()).expect("HMAC accepts any key length");
        mac.update(nonce.as_bytes());
        mac
    }

    /// `hex(HMAC-SHA256(secret, nonce))`, the `/healthz` proof for `nonce`.
    pub fn proof(&self, nonce: &str) -> String {
        hex(&self.mac(nonce).finalize().into_bytes())
    }

    /// Whether `proof` (hex) is this identity's proof for `nonce` (constant-time compare).
    pub fn check(&self, nonce: &str, proof: &str) -> bool {
        unhex(proof).is_some_and(|tag| self.mac(nonce).verify_slice(&tag).is_ok())
    }

    /// Asks whatever listens on `addr` to prove it holds this identity's secret, with a fresh
    /// random nonce (so a recorded answer cannot be replayed).
    pub async fn verify(&self, addr: SocketAddr) -> Result<(), IdentityError> {
        let mut raw = [0u8; 16];
        getrandom::fill(&mut raw).map_err(|e| IdentityError::Unreachable(format!("OS random source unavailable: {e}")))?;
        let nonce = hex(&raw);
        let body = tokio::time::timeout(PROBE_TIMEOUT, probe_healthz(addr, &nonce))
            .await
            .map_err(|_| IdentityError::Unreachable(format!("{addr}: timed out")))?
            .map_err(|e| IdentityError::Unreachable(format!("{addr}: {e}")))?;
        let (status, body) = body;
        if status != 200 {
            return Err(IdentityError::Foreign(format!("{addr}: /healthz answered HTTP {status}")));
        }
        let proof = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("proof").and_then(|p| p.as_str()).map(str::to_owned))
            .ok_or_else(|| IdentityError::Foreign(format!("{addr}: /healthz has no identity proof")))?;
        if self.check(&nonce, &proof) {
            Ok(())
        } else {
            Err(IdentityError::Foreign(format!("{addr}: identity proof does not match")))
        }
    }
}

/// `GET /healthz?nonce=` → (status, body).
async fn probe_healthz(addr: SocketAddr, nonce: &str) -> io::Result<(u16, String)> {
    let mut stream = TcpStream::connect(addr).await?;
    let req = format!("GET /healthz?nonce={nonce} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).await?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > MAX_PROBE_RESPONSE {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "oversized /healthz response"));
        }
    }
    let mut headers = [httparse::EMPTY_HEADER; 32];
    let mut resp = httparse::Response::new(&mut headers);
    match resp.parse(&buf) {
        Ok(httparse::Status::Complete(at)) => {
            let status = resp.code.unwrap_or(0);
            Ok((status, String::from_utf8_lossy(&buf[at..]).into_owned()))
        }
        _ => Err(io::Error::new(io::ErrorKind::InvalidData, "not an HTTP response")),
    }
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[usize::from(b >> 4)] as char);
        s.push(DIGITS[usize::from(b & 15)] as char);
    }
    s
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    let digit = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    s.as_bytes().chunks(2).map(|p| Some(digit(p[0])? << 4 | digit(p[1])?)).collect()
}

fn valid_nonce(n: &str) -> bool {
    !n.is_empty() && n.len() <= MAX_NONCE && n.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

enum Out {
    Binary(Bytes),
    Text(&'static str),
    TextOwned(String),
    Close(u16, &'static str),
}

impl Out {
    fn cost(&self) -> u32 {
        let len = match self {
            Out::Binary(b) => b.len(),
            Out::Text(t) => t.len(),
            Out::TextOwned(t) => t.len(),
            Out::Close(..) => 0,
        };
        u32::try_from(len.saturating_add(QUEUE_OVERHEAD)).unwrap_or(u32::MAX)
    }
}

/// A queued message and the byte budget it holds until written to the socket.
struct Queued {
    out: Out,
    permit: Option<OwnedSemaphorePermit>,
}

/// A connection's outbound queue, bounded in bytes by a semaphore of `queue_budget` permits.
#[derive(Clone)]
struct Outbox {
    tx: mpsc::UnboundedSender<Queued>,
    budget: Arc<Semaphore>,
    /// Drops the connection now, even while it is blocked writing to a stalled socket.
    kick: Arc<Notify>,
}

impl Outbox {
    fn new(bytes: usize) -> (Self, mpsc::UnboundedReceiver<Queued>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Self { tx, budget: Arc::new(Semaphore::new(bytes)), kick: Arc::new(Notify::new()) }, rx)
    }

    /// Queues without waiting; false when over budget or the peer is gone.
    fn try_push(&self, out: Out) -> bool {
        let Ok(permit) = self.budget.clone().try_acquire_many_owned(out.cost()) else { return false };
        self.tx.send(Queued { out, permit: Some(permit) }).is_ok()
    }

    /// Queues once the peer has drained enough; false when the peer is gone.
    async fn push(&self, out: Out) -> bool {
        let Ok(permit) = self.budget.clone().acquire_many_owned(out.cost()).await else { return false };
        self.tx.send(Queued { out, permit: Some(permit) }).is_ok()
    }

    /// Control message outside the byte budget (the room-closed notice must always get through).
    fn push_control(&self, out: Out) {
        let _ = self.tx.send(Queued { out, permit: None });
    }

    /// Over budget: close the connection without draining its queue.
    fn kick(&self) {
        self.kick.notify_one();
    }
}

struct Room {
    host_conn: u64,
    host: Outbox,
    guests: BTreeMap<u32, Outbox>,
    next_peer: u32,
}

#[derive(Default)]
struct Counters {
    frames_h2g: AtomicU64,
    bytes_h2g: AtomicU64,
    frames_g2h: AtomicU64,
    bytes_g2h: AtomicU64,
}

struct Shared {
    cfg: RelayConfig,
    identity: RelayIdentity,
    rooms: Mutex<HashMap<String, Room>>,
    next_conn: AtomicU64,
    counters: Counters,
}

impl Shared {
    fn stats(&self) -> RelayStats {
        let rooms = self.rooms.lock().unwrap();
        RelayStats {
            rooms: rooms.len(),
            guests: rooms.values().map(|r| r.guests.len()).sum(),
            frames_h2g: self.counters.frames_h2g.load(Ordering::Relaxed),
            bytes_h2g: self.counters.bytes_h2g.load(Ordering::Relaxed),
            frames_g2h: self.counters.frames_g2h.load(Ordering::Relaxed),
            bytes_g2h: self.counters.bytes_g2h.load(Ordering::Relaxed),
        }
    }
}

/// A running relay. Dropping it without [`Relay::shutdown`] aborts the accept loop.
pub struct Relay {
    addr: SocketAddr,
    shared: Arc<Shared>,
    stop: watch::Sender<bool>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl Relay {
    /// Bind `cfg.bind:cfg.port` and start serving.
    pub async fn start(cfg: RelayConfig) -> io::Result<Relay> {
        let identity = RelayIdentity::generate()?;
        let listener = TcpListener::bind((cfg.bind, cfg.port)).await?;
        let addr = listener.local_addr()?;
        let shared = Arc::new(Shared {
            cfg,
            identity,
            rooms: Mutex::new(HashMap::new()),
            next_conn: AtomicU64::new(1),
            counters: Counters::default(),
        });
        let (stop, stop_rx) = watch::channel(false);
        let task = tokio::spawn(accept_loop(listener, shared.clone(), stop_rx));
        log::info!("collab relay listening on ws://{addr}");
        Ok(Relay { addr, shared, stop, task: Some(task) })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    /// `ws://127.0.0.1:<port>`: the value for omp's `collab.relayUrl`.
    pub fn url(&self) -> String {
        format!("ws://{}", self.addr)
    }

    /// This relay's identity, to verify that a `ws://` address really reaches it.
    pub fn identity(&self) -> RelayIdentity {
        self.shared.identity.clone()
    }

    pub fn stats(&self) -> RelayStats {
        self.shared.stats()
    }

    /// Graceful stop: guests get `room-closed` + 4001, hosts 1001; waits up to 3 s.
    pub async fn shutdown(mut self) {
        let _ = self.stop.send(true);
        if let Some(task) = self.task.take() {
            let _ = tokio::time::timeout(Duration::from_secs(3), task).await;
        }
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

async fn accept_loop(listener: TcpListener, shared: Arc<Shared>, mut stop: watch::Receiver<bool>) {
    let mut conns = JoinSet::new();
    loop {
        tokio::select! {
            _ = stop.changed() => break,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    while conns.try_join_next().is_some() {}
                    if shared.cfg.max_connections > 0 && conns.len() >= shared.cfg.max_connections {
                        log::debug!("relay: connection limit ({}) reached; refusing", shared.cfg.max_connections);
                        let _ = stream.try_write(BUSY_RESPONSE);
                    } else {
                        let _ = stream.set_nodelay(true);
                        conns.spawn(serve_conn(stream, shared.clone(), stop.clone()));
                    }
                }
                Err(e) => {
                    log::warn!("relay accept failed: {e}");
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            },
            Some(_) = conns.join_next(), if !conns.is_empty() => {}
        }
    }
    drop(listener);
    // Connections observe `stop` themselves and close with the right codes.
    let drain = async { while conns.join_next().await.is_some() {} };
    if tokio::time::timeout(Duration::from_secs(2), drain).await.is_err() {
        conns.abort_all();
    }
    shared.rooms.lock().unwrap().clear();
}

enum Admit {
    Peer(u32),
    DuplicateHost,
    TooManyRooms,
    NoRoom,
    Full,
}
struct Head {
    path: String,
    query: String,
    upgrade: bool,
    ws_key: Option<String>,
    /// An `Origin` header was sent (browsers always send one; omp and hostd never do).
    origin: bool,
    consumed: usize,
}

async fn read_head(stream: &mut TcpStream, buf: &mut Vec<u8>) -> io::Result<Option<Head>> {
    let mut chunk = [0u8; 2048];
    loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk[..n]);
        let mut headers = [httparse::EMPTY_HEADER; 64];
        let mut req = httparse::Request::new(&mut headers);
        match req.parse(buf) {
            Ok(httparse::Status::Complete(consumed)) => {
                let target = req.path.unwrap_or("/");
                let (path, query) = target.split_once('?').unwrap_or((target, ""));
                let header = |name: &str| {
                    req.headers
                        .iter()
                        .find(|h| h.name.eq_ignore_ascii_case(name))
                        .and_then(|h| std::str::from_utf8(h.value).ok())
                };
                let upgrade = req.method == Some("GET")
                    && header("upgrade").is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
                    && header("connection")
                        .is_some_and(|v| v.split(',').any(|t| t.trim().eq_ignore_ascii_case("upgrade")));
                return Ok(Some(Head {
                    path: path.to_owned(),
                    query: query.to_owned(),
                    upgrade,
                    ws_key: header("sec-websocket-key").map(str::to_owned),
                    origin: req.headers.iter().any(|h| h.name.eq_ignore_ascii_case("origin")),
                    consumed,
                }));
            }
            Ok(httparse::Status::Partial) if buf.len() < MAX_HEAD => continue,
            _ => return Err(io::Error::new(io::ErrorKind::InvalidData, "bad http request")),
        }
    }
}

async fn respond(stream: &mut TcpStream, status: &str, ctype: &str, body: &str) {
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes()).await;
    let _ = stream.shutdown().await;
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PeerRole {
    Host,
    Guest,
}

async fn serve_conn(mut stream: TcpStream, shared: Arc<Shared>, stop: watch::Receiver<bool>) {
    let mut buf = Vec::new();
    let head = match tokio::time::timeout(HEAD_TIMEOUT, read_head(&mut stream, &mut buf)).await {
        Ok(Ok(Some(h))) => h,
        Ok(Err(_)) => return respond(&mut stream, "400 Bad Request", "text/plain", "bad request").await,
        _ => return,
    };
    if head.origin {
        // Web pages can open ws://127.0.0.1 sockets; omp and hostd send no Origin.
        log::debug!("relay: refusing request with an Origin header");
        return respond(&mut stream, "403 Forbidden", "text/plain", "browser origins are not allowed").await;
    }
    if head.path == "/healthz" {
        let s = shared.stats();
        let nonce = head.query.split('&').find_map(|kv| kv.strip_prefix("nonce="));
        let body = match nonce {
            Some(n) if valid_nonce(n) => format!(
                r#"{{"ok":true,"rooms":{},"guests":{},"proof":"{}"}}"#,
                s.rooms,
                s.guests,
                shared.identity.proof(n)
            ),
            Some(_) => return respond(&mut stream, "400 Bad Request", "text/plain", "bad nonce").await,
            None => format!(r#"{{"ok":true,"rooms":{},"guests":{}}}"#, s.rooms, s.guests),
        };
        return respond(&mut stream, "200 OK", "application/json", &body).await;
    }
    let room_id = head.path.strip_prefix("/r/").filter(|r| is_room_id(r)).map(str::to_owned);
    let role = head.query.split('&').find_map(|kv| match kv {
        "role=host" => Some(PeerRole::Host),
        "role=guest" => Some(PeerRole::Guest),
        _ => None,
    });
    let (Some(room_id), Some(role)) = (room_id, role) else {
        return respond(&mut stream, "404 Not Found", "text/plain", "not found").await;
    };
    let Some(key) = head.ws_key.as_deref().filter(|_| head.upgrade) else {
        return respond(&mut stream, "426 Upgrade Required", "text/plain", "websocket upgrade required").await;
    };
    let accept = derive_accept_key(key.as_bytes());
    let resp = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
    );
    if stream.write_all(resp.as_bytes()).await.is_err() {
        return;
    }
    let config = WebSocketConfig::default()
        .max_message_size(Some(shared.cfg.max_message))
        .max_frame_size(Some(shared.cfg.max_message));
    let leftover = buf.split_off(head.consumed);
    let ws = WebSocketStream::from_partially_read(stream, leftover, Role::Server, Some(config)).await;
    run_peer(ws, room_id, role, shared, stop).await;
}

async fn close_now(ws: &mut WebSocketStream<TcpStream>, code: u16, reason: &'static str) {
    let frame = CloseFrame { code: CloseCode::from(code), reason: reason.into() };
    let _ = ws.send(Message::Close(Some(frame))).await;
    // Let the client answer the close handshake briefly.
    let _ = tokio::time::timeout(Duration::from_secs(2), async { while let Some(Ok(_)) = ws.next().await {} }).await;
}

async fn run_peer(
    mut ws: WebSocketStream<TcpStream>,
    room_id: String,
    role: PeerRole,
    shared: Arc<Shared>,
    mut stop: watch::Receiver<bool>,
) {
    let conn_id = shared.next_conn.fetch_add(1, Ordering::Relaxed);
    let (outbox, mut rx) = Outbox::new(shared.cfg.queue_budget());
    let admit = {
        let mut rooms = shared.rooms.lock().unwrap();
        match role {
            PeerRole::Host if rooms.contains_key(&room_id) => Admit::DuplicateHost,
            PeerRole::Host if shared.cfg.max_rooms > 0 && rooms.len() >= shared.cfg.max_rooms => Admit::TooManyRooms,
            PeerRole::Host => {
                let room = Room { host_conn: conn_id, host: outbox.clone(), guests: BTreeMap::new(), next_peer: 1 };
                rooms.insert(room_id.clone(), room);
                Admit::Peer(0)
            }
            PeerRole::Guest => match rooms.get_mut(&room_id) {
                None => Admit::NoRoom,
                Some(room)
                    if shared.cfg.max_guests_per_room > 0 && room.guests.len() >= shared.cfg.max_guests_per_room =>
                {
                    Admit::Full
                }
                Some(room) => {
                    let id = room.next_peer;
                    room.next_peer += 1;
                    room.guests.insert(id, outbox.clone());
                    room.host.try_push(Out::TextOwned(format!(r#"{{"t":"peer-joined","peer":{id}}}"#)));
                    Admit::Peer(id)
                }
            },
        }
    };
    let kick = outbox.kick.clone();
    let budget = outbox.budget.clone();
    drop(outbox);
    let peer_id = match admit {
        Admit::DuplicateHost => {
            log::debug!("relay: duplicate host for room {room_id}");
            return close_now(&mut ws, CLOSE_DUPLICATE_HOST, "a host is already connected for this room").await;
        }
        Admit::TooManyRooms => {
            log::warn!("relay: room limit ({}) reached; refusing a new host", shared.cfg.max_rooms);
            return close_now(&mut ws, CLOSE_TOO_MANY_ROOMS, "relay room limit reached").await;
        }
        Admit::NoRoom => {
            log::debug!("relay: guest for missing room {room_id}");
            return close_now(&mut ws, CLOSE_NO_SUCH_ROOM, "no such room").await;
        }
        Admit::Full => return close_now(&mut ws, CLOSE_ROOM_FULL, "room is full").await,
        Admit::Peer(id) => {
            log::debug!("relay: {} open room={room_id} peer={id}", if role == PeerRole::Host { "host" } else { "guest" });
            id
        }
    };

    let (mut sink, mut stream) = ws.split();
    let tick = shared.cfg.ping_interval.min(Duration::from_secs(5));
    let mut ticker = tokio::time::interval(tick);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_heard = Instant::now();
    let mut last_ping = Instant::now();
    let mut close_with: Option<(u16, &'static str)> = None;
    // A write blocked this long (peer not reading) drops the connection like silence does.
    let limit = shared.cfg.idle_timeout;

    loop {
        let sent = tokio::select! {
            _ = kick.notified() => Sent::Kicked,
            _ = stop.changed() => {
                if role == PeerRole::Guest {
                    let _ = send_bounded(&mut sink, Message::text(ROOM_CLOSED_TEXT), limit, &kick).await;
                    close_with = Some((CLOSE_ROOM_CLOSED, "room closed"));
                } else {
                    close_with = Some((1001, "relay shutting down"));
                }
                break;
            }
            _ = ticker.tick() => {
                if last_heard.elapsed() > shared.cfg.idle_timeout {
                    log::debug!("relay: dropping silent {} room={room_id} peer={peer_id}", if role == PeerRole::Host { "host" } else { "guest" });
                    break;
                }
                if last_ping.elapsed() >= shared.cfg.ping_interval {
                    last_ping = Instant::now();
                    send_bounded(&mut sink, Message::Ping(Default::default()), limit, &kick).await
                } else {
                    Sent::Ok
                }
            }
            queued = rx.recv() => {
                let Some(Queued { out, permit }) = queued else { break };
                let msg = match out {
                    Out::Binary(b) => Message::Binary(b),
                    Out::Text(t) => Message::text(t),
                    Out::TextOwned(t) => Message::text(t),
                    Out::Close(code, reason) => { close_with = Some((code, reason)); break; }
                };
                let sent = send_bounded(&mut sink, msg, limit, &kick).await;
                // The byte budget is released only once the frame has been handed to the socket.
                drop(permit);
                sent
            }
            msg = stream.next() => {
                let Some(Ok(msg)) = msg else { break };
                last_heard = Instant::now();
                match msg {
                    Message::Binary(data) if data.len() >= 4 => {
                        if route(&shared, &room_id, role, conn_id, peer_id, data).await { Sent::Ok } else { Sent::Failed }
                    }
                    Message::Close(_) => break,
                    // Pings are answered by tungstenite; text and runt frames from clients are ignored.
                    _ => Sent::Ok,
                }
            }
        };
        match sent {
            Sent::Ok => {}
            Sent::Failed => break,
            Sent::Kicked => {
                close_with = Some((CLOSE_BACKLOG, "send backlog exceeded"));
                break;
            }
        }
    }
    // Wake guests waiting for this connection's budget; nothing more will be read from `rx`.
    budget.close();

    // Unregister and notify.
    {
        let mut rooms = shared.rooms.lock().unwrap();
        match role {
            PeerRole::Host => {
                if rooms.get(&room_id).is_some_and(|r| r.host_conn == conn_id) {
                    let room = rooms.remove(&room_id).unwrap();
                    for guest in room.guests.values() {
                        guest.push_control(Out::Text(ROOM_CLOSED_TEXT));
                        guest.push_control(Out::Close(CLOSE_ROOM_CLOSED, "room closed"));
                    }
                    log::debug!("relay: host closed room={room_id} ({} guests)", room.guests.len());
                }
            }
            PeerRole::Guest => {
                if let Some(room) = rooms.get_mut(&room_id) {
                    if room.guests.remove(&peer_id).is_some() {
                        room.host.try_push(Out::TextOwned(format!(r#"{{"t":"peer-left","peer":{peer_id}}}"#)));
                    }
                }
                log::debug!("relay: guest closed room={room_id} peer={peer_id}");
            }
        }
    }
    if let Some((code, reason)) = close_with {
        let frame = CloseFrame { code: CloseCode::from(code), reason: reason.into() };
        // Bounded: a kicked peer is usually not reading at all.
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            if sink.send(Message::Close(Some(frame))).await.is_ok() {
                while let Some(Ok(_)) = stream.next().await {}
            }
        })
        .await;
    }
}

enum Sent {
    Ok,
    Failed,
    Kicked,
}

type WsSink = futures_util::stream::SplitSink<WebSocketStream<TcpStream>, Message>;

/// Writes one message unless the connection is kicked first or the write stalls past `limit`.
async fn send_bounded(sink: &mut WsSink, msg: Message, limit: Duration, kick: &Notify) -> Sent {
    tokio::select! {
        _ = kick.notified() => Sent::Kicked,
        r = tokio::time::timeout(limit, sink.send(msg)) => if matches!(r, Ok(Ok(()))) { Sent::Ok } else { Sent::Failed },
    }
}

/// Route one binary frame. Returns false when the sender must be dropped.
async fn route(shared: &Shared, room_id: &str, role: PeerRole, conn_id: u64, peer_id: u32, data: Bytes) -> bool {
    let len = data.len() as u64;
    match role {
        PeerRole::Host => {
            let target = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
            shared.counters.frames_h2g.fetch_add(1, Ordering::Relaxed);
            shared.counters.bytes_h2g.fetch_add(len, Ordering::Relaxed);
            let mut rooms = shared.rooms.lock().unwrap();
            let Some(room) = rooms.get_mut(room_id).filter(|r| r.host_conn == conn_id) else { return true };
            let mut lagging = Vec::new();
            if target == 0 {
                // `Bytes` clones share one buffer across every guest.
                for (id, guest) in &room.guests {
                    if !guest.try_push(Out::Binary(data.clone())) {
                        lagging.push(*id);
                    }
                }
            } else if let Some(guest) = room.guests.get(&target) {
                if !guest.try_push(Out::Binary(data)) {
                    lagging.push(target);
                }
            }
            for id in lagging {
                // Over its byte budget (stalled reader) or its task is gone: drop it.
                if let Some(guest) = room.guests.remove(&id) {
                    log::warn!("relay: dropping guest peer={id}: send backlog exceeded");
                    guest.kick();
                    room.host.try_push(Out::TextOwned(format!(r#"{{"t":"peer-left","peer":{id}}}"#)));
                }
            }
            true
        }
        PeerRole::Guest => {
            let mut data = Vec::from(data);
            data[..4].copy_from_slice(&peer_id.to_be_bytes());
            shared.counters.frames_g2h.fetch_add(1, Ordering::Relaxed);
            shared.counters.bytes_g2h.fetch_add(len, Ordering::Relaxed);
            let host = {
                let rooms = shared.rooms.lock().unwrap();
                match rooms.get(room_id) {
                    Some(room) if room.guests.contains_key(&peer_id) => room.host.clone(),
                    _ => return false,
                }
            };
            // Backpressure the guest (wait for the host's byte budget) instead of dropping frames.
            host.push(Out::Binary(Bytes::from(data))).await
        }
    }
}
