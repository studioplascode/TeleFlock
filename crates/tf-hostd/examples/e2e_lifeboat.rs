//! Lab end-to-end run of Lifeboat: omp agents survive their herdr server stopping and a host
//! reboot (`Parked.ended`, auto-resume kind `restart`). Speaks the client protocol through
//! `tf-hostd attach` against the lab herdr session `tf-lab-lifeboat` and real omp 18.13.3, whose
//! model is the lab mock `/tmp/tf-lab-lifeboat/mock/mock.ts` (127.0.0.1:18752, keyed on
//! `LIFEBOAT-LAB role=<X>`; its omp agent dir `/tmp/tf-lab-lifeboat/omp-agent` points every model
//! role at it). Everything runs inside lab `lifeboat`: this harness, the `tf-hostd attach` and
//! daemon it starts, the herdr server, omp and the mock.
//!
//! ```sh
//! CARGO_TARGET_DIR=target/lifeboat cargo build -p tf-hostd --bin tf-hostd --example e2e_lifeboat
//! scripts/lab/stop lifeboat
//! rm -rf /tmp/tf-lab-lifeboat/{teleflock,home,xdg,run,omp-agent/sessions,prepared.json,c.out}
//! /tmp/tf-lab-lifeboat/mock/start-mock.sh
//! # Phase herdr (steps 1-4):
//! scripts/lab/run lifeboat -- target/lifeboat/debug/examples/e2e_lifeboat --phase herdr --pause-ended 0
//! # Phase reboot (step 5): the agents prepared as in steps 2-3, the "reboot", the check.
//! scripts/lab/run lifeboat -- target/lifeboat/debug/examples/e2e_lifeboat --phase prepare \
//!   && /tmp/tf-lab-lifeboat/mock/reboot.sh \
//!   && scripts/lab/run lifeboat -- target/lifeboat/debug/examples/e2e_lifeboat --phase reboot
//! scripts/lab/stop lifeboat
//! ```
//!
//! Steps: lab home with the uploaded overlay and bridge, herdr's omp integration in the lab's omp
//! agent dir (as on real hosts), the work repo, the hold file (`<lab>/mock/hold`) → agents
//! `a`..`d` (`mock/lab-1`, cwd the work repo): A answers one line and idles; B spawns one subagent
//! (`sleeper`) with `task` and `wait`s for it (the mock holds the sleeper's request while the hold
//! file exists); D streams a long reply (slowly while the hold file exists, its last chunk only
//! once it is gone); then C runs `sleep 30; echo done >> <lab>/c.out` → A idle, B in `wait` with
//! the sleeper running, C in bash, D streaming. `--phase prepare` stops here (written to
//! `<lab>/prepared.json`) and leaves them running.
//! `--phase herdr`: `herdr --session tf-lab-lifeboat server stop` → every card stays (same ids) as
//! `parked.ended` with a reason (A idle, B working, C working with lastAction `bash: sleep 30;
//! echo done >> <lab>/c.out`, D replying), none vanishes → `--pause-ended <secs>` (herdr stays
//! down that long for screenshots: hostd's herdr autoRestart is off meanwhile, then
//! `host.herdrRestart`) → herdr back (hostd's own restart, else after `--herdr-wait` this harness
//! starts it) → hold file removed → [outcome].
//! `--phase reboot` (after `reboot.sh` stopped the whole lab and started the mock and the daemon
//! with no client attached): `--attach-after` seconds without a client (hostd must start herdr and
//! bring the agents back by itself), attach, hold file removed → [outcome].
//! [outcome]: a/b/c/d live again under their names, each omp started with `--config
//! <home>/omp-overlay.yml`, `-e <home>/ext/teleflock-bridge.ts`, `--model mock/lab-1` and
//! `--resume=<its session file>`, never `--restore`; B's sleeper answers and B reaches
//! `[lab-final:B]`; C gets TeleFlock's note (`Your previous process ended unexpectedly at …`) and
//! reaches `[lab-final:C]` with its bash call emitted once and never run again (no new `sleep 30`
//! process, at most one line in c.out); D's reply is regenerated up to `[lab-final:D]`; A stays
//! idle with no new turn. Every check is listed at the end; the exit code says whether all passed.

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

/// (mock role, agent name, initial prompt after the marker).
const AGENTS: [(&str, &str, &str); 4] = [
    ("A", "a", "answer one short line, then stay idle."),
    (
        "B",
        "b",
        "delegate one sleeper subagent with the task tool, then wait for it.",
    ),
    ("C", "c", "run the 30-second bash step once, then report."),
    ("D", "d", "write the long lifeboat reply."),
];
const NOTE: &str = "Your previous process ended unexpectedly at";
const MOCK_PORT: u16 = 18752;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    Prepare,
    Herdr,
    Reboot,
    Kill,
    Handoff,
    Collide,
}

struct Args {
    phase: Phase,
    hostd: String,
    session: String,
    relay_port: u16,
    work: String,
    model: String,
    ext: String,
    pause_ended: u64,
    herdr_wait: u64,
    attach_after: u64,
    back_wait: u64,
    probe: String,
}

fn args() -> Args {
    let mut a = Args {
        phase: Phase::Herdr,
        hostd: "target/lifeboat/debug/tf-hostd".into(),
        session: "tf-lab-lifeboat".into(),
        relay_port: 47602,
        work: "/tmp/tf-lab-lifeboat/work".into(),
        model: "mock/lab-1".into(),
        ext: "host/teleflock-bridge/teleflock-bridge.ts".into(),
        pause_ended: 0,
        herdr_wait: 60,
        attach_after: 90,
        back_wait: 300,
        probe: String::new(),
    };
    let mut it = std::env::args().skip(1);
    while let Some(k) = it.next() {
        let mut v = || it.next().expect("missing value");
        match k.as_str() {
            "--phase" => {
                a.phase = match v().as_str() {
                    "prepare" => Phase::Prepare,
                    "herdr" => Phase::Herdr,
                    "reboot" => Phase::Reboot,
                    "kill" => Phase::Kill,
                    "handoff" => Phase::Handoff,
                    "collide" => Phase::Collide,
                    other => panic!("--phase prepare|herdr|reboot, not {other}"),
                }
            }
            "--hostd" => a.hostd = v(),
            "--session" => a.session = v(),
            "--relay-port" => a.relay_port = v().parse().expect("port"),
            "--work" => a.work = v(),
            "--model" => a.model = v(),
            "--ext" => a.ext = v(),
            "--pause-ended" => a.pause_ended = v().parse().expect("secs"),
            "--herdr-wait" => a.herdr_wait = v().parse().expect("secs"),
            "--attach-after" => a.attach_after = v().parse().expect("secs"),
            "--back-wait" => a.back_wait = v().parse().expect("secs"),
            "--probe-ended" => a.probe = v(),
            other => panic!("unknown arg {other}"),
        }
    }
    a
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// The lab's paths, checked against the environment `scripts/lab/run` sets.
struct Lab {
    name: String,
    root: PathBuf,
    home: PathBuf,
    hold: PathBuf,
    mock_log: PathBuf,
    c_out: PathBuf,
    prepared: PathBuf,
}

impl Lab {
    fn from_env(a: &Args) -> Lab {
        let name =
            std::env::var("TF_LAB").expect("run inside the lab: scripts/lab/run lifeboat -- …");
        let root = PathBuf::from(format!("/tmp/tf-lab-{name}"));
        let home = PathBuf::from(
            std::env::var("TF_HOSTD_HOME").expect("TF_HOSTD_HOME (scripts/lab/run sets it)"),
        );
        assert!(
            home.starts_with(&root),
            "the hostd home {} is not the lab's ({})",
            home.display(),
            root.display()
        );
        assert!(
            std::env::var("PI_CODING_AGENT_DIR").is_ok_and(|d| Path::new(&d).starts_with(&root)),
            "PI_CODING_AGENT_DIR must be the lab's omp agent dir"
        );
        if let Ok(sock) = std::env::var("HERDR_SOCKET_PATH") {
            assert!(
                Path::new(&sock).starts_with(&root),
                "HERDR_SOCKET_PATH={sock} is outside the lab"
            );
        }
        assert!(
            a.session.starts_with("tf-lab-"),
            "lab herdr sessions are named tf-lab-*"
        );
        let work = Path::new(&a.work);
        assert!(
            work.is_absolute() && work.starts_with(&root),
            "--work must be inside {}",
            root.display()
        );
        let mock = root.join("mock");
        Lab {
            name,
            hold: mock.join("hold"),
            mock_log: mock.join("mock.log"),
            c_out: root.join("c.out"),
            prepared: root.join("prepared.json"),
            root,
            home,
        }
    }

    fn overlay(&self) -> PathBuf {
        self.home.join("omp-overlay.yml")
    }

    fn ext(&self) -> PathBuf {
        self.home.join("ext").join("teleflock-bridge.ts")
    }

    /// C's bash call as TeleFlock names a last action (`<tool>: <short args>`).
    fn c_action(&self) -> String {
        format!("bash: sleep 30; echo done >> {}", self.c_out.display())
    }
}

struct Client {
    name: &'static str,
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<Value>,
    next_id: u64,
    state: Value,
    last_sent: Instant,
    /// Agents (id, name) watched from the herdr stop until they are back: a card must never
    /// disappear (one swapped for its relaunched agent of the same name did not); the first ended
    /// card and restart ticket each showed are recorded.
    watch: Vec<(String, String)>,
    /// Watched ids that disappeared: when, and when a card of theirs was back.
    vanished: Vec<(String, Instant, Option<Instant>)>,
    /// Name → the latest card of that name with `parked.ended` (hostd refines it once the agent's
    /// plan is decided).
    ended: std::collections::BTreeMap<String, Value>,
    /// Name → the first `autoResume` of kind `restart` a card of that name showed.
    tickets: std::collections::BTreeMap<String, Value>,
}

impl Client {
    fn attach(name: &'static str, a: &Args) -> Client {
        let mut child = Command::new(&a.hostd)
            .args([
                "attach",
                "--session",
                &a.session,
                "--relay-port",
                &a.relay_port.to_string(),
            ])
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
        let mut c = Client {
            name,
            child,
            stdin,
            rx,
            next_id: 1,
            state: Value::Null,
            last_sent: Instant::now(),
            watch: vec![],
            vanished: vec![],
            ended: Default::default(),
            tickets: Default::default(),
        };
        c.send(json!({
            "t": "hello", "protocol": tf_proto::PROTOCOL_VERSION,
            "client": {"app": "tf-hostd-e2e", "version": "0", "platform": "linux", "device": name},
            "herdrSession": a.session,
        }));
        c.wait("welcome", 90, |m| m["t"] == "welcome");
        c.wait("snapshot", 60, |m| m["t"] == "snapshot");
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
            _ => {}
        }
        // Whole messages only: a card swapped within one patch did not vanish.
        let now = Instant::now();
        let agents = self.agents();
        for (id, name) in &self.watch {
            let present = agents
                .iter()
                .any(|x| x["id"] == id.as_str() || x["name"] == name.as_str());
            match self.vanished.iter_mut().find(|v| &v.0 == id) {
                None if !present => {
                    println!(
                        "  [{}] agent {id} ({name}) VANISHED from the board",
                        self.name
                    );
                    self.vanished.push((id.clone(), now, None));
                }
                Some(v) if present && v.2.is_none() => {
                    println!(
                        "  [{}] agent {id} ({name}) back on the board after {} ms",
                        self.name,
                        now.duration_since(v.1).as_millis()
                    );
                    v.2 = Some(now);
                }
                _ => {}
            }
            if let Some(card) = agents
                .iter()
                .find(|x| x["name"] == name.as_str() && !x["parked"]["ended"].is_null())
                && self.ended.get(name).map(|c| &c["parked"]) != Some(&card["parked"])
            {
                let first = !self.ended.contains_key(name);
                println!(
                    "  [{}] {name} {}: card {} {}",
                    self.name,
                    if first { "ended" } else { "ended card updated" },
                    card["id"],
                    card["parked"]["ended"]
                );
                self.ended.insert(name.clone(), card.clone());
            }
            if let Some(ar) = agents
                .iter()
                .filter(|x| x["name"] == name.as_str())
                .map(|x| &x["autoResume"])
                .find(|ar| ar["kind"] == "restart")
                && !self.tickets.contains_key(name)
            {
                println!("  [{}] {name}: restart ticket {ar}", self.name);
                self.tickets.insert(name.clone(), ar.clone());
            }
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

    /// Receives until `pred` holds (checked before waiting and after every message, at least once
    /// a second); false when `secs` ran out.
    fn until(&mut self, what: &str, secs: u64, mut pred: impl FnMut(&mut Client) -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(secs);
        loop {
            if pred(self) {
                return true;
            }
            let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                println!("  [{}] gave up after {secs}s waiting for {what}", self.name);
                return false;
            };
            self.recv(left);
        }
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({"t": "req", "id": id, "method": method, "params": params}));
        let res = self.wait(method, 180, |m| m["t"] == "res" && m["id"] == id);
        if res["error"].is_null() {
            Ok(res["result"].clone())
        } else {
            Err(res["error"].clone())
        }
    }

    fn agent(&self, id: &str) -> Value {
        self.state["agents"]
            .as_array()
            .and_then(|a| a.iter().find(|x| x["id"] == id).cloned())
            .unwrap_or(Value::Null)
    }

    fn agents(&self) -> Vec<Value> {
        self.state["agents"].as_array().cloned().unwrap_or_default()
    }

    /// The live (not parked) agent named `name` whose omp runs.
    fn live(&self, name: &str) -> Option<Value> {
        self.agents().into_iter().find(|x| {
            x["name"] == name
                && x["parked"].is_null()
                && !x["paneId"].as_str().unwrap_or("").is_empty()
                && x["omp"]["pid"].as_u64().is_some()
        })
    }

    fn close(mut self) {
        self.send(json!({"t": "bye"}));
        let _ = self.child.wait();
    }
}

fn tool(a: &Value) -> &str {
    a["live"]["tool"]["name"].as_str().unwrap_or("")
}

fn idle(a: &Value) -> bool {
    matches!(a["state"].as_str(), Some("idle" | "done")) && a["turns"].as_u64().unwrap_or(0) >= 1
}

fn summary(a: &Value) -> String {
    if a.is_null() {
        return "(not on the board)".into();
    }
    format!(
        "id={} state={} column={} tool={} streaming={} pane={:?} pid={} link={} subagents={} jobs={} turns={} parked={} autoResume={}",
        a["id"].as_str().unwrap_or(""),
        a["state"].as_str().unwrap_or(""),
        a["column"].as_str().unwrap_or(""),
        tool(a),
        a["live"]["streaming"],
        a["paneId"].as_str().unwrap_or(""),
        a["omp"]["pid"],
        a["omp"]["link"].as_str().unwrap_or(""),
        a["omp"]["subagents"],
        a["omp"]["jobs"],
        a["turns"],
        a["parked"],
        a["autoResume"],
    )
}

/// Collects every expectation of a phase so one run reports all of them.
#[derive(Default)]
struct Checks {
    rows: Vec<(bool, String, String)>,
}

impl Checks {
    fn check(&mut self, ok: bool, name: impl Into<String>, detail: impl Into<String>) {
        let (name, detail) = (name.into(), detail.into());
        println!("  {} {name}: {detail}", if ok { "PASS" } else { "FAIL" });
        self.rows.push((ok, name, detail));
    }

    fn finish(self, phase: Phase) -> ! {
        let failed = self.rows.iter().filter(|r| !r.0).count();
        println!(
            "== checks ({phase:?}): {} passed, {failed} failed",
            self.rows.len() - failed
        );
        for (ok, name, detail) in &self.rows {
            println!("  {} {name}: {detail}", if *ok { "PASS" } else { "FAIL" });
        }
        if failed > 0 {
            println!("== e2e_lifeboat {phase:?} FAILED");
            std::process::exit(1);
        }
        println!("== e2e_lifeboat {phase:?} OK");
        std::process::exit(0)
    }
}

// ───────────────────────────── lab processes ─────────────────────────────

/// Processes whose environment carries `TF_LAB=<lab>`, with their argv.
fn lab_procs(lab: &str) -> Vec<(u32, Vec<String>)> {
    let marker = format!("TF_LAB={lab}");
    let mut out = vec![];
    for entry in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(env) = std::fs::read(format!("/proc/{pid}/environ")) else {
            continue;
        };
        if !env.split(|b| *b == 0).any(|v| v == marker.as_bytes()) {
            continue;
        }
        out.push((pid, cmdline(u64::from(pid))));
    }
    out
}

fn cmdline(pid: u64) -> Vec<String> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
    raw.split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect()
}

/// Start time in clock ticks since boot (`/proc/<pid>/stat` field 22): tells a reused pid apart.
fn start_ticks(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    stat.rsplit_once(')')?
        .1
        .split_whitespace()
        .nth(19)?
        .parse()
        .ok()
}

fn environ_has(pid: u64, var: &str) -> bool {
    std::fs::read(format!("/proc/{pid}/environ"))
        .is_ok_and(|env| env.split(|b| *b == 0).any(|v| v == var.as_bytes()))
}

/// C's bash step forks `sleep 30`: every one the lab runs, so a re-run of the step shows up as a
/// new process.
struct SleepWatch {
    lab: String,
    before: HashSet<(u32, u64)>,
    new: Vec<(u32, u64)>,
}

impl SleepWatch {
    fn start(lab: &str) -> SleepWatch {
        let mut w = SleepWatch {
            lab: lab.to_string(),
            before: HashSet::new(),
            new: vec![],
        };
        w.before = w.current();
        w
    }

    fn current(&self) -> HashSet<(u32, u64)> {
        lab_procs(&self.lab)
            .into_iter()
            .filter(|(_, argv)| {
                argv.len() == 2 && argv[0].rsplit('/').next() == Some("sleep") && argv[1] == "30"
            })
            .filter_map(|(pid, _)| start_ticks(pid).map(|t| (pid, t)))
            .collect()
    }

    fn poll(&mut self) {
        for p in self.current() {
            if !self.before.contains(&p) && !self.new.contains(&p) {
                println!(
                    "  NEW `sleep 30` process {} in the lab: C's bash step runs again",
                    p.0
                );
                self.new.push(p);
            }
        }
    }
}

/// Receives for `secs`, looking for new `sleep 30` processes meanwhile.
fn pump(c: &mut Client, watch: &mut SleepWatch, secs: u64) {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        watch.poll();
        c.recv(left);
    }
}

fn herdr(a: &Args, args: &[&str]) -> (bool, String) {
    match Command::new("herdr")
        .arg("--session")
        .arg(&a.session)
        .args(args)
        .output()
    {
        Ok(o) => (
            o.status.success(),
            format!(
                "{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            )
            .trim()
            .to_string(),
        ),
        Err(e) => (false, format!("cannot run herdr: {e}")),
    }
}

/// `herdr status server --json` of the lab session.
fn herdr_status(a: &Args) -> Value {
    let (_, out) = herdr(a, &["status", "server", "--json"]);
    serde_json::from_str(&out).unwrap_or_else(|_| json!({"running": false, "raw": out}))
}

/// The lab session's herdr server processes (`herdr --session <s> server`).
fn herdr_servers(lab: &Lab, session: &str) -> Vec<u32> {
    lab_procs(&lab.name)
        .into_iter()
        .filter(|(_, argv)| {
            argv.first()
                .is_some_and(|p| p.rsplit('/').next() == Some("herdr"))
                && argv.iter().any(|x| x == "server")
                && argv.iter().any(|x| x == session)
                && !argv.iter().any(|x| x == "stop" || x == "status")
        })
        .map(|(pid, _)| pid)
        .collect()
}

fn mock_up() -> bool {
    let Ok(mut s) = TcpStream::connect(("127.0.0.1", MOCK_PORT)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    if s.write_all(b"GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    out.ends_with("ok\n")
}

fn file_lines(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect()
}

/// hostd.log lines about agents ending and coming back, from line `from` on.
fn hostd_excerpt(lab: &Lab, from: usize) {
    const KEYS: [&str; 13] = [
        "herdr went down",
        "plan decided",
        "agent ended",
        "brought back",
        "new session",
        "auto-resume",
        "resume command",
        "herdr keeps",
        "herdr server",
        "agent ledger",
        "agent start",
        " WARN ",
        " ERROR ",
    ];
    let log = lab.home.join("hostd.log");
    println!("== {} from line {}", log.display(), from + 1);
    for l in file_lines(&log)
        .iter()
        .skip(from)
        .filter(|l| KEYS.iter().any(|k| l.contains(k)))
    {
        println!("  {}", l.chars().take(420).collect::<String>());
    }
}

/// Request lines of `role` in run `tag` (not the held/released/end/note lines).
fn requests<'a>(lines: &'a [String], role: &str, tag: &str) -> Vec<&'a String> {
    let key = format!(" role={role} run={tag} step=");
    lines
        .iter()
        .filter(|l| {
            l.contains(&key)
                && l.contains(" -> ")
                && !l.contains(" end role=")
                && !l.contains(" note role=")
        })
        .collect()
}

fn show(lines: &[&String]) -> String {
    lines.iter().map(|l| format!("\n      {l}")).collect()
}

// ───────────────────────────── steps ─────────────────────────────

/// Step 1: the lab home as the app leaves it (overlay + bridge), herdr's omp integration, the work
/// repo, the hold file. `fresh_run: false` (after the reboot) only checks them: the agents may be
/// starting right now and read the overlay and the bridge.
fn setup(a: &Args, lab: &Lab, fresh_run: bool) {
    let agent_dir = PathBuf::from(std::env::var("PI_CODING_AGENT_DIR").unwrap());
    let installed = agent_dir
        .join("extensions")
        .join("herdr-omp-agent-state.ts");
    if fresh_run {
        std::fs::create_dir_all(lab.home.join("ext")).unwrap();
        std::fs::write(
            lab.overlay(),
            format!(
                "collab:\n  autoStart: control\n  relayUrl: ws://127.0.0.1:{}\n  displayName: {}\n",
                a.relay_port, a.session
            ),
        )
        .unwrap();
        std::fs::copy(&a.ext, lab.ext()).expect("deploy the bridge extension");
        let work = Path::new(&a.work);
        if !work.join(".git").exists() {
            std::fs::create_dir_all(work.join("src")).unwrap();
            std::fs::write(work.join("README.md"), "# Lifeboat lab work repo\n\nThrowaway repository for crates/tf-hostd/examples/e2e_lifeboat.rs.\n").unwrap();
            std::fs::write(
                work.join("src/boat.ts"),
                "export const lifeboat = { oars: 4, lamps: 2, blankets: 6 };\n",
            )
            .unwrap();
            for git in [
                &["init", "-q", "-b", "main", "."][..],
                &["add", "-A"][..],
                &[
                    "-c",
                    "user.name=Lifeboat Lab",
                    "-c",
                    "user.email=lab@tf-lab-lifeboat.invalid",
                    "commit",
                    "-q",
                    "-m",
                    "Lifeboat lab work repo",
                ][..],
            ] {
                let st = Command::new("git")
                    .args(git)
                    .current_dir(work)
                    .status()
                    .expect("git");
                assert!(st.success(), "git {git:?} in {}", work.display());
            }
        }
        let _ = std::fs::remove_file(&lab.c_out);
        std::fs::write(
            &lab.hold,
            "e2e_lifeboat: the mock holds the sleeper and D's last chunk while this file exists\n",
        )
        .unwrap();
        // Real hosts have herdr's omp integration (TeleFlock's setup offers it): herdr then knows
        // the agents' states and session refs. herdr installs Pi's and omp's by
        // PI_CODING_AGENT_DIR and refuses while both resolve to one directory (the lab's omp agent
        // dir), so it is installed for a scratch HOME's default omp dir and copied to where the
        // lab's omp loads extensions.
        if !installed.exists() {
            let scratch = lab.root.join("herdr-integration");
            let file = scratch.join(".omp/agent/extensions/herdr-omp-agent-state.ts");
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            let out = Command::new("herdr")
                .args(["--session", &a.session, "integration", "install", "omp"])
                .env_remove("PI_CODING_AGENT_DIR")
                .env("HOME", &scratch)
                .output()
                .expect("herdr integration install");
            assert!(
                out.status.success() && file.exists(),
                "herdr integration install omp: {}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            std::fs::create_dir_all(installed.parent().unwrap()).unwrap();
            std::fs::copy(&file, &installed).unwrap();
        }
    }
    assert!(
        lab.overlay().is_file() && lab.ext().is_file(),
        "no overlay or bridge in {}: run --phase prepare first",
        lab.home.display()
    );
    let (_, status) = herdr(a, &["integration", "status"]);
    let line = status
        .lines()
        .find(|l| l.starts_with("omp:"))
        .unwrap_or("omp: (no status)");
    assert!(
        line.contains("current"),
        "herdr's omp integration in the lab: {line}"
    );
    println!("  herdr {line}");
    assert!(
        mock_up(),
        "the lab mock does not answer on 127.0.0.1:{MOCK_PORT}: run {}/mock/start-mock.sh",
        lab.root.display()
    );
    println!(
        "  home {} (overlay + bridge), work {}, hold file {}: {}",
        lab.home.display(),
        a.work,
        lab.hold.display(),
        if lab.hold.exists() {
            "present"
        } else {
            "absent"
        }
    );
}

fn host_settings(c: &mut Client) {
    let ar = c
        .call("host.autoResume", json!({}))
        .expect("host.autoResume");
    println!("  host auto-resume: {ar}");
    if ar["enabled"] != true {
        let ar = c
            .call("host.autoResumeSet", json!({"enabled": true}))
            .expect("host.autoResumeSet");
        println!("  turned auto-resume on: {ar}");
    }
    let hh = &c.state["info"]["herdrHealth"];
    println!(
        "  herdrHealth: {}",
        if hh.is_null() {
            "absent (daemon without the herdr health watch)".to_string()
        } else {
            hh.to_string()
        }
    );
}

/// Agents named a..d from an earlier run: live ones are closed, parked ones marked done.
fn clear_leftovers(c: &mut Client) {
    let names: Vec<&str> = AGENTS.iter().map(|x| x.1).chain(KILL_AGENTS).chain(["e1", "e2", "e3", "e4", "e5", "ca", "cb", "ci"]).collect();
    for ag in c
        .agents()
        .into_iter()
        .filter(|x| names.contains(&x["name"].as_str().unwrap_or("")) && x["archived"] != true)
    {
        let id = ag["id"].as_str().unwrap_or("").to_string();
        if ag["parked"].is_null() {
            println!(
                "  leftover live agent {} ({id}): closing its pane",
                ag["name"]
            );
            let _ = c.call("agent.stop", json!({"agentId": id, "mode": "closePane"}));
        } else {
            println!(
                "  leftover parked agent {} ({id}): marking it done",
                ag["name"]
            );
            let _ = c.call("agent.archive", json!({"agentId": id, "archived": true}));
        }
    }
    let gone = c.until("leftover agents closed", 60, |c| {
        c.agents().iter().all(|x| {
            !names.contains(&x["name"].as_str().unwrap_or(""))
                || !x["parked"].is_null()
                || x["archived"] == true
        })
    });
    assert!(
        gone,
        "leftover agents a..d still live; start from a fresh lab (see the header of this file)"
    );
}

fn start(c: &mut Client, a: &Args, role: &str, name: &str, task: &str, tag: &str) -> String {
    let spec = json!({"name": name, "kind": "omp", "model": a.model, "plan": false, "prompt": format!("LIFEBOAT-LAB role={role} run={tag}: {task}")});
    let target = json!({"kind": "cwd", "cwd": a.work, "label": format!("lifeboat-{name}")});
    let started = c
        .call("agent.start", json!({"target": target, "spec": spec}))
        .unwrap_or_else(|e| panic!("agent.start {name}: {e}"));
    let id = started["agentId"].as_str().expect("agent id").to_string();
    println!(
        "  {name} (role {role}): agent {id}, pane {}",
        started["paneId"].as_str().unwrap_or("")
    );
    id
}

/// Steps 2-3. Returns the prepared run: its tag and each agent's id, session file and omp pid.
fn prepare(c: &mut Client, a: &Args, lab: &Lab) -> Value {
    println!("== 1. lab setup");
    setup(a, lab, true);
    host_settings(c);
    clear_leftovers(c);
    let tag = format!("r{}", now_ms() / 1000);
    println!("== 2. agents a, b, d (run {tag}), then c");
    let mut ids = std::collections::BTreeMap::new();
    for (role, name, task) in AGENTS.iter().filter(|x| x.0 != "C") {
        ids.insert(*role, start(c, a, role, name, task, &tag));
    }
    let (ia, ib, id_d) = (ids["A"].clone(), ids["B"].clone(), ids["D"].clone());
    let held = format!(" held role=sleeper run={tag} ");
    let mut seen = HashSet::new();
    let ready = c.until(
        "A idle, B in wait with its sleeper held, D streaming",
        300,
        |c| {
            let (ag_a, ag_b, ag_d) = (c.agent(&ia), c.agent(&ib), c.agent(&id_d));
            let sleeper_held = file_lines(&lab.mock_log).iter().any(|l| l.contains(&held));
            let sub = ag_b["omp"]["subagents"]["live"].as_u64().unwrap_or(0) >= 1
                || ag_b["omp"]["jobs"]["running"].as_u64().unwrap_or(0) >= 1;
            let states = [
                ("A idle", idle(&ag_a)),
                ("B in wait", tool(&ag_b) == "wait"),
                ("B's sleeper running", sub),
                ("the sleeper's request held by the mock", sleeper_held),
                ("D streaming", ag_d["live"]["streaming"] == true),
            ];
            for (what, ok) in states {
                if ok && seen.insert(what) {
                    println!("  … {what}");
                }
            }
            states.iter().all(|s| s.1)
        },
    );
    if !ready {
        for id in [&ia, &ib, &id_d] {
            println!("  {}", summary(&c.agent(id)));
        }
        panic!("A, B and D did not reach their states");
    }
    let ic = start(c, a, "C", "c", AGENTS[2].2, &tag);
    let in_bash = c.until("C in bash", 180, |c| tool(&c.agent(&ic)) == "bash");
    assert!(
        in_bash,
        "C never ran its bash step: {}",
        summary(&c.agent(&ic))
    );
    let c_bash_at = Instant::now();
    println!("== 3. states (C's bash runs for 30 s from now)");
    let mut prepared = json!({"tag": tag, "preparedAt": now_ms(), "agents": {}});
    let mut ok = true;
    for ((role, name, _), id) in AGENTS.iter().zip([&ia, &ib, &ic, &id_d]) {
        let ag = c.agent(id);
        let state_ok = match *role {
            "A" => idle(&ag),
            "B" => {
                tool(&ag) == "wait"
                    && (ag["omp"]["subagents"]["live"].as_u64().unwrap_or(0) >= 1
                        || ag["omp"]["jobs"]["running"].as_u64().unwrap_or(0) >= 1)
            }
            "C" => tool(&ag) == "bash",
            _ => ag["live"]["streaming"] == true,
        };
        ok &= state_ok;
        println!(
            "  {name} [{}] {}",
            if state_ok { "ok" } else { "WRONG STATE" },
            summary(&ag)
        );
        prepared["agents"][*name] = json!({"id": id, "sessionFile": ag["omp"]["sessionFile"], "pid": ag["omp"]["pid"], "label": ag["live"]["tool"]["label"]});
    }
    let lines = file_lines(&lab.mock_log);
    for role in ["A", "B", "sleeper", "C", "D"] {
        println!(
            "  mock, role {role}:{}",
            show(
                &lines
                    .iter()
                    .filter(|l| l.contains(&format!(" role={role} run={tag} ")))
                    .collect::<Vec<_>>()
            )
        );
    }
    assert!(ok, "not every agent is in its state");
    assert!(
        c_bash_at.elapsed() < Duration::from_secs(20),
        "C's bash step is about to finish"
    );
    prepared
}

/// The ended cards right after the herdr stop. Returns C's `parked.ended.reason`.
fn ended_checks(c: &Client, lab: &Lab, prep: &Value, checks: &mut Checks) -> String {
    let c_action = lab.c_action();
    let mut c_reason = String::new();
    for (role, name, _) in AGENTS {
        let id = prep["agents"][name]["id"].as_str().unwrap_or("");
        let ag = c.ended.get(name).cloned().unwrap_or(Value::Null);
        let ended = &ag["parked"]["ended"];
        println!("  {name}: {}", summary(&ag));
        println!("  {name}: session file on disk now: {}", Path::new(prep["agents"][name]["sessionFile"].as_str().unwrap_or("")).exists());
        checks.check(
            !ended.is_null() && ag["id"] == id,
            format!("{name} kept as an ended card (same id {id})"),
            if ended.is_null() {
                "never seen ended".to_string()
            } else {
                format!("card {} {ended}", ag["id"])
            },
        );
        if ended.is_null() {
            continue;
        }
        let (cause, reason) = (
            ended["cause"].as_str().unwrap_or(""),
            ended["reason"].as_str().unwrap_or(""),
        );
        checks.check(
            !reason.is_empty(),
            format!("{name} says why it ended"),
            format!("reason={reason:?}"),
        );
        checks.check(
            cause.starts_with("herdr"),
            format!("{name} ended because herdr stopped"),
            format!("cause={cause}"),
        );
        let want = match role {
            "A" => "idle",
            "D" => "replying",
            _ => "working",
        };
        checks.check(
            ended["turn"] == want,
            format!("{name} ended {want}"),
            format!("turn={}", ended["turn"]),
        );
        let last = ended["lastAction"].as_str().unwrap_or("");
        match role {
            "B" => checks.check(
                last.starts_with("wait"),
                "b's last action is its wait",
                format!("lastAction={last:?}"),
            ),
            "C" => {
                checks.check(
                    last == c_action,
                    "c's last action is its bash step",
                    format!("lastAction={last:?}"),
                );
                c_reason = reason.to_string();
            }
            _ => println!("  {name} lastAction={last:?}"),
        }
        checks.check(
            ag["column"] == "review",
            format!("{name} in Review"),
            format!("column={}", ag["column"]),
        );
    }
    c_reason
}

/// The live agent `name` once its link is up and its card's omp pid is a running omp.
fn ready(c: &Client, name: &str) -> Option<Value> {
    c.live(name).filter(|x| {
        x["omp"]["link"] == "live"
            && cmdline(x["omp"]["pid"].as_u64().unwrap_or(0))
                .first()
                .is_some_and(|p| p.rsplit('/').next() == Some("omp"))
    })
}

/// After herdr (or the host) came back: the agents return and go on safely. Returns the note C got.
fn outcomes(
    c: &mut Client,
    a: &Args,
    lab: &Lab,
    prep: &Value,
    offset: usize,
    watch: &mut SleepWatch,
    checks: &mut Checks,
) -> String {
    let tag = prep["tag"].as_str().expect("prepared tag").to_string();
    println!("== agents back (up to {} s)", a.back_wait);
    let t0 = Instant::now();
    let names: Vec<&str> = AGENTS.iter().map(|x| x.1).collect();
    let d_fileless = !Path::new(prep["agents"]["d"]["sessionFile"].as_str().unwrap_or("")).exists();
    let old_pids: Vec<(&str, u64)> = names
        .iter()
        .filter(|n| !(d_fileless && **n == "d"))
        .map(|n| (*n, prep["agents"][*n]["pid"].as_u64().unwrap_or(0)))
        .collect();
    let mut stale = HashSet::new();
    // An agent without any card for 30 s is not coming back: no need to wait for it.
    let mut missing: std::collections::BTreeMap<&str, Instant> = Default::default();
    c.until("a, b, c and d live again (link live, omp running)", a.back_wait, |c| {
        watch.poll();
        let now = Instant::now();
        let mut settled = true;
        for (name, old) in &old_pids {
            if let Some(ag) = c.live(name)
                && ag["omp"]["pid"].as_u64() == Some(*old)
                && stale.insert(*name)
            {
                println!("  note: {name}'s relaunched card {} shows the ended omp's pid {old} (link {})", ag["id"], ag["omp"]["link"]);
            }
            if ready(c, name).is_some() {
                continue;
            }
            if c.agents().iter().any(|x| x["name"] == *name) {
                missing.remove(name);
                settled = false;
            } else if now.duration_since(*missing.entry(*name).or_insert(now)) < Duration::from_secs(30) {
                settled = false;
            }
        }
        settled
    });
    println!("  after {:.0} s", t0.elapsed().as_secs_f64());
    let back_at = Instant::now();
    let (overlay, ext) = (
        lab.overlay().display().to_string(),
        lab.ext().display().to_string(),
    );
    let mut live_ids = std::collections::BTreeMap::new();
    for (_, name, _) in AGENTS {
        if d_fileless && name == "d" {
            continue;
        }
        let rec = &prep["agents"][name];
        let Some(ag) = ready(c, name).or_else(|| c.live(name)) else {
            let cards: Vec<String> = c
                .agents()
                .iter()
                .filter(|x| x["name"] == name)
                .map(summary)
                .collect();
            checks.check(
                false,
                format!("{name} live again under its name"),
                format!("cards named {name}: {cards:?}"),
            );
            continue;
        };
        let id = ag["id"].as_str().unwrap_or("").to_string();
        let pid = ag["omp"]["pid"].as_u64().unwrap_or(0);
        let argv = cmdline(pid);
        let was = rec["id"].as_str().unwrap_or("");
        checks.check(
            true,
            format!("{name} live again under its name"),
            format!(
                "agent {id} ({}), omp pid {pid}, link {}",
                if id == was {
                    "same id".to_string()
                } else {
                    format!("new id; was {was}")
                },
                ag["omp"]["link"]
            ),
        );
        println!("    /proc/{pid}/cmdline: {}", argv.join(" "));
        let file = rec["sessionFile"].as_str().unwrap_or("?");
        let flag = |k: &str, v: &str| {
            argv.iter().any(|x| x == &format!("{k}={v}"))
                || argv.windows(2).any(|w| w[0] == k && w[1] == v)
        };
        checks.check(
            flag("--config", &overlay),
            format!("{name}'s omp loads TeleFlock's overlay"),
            format!("--config {overlay}"),
        );
        checks.check(
            flag("-e", &ext) || flag("--extension", &ext),
            format!("{name}'s omp loads the bridge"),
            format!("-e {ext}"),
        );
        checks.check(
            flag("--model", &a.model),
            format!("{name}'s omp runs its model"),
            format!("--model {}", a.model),
        );
        // An omp that ended before it ever wrote its session file cannot be resumed: it comes back
        // as a new session with its first prompt again.
        if Path::new(file).exists() {
            checks.check(
                argv.iter().any(|x| x == &format!("--resume={file}")),
                format!("{name}'s omp resumes its session"),
                format!("--resume={file}"),
            );
        } else {
            let resume: Vec<&String> = argv.iter().filter(|x| x.starts_with("--resume")).collect();
            checks.check(
                resume.is_empty(),
                format!("{name}'s omp starts a new session (the ended omp never wrote {file})"),
                format!("{resume:?}"),
            );
        }
        let restore: Vec<&String> = argv.iter().filter(|x| x.starts_with("--restore")).collect();
        checks.check(
            restore.is_empty(),
            format!("{name}'s omp is not started with --restore"),
            format!("{restore:?}"),
        );
        checks.check(
            environ_has(pid, &format!("TF_LAB={}", lab.name)),
            format!("{name}'s omp runs in the lab"),
            format!("TF_LAB={}", lab.name),
        );
        live_ids.insert(name, id);
    }
    let left: Vec<String> = c
        .agents()
        .iter()
        .filter(|x| {
            names.contains(&x["name"].as_str().unwrap_or("")) && !x["parked"]["ended"].is_null() && !(d_fileless && x["name"] == "d")
        })
        .map(summary)
        .collect();
    checks.check(
        left.is_empty(),
        "no ended card left beside the live agents",
        format!("{left:?}"),
    );

    if d_fileless {
        println!("== d never wrote its session file: its card waits for Continue");
        let card = c.agents().into_iter().find(|x| x["name"] == "d" && !x["parked"]["ended"].is_null());
        println!("  d: {}", card.as_ref().map_or("no ended card".into(), summary));
        let reason = card.as_ref().map(|x| x["autoResume"]["reason"].as_str().unwrap_or("").to_string()).unwrap_or_default();
        let lines = file_lines(&lab.mock_log);
        let later = requests(&lines[offset.min(lines.len())..], "D", &tag).len();
        checks.check(
            card.as_ref().is_some_and(|x| x["autoResume"]["status"] == "manual") && reason.contains("before its first reply") && later == 0,
            "d (fileless) is a manual ended card and was not started by itself",
            format!("reason={reason:?}, model requests after the reboot {later}"),
        );
        let id = card.as_ref().map(|x| x["id"].as_str().unwrap_or("").to_string()).unwrap_or_default();
        let cont = c.call("agent.autoResumeNow", json!({"agentId": id}));
        let back = c.until("d live after Continue", 150, |c| ready(c, "d").is_some());
        println!("  Continue d -> {cont:?}; back={back}: {}", ready(c, "d").map_or("none".into(), |x| summary(&x)));
        checks.check(cont.is_ok() && back, "Continue starts d again as a new session with its prompt", format!("{cont:?}"));
        if let Some(x) = ready(c, "d") {
            live_ids.insert("d", x["id"].as_str().unwrap_or("").to_string());
        }
    }
    println!("== B, C and D go on; A stays idle");
    let (mut b_final, mut c_note, mut c_final, mut d_final) =
        (String::new(), String::new(), String::new(), String::new());
    let deadline = Instant::now() + Duration::from_secs(240);
    let want = |name: &str, found: &str| live_ids.contains_key(name) && found.is_empty();
    while Instant::now() < deadline
        && (want("b", &b_final) || want("c", &c_note) || want("c", &c_final) || want("d", &d_final))
    {
        pump(c, watch, 3);
        let last_with = |items: &[Value], marker: &str| {
            items
                .iter()
                .rev()
                .find(|i| {
                    i["kind"] == "assistant" && i["text"].as_str().unwrap_or("").contains(marker)
                })
                .map(|i| i["text"].as_str().unwrap_or("").to_string())
        };
        if b_final.is_empty()
            && let Some(id) = live_ids.get("b")
        {
            b_final = last_with(&transcript(c, id), "[lab-final:B]").unwrap_or_default();
        }
        if (c_note.is_empty() || c_final.is_empty())
            && let Some(id) = live_ids.get("c")
        {
            let items = transcript(c, id);
            c_note = items
                .iter()
                .find(|i| {
                    i["kind"] == "user"
                        && i["text"]
                            .as_str()
                            .unwrap_or("")
                            .trim_start()
                            .starts_with(NOTE)
                })
                .map(|i| i["text"].as_str().unwrap_or("").to_string())
                .unwrap_or_default();
            c_final = last_with(&items, "[lab-final:C]").unwrap_or_default();
        }
        if d_final.is_empty()
            && let Some(id) = live_ids.get("d")
        {
            d_final = last_with(&transcript(c, id), "[lab-final:D]").unwrap_or_default();
        }
    }
    checks.check(
        !b_final.is_empty(),
        "b reaches [lab-final:B]",
        format!("{b_final:?}"),
    );
    checks.check(
        !c_note.is_empty(),
        "c gets TeleFlock's note",
        format!("{c_note:?}"),
    );
    checks.check(
        !c_final.is_empty(),
        "c reaches [lab-final:C]",
        format!("{c_final:?}"),
    );
    checks.check(
        !d_final.is_empty(),
        "d's reply reaches [lab-final:D]",
        d_final.lines().last().unwrap_or("").to_string(),
    );
    if let Some(id) = live_ids.get("c") {
        for t in transcript(c, id).iter().filter(|i| i["kind"] == "tool") {
            println!(
                "    c's {} call: status={} output={:?} error={:?}",
                t["tool"],
                t["status"],
                t["output"].as_str().unwrap_or(""),
                t["error"].as_str().unwrap_or("")
            );
        }
    }
    if let Some(id) = live_ids.get("d") {
        let prompt = format!("LIFEBOAT-LAB role=D run={tag}: {}", AGENTS[3].2);
        let users: Vec<String> = transcript(c, id)
            .iter()
            .filter(|i| i["kind"] == "user")
            .map(|i| i["text"].as_str().unwrap_or("").to_string())
            .collect();
        checks.check(
            users.iter().any(|u| u.trim() == prompt),
            "d's session holds its first prompt",
            format!("{users:?}"),
        );
    }

    // A re-run of C's step would fork `sleep 30` again: keep looking until 35 s after the return.
    let left = Duration::from_secs(35).saturating_sub(back_at.elapsed());
    pump(c, watch, left.as_secs());
    let survivors: Vec<u32> = watch.before.iter().map(|p| p.0).collect();
    checks.check(watch.new.is_empty(), "c's bash step never ran again", format!("`sleep 30` processes started after the end: {:?} (left running by the end: {survivors:?})", watch.new));
    let c_out = std::fs::read_to_string(&lab.c_out).unwrap_or_default();
    checks.check(
        c_out.lines().count() <= 1,
        "c.out has at most one line",
        format!("{:?}", c_out),
    );

    let lines = file_lines(&lab.mock_log);
    let after = &lines[offset.min(lines.len())..];
    let bash: Vec<&String> = requests(&lines, "C", &tag)
        .into_iter()
        .filter(|l| l.contains("-> tools[bash]"))
        .collect();
    checks.check(
        bash.len() == 1,
        "the mock emitted c's bash call exactly once",
        show(&bash),
    );
    let notes: Vec<&String> = after
        .iter()
        .filter(|l| l.contains(&format!(" note role=C run={tag} ")))
        .collect();
    checks.check(
        !notes.is_empty(),
        "the mock saw the note in c's conversation",
        show(&notes),
    );
    let sleeper: Vec<&String> = after
        .iter()
        .filter(|l| l.contains(&format!("role=sleeper run={tag} ")))
        .collect();
    let answered = sleeper
        .iter()
        .any(|l| l.contains(" end role=sleeper") && l.contains(" complete"));
    checks.check(
        answered,
        "b's sleeper answered after the end",
        show(&sleeper),
    );
    let d_replies: Vec<&String> = requests(&lines, "D", &tag)
        .into_iter()
        .filter(|l| l.contains("step=reply"))
        .collect();
    let d_done: Vec<&String> = after
        .iter()
        .filter(|l| l.contains(&format!(" end role=D run={tag} step=reply complete")))
        .collect();
    checks.check(
        d_replies.len() >= 2 && !d_done.is_empty(),
        "d's reply was regenerated",
        format!(
            "{} reply requests, completed after the end:{}{}",
            d_replies.len(),
            show(&d_done),
            show(&d_replies)
        ),
    );
    {
        let d_file = prep["agents"]["d"]["sessionFile"].as_str().unwrap_or("");
        let fileless = !Path::new(d_file).exists();
        let later: Vec<&String> = requests(after, "D", &tag).into_iter().filter(|l| l.contains("step=reply")).collect();
        let users_max = later.iter().map(|l| field(l, "users=")).max().unwrap_or(0);
        checks.check(
            users_max <= 1 && (!fileless || later.len() == 1),
            format!("d's first prompt reaches the model once ({})", if fileless { "fileless: exactly one request after the relaunch" } else { "its session file exists: resumed" }),
            format!("{} request(s) after the relaunch, max users={users_max}{}", later.len(), show(&later)),
        );
    }
    for role in ["A", "B", "D"] {
        let noted: Vec<&String> = after
            .iter()
            .filter(|l| l.contains(&format!(" role={role} run={tag} ")) && l.contains(" note=1 "))
            .collect();
        checks.check(
            noted.is_empty(),
            format!("no note to {}", role.to_lowercase()),
            show(&noted),
        );
    }
    let a_new = requests(after, "A", &tag);
    checks.check(
        a_new.is_empty(),
        "a made no model request after the end",
        show(&a_new),
    );
    if let Some(id) = live_ids.get("a") {
        let ag = c.agent(id);
        let users = transcript(c, id)
            .iter()
            .filter(|i| i["kind"] == "user")
            .count();
        checks.check(
            matches!(ag["state"].as_str(), Some("idle" | "done")),
            "a stays idle",
            summary(&ag),
        );
        checks.check(
            users == 1,
            "a's transcript holds only its first prompt",
            format!("{users} user message(s)"),
        );
    }
    println!("== board at the end");
    for (_, name, _) in AGENTS {
        println!(
            "  {name}: {}",
            c.live(name)
                .map(|x| summary(&x))
                .unwrap_or_else(|| "(not live)".into())
        );
    }
    c_note
}

fn transcript(c: &mut Client, id: &str) -> Vec<Value> {
    match c.call("session.open", json!({"agentId": id})) {
        Ok(snap) => {
            let _ = c.call("session.close", json!({"agentId": id}));
            snap["items"].as_array().cloned().unwrap_or_default()
        }
        Err(e) => {
            println!("    session.open {id}: {e}");
            vec![]
        }
    }
}

fn phase_herdr(c: &mut Client, a: &Args, lab: &Lab, prep: &Value) -> Checks {
    let mut checks = Checks::default();
    println!("== 4. herdr stops");
    let status = herdr_status(a);
    let socket = status["socket"].as_str().unwrap_or("");
    assert!(
        Path::new(socket).starts_with(&lab.root),
        "the herdr server to stop is not the lab's: {status}"
    );
    let servers = herdr_servers(lab, &a.session);
    assert!(
        !servers.is_empty()
            && servers
                .iter()
                .all(|p| environ_has(u64::from(*p), &format!("TF_LAB={}", lab.name))),
        "no lab herdr server process found: {servers:?}"
    );
    let epoch0 = c.state["info"]["herdrHealth"]["epoch"]
        .as_u64()
        .unwrap_or(0);
    println!(
        "  server pid(s) {servers:?}, socket {socket}, version {}, herdrHealth epoch {epoch0}",
        status["version"]
    );
    let offset = file_lines(&lab.mock_log).len();
    let log_from = file_lines(&lab.home.join("hostd.log")).len();
    let ids: Vec<String> = AGENTS
        .iter()
        .map(|x| prep["agents"][x.1]["id"].as_str().unwrap_or("").to_string())
        .collect();
    c.watch = AGENTS
        .iter()
        .zip(&ids)
        .map(|(x, id)| (id.clone(), x.1.to_string()))
        .collect();
    // A pause for screenshots keeps herdr down for its length: hostd's own restart is off meanwhile.
    let hold_outage = a.pause_ended > 0;
    if hold_outage {
        match c.call("host.herdrConfig", json!({"autoRestart": false})) {
            Ok(hh) => println!("  herdr autoRestart off for the pause: {}", hh["config"]),
            Err(e) => println!("  host.herdrConfig autoRestart=false failed: {e}"),
        }
    }
    let stopped_at = Instant::now();
    let (ok, out) = herdr(a, &["server", "stop"]);
    println!("  herdr --session {} server stop: ok={ok} {out}", a.session);
    let all_ended = c.until("a, b, c and d ended", 30, |c| {
        AGENTS.iter().all(|x| c.ended.contains_key(x.1))
    });
    println!(
        "  {} after {:.1} s",
        if all_ended {
            "all four ended"
        } else {
            "NOT all ended"
        },
        stopped_at.elapsed().as_secs_f64()
    );
    let mut watch = SleepWatch::start(&lab.name);
    // hostd refines each ended card once it decided the agent's plan (`plan decided` in hostd.log).
    let hostd_log = lab.home.join("hostd.log");
    let decided = |n: usize| {
        file_lines(&hostd_log)
            .iter()
            .skip(log_from)
            .filter(|l| l.contains("plan decided"))
            .count()
            >= n
    };
    c.until("hostd decided every ended agent's plan", 15, |_| {
        decided(AGENTS.len())
    });
    pump(c, &mut watch, 3);
    let c_reason = ended_checks(c, lab, prep, &mut checks);
    let hh = &c.state["info"]["herdrHealth"];
    println!("  herdrHealth: {hh}");
    if hold_outage {
        println!(
            "== paused {} s for screenshots (herdr stays down)",
            a.pause_ended
        );
        probe_ended(c, a, prep, &mut watch, &mut checks);
        pump(c, &mut watch, a.pause_ended);
        let on = c
            .call("host.herdrConfig", json!({"autoRestart": true}))
            .map(|hh| hh["config"].to_string())
            .unwrap_or_else(|e| e.to_string());
        let restart = c
            .call("host.herdrRestart", json!({}))
            .map(|hh| hh["state"].to_string())
            .unwrap_or_else(|e| e.to_string());
        println!("  herdr autoRestart on again ({on}); host.herdrRestart: {restart}");
    }

    println!(
        "== herdr back (hostd's own restart, up to {} s)",
        a.herdr_wait
    );
    let mut by = "";
    let wait_from = Instant::now();
    let mut last_hh = String::new();
    while wait_from.elapsed() < Duration::from_secs(a.herdr_wait) {
        pump(c, &mut watch, 1);
        let hh = &c.state["info"]["herdrHealth"];
        let line = format!(
            "state={} cause={} attempt={} retryAt={} epoch={}",
            hh["state"], hh["cause"], hh["attempt"], hh["retryAt"], hh["epoch"]
        );
        if line != last_hh {
            println!("  herdrHealth {line}");
            last_hh = line;
        }
        if herdr_status(a)["running"] == true {
            by = "hostd";
            break;
        }
    }
    if by.is_empty() {
        let log = lab.root.join("herdr-harness.log");
        println!(
            "  not back after {} s: starting `herdr --session {} server` in the lab (log {})",
            a.herdr_wait,
            a.session,
            log.display()
        );
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log)
            .unwrap();
        let st = Command::new("setsid")
            .args(["-f", "herdr", "--session", &a.session, "server"])
            .stdin(Stdio::null())
            .stdout(file.try_clone().unwrap())
            .stderr(file)
            .status()
            .expect("setsid herdr");
        assert!(st.success(), "starting herdr: {st}");
        let up = c.until("herdr up", 60, |_| herdr_status(a)["running"] == true);
        assert!(up, "the lab herdr server did not start");
        by = "this harness";
    }
    c.until("herdrHealth up", 15, |c| {
        c.state["info"]["herdrHealth"].is_null() || c.state["info"]["herdrHealth"]["state"] == "up"
    });
    let hh = &c.state["info"]["herdrHealth"];
    println!(
        "  herdr up {:.1} s after the stop, started by {by}: pids {:?}, herdrHealth {hh}",
        stopped_at.elapsed().as_secs_f64(),
        herdr_servers(lab, &a.session)
    );
    if hh["config"]["autoRestart"] == true {
        checks.check(
            by == "hostd",
            "hostd started herdr again by itself (herdrHealth.config.autoRestart)",
            format!("started by {by}"),
        );
    }
    let _ = std::fs::remove_file(&lab.hold);
    println!("  hold file removed");
    let note = outcomes(c, a, lab, prep, offset, &mut watch, &mut checks);
    // TeleFlock's note: "… ended unexpectedly at HH:MM (<reason>). Its last action (<tool>: <args>) …"
    let action = format!("({})", lab.c_action());
    checks.check(
        !c_reason.is_empty() && note.contains(&format!("({c_reason})")),
        "c's note gives the reason its card showed",
        format!("reason {c_reason:?}"),
    );
    checks.check(
        note.contains(&action),
        "c's note names its last action",
        action,
    );
    for (_, name, _) in AGENTS {
        let ticket = c.tickets.get(name).map(Value::to_string);
        checks.check(
            ticket.is_some(),
            format!("{name} showed a restart ticket (autoResume kind restart)"),
            ticket.unwrap_or_else(|| "never".into()),
        );
    }
    let gaps: Vec<String> = c
        .vanished
        .iter()
        .map(|(id, at, back)| {
            format!(
                "{id}: {}",
                back.map(|b| format!("off the board for {} ms", b.duration_since(*at).as_millis()))
                    .unwrap_or_else(|| "never back".into())
            )
        })
        .collect();
    checks.check(
        c.vanished.is_empty(),
        "no card vanished from the herdr stop until the agents were back",
        format!("{gaps:?}"),
    );
    c.watch.clear();
    hostd_excerpt(lab, log_from);
    checks
}

fn phase_reboot(a: &Args, lab: &Lab) -> Checks {
    let mut checks = Checks::default();
    let prep: Value = serde_json::from_str(
        &std::fs::read_to_string(&lab.prepared).expect("prepared.json: run --phase prepare first"),
    )
    .expect("prepared.json");
    println!(
        "== 5. after the reboot (run {}, prepared {:.0} s ago)",
        prep["tag"],
        (now_ms() - prep["preparedAt"].as_i64().unwrap_or(0)) as f64 / 1000.0
    );
    setup(a, lab, false);
    let lines = file_lines(&lab.mock_log);
    let offset = lines
        .iter()
        .rposition(|l| l.contains(" start pid="))
        .unwrap_or(0);
    println!(
        "  mock restarted: {}",
        lines.get(offset).map(String::as_str).unwrap_or("?")
    );
    let mut watch = SleepWatch::start(&lab.name);
    println!(
        "  `sleep 30` processes left from before the reboot: {:?}",
        watch.before
    );
    println!("== no client attached for {} s", a.attach_after);
    let t0 = Instant::now();
    let mut next = Duration::ZERO;
    while t0.elapsed() < Duration::from_secs(a.attach_after) {
        watch.poll();
        if t0.elapsed() >= next {
            next += Duration::from_secs(15);
            let procs = lab_procs(&lab.name);
            let attached = procs.iter().any(|(_, v)| v.iter().any(|x| x == "attach"));
            let omps: Vec<String> = procs
                .iter()
                .filter(|(_, v)| {
                    v.first()
                        .is_some_and(|p| p.rsplit('/').next() == Some("omp"))
                })
                .map(|(p, v)| format!("{p}: {}", v[1..].join(" ")))
                .collect();
            println!(
                "  +{:>3.0} s: herdr servers {:?}, clients attached: {attached}, omp: {omps:?}",
                t0.elapsed().as_secs_f64(),
                herdr_servers(lab, &a.session)
            );
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    let servers = herdr_servers(lab, &a.session);
    checks.check(
        !servers.is_empty() && herdr_status(a)["running"] == true,
        "hostd started herdr with no client attached",
        format!("server pids {servers:?}"),
    );
    let mut c = Client::attach("after-reboot", a);
    host_settings(&mut c);
    for (_, name, _) in AGENTS {
        let cards: Vec<Value> = c
            .agents()
            .into_iter()
            .filter(|x| x["name"] == name)
            .collect();
        for card in &cards {
            println!("  {name}: {}", summary(card));
            let id = card["id"].as_str().unwrap_or("");
            if let Ok(act) = c.call("host.activity", json!({"limit": 8, "agentId": id})) {
                for e in act["events"].as_array().into_iter().flatten() {
                    println!(
                        "      activity {} {} — {}",
                        e["kind"].as_str().unwrap_or(""),
                        e["title"].as_str().unwrap_or(""),
                        e["detail"].as_str().unwrap_or("")
                    );
                }
            }
        }
    }
    let _ = std::fs::remove_file(&lab.hold);
    println!("  hold file removed");
    let note = outcomes(&mut c, a, lab, &prep, offset, &mut watch, &mut checks);
    let action = format!("({})", lab.c_action());
    checks.check(
        note.contains(&action),
        "c's note names its last action",
        action,
    );
    c.close();
    // From the daemon reboot.sh started (its first line after the restart).
    let log = file_lines(&lab.home.join("hostd.log"));
    hostd_excerpt(
        lab,
        log.iter()
            .rposition(|l| l.contains("listening"))
            .unwrap_or(0),
    );
    checks
}

/// B1: while herdr is down, the fresh ended card of an agent whose omp never wrote its session file
/// gets `session.open` (`--probe-ended open`) or a prompt (`--probe-ended prompt`). The card must
/// stay on the board; the herdr phase's outcome checks then require the agent back.
fn probe_ended(
    c: &mut Client,
    a: &Args,
    prep: &Value,
    watch: &mut SleepWatch,
    checks: &mut Checks,
) {
    if a.probe.is_empty() {
        return;
    }
    let no_file = |n: &str| !Path::new(prep["agents"][n]["sessionFile"].as_str().unwrap_or("")).exists();
    let name = AGENTS.iter().map(|x| x.1).find(|n| no_file(n)).unwrap_or("d");
    let id = prep["agents"][name]["id"].as_str().unwrap_or("").to_string();
    println!(
        "== B1 probe ({}) on {name} (card {id}); its session file {} on disk",
        a.probe,
        if no_file(name) { "is NOT" } else { "is" }
    );
    let card = c.agent(&id);
    println!("  before: {}", summary(&card));
    checks.check(
        !card["parked"]["ended"].is_null(),
        format!("B1: {name} is an ended card before the probe"),
        format!("{}", card["parked"]),
    );
    let res = match a.probe.as_str() {
        "open" => c.call("session.open", json!({"agentId": id})).map(|s| {
            format!(
                "{} item(s), keys {:?}",
                s["items"].as_array().map_or(0, Vec::len),
                s.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>())
            )
        }),
        "prompt" => c
            .call(
                "agent.prompt",
                json!({"agentId": id, "text": "lab probe: are you still there?", "delivery": "auto"}),
            )
            .map(|r| r.to_string()),
        other => panic!("--probe-ended open|prompt, not {other}"),
    };
    println!("  {} -> {res:?}", a.probe);
    if a.probe == "open" {
        let _ = c.call("session.close", json!({"agentId": id}));
    }
    for tick in 0..4 {
        pump(c, watch, 3);
        let cards: Vec<Value> = c.agents().into_iter().filter(|x| x["name"] == name).collect();
        println!(
            "  +{} s: {}",
            (tick + 1) * 3,
            if cards.is_empty() {
                "(no card named so)".to_string()
            } else {
                cards.iter().map(summary).collect::<Vec<_>>().join(" | ")
            }
        );
    }
    let cards: Vec<Value> = c.agents().into_iter().filter(|x| x["name"] == name).collect();
    checks.check(
        !cards.is_empty() && c.vanished.is_empty(),
        format!("B1 ({}): {name}'s card stays on the board", a.probe),
        format!("{} card(s), vanished {:?}", cards.len(), c.vanished.len()),
    );
}

/// Lab omps (name `omp`) whose command line resumes `file`.
fn omps_on(lab: &Lab, file: &str) -> Vec<u32> {
    lab_procs(&lab.name)
        .into_iter()
        .filter(|(_, v)| {
            v.first().is_some_and(|p| p.rsplit('/').next() == Some("omp"))
                && v.iter().any(|x| x == &format!("--resume={file}"))
        })
        .map(|x| x.0)
        .collect()
}

/// Signals one lab omp, after checking its command line and environment right before.
fn signal(lab: &Lab, pid: u64, sig: &str) -> bool {
    let argv = cmdline(pid);
    assert!(
        argv.first().is_some_and(|p| p.rsplit('/').next() == Some("omp"))
            && environ_has(pid, &format!("TF_LAB={}", lab.name)),
        "refusing to signal {pid}: {argv:?}"
    );
    println!("  kill -{sig} {pid} ({})", argv.join(" "));
    Command::new("kill")
        .args([format!("-{sig}"), pid.to_string()])
        .status()
        .is_ok_and(|s| s.success())
}

/// The ledger's entry of agent `name`: its `ends` and `hold`.
fn ledger_entry(lab: &Lab, name: &str) -> String {
    let raw = std::fs::read_to_string(lab.home.join("ledger.json")).unwrap_or_default();
    let v: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let mut out = vec![];
    for sess in v["sessions"].as_object().into_iter().flatten() {
        for (id, e) in sess.1.as_object().into_iter().flatten() {
            if e["record"]["name"] == name {
                out.push(format!(
                    "{id}: ends={} hold={} endReason={}",
                    e["ends"].as_array().map_or(0, Vec::len),
                    e["hold"],
                    e["end"]["reason"]
                ));
            }
        }
    }
    format!("{out:?}")
}

/// C13 and B4: `k1` is stopped alone with SIGTERM (held, Continue brings it back), `k2` alone with
/// SIGKILL (relaunched by itself), then herdr is stopped four times: `k3`'s fourth end within ten
/// minutes holds its ticket "keeps crashing". All three are role-A agents (idle after one reply).
fn phase_kill(c: &mut Client, a: &Args, lab: &Lab) -> Checks {
    let mut checks = Checks::default();
    println!("== 1. lab setup, agents k1 (SIGTERM), k2 (SIGKILL), k3 (herdr stops)");
    setup(a, lab, true);
    host_settings(c);
    clear_leftovers(c);
    let tag = format!("k{}", now_ms() / 1000);
    let mut ids = std::collections::BTreeMap::new();
    for n in KILL_AGENTS {
        ids.insert(n, start(c, a, "A", n, AGENTS[0].2, &tag));
    }
    let ok = c.until("k1, k2, k3 idle with live links", 240, |c| {
        KILL_AGENTS
            .iter()
            .all(|n| ready(c, n).is_some_and(|x| matches!(x["state"].as_str(), Some("idle" | "done")) && x["live"]["line"].as_str().unwrap_or("").contains("[lab-final:A]")))
    });
    assert!(ok, "k agents not idle");
    c.watch = KILL_AGENTS.iter().map(|n| (ids[n].clone(), n.to_string())).collect();
    let mut file = std::collections::BTreeMap::new();
    for n in KILL_AGENTS {
        let x = ready(c, n).unwrap();
        println!("  {n}: {}", summary(&x));
        file.insert(n, x["omp"]["sessionFile"].as_str().unwrap_or("").to_string());
    }
    let mut watch = SleepWatch::start(&lab.name);
    let log_from = file_lines(&lab.home.join("hostd.log")).len();
    fileless_b1(c, a, lab, &tag, &mut checks);

    // ── C13: SIGTERM alone, herdr up
    println!("== 2. k1: SIGTERM alone while herdr stays up");
    let k1 = ready(c, "k1").unwrap();
    let old_pid = k1["omp"]["pid"].as_u64().unwrap();
    assert!(signal(lab, old_pid, "TERM"));
    let t0 = Instant::now();
    let seen = c.until("k1 ended card", 30, |c| {
        c.agents().iter().any(|x| x["name"] == "k1" && !x["parked"]["ended"].is_null())
    });
    let card = c.agents().into_iter().find(|x| x["name"] == "k1").unwrap_or(Value::Null);
    println!("  k1 after {:.1} s: {}", t0.elapsed().as_secs_f64(), summary(&card));
    checks.check(seen, "C13: k1 becomes an ended card after SIGTERM", format!("ended={}", card["parked"]["ended"]));
    checks.check(
        card["parked"]["ended"]["cause"] == "ompKilled" || card["parked"]["ended"]["reason"].as_str().unwrap_or("").contains("SIGTERM"),
        "C13: the card names the SIGTERM",
        format!("{}", card["parked"]["ended"]),
    );
    let ended_id = card["id"].as_str().unwrap_or("").to_string();
    pump(c, &mut watch, 75);
    let cards: Vec<Value> = c.agents().into_iter().filter(|x| x["name"] == "k1").collect();
    println!("  k1 75 s later: {}", cards.iter().map(summary).collect::<Vec<_>>().join(" | "));
    println!("  ledger k1: {}", ledger_entry(lab, "k1"));
    let omps = omps_on(lab, &file["k1"]);
    checks.check(
        cards.len() == 1 && !cards[0]["parked"]["ended"].is_null() && cards[0]["id"] == ended_id.as_str() && omps.is_empty() && cards[0]["autoResume"]["status"] == "manual",
        "C13: k1 is NOT relaunched automatically (still the ended card, ticket manual, no omp on its file)",
        format!("cards {}, autoResume={}, omps on its file {omps:?}", cards.len(), cards.first().map_or(Value::Null, |x| x["autoResume"].clone())),
    );
    println!("  Continue: agent.autoResumeNow {ended_id}");
    let cont = c.call("agent.autoResumeNow", json!({"agentId": ended_id}));
    println!("  -> {cont:?}");
    let back = c.until("k1 live again", 120, |c| ready(c, "k1").is_some_and(|x| x["omp"]["pid"].as_u64() != Some(old_pid)));
    let live = ready(c, "k1");
    println!("  k1 after Continue ({:.1} s): {}", t0.elapsed().as_secs_f64(), live.as_ref().map_or("none".into(), summary));
    let argv = live.as_ref().map(|x| cmdline(x["omp"]["pid"].as_u64().unwrap_or(0))).unwrap_or_default();
    checks.check(
        cont.is_ok() && back && argv.iter().any(|x| x == &format!("--resume={}", file["k1"])) && !argv.iter().any(|x| x.starts_with("--restore")),
        "C13: Continue brings k1 back (new omp, --resume of its session file, no --restore)",
        argv.join(" "),
    );
    pump(c, &mut watch, 5);
    let left: Vec<String> = c.agents().iter().filter(|x| x["name"] == "k1" && !x["parked"]["ended"].is_null()).map(summary).collect();
    checks.check(left.is_empty(), "C13: no ended card of k1 left", format!("{left:?}"));

    // ── SIGKILL alone, herdr up
    println!("== 3. k2: SIGKILL alone while herdr stays up");
    let k2 = ready(c, "k2").unwrap();
    let old2 = k2["omp"]["pid"].as_u64().unwrap();
    let t0 = Instant::now();
    assert!(signal(lab, old2, "KILL"));
    let mut first_ended = None;
    let back = c.until("k2 relaunched by itself", 180, |c| {
        if first_ended.is_none()
            && let Some(x) = c.agents().into_iter().find(|x| x["name"] == "k2" && !x["parked"]["ended"].is_null())
        {
            println!("  k2 ended card after {:.1} s: {}", t0.elapsed().as_secs_f64(), summary(&x));
            first_ended = Some(x);
        }
        ready(c, "k2").is_some_and(|x| x["omp"]["pid"].as_u64() != Some(old2))
    });
    let live = ready(c, "k2");
    println!("  k2 after {:.1} s: {}", t0.elapsed().as_secs_f64(), live.as_ref().map_or("none".into(), summary));
    let argv = live.as_ref().map(|x| cmdline(x["omp"]["pid"].as_u64().unwrap_or(0))).unwrap_or_default();
    println!("  ledger k2: {}", ledger_entry(lab, "k2"));
    checks.check(
        back && argv.iter().any(|x| x == &format!("--resume={}", file["k2"])),
        "SIGKILL: k2 is relaunched automatically with --resume of its session file",
        format!("{:.1} s; ended card seen: {}; {}", t0.elapsed().as_secs_f64(), first_ended.as_ref().map_or("no".into(), |x| x["parked"]["ended"].to_string()), argv.join(" ")),
    );

    // ── B4: four herdr stops
    println!("== 4. B4: herdr stopped four times (k3)");
    for n in 1..=4 {
        let k3 = ready(c, "k3");
        let old3 = k3.as_ref().and_then(|x| x["omp"]["pid"].as_u64()).unwrap_or(0);
        let t0 = Instant::now();
        let (ok, out) = herdr(a, &["server", "stop"]);
        println!("  stop {n}: ok={ok} {out}");
        let ended = c.until("k3 ended", 30, |c| c.agents().iter().any(|x| x["name"] == "k3" && !x["parked"]["ended"].is_null()));
        let mut up = c.until("herdr up", if n < 4 { 120 } else { 25 }, |_| herdr_status(a)["running"] == true);
        if !up {
            println!("  stop {n}: herdr still down; herdrHealth {}", c.state["info"]["herdrHealth"]);
            println!("  host.herdrRestart -> {:?}", c.call("host.herdrRestart", json!({})).map(|h| h["state"].to_string()));
            up = c.until("herdr up after Restart herdr", 60, |_| herdr_status(a)["running"] == true);
        }
        println!("  stop {n}: k3 ended seen={ended}; herdr back={up} after {:.1} s", t0.elapsed().as_secs_f64());
        if n < 4 {
            let back = c.until("k3 back", 180, |c| ready(c, "k3").is_some_and(|x| x["omp"]["pid"].as_u64() != Some(old3)));
            println!("  stop {n}: k3 {} after {:.1} s; ledger {}", if back { "back by itself" } else { "NOT back" }, t0.elapsed().as_secs_f64(), ledger_entry(lab, "k3"));
            checks.check(ended && back, format!("B4: after herdr stop {n} k3 ended and came back by itself"), format!("{:.1} s", t0.elapsed().as_secs_f64()));
            pump(c, &mut watch, 5);
        } else {
            pump(c, &mut watch, 90);
            let cards: Vec<Value> = c.agents().into_iter().filter(|x| x["name"] == "k3").collect();
            println!("  stop 4, 90 s later: {}", cards.iter().map(summary).collect::<Vec<_>>().join(" | "));
            println!("  ledger k3: {}", ledger_entry(lab, "k3"));
            let omps = omps_on(lab, &file["k3"]);
            let reason = cards.first().map(|x| x["autoResume"]["reason"].as_str().unwrap_or("").to_string()).unwrap_or_default();
            checks.check(
                ended && cards.len() == 1 && !cards[0]["parked"]["ended"].is_null() && omps.is_empty() && cards[0]["autoResume"]["status"] == "manual" && reason.contains("keeps crashing"),
                "B4: the fourth end within ten minutes holds k3 with \"keeps crashing\" (no relaunch)",
                format!("reason={reason:?}, omps on its file {omps:?}"),
            );
            if let Some(card) = cards.first() {
                let id = card["id"].as_str().unwrap_or("").to_string();
                let cont = c.call("agent.autoResumeNow", json!({"agentId": id}));
                println!("  Continue k3 -> {cont:?}");
                let back = c.until("k3 live after Continue", 120, |c| ready(c, "k3").is_some());
                checks.check(back, "B4: Continue brings the held k3 back", ready(c, "k3").map_or("none".into(), |x| summary(&x)));
            }
        }
    }
    hostd_excerpt(lab, log_from);
    checks
}

/// Fileless first turns (omp never wrote the session file): `e1`, `e2` (role D streaming its held
/// reply) and `e5` (the same with an image in the first prompt) are SIGKILLed together. Their
/// cards must wait as manual tickets ("before its first reply", prompt kept) and not be started
/// again by themselves for 65 s. Then `e1` is opened (`session.open`) and continued twice (the
/// second Continue is `busy`), `e2` gets a typed prompt, `e5` is continued. Each prompt reaches the
/// model exactly once (e5 with its image); the old cards stay while the successors have not
/// replied and go once they did.
fn fileless_b1(c: &mut Client, a: &Args, lab: &Lab, tag: &str, checks: &mut Checks) {
    println!("== B1: fileless ended cards (manual tickets, Continue / typed prompt)");
    let mut watch = SleepWatch::start(&lab.name);
    // name, run tag, agent id, omp pid, mock log offset
    let mut es: Vec<(&str, String, String, u64, usize)> = vec![];
    for (name, image) in [("e1", false), ("e2", false), ("e5", true)] {
        let tag_n = format!("{tag}{name}");
        let id = if image { start_img(c, a, "D", name, AGENTS[3].2, &tag_n) } else { start(c, a, "D", name, AGENTS[3].2, &tag_n) };
        c.watch.push((id.clone(), name.to_string()));
        let up = c.until(&format!("{name} streaming"), 120, |c| c.agent(&id)["live"]["streaming"] == true && ready(c, name).is_some());
        let e = c.agent(&id);
        let (pid, file) = (e["omp"]["pid"].as_u64().unwrap_or(0), e["omp"]["sessionFile"].as_str().unwrap_or("").to_string());
        println!("  {name}: streaming={up}; {}; file {file} exists={}", summary(&e), Path::new(&file).exists());
        assert!(up, "{name} not streaming");
        es.push((name, tag_n, id, pid, 0));
    }
    for e in es.iter_mut() {
        e.4 = file_lines(&lab.mock_log).len();
    }
    for e in &es {
        assert!(signal(lab, e.3, "KILL"));
    }
    let seen = c.until("e1, e2, e5 ended cards", 40, |c| {
        es.iter().all(|e| c.agents().iter().any(|x| x["name"] == e.0 && !x["parked"]["ended"].is_null()))
    });
    println!("  all three ended: {seen}; waiting 65 s: none may be started again by itself");
    pump(c, &mut watch, 65);
    for e in &es {
        let cards: Vec<Value> = c.agents().into_iter().filter(|x| x["name"] == e.0).collect();
        let lines = file_lines(&lab.mock_log);
        let later = requests(&lines[e.4.min(lines.len())..], "D", &e.1).len();
        let reason = cards.first().map(|x| x["autoResume"]["reason"].as_str().unwrap_or("").to_string()).unwrap_or_default();
        let (prompts, imgs) = ledger_kept(lab, e.0);
        println!("  {}: {} | ledger kept prompts={prompts} images={imgs}", e.0, cards.iter().map(summary).collect::<Vec<_>>().join(" | "));
        checks.check(
            seen && cards.len() == 1 && !cards[0]["parked"]["ended"].is_null() && cards[0]["autoResume"]["status"] == "manual" && reason.contains("before its first reply") && later == 0 && prompts >= 1 && (e.0 != "e5" || imgs >= 1),
            format!("B1 {}: manual card, not started by itself in 65 s, prompt{} kept", e.0, if e.0 == "e5" { " and image" } else { "" }),
            format!("reason={reason:?}, model requests after the end {later}, kept prompts={prompts} images={imgs}"),
        );
    }
    // e1: opened, then Continue twice.
    let card_id = |c: &Client, n: &str| c.agents().iter().find(|x| x["name"] == n && !x["parked"]["ended"].is_null()).map(|x| x["id"].as_str().unwrap_or("").to_string()).unwrap_or_default();
    let id1 = card_id(c, "e1");
    let opened = c.call("session.open", json!({"agentId": id1}));
    println!("  e1: session.open -> {}", opened.as_ref().map(|s| format!("ok, {} item(s)", s["items"].as_array().map_or(0, Vec::len))).unwrap_or_else(|e| format!("error {e}")));
    let _ = c.call("session.close", json!({"agentId": id1}));
    pump(c, &mut watch, 3);
    checks.check(card_id(c, "e1") == id1, "B1 e1: session.open leaves the fileless card where it was", id1.clone());
    let first = c.call("agent.autoResumeNow", json!({"agentId": id1}));
    let second = c.call("agent.autoResumeNow", json!({"agentId": id1}));
    println!("  e1: Continue -> {first:?}; Continue again at once -> {second:?}");
    checks.check(first.is_ok(), "B1 e1: Continue starts it again", format!("{first:?}"));
    checks.check(second.as_ref().err().is_some_and(|e| e["code"] == "busy"), "B1 e1: a second Continue right after is busy", format!("{second:?}"));
    // e2: a prompt typed on the card is refused (retryable, draft kept); Continue starts the kept prompt.
    let id2 = card_id(c, "e2");
    let typed = c.call("agent.prompt", json!({"agentId": id2, "text": "lab probe: are you still there?", "delivery": "auto"}));
    println!("  e2: agent.prompt -> {typed:?}");
    checks.check(typed.as_ref().err().is_some_and(|e| e["retryable"] == true), "B1 e2: a typed prompt on the fileless card is refused with a retryable error", format!("{typed:?}"));
    pump(c, &mut watch, 2);
    checks.check(card_id(c, "e2") == id2, "B1 e2: the refused prompt leaves the card where it was", id2.clone());
    let cont2 = c.call("agent.autoResumeNow", json!({"agentId": id2}));
    println!("  e2: Continue -> {cont2:?}");
    checks.check(cont2.is_ok(), "B1 e2: Continue starts its kept prompt", format!("{cont2:?}"));
    // e5: Continue.
    let id5 = card_id(c, "e5");
    let cont5 = c.call("agent.autoResumeNow", json!({"agentId": id5}));
    println!("  e5: Continue -> {cont5:?}");
    checks.check(cont5.is_ok(), "B1 e5: Continue starts it again", format!("{cont5:?}"));
    let back = c.until("e1, e2, e5 live again", 150, |c| es.iter().all(|e| ready(c, e.0).is_some_and(|x| x["omp"]["pid"].as_u64() != Some(e.3))));
    pump(c, &mut watch, 25);
    checks.check(back, "B1: e1, e2 and e5 are live again (new omp)", format!("{back}"));
    for e in &es {
        exact_once(checks, &format!("B1 {}", e.0), lab, &e.1, e.4, e.0 == "e5");
        let cards: Vec<Value> = c.agents().into_iter().filter(|x| x["name"] == e.0).collect();
        println!("  {} while the successor has not replied: {}", e.0, cards.iter().map(summary).collect::<Vec<_>>().join(" | "));
        println!("  {}: {} card(s) named so (the successor takes the pane's agent id)", e.0, cards.len());
    }
    let _ = std::fs::remove_file(&lab.hold);
    let gone = c.until("old cards gone", 150, |c| es.iter().all(|e| c.agents().iter().filter(|x| x["name"] == e.0).count() == if e.0 == "e5" { 2 } else { 1 }));
    for e in &es {
        let cards: Vec<Value> = c.agents().into_iter().filter(|x| x["name"] == e.0).collect();
        println!("  {} after the reply: {}", e.0, cards.iter().map(summary).collect::<Vec<_>>().join(" | "));
        println!("  ledger {}: {}", e.0, ledger_entry(lab, e.0));
    }
    checks.check(gone, "B1: each old card goes once its successor replied (e5, an image prompt, keeps its old card by design)", format!("{gone}"));
}

/// (prompts, images) the ledger keeps for the agent named `name`.
fn ledger_kept(lab: &Lab, name: &str) -> (usize, usize) {
    let raw = std::fs::read_to_string(lab.home.join("ledger.json")).unwrap_or_default();
    let v: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    for sess in v["sessions"].as_object().into_iter().flatten() {
        for (_, e) in sess.1.as_object().into_iter().flatten() {
            if e["record"]["name"] == name {
                return (e["prompts"].as_array().map_or(0, Vec::len), e["images"].as_array().map_or(0, Vec::len));
            }
        }
    }
    (0, 0)
}

/// `key<digits>` from a mock log line.
fn field(line: &str, key: &str) -> u32 {
    line.split_whitespace().find_map(|w| w.strip_prefix(key)).and_then(|v| v.parse().ok()).unwrap_or(0)
}

/// After a relaunch (mock log line `off` on): exactly one `step=reply` request of D run `tag`,
/// carrying the prompt once (`users=1`) and, with `imgs`, exactly one image.
fn exact_once(checks: &mut Checks, label: &str, lab: &Lab, tag: &str, off: usize, imgs: bool) {
    let lines = file_lines(&lab.mock_log);
    let after = &lines[off.min(lines.len())..];
    let reqs: Vec<&String> = requests(after, "D", tag).into_iter().filter(|l| l.contains("step=reply")).collect();
    let users = reqs.iter().map(|l| field(l, "users=")).max().unwrap_or(0);
    let images = reqs.iter().map(|l| field(l, "imgs=")).max().unwrap_or(0);
    checks.check(
        reqs.len() == 1 && users == 1 && (!imgs || images == 1),
        format!("{label}: prompt delivered exactly once{}", if imgs { " with its image" } else { "" }),
        format!("{} request(s) after the relaunch, users={users}, imgs={images}{}", reqs.len(), show(&reqs)),
    );
}

const PNG_1X1: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/// Like [`start`], with an image in the first prompt.
fn start_img(c: &mut Client, a: &Args, role: &str, name: &str, task: &str, tag: &str) -> String {
    let spec = json!({"name": name, "kind": "omp", "model": a.model, "plan": false, "prompt": format!("LIFEBOAT-LAB role={role} run={tag}: {task}"), "images": [{"mime": "image/png", "data": PNG_1X1}]});
    let target = json!({"kind": "cwd", "cwd": a.work, "label": format!("lifeboat-{name}")});
    let started = c
        .call("agent.start", json!({"target": target, "spec": spec}))
        .unwrap_or_else(|e| panic!("agent.start {name}: {e}"));
    let id = started["agentId"].as_str().expect("agent id").to_string();
    println!("  {name} (role {role}, with an image): agent {id}, pane {}", started["paneId"].as_str().unwrap_or(""));
    id
}

/// hostd killed right after a manual Continue's `agent start`: `e3` (text prompt) and `e4` (prompt
/// with an image) are fileless agents whose omp is SIGKILLed (their cards wait as manual tickets).
/// Continue is sent, and the moment hostd logs the successor's `agent start` it is SIGKILLed and
/// started again. Afterwards the old card is still there or the successor has its prompt, and the
/// prompt reaches the model at most once (the image too); a Continue right after is `busy` or
/// starts nothing twice.
fn phase_handoff(c: &mut Client, a: &Args, lab: &Lab) -> Checks {
    let mut checks = Checks::default();
    println!("== 1. lab setup");
    setup(a, lab, true);
    host_settings(c);
    clear_leftovers(c);
    let base = format!("h{}", now_ms() / 1000);
    let log_path = lab.home.join("hostd.log");
    for (name, image) in [("e3", false), ("e4", true)] {
        let tag = format!("{base}{name}");
        std::fs::write(&lab.hold, "e2e_lifeboat: hold\n").unwrap();
        println!("== handoff {name} ({}): omp SIGKILL, Continue, hostd SIGKILL at the successor's agent start", if image { "prompt with image" } else { "text prompt" });
        let id = if image { start_img(c, a, "D", name, AGENTS[3].2, &tag) } else { start(c, a, "D", name, AGENTS[3].2, &tag) };
        let up = c.until(&format!("{name} streaming"), 120, |c| c.agent(&id)["live"]["streaming"] == true && ready(c, name).is_some());
        let e = c.agent(&id);
        let (pid, file) = (e["omp"]["pid"].as_u64().unwrap_or(0), e["omp"]["sessionFile"].as_str().unwrap_or("").to_string());
        println!("  {name}: {}; file exists={}", summary(&e), Path::new(&file).exists());
        assert!(up, "{name} not streaming");
        let off = file_lines(&lab.mock_log).len();
        assert!(signal(lab, pid, "KILL"));
        let manual = c.until(&format!("{name} ended card with a manual ticket"), 40, |c| {
            c.agents().iter().any(|x| x["name"] == name && !x["parked"]["ended"].is_null() && x["autoResume"]["status"] == "manual")
        });
        let card = c.agents().into_iter().find(|x| x["name"] == name).unwrap_or(Value::Null);
        let card_id = card["id"].as_str().unwrap_or("").to_string();
        println!("  {name} ended: {}", summary(&card));
        checks.check(manual, format!("handoff {name}: ended card with a manual ticket"), format!("{}", card["autoResume"]));
        let log_from = file_lines(&log_path).len();
        let t0 = Instant::now();
        c.send(json!({"t": "req", "id": 900, "method": "agent.autoResumeNow", "params": {"agentId": card_id}}));
        let needle = format!("agent start name={name} ");
        let mut started = false;
        while t0.elapsed() < Duration::from_secs(60) {
            if file_lines(&log_path).iter().skip(log_from).any(|l| l.contains(&needle)) {
                started = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let daemons: Vec<u32> = lab_procs(&lab.name)
            .into_iter()
            .filter(|(_, v)| v.first().is_some_and(|p| p.ends_with("tf-hostd")) && v.iter().any(|x| x == "daemon"))
            .map(|x| x.0)
            .collect();
        for p in &daemons {
            let argv = cmdline(u64::from(*p));
            assert!(argv.first().is_some_and(|x| x.ends_with("tf-hostd")) && argv.iter().any(|x| x == "daemon"));
            let _ = Command::new("kill").args(["-KILL", &p.to_string()]).status();
        }
        println!("  {name}: Continue sent; hostd logged the successor's start after {:.2} s: {started}; daemon {daemons:?} SIGKILLed; ledger {}", t0.elapsed().as_secs_f64(), ledger_entry(lab, name));
        checks.check(started && daemons.len() == 1, format!("handoff {name}: hostd killed right after Continue's agent start"), format!("started={started} daemons={daemons:?}"));
        let _ = c.child.kill();
        let _ = c.child.wait();
        std::thread::sleep(Duration::from_secs(1));
        *c = Client::attach("lifeboat-2", a);
        c.until("settle", 40, |_| false);
        let cards: Vec<Value> = c.agents().into_iter().filter(|x| x["name"] == name).collect();
        println!("  {name} cards after hostd restarted: {}", cards.iter().map(summary).collect::<Vec<_>>().join(" | "));
        println!("  ledger {name}: {} kept (prompts, images) {:?}", ledger_entry(lab, name), ledger_kept(lab, name));
        let lines = file_lines(&lab.mock_log);
        let reqs: Vec<&String> = requests(&lines[off.min(lines.len())..], "D", &tag).into_iter().filter(|l| l.contains("step=reply")).collect();
        let (users, imgs) = (reqs.iter().map(|l| field(l, "users=")).max().unwrap_or(0), reqs.iter().map(|l| field(l, "imgs=")).max().unwrap_or(0));
        let old = cards.iter().find(|x| !x["parked"]["ended"].is_null());
        let succ = cards.iter().find(|x| x["parked"].is_null());
        checks.check(
            old.is_some() || (succ.is_some() && reqs.len() == 1),
            format!("handoff {name}: after the restart the old card is still there, or the successor has its prompt"),
            format!("old card={}, successor={}, {} request(s) after the Continue", old.is_some(), succ.is_some(), reqs.len()),
        );
        checks.check(
            reqs.len() <= 1 && users <= 1 && (!image || imgs <= 1),
            format!("handoff {name}: the prompt reached the model at most once"),
            format!("{} request(s), users={users}, imgs={imgs}{}", reqs.len(), show(&reqs)),
        );
        if image && reqs.len() == 1 {
            checks.check(imgs == 1, "handoff e4: the delivered prompt carries its image", format!("imgs={imgs}"));
        }
        if succ.is_some() && reqs.is_empty() {
            println!("  NOTE {name}: a successor lives but its prompt never reached the model (hostd died before delivering it)");
        }
        // A Continue now: busy (a successor lives or was started a moment ago), never a second start.
        if let Some(o) = old {
            let oid = o["id"].as_str().unwrap_or("").to_string();
            let again = c.call("agent.autoResumeNow", json!({"agentId": oid}));
            println!("  {name}: Continue on the old card now -> {again:?}");
            let busy = again.as_ref().err().is_some_and(|e| e["code"] == "busy");
            checks.check(busy, format!("handoff {name}: Continue on the old card right after the restart is busy"), format!("{again:?}"));
        }
        let _ = std::fs::remove_file(&lab.hold);
        let settled = c.until(&format!("{name}: one live card, no ended card"), 150, |c| {
            let cs: Vec<Value> = c.agents().into_iter().filter(|x| x["name"] == name).collect();
            cs.len() == 1 && cs[0]["parked"].is_null()
        });
        c.until("delivery settles", 150, |_| {
            let lines = file_lines(&lab.mock_log);
            requests(&lines[off.min(lines.len())..], "D", &tag).iter().any(|l| l.contains("step=reply"))
        });
        c.until("no duplicate follows", 20, |_| false);
        let cards: Vec<Value> = c.agents().into_iter().filter(|x| x["name"] == name).collect();
        println!("  {name} at the end (hold removed): settled={settled}: {}", cards.iter().map(summary).collect::<Vec<_>>().join(" | "));
        let lines = file_lines(&lab.mock_log);
        let reqs: Vec<&String> = requests(&lines[off.min(lines.len())..], "D", &tag).into_iter().filter(|l| l.contains("step=reply")).collect();
        let users = reqs.iter().map(|l| field(l, "users=")).max().unwrap_or(0);
        checks.check(reqs.len() == 1 && users == 1 && (!image || reqs.iter().map(|l| field(l, "imgs=")).max().unwrap_or(0) == 1), format!("handoff {name}: the prompt was delivered exactly once by the end{}", if image { " with its image" } else { "" }), format!("{} request(s), users={users}{}", reqs.len(), show(&reqs)));
        let live = cards.iter().filter(|x| x["parked"].is_null()).count();
        checks.check(live == 1 && cards.len() == if image { 2 } else { 1 }, format!("handoff {name}: one live agent at the end{}", if image { " (the old image card stays by design)" } else { ", no old card" }), format!("{} card(s), {live} live", cards.len()));
    }
    hostd_excerpt(lab, 0);
    checks
}

/// The prompts the ledger keeps for the agent named `name` (one entry per session; the first match).
fn ledger_prompts(lab: &Lab, name: &str) -> Vec<String> {
    let raw = std::fs::read_to_string(lab.home.join("ledger.json")).unwrap_or_default();
    let v: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let mut out = vec![];
    for sess in v["sessions"].as_object().into_iter().flatten() {
        for (_, e) in sess.1.as_object().into_iter().flatten() {
            if e["record"]["name"] == name {
                out.extend(e["prompts"].as_array().into_iter().flatten().map(|p| p.as_str().unwrap_or("").to_string()));
            }
        }
    }
    out
}

fn ended_card(c: &Client, n: &str) -> Option<Value> {
    c.agents().into_iter().find(|x| x["name"] == n && !x["parked"]["ended"].is_null())
}

/// Agent ids are reused by herdr: with a fileless manual card `ca` waiting, a NEW ordinary agent
/// `cb` is started in ca's pane (it gets ca's freed id) and SIGKILLed while fileless. cb's card
/// must hold cb's prompt, ca's card must still exist with ca's prompt; Continue on each replays
/// its own prompt exactly once. Then `ci` (first prompt with an image) is continued, settles, gets
/// its session file, is SIGKILLed once more and must come back by itself with `--resume`.
fn phase_collide(c: &mut Client, a: &Args, lab: &Lab) -> Checks {
    let mut checks = Checks::default();
    println!("== 1. lab setup");
    setup(a, lab, true);
    host_settings(c);
    clear_leftovers(c);
    let base = format!("c{}", now_ms() / 1000);
    let (tag_a, tag_b, tag_i) = (format!("{base}ca"), format!("{base}cb"), format!("{base}ci"));
    let streaming = |c: &mut Client, id: &str, n: &str| c.until(&format!("{n} streaming"), 120, |c| c.agent(id)["live"]["streaming"] == true && ready(c, n).is_some());
    println!("== 2. ca: fileless, killed -> manual card");
    let id_a = start(c, a, "D", "ca", AGENTS[3].2, &tag_a);
    assert!(streaming(c, &id_a, "ca"));
    let ea = c.agent(&id_a);
    let (pid_a, pane_a) = (ea["omp"]["pid"].as_u64().unwrap_or(0), ea["paneId"].as_str().unwrap_or("").to_string());
    println!("  ca: {}", summary(&ea));
    assert!(signal(lab, pid_a, "KILL"));
    let manual = c.until("ca manual card", 40, |c| ended_card(c, "ca").is_some_and(|x| x["autoResume"]["status"] == "manual"));
    checks.check(manual, "collide: ca is a fileless manual ended card", format!("{}", ended_card(c, "ca").map_or(Value::Null, |x| x["autoResume"].clone())));
    println!("== 3. cb: a NEW agent started in ca's pane {pane_a}");
    let spec = json!({"name": "cb", "kind": "omp", "model": a.model, "plan": false, "prompt": format!("LIFEBOAT-LAB role=D run={tag_b}: {}", AGENTS[3].2)});
    let started = c.call("agent.start", json!({"target": {"kind": "pane", "paneId": pane_a}, "spec": spec})).unwrap_or_else(|e| panic!("agent.start cb: {e}"));
    let id_b = started["agentId"].as_str().unwrap_or("").to_string();
    println!("  cb: agent {id_b} (ca had {id_a})");
    checks.check(id_b == id_a, "collide: cb got ca's freed agent id", format!("cb={id_b} ca={id_a}"));
    assert!(streaming(c, &id_b, "cb"));
    let eb = c.agent(&id_b);
    println!("  cb: {}", summary(&eb));
    let ca_now: Vec<Value> = c.agents().into_iter().filter(|x| x["name"] == "ca").collect();
    println!("  ca cards while cb lives: {}", ca_now.iter().map(summary).collect::<Vec<_>>().join(" | "));
    checks.check(ca_now.iter().any(|x| !x["parked"]["ended"].is_null()), "collide: ca's ended card is still on the board while cb lives", format!("{} card(s) named ca", ca_now.len()));
    let (off_a, pid_b) = (file_lines(&lab.mock_log).len(), eb["omp"]["pid"].as_u64().unwrap_or(0));
    assert!(signal(lab, pid_b, "KILL"));
    let manual_b = c.until("cb manual card", 40, |c| ended_card(c, "cb").is_some_and(|x| x["autoResume"]["status"] == "manual"));
    pump_quiet(c, 5);
    println!("  ledger ca: {:?} | cb: {:?}", ledger_prompts(lab, "ca"), ledger_prompts(lab, "cb"));
    let (pa, pb) = (ledger_prompts(lab, "ca"), ledger_prompts(lab, "cb"));
    checks.check(manual_b && pb.len() == 1 && pb[0].contains(&tag_b) && !pb[0].contains(&tag_a), "collide: cb's card holds cb's prompt", format!("{pb:?}"));
    checks.check(ended_card(c, "ca").is_some() && pa.len() == 1 && pa[0].contains(&tag_a), "collide: ca's card still exists with ca's prompt", format!("{pa:?}"));
    println!("== 4. Continue cb, then ca");
    let cb_card = ended_card(c, "cb").map(|x| x["id"].as_str().unwrap_or("").to_string()).unwrap_or_default();
    let cont_b = c.call("agent.autoResumeNow", json!({"agentId": cb_card}));
    let again_b = c.call("agent.autoResumeNow", json!({"agentId": cb_card}));
    println!("  cb: Continue -> {cont_b:?}; again -> {again_b:?}");
    checks.check(cont_b.is_ok(), "collide: Continue on cb starts it", format!("{cont_b:?}"));
    checks.check(again_b.as_ref().err().is_some_and(|e| e["code"] == "busy"), "collide: a second Continue on cb is busy", format!("{again_b:?}"));
    c.until("cb live", 120, |c| ready(c, "cb").is_some_and(|x| x["omp"]["pid"].as_u64() != Some(pid_b)));
    let ca_card = ended_card(c, "ca").map(|x| x["id"].as_str().unwrap_or("").to_string()).unwrap_or_default();
    println!("  ca card id now {ca_card}");
    let cont_a = c.call("agent.autoResumeNow", json!({"agentId": ca_card}));
    println!("  ca: Continue -> {cont_a:?}");
    checks.check(cont_a.is_ok(), "collide: Continue on ca starts it", format!("{cont_a:?}"));
    c.until("ca live", 120, |c| ready(c, "ca").is_some_and(|x| x["omp"]["pid"].as_u64() != Some(pid_a)));
    let _ = std::fs::remove_file(&lab.hold);
    c.until("replies settle", 60, |_| false);
    exact_once(&mut checks, "collide cb", lab, &tag_b, off_a, false);
    exact_once(&mut checks, "collide ca (its own prompt, once)", lab, &tag_a, off_a, false);
    let lines = file_lines(&lab.mock_log);
    let cross = requests(&lines[off_a.min(lines.len())..], "D", &tag_a).len() + requests(&lines[off_a.min(lines.len())..], "D", &tag_b).len();
    checks.check(cross == 2 || cross == 4, "collide: no prompt replayed into the wrong agent", format!("{cross} D request(s) in total (reply+title per run)"));
    for n in ["ca", "cb"] {
        let cards: Vec<Value> = c.agents().into_iter().filter(|x| x["name"] == n).collect();
        println!("  {n} at the end: {}", cards.iter().map(summary).collect::<Vec<_>>().join(" | "));
        checks.check(cards.len() == 1 && cards[0]["parked"].is_null(), format!("collide: {n} ends as one live agent"), format!("{} card(s)", cards.len()));
    }
    println!("== 5. ci: image prompt, Continue, then SIGKILL after it has its session file");
    std::fs::write(&lab.hold, "hold\n").unwrap();
    let id_i = start_img(c, a, "D", "ci", AGENTS[3].2, &tag_i);
    assert!(streaming(c, &id_i, "ci"));
    let pid_i = c.agent(&id_i)["omp"]["pid"].as_u64().unwrap_or(0);
    assert!(signal(lab, pid_i, "KILL"));
    let man_i = c.until("ci manual card", 40, |c| ended_card(c, "ci").is_some_and(|x| x["autoResume"]["status"] == "manual"));
    let ci_card = ended_card(c, "ci").map(|x| x["id"].as_str().unwrap_or("").to_string()).unwrap_or_default();
    let off_i = file_lines(&lab.mock_log).len();
    let cont_i = c.call("agent.autoResumeNow", json!({"agentId": ci_card}));
    println!("  ci: manual={man_i}; Continue -> {cont_i:?}");
    let _ = std::fs::remove_file(&lab.hold);
    let live_i = c.until("ci live and replied", 150, |c| {
        ready(c, "ci").is_some_and(|x| x["omp"]["pid"].as_u64() != Some(pid_i) && x["omp"]["sessionFile"].as_str().is_some_and(|f| Path::new(f).exists()))
    });
    c.until("settle", 45, |_| false);
    let cards: Vec<Value> = c.agents().into_iter().filter(|x| x["name"] == "ci").collect();
    println!("  ci after settling: {}", cards.iter().map(summary).collect::<Vec<_>>().join(" | "));
    println!("  ledger ci: {}", ledger_entry(lab, "ci"));
    checks.check(live_i && cards.iter().filter(|x| x["parked"].is_null()).count() == 1 && cards.len() <= 2, "collide: ci settles as one live agent with a session file (an old image card may stay by design)", format!("live={live_i}, {} card(s)", cards.len()));
    exact_once(&mut checks, "collide ci", lab, &tag_i, off_i, true);
    if let Some(x) = ready(c, "ci") {
        let (pid2, file2) = (x["omp"]["pid"].as_u64().unwrap_or(0), x["omp"]["sessionFile"].as_str().unwrap_or("").to_string());
        assert!(signal(lab, pid2, "KILL"));
        let back = c.until("ci back by itself", 180, |c| ready(c, "ci").is_some_and(|y| y["omp"]["pid"].as_u64() != Some(pid2)));
        let argv = ready(c, "ci").map(|y| cmdline(y["omp"]["pid"].as_u64().unwrap_or(0))).unwrap_or_default();
        println!("  ci after SIGKILL: back={back}; {}", argv.join(" "));
        checks.check(back && argv.iter().any(|x| x == &format!("--resume={file2}")) && !argv.iter().any(|x| x.starts_with("--restore")), "collide: ci (with a session file) comes back by itself via --resume", argv.join(" "));
    } else {
        checks.check(false, "collide: ci comes back by itself via --resume", "ci not live".to_string());
    }
    hostd_excerpt(lab, 0);
    checks
}

fn pump_quiet(c: &mut Client, secs: u64) {
    c.until("quiet", secs, |_| false);
}

/// The role-A agents of `--phase kill`.
const KILL_AGENTS: [&str; 3] = ["k1", "k2", "k3"];

fn main() {
    let a = args();
    let lab = Lab::from_env(&a);
    println!(
        "== e2e_lifeboat {:?}: lab {} (TF_LAB={}), session {}, hostd {}",
        a.phase,
        lab.root.display(),
        lab.name,
        a.session,
        a.hostd
    );
    match a.phase {
        Phase::Prepare => {
            let mut c = Client::attach("lifeboat", &a);
            let prep = prepare(&mut c, &a, &lab);
            std::fs::write(&lab.prepared, serde_json::to_string_pretty(&prep).unwrap()).unwrap();
            c.close();
            println!(
                "== prepared: {} (run reboot.sh now: C's bash step ends 30 s after it started)",
                lab.prepared.display()
            );
        }
        Phase::Herdr => {
            let mut c = Client::attach("lifeboat", &a);
            let prep = prepare(&mut c, &a, &lab);
            std::fs::write(&lab.prepared, serde_json::to_string_pretty(&prep).unwrap()).unwrap();
            let checks = phase_herdr(&mut c, &a, &lab, &prep);
            c.close();
            checks.finish(a.phase);
        }
        Phase::Reboot => phase_reboot(&a, &lab).finish(a.phase),
        Phase::Kill => {
            let mut c = Client::attach("lifeboat", &a);
            let checks = phase_kill(&mut c, &a, &lab);
            c.close();
            checks.finish(a.phase)
        }
        Phase::Handoff => {
            let mut c = Client::attach("lifeboat", &a);
            let checks = phase_handoff(&mut c, &a, &lab);
            c.close();
            checks.finish(a.phase)
        }
        Phase::Collide => {
            let mut c = Client::attach("lifeboat", &a);
            let checks = phase_collide(&mut c, &a, &lab);
            c.close();
            checks.finish(a.phase)
        }
    }
}
