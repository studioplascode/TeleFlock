//! End-to-end harness: speaks the client protocol (JSON lines) through `tf-hostd attach`
//! against a real herdr lab session and prints evidence excerpts.
//!
//! ```sh
//! TF_HOSTD_HOME=/tmp/tf-lab-core-home cargo run -p tf-hostd --example e2e -- \
//!   --hostd target/HostdCore/debug/tf-hostd --session tf-lab-core --relay-port 47567 \
//!   --cwd /tmp/tf-lab-core-work --model openai-codex/gpt-6-luna
//! ```
//!
//! Steps: daemon start + snapshot → `agent.start` → agent linked → `session.open` →
//! prompt → `append` deltas → ask lands in `needs` → `agent.answer` → archive →
//! second client sees the same state → daemon restart keeps the archive.
//! Before the run, the harness writes `<home>/omp-overlay.yml` (what the app deploys).

use std::io::{BufRead, BufReader, Write};
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
}

fn args() -> Args {
    let mut a = Args {
        hostd: "target/HostdCore/debug/tf-hostd".into(),
        session: "tf-lab-core".into(),
        relay_port: 47567,
        cwd: "/tmp/tf-lab-core-work".into(),
        model: "openai-codex/gpt-6-luna".into(),
        keep: false,
        ext: Some("host/teleflock-bridge/teleflock-bridge.ts".into()).filter(|p| std::path::Path::new(p).is_file()),
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
        let welcome = c.wait("welcome", 15, |m| m["t"] == "welcome");
        println!("[{name}] welcome: {welcome}");
        c.wait("snapshot", 15, |m| m["t"] == "snapshot");
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
                        Some("info") => {
                            self.state["info"] = op["info"].clone();
                            continue;
                        }
                        Some("usage") => {
                            self.state["usage"] = op["usage"].clone();
                            continue;
                        }
                        Some("health") => {
                            self.state["health"] = op["health"].clone();
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
        panic!("[{}] timed out after {secs}s waiting for state: {what}", self.name);
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({"t": "req", "id": id, "method": method, "params": params}));
        let res = self.wait(method, 90, |m| m["t"] == "res" && m["id"] == id);
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

    fn close(mut self) {
        self.send(json!({"t": "bye"}));
        let _ = self.child.wait();
    }
}

fn short(v: &Value, n: usize) -> String {
    let s = v.to_string();
    if s.len() > n { format!("{}…", &s[..n]) } else { s }
}

fn main() {
    let a = args();
    let home = std::env::var("TF_HOSTD_HOME").expect("set TF_HOSTD_HOME (lab home)");
    std::fs::create_dir_all(&home).unwrap();
    // What the app deploys: the collab overlay pointing at this daemon's relay.
    std::fs::write(
        format!("{home}/omp-overlay.yml"),
        format!("collab:\n  autoStart: control\n  relayUrl: ws://127.0.0.1:{}\n  displayName: tf-lab-core\n", a.relay_port),
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
    let mut c1 = Client::attach("desktop", &a);
    println!(
        "[desktop] snapshot rev {} info.herdrSession={} relayPort={} setup.relay={} workspaces={} agents={}",
        c1.rev,
        c1.state["info"]["herdrSession"],
        c1.state["info"]["relayPort"],
        c1.state["info"]["setup"]["relay"],
        c1.state["workspaces"].as_array().map_or(0, |v| v.len()),
        c1.state["agents"].as_array().map_or(0, |v| v.len()),
    );

    println!("== 2. agent.start");
    let started = c1
        .call(
            "agent.start",
            json!({"target": {"kind": "cwd", "cwd": a.cwd, "label": "e2e"},
                   "spec": {"kind": "omp", "model": a.model, "thinking": "low", "plan": false}}),
        )
        .expect("agent.start");
    println!("[desktop] started: {started}");
    let id = started["agentId"].as_str().expect("agent id").to_string();
    c1.wait_state("agent linked", 60, |s| {
        s["agents"].as_array().into_iter().flatten().any(|x| x["id"] == id.as_str() && x["omp"]["link"] == "live")
    });
    let ag = c1.agent(&id);
    println!(
        "[desktop] agent in snapshot: id={} name={} kind={} column={} state={} link={} session={} bridge={}",
        ag["id"], ag["name"], ag["kind"], ag["column"], ag["state"], ag["omp"]["link"], ag["omp"]["sessionId"], ag["omp"]["bridge"]
    );

    println!("== 3. session.open");
    let snap = c1.call("session.open", json!({"agentId": id})).expect("session.open");
    println!(
        "[desktop] session snapshot: items={} caps.prompt={} caps.bridge={} model={}",
        snap["items"].as_array().map_or(0, |v| v.len()),
        snap["meta"]["caps"]["prompt"],
        snap["meta"]["caps"]["bridge"],
        short(&snap["meta"]["model"], 120)
    );

    println!("== 4. prompt → append deltas");
    let mark = c1.log.len();
    c1.call("agent.prompt", json!({"agentId": id, "text": "Write four short sentences about kites.", "images": [], "delivery": "auto"}))
        .expect("agent.prompt");
    c1.wait_state("turn started", 60, |s| {
        s["agents"].as_array().into_iter().flatten().any(|x| x["id"] == id.as_str() && x["state"] == "working")
    });
    c1.wait_state("turn finished", 120, |s| {
        s["agents"].as_array().into_iter().flatten().any(|x| x["id"] == id.as_str() && x["column"] == "review")
    });
    c1.drain(800);
    let session_msgs: Vec<&Value> = c1.log[mark..].iter().filter(|m| m["t"] == "session").collect();
    let appends: Vec<&Value> = session_msgs.iter().copied().filter(|m| m["ev"]["k"] == "append").collect();
    let pulses = c1.log[mark..].iter().filter(|m| m["t"] == "pulse").count();
    println!("[desktop] session events: {} ({} append deltas), pulses: {}", session_msgs.len(), appends.len(), pulses);
    let mut kinds: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for m in &session_msgs {
        *kinds.entry(m["ev"]["k"].as_str().unwrap_or("?").to_string()).or_default() += 1;
    }
    println!("  by kind: {kinds:?}");
    for m in appends.iter().take(4) {
        println!("  append: {}", short(&m["ev"], 160));
    }
    if let Some(last) = session_msgs.iter().rev().find(|m| m["ev"]["k"] == "upsert" && m["ev"]["item"]["kind"] == "assistant") {
        println!("  final assistant upsert: {}", short(&last["ev"]["item"]["text"], 200));
    }
    assert!(!appends.is_empty(), "no append deltas streamed");
    let notes: Vec<&Value> = c1.log[mark..].iter().filter(|m| m["t"] == "notify").collect();
    for n in &notes {
        println!("  notify: {}", short(&n["notification"], 200));
    }

    println!("== 5. ask → needs → agent.answer");
    let mark = c1.log.len();
    c1.call(
        "agent.prompt",
        json!({"agentId": id, "images": [], "delivery": "auto",
               "text": "Use the ask tool now to ask me exactly one question: 'Pick a color' with the options 'Red' and 'Blue'. After I answer, reply with only the color I picked."}),
    )
    .expect("ask prompt");
    c1.wait_state("needs ask", 120, |s| {
        s["agents"].as_array().into_iter().flatten().any(|x| x["id"] == id.as_str() && x["column"] == "needs" && x["needs"]["kind"] == "ask")
    });
    let needs = c1.agent(&id)["needs"].clone();
    println!("[desktop] needs: {}", short(&needs, 400));
    let ui = c1.log[mark..].iter().rev().find(|m| m["t"] == "session" && m["ev"]["k"] == "ui").cloned();
    println!("[desktop] session ui event: {}", ui.map(|u| short(&u["ev"], 300)).unwrap_or_else(|| "none".into()));
    let request_id = needs["requestId"].as_str().expect("request id").to_string();
    let choice = needs["options"]
        .as_array()
        .and_then(|o| o.iter().find(|x| x["label"] == "Blue").or(o.first()))
        .map(|o| o["id"].clone())
        .expect("option");
    c1.call("agent.answer", json!({"agentId": id, "requestId": request_id, "answer": {"choices": [choice], "cancel": false, "chat": false}}))
        .expect("agent.answer");
    c1.wait_state("needs resolved + finished", 120, |s| {
        s["agents"].as_array().into_iter().flatten().any(|x| x["id"] == id.as_str() && x["needs"].is_null() && x["column"] == "review")
    });
    c1.drain(800);
    let answer_text = c1.log[mark..]
        .iter()
        .rev()
        .find(|m| m["t"] == "session" && m["ev"]["k"] == "upsert" && m["ev"]["item"]["kind"] == "assistant")
        .map(|m| short(&m["ev"]["item"]["text"], 120))
        .unwrap_or_default();
    println!("[desktop] answered `{choice}`; needs cleared; column=review; assistant: {answer_text}");
    let activity = c1.call("host.activity", json!({"limit": 12})).expect("host.activity");
    for ev in activity["events"].as_array().into_iter().flatten().take(12) {
        println!("  activity: {} {} — {}", ev["kind"], ev["title"], short(&ev["detail"], 80));
    }

    println!("== 6. archive + second client");
    c1.call("agent.archive", json!({"agentId": id, "archived": true})).expect("archive");
    c1.wait_state("archived", 10, |s| {
        s["agents"].as_array().into_iter().flatten().any(|x| x["id"] == id.as_str() && x["column"] == "done" && x["archived"] == true)
    });
    let c2 = Client::attach("phone", &a);
    let ag2 = c2.agent(&id);
    println!(
        "[phone] snapshot rev {}: agent {} column={} archived={} link={} turns={}",
        c2.rev, ag2["name"], ag2["column"], ag2["archived"], ag2["omp"]["link"], ag2["turns"]
    );
    assert_eq!(ag2["column"], "done");
    let c1_agents: Vec<Value> = c1.state["agents"].as_array().cloned().unwrap_or_default();
    let c2_agents: Vec<Value> = c2.state["agents"].as_array().cloned().unwrap_or_default();
    let same = c1_agents.iter().all(|x| c2_agents.iter().any(|y| y["id"] == x["id"] && y["column"] == x["column"]));
    println!("[phone] same agents/columns as desktop: {same}");
    assert!(same);
    c2.close();
    c1.close();

    println!("== 7. daemon restart keeps the archive");
    let out = Command::new(&a.hostd).arg("stop").output().expect("tf-hostd stop");
    println!("[stop] {}", String::from_utf8_lossy(&out.stderr).trim().replace('\n', " | "));
    let state_json = std::fs::read_to_string(format!("{home}/state.json")).unwrap_or_default();
    println!("[state.json] archived entry present: {}", state_json.contains(&id));
    let mut c3 = Client::attach("desktop-again", &a);
    c3.wait_state("agent present after restart", 30, |s| {
        s["agents"].as_array().into_iter().flatten().any(|x| x["id"] == id.as_str())
    });
    let ag3 = c3.agent(&id);
    println!("[desktop-again] after restart: column={} archived={} turns={}", ag3["column"], ag3["archived"], ag3["turns"]);
    assert_eq!(ag3["archived"], true);
    c3.wait_state("relinked", 60, |s| {
        s["agents"].as_array().into_iter().flatten().any(|x| x["id"] == id.as_str() && x["omp"]["link"] == "live")
    });
    println!("[desktop-again] relinked after restart: link=live");

    if !a.keep {
        let _ = c3.call("agent.stop", json!({"agentId": id, "mode": "closePane"}));
    }
    c3.close();
    println!("== e2e OK");
}
