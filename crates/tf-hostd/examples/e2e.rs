//! End-to-end harness for omp sessions (architecture §3.4): speaks the client protocol (JSON
//! lines) through `tf-hostd attach` against a real herdr lab session and real omp, and prints
//! evidence excerpts.
//!
//! ```sh
//! TF_HOSTD_HOME=/tmp/tf-lab-x-home PI_CODING_AGENT_DIR=/tmp/tf-lab-x-agent \
//!   cargo run -p tf-hostd --example e2e -- --hostd target/debug/tf-hostd --session tf-lab-x \
//!   --relay-port 47650 --cwd /tmp/tf-lab-x-work --old-ext /tmp/tf-lab-x-old/teleflock-bridge.ts
//! ```
//!
//! `PI_CODING_AGENT_DIR` gives the lab omp an agent dir (and credentials) of its own: the daemon
//! `attach` starts inherits it, and so do the herdr server it starts and every omp pane.
//!
//! Steps: daemon start → agent A with the current bridge (≥ 2.0): `live` through the bridge,
//! no collab guest in its room → `session.open` → a prompt streams `append` deltas → an `ask`
//! answered with `agent.answer` reaches the tool → parallel subagents stream their roster and
//! progress while the session stays `live` → agent B with an old bridge (`--old-ext`, 1.4.x):
//! `live` through omp's collab room → the daemon is killed (SIGKILL) and started again: A comes
//! back through its bridge with the same rows and no notification replay, B through its room →
//! both panes closed, daemon stopped. Before the run the harness writes `<home>/omp-overlay.yml`
//! and deploys `--ext` to `<home>/ext/` (what the app does).

use std::collections::{BTreeMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

struct Args {
    hostd: String,
    session: String,
    relay_port: u16,
    cwd: String,
    model: String,
    keep: bool,
    /// Companion extension to deploy into `<home>/ext/` (what the app uploads).
    ext: Option<String>,
    /// An old bridge (< 2.0, no data plane) for the second agent; skipped without one.
    old_ext: Option<String>,
}

fn args() -> Args {
    let mut a = Args {
        hostd: "target/debug/tf-hostd".into(),
        session: "tf-lab-e2e".into(),
        relay_port: 47650,
        cwd: "/tmp/tf-lab-e2e-work".into(),
        model: "openai-codex/gpt-6-luna".into(),
        keep: false,
        ext: Some("host/teleflock-bridge/teleflock-bridge.ts".into()).filter(|p| std::path::Path::new(p).is_file()),
        old_ext: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(k) = it.next() {
        let mut v = || it.next().expect("missing value");
        match k.as_str() {
            "--hostd" => a.hostd = v(),
            "--session" => a.session = v(),
            "--relay-port" => a.relay_port = v().parse().expect("port"),
            "--cwd" => a.cwd = v(),
            "--model" => a.model = v(),
            "--keep" => a.keep = true,
            "--ext" => a.ext = Some(v()),
            "--no-ext" => a.ext = None,
            "--old-ext" => a.old_ext = Some(v()),
            other => panic!("unknown arg {other}"),
        }
    }
    a
}

struct Client {
    name: &'static str,
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<Value>,
    next_id: u64,
    /// Everything received, for later assertions.
    log: Vec<Value>,
    state: Value,
    rev: u64,
    last_sent: Instant,
}

impl Client {
    fn attach(name: &'static str, a: &Args) -> Client {
        let mut child = Command::new(&a.hostd)
            .args(["attach", "--session", &a.session, "--relay-port", &a.relay_port.to_string()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn tf-hostd attach");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if tx.send(v).is_err() {
                        break;
                    }
                }
            }
        });
        let mut c = Client { name, child, stdin, rx, next_id: 1, log: vec![], state: Value::Null, rev: 0, last_sent: Instant::now() };
        c.send(json!({
            "t": "hello", "protocol": tf_proto::PROTOCOL_VERSION,
            "client": {"app": "tf-hostd-e2e", "version": "0", "platform": "linux", "device": name},
            "herdrSession": a.session,
        }));
        let welcome = c.wait("welcome", 30, |m| m["t"] == "welcome");
        println!("[{name}] welcome: {}", short(&welcome, 200));
        c.wait("snapshot", 30, |m| m["t"] == "snapshot");
        c
    }

    fn send(&mut self, v: Value) {
        let mut s = v.to_string();
        s.push('\n');
        self.stdin.write_all(s.as_bytes()).expect("write");
        self.stdin.flush().unwrap();
        self.last_sent = Instant::now();
    }

    /// Receives one message within `max`, pinging every 15 s like the real client
    /// (the daemon drops clients after 45 s of silence).
    fn recv(&mut self, max: Duration) -> Option<Value> {
        if self.last_sent.elapsed() > Duration::from_secs(15) {
            let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
            self.send(json!({"t": "ping", "ts": ts}));
        }
        let m = self.rx.recv_timeout(max.min(Duration::from_secs(1))).ok()?;
        self.apply(&m);
        self.log.push(m.clone());
        Some(m)
    }

    fn apply(&mut self, m: &Value) {
        match m["t"].as_str() {
            Some("snapshot") => {
                self.state = m["state"].clone();
                self.rev = m["rev"].as_u64().unwrap_or(0);
            }
            Some("patch") => {
                let rev = m["rev"].as_u64().unwrap_or(0);
                assert_eq!(rev, self.rev + 1, "[{}] rev gap {} → {}", self.name, self.rev, rev);
                self.rev = rev;
                for op in m["ops"].as_array().into_iter().flatten() {
                    let (list, key) = match op["op"].as_str() {
                        Some("agent") => ("agents", "id"),
                        Some("workspace") => ("workspaces", "id"),
                        Some(field @ ("info" | "usage" | "health")) => {
                            self.state[field] = op[field].clone();
                            continue;
                        }
                        _ => continue,
                    };
                    let id = op[key].clone();
                    let arr = self.state[list].as_array_mut().expect("list");
                    arr.retain(|e| e["id"] != id);
                    if !op["value"].is_null() {
                        arr.push(op["value"].clone());
                    }
                }
            }
            _ => {}
        }
    }

    /// Waits for a message matching `pred` (applying state messages on the way).
    fn wait(&mut self, what: &str, secs: u64, pred: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + Duration::from_secs(secs);
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            if let Some(m) = self.recv(left) {
                if pred(&m) {
                    return m;
                }
            }
        }
        panic!("[{}] timed out after {secs}s waiting for {what}", self.name)
    }

    /// Waits until the mirrored state satisfies `pred`.
    fn wait_state(&mut self, what: &str, secs: u64, pred: impl Fn(&Value) -> bool) {
        if pred(&self.state) {
            return;
        }
        let deadline = Instant::now() + Duration::from_secs(secs);
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            if self.recv(left).is_some() && pred(&self.state) {
                return;
            }
        }
        panic!("[{}] timed out after {secs}s waiting for state: {what}\nagents: {}", self.name, short(&self.state["agents"], 3000));
    }

    /// Waits until agent `id` satisfies `pred`.
    fn wait_agent(&mut self, what: &str, secs: u64, id: &str, pred: impl Fn(&Value) -> bool) -> Value {
        self.wait_state(what, secs, |s| s["agents"].as_array().into_iter().flatten().any(|x| x["id"] == id && pred(x)));
        self.agent(id)
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({"t": "req", "id": id, "method": method, "params": params}));
        let res = self.wait(method, 120, |m| m["t"] == "res" && m["id"] == id);
        if res["error"].is_null() { Ok(res["result"].clone()) } else { Err(res["error"].clone()) }
    }

    fn agent(&self, id: &str) -> Value {
        self.state["agents"].as_array().and_then(|a| a.iter().find(|x| x["id"] == id).cloned()).unwrap_or(Value::Null)
    }

    /// Receives (and applies) messages for `ms` milliseconds.
    fn drain(&mut self, ms: u64) {
        let deadline = Instant::now() + Duration::from_millis(ms);
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            self.recv(left);
        }
    }

    /// Session events for `agent` received since log index `mark`.
    fn session_events(&self, mark: usize, agent: &str) -> Vec<Value> {
        self.log[mark..].iter().filter(|m| m["t"] == "session" && m["agentId"] == agent).map(|m| m["ev"].clone()).collect()
    }

    fn close(mut self) {
        self.send(json!({"t": "bye"}));
        let _ = self.child.wait();
    }
}

fn short(v: &Value, n: usize) -> String {
    let s = v.to_string();
    if s.len() > n { format!("{}…", &s[..s.floor_char_boundary(n)]) } else { s }
}

fn turns_of(a: &Value) -> u64 {
    a["turns"].as_u64().unwrap_or(0)
}

/// `omp.link` / `linkReason` / `linkVia` of an agent.
fn link(a: &Value) -> (String, String, String) {
    let s = |k: &str| a["omp"][k].as_str().unwrap_or("-").to_string();
    (s("link"), s("linkReason"), s("linkVia"))
}

fn live_via(via: &'static str) -> impl Fn(&Value) -> bool {
    move |a: &Value| a["omp"]["link"] == "live" && a["omp"]["linkVia"] == via
}

/// The lab relay's `/healthz`: `{"ok":true,"rooms":N,"guests":M}`.
fn relay_health(port: u16) -> Value {
    let mut s = TcpStream::connect(("127.0.0.1", port)).expect("relay");
    s.write_all(b"GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
    let mut answer = String::new();
    s.read_to_string(&mut answer).unwrap();
    answer.split("\r\n\r\n").nth(1).and_then(|b| serde_json::from_str(b).ok()).unwrap_or(Value::Null)
}

/// What the daemon logged since byte `from` of `<home>/hostd.log`.
fn log_since(home: &str, from: u64) -> String {
    let text = std::fs::read(format!("{home}/hostd.log")).unwrap_or_default();
    String::from_utf8_lossy(&text[(from as usize).min(text.len())..]).into_owned()
}

fn log_len(home: &str) -> u64 {
    std::fs::metadata(format!("{home}/hostd.log")).map_or(0, |m| m.len())
}

fn log_lines<'a>(log: &'a str, needle: &str) -> Vec<&'a str> {
    log.lines().filter(|l| l.contains(needle)).collect()
}

/// A transcript row reduced to what a client shows (id, kind, text or tool status).
fn row_key(item: &Value) -> String {
    let what = match item["kind"].as_str() {
        Some("tool") => format!("{}:{}:{}", item["tool"], item["status"], item["output"].as_str().map_or(0, str::len)),
        _ => item["text"].as_str().unwrap_or_default().chars().take(60).collect(),
    };
    format!("{} {} {}", item["id"].as_str().unwrap_or("?"), item["kind"].as_str().unwrap_or("?"), what)
}

fn rows(snapshot: &Value) -> Vec<Value> {
    snapshot["items"].as_array().cloned().unwrap_or_default()
}

fn main() {
    let a = args();
    let home = std::env::var("TF_HOSTD_HOME").expect("set TF_HOSTD_HOME (lab home)");
    let agent_dir = std::env::var("PI_CODING_AGENT_DIR").unwrap_or_default();
    println!("lab: home={home} PI_CODING_AGENT_DIR={agent_dir} herdr session={} relay port={}", a.session, a.relay_port);
    std::fs::create_dir_all(&home).unwrap();
    // What the app deploys: the collab overlay pointing at this daemon's relay.
    std::fs::write(
        format!("{home}/omp-overlay.yml"),
        format!("collab:\n  autoStart: control\n  relayUrl: ws://127.0.0.1:{}\n  displayName: {}\n", a.relay_port, a.session),
    )
    .unwrap();
    std::fs::create_dir_all(&a.cwd).unwrap();
    let ext_dst = format!("{home}/ext/teleflock-bridge.ts");
    match &a.ext {
        Some(src) => {
            std::fs::create_dir_all(format!("{home}/ext")).unwrap();
            std::fs::copy(src, &ext_dst).expect("deploy extension");
            println!("deployed bridge extension {src} → {ext_dst}");
        }
        None => {
            let _ = std::fs::remove_file(&ext_dst);
        }
    }

    println!("== 1. daemon start + snapshot");
    let log_start = log_len(&home);
    let mut c1 = Client::attach("desktop", &a);
    println!(
        "[desktop] snapshot rev {} herdrSession={} relayPort={} agents={}",
        c1.rev,
        c1.state["info"]["herdrSession"],
        c1.state["info"]["relayPort"],
        c1.state["agents"].as_array().map_or(0, |v| v.len()),
    );

    println!("== 2. agent A (current bridge): live through the bridge, no collab guest");
    let started = c1
        .call(
            "agent.start",
            json!({"target": {"kind": "cwd", "cwd": a.cwd, "label": "e2e-bridge"},
                   "spec": {"kind": "omp", "model": a.model, "thinking": "low", "plan": false}}),
        )
        .expect("agent.start");
    let id = started["agentId"].as_str().expect("agent id").to_string();
    let t0 = Instant::now();
    let ag = c1.wait_agent("A live through the bridge", 120, &id, live_via("bridge"));
    println!(
        "[desktop] A after {:.1}s: name={} link={:?} bridge={} session={}",
        t0.elapsed().as_secs_f32(),
        ag["name"],
        link(&ag),
        ag["omp"]["bridge"],
        ag["omp"]["sessionId"]
    );
    let sid_a = ag["omp"]["sessionId"].as_str().expect("session id").to_string();
    c1.drain(3000);
    let health = relay_health(a.relay_port);
    let log = log_since(&home, log_start);
    let joins = log_lines(&log, "joined omp session");
    println!("[relay] /healthz {health} (omp's room is open, nobody joined it)");
    for l in log_lines(&log, "bridge serves omp session").iter().chain(&joins) {
        println!("  log: {}", l.trim());
    }
    assert_eq!(health["guests"], 0, "a collab guest joined the bridge-served session");
    assert!(joins.is_empty(), "hostd joined a collab room: {joins:?}");
    assert_eq!(link(&c1.agent(&id)).0, "live");

    println!("== 3. session.open");
    let snap = c1.call("session.open", json!({"agentId": id, "limit": 2000})).expect("session.open");
    println!(
        "[desktop] session snapshot: items={} caps={} model={}",
        rows(&snap).len(),
        short(&snap["meta"]["caps"], 200),
        short(&snap["meta"]["model"], 120)
    );

    println!("== 4. prompt → append deltas");
    let mark = c1.log.len();
    let turns = turns_of(&c1.agent(&id));
    c1.call("agent.prompt", json!({"agentId": id, "text": "Write two short sentences about kites.", "images": [], "delivery": "auto"}))
        .expect("agent.prompt");
    c1.wait_agent("turn finished", 180, &id, |x| turns_of(x) > turns && x["column"] == "review");
    c1.drain(1000);
    let events = c1.session_events(mark, &id);
    let mut kinds: BTreeMap<String, usize> = BTreeMap::new();
    for ev in &events {
        *kinds.entry(ev["k"].as_str().unwrap_or("?").to_string()).or_default() += 1;
    }
    println!("[desktop] session events: {} by kind {kinds:?}", events.len());
    for ev in events.iter().filter(|e| e["k"] == "append").take(4) {
        println!("  append: {}", short(ev, 160));
    }
    if let Some(last) = events.iter().rev().find(|e| e["k"] == "upsert" && e["item"]["kind"] == "assistant") {
        println!("  final assistant upsert: {}", short(&last["item"]["text"], 200));
    }
    assert!(kinds.get("append").copied().unwrap_or(0) > 0, "no append deltas streamed");

    println!("== 5. ask → needs → agent.answer → the tool gets it");
    let mark = c1.log.len();
    let turns = turns_of(&c1.agent(&id));
    c1.call(
        "agent.prompt",
        json!({"agentId": id, "images": [], "delivery": "auto",
               "text": "Use the ask tool now to ask me exactly one question: 'Pick a color' with the options 'Red' and 'Blue'. After I answer, reply with only the color I picked."}),
    )
    .expect("ask prompt");
    let ag = c1.wait_agent("needs ask", 180, &id, |x| x["column"] == "needs" && x["needs"]["kind"] == "ask");
    let needs = ag["needs"].clone();
    println!("[desktop] needs: {}", short(&needs, 400));
    let ui = c1.session_events(mark, &id).into_iter().rev().find(|e| e["k"] == "ui");
    println!("[desktop] session ui event: {}", ui.map(|u| short(&u, 300)).unwrap_or_else(|| "none".into()));
    let request_id = needs["requestId"].as_str().expect("request id").to_string();
    let choice = needs["options"]
        .as_array()
        .and_then(|o| o.iter().find(|x| x["label"] == "Blue").or(o.first()))
        .map(|o| o["id"].clone())
        .expect("option");
    c1.call("agent.answer", json!({"agentId": id, "requestId": request_id, "answer": {"choices": [choice], "cancel": false, "chat": false}}))
        .expect("agent.answer");
    c1.wait_agent("needs resolved + finished", 180, &id, |x| turns_of(x) > turns && x["needs"].is_null() && x["column"] == "review");
    c1.drain(1500);
    let events = c1.session_events(mark, &id);
    let ask = events.iter().rev().find(|e| e["k"] == "upsert" && e["item"]["kind"] == "tool" && e["item"]["tool"] == "ask");
    let reply = events
        .iter()
        .rev()
        .find(|e| e["k"] == "upsert" && e["item"]["kind"] == "assistant" && e["item"]["text"].as_str().is_some_and(|t| !t.is_empty()))
        .map(|e| e["item"]["text"].as_str().unwrap_or_default().to_string())
        .unwrap_or_default();
    println!("[desktop] ask row: {}", ask.map(|e| short(&e["item"], 400)).unwrap_or_else(|| "none".into()));
    println!("[desktop] answered `{choice}`; needs cleared; assistant: {reply}");
    assert!(ask.is_some_and(|e| e["item"]["status"] == "ok"), "the ask tool did not finish ok");
    assert!(reply.contains("Blue"), "the tool did not get the answer: {reply}");

    println!("== 6. parallel subagents: roster and progress stream, the session stays live");
    let mark = c1.log.len();
    let turns = turns_of(&c1.agent(&id));
    c1.call(
        "agent.prompt",
        json!({"agentId": id, "images": [], "delivery": "auto",
               "text": "Call the task tool once with 5 tasks that run in parallel. Task N must only reply with the single word `pong-N` and use no tools. When they are done, reply with just `done`."}),
    )
    .expect("subagent prompt");
    let mut links: HashSet<(String, String, String)> = HashSet::new();
    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        assert!(Instant::now() < deadline, "the subagent turn did not finish");
        c1.recv(Duration::from_millis(500));
        let ag = c1.agent(&id);
        links.insert(link(&ag));
        if turns_of(&ag) > turns && ag["column"] == "review" {
            break;
        }
    }
    c1.drain(2000);
    links.insert(link(&c1.agent(&id)));
    let events = c1.session_events(mark, &id);
    let metas: Vec<&Value> = events.iter().filter(|e| e["k"] == "meta").collect();
    let mut seen: BTreeMap<String, (String, usize)> = BTreeMap::new();
    let mut most_running = 0;
    let mut lines_seen = 0;
    for m in &metas {
        let subs = m["meta"]["subagents"].as_array().cloned().unwrap_or_default();
        most_running = most_running.max(subs.iter().filter(|s| s["status"] == "running").count());
        for s in subs {
            let e = seen.entry(s["id"].as_str().unwrap_or("?").to_string()).or_default();
            e.0 = s["status"].as_str().unwrap_or("?").to_string();
            if s["line"].is_string() || s["tokens"].is_number() {
                e.1 += 1;
                lines_seen += 1;
            }
        }
    }
    let pulses = c1.log[mark..].iter().filter(|m| m["t"] == "pulse").flat_map(|m| m["pulses"].as_array().cloned().unwrap_or_default()).filter(|p| p["agentId"] == id.as_str()).count();
    println!(
        "[desktop] {} session events ({} meta, {} pulses); subagents seen: {}; at most {} running at once; progress updates: {lines_seen}",
        events.len(),
        metas.len(),
        pulses,
        seen.len(),
        most_running
    );
    for (sub, (status, updates)) in &seen {
        println!("  subagent {sub}: final status {status}, {updates} roster updates with progress");
    }
    println!("[desktop] link states of A during the turn: {links:?}");
    let last_meta = metas.last().map(|m| m["meta"]["subagents"].clone()).unwrap_or_default();
    println!("  last roster: {}", short(&last_meta, 1200));
    assert!(seen.len() >= 4, "the roster did not reach the client: {seen:?}");
    assert!(most_running >= 2, "subagents did not run concurrently ({most_running})");
    assert!(seen.values().all(|(s, _)| s != "running"), "a subagent still shows running: {seen:?}");
    assert!(links.iter().all(|l| l.0 == "live" && l.2 == "bridge"), "the session left `live`: {links:?}");

    let mut id_b = None;
    if let Some(old) = &a.old_ext {
        println!("== 7. agent B (old bridge {old}): live through omp's collab room");
        let current = std::fs::read(&ext_dst).ok();
        std::fs::copy(old, &ext_dst).expect("deploy the old bridge");
        let log_mark = log_len(&home);
        let started = c1
            .call(
                "agent.start",
                json!({"target": {"kind": "cwd", "cwd": a.cwd, "label": "e2e-old-bridge"},
                       "spec": {"kind": "omp", "model": a.model, "thinking": "low", "plan": false}}),
            )
            .expect("agent.start (old bridge)");
        let b = started["agentId"].as_str().expect("agent id").to_string();
        let t0 = Instant::now();
        let ag = c1.wait_agent("B live through collab", 180, &b, live_via("collab"));
        // omp loaded it at start: the current bridge goes back for everything else.
        match current {
            Some(bytes) => std::fs::write(&ext_dst, bytes).unwrap(),
            None => std::fs::remove_file(&ext_dst).unwrap(),
        }
        println!("[desktop] B after {:.1}s: link={:?} bridge={} session={}", t0.elapsed().as_secs_f32(), link(&ag), ag["omp"]["bridge"], ag["omp"]["sessionId"]);
        let log = log_since(&home, log_mark);
        for l in log_lines(&log, "bridge connected").iter().chain(&log_lines(&log, "joined omp session")) {
            println!("  log: {}", l.trim());
        }
        let snap_b = c1.call("session.open", json!({"agentId": b})).expect("session.open B");
        println!("[desktop] B session snapshot through collab: items={} caps={}", rows(&snap_b).len(), short(&snap_b["meta"]["caps"], 200));
        let health = relay_health(a.relay_port);
        println!("[relay] /healthz {health}");
        assert_eq!(health["guests"], 1, "B's room has TeleFlock's guest, A's none");
        id_b = Some(b);
    }

    println!("== 8. tf-hostd killed (SIGKILL) and started again");
    let before = c1.call("session.open", json!({"agentId": id, "limit": 2000})).expect("session.open before restart");
    let before_rows: Vec<String> = rows(&before).iter().map(row_key).collect();
    let before_turns = c1.agent(&id)["turns"].clone();
    let usage_before = c1.state["usage"].clone();
    c1.close();
    let pid: i32 = std::fs::read_to_string(format!("{home}/run/hostd.lock")).ok().and_then(|p| p.trim().parse().ok()).expect("daemon pid");
    let log_mark = log_len(&home);
    let status = Command::new("kill").args(["-9", &pid.to_string()]).status().unwrap();
    println!("[kill] SIGKILL daemon pid {pid}: {status}");
    std::thread::sleep(Duration::from_millis(500));
    let t0 = Instant::now();
    let mut c2 = Client::attach("desktop-again", &a);
    let mark = c2.log.len();
    // What the card says until the bridge has reconnected (its 5 s retry).
    let mut states: Vec<(String, String, String)> = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let ag = c2.agent(&id);
        if !ag.is_null() && states.last() != Some(&link(&ag)) {
            states.push(link(&ag));
            println!("  A at {:.1}s: {:?} {}", t0.elapsed().as_secs_f32(), link(&ag), ag["omp"]["linkError"]);
        }
        if live_via("bridge")(&ag) {
            break;
        }
        assert!(Instant::now() < deadline, "A did not come back through its bridge");
        c2.recv(Duration::from_millis(200));
    }
    let ag = c2.agent(&id);
    println!("[desktop-again] A after {:.1}s: link={:?} turns={} (before: {before_turns})", t0.elapsed().as_secs_f32(), link(&ag), ag["turns"]);
    if let Some(b) = &id_b {
        let ag = c2.wait_agent("B back through its room", 90, b, live_via("collab"));
        println!("[desktop-again] B after {:.1}s: link={:?}", t0.elapsed().as_secs_f32(), link(&ag));
    }
    c2.drain(5000);
    let after = c2.call("session.open", json!({"agentId": id, "limit": 2000})).expect("session.open after restart");
    let after_rows: Vec<String> = rows(&after).iter().map(row_key).collect();
    let unique: HashSet<&String> = after_rows.iter().collect();
    println!("[desktop-again] A rows: {} before, {} after ({} unique)", before_rows.len(), after_rows.len(), unique.len());
    for (i, (x, y)) in rows(&before).iter().zip(&rows(&after)).enumerate() {
        if x != y {
            let fields: Vec<&String> = x.as_object().into_iter().flatten().filter(|(k, v)| y.get(k.as_str()) != Some(*v)).map(|(k, _)| k).collect();
            println!("  row {i} differs in {fields:?}:\n    before {}\n    after  {}", short(x, 300), short(y, 300));
        }
    }
    for extra in after_rows.iter().skip(before_rows.len()).chain(before_rows.iter().skip(after_rows.len())) {
        println!("  only on one side: {extra}");
    }
    let same_rows = rows(&before) == rows(&after);
    println!("[desktop-again] rows identical field for field: {same_rows}; meta subagents {} before / {} after", before["meta"]["subagents"].as_array().map_or(0, Vec::len), after["meta"]["subagents"].as_array().map_or(0, Vec::len));
    let notes: Vec<&Value> = c2.log[mark..].iter().filter(|m| m["t"] == "notify").collect();
    for n in &notes {
        println!("  notify after the restart: {}", short(&n["notification"], 200));
    }
    let log = log_since(&home, log_mark);
    for l in log_lines(&log, "bridge serves omp session").iter().chain(&log_lines(&log, "joined omp session")).chain(&log_lines(&log, "session file read")) {
        println!("  log: {}", l.trim());
    }
    let rejoined_a: Vec<&str> = log_lines(&log, "joined omp session").into_iter().filter(|l| l.contains(&sid_a)).collect();
    println!("[desktop-again] usage before {} / after {}", short(&usage_before, 200), short(&c2.state["usage"], 200));
    assert_eq!(after_rows, before_rows, "A's transcript changed across the restart");
    if !same_rows {
        // Known open issue: rows rebuilt from the session file differ from the live ones in
        // incidental fields (user `author`, tool `args` normalisation, `durationMs`).
        println!("[desktop-again] KNOWN GLITCH: rows differ field for field after the restart (see above)");
    }
    assert_eq!(unique.len(), after_rows.len(), "a row twice after the restart");
    assert!(notes.is_empty(), "the restart replayed notifications");
    assert!(rejoined_a.is_empty(), "the restarted hostd joined A's collab room: {rejoined_a:?}");
    assert!(states.iter().all(|s| s.1 != "joining" && s.2 != "collab"), "A's card claimed a collab join while its bridge reconnected: {states:?}");
    assert_eq!(c2.agent(&id)["turns"], before_turns, "the restart changed A's turn count");
    assert_eq!(c2.state["usage"], usage_before, "the restart counted usage again");

    if !a.keep {
        println!("== 9. cleanup");
        for agent in std::iter::once(&id).chain(id_b.as_ref()) {
            let r = c2.call("agent.stop", json!({"agentId": agent, "mode": "closePane"}));
            println!("[desktop-again] agent.stop {agent}: {}", r.map(|_| "ok".to_string()).unwrap_or_else(|e| e.to_string()));
        }
    }
    c2.close();
    println!("== e2e OK");
}
