//! Lab run of "make this host like that one" (architecture §3.24) between two isolated labs
//! (`scripts/lab/run`, AGENTS.md): each host has its own lab, so its own HOME, hostd home, omp
//! agent dir, herdr session (`tf-lab-<lab>`) and relay port. The daemons are driven over the
//! client protocol like the app (`tf-hostd attach`), with the real omp.
//!
//! ```sh
//! cargo build -p tf-hostd --bin tf-hostd --example e2e_hostsync
//! scripts/lab/run hostsync-a -- bun crates/tf-hostd/examples/e2e_hostsync_mock.ts &   # mock provider on 47646
//! scripts/lab/run hostsync-a -- target/debug/examples/e2e_hostsync --tools-home "$HOME" \
//!   --hostd target/debug/tf-hostd --a hostsync-a --b hostsync-b --relay-a 47606 --relay-b 47616 \
//!   [--mock-port 47646] [--prepare-only]
//! scripts/lab/stop hostsync-a; scripts/lab/stop hostsync-b
//! ```
//!
//! Run from the repo root with both labs stopped. Every omp command and daemon goes through
//! `scripts/lab/run <lab>` (with `--tools-home` as the HOME whose `~/.local/bin` / `~/.bun/bin`
//! hold omp and herdr, so a run from inside a lab finds them too). Prepares both labs through the
//! real omp: settings, model roles, a credential setting, MCP servers, `labmock` (a custom
//! provider served by `e2e_hostsync_mock.ts`) and made-up sign-ins through `omp auth import`, for
//! providers no real service knows, so nothing ever reaches a real provider. Then export on A →
//! plan on B → one-time key on B → seal on A → apply on B, and checks B with omp's own CLI, that
//! B's omp now answers with A's API key (with `--mock-port`), that a replayed or tampered box is
//! refused, and that no secret appeared in any line the harness sent or either daemon sent, nor
//! in either hostd.log. The daemons keep running for `scripts/lab/stop`. `--prepare-only` only
//! prepares the two labs (for the UI lab, whose app starts the daemons).

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// Every secret the labs hold: none may appear on the wire or in a log.
const SECRETS: [&str; 6] = ["LAB-MOCK-KEY-A", "LAB-OAUTH-ACCESS", "LAB-OAUTH-REFRESH", "LAB-SEARX-SECRET", "LAB-MCP-SECRET", "LAB-B-OWN-KEY"];

/// Both labs' omp `models.yml` (`PORT`: the mock's). `auth: oauth` without an `apiKey`: the key
/// comes from omp's credential store (`omp auth import`); a key in this file would win over it.
const MODELS_YML: &str = "\
# HostSync lab: provider `labmock`, served by the lab's mock on 127.0.0.1:PORT. Its API key is the
# sign-in in omp's credential store (`omp auth import`), so this file names none.
providers:
  labmock:
    baseUrl: http://127.0.0.1:PORT/v1
    api: openai-completions
    auth: oauth
    models:
      - id: lab-sync
        name: HostSync Lab Mock
        reasoning: false
        input: [text]
        contextWindow: 128000
        maxTokens: 8192
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
";

struct Args {
    hostd: PathBuf,
    omp: String,
    tools_home: String,
    a: String,
    b: String,
    relay_a: u16,
    relay_b: u16,
    mock_port: Option<u16>,
    prepare_only: bool,
}

fn args() -> Args {
    let mut a = Args {
        hostd: "target/debug/tf-hostd".into(),
        omp: "omp".into(),
        tools_home: String::new(),
        a: "hostsync-a".into(),
        b: "hostsync-b".into(),
        relay_a: 47606,
        relay_b: 47616,
        mock_port: None,
        prepare_only: false,
    };
    let mut it = std::env::args().skip(1);
    while let Some(k) = it.next() {
        let mut v = || it.next().expect("missing value");
        match k.as_str() {
            "--hostd" => a.hostd = v().into(),
            "--omp" => a.omp = v(),
            "--tools-home" => a.tools_home = v(),
            "--a" => a.a = v(),
            "--b" => a.b = v(),
            "--relay-a" => a.relay_a = v().parse().expect("port"),
            "--relay-b" => a.relay_b = v().parse().expect("port"),
            "--mock-port" => a.mock_port = Some(v().parse().expect("port")),
            "--prepare-only" => a.prepare_only = true,
            other => panic!("unknown arg {other}"),
        }
    }
    if a.tools_home.is_empty() {
        assert!(std::env::var_os("TF_LAB").is_none(), "inside a lab, pass --tools-home (the HOME whose ~/.local/bin and ~/.bun/bin hold omp and herdr)");
        a.tools_home = std::env::var("HOME").expect("HOME");
    }
    assert!(Path::new("scripts/lab/run").is_file(), "run from the repo root");
    assert_ne!(a.a, a.b, "two labs");
    a.hostd = std::fs::canonicalize(&a.hostd).expect("--hostd");
    a
}

/// One lab host (`scripts/lab/run` layout under `/tmp/tf-lab-<lab>`).
struct Lab {
    name: &'static str,
    lab: String,
    relay: u16,
}

impl Lab {
    fn root(&self) -> PathBuf {
        PathBuf::from(format!("/tmp/tf-lab-{}", self.lab))
    }

    /// `TF_HOSTD_HOME` in the lab.
    fn home(&self) -> PathBuf {
        self.root().join("teleflock")
    }

    /// `PI_CODING_AGENT_DIR` in the lab.
    fn agent(&self) -> PathBuf {
        self.root().join("omp-agent")
    }

    fn session(&self) -> String {
        format!("tf-lab-{}", self.lab)
    }

    /// `argv` inside this lab: `scripts/lab/run <lab> -- argv…` (its own clean environment).
    fn cmd(&self, a: &Args, argv: &[&str]) -> Command {
        let mut c = Command::new("scripts/lab/run");
        c.env_clear().env("HOME", &a.tools_home).env("PATH", "/usr/bin:/bin").arg(&self.lab).arg("--").args(argv);
        c
    }

    fn omp(&self, a: &Args, args: &[&str], stdin: Option<&str>) -> String {
        let mut argv = vec!["env", "NO_COLOR=1", a.omp.as_str()];
        argv.extend_from_slice(args);
        let mut child = self
            .cmd(a, &argv)
            .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("scripts/lab/run omp");
        if let Some(text) = stdin {
            child.stdin.take().unwrap().write_all(text.as_bytes()).unwrap();
        }
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "[{}] omp {}: {}", self.name, args.join(" "), String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap()
    }

    fn prepare(&self, a: &Args, settings: &[(&str, &str)], mcp: &Value, credentials: &Value) {
        let sock = self.home().join("run/hostd.sock");
        assert!(std::os::unix::net::UnixStream::connect(&sock).is_err(), "[{}] a daemon still runs in lab {}: scripts/lab/stop {} first", self.name, self.lab, self.lab);
        for dir in [self.home(), self.agent()] {
            if dir.exists() {
                std::fs::remove_dir_all(&dir).unwrap();
            }
            std::fs::create_dir_all(&dir).unwrap();
        }
        std::fs::create_dir_all(self.home().join("ext")).unwrap();
        // `hostSync.export` reads omp's settings schema through the companion extension (§3.10).
        std::fs::copy("host/teleflock-bridge/teleflock-bridge.ts", self.home().join("ext/teleflock-bridge.ts")).unwrap();
        let port = a.mock_port.unwrap_or(47646).to_string();
        std::fs::write(self.agent().join("models.yml"), MODELS_YML.replace("PORT", &port)).unwrap();
        for (k, v) in settings {
            self.omp(a, &["config", "set", "--", k, v], None);
        }
        std::fs::write(self.agent().join("mcp.json"), serde_json::to_string_pretty(mcp).unwrap()).unwrap();
        self.omp(a, &["auth", "import", "-"], Some(&credentials.to_string()));
        println!("[{}] prepared lab {} ({})", self.name, self.lab, self.root().display());
    }

    /// One prompt to the lab's mock provider; its answer names the API key it got.
    fn ask_mock(&self, a: &Args) -> String {
        self.omp(a, &["-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--model=labmock/lab-sync", "Which key?"], None)
    }
}

struct Client {
    name: &'static str,
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<String>,
    next_id: u64,
    /// Every line the daemon sent.
    seen: String,
    /// Every line sent to the daemon.
    sent: String,
    last_sent: Instant,
}

impl Client {
    fn attach(lab: &Lab, a: &Args) -> Client {
        let hostd = a.hostd.to_string_lossy();
        let relay = lab.relay.to_string();
        let session = lab.session();
        let mut child = lab
            .cmd(a, &[&hostd, "attach", "--session", &session, "--relay-port", &relay])
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
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        let mut c = Client { name: lab.name, child, stdin, rx, next_id: 1, seen: String::new(), sent: String::new(), last_sent: Instant::now() };
        c.send(json!({
            "t": "hello", "protocol": tf_proto::PROTOCOL_VERSION,
            "client": {"app": "tf-hostd-e2e", "version": "0", "platform": "linux", "device": lab.name},
            "herdrSession": session,
        }));
        c.wait("welcome", 90, |m| m["t"] == "welcome");
        c
    }

    fn send(&mut self, v: Value) {
        let line = v.to_string();
        writeln!(self.stdin, "{line}").expect("write");
        self.stdin.flush().unwrap();
        self.sent.push_str(&line);
        self.sent.push('\n');
        self.last_sent = Instant::now();
    }

    fn wait(&mut self, what: &str, secs: u64, pred: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + Duration::from_secs(secs);
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            if self.last_sent.elapsed() > Duration::from_secs(10) {
                self.send(json!({"t": "ping", "ts": 0}));
            }
            let Ok(line) = self.rx.recv_timeout(left.min(Duration::from_secs(1))) else { continue };
            self.seen.push_str(&line);
            self.seen.push('\n');
            if let Ok(m) = serde_json::from_str::<Value>(&line)
                && pred(&m)
            {
                return m;
            }
        }
        panic!("[{}] timed out after {secs}s waiting for {what}", self.name)
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, Value> {
        let id = self.next_id;
        self.next_id += 1;
        let started = Instant::now();
        self.send(json!({"t": "req", "id": id, "method": method, "params": params}));
        let res = self.wait(method, 200, |m| m["t"] == "res" && m["id"] == id);
        println!("[{}] {method}: {:.1}s{}", self.name, started.elapsed().as_secs_f32(), if res["error"].is_null() { String::new() } else { format!(" → {}", res["error"]) });
        if res["error"].is_null() { Ok(res["result"].clone()) } else { Err(res["error"].clone()) }
    }

    fn close(mut self) {
        self.send(json!({"t": "bye"}));
        let _ = self.child.wait();
    }
}

fn assert_clean(what: &str, text: &str) {
    for s in SECRETS {
        assert!(!text.contains(s), "{what} carries the secret {s}");
    }
    println!("ok: no secret in {what} ({} bytes)", text.len());
}

fn item<'a>(plan: &'a Value, id: &str) -> &'a Value {
    plan["items"].as_array().unwrap().iter().find(|i| i["id"] == id).unwrap_or_else(|| panic!("{id} not in the plan"))
}

fn sign_in(profile: &Value, provider: &str) -> String {
    let s = profile["signIns"].as_array().unwrap().iter().find(|s| s["provider"] == provider).unwrap_or_else(|| panic!("no {provider} sign-in"));
    format!("signIn:{}", s["id"].as_str().unwrap())
}

fn main() {
    let a = args();
    let host_a = Lab { name: "A", lab: a.a.clone(), relay: a.relay_a };
    let host_b = Lab { name: "B", lab: a.b.clone(), relay: a.relay_b };
    let in_a_year = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() + 365 * 86_400_000) as u64;
    host_a.prepare(
        &a,
        &[
            ("compaction.enabled", "false"),
            ("retry.maxRetries", "7"),
            ("shellPath", "/bin/bash"),
            ("modelRoles", r#"{"smol":"labmock/lab-sync","slow":"anthropic/claude-opus-4-1"}"#),
            ("retry.fallbackChains", r#"{"slow":["labmock/lab-sync"]}"#),
            ("searxng.token", "LAB-SEARX-SECRET"),
        ],
        // Commands that don't exist and a host that never resolves: no omp in the labs ever starts
        // or reaches one of these servers.
        &json!({ "mcpServers": {
            "labgh": { "command": "lab-gh-mcp", "args": ["--stdio"], "env": { "LAB_TOKEN": "LAB-MCP-SECRET", "LOG": "info" } },
            "labdocs": { "type": "http", "url": "https://docs.lab.invalid/mcp" }
        }}),
        &json!({ "version": 1, "credentials": [
            { "provider": "labmock", "credential": { "type": "api_key", "key": "LAB-MOCK-KEY-A" } },
            { "provider": "lab-oauth", "credential": { "type": "oauth", "access": "LAB-OAUTH-ACCESS", "refresh": "LAB-OAUTH-REFRESH", "expires": in_a_year, "email": "lab@example.invalid" } }
        ]}),
    );
    host_b.prepare(
        &a,
        &[("compaction.enabled", "true"), ("retry.maxRetries", "7"), ("symbolPreset", "ascii"), ("modelRoles", r#"{"smol":"openai/gpt-5-nano","tiny":"openai/gpt-5-nano"}"#)],
        &json!({ "mcpServers": { "labold": { "command": "old-lab-mcp" } } }),
        &json!({ "version": 1, "credentials": [{ "provider": "labmock", "credential": { "type": "api_key", "key": "LAB-B-OWN-KEY" } }] }),
    );
    if a.prepare_only {
        println!("prepared: labs {} and {}", host_a.lab, host_b.lab);
        return;
    }
    if a.mock_port.is_some() {
        let answer = host_b.ask_mock(&a);
        assert!(answer.contains("answered with key B"), "B uses its own key before the copy: {answer}");
        println!("ok: B's omp reaches the mock with B's own key");
    }

    let mut ca = Client::attach(&host_a, &a);
    let mut cb = Client::attach(&host_b, &a);

    let profile = ca.call("hostSync.export", json!({})).expect("export on A");
    assert_clean("A's profile", &profile.to_string());
    let plan = cb.call("hostSync.plan", json!({ "source": profile })).expect("plan on B");
    for it in plan["items"].as_array().unwrap() {
        println!(
            "  {:<44} {:<11} {}{}{}",
            it["id"].as_str().unwrap(),
            it["change"].as_str().unwrap(),
            if it["secret"] == true { "secret " } else { "" },
            if it["suggested"] == true { "suggested " } else { "" },
            it["notes"].as_array().map(|n| n.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" | ")).unwrap_or_default()
        );
    }
    assert_eq!(item(&plan, "setting:compaction.enabled")["change"], "change");
    assert_eq!(item(&plan, "setting:retry.maxRetries")["change"], "same");
    assert_eq!(item(&plan, "setting:symbolPreset")["change"], "remove");
    assert_eq!(item(&plan, "setting:searxng.token")["secret"], true);
    assert_eq!(item(&plan, "role:slow")["change"], "add");
    assert_eq!(item(&plan, "role:tiny")["change"], "remove");
    assert_eq!(item(&plan, "mcp:labgh")["needs"], "mcpSecrets:labgh");
    assert_eq!(item(&plan, "mcp:labold")["change"], "remove");
    let (oauth, key) = (sign_in(&profile, "lab-oauth"), sign_in(&profile, "labmock"));
    assert_eq!(item(&plan, &oauth)["change"], "add");
    assert_eq!(item(&plan, &key)["change"], "unknown", "B has its own labmock key");

    // Everything suggested, plus the secrets: both sign-ins, the token setting, labgh's secrets.
    let secrets = vec![oauth.clone(), key.clone(), "setting:searxng.token".to_string(), "mcpSecrets:labgh".to_string()];
    let mut chosen: Vec<String> = plan["items"].as_array().unwrap().iter().filter(|i| i["suggested"] == true).map(|i| i["id"].as_str().unwrap().to_string()).collect();
    chosen.extend(secrets.iter().cloned());
    let key_b = cb.call("hostSync.keyBegin", json!({})).expect("key on B");
    let sealed = ca.call("hostSync.seal", json!({ "transferId": key_b["transferId"], "publicKey": key_b["publicKey"], "items": secrets })).expect("seal on A");
    assert_clean("the sealed box", &sealed.to_string());
    let applied = cb.call("hostSync.apply", json!({ "source": profile, "items": chosen, "sealed": sealed })).expect("apply on B");
    for r in applied["results"].as_array().unwrap() {
        println!("  {} {:<44} {}", if r["ok"] == true { "✓" } else { "✗" }, r["id"].as_str().unwrap(), r["error"].as_str().or(r["note"].as_str()).unwrap_or(""));
        assert_eq!(r["ok"], true, "{r}");
    }
    println!("  mcp reload: {}", applied["mcpReload"]);
    assert_clean("the apply answer", &applied.to_string());

    // B, as omp itself reports it.
    let layer: Value = serde_json::from_str(&host_b.omp(&a, &["config", "list", "--scope", "global", "--json"], None)).unwrap();
    assert_eq!(layer["compaction.enabled"]["value"], false);
    assert_eq!(layer["shellPath"]["value"], "/bin/bash");
    assert_eq!(layer["symbolPreset"]["value"], "ascii", "an unchosen removal stays");
    assert_eq!(layer["modelRoles"]["value"], json!({ "smol": "labmock/lab-sync", "tiny": "openai/gpt-5-nano", "slow": "anthropic/claude-opus-4-1" }));
    assert_eq!(layer["retry.fallbackChains"]["value"], json!({ "slow": ["labmock/lab-sync"] }));
    assert_eq!(layer["searxng.token"]["redacted"], true);
    let token: Value = serde_json::from_str(&host_b.omp(&a, &["config", "get", "searxng.token", "--json"], None)).unwrap();
    assert_eq!(token["value"], "LAB-SEARX-SECRET");
    let creds = host_b.omp(&a, &["auth", "export"], None);
    assert!(creds.contains("LAB-OAUTH-REFRESH") && creds.contains("LAB-MOCK-KEY-A") && !creds.contains("LAB-B-OWN-KEY"), "B's credential store: the account added, the key replaced");
    let mcp = std::fs::read_to_string(host_b.agent().join("mcp.json")).unwrap();
    assert!(mcp.contains("LAB-MCP-SECRET") && mcp.contains("labdocs") && mcp.contains("labold"), "{mcp}");
    println!("ok: B has A's settings, roles, MCP servers and sign-ins (and kept what wasn't chosen)");
    for (id, change) in [("setting:compaction.enabled", "same"), ("role:slow", "same"), ("mcp:labgh", "same"), (oauth.as_str(), "unknown")] {
        assert_eq!(item(&applied["plan"], id)["change"], change, "{id} after applying");
    }
    if a.mock_port.is_some() {
        let answer = host_b.ask_mock(&a);
        assert!(answer.contains("answered with key A"), "B uses the copied key: {answer}");
        println!("ok: B's omp now reaches the mock with A's key");
    }

    // The box opens once; a changed one never.
    let again = cb.call("hostSync.apply", json!({ "source": profile, "items": chosen, "sealed": sealed })).unwrap_err();
    assert_eq!(again["code"], "expired");
    let key_b = cb.call("hostSync.keyBegin", json!({})).unwrap();
    let mut sealed = ca.call("hostSync.seal", json!({ "transferId": key_b["transferId"], "publicKey": key_b["publicKey"], "items": [oauth] })).unwrap();
    let ct = sealed["ciphertext"].as_str().unwrap().to_string();
    let flipped = if ct.starts_with('A') { format!("B{}", &ct[1..]) } else { format!("A{}", &ct[1..]) };
    sealed["ciphertext"] = json!(flipped);
    let err = cb.call("hostSync.apply", json!({ "source": profile, "items": [oauth], "sealed": sealed })).unwrap_err();
    assert_eq!(err["code"], "sealed_invalid");
    println!("ok: a replayed box is refused (expired), a tampered one too (sealed_invalid)");

    for c in [&ca, &cb] {
        assert_clean(&format!("everything {} sent", c.name), &c.seen);
        assert_clean(&format!("everything sent to {}", c.name), &c.sent);
    }
    ca.close();
    cb.close();
    for lab in [&host_a, &host_b] {
        let log = std::fs::read_to_string(lab.home().join("hostd.log")).unwrap_or_default();
        assert!(log.contains("hostSync"), "[{}] hostd.log has the hostSync lines", lab.name);
        assert_clean(&format!("{}'s hostd.log", lab.name), &log);
    }
    println!("done: both daemons keep running; stop them with scripts/lab/stop {} and scripts/lab/stop {}", host_a.lab, host_b.lab);
}
