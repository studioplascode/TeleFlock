//! Lab end-to-end run of the done-agent lifecycle (architecture §3.5): speaks the client
//! protocol through `tf-hostd attach` against a real herdr lab session and real omp.
//!
//! ```sh
//! TF_HOSTD_HOME=/tmp/tf-lab-x cargo run -p tf-hostd --example e2e_parked -- \
//!   --hostd target/debug/tf-hostd --session tf-lab-x --relay-port 47608 --work /tmp/tf-lab-x-work
//! ```
//!
//! Steps: agent in a linked git worktree → Mark done with close + Undo keeps the pane → Mark
//! done with close parks it (workspace closed, parked card, read-only transcript, controls say
//! `parked`) → `agent.resume` (`omp --resume`, worktree reopened, card swapped in one patch) →
//! prompting a parked agent resumes it and delivers the prompt → daemon restart keeps the parked
//! card → deleting the session files prunes the parked agent and an archived live one.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

struct Args {
    hostd: String,
    session: String,
    relay_port: u16,
    work: String,
    model: String,
    ext: Option<String>,
}

fn args() -> Args {
    let mut a = Args {
        hostd: "target/debug/tf-hostd".into(),
        session: "tf-lab-lifecycle".into(),
        relay_port: 47608,
        work: "/tmp/tf-lab-lifecycle-work".into(),
        model: "openai-codex/gpt-6-luna".into(),
        ext: Some("host/teleflock-bridge/teleflock-bridge.ts".into()).filter(|p| Path::new(p).is_file()),
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
        c.wait("welcome", 30, |m| m["t"] == "welcome");
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
        panic!("[{}] timed out after {secs}s waiting for state: {what}\nagents: {}", self.name, self.state["agents"]);
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

fn has(s: &Value, id: &str, pred: impl Fn(&Value) -> bool) -> bool {
    s["agents"].as_array().into_iter().flatten().any(|x| x["id"] == id && pred(x))
}

fn short(v: &Value, n: usize) -> String {
    let s = v.to_string();
    if s.len() > n { format!("{}…", &s[..s.char_indices().nth(n).map_or(s.len(), |(i, _)| i)]) } else { s }
}

fn sh(dir: &str, args: &[&str]) {
    let st = Command::new(args[0]).args(&args[1..]).current_dir(dir).status().expect("spawn");
    assert!(st.success(), "{args:?} failed");
}

/// Command line of the omp process running `--resume=<file>` (evidence of the relaunch).
fn resume_cmdline(file: &str) -> Option<String> {
    let out = Command::new("ps").args(["-eo", "args"]).output().ok()?;
    String::from_utf8_lossy(&out.stdout).lines().find(|l| l.contains(&format!("--resume={file}"))).map(str::to_string)
}

/// Starts an omp agent, waits until it is linked and has finished one prompt.
fn start_and_prompt(c: &mut Client, a: &Args, cwd: &str, text: &str) -> String {
    let started = c
        .call("agent.start", json!({"target": {"kind": "cwd", "cwd": cwd}, "spec": {"kind": "omp", "model": a.model, "thinking": "low", "plan": false}}))
        .expect("agent.start");
    let id = started["agentId"].as_str().expect("agent id").to_string();
    c.wait_state("agent linked", 90, |s| has(s, &id, |x| x["omp"]["link"] == "live" && x["state"] == "idle"));
    c.call("agent.prompt", json!({"agentId": id, "text": text, "images": [], "delivery": "auto"})).expect("prompt");
    c.wait_state("turn started", 60, |s| has(s, &id, |x| x["state"] == "working"));
    c.wait_state("turn finished", 180, |s| has(s, &id, |x| x["column"] == "review"));
    c.wait_state("session file known", 30, |s| has(s, &id, |x| x["omp"]["sessionFile"].is_string()));
    id
}

/// Mark done with close; waits until the card is parked.
fn park(c: &mut Client, id: &str) -> Value {
    let ws = c.agent(id)["workspaceId"].clone();
    c.call("agent.archive", json!({"agentId": id, "archived": true, "close": true})).expect("archive close");
    c.drain(5_000);
    let mid = c.agent(id);
    println!("  +5 s (undo window): column={} paneId={} parked={}", mid["column"], mid["paneId"], mid["parked"]);
    assert!(mid["parked"].is_null() && mid["paneId"] != "", "closed inside the undo window");
    c.wait_state("parked", 30, |s| has(s, id, |x| x["parked"].is_object()));
    let card = c.agent(id);
    println!(
        "  parked card: column={} archived={} state={} paneId={:?} link={} parked={} title={}",
        card["column"], card["archived"], card["state"], card["paneId"], card["omp"]["link"], card["parked"], short(&card["title"], 60)
    );
    assert_eq!((card["column"].as_str(), card["archived"].as_bool(), card["paneId"].as_str()), (Some("done"), Some(true), Some("")));
    c.drain(1_000);
    let ws_open = c.state["workspaces"].as_array().into_iter().flatten().any(|w| w["id"] == ws);
    println!("  its workspace {ws} still open: {ws_open}");
    card
}

/// Waits for the patch that drops `old` and returns the new agent id it brought along.
fn wait_swap(c: &mut Client, mark: usize, old: &str, new: &str) {
    c.wait_state("swap", 90, |s| has(s, new, |_| true) && !has(s, old, |_| true));
    let same_patch = c.log[mark..].iter().any(|m| {
        let ops = m["ops"].as_array().cloned().unwrap_or_default();
        ops.iter().any(|o| o["op"] == "agent" && o["id"] == old && o["value"].is_null())
            && ops.iter().any(|o| o["op"] == "agent" && o["id"] == new && o["value"].is_object())
    });
    println!("  parked {old} → live {new}: swapped in one patch: {same_patch}");
}

fn main() {
    let a = args();
    let home = std::env::var("TF_HOSTD_HOME").expect("set TF_HOSTD_HOME (lab home)");
    assert!(home.starts_with("/tmp/"), "lab homes live in /tmp (never the real ~/.teleflock)");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(
        format!("{home}/omp-overlay.yml"),
        format!("collab:\n  autoStart: control\n  relayUrl: ws://127.0.0.1:{}\n  displayName: {}\n", a.relay_port, a.session),
    )
    .unwrap();
    if let Some(src) = &a.ext {
        std::fs::create_dir_all(format!("{home}/ext")).unwrap();
        std::fs::copy(src, format!("{home}/ext/teleflock-bridge.ts")).expect("deploy extension");
    }
    // A repository with a linked worktree (what Dispatch creates). `--work` is wiped first, so
    // it must be a lab folder in /tmp too.
    let work = Path::new(&a.work);
    assert!(
        work.is_absolute() && work.starts_with("/tmp") && work.components().count() > 2 && !a.work.contains(".."),
        "--work must be a folder inside /tmp (it is deleted first): {}",
        a.work
    );
    let _ = std::fs::remove_dir_all(&a.work);
    let repo = format!("{}/repo", a.work);
    let wt = format!("{}/repo-wt", a.work);
    let plain = format!("{}/plain", a.work);
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::create_dir_all(&plain).unwrap();
    sh(&repo, &["git", "init", "-q", "-b", "main"]);
    std::fs::write(format!("{repo}/README.md"), "lab\n").unwrap();
    sh(&repo, &["git", "add", "."]);
    sh(&repo, &["git", "-c", "user.name=lab", "-c", "user.email=lab@x", "commit", "-qm", "init"]);
    sh(&repo, &["git", "worktree", "add", "-q", "-b", "lab-wt", &wt]);

    println!("== 1. agent in a linked worktree (+ an archived agent kept open)");
    let mut c = Client::attach("desktop", &a);
    let id = start_and_prompt(&mut c, &a, &wt, "Reply with just: ok");
    let ag = c.agent(&id);
    let file = ag["omp"]["sessionFile"].as_str().unwrap().to_string();
    println!("  agent {id} name={} ws={} session={file}", ag["name"], ag["workspaceId"]);
    let other = start_and_prompt(&mut c, &a, &plain, "Reply with just: fine");
    let other_file = c.agent(&other)["omp"]["sessionFile"].as_str().unwrap().to_string();
    c.call("agent.archive", json!({"agentId": other, "archived": true})).expect("archive (keep pane)");

    println!("== 2. Mark done + Undo inside the window keeps the pane");
    c.call("agent.archive", json!({"agentId": id, "archived": true, "close": true})).expect("archive close");
    c.drain(2_000);
    c.call("agent.archive", json!({"agentId": id, "archived": false})).expect("undo");
    c.drain(12_000);
    let ag = c.agent(&id);
    println!("  12 s after Undo: column={} paneId={} parked={}", ag["column"], ag["paneId"], ag["parked"]);
    assert!(ag["parked"].is_null() && ag["column"] == "review");

    println!("== 3. Mark done with close → parked");
    let name = c.agent(&id)["name"].clone();
    park(&mut c, &id);
    let snap = c.call("session.open", json!({"agentId": id})).expect("session.open parked");
    let texts: Vec<String> = snap["items"].as_array().into_iter().flatten().filter(|i| i["kind"] == "assistant").map(|i| short(&i["text"], 40)).collect();
    println!("  session.open (read-only): items={} caps.prompt={} caps.abort={} assistant={texts:?}", snap["items"].as_array().map_or(0, |v| v.len()), snap["meta"]["caps"]["prompt"], snap["meta"]["caps"]["abort"]);
    let err = c.call("agent.keys", json!({"agentId": id, "keys": ["enter"]})).expect_err("keys on parked");
    println!("  agent.keys on parked → {}", short(&err, 160));
    assert_eq!(err["code"], "parked");
    let err = c.call("term.open", json!({"target": {"kind": "agent", "agentId": id}, "mode": "observe", "cols": 80, "rows": 24, "takeover": false})).expect_err("term.open on parked");
    println!("  term.open on parked → {}", short(&err, 160));
    let past = c.call("host.sessions", json!({"limit": 20})).expect("host.sessions");
    let row = past["sessions"].as_array().into_iter().flatten().find(|s| s["file"] == file.as_str()).cloned().unwrap_or(Value::Null);
    println!("  host.sessions row: live={} agentId={}", row["live"], row["agentId"]);

    println!("== 4. agent.resume");
    let mark = c.log.len();
    let started = c.call("agent.resume", json!({"agentId": id})).expect("agent.resume");
    println!("  started: {started}");
    let new_id = started["agentId"].as_str().unwrap().to_string();
    wait_swap(&mut c, mark, &id, &new_id);
    c.wait_state("resumed agent linked", 90, |s| has(s, &new_id, |x| x["omp"]["link"] == "live"));
    let ag = c.agent(&new_id);
    let ws = c.state["workspaces"].as_array().into_iter().flatten().find(|w| w["id"] == ag["workspaceId"]).cloned().unwrap_or(Value::Null);
    println!(
        "  resumed: name={} (was {name}) column={} archived={} session={} workspace={} worktree={}",
        ag["name"], ag["column"], ag["archived"], ag["omp"]["sessionFile"], ws["label"], short(&ws["worktree"], 120)
    );
    println!("  process: {}", resume_cmdline(&file).unwrap_or_else(|| "<not found>".into()));
    assert_eq!(ag["column"], "review");
    assert_eq!(ag["omp"]["sessionFile"].as_str(), Some(file.as_str()));
    let again = c.call("agent.resume", json!({"agentId": new_id})).expect_err("resume live");
    println!("  agent.resume on a live agent → {}", short(&again, 120));

    println!("== 5. prompting a parked agent resumes it and delivers the prompt");
    park(&mut c, &new_id);
    let mark = c.log.len();
    c.call("agent.prompt", json!({"agentId": new_id, "text": "Reply with just the word: PARROT", "images": [], "delivery": "auto"}))
        .expect("prompt parked");
    let known = [new_id.clone(), other.clone()];
    let fresh = |s: &Value| s["agents"].as_array().into_iter().flatten().find(|x| !known.iter().any(|k| x["id"] == k.as_str())).cloned();
    c.wait_state("resumed agent", 90, |s| fresh(s).is_some());
    let third_id = fresh(&c.state).unwrap()["id"].as_str().unwrap().to_string();
    wait_swap(&mut c, mark, &new_id, &third_id);
    c.wait_state("prompt turn finished", 180, |s| has(s, &third_id, |x| x["column"] == "review" && x["turns"].as_u64() >= Some(1)));
    let snap = c.call("session.open", json!({"agentId": third_id})).expect("session.open resumed");
    let last = snap["items"].as_array().into_iter().flatten().rev().find(|i| i["kind"] == "assistant").map(|i| short(&i["text"], 80)).unwrap_or_default();
    let users: Vec<String> = snap["items"].as_array().into_iter().flatten().filter(|i| i["kind"] == "user").map(|i| short(&i["text"], 50)).collect();
    println!("  resumed by prompt: user rows={users:?} last assistant={last}");
    assert!(last.contains("PARROT"));

    println!("== 6. daemon restart keeps the parked card");
    park(&mut c, &third_id);
    c.close();
    let out = Command::new(&a.hostd).arg("stop").output().expect("tf-hostd stop");
    println!("  [stop] {}", String::from_utf8_lossy(&out.stderr).trim().replace('\n', " | "));
    let mut c = Client::attach("desktop-again", &a);
    let card = c.agent(&third_id);
    println!("  after restart: parked={} column={} title={}", card["parked"], card["column"], short(&card["title"], 60));
    assert!(card["parked"].is_object());

    println!("== 7. deleting the session files prunes (parked + archived live)");
    c.drain(2_000);
    std::fs::remove_file(&file).expect("delete parked session file");
    std::fs::remove_file(&other_file).expect("delete archived agent's session file");
    let t0 = Instant::now();
    c.wait_state("parked pruned", 150, |s| !has(s, &third_id, |_| true));
    println!("  parked agent pruned after {:.0?}", t0.elapsed());
    // A live agent goes only after two consecutive misses (one prune pass a minute).
    c.wait_state("archived live agent pruned", 210, |s| !has(s, &other, |_| true));
    println!("  archived live agent pruned (pane closed) after {:.0?}", t0.elapsed());
    c.drain(1_000);
    println!("  info.pruned: {}", short(&c.state["info"]["pruned"], 300));
    let pruned = c.state["info"]["pruned"].as_array().cloned().unwrap_or_default();
    assert!(pruned.iter().any(|p| p["agentId"] == third_id.as_str()) && pruned.iter().any(|p| p["agentId"] == other.as_str()));
    let act = c.call("host.activity", json!({"limit": 200, "agentId": third_id})).expect("activity");
    println!("  activity left for the pruned agent: {}", act["events"].as_array().map_or(0, |v| v.len()));
    c.close();
    println!("== e2e_parked OK");
}
