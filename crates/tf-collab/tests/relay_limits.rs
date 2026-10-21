//! Relay hardening: browser Origins refused, room/connection caps, per-guest byte budget, and the
//! `/healthz` nonce identity proof. Runs offline.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tf_collab::{IdentityError, Relay, RelayConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{self, Message};

const ROOM_A: &str = "TfRelayLimitsRoom00001";
const ROOM_B: &str = "TfRelayLimitsRoom00002";

async fn http(port: u16, req: &str) -> String {
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    s.write_all(req.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    let _ = s.read_to_end(&mut out).await;
    String::from_utf8_lossy(&out).into_owned()
}

fn url(port: u16, room: &str, role: &str) -> String {
    format!("ws://127.0.0.1:{port}/r/{room}?role={role}")
}

async fn close_code<S>(ws: &mut S) -> u16
where
    S: StreamExt<Item = Result<Message, tungstenite::Error>> + Unpin,
{
    loop {
        match tokio::time::timeout(Duration::from_secs(10), ws.next()).await.expect("close timeout") {
            Some(Ok(Message::Close(Some(f)))) => return u16::from(f.code),
            Some(Ok(_)) => continue,
            other => panic!("expected a close frame, got {other:?}"),
        }
    }
}

async fn wait_for(mut cond: impl FnMut() -> bool) {
    for _ in 0..200 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("condition not reached");
}

#[tokio::test(flavor = "multi_thread")]
async fn browser_origin_is_refused() {
    let relay = Relay::start(RelayConfig::new(0)).await.unwrap();
    let port = relay.port();

    // What hostd's guest sends: tungstenite adds no Origin header of its own.
    let req = url(port, ROOM_A, "host").into_client_request().unwrap();
    assert!(req.headers().get("origin").is_none());

    let mut req = url(port, ROOM_A, "host").into_client_request().unwrap();
    req.headers_mut().insert("Origin", "https://evil.example".parse().unwrap());
    match tokio_tungstenite::connect_async(req).await {
        Err(tungstenite::Error::Http(resp)) => assert_eq!(resp.status(), 403),
        other => panic!("expected 403, got {:?}", other.map(|(_, r)| r.status())),
    }
    let raw = http(
        port,
        &format!(
            "GET /r/{ROOM_A}?role=guest HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\norigin: null\r\n\r\n"
        ),
    )
    .await;
    assert!(raw.starts_with("HTTP/1.1 403"), "{raw}");
    let health = http(port, "GET /healthz HTTP/1.1\r\nHost: x\r\nOrigin: http://localhost:1420\r\n\r\n").await;
    assert!(health.starts_with("HTTP/1.1 403"), "{health}");
    assert_eq!(relay.stats().rooms, 0);

    // Same request without Origin (omp's Bun client) is accepted.
    let (_host, _) = tokio_tungstenite::connect_async(url(port, ROOM_A, "host")).await.unwrap();
    wait_for(|| relay.stats().rooms == 1).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn room_cap_refuses_new_hosts() {
    let relay = Relay::start(RelayConfig { max_rooms: 1, ..RelayConfig::new(0) }).await.unwrap();
    let port = relay.port();
    let (a, _) = tokio_tungstenite::connect_async(url(port, ROOM_A, "host")).await.unwrap();
    wait_for(|| relay.stats().rooms == 1).await;

    let (mut b, _) = tokio_tungstenite::connect_async(url(port, ROOM_B, "host")).await.unwrap();
    assert_eq!(close_code(&mut b).await, tf_collab::relay::CLOSE_TOO_MANY_ROOMS);
    assert_eq!(relay.stats().rooms, 1);

    drop(a);
    wait_for(|| relay.stats().rooms == 0).await;
    let (_b, _) = tokio_tungstenite::connect_async(url(port, ROOM_B, "host")).await.unwrap();
    wait_for(|| relay.stats().rooms == 1).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn connection_cap_refuses_excess_sockets() {
    let relay = Relay::start(RelayConfig { max_connections: 2, ..RelayConfig::new(0) }).await.unwrap();
    let port = relay.port();
    let (a, _) = tokio_tungstenite::connect_async(url(port, ROOM_A, "host")).await.unwrap();
    let (_b, _) = tokio_tungstenite::connect_async(url(port, ROOM_B, "host")).await.unwrap();
    wait_for(|| relay.stats().rooms == 2).await;

    let busy = http(port, "GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n").await;
    assert!(busy.starts_with("HTTP/1.1 503"), "{busy}");
    assert!(tokio_tungstenite::connect_async(url(port, "TfRelayLimitsRoom00003", "host")).await.is_err());

    drop(a);
    wait_for(|| relay.stats().rooms == 1).await;
    // The slot frees once the connection task ends.
    let mut ok = false;
    for _ in 0..100 {
        if http(port, "GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n").await.starts_with("HTTP/1.1 200") {
            ok = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(ok, "connection slot was not released");
}

#[tokio::test(flavor = "multi_thread")]
async fn stalled_guest_over_byte_budget_is_dropped() {
    let frame = 64 * 1024;
    let cfg = RelayConfig { max_message: frame, max_queued_bytes: 2 * frame, ..RelayConfig::new(0) };
    let relay = Relay::start(cfg).await.unwrap();
    let port = relay.port();

    let (host, _) = tokio_tungstenite::connect_async(url(port, ROOM_A, "host")).await.unwrap();
    let (mut host_tx, mut host_rx) = host.split();
    // A guest that never reads: everything for it piles up in the relay.
    let (stalled, _) = tokio_tungstenite::connect_async(url(port, ROOM_A, "guest")).await.unwrap();
    let joined = tokio::time::timeout(Duration::from_secs(5), host_rx.next()).await.unwrap().unwrap().unwrap();
    assert_eq!(joined.into_text().unwrap().as_str(), r#"{"t":"peer-joined","peer":1}"#);

    // Broadcast until the relay gives up on the guest (kernel buffers absorb a few MiB first).
    let sender = tokio::spawn(async move {
        let payload = vec![0u8; frame - 64];
        for _ in 0..4096 {
            if host_tx.send(Message::binary(payload.clone())).await.is_err() {
                break;
            }
        }
        host_tx
    });
    let left = tokio::time::timeout(Duration::from_secs(30), async {
        while let Some(Ok(msg)) = host_rx.next().await {
            if let Message::Text(t) = msg {
                return t.as_str().to_owned();
            }
        }
        panic!("host stream ended");
    })
    .await
    .expect("guest was not dropped");
    assert_eq!(left, r#"{"t":"peer-left","peer":1}"#);
    assert_eq!(relay.stats().guests, 0);
    assert_eq!(relay.stats().rooms, 1, "the host stays connected");
    sender.abort();
    drop(stalled);
}

#[tokio::test(flavor = "multi_thread")]
async fn healthz_nonce_proves_identity() {
    let ours = Relay::start(RelayConfig::new(0)).await.unwrap();
    let other = Relay::start(RelayConfig::new(0)).await.unwrap();
    let id = ours.identity();

    // Plain healthz is unchanged; with a nonce it carries the proof.
    let plain = http(ours.port(), "GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n").await;
    assert!(plain.ends_with(r#"{"ok":true,"rooms":0,"guests":0}"#), "{plain}");
    let proved = http(ours.port(), "GET /healthz?nonce=abc123 HTTP/1.1\r\nHost: x\r\n\r\n").await;
    let body: serde_json::Value = serde_json::from_str(proved.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    let proof = body["proof"].as_str().unwrap();
    assert_eq!(proof, id.proof("abc123"));
    assert!(id.check("abc123", proof));
    assert!(!id.check("abc124", proof));
    assert!(!other.identity().check("abc123", proof));
    assert!(http(ours.port(), "GET /healthz?nonce=a%20b HTTP/1.1\r\nHost: x\r\n\r\n").await.starts_with("HTTP/1.1 400"));

    // Good relay vs. a foreign relay on another port.
    id.verify(ours.local_addr()).await.unwrap();
    assert!(matches!(id.verify(other.local_addr()).await, Err(IdentityError::Foreign(_))));

    // A squatter that answers healthz (even echoing the nonce) cannot forge the proof.
    let squatter = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let squat_addr = squatter.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = squatter.accept().await {
            let mut buf = vec![0u8; 2048];
            let n = s.read(&mut buf).await.unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).into_owned();
            let nonce = req.split("nonce=").nth(1).and_then(|r| r.split(' ').next()).unwrap_or("").to_owned();
            let body = format!(r#"{{"ok":true,"rooms":0,"guests":0,"proof":"{nonce}"}}"#);
            let resp = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = s.write_all(resp.as_bytes()).await;
        }
    });
    assert!(matches!(id.verify(squat_addr).await, Err(IdentityError::Foreign(_))));

    // Nothing listening.
    let closed = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap()
    };
    assert!(matches!(id.verify(closed).await, Err(IdentityError::Unreachable(_))));
}
