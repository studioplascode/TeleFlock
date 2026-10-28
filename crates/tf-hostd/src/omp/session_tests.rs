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
    let resync = idle_resync(session_id, file, seq, last_entry(file).as_deref(), &[]);
    hello_then_subscribe(&mut ext, hello(session_id, file), resync).await;
    ext
}

/// A data-plane bridge's hello for `session_id`, its file at `file`, in this process.
fn hello(session_id: &str, file: &Path) -> Value {
    json!({ "t": "hello", "v": 2, "reason": "connect", "pid": std::process::id(), "sessionId": session_id,
        "sessionFile": file, "cwd": "/w", "ompVersion": "18.13.2", "bridgeVersion": "2.0.0", "tui": true, "caps": caps() })
}

/// An idle resync (the main agent only) naming `file`, `last` as its `lastEntryId`, with
/// `entries` inlined (as an extension does while it takes the session as never written).
fn idle_resync(session_id: &str, file: &Path, seq: u64, last: Option<&str>, entries: &[Value]) -> Value {
    let mut frames: Vec<Value> = entries.iter().map(|entry| json!({ "t": "entry", "entry": entry })).collect();
    frames.push(json!({ "t": "state", "state": { "isStreaming": false, "queuedMessageCount": 0, "cwd": "/w", "participants": [] } }));
    frames.push(json!({ "t": "agents", "agents": [{ "id": "Main", "displayName": "main", "kind": "main", "status": "running" }] }));
    json!({ "t": "resync", "seq": seq, "sessionId": session_id, "sessionFile": file, "leafId": last, "lastEntryId": last,
        "live": { "streaming": false, "frames": frames } })
}

/// The id of the last entry in session file `file`.
fn last_entry(file: &Path) -> Option<String> {
    let text = std::fs::read_to_string(file).unwrap();
    text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter_map(|v| v["id"].as_str().map(str::to_owned)).last()
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

// ───────────────────────────── restarts of the bridge feed ─────────────────────────────

/// What the scripted extension of [`serve_feed`] answers a `liveSubscribe` with; the test can
/// change it while the extension runs ([`FeedExt::script`]).
#[derive(Clone, Default)]
struct FeedScript {
    /// The session file the resync names.
    file: PathBuf,
    /// Its `lastEntryId` (`None`: `null`).
    last: Option<String>,
    /// Entries the resync inlines (an extension that takes the session as never written).
    entries: Vec<Value>,
    /// A live frame omp produced while the request was on its way: written ahead of every resync
    /// but the first, numbered like any other frame.
    stale: Option<Value>,
}

/// The scripted extension of [`serve_feed`].
struct FeedExt {
    script: Arc<Mutex<FeedScript>>,
    /// When each `liveSubscribe` arrived (tokio's clock).
    subscribes: Arc<Mutex<Vec<Instant>>>,
    /// Told of each `liveSubscribe`.
    subscribed: Arc<tokio::sync::Notify>,
    frames: mpsc::UnboundedSender<Value>,
}

/// This many subscriptions while a test waits are a feed starting over in a loop. Such a loop
/// never lets the runtime idle, so a paused clock never moves: the waits below give up on it
/// instead of hanging.
const STORM: usize = 50;

impl FeedExt {
    fn subscribes(&self) -> Vec<Instant> {
        self.subscribes.lock().unwrap().clone()
    }

    /// Writes `frame` as the next `live` frame.
    fn live(&self, frame: Value) {
        self.frames.send(frame).unwrap();
    }

    fn script(&self, change: impl FnOnce(&mut FeedScript)) {
        change(&mut self.script.lock().unwrap());
    }

    /// [`until`], failing on a feed that keeps starting over.
    async fn until(&self, what: &str, mut cond: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        let storm = self.subscribes().len() + STORM;
        while !cond() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            assert!(self.subscribes().len() < storm, "the feed keeps starting over while waiting for {what}");
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(5)) => {}
                _ = self.subscribed.notified() => {}
            }
        }
    }

    /// Lets `time` pass (tokio's clock), or less once the feed has started over [`STORM`] times.
    async fn wait(&self, time: Duration) {
        let storm = self.subscribes().len() + STORM;
        let storming = async {
            while self.subscribes().len() < storm {
                self.subscribed.notified().await;
            }
        };
        tokio::select! {
            _ = tokio::time::sleep(time) => {}
            _ = storming => {}
        }
    }
}

/// A scripted extension serving `session_id` from a task of its own, numbering and ordering its
/// frames as the real one does: one `seq` per connection, every `liveSubscribe` answered with an
/// idle resync ([`FeedScript`]) written before its `res`, any other request with `{}`.
async fn serve_feed(lab: &Lab, session_id: &str, script: FeedScript) -> FeedExt {
    let FakeExt { mut lines, mut w } = FakeExt::connect(&lab.bridge).await;
    w.write_all(format!("{}\n", hello(session_id, &script.file)).as_bytes()).await.unwrap();
    let script = Arc::new(Mutex::new(script));
    let subscribes = Arc::new(Mutex::new(Vec::new()));
    let subscribed = Arc::new(tokio::sync::Notify::new());
    let (frames, mut queued) = mpsc::unbounded_channel::<Value>();
    let (current, seen, told, sid) = (script.clone(), subscribes.clone(), subscribed.clone(), session_id.to_owned());
    tokio::spawn(async move {
        let mut seq = 0u64;
        loop {
            let mut out = Vec::new();
            tokio::select! {
                line = lines.next_line() => {
                    let Ok(Some(line)) = line else { return };
                    let req: Value = serde_json::from_str(&line).unwrap();
                    if req["t"] != "req" {
                        continue;
                    }
                    if req["op"] == "liveSubscribe" {
                        let n = {
                            let mut seen = seen.lock().unwrap();
                            seen.push(Instant::now());
                            seen.len()
                        };
                        told.notify_one();
                        let script = current.lock().unwrap().clone();
                        if let Some(frame) = script.stale.filter(|_| n > 1) {
                            seq += 1;
                            out.push(json!({ "t": "live", "seq": seq, "f": frame }));
                        }
                        seq += 1;
                        out.push(idle_resync(&sid, &script.file, seq, script.last.as_deref(), &script.entries));
                    }
                    out.push(json!({ "t": "res", "id": req["id"], "ok": true, "result": {} }));
                }
                Some(frame) = queued.recv() => {
                    seq += 1;
                    out.push(json!({ "t": "live", "seq": seq, "f": frame }));
                }
            }
            let text: String = out.iter().map(|v| format!("{v}\n")).collect();
            if w.write_all(text.as_bytes()).await.is_err() {
                return;
            }
        }
    });
    FeedExt { script, subscribes, subscribed, frames }
}

fn has_user_row(s: &OmpSession, text: &str) -> bool {
    rows(s).iter().any(|i| matches!(i, TranscriptItem::User(u) if u.text == text))
}

/// A session file entry: a user message.
fn user_entry(id: &str, text: &str) -> Value {
    json!({ "type": "message", "id": id, "parentId": null, "timestamp": "2026-10-28T10:00:03.000Z",
            "message": { "role": "user", "content": text, "timestamp": 1_793_000_003_000_u64 } })
}

const LIVE: (LinkState, Option<LinkReason>, Option<LinkVia>) = (LinkState::Live, None, Some(LinkVia::Bridge));

#[tokio::test] // current-thread: its clock can be paused
async fn frames_written_before_a_new_resync_do_not_start_the_feed_over_again() {
    // omp rewrote the session file mid-turn (a temp file renamed over it): hostd's tail finds
    // another file and subscribes again. omp goes on streaming, so frames the extension wrote
    // before it took the new `liveSubscribe` reach the new subscription ahead of its resync. They
    // belong to the old one: applied, the first would read the old tail (rewritten again) and the
    // next look like a gap, each starting over (one more resync built by omp, one more full read
    // of the file) for as long as omp streams.
    let lab = Lab::start().await;
    let file = session_file(lab.dir.path(), "s1", "first");
    let stale = json!({ "t": "event", "event": { "type": "message_start",
        "message": { "role": "user", "content": [{ "type": "text", "text": "stale" }], "timestamp": 1_793_000_009_000_u64 } } });
    let ext = serve_feed(&lab, "s1", FeedScript { file: file.clone(), last: Some("e1".into()), stale: Some(stale), ..FeedScript::default() }).await;
    until("the bridge serves the session", || lab.session("s1").is_some_and(|s| link_of(&s) == LIVE)).await;
    let s = lab.session("s1").unwrap();
    ext.live(json!({ "t": "event", "event": { "type": "agent_start" } }));
    until("the turn runs", || s.is_streaming()).await;

    tokio::time::pause();
    let mut entry = user_entry("e2", "rewritten");
    entry["parentId"] = json!("e1");
    let tmp = lab.dir.path().join("rewrite.tmp");
    std::fs::write(&tmp, format!("{}{entry}\n", std::fs::read_to_string(&file).unwrap())).unwrap();
    ext.script(|script| script.last = Some("e2".into()));
    std::fs::rename(&tmp, &file).unwrap();
    ext.until("the rewritten file is read", || has_user_row(&s, "rewritten")).await;
    ext.wait(Duration::from_secs(30)).await;
    assert_eq!(ext.subscribes().len(), 2, "the feed started over more than once");
    assert!(!has_user_row(&s, "stale"));
    assert!(!s.is_streaming(), "the resync says omp is idle");
    assert_eq!(link_of(&s), LIVE);
    tokio::time::resume();
    lab.stop().await;
}

#[tokio::test] // current-thread: its clock can be paused
async fn a_session_file_hostd_cannot_read_is_tried_again_with_growing_pauses() {
    // Every resync names a file hostd cannot read (here a directory). Each subscription makes omp
    // build a resync and hostd try the file: they come with growing pauses instead of in a loop,
    // the link says why the session does not load, and Retry (`agent.connect`) ends a pause.
    let lab = Lab::start().await;
    let path = lab.dir.path().join("2026-10-28T10-00-00-000Z_s1.jsonl");
    std::fs::create_dir(&path).unwrap();
    let ext = serve_feed(&lab, "s1", FeedScript { file: path.clone(), last: Some("e1".into()), ..FeedScript::default() }).await;
    tokio::time::pause();
    ext.wait(Duration::from_secs(20)).await;
    let times = ext.subscribes();
    // At once, then 0.25, 0.5, 1, 2, 4, 8 s after the one before: 8 by 15.75 s.
    assert!((5..=9).contains(&times.len()), "{} subscriptions within 20 s", times.len());
    let gaps: Vec<Duration> = times.windows(2).map(|w| w[1] - w[0]).collect();
    for (i, gap) in gaps.iter().enumerate().skip(1) {
        assert!(*gap >= crate::feed::RESTART_PAUSE * 2u32.pow(i as u32 - 1), "pause {i}: {gaps:?}");
    }
    let s = lab.session("s1").unwrap();
    let link = s.link_status();
    assert_eq!((link.state, link.reason), (LinkState::Connecting, Some(LinkReason::Syncing)));
    assert!(link.error.as_deref().is_some_and(|e| e.contains("cannot read the session file")), "{link:?}");

    // The file is readable now: Retry does not wait out the pause (the next subscription would
    // come 11.75 s from now).
    std::fs::remove_dir(&path).unwrap();
    session_file(lab.dir.path(), "s1", "readable");
    let asked = Instant::now();
    lab.omp.retry_now("s1").await;
    ext.until("the session loads", || link_of(&s) == LIVE).await;
    assert!(asked.elapsed() < Duration::from_secs(5), "loaded {:?} after the retry", asked.elapsed());
    assert!(has_user_row(&s, "readable"));
    tokio::time::resume();
    lab.stop().await;
}

/// A FIFO standing in for a session file: a reader opening it waits until [`Fifo::release`].
/// Released on drop too, so a failing test leaves no blocking-pool thread behind.
struct Fifo(PathBuf);

impl Fifo {
    fn make(path: PathBuf) -> Fifo {
        use std::os::unix::ffi::OsStrExt as _;
        let c = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        // SAFETY: `c` is a NUL-terminated path that outlives the call.
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0, "mkfifo {}", path.display());
        Fifo(path)
    }

    /// Opens the write end and closes it, so a reader that has the FIFO open reads to its end
    /// (nothing). `false` while no reader has it open.
    fn release(&self) -> bool {
        use std::os::unix::fs::OpenOptionsExt as _;
        std::fs::OpenOptions::new().write(true).custom_flags(libc::O_NONBLOCK).open(&self.0).is_ok()
    }
}

impl Drop for Fifo {
    fn drop(&mut self) {
        self.release();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_retry_asked_for_while_the_session_loads_does_not_start_it_over_once_live() {
    // The session view offers Retry after 20 s of "Loading the session…": while hostd reads a large
    // session file. That retry must not start the feed over once the read went live (one more
    // resync built by omp, one more read of the whole file, a reset for every client).
    let lab = Lab::start().await;
    // hostd's read of the session file waits until the test lets it end (empty: the resync
    // inlines the session's entry).
    let fifo = Fifo::make(lab.dir.path().join("2026-10-28T10-00-00-000Z_s1.jsonl"));
    let script = FeedScript { file: fifo.0.clone(), entries: vec![user_entry("e1", "loaded")], ..FeedScript::default() };
    let ext = serve_feed(&lab, "s1", script).await;
    until("hostd reads the session file", || lab.session("s1").is_some_and(|s| s.lock().notes_loaded)).await;
    let s = lab.session("s1").unwrap();
    assert_eq!(link_of(&s), (LinkState::Connecting, Some(LinkReason::Syncing), Some(LinkVia::Bridge)));
    lab.omp.retry_now("s1").await;
    until("the read ends", || fifo.release()).await;
    until("the session is live", || link_of(&s) == LIVE).await;
    assert!(has_user_row(&s, "loaded"));
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(ext.subscribes().len(), 1, "the retry started the feed over after it went live");
    assert_eq!(link_of(&s), LIVE);
    lab.stop().await;
}

#[tokio::test]
async fn a_session_held_for_long_holds_up_no_other_user_of_the_sessions_map() {
    // A resync rebuilding a large session's replica holds the session's lock for seconds. The
    // registry poll reading what feeds each session waits for it, but not with the sessions map
    // locked: a bridge's hello (a writer) and every op and board reading the map (which std's
    // `RwLock` queues behind a waiting writer) go on meanwhile.
    let dir = tempfile::tempdir().unwrap();
    let persist = Persist::load(dir.path().join("state.json"));
    let (bridge, _) = fake_bridge::handle();
    let session = |id: &str| Arc::new(OmpSession::new(id, 1, &persist, bridge.clone()));
    let (slow, newcomer) = (session("slow"), session("newcomer"));
    let map = Arc::new(RwLock::new(HashMap::from([("slow".to_owned(), slow.clone()), ("other".to_owned(), session("other"))])));
    let resync = slow.lock();
    let poll = {
        let map = map.clone();
        std::thread::spawn(move || session_feeds(&map))
    };
    // The poll waits for the slow session by now.
    std::thread::sleep(Duration::from_millis(100));
    let (done, went_on) = std::sync::mpsc::channel();
    let writer = {
        let (map, done) = (map.clone(), done.clone());
        std::thread::spawn(move || {
            map.write().unwrap().insert("newcomer".to_owned(), newcomer);
            let _ = done.send("a hello");
        })
    };
    std::thread::sleep(Duration::from_millis(20));
    let reader = {
        let map = map.clone();
        std::thread::spawn(move || {
            let other = map.read().unwrap().get("other").cloned();
            let _ = done.send(if other.is_some() { "an op" } else { "an op without its session" });
        })
    };
    let mut seen: Vec<&str> = (0..2).map(|_| went_on.recv_timeout(Duration::from_secs(2)).expect("held up by the slow session")).collect();
    seen.sort_unstable();
    assert_eq!(seen, ["a hello", "an op"]);
    drop(resync);
    let (joined, held) = poll.join().unwrap();
    writer.join().unwrap();
    reader.join().unwrap();
    assert!(joined.is_empty());
    assert!(held.contains("slow") && held.contains("other"), "{held:?}");
}

#[tokio::test] // current-thread: its clock can be paused
async fn a_moved_session_file_is_waited_for_and_the_session_kept_meanwhile() {
    // omp's `/move` renames the session file, moves the artifacts, and only then points the
    // session at the new path. hostd's tail finds the file gone and subscribes again; resyncs taken
    // meanwhile still name the old path, with its last entry, or (from an extension that took the
    // session as never written) with its entries inlined. Neither replaces the session: hostd
    // subscribes again, with pauses, until a resync names the file where it is.
    let lab = Lab::start().await;
    let file = session_file(lab.dir.path(), "s1", "kept");
    let ext = serve_feed(&lab, "s1", FeedScript { file: file.clone(), last: Some("e1".into()), ..FeedScript::default() }).await;
    until("the bridge serves the session", || lab.session("s1").is_some_and(|s| link_of(&s) == LIVE)).await;
    let s = lab.session("s1").unwrap();

    tokio::time::pause();
    let moved = lab.dir.path().join("moved").join(file.file_name().unwrap());
    std::fs::create_dir(moved.parent().unwrap()).unwrap();
    std::fs::rename(&file, &moved).unwrap();
    ext.until("hostd subscribes again", || ext.subscribes().len() >= 3).await;
    ext.script(|script| {
        script.last = None;
        script.entries = vec![user_entry("x1", "inlined")];
    });
    ext.until("…and again", || ext.subscribes().len() >= 5).await;
    assert_eq!(link_of(&s), LIVE, "the session goes on as it was");
    assert!(has_user_row(&s, "kept") && !has_user_row(&s, "inlined"));
    assert_eq!(s.lock().session_file.as_deref(), Some(file.as_path()));

    // omp points the session at the new path.
    ext.script(|script| {
        script.file = moved.clone();
        script.last = Some("e1".into());
        script.entries.clear();
    });
    ext.until("the moved file serves the session", || s.lock().session_file.as_deref() == Some(moved.as_path())).await;
    assert!(has_user_row(&s, "kept"));
    let subscribed = ext.subscribes().len();
    ext.wait(Duration::from_secs(30)).await;
    assert_eq!(ext.subscribes().len(), subscribed, "the feed settled on the moved file");
    tokio::time::resume();
    lab.stop().await;
}

#[tokio::test] // current-thread: its clock can be paused
async fn a_lost_bridge_without_a_room_reads_the_same_on_every_poll() {
    // The boards show for how long through `linkSince`: a counter in the words would send every
    // client a board patch per registry poll, for up to 10 minutes.
    let lab = Lab::start().await;
    let file = session_file(lab.dir.path(), "s1", "hi");
    let ext = bridge_serves(&lab, "s1", &file, 1).await;
    until("the bridge serves the session", || lab.session("s1").is_some_and(|s| link_of(&s) == LIVE)).await;
    let s = lab.session("s1").unwrap();
    drop(ext);
    until("the bridge is lost", || link_of(&s).1 == Some(LinkReason::BridgeLost)).await;
    tokio::time::pause();
    tokio::time::sleep(BRIDGE_RETURN + Duration::from_secs(2)).await;
    let link = s.link_status();
    assert!(link.error.as_deref().is_some_and(|e| e.contains("no collab room to fall back to")), "{link:?}");
    let mut updates = lab.omp.subscribe();
    tokio::time::sleep(Duration::from_secs(30)).await;
    assert_eq!(s.link_status(), link);
    let mut patches = 0;
    while let Ok(update) = updates.try_recv() {
        patches += usize::from(matches!(update, OmpUpdate::Changed { session_id } if session_id == "s1"));
    }
    assert_eq!(patches, 0, "the boards were told the session changed while nothing did");
    tokio::time::resume();
    lab.stop().await;
}
