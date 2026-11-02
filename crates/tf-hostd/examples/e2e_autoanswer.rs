//! Lab end-to-end run of decide for me (architecture §3.23): speaks the client protocol through
//! `tf-hostd attach` against a real herdr lab session and real omp, whose model is a local mock
//! that makes the agent call omp's `ask` tool with a ★ recommended option ("Use SQLite").
//!
//! Run it in a lab (AGENTS.md); the mock model and the lab's omp settings are in
//! `crates/tf-hostd/src/autoanswer/testdata/`:
//!
//! ```sh
//! cargo build -p tf-hostd --bin tf-hostd --example e2e_autoanswer
//! mkdir -p /tmp/tf-lab-autoanswer/omp-agent
//! cp crates/tf-hostd/src/autoanswer/testdata/{models,config}.yml /tmp/tf-lab-autoanswer/omp-agent/
//! scripts/lab/run autoanswer -- bun crates/tf-hostd/src/autoanswer/testdata/mock.ts &
//! scripts/lab/run autoanswer -- target/debug/examples/e2e_autoanswer --hostd target/debug/tf-hostd \
//!   --session tf-lab-autoanswer --relay-port 47608 --work /tmp/tf-lab-autoanswer/work
//! scripts/lab/stop autoanswer --purge
//! ```
//!
//! Steps: three agents ask while an app is connected: `only` (1 min, only when no app is
//! connected) stands still, `cancelled` (same policy) is cancelled for its question, `always`
//! (1 min, apps or not) is answered at its deadline → the app disconnects: `only` counts down
//! (an app that drops by in between stops it) and is answered with no app connected, `cancelled`
//! never is → host default (2 min) on `restart`'s question survives a daemon restart and fires at
//! the deadline set before it.
//!
//! Review items (`HostInfo.decisions`): `always`'s answer is one at once, with its options, wait,
//! policy and notification (whose Open leads to it); `only`'s, decided with no app connected, is
//! in the snapshot of the app that connects afterwards, and reviewing it there removes it for a
//! second app (with `notifyDone` for its notification); `always`'s, unreviewed, is still there
//! after the daemon restart; Mark all reviewed empties the list.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

struct Args {
    hostd: String,
    session: String,
    relay_port: u16,
    work: String,
    model: String,
    ext: String,
}

fn args() -> Args {
    let mut a = Args {
        hostd: "target/debug/tf-hostd".into(),
        session: "tf-lab-autoanswer".into(),
        relay_port: 47576,
        work: "/tmp/tf-lab-autoanswer/work".into(),
        model: "mock/lab-1".into(),
        ext: "host/teleflock-bridge/teleflock-bridge.ts".into(),
    };
    let mut it = std::env::args().skip(1);
    while let Some(k) = it.next() {
        let mut v = || it.next().expect("missing value");
        match k.as_str() {
            "--hostd" => a.hostd = v(),
            "--session" => a.session = v(),
            "--relay-port" => a.relay_port = v().parse().expect("port"),
            "--work" => a.work = v(),
            "--model" => a.model = v(),
            "--ext" => a.ext = v(),
            other => panic!("unknown arg {other}"),
        }
    }
    a
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

struct Client {
    name: &'static str,
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<Value>,
    next_id: u64,
    state: Value,
    notes: Vec<Value>,
    /// `notifyDone` messages (apps with the `presence` feature).
    done: Vec<Value>,
    last_sent: Instant,
}

impl Client {
    fn attach(name: &'static str, a: &Args) -> Client {
        Client::attach_with(name, a, &[])
    }

    fn attach_with(name: &'static str, a: &Args, features: &[&str]) -> Client {
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
                if let Ok(v) = serde_json::from_str::<Value>(&line)
                    && tx.send(v).is_err()
                {
                    break;
                }
            }
        });
        let mut c = Client { name, child, stdin, rx, next_id: 1, state: Value::Null, notes: vec![], done: vec![], last_sent: Instant::now() };
        c.send(json!({
            "t": "hello", "protocol": tf_proto::PROTOCOL_VERSION,
            "client": {"app": "tf-hostd-e2e", "version": "0", "platform": "linux", "device": name, "features": features},
            "herdrSession": a.session,
        }));
        c.wait("welcome", 60, |m| m["t"] == "welcome");
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

    fn recv(&mut self, max: Duration) -> Option<Value> {
        if self.last_sent.elapsed() > Duration::from_secs(15) {
            self.send(json!({"t": "ping", "ts": now_ms()}));
        }
        let m = self.rx.recv_timeout(max.min(Duration::from_secs(1))).ok()?;
        match m["t"].as_str() {
            Some("snapshot") => self.state = m["state"].clone(),
            Some("patch") => {
                for op in m["ops"].as_array().into_iter().flatten() {
                    match op["op"].as_str() {
                        Some("info") => self.state["info"] = op["info"].clone(),
                        Some("agent") => {
                            let arr = self.state["agents"].as_array_mut().expect("agents");
                            arr.retain(|e| e["id"] != op["id"]);
                            if !op["value"].is_null() {
                                arr.push(op["value"].clone());
                            }
                        }
                        _ => {}
                    }
                }
            }
            Some("notify") => self.notes.push(m["notification"].clone()),
            Some("notifyDone") => self.done.push(m.clone()),
            _ => {}
        }
        Some(m)
    }

    fn wait(&mut self, what: &str, secs: u64, pred: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + Duration::from_secs(secs);
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            if let Some(m) = self.recv(left)
                && pred(&m)
            {
                return m;
            }
        }
        panic!("[{}] timed out after {secs}s waiting for {what}", self.name)
    }

    fn wait_agent(&mut self, what: &str, id: &str, secs: u64, pred: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + Duration::from_secs(secs);
        loop {
            let a = self.agent(id);
            if pred(&a) {
                return a;
            }
            let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                panic!("[{}] timed out after {secs}s waiting for {id}: {what}\n{}", self.name, self.agent(id));
            };
            self.recv(left);
        }
    }

    /// Reads on until `done` holds for what this client has seen.
    fn until(&mut self, what: &str, secs: u64, done: impl Fn(&Client) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(secs);
        while !done(self) {
            let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                panic!("[{}] timed out after {secs}s waiting for {what}\ndecisions: {}", self.name, self.state["info"]["decisions"]);
            };
            self.recv(left);
        }
    }

    /// The review item (`HostInfo.decisions`) of an answer decide for me sent to `agent_id`.
    fn decision(&self, agent_id: &str) -> Option<Value> {
        self.state["info"]["decisions"].as_array().and_then(|a| a.iter().find(|d| d["agentId"] == agent_id).cloned())
    }

    /// A `notifyDone` named this notification.
    fn retracted(&self, notification_id: &Value) -> bool {
        self.done.iter().any(|m| m["ids"].as_array().is_some_and(|ids| ids.contains(notification_id)))
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({"t": "req", "id": id, "method": method, "params": params}));
        let res = self.wait(method, 180, |m| m["t"] == "res" && m["id"] == id);
        if res["error"].is_null() { Ok(res["result"].clone()) } else { Err(res["error"].clone()) }
    }

    fn agent(&self, id: &str) -> Value {
        self.state["agents"].as_array().and_then(|a| a.iter().find(|x| x["id"] == id).cloned()).unwrap_or(Value::Null)
    }

    fn drain(&mut self, d: Duration) {
        let deadline = Instant::now() + d;
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            self.recv(left);
        }
    }

    fn close(mut self) {
        self.send(json!({"t": "bye"}));
        let _ = self.child.wait();
    }
}

/// The agent's pending ask and its countdown (`None` while nothing is pending).
fn countdown(a: &Value) -> Option<Value> {
    let cd = &a["autoAnswer"]["countdown"];
    (a["needs"]["kind"] == "ask" && !cd.is_null() && cd["requestId"] == a["needs"]["requestId"]).then(|| cd.clone())
}

fn star(a: &Value) -> String {
    let opts = a["needs"]["options"].as_array().cloned().unwrap_or_default();
    opts.iter().map(|o| format!("{}{}", if o["recommended"] == true { "★ " } else { "" }, o["label"].as_str().unwrap_or(""))).collect::<Vec<_>>().join(" | ")
}

fn start(c: &mut Client, a: &Args, tag: &str, policy: Option<Value>) -> String {
    let mut spec = json!({"kind": "omp", "model": a.model, "plan": false, "prompt": format!("AUTOANSWER-LAB q=Which database should lab agent {tag} use?")});
    if let Some(p) = policy {
        spec["autoAnswer"] = p;
    }
    let cwd = format!("{}/{tag}", a.work);
    std::fs::create_dir_all(&cwd).unwrap();
    let started = c.call("agent.start", json!({"target": {"kind": "cwd", "cwd": cwd, "label": format!("aa-{tag}")}, "spec": spec})).expect("agent.start");
    let id = started["agentId"].as_str().expect("agent id").to_string();
    let ag = c.wait_agent("its question", &id, 180, |x| countdown(x).is_some() || (x["needs"]["kind"] == "ask" && x["autoAnswer"].is_null()));
    println!("  {tag} ({id}): asks {:?} [{}] → {}", ag["needs"]["question"], star(&ag), ag["autoAnswer"]);
    id
}

/// The transcript's ask result and the agent's last reply.
fn outcome(c: &mut Client, id: &str) -> (String, String) {
    let snap = c.call("session.open", json!({"agentId": id})).expect("session.open");
    let items = snap["items"].as_array().cloned().unwrap_or_default();
    // The ask row as a whole: omp's result text ("User selected: …") is in its output or view.
    let ask = items.iter().rev().find(|i| i["kind"] == "tool" && i["tool"] == "ask").map(|i| i.to_string()).unwrap_or_default();
    let last = items.iter().rev().find(|i| i["kind"] == "assistant").map(|i| i["text"].as_str().unwrap_or("").to_string()).unwrap_or_default();
    let _ = c.call("session.close", json!({"agentId": id}));
    (ask, last)
}

fn activity(c: &mut Client, id: &str) -> Vec<String> {
    let act = c.call("host.activity", json!({"limit": 50, "agentId": id})).expect("activity");
    act["events"].as_array().into_iter().flatten().map(|e| format!("{} {} — {}", e["kind"].as_str().unwrap_or(""), e["title"].as_str().unwrap_or(""), e["detail"].as_str().unwrap_or(""))).collect()
}

fn auto_answered(c: &mut Client, id: &str) -> Option<String> {
    activity(c, id).into_iter().find(|l| l.starts_with("answered Auto-answered"))
}

/// The id of `agent_id`'s unreviewed review item as `auto-answer.json` keeps it.
fn saved_decision_id(file: &str, agent_id: &str) -> Option<String> {
    let v: Value = serde_json::from_str(file).ok()?;
    v["sessions"]
        .as_object()?
        .values()
        .flat_map(|s| s["decisions"].as_array().cloned().unwrap_or_default())
        .find(|d| d["agentId"] == agent_id && d["reviewedAt"].is_null())
        .and_then(|d| d["id"].as_str().map(str::to_string))
}

fn main() {
    let a = args();
    let home = std::env::var("TF_HOSTD_HOME").expect("set TF_HOSTD_HOME (lab home)");
    assert!(home.starts_with("/tmp/"), "lab homes live in /tmp (never the real ~/.teleflock)");
    assert!(std::env::var("PI_CODING_AGENT_DIR").is_ok_and(|d| d.starts_with("/tmp/")), "set PI_CODING_AGENT_DIR to the lab's omp agent dir");
    assert!(std::env::var("HERDR_SOCKET_PATH").is_err(), "unset the herdr env of the calling pane (HERDR_*)");
    std::fs::create_dir_all(format!("{home}/ext")).unwrap();
    std::fs::write(
        format!("{home}/omp-overlay.yml"),
        format!("collab:\n  autoStart: control\n  relayUrl: ws://127.0.0.1:{}\n  displayName: {}\n", a.relay_port, a.session),
    )
    .unwrap();
    std::fs::copy(&a.ext, format!("{home}/ext/teleflock-bridge.ts")).expect("deploy extension");
    let work = Path::new(&a.work);
    assert!(work.is_absolute() && work.starts_with("/tmp") && work.components().count() > 2, "--work must be a folder inside /tmp");
    let _ = std::fs::remove_dir_all(work);
    std::fs::create_dir_all(work).unwrap();
    let one_min = |only: bool| json!({"enabled": true, "afterSecs": 60, "onlyWhenNoApp": only});

    println!("== 1. questions while an app is connected");
    let mut c = Client::attach("desktop", &a);
    println!("  host default: {}", c.state["info"]["autoAnswer"]);
    assert!(c.state["info"]["autoAnswer"].is_object(), "HostInfo.autoAnswer present");
    c.call("host.autoAnswerSet", json!({"enabled": false, "afterSecs": 1200, "onlyWhenNoApp": false})).expect("host default off");
    let only = start(&mut c, &a, "only", Some(one_min(true)));
    let cancelled = start(&mut c, &a, "cancelled", Some(one_min(true)));
    let always = start(&mut c, &a, "always", Some(one_min(false)));
    for id in [&only, &cancelled] {
        let cd = countdown(&c.agent(id)).expect("countdown");
        assert_eq!((cd["status"].as_str(), cd["remainingMs"].as_i64()), (Some("waitingForNoApp"), Some(60_000)), "{id}: {cd}");
    }
    let cd = countdown(&c.agent(&always)).expect("countdown");
    assert_eq!(cd["status"], "counting");
    let always_deadline = cd["deadline"].as_i64().unwrap();
    println!("  always: counting, deadline in {:.1} s", (always_deadline - now_ms()) as f64 / 1000.0);
    let note = c.notes.iter().find(|n| n["agentId"] == only.as_str() && n["kind"] == "needs").cloned().unwrap_or(Value::Null);
    println!("  needs notification ({only}): {:?}", note["body"]);
    assert!(note["body"].as_str().unwrap_or("").contains("Decide for me picks ★ Use SQLite after 1 min with no app connected."));
    let note = c.notes.iter().find(|n| n["agentId"] == always.as_str() && n["kind"] == "needs").cloned().unwrap_or(Value::Null);
    println!("  needs notification ({always}): {:?}", note["body"]);

    // Cancel `cancelled`; postpone then cancel shows the remaining time moving as asked.
    let rid = c.agent(&cancelled)["needs"]["requestId"].clone();
    c.call("agent.autoAnswerPostpone", json!({"agentId": cancelled, "requestId": rid, "secs": 600})).expect("postpone");
    c.wait_agent("postponed", &cancelled, 10, |x| countdown(x).is_some_and(|cd| cd["remainingMs"] == 660_000));
    c.call("agent.autoAnswerCancel", json!({"agentId": cancelled, "requestId": rid})).expect("cancel");
    let cd = countdown(&c.wait_agent("cancelled", &cancelled, 10, |x| countdown(x).is_some_and(|cd| cd["status"] == "cancelled"))).unwrap();
    println!("  cancelled: {cd}");
    let err = c.call("agent.autoAnswerCancel", json!({"agentId": cancelled, "requestId": "nope"})).expect_err("unknown request");
    assert_eq!(err["code"], "not_found");

    // `always` is answered at its deadline, with the app connected.
    let ag = c.wait_agent("always answered", &always, 120, |x| x["needs"].is_null());
    let late = now_ms() - always_deadline;
    println!("  always answered {late} ms after its deadline (60 s after its question), with the app connected; column={}", ag["column"]);
    assert!((-1_000..10_000).contains(&late));
    c.drain(Duration::from_secs(2));
    let n = c.notes.iter().rev().find(|n| n["agentId"] == always.as_str() && n["kind"] == "info").cloned().expect("decided-for-you notification");
    println!("  notification: {:?} / {:?} actions={}", n["title"], n["body"], n["actions"]);
    assert_eq!(n["actions"][0]["id"], "open:decisions", "opening it leads to its decision in the Inbox");
    // The answer is a review item at once (published before its notification went out).
    let d = c.decision(&always).expect("a review item for always's answer");
    println!("  review item: {d}");
    let picked: Vec<&str> = d["options"].as_array().into_iter().flatten().filter(|o| o["picked"] == true).filter_map(|o| o["label"].as_str()).collect();
    assert_eq!(picked, ["Use SQLite"]);
    assert!(d["options"].as_array().is_some_and(|o| o.len() >= 2), "every option of the question");
    assert_eq!((d["source"].as_str(), d["waitedMs"].as_i64(), d["earlier"].as_bool()), (Some("agent"), Some(60_000), Some(false)));
    assert!(d["question"].as_str().unwrap_or("").contains("lab agent always") && d["agentName"].is_string() && d["sessionFile"].is_string());
    assert_eq!(d["notificationId"], n["id"]);
    let act = auto_answered(&mut c, &always);
    println!("  activity: {act:?}");
    assert!(act.is_some_and(|l| l.contains("★ Use SQLite")));
    c.wait_agent("always's turn ends", &always, 60, |x| x["column"] == "review");
    let (ask, last) = outcome(&mut c, &always);
    println!("  always transcript: ask → {ask:?}; reply → {last:?}");
    assert!(ask.contains("User selected: Use SQLite") && last.contains("User selected: Use SQLite"));

    // Stay connected past `only`'s wait: it must still stand still.
    let waited = Instant::now();
    c.drain(Duration::from_secs(70));
    let cd = countdown(&c.agent(&only)).expect("only still waiting");
    println!("  after {:.0} s more with the app connected, only: {cd}", waited.elapsed().as_secs_f64());
    assert_eq!((cd["status"].as_str(), cd["remainingMs"].as_i64()), (Some("waitingForNoApp"), Some(60_000)));
    c.close();

    println!("== 2. no app connected");
    let gone = Instant::now();
    std::thread::sleep(Duration::from_secs(25));
    // An app that drops by stops the clock while it is connected. Its snapshot is the board as it
    // stood (the clock running); the stop follows as a patch.
    let mut c = Client::attach("phone", &a);
    let ag = c.wait_agent("the clock stops for the app", &only, 10, |x| countdown(x).is_some_and(|cd| cd["status"] == "waitingForNoApp"));
    let cd = countdown(&ag).expect("only pending");
    println!("  an app drops by after {:.0} s: only = {cd}", gone.elapsed().as_secs_f64());
    let left = cd["remainingMs"].as_i64().unwrap_or(0);
    assert!(cd["status"] == "waitingForNoApp" && (25_000..=40_000).contains(&left), "about 25 s counted: {cd}");
    c.drain(Duration::from_secs(5));
    let cd2 = countdown(&c.agent(&only)).unwrap();
    assert_eq!(cd2["remainingMs"], cd["remainingMs"], "stands still while the app is connected");
    c.close();
    let back = Instant::now();
    std::thread::sleep(Duration::from_millis(left as u64 + 15_000));
    let mut c = Client::attach_with("desktop-again", &a, &["presence"]);
    // Decided while no app was connected: in the snapshot of the app that connects afterwards.
    let d_only = c.decision(&only).expect("only's review item in the snapshot of an app that connects afterwards");
    println!("  snapshot of the app that connected afterwards: {} review item(s), only's = {}", c.state["info"]["decisions"].as_array().map_or(0, Vec::len), d_only["id"]);
    assert!(c.decision(&always).is_some(), "always's is still unreviewed");
    let ag = c.agent(&only);
    let act = auto_answered(&mut c, &only);
    println!("  {:.0} s after the app left again: only needs={} activity={act:?}", back.elapsed().as_secs_f64(), ag["needs"]["kind"]);
    assert!(ag["needs"].is_null() && act.is_some(), "only was answered with no app connected");
    // Reviewed on this app: gone for a second app at once, and its notification retracted there.
    let mut phone = Client::attach_with("phone-2", &a, &["presence"]);
    assert!(phone.decision(&only).is_some());
    let r = c.call("host.autoAnswerReview", json!({"ids": [d_only["id"]]})).expect("review");
    assert_eq!(r["reviewed"], json!([d_only["id"]]));
    let note = d_only["notificationId"].clone();
    phone.until("the review on the other app", 10, |p| p.decision(&only).is_none() && p.retracted(&note));
    c.until("the review on this app", 10, |c| c.decision(&only).is_none());
    println!("  reviewed on desktop-again: gone on phone-2 (notifyDone {:?}), always's still listed: {}", phone.done.last().map(|m| m.to_string()), phone.decision(&always).is_some());
    assert!(phone.decision(&always).is_some());
    let again = phone.call("host.autoAnswerReview", json!({"ids": [d_only["id"]]})).expect("review again");
    assert_eq!(again["reviewed"], json!([]), "reviewed once is enough");
    phone.close();
    c.wait_agent("only's turn ends", &only, 60, |x| x["column"] == "review");
    let (ask, last) = outcome(&mut c, &only);
    println!("  only transcript: ask → {ask:?}; reply → {last:?}");
    assert!(ask.contains("User selected: Use SQLite"));
    let cd = countdown(&c.agent(&cancelled)).expect("cancelled still pending");
    println!("  cancelled after the same time: needs={} countdown={cd}", c.agent(&cancelled)["needs"]["kind"]);
    assert!(cd["status"] == "cancelled" && auto_answered(&mut c, &cancelled).is_none());

    println!("== 3. host default survives a daemon restart");
    c.call("host.autoAnswerSet", json!({"enabled": true, "afterSecs": 120, "onlyWhenNoApp": false})).expect("host default on");
    let restart = start(&mut c, &a, "restart", None);
    let ag = c.agent(&restart);
    let cd = countdown(&ag).expect("host default countdown");
    assert_eq!((ag["autoAnswer"]["source"].as_str(), cd["status"].as_str()), (Some("host"), Some("counting")));
    let deadline = cd["deadline"].as_i64().unwrap();
    println!("  restart: source=host deadline in {:.1} s", (deadline - now_ms()) as f64 / 1000.0);
    // The cancelled question now falls under no own policy change: still cancelled.
    c.close();
    let out = Command::new(&a.hostd).arg("stop").output().expect("tf-hostd stop");
    println!("  [stop] {}", String::from_utf8_lossy(&out.stdout).trim());
    std::thread::sleep(Duration::from_secs(3));
    let file = std::fs::read_to_string(format!("{home}/auto-answer.json")).expect("auto-answer.json");
    let always_id = saved_decision_id(&file, &always);
    println!("  auto-answer.json after stop: {} bytes, holds restart's countdown: {}, always's review item: {}", file.len(), file.contains(&restart), always_id.is_some());
    let mut c = Client::attach("after-restart", &a);
    // Unreviewed, it survived the restart; reviewed, only's stays reviewed.
    let d = c.decision(&always).expect("always's review item after the restart");
    assert_eq!(Some(d["id"].as_str().unwrap_or("")), always_id.as_deref());
    assert!(c.decision(&only).is_none());
    println!("  after the restart: always's review item is in the snapshot ({})", d["id"]);
    let ag = c.wait_agent("question back after the restart", &restart, 90, |x| countdown(x).is_some());
    let cd = countdown(&ag).unwrap();
    println!("  after restart: {cd} (deadline moved {} ms)", cd["deadline"].as_i64().unwrap_or(0) - deadline);
    assert_eq!(cd["deadline"].as_i64(), Some(deadline), "the countdown kept its deadline");
    c.wait_agent("restart answered", &restart, 150, |x| x["needs"].is_null());
    let late = now_ms() - deadline;
    println!("  answered {late} ms after the deadline set before the restart; activity: {:?}", auto_answered(&mut c, &restart));
    assert!((-1_000..15_000).contains(&late));
    c.until("restart's review item", 10, |c| c.decision(&restart).is_some());
    let d_restart = c.decision(&restart).unwrap();
    assert_eq!(d_restart["source"], "host");
    // Mark all reviewed.
    let r = c.call("host.autoAnswerReview", json!({"all": true})).expect("review all");
    println!("  mark all reviewed: {}", r["reviewed"]);
    let reviewed = r["reviewed"].as_array().cloned().unwrap_or_default();
    assert!(reviewed.contains(&d["id"]) && reviewed.contains(&d_restart["id"]), "always's and restart's");
    c.until("an empty review list", 10, |c| c.state["info"]["decisions"].as_array().is_none_or(Vec::is_empty));
    c.call("host.autoAnswerSet", json!({"enabled": false, "afterSecs": 120, "onlyWhenNoApp": false})).expect("host default off");
    for id in [&only, &cancelled, &always, &restart] {
        let _ = c.call("agent.stop", json!({"agentId": id, "mode": "closePane"}));
    }
    c.close();
    println!("== e2e_autoanswer OK");
}
