//! Sessions end to end inside hostd, on the two paths that serve them: the bridge's data plane
//! (a scripted extension, [`crate::bridge::fake`], replaying recorded runs) and omp's collab room
//! (a scripted omp collab host on hostd's own relay, published in a registry dir of the test's
//! own). Covers where controls go, a resync in the middle of a turn, a session switch, and the
//! bridge-lost → collab fallback → bridge-back sequence on a paused clock.

use std::path::{Path, PathBuf};

use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tf_collab::{CollabLink, HostFrame, RoomKey};
use tf_proto::model::Answer;
use tf_proto::session::{ToolStatus, TranscriptItem};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::*;
use crate::bridge::fake::{self as fake_bridge, FakeExt};
use crate::feed::fixture::{self, GrowingFile};

fn caps() -> Value {
    json!({ "live": 1, "dialogs": true, "subagentCtl": true, "prompt": true })
}

/// Polls `cond` every 5 ms of tokio time, for at most 10 s of it.
async fn until(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !cond() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

fn link_of(s: &OmpSession) -> (LinkState, Option<LinkReason>, Option<LinkVia>) {
    let l = s.link_status();
    (l.state, l.reason, l.via)
}

fn rows(s: &OmpSession) -> Vec<TranscriptItem> {
    s.lock().replica.snapshot(usize::MAX).items
}

// ───────────────────────────── scripted omp collab host ─────────────────────────────

/// A full (control) link to `room` on the relay at `port`, and the URL omp's registry hands out
/// for it.
fn room_link(port: u16, room: &str) -> (CollabLink, String) {
    use base64::Engine as _;
    let mut secret: Vec<u8> = (0..32u8).map(|i| i.wrapping_mul(7).wrapping_add(3)).collect();
    secret.extend_from_slice(&[5; 16]);
    let secret = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&secret);
    let url = format!("http://127.0.0.1:{port}/#ws://127.0.0.1:{port}/r/{room}.{secret}");
    (CollabLink::parse(&url).unwrap(), url)
}

/// What the omp collab host saw.
#[derive(Debug, Clone, PartialEq)]
enum HostSaw {
    Joined(u32),
    Left(u32),
    /// A guest frame, from peer `.0`.
    Frame(u32, Value),
}

/// A scripted omp collab host in a room on hostd's relay: a welcome and a one-entry snapshot
/// per guest hello, the transcript of any agent on `fetch-transcript`; the rest is reported.
struct FakeRoom {
    saw: mpsc::UnboundedReceiver<HostSaw>,
    /// Everything reported so far (what [`FakeRoom::take`] drained).
    log: Vec<HostSaw>,
}

impl FakeRoom {
    async fn open(link: &CollabLink, session_id: &str) -> FakeRoom {
        let (ws, _) = tokio_tungstenite::connect_async(format!("{}?role=host", link.ws_url)).await.unwrap();
        // The relay registers the room just after the upgrade: wait for it (a guest racing the
        // registration gets 4004).
        rooms_registered(loopback_port(&link.ws_url).unwrap()).await;
        let key = RoomKey::new(&link.key);
        let (tx, saw) = mpsc::unbounded_channel();
        let sid = session_id.to_owned();
        tokio::spawn(async move {
            let (mut out, mut inbox) = ws.split();
            while let Some(Ok(msg)) = inbox.next().await {
                let data = match msg {
                    Message::Binary(b) => b,
                    Message::Text(t) => {
                        let v: Value = serde_json::from_str(&t).unwrap();
                        let peer = v["peer"].as_u64().unwrap_or_default() as u32;
                        let _ = tx.send(match v["t"].as_str() {
                            Some("peer-joined") => HostSaw::Joined(peer),
                            Some("peer-left") => HostSaw::Left(peer),
                            _ => continue,
                        });
                        continue;
                    }
                    Message::Close(_) => break,
                    _ => continue,
                };
                let Ok((peer, plain)) = key.open(&data) else { continue };
                let frame: Value = serde_json::from_slice(&plain).unwrap();
                let seal = |v: Value| Message::binary(key.seal(peer, &serde_json::to_vec(&v).unwrap()));
                match frame["t"].as_str() {
                    Some("hello") => {
                        let welcome = json!({ "t": "welcome", "proto": tf_collab::COLLAB_PROTO,
                            "header": { "type": "session", "version": 3, "id": sid, "timestamp": "2026-10-28T10:00:00.000Z", "cwd": "/w" },
                            "state": { "isStreaming": false, "queuedMessageCount": 0, "cwd": "/w", "participants": [] },
                            "agents": [{ "id": "Main", "displayName": "main", "kind": "main", "status": "running" }], "entryCount": 1 });
                        let chunk = json!({ "t": "snapshot-chunk", "final": true, "entries": [room_entry()] });
                        if out.send(seal(welcome)).await.is_err() || out.send(seal(chunk)).await.is_err() {
                            break;
                        }
                    }
                    Some("fetch-transcript") => {
                        let text = if frame["fromByte"] == 0 { format!("{}\n", room_entry()) } else { String::new() };
                        let size = frame["fromByte"].as_u64().unwrap_or_default().max(text.len() as u64);
                        let reply = json!({ "t": "transcript", "reqId": frame["reqId"], "text": text, "newSize": size });
                        if out.send(seal(reply)).await.is_err() {
                            break;
                        }
                    }
                    _ => {}
                }
                let _ = tx.send(HostSaw::Frame(peer, frame));
            }
        });
        FakeRoom { saw, log: Vec::new() }
    }

    /// Drains what the host saw since the last call into [`FakeRoom::log`], returning it.
    fn take(&mut self) -> Vec<HostSaw> {
        let mut new = Vec::new();
        while let Ok(s) = self.saw.try_recv() {
            new.push(s);
        }
        self.log.extend(new.iter().cloned());
        new
    }

    /// The next guest frame of type `t` (skipping joins, leaves and other frames).
    async fn next_frame(&mut self, t: &str) -> Value {
        loop {
            let s = tokio::time::timeout(Duration::from_secs(10), self.saw.recv()).await.expect("the room saw nothing").unwrap();
            self.log.push(s.clone());
            if let HostSaw::Frame(_, f) = s
                && f["t"] == t
            {
                return f;
            }
        }
    }

    fn joins(&mut self) -> usize {
        self.take();
        self.log.iter().filter(|s| matches!(s, HostSaw::Joined(_))).count()
    }

    fn leaves(&mut self) -> usize {
        self.take();
        self.log.iter().filter(|s| matches!(s, HostSaw::Left(_))).count()
    }
}

/// The one entry the room's snapshot carries.
fn room_entry() -> Value {
    json!({ "type": "message", "id": "r1", "parentId": null, "timestamp": "2026-10-28T10:00:01.000Z",
            "message": { "role": "user", "content": "shown through the room", "timestamp": 1_793_000_001_000_u64 } })
}

/// Waits until the relay on `port` has a room (`/healthz`).
async fn rooms_registered(port: u16) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(b"GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n").await.unwrap();
        let mut answer = String::new();
        s.read_to_string(&mut answer).await.unwrap();
        let body: Value = answer.split("\r\n\r\n").nth(1).and_then(|b| serde_json::from_str(b).ok()).unwrap_or_default();
        if body["rooms"].as_u64().is_some_and(|n| n >= 1) {
            return;
        }
        assert!(Instant::now() < deadline, "the relay never registered the room: {answer}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

// ───────────────────────────── omp's collab registry ─────────────────────────────

/// Publishes a collab host in `dir` the way omp does (`<instance>.json` + its socket), answering
/// `snapshot` and `link`; returns the ops it was asked, in order.
fn publish_room(dir: &Path, instance: &str, pid: u32, session_id: &str, url: String) -> Arc<Mutex<Vec<String>>> {
    let sock = dir.join(format!("{instance}.sock"));
    let listener = tokio::net::UnixListener::bind(&sock).unwrap();
    let meta = json!({ "version": 1, "instanceId": instance, "pid": pid, "endpoint": sock, "createdAt": 1, "token": "tok" });
    std::fs::write(dir.join(format!("{instance}.json")), meta.to_string()).unwrap();
    let snapshot = json!({ "instanceId": instance, "generation": 1, "pid": pid, "sessionId": session_id,
                           "relayConnected": true, "access": "control" });
    let ops = Arc::new(Mutex::new(Vec::new()));
    let seen = ops.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let (rd, mut wr) = stream.into_split();
            let mut line = String::new();
            if BufReader::new(rd).read_line(&mut line).await.is_err() {
                continue;
            }
            let req: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(req["token"], "tok");
            let op = req["op"].as_str().unwrap_or_default().to_owned();
            let reply = match op.as_str() {
                "snapshot" => json!({ "ok": true, "v": 1, "snapshot": snapshot }),
                "link" => json!({ "ok": true, "v": 1, "url": url }),
                _ => json!({ "ok": false, "v": 1, "error": "unknown_op" }),
            };
            seen.lock().unwrap().push(op);
            let _ = wr.write_all(format!("{reply}\n").as_bytes()).await;
        }
    });
    ops
}

fn count(ops: &Mutex<Vec<String>>, op: &str) -> usize {
    ops.lock().unwrap().iter().filter(|o| *o == op).count()
}

// ───────────────────────────── hostd's omp data plane ─────────────────────────────

/// An [`OmpHandle`] on a relay port of its own, polling a registry dir of its own, with a
/// bridge socket the scripted extension connects to.
struct Lab {
    omp: OmpHandle,
    bridge: BridgeHandle,
    port: u16,
    cancel: CancellationToken,
    dir: tempfile::TempDir,
}

impl Lab {
    async fn start() -> Lab {
        let dir = tempfile::tempdir().unwrap();
        let registry_dir = dir.path().join("collab-hosts");
        std::fs::create_dir_all(&registry_dir).unwrap();
        let (bridge, _) = fake_bridge::handle();
        let persist = Persist::load(dir.path().join("state.json"));
        for _ in 0..20 {
            let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
            let cancel = CancellationToken::new();
            let registry = Registry::with_dir(registry_dir.clone()).omp_bin("/nonexistent/omp");
            let omp = OmpHandle::start_with(port, persist.clone(), cancel.clone(), bridge.clone(), registry).await;
            if omp.relay_listening() {
                return Lab { omp, bridge, port, cancel, dir };
            }
            cancel.cancel();
            omp.shutdown().await;
        }
        panic!("no free relay port");
    }

    fn registry_dir(&self) -> PathBuf {
        self.dir.path().join("collab-hosts")
    }

    fn session(&self, id: &str) -> Option<Arc<OmpSession>> {
        self.omp.session(id)
    }

    async fn stop(self) {
        self.cancel.cancel();
        self.omp.shutdown().await;
    }
}

/// The scripted extension says hello for `session_id` (its file at `file`) and serves the
/// driver's `liveSubscribe` with a resync of what `file` holds (idle, the main agent only).
async fn bridge_serves(lab: &Lab, session_id: &str, file: &Path, seq: u64) -> FakeExt {
    let mut ext = FakeExt::connect(&lab.bridge).await;
    let hello = json!({ "t": "hello", "v": 2, "reason": "connect", "pid": std::process::id(), "sessionId": session_id,
        "sessionFile": file, "cwd": "/w", "ompVersion": "18.13.2", "bridgeVersion": "2.0.0", "tui": true, "caps": caps() });
    let last = std::fs::read_to_string(file).unwrap().lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter_map(|v| v["id"].as_str().map(str::to_owned)).last();
    let resync = json!({ "t": "resync", "seq": seq, "sessionId": session_id, "sessionFile": file, "leafId": last, "lastEntryId": last,
        "live": { "streaming": false, "frames": [
            { "t": "state", "state": { "isStreaming": false, "queuedMessageCount": 0, "cwd": "/w", "participants": [] } },
            { "t": "agents", "agents": [{ "id": "Main", "displayName": "main", "kind": "main", "status": "running" }] } ] } });
    hello_then_subscribe(&mut ext, hello, resync).await;
    ext
}

/// Says `hello` and answers the driver's `liveSubscribe` with `resync`, written before the
/// `res` as the extension does. The request can overtake the hello's `welcome`: hostd's driver
/// starts on the hello, on another thread than the one answering it.
async fn hello_then_subscribe(ext: &mut FakeExt, hello: Value, resync: Value) {
    ext.send(hello).await;
    let mut req = None;
    loop {
        let line = ext.recv().await;
        match line["t"].as_str() {
            Some("welcome") => break,
            Some("req") => req = Some(line),
            _ => {}
        }
    }
    let req = match req {
        Some(req) => req,
        None => ext.recv_req().await,
    };
    assert_eq!(req["op"], "liveSubscribe");
    ext.send(resync).await;
    ext.ok(&req, json!({})).await;
}

/// A session file with a title slot, a header and one user message.
fn session_file(dir: &Path, session_id: &str, text: &str) -> PathBuf {
    let path = dir.join(format!("2026-10-28T10-00-00-000Z_{session_id}.jsonl"));
    let lines = [
        json!({ "type": "title", "v": 1, "title": "", "pad": "  " }),
        json!({ "type": "session", "version": 3, "id": session_id, "timestamp": "2026-10-28T10:00:00.000Z", "cwd": "/w" }),
        json!({ "type": "message", "id": "e1", "parentId": null, "timestamp": "2026-10-28T10:00:02.000Z",
                "message": { "role": "user", "content": text, "timestamp": 1_793_000_002_000_u64 } }),
    ];
    std::fs::write(&path, lines.iter().map(|l| format!("{l}\n")).collect::<String>()).unwrap();
    path
}

fn client(id: &str) -> ClientHandle {
    let info = tf_proto::host::ClientInfo { app: "teleflock-desktop".into(), version: "0.6.0".into(), platform: "linux".into(), device: id.into(), features: None };
    ClientHandle::new(id.into(), info)
}

/// Kinds of the session events queued for `c` since the last call.
fn sent_kinds(c: &ClientHandle) -> Vec<String> {
    let mut lines = Vec::new();
    c.take_batch(&mut lines);
    lines.iter().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter_map(|v| v["ev"]["k"].as_str().map(str::to_owned)).collect()
}

fn statuses(s: &OmpSession) -> Vec<ToolStatus> {
    rows(s)
        .into_iter()
        .filter_map(|i| match i {
            TranscriptItem::Tool(t) => Some(t.status),
            _ => None,
        })
        .collect()
}

/// Runs `call` while the scripted extension answers its one request with `result`.
async fn via_bridge<T: Send + 'static>(
    ext: &mut FakeExt,
    result: Value,
    call: impl Future<Output = Result<T, ApiError>> + Send + 'static,
) -> (Value, Result<T, ApiError>) {
    let call = tokio::spawn(call);
    let req = ext.recv_req().await;
    ext.ok(&req, result).await;
    (req, call.await.unwrap())
}

// ───────────────────────────── tests ─────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn controls_take_the_path_that_serves_the_session() {
    let relay = Relay::start(RelayConfig::new(0)).await.unwrap();
    let (link, _) = room_link(relay.port(), "TfRoutingTestRoom00001");
    let mut room = FakeRoom::open(&link, "s1").await;
    let (guest, _events) = Guest::connect(link.clone(), GUEST_NAME).await.unwrap();
    let (bridge, _) = fake_bridge::handle();
    let mut ext = FakeExt::connect(&bridge).await;
    let pid = std::process::id();
    ext.hello_caps(pid, "s1", "2.0.0", Some(caps())).await;
    let dir = tempfile::tempdir().unwrap();
    let main = session_file(dir.path(), "s1", "hi");
    let subagents = crate::artifacts::artifacts_dir(&main);
    std::fs::create_dir_all(&subagents).unwrap();
    let reply = json!({ "type": "message", "id": "x1", "parentId": null, "timestamp": "2026-10-28T10:00:03.000Z",
        "message": { "role": "assistant", "content": [{ "type": "text", "text": "from the file" }], "timestamp": 1_793_000_003_000_u64 } });
    std::fs::write(subagents.join("Sub.jsonl"), format!("{reply}\n")).unwrap();
    let s = Arc::new(OmpSession::new("s1", pid, &Persist::load(dir.path().join("state.json")), bridge.clone()));
    // A pending dialog (either path delivers one the same way).
    let ask = json!({ "t": "ui-request", "request": { "kind": "select", "title": "Pick a color", "options": ["Red", "Blue"], "reqId": 7 } });
    s.lock().replica.apply(&GuestEvent::Frame(HostFrame::from_value(ask)), now_ms());
    let blue = Answer { choices: vec!["Blue".into()], text: None, cancel: false, chat: false };

    // Nothing serves it: every control fails, retryably, with the link's own reason.
    let why = "TeleFlock's bridge in omp disconnected; waiting for it to reconnect";
    s.lock().set_link(LinkStatus::connecting(LinkReason::BridgeLost, Some(LinkVia::Bridge), why));
    for err in [
        s.prompt("x", vec![], Delivery::Auto).await.unwrap_err(),
        s.abort().await.unwrap_err(),
        s.answer("7", &blue).await.unwrap_err(),
        s.agent_cmd(AgentCmdKind::Kill, "Sub", None).await.unwrap_err(),
        s.transcript("Sub").await.unwrap_err(),
    ] {
        assert_eq!((err.code.as_str(), err.message.as_str(), err.retryable), ("not_connected", why, true));
    }

    // A collab guest serves it: everything goes to omp's room.
    {
        let mut st = s.lock();
        let room_id = link.room_id.clone();
        st.transport = Transport::Collab(CollabRoom { guest: guest.clone(), instance_id: "i1".into(), generation: 1, room_id, token: next_token() });
        st.set_link(LinkStatus::live(LinkVia::Collab));
    }
    assert!(!s.follow_up_prompts(), "a collab guest cannot queue follow-ups");
    s.prompt("through the room", vec![], Delivery::Auto).await.unwrap();
    assert_eq!(room.next_frame("prompt").await["text"], "through the room");
    s.abort().await.unwrap();
    room.next_frame("abort").await;
    s.answer("7", &blue).await.unwrap();
    let r = room.next_frame("ui-response").await;
    assert_eq!((&r["reqId"], &r["value"]), (&json!(7), &json!("Blue")));
    s.agent_cmd(AgentCmdKind::Kill, "Sub", None).await.unwrap();
    let c = room.next_frame("agent-cmd").await;
    assert_eq!((&c["cmd"], &c["agentId"]), (&json!("kill"), &json!("Sub")));
    let page = s.transcript("Sub").await.unwrap();
    assert_eq!(room.next_frame("fetch-transcript").await["agentId"], "Sub");
    assert!(page.items.iter().any(|i| matches!(i, TranscriptItem::User(u) if u.text == "shown through the room")), "{page:?}");
    assert!(tokio::time::timeout(Duration::from_millis(200), ext.recv_req()).await.is_err(), "the bridge got a control");
    room.take();

    // The bridge's data plane serves it: everything goes to the extension, transcripts come
    // from the files next to the session file.
    let token = next_token();
    {
        let mut st = s.lock();
        st.transport = Transport::Bridge { token, caps: serde_json::from_value(caps()).unwrap() };
        st.set_link(LinkStatus::live(LinkVia::Bridge));
        st.session_file = Some(main.clone());
    }
    assert!(s.follow_up_prompts());
    let (req, r) = via_bridge(&mut ext, json!({ "queued": true }), {
        let s = s.clone();
        async move { s.prompt("look", vec![ImageContent::new("aGk=", "image/png")], Delivery::FollowUp).await }
    })
    .await;
    r.unwrap();
    assert_eq!(req["op"], "prompt");
    assert_eq!(req["params"], json!({ "text": "look", "images": [{ "type": "image", "data": "aGk=", "mimeType": "image/png" }], "delivery": "followUp" }));
    let (req, r) = via_bridge(&mut ext, json!({}), {
        let s = s.clone();
        async move { s.abort().await }
    })
    .await;
    r.unwrap();
    assert_eq!(req["op"], "abort");
    let (req, r) = via_bridge(&mut ext, json!({}), {
        let (s, blue) = (s.clone(), blue.clone());
        async move { s.answer("7", &blue).await }
    })
    .await;
    r.unwrap();
    assert_eq!((&req["op"], &req["params"]), (&json!("uiResponse"), &json!({ "reqId": 7, "value": "Blue" })));
    let (req, r) = via_bridge(&mut ext, json!({}), {
        let s = s.clone();
        async move { s.agent_cmd(AgentCmdKind::Chat, "Sub", Some("go on".into())).await }
    })
    .await;
    r.unwrap();
    assert_eq!((&req["op"], &req["params"]), (&json!("agentCmd"), &json!({ "cmd": "chat", "agentId": "Sub", "text": "go on" })));
    let page = s.transcript("Sub").await.unwrap();
    assert!(page.items.iter().any(|i| matches!(i, TranscriptItem::Assistant(a) if a.text == "from the file")), "{page:?}");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!room.take().iter().any(|x| matches!(x, HostSaw::Frame(..))), "the room got a control: {:?}", room.log);

    // A bridge whose data plane lacks a control says so instead of guessing.
    s.lock().transport = Transport::Bridge { token, caps: BridgeCaps { live: 1, ..BridgeCaps::default() } };
    assert!(!s.follow_up_prompts());
    assert_eq!(s.prompt("x", vec![], Delivery::Auto).await.unwrap_err().code, "unsupported");
    assert_eq!(s.answer("7", &blue).await.unwrap_err().code, "unsupported");
    assert_eq!(s.agent_cmd(AgentCmdKind::Chat, "Sub", Some("x".into())).await.unwrap_err().code, "unsupported");
    let (req, r) = via_bridge(&mut ext, json!({}), {
        let s = s.clone();
        async move { s.abort().await }
    })
    .await;
    r.unwrap();
    assert_eq!(req["op"], "abort", "aborting is a control-plane op every bridge has");
    guest.close();
    relay.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_resync_mid_turn_and_a_session_switch_through_the_driver() {
    // The recorded run of `fixture::FEED_2` replayed by the scripted extension, with omp's
    // session file growing as it did.
    let lab = Lab::start().await;
    let lines = fixture::lines(fixture::FEED_2);
    let hellos: Vec<&Value> = lines.iter().filter(|l| l["t"] == "hello").collect();
    let resyncs: Vec<&Value> = lines.iter().filter(|l| l["t"] == "resync").collect();
    let (first_id, switched_id) = (hellos[0]["sessionId"].as_str().unwrap(), hellos[1]["sessionId"].as_str().unwrap());
    let dir = tempfile::tempdir().unwrap();
    let mut file = GrowingFile::new(dir.path().join("first.jsonl"), fixture::SESSION_2);
    let mut switched_file = GrowingFile::new(dir.path().join("switched.jsonl"), fixture::SWITCHED_2);
    let here = |v: &Value, path: &Path| {
        let mut v = v.clone();
        v["sessionFile"] = json!(path);
        if v["t"] == "hello" {
            v["pid"] = json!(std::process::id());
        }
        v
    };

    let mut ext = FakeExt::connect(&lab.bridge).await;
    hello_then_subscribe(&mut ext, here(hellos[0], file.path()), here(resyncs[0], file.path())).await;
    until("the bridge serves the session", || lab.session(first_id).is_some_and(|s| link_of(&s) == (LinkState::Live, None, Some(LinkVia::Bridge)))).await;
    let first = lab.session(first_id).unwrap();
    let app = client("app");
    first.subscribe(&app, "agent-1", 100, None);

    // The turn streams; omp persists each message once it ended.
    let overflow = resyncs[1];
    for l in lines.iter().filter(|l| l["t"] == "live") {
        assert!(l["seq"].as_u64() < overflow["seq"].as_u64());
        ext.send(l.clone()).await;
        if let Some(message) = fixture::ended_message(&l["f"]) {
            file.message_ended(message);
        }
    }
    until("the second bash call runs", || statuses(&first) == [ToolStatus::Ok, ToolStatus::Running]).await;
    assert!(first.is_streaming());

    // hostd fell behind: the extension dropped the queued frames for one resync, taken after
    // the turn ended; omp wrote the rest of the file meanwhile.
    file.through(overflow["lastEntryId"].as_str().unwrap());
    ext.send(here(overflow, file.path())).await;
    until("the resync settles the turn", || !first.is_streaming() && statuses(&first) == [ToolStatus::Ok; 3]).await;
    let ids: Vec<String> = rows(&first).iter().map(|i| i.id().to_owned()).collect();
    assert_eq!(ids.iter().collect::<std::collections::HashSet<_>>().len(), ids.len(), "a row twice: {ids:?}");
    let last = rows(&first).into_iter().rev().find_map(|i| match i {
        TranscriptItem::Assistant(a) => Some(a.text),
        _ => None,
    });
    assert_eq!(last.as_deref(), Some("done"));
    assert_eq!(link_of(&first), (LinkState::Live, None, Some(LinkVia::Bridge)));
    assert!(!sent_kinds(&app).contains(&"ended".to_string()));

    // `/new` in omp: the switch hello ends the first session, the new one is subscribed.
    switched_file.through(resyncs[2]["lastEntryId"].as_str().unwrap());
    hello_then_subscribe(&mut ext, here(hellos[1], switched_file.path()), here(resyncs[2], switched_file.path())).await;
    until("the new session is served", || lab.session(switched_id).is_some_and(|s| link_of(&s) == (LinkState::Live, None, Some(LinkVia::Bridge)))).await;
    let mut kinds = Vec::new();
    until("the first session ends and its subscribers are told", || {
        kinds.extend(sent_kinds(&app));
        first.is_closed() && lab.session(first_id).is_none() && kinds.iter().any(|k| k == "ended")
    })
    .await;
    let switched = lab.session(switched_id).unwrap();
    assert_eq!(switched.lock().replica.header().map(|h| h.id.clone()).as_deref(), Some(switched_id));

    // Through the driver too, an entry omp wrote right before a turn starts shows before it.
    let seq = resyncs[2]["seq"].as_u64().unwrap();
    switched_file.append(&json!({ "type": "model_change", "id": "aa11bb22", "parentId": resyncs[2]["lastEntryId"],
        "timestamp": "2026-10-28T16:46:00.000Z", "model": "openai-codex/gpt-6-sol" }));
    ext.send(json!({ "t": "live", "seq": seq + 1, "f": { "t": "event", "event": { "type": "agent_start" } } })).await;
    ext.send(json!({ "t": "live", "seq": seq + 2, "f": { "t": "event", "event": { "type": "message_start",
        "message": { "role": "user", "content": [{ "type": "text", "text": "hi" }], "timestamp": 1_793_205_960_000_u64 } } } }))
        .await;
    until("the prompt shows", || rows(&switched).iter().any(|i| matches!(i, TranscriptItem::User(_)))).await;
    let order: Vec<String> = rows(&switched).iter().map(|i| i.id().to_owned()).collect();
    let (mode, user) = (order.iter().position(|id| id == "maa11bb22"), order.iter().position(|id| id.starts_with('u')));
    assert!(mode.is_some() && mode < user, "{order:?}");
    lab.stop().await;
}

/// A bridge-served session, its room published too (omp started with TeleFlock's overlay).
async fn served_with_a_room(lab: &Lab, room: &str) -> (FakeRoom, Arc<Mutex<Vec<String>>>, PathBuf, FakeExt, Arc<OmpSession>) {
    let (link, url) = room_link(lab.port, room);
    let fake_room = FakeRoom::open(&link, "s1").await;
    let ops = publish_room(&lab.registry_dir(), "i1", std::process::id(), "s1", url);
    let file = session_file(lab.dir.path(), "s1", "kept while the bridge is away");
    let ext = bridge_serves(lab, "s1", &file, 1).await;
    until("the bridge serves the session", || lab.session("s1").is_some_and(|s| link_of(&s) == (LinkState::Live, None, Some(LinkVia::Bridge)))).await;
    let s = lab.session("s1").unwrap();
    // Polls list the room, and leave it alone.
    for polls in 1..=2 {
        lab.omp.repoll();
        until("a registry poll", || count(&ops, "snapshot") >= polls).await;
    }
    (fake_room, ops, file, ext, s)
}

/// Lets a registry poll run at the current (paused) time.
async fn poll_now(lab: &Lab, ops: &Mutex<Vec<String>>) {
    let polls = count(ops, "snapshot");
    lab.omp.repoll();
    until("a registry poll", || count(ops, "snapshot") > polls).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
}

#[tokio::test] // current-thread: its clock can be paused
async fn a_lost_bridge_hands_its_session_to_the_room_after_ten_seconds_and_takes_it_back() {
    let lab = Lab::start().await;
    let (mut room, ops, file, ext, s) = served_with_a_room(&lab, "TfFallbackTestRoom0001").await;
    let app = client("app");
    s.subscribe(&app, "agent-1", 100, None);
    assert_eq!((count(&ops, "link"), room.joins()), (0, 0), "a room of a bridge-served session is never joined");

    // The bridge goes away: the replica and its subscribers stay, waiting for it.
    let before = rows(&s);
    drop(ext);
    let waiting = (LinkState::Connecting, Some(LinkReason::BridgeLost), Some(LinkVia::Bridge));
    until("the bridge is lost", || link_of(&s) == waiting).await;
    assert!(s.link_status().error.unwrap().contains("waiting for it to reconnect"));
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(9)).await;
    poll_now(&lab, &ops).await;
    assert_eq!((count(&ops, "link"), room.joins()), (0, 0), "joined before the bridge had 10 s to come back");
    assert_eq!(link_of(&s), waiting);
    assert_eq!(rows(&s), before);

    // Ten seconds without it: the published room takes over the same session.
    tokio::time::advance(Duration::from_secs(2)).await;
    tokio::time::resume();
    lab.omp.repoll();
    until("the room serves the session", || link_of(&s) == (LinkState::Live, Some(LinkReason::FallbackCollab), Some(LinkVia::Collab))).await;
    assert!(Arc::ptr_eq(&s, &lab.session("s1").unwrap()), "the same session (replica, subscribers) goes on");
    assert_eq!(room.joins(), 1);
    assert!(rows(&s).iter().any(|i| matches!(i, TranscriptItem::User(u) if u.text == "shown through the room")));

    // The bridge comes back: it takes the session back and the guest leaves the room.
    let _ext = bridge_serves(&lab, "s1", &file, 1).await;
    until("the bridge serves it again", || link_of(&s) == (LinkState::Live, None, Some(LinkVia::Bridge))).await;
    until("the guest leaves the room", || room.leaves() == 1).await;
    assert!(rows(&s).iter().any(|i| matches!(i, TranscriptItem::User(u) if u.text == "kept while the bridge is away")));
    let links = count(&ops, "link");
    poll_now(&lab, &ops).await;
    assert_eq!((count(&ops, "link"), room.joins()), (links, 1), "the room is not joined again");
    assert!(Arc::ptr_eq(&s, &lab.session("s1").unwrap()));
    assert!(!sent_kinds(&app).contains(&"ended".to_string()), "subscribers stayed through both hand-overs");
    lab.stop().await;
}

#[tokio::test] // current-thread: its clock can be paused
async fn a_bridge_back_within_ten_seconds_keeps_its_room_unjoined() {
    let lab = Lab::start().await;
    let (mut room, ops, file, ext, s) = served_with_a_room(&lab, "TfReturnTestRoom000001").await;
    drop(ext);
    until("the bridge is lost", || link_of(&s).1 == Some(LinkReason::BridgeLost)).await;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(6)).await;
    tokio::time::resume();
    // An extension reload, or tf-hostd restarting: the bridge is back after 6 s.
    let _ext = bridge_serves(&lab, "s1", &file, 2).await;
    until("the bridge serves it again", || link_of(&s) == (LinkState::Live, None, Some(LinkVia::Bridge))).await;
    assert!(Arc::ptr_eq(&s, &lab.session("s1").unwrap()));
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(30)).await;
    poll_now(&lab, &ops).await;
    tokio::time::resume();
    assert_eq!((count(&ops, "link"), room.joins()), (0, 0));
    lab.stop().await;
}
