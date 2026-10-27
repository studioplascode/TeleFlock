//! Relay + guest against a scripted fake omp host (wire-level: envelopes, routing, close codes,
//! resync after host reconnect). Runs offline.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tf_collab::frame::GuestFrame;
use tf_collab::relay::CLOSE_RESET;
use tf_collab::{CollabLink, EndReason, Guest, GuestError, GuestEvent, HostFrame, JoinTimeouts, Relay, RelayConfig, RoomKey};
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
    fake_host_with(port, key, seen, Arc::new(AtomicBool::new(true))).await
}

/// [`fake_host`] that ignores `hello` while `answer` is false (a host that keeps the room open
/// but stopped answering joins), and reports the relay's close code as `(0, {"close": code})`.
async fn fake_host_with(
    port: u16,
    key: RoomKey,
    seen: tokio::sync::mpsc::UnboundedSender<(u32, Value)>,
    answer: Arc<AtomicBool>,
) -> tokio::task::JoinHandle<()> {
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/r/{ROOM}?role=host")).await.unwrap();
    // The relay registers the room just after the upgrade; a guest racing it gets 4004 on a busy
    // machine. `/healthz` counts rooms, so wait for this one before handing the host over.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !http(port, "GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n").await.contains(r#""rooms":1"#) {
        assert!(tokio::time::Instant::now() < deadline, "the relay never registered the room");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::spawn(async move {
        let (mut tx, mut rx) = ws.split();
        while let Some(Ok(msg)) = rx.next().await {
            let data = match msg {
                Message::Binary(b) => b,
                Message::Text(t) => {
                    let _ = seen.send((0, serde_json::from_str(&t).unwrap()));
                    continue;
                }
                Message::Close(f) => {
                    let _ = seen.send((0, json!({"close": f.map(|f| u16::from(f.code))})));
                    break;
                }
                _ => continue,
            };
            // Like omp: undecryptable guest frames are dropped silently.
            let Ok((peer, plain)) = key.open(&data) else { continue };
            let frame: Value = serde_json::from_slice(&plain).unwrap();
            let _ = seen.send((peer, frame.clone()));
            let send = |target: u32, v: Value| Message::binary(key.seal(target, &serde_json::to_vec(&v).unwrap()));
            match frame["t"].as_str().unwrap() {
                "hello" if answer.load(Ordering::SeqCst) => {
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

/// The field failure behind hostd's room reset: the host keeps its room open on the relay but
/// never answers a join. Every join times out; resetting the room (the host reconnects to the
/// same room id) lets the next one through.
#[tokio::test(flavor = "multi_thread")]
async fn stuck_room_times_out_until_reset() {
    let relay = Relay::start(RelayConfig::new(0)).await.unwrap();
    let port = relay.port();
    let l = link(port);
    let key = RoomKey::new(&l.key);
    let short = JoinTimeouts { welcome: Duration::from_millis(300), snapshot_progress: Duration::from_millis(300) };
    assert!(!relay.reset_room(ROOM), "no such room yet");

    let (seen_tx, mut seen) = tokio::sync::mpsc::unbounded_channel();
    let answer = Arc::new(AtomicBool::new(false));
    let stuck = fake_host_with(port, key.clone(), seen_tx.clone(), answer.clone()).await;
    for _ in 0..2 {
        assert_eq!(Guest::connect_with(l.clone(), "teleflock", short).await.unwrap_err(), GuestError::Timeout("welcome"));
    }

    // The relay closes the host with 1012; like omp, it comes back on the same room id.
    assert!(relay.reset_room(ROOM));
    let close = loop {
        let (_, v) = tokio::time::timeout(Duration::from_secs(5), seen.recv()).await.unwrap().unwrap();
        if let Some(code) = v.get("close") {
            break code.as_u64();
        }
    };
    assert_eq!(close, Some(u64::from(CLOSE_RESET)));
    let _ = stuck.await;
    let _host = fake_host(port, key, seen_tx).await;
    let (guest, mut events) = Guest::connect_with(l, "teleflock", short).await.unwrap();
    assert!(guest.is_live());
    assert!(matches!(next(&mut events).await, GuestEvent::Snapshot(_)));
    relay.shutdown().await;
}

/// After the join, a host that stops answering a resync makes the guest reconnect and say the
/// welcome timed out (hostd counts those to reset the room); the guest keeps retrying.
#[tokio::test(flavor = "multi_thread")]
async fn resync_timeout_reconnects_and_reports_it() {
    let relay = Relay::start(RelayConfig::new(0)).await.unwrap();
    let port = relay.port();
    let l = link(port);
    let (seen_tx, _seen) = tokio::sync::mpsc::unbounded_channel();
    let answer = Arc::new(AtomicBool::new(true));
    let _host = fake_host_with(port, RoomKey::new(&l.key), seen_tx, answer.clone()).await;
    let short = JoinTimeouts { welcome: Duration::from_millis(300), snapshot_progress: Duration::from_millis(300) };
    let (guest, mut events) = Guest::connect_with(l, "teleflock", short).await.unwrap();
    assert!(matches!(next(&mut events).await, GuestEvent::Snapshot(_)));

    answer.store(false, Ordering::SeqCst);
    guest.resync().unwrap();
    match next(&mut events).await {
        GuestEvent::Reconnecting { code, timed_out, attempt, .. } => assert_eq!((code, timed_out, attempt), (1006, true, 1)),
        other => panic!("{other:?}"),
    }
    // Answering again: a resync during the backoff retries at once and the guest is live again.
    answer.store(true, Ordering::SeqCst);
    guest.resync().unwrap();
    loop {
        match next(&mut events).await {
            GuestEvent::Snapshot(s) => {
                assert!(s.resync);
                break;
            }
            GuestEvent::Reconnecting { .. } => {}
            other => panic!("{other:?}"),
        }
    }
    assert!(guest.is_live());
    relay.shutdown().await;
}
