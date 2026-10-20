//! Loopback collab relay (`omp-collab.md` §4), wire-compatible with omp's `local-relay.ts`.
//!
//! * `GET /r/<roomId>?role=host|guest` + WebSocket upgrade. Wrong path/role → 404, no upgrade → 426.
//! * `GET /healthz` → `{"ok":true,"rooms":N,"guests":M}`.
//! * Room state: first host creates the room; a second live host gets close 4009. A guest for a
//!   missing room gets close 4004 *after* the upgrade. Guests get peer ids 1, 2, … per room
//!   incarnation; the host is told `{"t":"peer-joined","peer":N}` / `peer-left`.
//! * Host BINARY `[u32 BE peer][sealed]`: 0 broadcasts, N targets guest N. Guest BINARY gets its
//!   first 4 bytes rewritten to the sender's id and goes to the host. TEXT from clients is ignored.
//! * Host leaves → each guest gets TEXT `{"t":"room-closed"}` then close 4001.
//! * Liveness: ping every `ping_interval` (20 s), drop after `idle_timeout` (60 s) of silence.
//! * Max message `max_message` (16 MiB). Optional per-room guest cap → close 4029.

use std::collections::{BTreeMap, HashMap};
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinSet;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::frame::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};

use crate::link::is_room_id;

pub const CLOSE_ROOM_CLOSED: u16 = 4001;
pub const CLOSE_NO_SUCH_ROOM: u16 = 4004;
pub const CLOSE_DUPLICATE_HOST: u16 = 4009;
pub const CLOSE_ROOM_FULL: u16 = 4029;

const ROOM_CLOSED_TEXT: &str = r#"{"t":"room-closed"}"#;
const MAX_HEAD: usize = 16 * 1024;
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
/// Per-connection outbound queue (frames). A guest that falls this far behind is dropped.
const OUT_QUEUE: usize = 1024;

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
}

impl RelayConfig {
    pub fn new(port: u16) -> Self {
        Self {
            bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port,
            ping_interval: Duration::from_secs(20),
            idle_timeout: Duration::from_secs(60),
            max_message: 16 * 1024 * 1024,
            max_guests_per_room: 16,
        }
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

enum Out {
    Binary(Vec<u8>),
    Text(&'static str),
    TextOwned(String),
    Close(u16, &'static str),
}

struct Room {
    host_conn: u64,
    host: mpsc::Sender<Out>,
    guests: BTreeMap<u32, mpsc::Sender<Out>>,
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
        let listener = TcpListener::bind((cfg.bind, cfg.port)).await?;
        let addr = listener.local_addr()?;
        let shared = Arc::new(Shared {
            cfg,
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
                    let _ = stream.set_nodelay(true);
                    conns.spawn(serve_conn(stream, shared.clone(), stop.clone()));
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
    NoRoom,
    Full,
}
struct Head {
    path: String,
    query: String,
    upgrade: bool,
    ws_key: Option<String>,
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
    if head.path == "/healthz" {
        let s = shared.stats();
        let body = format!(r#"{{"ok":true,"rooms":{},"guests":{}}}"#, s.rooms, s.guests);
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
    let (tx, mut rx) = mpsc::channel::<Out>(OUT_QUEUE);
    let admit = {
        let mut rooms = shared.rooms.lock().unwrap();
        match role {
            PeerRole::Host if rooms.contains_key(&room_id) => Admit::DuplicateHost,
            PeerRole::Host => {
                let room = Room { host_conn: conn_id, host: tx.clone(), guests: BTreeMap::new(), next_peer: 1 };
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
                    room.guests.insert(id, tx.clone());
                    let _ = room.host.try_send(Out::TextOwned(format!(r#"{{"t":"peer-joined","peer":{id}}}"#)));
                    Admit::Peer(id)
                }
            },
        }
    };
    drop(tx);
    let peer_id = match admit {
        Admit::DuplicateHost => {
            log::info!("relay: duplicate host for room {room_id}");
            return close_now(&mut ws, CLOSE_DUPLICATE_HOST, "a host is already connected for this room").await;
        }
        Admit::NoRoom => {
            log::debug!("relay: guest for missing room {room_id}");
            return close_now(&mut ws, CLOSE_NO_SUCH_ROOM, "no such room").await;
        }
        Admit::Full => return close_now(&mut ws, CLOSE_ROOM_FULL, "room is full").await,
        Admit::Peer(id) => {
            log::info!("relay: {} open room={room_id} peer={id}", if role == PeerRole::Host { "host" } else { "guest" });
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

    loop {
        tokio::select! {
            _ = stop.changed() => {
                if role == PeerRole::Guest {
                    let _ = sink.send(Message::text(ROOM_CLOSED_TEXT)).await;
                    close_with = Some((CLOSE_ROOM_CLOSED, "room closed"));
                } else {
                    close_with = Some((1001, "relay shutting down"));
                }
                break;
            }
            _ = ticker.tick() => {
                if last_heard.elapsed() > shared.cfg.idle_timeout {
                    log::info!("relay: dropping silent {} room={room_id} peer={peer_id}", if role == PeerRole::Host { "host" } else { "guest" });
                    break;
                }
                if last_ping.elapsed() >= shared.cfg.ping_interval {
                    last_ping = Instant::now();
                    if sink.send(Message::Ping(Default::default())).await.is_err() { break; }
                }
            }
            out = rx.recv() => match out {
                Some(Out::Binary(b)) => if sink.send(Message::binary(b)).await.is_err() { break },
                Some(Out::Text(t)) => if sink.send(Message::text(t)).await.is_err() { break },
                Some(Out::TextOwned(t)) => if sink.send(Message::text(t)).await.is_err() { break },
                Some(Out::Close(code, reason)) => { close_with = Some((code, reason)); break; }
                None => break,
            },
            msg = stream.next() => {
                let Some(Ok(msg)) = msg else { break };
                last_heard = Instant::now();
                match msg {
                    Message::Binary(data) => {
                        if data.len() < 4 { continue; }
                        if !route(&shared, &room_id, role, conn_id, peer_id, data.into()).await { break; }
                    }
                    Message::Close(_) => break,
                    // Pings are answered by tungstenite; text from clients is ignored.
                    _ => {}
                }
            }
        }
    }

    // Unregister and notify.
    {
        let mut rooms = shared.rooms.lock().unwrap();
        match role {
            PeerRole::Host => {
                if rooms.get(&room_id).is_some_and(|r| r.host_conn == conn_id) {
                    let room = rooms.remove(&room_id).unwrap();
                    for guest in room.guests.values() {
                        let _ = guest.try_send(Out::Text(ROOM_CLOSED_TEXT));
                        let _ = guest.try_send(Out::Close(CLOSE_ROOM_CLOSED, "room closed"));
                    }
                    log::info!("relay: host closed room={room_id} ({} guests)", room.guests.len());
                }
            }
            PeerRole::Guest => {
                if let Some(room) = rooms.get_mut(&room_id) {
                    if room.guests.remove(&peer_id).is_some() {
                        let _ = room.host.try_send(Out::TextOwned(format!(r#"{{"t":"peer-left","peer":{peer_id}}}"#)));
                    }
                }
                log::info!("relay: guest closed room={room_id} peer={peer_id}");
            }
        }
    }
    if let Some((code, reason)) = close_with {
        let frame = CloseFrame { code: CloseCode::from(code), reason: reason.into() };
        let _ = sink.send(Message::Close(Some(frame))).await;
        let _ = tokio::time::timeout(Duration::from_secs(2), async { while let Some(Ok(_)) = stream.next().await {} }).await;
    }
}

/// Route one binary frame. Returns false when the sender must be dropped.
async fn route(shared: &Shared, room_id: &str, role: PeerRole, conn_id: u64, peer_id: u32, mut data: Vec<u8>) -> bool {
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
                let n = room.guests.len();
                for (i, (id, guest)) in room.guests.iter().enumerate() {
                    let payload = if i + 1 == n { std::mem::take(&mut data) } else { data.clone() };
                    if guest.try_send(Out::Binary(payload)).is_err() {
                        lagging.push(*id);
                    }
                }
            } else if let Some(guest) = room.guests.get(&target) {
                if guest.try_send(Out::Binary(data)).is_err() {
                    lagging.push(target);
                }
            }
            for id in lagging {
                // The guest's queue is full (stalled reader) or its task is gone: drop it.
                if let Some(guest) = room.guests.remove(&id) {
                    log::warn!("relay: dropping lagging guest room={room_id} peer={id}");
                    let _ = guest.try_send(Out::Close(1008, "send backlog exceeded"));
                    let _ = room.host.try_send(Out::TextOwned(format!(r#"{{"t":"peer-left","peer":{id}}}"#)));
                }
            }
            true
        }
        PeerRole::Guest => {
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
            // Backpressure the guest instead of dropping its frames.
            host.send(Out::Binary(data)).await.is_ok()
        }
    }
}
