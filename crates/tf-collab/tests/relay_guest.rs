//! Relay + guest against a scripted fake omp host (wire-level: envelopes, routing, close codes,
//! resync after host reconnect). Runs offline.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tf_collab::frame::GuestFrame;
use tf_collab::{CollabLink, EndReason, Guest, GuestError, GuestEvent, HostFrame, Relay, RelayConfig, RoomKey};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message;

const ROOM: &str = "TfRelayTestRoom0000001";

fn link(port: u16) -> CollabLink {
    let key: [u8; 32] = std::array::from_fn(|i| i as u8 * 3);
    let tok: [u8; 16] = [7; 16];
    let mut secret = key.to_vec();
    secret.extend_from_slice(&tok);
    use base64::Engine as _;
    let s = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&secret);
    CollabLink::parse(&format!("http://127.0.0.1:{port}/#ws://127.0.0.1:{port}/r/{ROOM}.{s}")).unwrap()
}

async fn http(port: u16, req: &str) -> String {
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    s.write_all(req.as_bytes()).await.unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).await.unwrap();
    out
}

/// A minimal omp host: welcome + one-entry snapshot per hello, echoes prompts as events,
/// answers fetch-transcript. Reports guest frames on `seen`.
async fn fake_host(port: u16, key: RoomKey, seen: tokio::sync::mpsc::UnboundedSender<(u32, Value)>) -> tokio::task::JoinHandle<()> {
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/r/{ROOM}?role=host")).await.unwrap();
    tokio::spawn(async move {
        let (mut tx, mut rx) = ws.split();
        while let Some(Ok(msg)) = rx.next().await {
            let data = match msg {
                Message::Binary(b) => b,
                Message::Text(t) => {
                    let _ = seen.send((0, serde_json::from_str(&t).unwrap()));
                    continue;
                }
                Message::Close(_) => break,
                _ => continue,
            };
            // Like omp: undecryptable guest frames are dropped silently.
            let Ok((peer, plain)) = key.open(&data) else { continue };
            let frame: Value = serde_json::from_slice(&plain).unwrap();
            let _ = seen.send((peer, frame.clone()));
            let send = |target: u32, v: Value| Message::binary(key.seal(target, &serde_json::to_vec(&v).unwrap()));
            match frame["t"].as_str().unwrap() {
                "hello" => {
                    let welcome = json!({"t":"welcome","proto":3,
                        "header":{"type":"session","version":3,"id":"sess-1","timestamp":"2026-10-20T21:52:42.390Z","cwd":"/tmp/w"},
                        "state":{"isStreaming":false,"queuedMessageCount":0,"cwd":"/tmp/w","participants":[]},
                        "agents":[],"entryCount":1});
                    tx.send(send(peer, welcome)).await.unwrap();
                    let chunk = json!({"t":"snapshot-chunk","final":true,"entries":[
                        {"type":"model_change","id":"e1","parentId":null,"timestamp":"2026-10-20T21:52:42.446Z","model":"p/m"}]});
                    tx.send(send(peer, chunk)).await.unwrap();
                }
                "prompt" => {
                    tx.send(send(0, json!({"t":"event","event":{"type":"agent_start"}}))).await.unwrap();
                }
                "fetch-transcript" => {
                    let reply = json!({"t":"transcript","reqId":frame["reqId"],"text":"{\"type\":\"session\"}\n","newSize":18});
                    tx.send(send(peer, reply)).await.unwrap();
                }
                _ => {}
            }
        }
    })
}

async fn next(ev: &mut tokio::sync::mpsc::UnboundedReceiver<GuestEvent>) -> GuestEvent {
    tokio::time::timeout(Duration::from_secs(10), ev.recv()).await.expect("guest event timeout").expect("guest stream ended")
}

#[tokio::test(flavor = "multi_thread")]
async fn relay_and_guest_end_to_end() {
    let relay = Relay::start(RelayConfig::new(0)).await.unwrap();
    let port = relay.port();
    assert!(relay.local_addr().ip().is_loopback());

    // Plain HTTP endpoints.
    let health = http(port, "GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n").await;
    assert!(health.starts_with("HTTP/1.1 200") && health.ends_with(r#"{"ok":true,"rooms":0,"guests":0}"#), "{health}");
    assert!(http(port, "GET /nope HTTP/1.1\r\nHost: x\r\n\r\n").await.starts_with("HTTP/1.1 404"));
    assert!(http(port, &format!("GET /r/{ROOM}?role=boss HTTP/1.1\r\nHost: x\r\n\r\n")).await.starts_with("HTTP/1.1 404"));
    assert!(http(port, &format!("GET /r/{ROOM}?role=host HTTP/1.1\r\nHost: x\r\n\r\n")).await.starts_with("HTTP/1.1 426"));

    // Guest before the room exists: 4004 → NoSuchRoom on first connect.
    let l = link(port);
    assert_eq!(Guest::connect(l.clone(), "teleflock").await.unwrap_err(), GuestError::NoSuchRoom);

    let key = RoomKey::new(&l.key);
    let (seen_tx, mut seen) = tokio::sync::mpsc::unbounded_channel();
    let host = fake_host(port, key.clone(), seen_tx.clone()).await;

    // Duplicate host → 4009.
    let (mut dup, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/r/{ROOM}?role=host")).await.unwrap();
    match dup.next().await {
        Some(Ok(Message::Close(Some(f)))) => assert_eq!(u16::from(f.code), 4009),
        other => panic!("expected 4009, got {other:?}"),
    }

    let (guest, mut events) = Guest::connect(l.clone(), "teleflock").await.unwrap();
    assert!(guest.is_live() && !guest.read_only());
    let GuestEvent::Snapshot(snap) = next(&mut events).await else { panic!() };
    assert!(!snap.resync);
    assert_eq!(snap.entries.len(), 1);
    assert_eq!(snap.welcome.header.id, "sess-1");
    // Host saw peer-joined then a hello with the relay-rewritten peer id and our write token.
    let (_, joined) = seen.recv().await.unwrap();
    assert_eq!(joined, json!({"t":"peer-joined","peer":1}));
    let (peer, hello) = seen.recv().await.unwrap();
    assert_eq!(peer, 1);
    assert_eq!(hello["proto"], 3);
    assert_eq!(hello["name"], "teleflock");
    assert_eq!(hello["writeToken"], l.write_token_b64().unwrap());

    guest.prompt("hi".into(), vec![]).unwrap();
    let GuestEvent::Frame(HostFrame::Event { event }) = next(&mut events).await else { panic!() };
    assert_eq!(event["type"], "agent_start");
    let (_, prompt) = seen.recv().await.unwrap();
    assert_eq!(prompt, serde_json::to_value(GuestFrame::Prompt { text: "hi".into(), images: vec![] }).unwrap());

    let chunk = guest.fetch_transcript("Main", 0).await.unwrap();
    assert_eq!(chunk.new_size, 18);
    let stats = relay.stats();
    assert_eq!((stats.rooms, stats.guests), (1, 1));
    assert!(stats.frames_h2g >= 4 && stats.frames_g2h >= 3);

    // Host drops → room-closed + 4001 → guest reconnects; host returns on the same room → resync.
    host.abort();
    let _ = host.await;
    match next(&mut events).await {
        GuestEvent::Reconnecting { code, attempt, .. } => assert_eq!((code, attempt), (4001, 1)),
        other => panic!("{other:?}"),
    }
    assert!(!guest.is_live());
    assert_eq!(guest.prompt("x".into(), vec![]).unwrap_err(), GuestError::NotConnected);
    let _host2 = fake_host(port, key.clone(), seen_tx.clone()).await;
    loop {
        match next(&mut events).await {
            GuestEvent::Snapshot(s) => {
                assert!(s.resync);
                break;
            }
            GuestEvent::Reconnecting { code, .. } => assert!(code == 4004 || code == 1006, "{code}"),
            other => panic!("{other:?}"),
        }
    }
    assert!(guest.is_live());

    // Explicit resync on the open socket.
    guest.resync().unwrap();
    let GuestEvent::Snapshot(s) = next(&mut events).await else { panic!() };
    assert!(s.resync);

    guest.close();
    loop {
        if let GuestEvent::Ended(r) = next(&mut events).await {
            assert_eq!(r, EndReason::Closed);
            break;
        }
    }
    relay.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn view_link_is_read_only() {
    let relay = Relay::start(RelayConfig::new(0)).await.unwrap();
    let port = relay.port();
    let l = link(port);
    let (seen_tx, _seen) = tokio::sync::mpsc::unbounded_channel();
    let _host = fake_host(port, RoomKey::new(&l.key), seen_tx).await;
    let (g, _ev) = Guest::connect(l.view_only(), "viewer").await.unwrap();
    assert!(g.read_only());
    assert_eq!(g.prompt("x".into(), vec![]).unwrap_err(), GuestError::ReadOnly);
    assert_eq!(g.abort().unwrap_err(), GuestError::ReadOnly);
    // Fetching transcripts is allowed on view links.
    assert_eq!(g.fetch_transcript("Main", 0).await.unwrap().new_size, 18);
    relay.shutdown().await;
}
