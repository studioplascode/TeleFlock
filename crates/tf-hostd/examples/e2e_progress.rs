//! Lab end-to-end run of the main agent's progress (bridge 2.6.0, `OmpInfo.progress`): speaks the
//! client protocol through `tf-hostd attach` against a real herdr lab session and real omp (≥ 18.20)
//! with TeleFlock's bridge, whose model is a local mock (`e2e_progress_mock.ts`, next to this file):
//! the agent's run stays busy with one `bash` call (`sleep 20`), and the bridge's progress question
//! (an ephemeral side turn holding `<progress-check>`) gets `{"pct":40,"stage":"checking the parser"}`.
//!
//! Run it in a lab (AGENTS.md) whose daemon is not running yet: it writes the lab's omp settings
//! (every role on the mock) and herdr's omp integration (omp's runs as herdr's agent state, which
//! the board's turn follows) itself, and its `tf-hostd attach` starts the daemon, which starts herdr
//! and in it omp, with the bridge's lab schedule (`TF_BRIDGE_PROGRESS_DELAYS`, `--delays`: the first
//! question 2 s into the run, each next one 3 s after an answer, instead of omp's 2/5/10/30/60 min):
//!
//! ```sh
//! cargo build -p tf-hostd --bin tf-hostd --example e2e_progress
//! scripts/lab/run progresslab -- bun crates/tf-hostd/examples/e2e_progress_mock.ts &
//! scripts/lab/run progresslab -- target/debug/examples/e2e_progress --hostd target/debug/tf-hostd \
//!   --session tf-lab-progresslab --relay-port 47671 --work /tmp/tf-lab-progresslab/work
//! scripts/lab/stop progresslab --purge
//! ```
//!
//! Steps: 1. omp's `task.completionProbe` on (its default): while the board shows the turn running,
//! the agent carries the estimate (`omp.progress`: 40 %, the stage, `since` the run's start, `at` the
//! answer to the first question, which went out 2 s into the run); the next question quotes it, and
//! its answer keeps `since`. Once the turn ended the estimate is gone and nothing more is asked; the
//! session file bills the questions as `model_usage` entries (`purpose: teleflock-progress-probe`)
//! and holds none of them in its transcript. 2. The setting off in the lab's omp config: the same
//! run sends the model no question, shows no estimate and bills nothing.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

/// The mock agent's answer to every progress question (`e2e_progress_mock.ts` `ESTIMATE`).
const PCT: f64 = 40.0;
const STAGE: &str = "checking the parser";
/// How long the mock agent's one tool call keeps its run busy (`e2e_progress_mock.ts` `WORK`).
const WORK_SECS: u64 = 20;
/// `purpose` of the `model_usage` entries the bridge bills its questions as (`PROGRESS_USAGE_PURPOSE`).
const PURPOSE: &str = "teleflock-progress-probe";

struct Args {
    hostd: String,
    session: String,
    relay_port: u16,
    work: String,
    mock_port: u16,
    mock_log: String,
    ext: String,
    delays: String,
}

fn args() -> Args {
    let mut a = Args {
        hostd: "target/debug/tf-hostd".into(),
        session: "tf-lab-progresslab".into(),
        relay_port: 47671,
        work: "/tmp/tf-lab-progresslab/work".into(),
        mock_port: 18771,
        mock_log: format!("{}/progress-mock.jsonl", std::env::var("HOME").unwrap_or_else(|_| "/tmp".into())),
        ext: "host/teleflock-bridge/teleflock-bridge.ts".into(),
        delays: "2000,3000".into(),
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
            "--mock-log" => a.mock_log = v(),
            "--ext" => a.ext = v(),
            "--delays" => a.delays = v(),
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
            // The daemon this attach starts passes it on to its herdr, and herdr to the omp it runs.
            .env("TF_BRIDGE_PROGRESS_DELAYS", &a.delays)
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
            "client": {"app": "tf-hostd-e2e", "version": "0", "platform": "linux", "device": "progress"},
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

/// The lab's omp settings: every role on the mock, no approvals, no wizard. `probe` false turns
/// omp's subagent completion probe off (`task.completionProbe`), and with it the bridge's question.
fn omp_config(agent_dir: &str, probe: bool) {
    let roles = ["default", "smol", "slow", "vision", "plan", "commit", "tiny", "memory", "task", "advisor", "widget", "judge"];
    let task = if probe { "" } else { "task:\n  completionProbe: false\n" };
    let config = format!(
        "modelRoles:\n{}disabledProviders: [ollama, lm-studio, llama.cpp, apple, web]\ntools:\n  approvalMode: yolo\n{task}setupVersion: 2\nstartup:\n  setupWizard: false\n  checkUpdate: false\n  changelogMode: hidden\ndev:\n  autoqaConsent: denied\n",
        roles.iter().map(|r| format!("  {r}: mock/lab-1\n")).collect::<String>()
    );
    std::fs::write(format!("{agent_dir}/config.yml"), config).unwrap();
}

/// herdr's omp integration in the lab's agent dir: omp's runs as herdr's agent state, which the
/// board's turn (column, `turnStartedAt`) follows. As the lab setups install it: herdr refuses while
/// PI_CODING_AGENT_DIR points Pi and omp at one dir, so into the lab home's ~/.omp/agent, then over.
fn herdr_integration(session: &str, agent_dir: &str) {
    let installed = format!("{}/.omp/agent/extensions", std::env::var("HOME").expect("HOME"));
    std::fs::create_dir_all(&installed).unwrap();
    let out = Command::new("herdr").args(["--session", session, "integration", "install", "omp"]).env_remove("PI_CODING_AGENT_DIR").output().expect("run herdr");
    assert!(out.status.success(), "herdr integration install omp: {}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    std::fs::create_dir_all(format!("{agent_dir}/extensions")).unwrap();
    std::fs::copy(format!("{installed}/herdr-omp-agent-state.ts"), format!("{agent_dir}/extensions/herdr-omp-agent-state.ts")).expect("herdr's omp integration");
}

/// Starts an agent on the run the mock knows as `run` (`PROGRESS-LAB <run>:`); its id.
fn start(c: &mut Client, a: &Args, run: &str) -> String {
    let spec = json!({"kind": "omp", "model": "mock/lab-1", "plan": false, "prompt": format!("PROGRESS-LAB {run}: check the parser")});
    let started = c.call("agent.start", json!({"target": {"kind": "cwd", "cwd": a.work, "label": "progress"}, "spec": spec})).expect("agent.start");
    started["agentId"].as_str().expect("agent id").to_string()
}

/// The mock's requests (`e2e_progress_mock.ts` log) of `kind` in run `run`, oldest first.
fn requests(a: &Args, run: &str, kind: &str) -> Vec<Value> {
    let log = std::fs::read_to_string(&a.mock_log).unwrap_or_default();
    log.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(|e| e["run"] == run && e["kind"] == kind).collect()
}

/// Waits (following hostd meanwhile) for the mock's first request of `kind` in run `run`.
fn request(c: &mut Client, a: &Args, run: &str, kind: &str, secs: u64) -> Value {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        if let Some(r) = requests(a, run, kind).into_iter().next() {
            return r;
        }
        assert!(Instant::now() < deadline, "timed out after {secs}s waiting for the mock's {kind} request of run {run} ({})", a.mock_log);
        c.recv(Duration::from_millis(250));
    }
}

/// omp runs on the bridge's lab schedule (`TF_BRIDGE_PROGRESS_DELAYS` in its environment). Without
/// it the lab's daemon, and the herdr that runs omp, came from an earlier attach, and the bridge
/// asks on omp's two-minute schedule: the run would end before the first question.
fn on_lab_schedule(c: &mut Client, id: &str, delays: &str) {
    let pid = c.wait_agent("omp's pid", id, 60, |x| x["omp"]["pid"].is_u64())["omp"]["pid"].as_u64().unwrap();
    let environ = std::fs::read(format!("/proc/{pid}/environ")).unwrap_or_else(|e| panic!("reading omp's environment (pid {pid}): {e}"));
    let want = format!("TF_BRIDGE_PROGRESS_DELAYS={delays}");
    assert!(
        environ.split(|b| *b == 0).any(|kv| kv == want.as_bytes()),
        "omp (pid {pid}) runs without {want}: stop the lab (scripts/lab/stop) and run this again, so that its attach starts the daemon"
    );
    println!("  omp (pid {pid}) asks on the lab schedule: {delays} ms");
}

/// The session file's bills for the bridge's progress questions (`model_usage` entries with its
/// purpose), and whether a question made it into the transcript.
fn billed(file: &str) -> (Vec<Value>, bool) {
    let text = std::fs::read_to_string(file).unwrap_or_else(|e| panic!("reading the session file {file}: {e}"));
    let bills = text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(|e| e["type"] == "model_usage" && e["purpose"] == PURPOSE).collect();
    (bills, text.contains("<progress-check>"))
}

fn main() {
    let a = args();
    let home = std::env::var("TF_HOSTD_HOME").expect("set TF_HOSTD_HOME (lab home)");
    assert!(home.starts_with("/tmp/"), "lab homes live in /tmp (never the real ~/.teleflock)");
    let agent_dir = std::env::var("PI_CODING_AGENT_DIR").expect("set PI_CODING_AGENT_DIR to the lab's omp agent dir");
    assert!(agent_dir.starts_with("/tmp/"), "the lab's omp agent dir lives in /tmp");
    assert!(std::env::var("HERDR_SOCKET_PATH").is_err(), "unset the herdr env of the calling pane (HERDR_*)");
    // herdr installs its omp integration into HOME's ~/.omp: only a lab's own (scripts/lab/run).
    let lab_home = std::env::var("HOME").unwrap_or_default();
    assert!(std::env::var_os("TF_LAB").is_some() && lab_home.starts_with("/tmp/"), "run it inside a lab: scripts/lab/run <name> -- …");
    let delays: Vec<i64> = a.delays.split(',').map(|d| d.trim().parse().ok().filter(|ms| *ms > 0).expect("--delays: positive milliseconds, comma-separated")).collect();
    // The bridge's waits: the first counts from the run's start, each next one from an answer.
    let (first_wait, next_wait) = (delays[0], delays.get(1).copied().unwrap_or(delays[0]));
    let longest_wait = delays.iter().copied().max().unwrap_or(first_wait);
    std::fs::create_dir_all(&agent_dir).unwrap();
    let models = format!(
        "providers:\n  mock:\n    baseUrl: http://127.0.0.1:{}/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: lab-1\n        name: Progress Lab Mock\n        reasoning: false\n        input: [text]\n        contextWindow: 1000000\n        maxTokens: 32768\n        cost: {{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }}\n",
        a.mock_port
    );
    std::fs::write(format!("{agent_dir}/models.yml"), models).unwrap();
    omp_config(&agent_dir, true);
    herdr_integration(&a.session, &agent_dir);
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
    // This invocation's runs, as the mock logs them (a log a previous invocation left names others).
    let stamp = now_ms();

    println!("== 1. omp's completion probe on (its default): the run's progress shows on the agent");
    let mut c = Client::attach(&a);
    let on = format!("on{stamp}");
    let launched = now_ms();
    let id = start(&mut c, &a, &on);
    let run_at = request(&mut c, &a, &on, "work", 120)["at"].as_i64().expect("request time");
    on_lab_schedule(&mut c, &id, &a.delays);
    let x = c.wait_agent("the agent's progress", &id, 60, |x| x["omp"]["progress"].is_object());
    let p = x["omp"]["progress"].clone();
    println!("  progress {p} (column {}, turn started {}, run's first request {run_at})", x["column"], x["omp"]["turnStartedAt"]);
    assert!(x["column"] == "running" && requests(&a, &on, "done").is_empty(), "the estimate shows while the turn runs");
    assert_eq!((p["pct"].as_f64(), p["stage"].as_str()), (Some(PCT), Some(STAGE)), "the agent's answer");
    let (since, at) = (p["since"].as_i64().expect("since"), p["at"].as_i64().expect("at"));
    let turn = x["omp"]["turnStartedAt"].as_i64().expect("the board's turn start");
    // `since` is the run's start: omp's `agent_start`, just before the run's first model request and
    // herdr's word that the agent works (the board's turn start).
    assert!(
        launched <= since && since <= run_at && run_at - since < 5_000 && (turn - since).abs() < 5_000,
        "since {since}: the run's first request came at {run_at}, the board's turn started at {turn} (launched at {launched})"
    );
    let asked = requests(&a, &on, "progress");
    let first = asked.first().expect("the question reached the model")["at"].as_i64().expect("request time");
    assert!(since + first_wait <= first && first <= at, "the first question goes out {first_wait} ms into the run: run {since}, question {first}, answer {at}");
    assert_eq!(asked[0]["previous"], false, "the first question quotes no estimate");

    let x = c.wait_agent("the next estimate", &id, 30, |x| x["omp"]["progress"]["at"].as_i64().is_some_and(|t| t > at));
    let next = &x["omp"]["progress"];
    println!("  next estimate {next}");
    assert_eq!(next["since"].as_i64(), Some(since), "one run, one start");
    assert!(next["at"].as_i64().unwrap() - at >= next_wait, "the next question goes out {next_wait} ms after the answer");
    assert_eq!(requests(&a, &on, "progress")[1]["previous"], true, "the next question quotes the estimate before it");

    let done = c.wait_agent("the turn ends", &id, WORK_SECS + 120, |x| x["needs"].is_null() && x["column"] == "review" && !requests(&a, &on, "done").is_empty());
    let asked = requests(&a, &on, "progress").len();
    println!("  turn ended (column {}): progress {}, {asked} question(s) asked", done["column"], done["omp"]["progress"]);
    assert!(done["omp"]["progress"].is_null(), "the estimate goes with the run");
    // Longer than the schedule's longest wait: no estimate comes back, no question goes out.
    let quiet = Instant::now() + Duration::from_millis(longest_wait as u64 + 2_000);
    while Instant::now() < quiet {
        c.recv(Duration::from_millis(250));
        assert!(c.agent(&id)["omp"]["progress"].is_null(), "an estimate after the run: {}", c.agent(&id)["omp"]["progress"]);
    }
    assert_eq!(requests(&a, &on, "progress").len(), asked, "no question after the run");
    let file = done["omp"]["sessionFile"].as_str().expect("the session file").to_string();
    let (bills, in_transcript) = billed(&file);
    println!("  session file {file}: {} of {asked} question(s) billed, e.g. {}", bills.len(), bills.first().unwrap_or(&Value::Null));
    assert!(!bills.is_empty() && bills.len() <= asked, "each question answered is billed once");
    assert!(bills.iter().all(|b| b["provider"] == "mock" && b["model"] == "lab-1" && b["usage"].is_object()), "the side turn's model and usage");
    assert!(bills.iter().any(|b| b["stopReason"] == "stop"), "an answered question is billed as answered");
    assert!(!in_transcript, "the questions stay out of the transcript");

    println!("== 2. omp's completion probe off: no question, no progress");
    omp_config(&agent_dir, false);
    let off = format!("off{stamp}");
    let id = start(&mut c, &a, &off);
    request(&mut c, &a, &off, "work", 120);
    on_lab_schedule(&mut c, &id, &a.delays);
    // The whole run, long past the first question's time: never an estimate.
    let deadline = Instant::now() + Duration::from_secs(WORK_SECS + 120);
    let mut ran = false;
    let done = loop {
        let x = c.agent(&id);
        assert!(x["omp"]["progress"].is_null(), "an estimate with the probe off: {}", x["omp"]["progress"]);
        ran |= x["column"] == "running";
        if ran && x["needs"].is_null() && x["column"] == "review" && !requests(&a, &off, "done").is_empty() {
            break x;
        }
        assert!(Instant::now() < deadline, "timed out waiting for the turn to end\n{x}");
        c.recv(Duration::from_millis(250));
    };
    let file = done["omp"]["sessionFile"].as_str().expect("the session file").to_string();
    let (bills, in_transcript) = billed(&file);
    println!("  turn ended (column {}): {} question(s) asked, {} billed", done["column"], requests(&a, &off, "progress").len(), bills.len());
    assert!(requests(&a, &off, "progress").is_empty(), "no question reaches the model");
    assert!(bills.is_empty() && !in_transcript, "nothing billed");
    c.close();
    println!("== ok");
}
