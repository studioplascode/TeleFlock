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
use tf_proto::session::{AskStep, ToolStatus, TranscriptItem};
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
        FakeRoom::open_with(link, session_id, vec![room_entry()], Vec::new()).await
    }

    /// A room whose join snapshot carries `entries`, followed by the frames `then`.
    async fn open_with(link: &CollabLink, session_id: &str, entries: Vec<Value>, then: Vec<Value>) -> FakeRoom {
        FakeRoom::open_answering(link, session_id, entries, then, usize::MAX).await
    }

    /// A room serving omp's session file `file` as omp does: its entries in the join snapshot, its
    /// bytes on `fetch-transcript`.
    async fn open_serving(link: &CollabLink, session_id: &str, file: &Path) -> FakeRoom {
        FakeRoom::open_scripted(link, session_id, file_entries(file), Vec::new(), usize::MAX, Some(file.to_path_buf())).await
    }

    /// [`FakeRoom::open_with`] answering only the first `hellos` hellos: then it goes silent (it
    /// still reports what it gets).
    async fn open_answering(link: &CollabLink, session_id: &str, entries: Vec<Value>, then: Vec<Value>, hellos: usize) -> FakeRoom {
        FakeRoom::open_scripted(link, session_id, entries, then, hellos, None).await
    }

    async fn open_scripted(link: &CollabLink, session_id: &str, entries: Vec<Value>, then: Vec<Value>, hellos: usize, transcript: Option<PathBuf>) -> FakeRoom {
        let (ws, _) = tokio_tungstenite::connect_async(format!("{}?role=host", link.ws_url)).await.unwrap();
        // The relay registers the room just after the upgrade: wait for it (a guest racing the
        // registration gets 4004).
        rooms_registered(loopback_port(&link.ws_url).unwrap()).await;
        let key = RoomKey::new(&link.key);
        let (tx, saw) = mpsc::unbounded_channel();
        let sid = session_id.to_owned();
        tokio::spawn(async move {
            let mut hellos = hellos;
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
                    Some("hello") if hellos > 0 => {
                        hellos -= 1;
                        let welcome = json!({ "t": "welcome", "proto": tf_collab::COLLAB_PROTO,
                            "header": { "type": "session", "version": 3, "id": sid, "timestamp": "2026-10-28T10:00:00.000Z", "cwd": "/w" },
                            "state": { "isStreaming": false, "queuedMessageCount": 0, "cwd": "/w", "participants": [] },
                            "agents": [{ "id": "Main", "displayName": "main", "kind": "main", "status": "running" }], "entryCount": entries.len() });
                        let chunk = json!({ "t": "snapshot-chunk", "final": true, "entries": entries });
                        if out.send(seal(welcome)).await.is_err() || out.send(seal(chunk)).await.is_err() {
                            break;
                        }
                        for f in &then {
                            if out.send(seal(f.clone())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Some("fetch-transcript") => {
                        let from = frame["fromByte"].as_u64().unwrap_or_default();
                        let text = match &transcript {
                            // The complete lines from `from` on, as omp's host reads its file.
                            Some(file) => {
                                let bytes = std::fs::read(file).unwrap();
                                let rest = &bytes[(from as usize).min(bytes.len())..];
                                let end = rest.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
                                String::from_utf8_lossy(&rest[..end]).into_owned()
                            }
                            None if from == 0 => format!("{}\n", room_entry()),
                            None => String::new(),
                        };
                        let size = if transcript.is_some() { from + text.len() as u64 } else { from.max(text.len() as u64) };
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
    text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter_map(|v| v["id"].as_str().map(str::to_owned)).next_back()
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
    let blue = Answer { choices: vec!["Blue".into()], text: None, cancel: false, chat: false, back: false };

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
async fn a_bridge_that_stops_answering_leaves_its_room_unjoined_and_the_file_serves_its_session() {
    // A session with a bridge never falls back to its collab room: a join makes omp serialize the
    // whole session, and an omp that leaves its bridge unanswered is busy already. While the bridge
    // does not answer, then is closed and stays away, omp's session file serves the session; the
    // bridge coming back takes it over. Before, ten seconds without the bridge handed the session to
    // the room, and a feed that did not start left the copy where it was.
    let lab = Lab::start().await;
    let (mut room, ops, file, mut ext, s) = served_with_a_room(&lab, "TfStarvedTestRoom00001").await;
    let app = client("app");
    s.subscribe(&app, "agent-1", 100, None);
    let user_at = |id: &str, ms: u64, text: &str| {
        json!({ "type": "message", "id": id, "parentId": null, "timestamp": "2026-10-28T10:00:03.000Z",
                "message": { "role": "user", "content": text, "timestamp": ms } })
    };
    // The feed starts over (a settle ask here) and the bridge answers nothing from now on.
    s.lock().settle.ask = Some("starts over".into());
    s.feed_kick.notify_one();
    assert_eq!(ext.recv_req().await["op"], "liveSubscribe");
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(11)).await;
    tokio::time::resume();
    // Its subscription timed out: the file serves the session.
    until("the file serves the session", || s.lock().bridge_lost.is_some() && link_of(&s).0 == LinkState::Connecting).await;
    append_entries(&file, &[user_at("e2", 1_793_000_004_000, "written while the bridge starved")]);
    until("rows come from the file", || has_user_row(&s, "written while the bridge starved")).await;
    // The next one too: hostd closes the connection, and the bridge stays away for a while.
    tokio::time::pause();
    let closed = async { while let Ok(Some(_)) = ext.lines.next_line().await {} };
    tokio::time::timeout(Duration::from_secs(60), closed).await.expect("the starved bridge's connection is closed");
    until("the bridge is lost", || link_of(&s).1 == Some(LinkReason::BridgeLost)).await;
    tokio::time::advance(BRIDGE_RETURN + Duration::from_secs(5)).await;
    poll_now(&lab, &ops).await;
    tokio::time::resume();
    append_entries(&file, &[user_at("e3", 1_793_000_005_000, "written while the bridge was away")]);
    until("rows still come from the file", || has_user_row(&s, "written while the bridge was away")).await;
    poll_now(&lab, &ops).await;
    assert_eq!((count(&ops, "link"), room.joins()), (0, 0), "the room of an omp with a bridge was joined");

    // The bridge is back: it takes the same session over, its rows unchanged.
    let followed = row_ids(&s);
    let _ext = bridge_serves(&lab, "s1", &file, 1).await;
    until("the bridge serves it again", || link_of(&s) == LIVE).await;
    assert!(Arc::ptr_eq(&s, &lab.session("s1").unwrap()), "the same session went on");
    assert_eq!(row_ids(&s), followed, "no row lost or doubled");
    assert!(has_user_row(&s, "kept while the bridge is away") && has_user_row(&s, "written while the bridge starved"));
    assert_eq!((count(&ops, "link"), room.joins()), (0, 0));
    assert!(!sent_kinds(&app).contains(&"ended".to_string()), "subscribers stayed through it all");
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
    assert!(link.error.as_deref().is_some_and(|e| e.contains("from its file until it reconnects")), "{link:?}");
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

#[tokio::test(flavor = "multi_thread")]
async fn a_turn_omp_ended_without_the_feed_saying_so_is_reloaded() {
    // The live feed lost the end of a turn (frames tf-hostd could not read: bridge 2.0.0 wrote
    // omp's half surrogate pairs as escapes serde_json refuses). omp's control state says idle,
    // the replica still runs a `wait`. The stall watchdog subscribes again, and the resync settles
    // the session. Before, the transcript stayed on the running `wait` for good.
    let lab = Lab::start().await;
    let dir = tempfile::tempdir().unwrap();
    let file = session_file(dir.path(), "s1", "hi");
    let mut ext = bridge_serves(&lab, "s1", &file, 1).await;
    until("the bridge serves the session", || lab.session("s1").is_some_and(|s| link_of(&s) == (LinkState::Live, None, Some(LinkVia::Bridge)))).await;
    let s = lab.session("s1").unwrap();
    ext.send(json!({ "t": "live", "seq": 2, "f": { "t": "event", "event": { "type": "agent_start" } } })).await;
    ext.send(json!({ "t": "live", "seq": 3, "f": { "t": "event", "event":
        { "type": "tool_execution_start", "toolCallId": "w1", "toolName": "wait", "args": {} } } }))
    .await;
    until("the wait runs", || s.is_streaming() && statuses(&s) == [ToolStatus::Running]).await;
    // omp's turn ended; the live frames saying so never arrived. Its control state says idle.
    ext.state_titled("s1", "t").await;
    let req = ext.recv_req().await;
    assert_eq!(req["op"], "liveSubscribe", "the watchdog subscribes again");
    ext.send(idle_resync("s1", &file, 4, last_entry(&file).as_deref(), &[])).await;
    ext.ok(&req, json!({})).await;
    until("the resync settles the turn", || !s.is_streaming() && !statuses(&s).contains(&ToolStatus::Running)).await;
    assert_eq!(link_of(&s), (LinkState::Live, None, Some(LinkVia::Bridge)));
    lab.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_steer_omp_takes_before_the_prompt_answers_is_not_left_queued() {
    // omp can take a steer at once (it cuts a running tool batch short), so the steer's row can
    // reach hostd ahead of the prompt's answer. Listed only after that answer, the steer stayed
    // in `meta.queue` until omp went idle: a chip of a delivered message nothing could pull back.
    let lab = Lab::start().await;
    let dir = tempfile::tempdir().unwrap();
    let file = session_file(dir.path(), "s1", "hi");
    let mut ext = bridge_serves(&lab, "s1", &file, 1).await;
    until("the bridge serves the session", || lab.session("s1").is_some_and(|s| link_of(&s) == LIVE)).await;
    let s = lab.session("s1").unwrap();
    ext.send(json!({ "t": "live", "seq": 2, "f": { "t": "event", "event": { "type": "agent_start" } } })).await;
    until("the turn runs", || s.is_streaming()).await;
    let queued = |s: &OmpSession| s.lock().replica.meta().queue.steering.clone();
    let call = tokio::spawn({
        let s = s.clone();
        async move { s.prompt_queued("land it now", vec![], Delivery::Auto).await }
    });
    let req = ext.recv_req().await;
    assert_eq!(req["op"], "prompt");
    assert_eq!(queued(&s), ["land it now"], "listed before it goes out");
    let row = json!({ "role": "user", "content": [{ "type": "text", "text": "land it now" }], "steering": true, "timestamp": crate::util::now_ms() });
    ext.send(json!({ "t": "live", "seq": 3, "f": { "t": "event", "event": { "type": "message_start", "message": row } } })).await;
    ext.send(json!({ "t": "live", "seq": 4, "f": { "t": "event", "event": { "type": "message_end", "message": row } } })).await;
    until("the steer's row lands", || rows(&s).iter().any(|i| matches!(i, TranscriptItem::User(u) if u.text == "land it now"))).await;
    ext.ok(&req, json!({ "queued": true })).await;
    call.await.unwrap().unwrap();
    assert!(queued(&s).is_empty(), "the delivered steer is still queued: {:?}", queued(&s));

    // A send that fails is unlisted again.
    let call = tokio::spawn({
        let s = s.clone();
        async move { s.prompt_queued("never sent", vec![], Delivery::Auto).await }
    });
    let req = ext.recv_req().await;
    assert_eq!(queued(&s), ["never sent"]);
    ext.send(json!({ "t": "res", "id": req["id"], "ok": false, "error": { "code": "omp_error", "message": "boom" } })).await;
    assert!(call.await.unwrap().is_err());
    assert!(queued(&s).is_empty(), "{:?}", queued(&s));
    lab.stop().await;
}

// ───────────────────────────── an ask's explanation and Back ─────────────────────────────

const EXPLANATION: &str = "**SQLite** keeps it in one file; Postgres needs a server.\n\nBoth work with Drizzle.";

/// A turn that asks two questions: the prompt, then one assistant message with the explanation
/// and the ask call (thinking first, which never counts).
fn ask_turn() -> Vec<Value> {
    let questions = json!([
        { "id": "store", "question": "Which store?", "options": [{ "label": "SQLite" }, { "label": "Postgres" }] },
        { "id": "orm", "question": "Which ORM?", "options": [{ "label": "none" }, { "label": "Drizzle" }] },
    ]);
    vec![
        json!({ "type": "message", "id": "u1", "parentId": null, "timestamp": "2026-10-28T10:00:01.000Z",
            "message": { "role": "user", "content": "pick a store", "timestamp": 1_793_000_001_000_u64 } }),
        json!({ "type": "message", "id": "m1", "parentId": "u1", "timestamp": "2026-10-28T10:00:02.000Z",
            "message": { "role": "assistant", "stopReason": "toolUse", "timestamp": 1_793_000_002_000_u64, "content": [
                { "type": "thinking", "thinking": "which store fits" },
                { "type": "text", "text": EXPLANATION },
                { "type": "toolCall", "id": "call_ask1", "name": "ask", "arguments": { "questions": questions } },
            ] } }),
    ]
}

fn select(req_id: u64, title: &str, options: [&str; 2], nav: Option<Value>) -> Value {
    let mut request = json!({ "kind": "select", "title": title, "options": [options[0], options[1], "Other (type your own)", "Chat about this"],
        "initialIndex": 0, "selectionMarker": "radio", "markableCount": 2, "reqId": req_id });
    if let Some(nav) = nav {
        request["nav"] = nav;
    }
    json!({ "t": "ui-request", "request": request })
}

fn back() -> Answer {
    Answer { choices: vec![], text: None, cancel: false, chat: false, back: true }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_asks_explanation_and_back_through_the_bridge() {
    let lab = Lab::start().await;
    let dir = tempfile::tempdir().unwrap();
    let file = session_file(dir.path(), "s1", "pick a store");
    let mut ext = bridge_serves(&lab, "s1", &file, 1).await;
    until("the bridge serves the session", || lab.session("s1").is_some_and(|s| link_of(&s) == (LinkState::Live, None, Some(LinkVia::Bridge)))).await;
    let s = lab.session("s1").unwrap();
    ext.send(json!({ "t": "live", "seq": 2, "f": { "t": "event", "event": { "type": "message_end", "message": ask_turn()[1]["message"] } } })).await;
    // The bridge's ask flow on its second question, which was answered "Drizzle" before (Back).
    let nav = json!({ "index": 1, "total": 2, "back": "\u{0}back", "answer": { "choices": ["Drizzle"] } });
    ext.send(json!({ "t": "live", "seq": 3, "f": select(9, "Which ORM?", ["none", "Drizzle"], Some(nav)) })).await;
    until("the ask", || s.ui().is_some()).await;
    let ui = s.ui().unwrap();
    assert_eq!(ui.call_id.as_deref(), Some("call_ask1"));
    assert_eq!(ui.context.as_deref(), Some(EXPLANATION));
    assert_eq!(ui.step, Some(AskStep { index: 1, total: 2, can_back: true, choices: vec!["Drizzle".into()], text: None }));
    let needs = s.lock().replica.needs().unwrap();
    assert_eq!((needs.context.as_deref(), needs.step.as_ref()), (Some(EXPLANATION), ui.step.as_ref()), "the board has them too");

    // Back is answered with the bridge's own value.
    let (req, r) = via_bridge(&mut ext, json!({}), {
        let s = s.clone();
        async move { s.answer("9", &back()).await }
    })
    .await;
    r.unwrap();
    assert_eq!((&req["op"], &req["params"]), (&json!("uiResponse"), &json!({ "reqId": 9, "value": "\u{0}back" })));
    lab.stop().await;
}

#[tokio::test] // current-thread: its clock can be paused
async fn an_asks_explanation_through_omps_room_without_back() {
    // omp's own collab mirroring: the join snapshot carries the turn, the dialog follows it, with
    // no nav (omp's guests cannot go back).
    let lab = Lab::start().await;
    let (link, url) = room_link(lab.port, "TfAskContextRoom000001");
    let mut room = FakeRoom::open_with(&link, "s1", ask_turn(), vec![select(3, "Which store?", ["SQLite", "Postgres"], None)]).await;
    let ops = publish_room(&lab.registry_dir(), "i1", std::process::id(), "s1", url);
    poll_now(&lab, &ops).await;
    // No bridge says hello for the process: the room is joined after the grace.
    tokio::time::pause();
    tokio::time::advance(JOIN_GRACE + Duration::from_secs(1)).await;
    tokio::time::resume();
    lab.omp.repoll();
    until("the room serves the ask", || lab.session("s1").is_some_and(|s| link_of(&s).2 == Some(LinkVia::Collab) && s.ui().is_some())).await;
    let s = lab.session("s1").unwrap();
    let ui = s.ui().unwrap();
    assert_eq!(ui.context.as_deref(), Some(EXPLANATION));
    assert_eq!(s.lock().replica.needs().unwrap().context.as_deref(), Some(EXPLANATION));
    assert_eq!(ui.step, None);
    assert_eq!(s.answer("3", &back()).await.unwrap_err().code, "invalid_params");
    s.answer("3", &Answer { choices: vec!["Postgres".into()], back: false, ..back() }).await.unwrap();
    let r = room.next_frame("ui-response").await;
    assert_eq!((&r["reqId"], &r["value"]), (&json!(3), &json!("Postgres")));
    lab.stop().await;
}

// ───────────────────────────── the settle watchdog ─────────────────────────────

/// The turn of the reported freeze, as omp writes it to its session file once it ran on: the
/// first message (a redacted thought, two `grep` calls), their results, the final answer.
fn grep_turn() -> Vec<Value> {
    let call = |id: &str, pattern: &str| json!({ "type": "toolCall", "id": id, "name": "grep", "arguments": { "pattern": pattern } });
    let result = |id: &str, call: &str| json!({ "type": "message", "id": id, "parentId": "m1", "timestamp": "2026-10-28T10:00:04.000Z",
        "message": { "role": "toolResult", "toolCallId": call, "toolName": "grep", "content": [{ "type": "text", "text": "3 matches" }],
                     "isError": false, "timestamp": 1_793_000_004_000_u64 } });
    vec![
        json!({ "type": "message", "id": "m1", "parentId": "e1", "timestamp": "2026-10-28T10:00:03.000Z",
            "message": { "role": "assistant", "stopReason": "toolUse", "timestamp": 1_793_000_003_000_u64, "content": [
                { "type": "redactedThinking", "data": "x" }, call("g1", "case \\w+ = "), call("g2", "grep") ] } }),
        result("r1", "g1"),
        result("r2", "g2"),
        json!({ "type": "message", "id": "m2", "parentId": "r2", "timestamp": "2026-10-28T10:00:05.000Z",
            "message": { "role": "assistant", "stopReason": "stop", "timestamp": 1_793_000_005_000_u64,
                         "content": [{ "type": "text", "text": "Fertig: die Übersicht als Tabelle." }] } }),
    ]
}

/// The first message streaming its two tool calls, as a live `message_update`; `marker` rides in
/// its text (where a lab freeze is armed).
fn streaming_calls(marker: &str) -> Value {
    json!({ "t": "event", "event": { "type": "message_update", "assistantMessageEvent": { "type": "toolcall_delta" },
        "message": { "role": "assistant", "timestamp": 1_793_000_003_000_u64, "content": [
            { "type": "redactedThinking", "data": "x" },
            { "type": "toolCall", "id": "g1", "name": "grep", "arguments": { "pattern": format!("case {marker}") } },
            { "type": "toolCall", "id": "g2", "name": "grep", "arguments": { "pattern": "gr" } } ] } } })
}

fn append_entries(file: &Path, entries: &[Value]) {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().append(true).open(file).unwrap();
    for e in entries {
        writeln!(f, "{e}").unwrap();
    }
}

fn final_answer_shown(s: &OmpSession) -> bool {
    rows(s).iter().any(|i| matches!(i, TranscriptItem::Assistant(a) if a.text.contains("Tabelle") && !a.streaming))
}

#[tokio::test(flavor = "multi_thread")]
async fn a_feed_driver_stuck_mid_turn_is_started_over_and_the_copy_reloaded_from_the_file() {
    // The reported freeze: the first message streams its tool calls, then nothing more reaches the
    // copy (here its feed driver hangs where no ask reaches it) while omp writes the rest of the
    // turn and ends it. The watchdog sees the file ahead of the copy, starts the driver over and
    // rebuilds the copy from the file. Before, the stall watchdog's ask was never taken: the copy
    // (and every app showing it) stayed on the two queued calls for good.
    let lab = Lab::start().await;
    let dir = tempfile::tempdir().unwrap();
    let file = session_file(dir.path(), "s1", "grep it");
    let mut ext = bridge_serves(&lab, "s1", &file, 1).await;
    until("the bridge serves the session", || lab.session("s1").is_some_and(|s| link_of(&s) == LIVE)).await;
    let s = lab.session("s1").unwrap();
    let app = client("app");
    s.subscribe(&app, "agent-1", 100, None);
    ext.send(json!({ "t": "live", "seq": 2, "f": { "t": "event", "event": { "type": "agent_start" } } })).await;
    ext.send(json!({ "t": "live", "seq": 3, "f": streaming_calls("") })).await;
    until("the calls are queued", || statuses(&s) == [ToolStatus::Pending, ToolStatus::Pending]).await;
    crate::lab::arm("stuck-driver-7f3a");
    ext.send(json!({ "t": "live", "seq": 4, "f": streaming_calls("stuck-driver-7f3a") })).await;
    // omp goes on: the turn lands in its file and its control state says idle.
    append_entries(&file, &grep_turn());
    ext.state_titled("s1", "t").await;
    let req = ext.recv_req().await;
    assert_eq!(req["op"], "liveSubscribe", "a new driver subscribes");
    // Before the bridge answers, the copy shows the turn as omp wrote it.
    until("the copy is reloaded from the file", || final_answer_shown(&s)).await;
    assert_eq!(statuses(&s), [ToolStatus::Ok, ToolStatus::Ok]);
    assert!(!s.is_streaming());
    assert!(sent_kinds(&app).contains(&"reset".to_string()), "subscribers got the repaired rows");
    ext.send(idle_resync("s1", &file, 5, last_entry(&file).as_deref(), &[])).await;
    ext.ok(&req, json!({})).await;
    until("the new driver serves it", || link_of(&s) == LIVE && s.lock().settle.ask.is_none()).await;
    assert!(final_answer_shown(&s));
    lab.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stuck_feed_driver_whose_bridge_left_hands_the_session_to_the_file() {
    // The feed driver hangs where no ask reaches it, then omp's bridge goes (omp exited, or its
    // extension went away for good): the driver never sees it, and its restart finds no bridge to
    // subscribe to. The session must say its bridge is lost (the file serves it meanwhile, and it
    // is dropped once omp is gone). Before, it stayed `live` through a bridge that was gone, with
    // no driver, and was never dropped.
    let lab = Lab::start().await;
    let dir = tempfile::tempdir().unwrap();
    let file = session_file(dir.path(), "s1", "grep it");
    let mut ext = bridge_serves(&lab, "s1", &file, 1).await;
    until("the bridge serves the session", || lab.session("s1").is_some_and(|s| link_of(&s) == LIVE)).await;
    let s = lab.session("s1").unwrap();
    ext.send(json!({ "t": "live", "seq": 2, "f": { "t": "event", "event": { "type": "agent_start" } } })).await;
    ext.send(json!({ "t": "live", "seq": 3, "f": streaming_calls("") })).await;
    until("the calls are queued", || statuses(&s) == [ToolStatus::Pending, ToolStatus::Pending]).await;
    crate::lab::arm("bridge-left-5d1e");
    ext.send(json!({ "t": "live", "seq": 4, "f": streaming_calls("bridge-left-5d1e") })).await;
    // The frame is on its way to the driver ahead of the connection's end.
    drop(ext);
    append_entries(&file, &grep_turn());
    until("the session says its bridge is lost", || link_of(&s) == (LinkState::Connecting, Some(LinkReason::BridgeLost), Some(LinkVia::Bridge))).await;
    until("the file serves it", || final_answer_shown(&s)).await;
    assert_eq!(statuses(&s), [ToolStatus::Ok, ToolStatus::Ok]);
    lab.stop().await;
}

/// A turn whose first attempt failed after streaming a tool call (the provider gave out mid-reply)
/// and whose retry answered, as omp writes it: the file keeps the attempt, no result for its call.
fn retried_call_turn() -> Vec<Value> {
    vec![
        json!({ "type": "message", "id": "f1", "parentId": "e1", "timestamp": "2026-10-28T10:00:02.000Z",
            "message": { "role": "assistant", "stopReason": "error", "errorMessage": "529 Overloaded", "timestamp": 1_793_000_002_000_u64,
                         "content": [{ "type": "thinking", "thinking": "deploying" },
                                     { "type": "toolCall", "id": "c1", "name": "bash", "arguments": { "command": "./deploy" } }] } }),
        json!({ "type": "message", "id": "m1", "parentId": "f1", "timestamp": "2026-10-28T10:00:05.000Z",
            "message": { "role": "assistant", "stopReason": "stop", "timestamp": 1_793_000_005_000_u64,
                         "content": [{ "type": "text", "text": "Deployed." }] } }),
    ]
}

#[tokio::test(flavor = "multi_thread")]
async fn a_call_no_run_finished_does_not_get_its_session_repaired_for_good() {
    // A copy rebuilt from omp's file (any resync: a bridge reconnect, a tf-hostd update) shows the
    // failed attempt's call queued for good while omp is idle: the file has no result for it, so no
    // repair can settle it. Before, the settle watchdog took it for a copy stuck mid-turn: a fresh
    // resync after 30 s, a rebuild from the whole file 15 s later, and again every 2 to 15 minutes,
    // each a reset for every app, for as long as the call was among the newest 64 rows.
    let lab = Lab::start().await;
    let dir = tempfile::tempdir().unwrap();
    let file = session_file(dir.path(), "s1", "deploy it");
    append_entries(&file, &retried_call_turn());
    let mut ext = bridge_serves(&lab, "s1", &file, 1).await;
    until("the bridge serves the session", || lab.session("s1").is_some_and(|s| link_of(&s) == LIVE)).await;
    let s = lab.session("s1").unwrap();
    assert!(statuses(&s).contains(&ToolStatus::Pending), "the rebuilt copy shows the call queued: {:?}", statuses(&s));
    assert!(rows(&s).iter().any(|i| matches!(i, TranscriptItem::Assistant(a) if a.text == "Deployed.")));
    // Well past the stale wait and the source's grace (300 ms + 400 ms in tests).
    let asked = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let req = ext.recv_req().await;
            if req["op"] == "liveSubscribe" {
                return req;
            }
        }
    })
    .await;
    assert!(asked.is_err(), "the settle watchdog repaired a copy omp agrees with: {asked:?}");
    assert_eq!(link_of(&s), LIVE);
    lab.stop().await;
}

#[tokio::test] // current-thread: its clock can be paused
async fn a_bridge_that_stops_answering_is_closed_so_it_dials_again() {
    // A bridge whose socket is open but answers nothing (its writer stuck): two subscriptions in a
    // row time out, and hostd closes the connection; the extension then redials. Before, hostd
    // asked it again every 2-30 s forever.
    let lab = Lab::start().await;
    let dir = tempfile::tempdir().unwrap();
    let file = session_file(dir.path(), "s1", "hi");
    let mut ext = FakeExt::connect(&lab.bridge).await;
    ext.send(hello("s1", &file)).await;
    tokio::time::pause();
    let closed = async { while let Ok(Some(_)) = ext.lines.next_line().await {} };
    tokio::time::timeout(Duration::from_secs(60), closed).await.expect("hostd keeps the silent bridge's connection open");
    tokio::time::resume();
    lab.stop().await;
}

#[tokio::test] // current-thread: its clock can be paused (the join grace)
async fn a_silent_collab_room_is_asked_again_and_the_copy_reloaded_from_the_file() {
    // A session served through omp's collab room (no bridge with a data plane: an old global
    // bridge copy, a hand-started omp). The room goes silent mid-turn and does not answer a new
    // hello either, while omp writes the turn to its file. The copy is rebuilt from the file. Before,
    // nothing watched collab-served copies.
    let lab = Lab::start().await;
    let sessions = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(sessions.path().join("-w")).unwrap();
    let file = session_file(&sessions.path().join("-w"), "s1", "grep it");
    lab.omp.set_sessions_root(sessions.path().to_path_buf());
    let first = json!({ "type": "message", "id": "e1", "parentId": null, "timestamp": "2026-10-28T10:00:02.000Z",
        "message": { "role": "user", "content": "grep it", "timestamp": 1_793_000_002_000_u64 } });
    crate::lab::arm("silent-room-41c2");
    let then = vec![json!({ "t": "event", "event": { "type": "agent_start" } }), streaming_calls(""), streaming_calls("silent-room-41c2")];
    let (link, url) = room_link(lab.port, "TfSilentRoomTestRoom01");
    let mut room = FakeRoom::open_answering(&link, "s1", vec![first], then, 1).await;
    let ops = publish_room(&lab.registry_dir(), "i1", std::process::id(), "s1", url);
    poll_now(&lab, &ops).await;
    // No bridge says hello for the process: the room is joined after the grace.
    tokio::time::pause();
    tokio::time::advance(JOIN_GRACE + Duration::from_secs(1)).await;
    tokio::time::resume();
    lab.omp.repoll();
    until("the room serves the queued calls", || {
        lab.session("s1").is_some_and(|s| link_of(&s).2 == Some(LinkVia::Collab) && statuses(&s) == [ToolStatus::Pending, ToolStatus::Pending])
    })
    .await;
    let s = lab.session("s1").unwrap();
    append_entries(&file, &grep_turn());
    until("the copy is reloaded from the file", || final_answer_shown(&s)).await;
    assert_eq!(statuses(&s), [ToolStatus::Ok, ToolStatus::Ok]);
    let hellos = room.take().iter().filter(|h| matches!(h, HostSaw::Frame(_, f) if f["t"] == "hello")).count() + 1;
    assert!(hellos >= 2, "the room was asked for everything again ({hellos} hellos)");
    lab.stop().await;
}

// ───────────────────────────── the session file serves what no room does ─────────────────────────────

/// A sessions dir of the test's own with `s1`'s file (the user's first message), set as where the
/// settle watchdog looks session files up.
fn sessions_dir(lab: &Lab) -> (tempfile::TempDir, PathBuf) {
    let sessions = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(sessions.path().join("-w")).unwrap();
    let file = session_file(&sessions.path().join("-w"), "s1", "grep it");
    lab.omp.set_sessions_root(sessions.path().to_path_buf());
    (sessions, file)
}

/// The entries of `file` (title slot and header left out).
fn file_entries(file: &Path) -> Vec<Value> {
    std::fs::read_to_string(file).unwrap().lines().map(|l| serde_json::from_str::<Value>(l).unwrap()).filter(|v| !matches!(v["type"].as_str(), Some("title" | "session"))).collect()
}

fn row_ids(s: &OmpSession) -> Vec<String> {
    rows(s).iter().map(|i| i.id().to_owned()).collect()
}

#[tokio::test] // current-thread: its clock can be paused (the join grace)
async fn a_room_that_went_away_leaves_the_file_serving_its_session_until_the_room_is_back() {
    // omp's collab room serves the session; then the room goes (omp closed it, the relay reset it)
    // and the guest keeps reconnecting. Meanwhile omp goes on and writes its turn: the copy follows
    // the session file, row by row, without a reset. When the room is back, the guest's snapshot
    // takes over: the same rows, none twice. Before, the copy stayed where the room left it until
    // the room came back (or, with repairs, a full rebuild every 60 s to 15 min).
    let lab = Lab::start().await;
    let (_sessions, file) = sessions_dir(&lab);
    let (link, url) = room_link(lab.port, "TfFollowTestRoom000001");
    let _room = FakeRoom::open_serving(&link, "s1", &file).await;
    let ops = publish_room(&lab.registry_dir(), "i1", std::process::id(), "s1", url);
    poll_now(&lab, &ops).await;
    tokio::time::pause();
    tokio::time::advance(JOIN_GRACE + Duration::from_secs(1)).await;
    tokio::time::resume();
    lab.omp.repoll();
    until("the room serves the session", || lab.session("s1").is_some_and(|s| link_of(&s) == (LinkState::Live, None, Some(LinkVia::Collab)))).await;
    let s = lab.session("s1").unwrap();
    let app = client("app");
    s.subscribe(&app, "agent-1", 100, None);
    sent_kinds(&app);

    // The guest read omp's journal (the session file) as far as it goes.
    let len = std::fs::metadata(&file).unwrap().len();
    until("the journal is read", || s.lock().replica.journal_offset() == len).await;
    // The room goes: the guest reconnects, and the file serves the session.
    reset_room(&lab.omp.inner, "TfFollowTestRoom000001").await;
    until("the guest reconnects", || link_of(&s).0 == LinkState::Connecting).await;
    append_entries(&file, &grep_turn());
    until("the copy follows the file", || final_answer_shown(&s)).await;
    assert_eq!(statuses(&s), [ToolStatus::Ok, ToolStatus::Ok]);
    // Subscribers get the rows with the next flush (every 50 ms).
    tokio::time::sleep(Duration::from_millis(200)).await;
    let kinds = sent_kinds(&app);
    assert!(kinds.contains(&"upsert".to_string()), "{kinds:?}");
    assert!(!kinds.iter().any(|k| k == "reset" || k == "ended"), "followed row by row: {kinds:?}");
    let followed = row_ids(&s);

    // The room is back with the session as omp has it: the guest takes over, rows unchanged.
    let _back = FakeRoom::open_serving(&link, "s1", &file).await;
    until("the room serves it again", || link_of(&s) == (LinkState::Live, None, Some(LinkVia::Collab))).await;
    assert!(Arc::ptr_eq(&s, &lab.session("s1").unwrap()), "the same session went on");
    assert_eq!(row_ids(&s), followed, "no row lost or doubled");
    assert!(!sent_kinds(&app).contains(&"ended".to_string()));
    lab.stop().await;
}

#[tokio::test] // current-thread: its clock can be paused (the join grace)
async fn a_room_hostd_cannot_join_shows_its_session_from_the_file_until_a_join_works() {
    // omp publishes a room that cannot be joined (here: nobody hosts it on the relay). Before, the
    // agent had no transcript at all while joins kept failing; now its session file serves it,
    // the link saying why it is not live, and the join that works takes the session over.
    let lab = Lab::start().await;
    let (_sessions, file) = sessions_dir(&lab);
    append_entries(&file, &grep_turn()[..1]);
    let (link, url) = room_link(lab.port, "TfUnjoinableTestRoom01");
    let ops = publish_room(&lab.registry_dir(), "i1", std::process::id(), "s1", url);
    poll_now(&lab, &ops).await;
    tokio::time::pause();
    tokio::time::advance(JOIN_GRACE + Duration::from_secs(1)).await;
    tokio::time::resume();
    lab.omp.repoll();
    until("the file serves the session", || lab.session("s1").is_some_and(|s| statuses(&s).len() == 2)).await;
    let s = lab.session("s1").unwrap();
    assert_eq!(link_of(&s), (LinkState::Connecting, Some(LinkReason::JoinFailed), Some(LinkVia::Collab)));
    let app = client("app");
    s.subscribe(&app, "agent-1", 100, None);
    sent_kinds(&app);
    append_entries(&file, &grep_turn()[1..]);
    until("the copy follows the file", || final_answer_shown(&s)).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let kinds = sent_kinds(&app);
    assert!(kinds.contains(&"upsert".to_string()) && !kinds.iter().any(|k| k == "reset" || k == "ended"), "followed row by row: {kinds:?}");
    let followed = row_ids(&s);

    // The room can be joined now: the next attempt takes the session over.
    let _room = FakeRoom::open_serving(&link, "s1", &file).await;
    until("the room serves it", || link_of(&s) == (LinkState::Live, None, Some(LinkVia::Collab))).await;
    assert!(Arc::ptr_eq(&s, &lab.session("s1").unwrap()), "the session served from its file goes on");
    assert_eq!(row_ids(&s), followed, "no row lost or doubled");
    lab.stop().await;
}
