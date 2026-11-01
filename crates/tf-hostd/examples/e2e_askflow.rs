//! Lab end-to-end run of an ask's explanation and Back between its questions (architecture §3.5
//! "Needs-you"): speaks the client protocol through `tf-hostd attach` against a real herdr lab
//! session and real omp with TeleFlock's bridge, whose model is a local mock
//! (`e2e_askflow_mock.ts`, next to this file) that explains and then calls omp's `ask` tool with
//! three questions (a single choice, a multi-select, a single choice).
//!
//! Run it in a lab (AGENTS.md); it writes the lab's omp settings (every role on the mock) itself:
//!
//! ```sh
//! cargo build -p tf-hostd --bin tf-hostd --example e2e_askflow
//! scripts/lab/run askflow -- bun crates/tf-hostd/examples/e2e_askflow_mock.ts &
//! scripts/lab/run askflow -- target/debug/examples/e2e_askflow --hostd target/debug/tf-hostd \
//!   --session tf-lab-askflow --relay-port 47612 --work /tmp/tf-lab-askflow/work
//! scripts/lab/stop askflow --purge
//! ```
//!
//! Steps: the agent asks → its board card and its session's dialog carry the explanation and
//! question 1 of 3 → Postgres → Auth + Search → Back from question 3: question 2 comes back with
//! its ticks → Back: question 1 comes back on Postgres → SQLite → Search alone → a typed answer
//! for question 3 → omp's ask result, which the agent echoes, holds the final answers. Every question,
//! Back included, keeps the waiting time of the first (`needs.since`). `--keep`
//! leaves the agent waiting on its first question (for a look in the app) instead.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

/// What the mock agent writes before asking (`e2e_askflow_mock.ts`).
const EXPLANATION: &str = "I compared the two stores for the **lab app**:\n\n- *SQLite* keeps everything in one file and needs nothing running.\n- *Postgres* scales further, but needs a server.\n\nThree things decide the setup, so I am asking them together.";

struct Args {
    hostd: String,
    session: String,
    relay_port: u16,
    work: String,
    mock_port: u16,
    ext: String,
    keep: bool,
}

fn args() -> Args {
    let mut a = Args {
        hostd: "target/debug/tf-hostd".into(),
        session: "tf-lab-askflow".into(),
        relay_port: 47612,
        work: "/tmp/tf-lab-askflow/work".into(),
        mock_port: 18759,
        ext: "host/teleflock-bridge/teleflock-bridge.ts".into(),
        keep: false,
    };
    let mut it = std::env::args().skip(1);
    while let Some(k) = it.next() {
        let mut v = || it.next().expect("missing value");
        match k.as_str() {
            "--hostd" => a.hostd = v(),
            "--session" => a.session = v(),
            "--relay-port" => a.relay_port = v().parse().expect("port"),
            "--work" => a.work = v(),
            "--mock-port" => a.mock_port = v().parse().expect("port"),
            "--ext" => a.ext = v(),
            "--keep" => a.keep = true,
            other => panic!("unknown arg {other}"),
        }
    }
    a
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

struct Client {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<Value>,
    next_id: u64,
    state: Value,
    last_sent: Instant,
}

impl Client {
    fn attach(a: &Args) -> Client {
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
        let mut c = Client { child, stdin, rx, next_id: 1, state: Value::Null, last_sent: Instant::now() };
        c.send(json!({
            "t": "hello", "protocol": tf_proto::PROTOCOL_VERSION,
            "client": {"app": "tf-hostd-e2e", "version": "0", "platform": "linux", "device": "askflow"},
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
                    if op["op"] == "agent" {
                        let arr = self.state["agents"].as_array_mut().expect("agents");
                        arr.retain(|e| e["id"] != op["id"]);
                        if !op["value"].is_null() {
                            arr.push(op["value"].clone());
                        }
                    }
                }
            }
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
        panic!("timed out after {secs}s waiting for {what}")
    }

    fn wait_agent(&mut self, what: &str, id: &str, secs: u64, pred: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + Duration::from_secs(secs);
        loop {
            let a = self.agent(id);
            if pred(&a) {
                return a;
            }
            let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                panic!("timed out after {secs}s waiting for {id}: {what}\n{a}");
            };
            self.recv(left);
        }
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

    fn close(mut self) {
        self.send(json!({"t": "bye"}));
        let _ = self.child.wait();
    }
}

/// Waits for the agent's question `index` (0-based), a request other than `after`.
fn question(c: &mut Client, id: &str, index: u64, after: &str) -> Value {
    let needs = c.wait_agent(&format!("question {}", index + 1), id, 120, |x| {
        x["needs"]["kind"] == "ask" && x["needs"]["step"]["index"] == index && x["needs"]["requestId"] != after
    })["needs"]
        .clone();
    println!(
        "  question {} of {}: {:?} (request {}, back: {}, has: {} {})",
        index + 1,
        needs["step"]["total"],
        needs["question"].as_str().unwrap_or(""),
        needs["requestId"].as_str().unwrap_or(""),
        needs["step"]["canBack"],
        needs["step"]["choices"],
        needs["step"]["text"],
    );
    assert_eq!(needs["context"], EXPLANATION, "every question carries the explanation");
    assert_eq!((needs["step"]["total"].as_u64(), needs["step"]["canBack"].as_bool()), (Some(3), Some(index > 0)));
    needs
}

/// `needs` waits since `since`: the time the ask's first question came.
fn same_wait(needs: Value, since: &Value) -> Value {
    assert_eq!(&needs["since"], since, "every question of the ask waits since its first");
    needs
}

fn answer(c: &mut Client, id: &str, needs: &Value, answer: Value) -> String {
    let request = needs["requestId"].as_str().expect("request id").to_string();
    let mut full = json!({"choices": [], "cancel": false, "chat": false});
    for (k, v) in answer.as_object().unwrap() {
        full[k] = v.clone();
    }
    c.call("agent.answer", json!({"agentId": id, "requestId": request, "answer": full})).unwrap_or_else(|e| panic!("agent.answer {answer}: {e}"));
    println!("    answered {answer}");
    request
}

fn main() {
    let a = args();
    let home = std::env::var("TF_HOSTD_HOME").expect("set TF_HOSTD_HOME (lab home)");
    assert!(home.starts_with("/tmp/"), "lab homes live in /tmp (never the real ~/.teleflock)");
    let agent_dir = std::env::var("PI_CODING_AGENT_DIR").expect("set PI_CODING_AGENT_DIR to the lab's omp agent dir");
    assert!(agent_dir.starts_with("/tmp/"), "the lab's omp agent dir lives in /tmp");
    assert!(std::env::var("HERDR_SOCKET_PATH").is_err(), "unset the herdr env of the calling pane (HERDR_*)");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let models = format!(
        "providers:\n  mock:\n    baseUrl: http://127.0.0.1:{}/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: lab-1\n        name: AskFlow Lab Mock\n        reasoning: false\n        input: [text]\n        contextWindow: 1000000\n        maxTokens: 32768\n        cost: {{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }}\n",
        a.mock_port
    );
    std::fs::write(format!("{agent_dir}/models.yml"), models).unwrap();
    let roles = ["default", "smol", "slow", "vision", "plan", "commit", "tiny", "memory", "task", "advisor", "widget", "judge"];
    let config = format!(
        "modelRoles:\n{}disabledProviders: [ollama, lm-studio, llama.cpp, apple, web]\ntools:\n  approvalMode: yolo\nsetupVersion: 2\nstartup:\n  setupWizard: false\n  checkUpdate: false\n  changelogMode: hidden\ndev:\n  autoqaConsent: denied\n",
        roles.iter().map(|r| format!("  {r}: mock/lab-1\n")).collect::<String>()
    );
    std::fs::write(format!("{agent_dir}/config.yml"), config).unwrap();
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

    println!("== 1. the agent explains, then asks three questions");
    let mut c = Client::attach(&a);
    let spec = json!({"kind": "omp", "model": "mock/lab-1", "plan": false, "prompt": "ASKFLOW-LAB: set up the lab app"});
    let started = c.call("agent.start", json!({"target": {"kind": "cwd", "cwd": a.work, "label": "askflow"}, "spec": spec})).expect("agent.start");
    let id = started["agentId"].as_str().expect("agent id").to_string();
    let q1 = question(&mut c, &id, 0, "");
    // One ask is one wait: every question (Back included) keeps the time the first came.
    let asked = q1["since"].clone();
    assert_eq!(q1["step"]["choices"], Value::Null, "nothing answered yet");
    let snap = c.call("session.open", json!({"agentId": id})).expect("session.open");
    let ui = &snap["ui"];
    println!("  session dialog: {:?}, step {}, context {} bytes", ui["title"].as_str().unwrap_or(""), ui["step"], ui["context"].as_str().map_or(0, str::len));
    assert_eq!((&ui["id"], &ui["context"], &ui["step"]), (&q1["requestId"], &json!(EXPLANATION), &q1["step"]), "the session's dialog matches the board");
    let _ = c.call("session.close", json!({"agentId": id}));
    if a.keep {
        println!("== --keep: the agent waits on its first question");
        c.close();
        return;
    }

    println!("== 2. forward, Back twice, forward with other answers");
    let r1 = answer(&mut c, &id, &q1, json!({"choices": ["Postgres"]}));
    let q2 = same_wait(question(&mut c, &id, 1, &r1), &asked);
    assert_eq!(q2["multi"], true);
    let r2 = answer(&mut c, &id, &q2, json!({"choices": ["Auth", "Search"]}));
    let q3 = same_wait(question(&mut c, &id, 2, &r2), &asked);
    let r3 = answer(&mut c, &id, &q3, json!({"back": true}));
    let q2 = same_wait(question(&mut c, &id, 1, &r3), &asked);
    assert_eq!(q2["step"]["choices"], json!(["Auth", "Search"]), "question 2 comes back with its ticks");
    let r2 = answer(&mut c, &id, &q2, json!({"back": true}));
    let q1 = same_wait(question(&mut c, &id, 0, &r2), &asked);
    assert_eq!(q1["step"]["choices"], json!(["Postgres"]), "question 1 comes back on its answer");
    let err = c.call("agent.answer", json!({"agentId": id, "requestId": q1["requestId"], "answer": {"choices": [], "cancel": false, "chat": false, "back": true}})).expect_err("no Back on question 1");
    println!("  Back on question 1: {}", err["code"]);
    assert_eq!(err["code"], "invalid_params");
    let r1 = answer(&mut c, &id, &q1, json!({"choices": ["SQLite"]}));
    let q2 = same_wait(question(&mut c, &id, 1, &r1), &asked);
    assert_eq!(q2["step"]["choices"], json!(["Auth", "Search"]));
    let r2 = answer(&mut c, &id, &q2, json!({"choices": ["Search"]}));
    let q3 = same_wait(question(&mut c, &id, 2, &r2), &asked);
    answer(&mut c, &id, &q3, json!({"text": "Fly.io, region fra"}));

    println!("== 3. the agent gets the final answers");
    // omp's ask result is what the model gets next.
    let mut ask = Value::Null;
    let deadline = Instant::now() + Duration::from_secs(120);
    while ask["status"] != "ok" {
        assert!(Instant::now() < deadline, "timed out waiting for the ask's result: {ask}");
        std::thread::sleep(Duration::from_millis(500));
        let snap = c.call("session.open", json!({"agentId": id})).expect("session.open");
        let items = snap["items"].as_array().cloned().unwrap_or_default();
        ask = items.iter().rev().find(|i| i["kind"] == "tool" && i["tool"] == "ask").cloned().unwrap_or(Value::Null);
        let _ = c.call("session.close", json!({"agentId": id}));
    }
    println!("  ask row: status {} output {:?}", ask["status"], ask["output"]);
    assert_eq!(ask["output"], "User answers:\nstore: SQLite\nfeatures: [Search]\ndeploy: \"Fly.io, region fra\"", "the agent got the final answers");
    let done = c.wait_agent("the turn ends", &id, 120, |x| x["needs"].is_null() && x["column"] == "review");
    println!("  turn ended: column {}", done["column"]);
    c.close();
    println!("== ok");
}
