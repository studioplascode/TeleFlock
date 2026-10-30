//! `services.*` (architecture §3.18): the processes omp's daemon broker supervises on this host,
//! through omp's own CLI (`omp ps`): dev servers and other named `bash` services agents started,
//! the shared browser, omp's machine-global services.
//!
//! * `services.list`: `omp ps --all --json` (one run per 2 s at most, shared by every client),
//!   each process with the TCP ports its process tree listens on (Linux `/proc`, for Preview) and
//!   the board agent whose omp session started it.
//! * `services.logs`: `omp ps logs <name> -n <lines>`.
//! * `services.stop` / `.kill` / `.restart`: `omp ps stop|kill|restart <name> --json`.
//!
//! Every command runs without a shell, `NO_COLOR=1`, in the temp dir, with a timeout. A service is
//! named by its scope (`--dir <project folder>` or `--global <service>`) and its name, both checked
//! against omp's own rules first, so nothing reaches omp as a flag.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::Value;
use tf_proto::{ApiError, HostMethod, Millis, Service, ServiceList, ServiceLogs, ServiceScope, ServiceScopeKind};
use tracing::info;

use crate::ops::git::run_cmd;
use crate::ops::host::omp_bin;
use crate::ops::tools::strip_ansi;
use crate::ops::{to_value, Ctx};
use crate::util::{clip, now_ms};

/// One `omp ps --all --json` per this long, whoever asks.
const LIST_TTL: Duration = Duration::from_secs(2);
const LIST_TIMEOUT: Duration = Duration::from_secs(15);
/// Under the app's 30 s request timeout; omp's own `stop` grace is 5 s.
const ACTION_TIMEOUT: Duration = Duration::from_secs(25);
/// Exited and failed processes kept per scope (newest first): `--all` lists every one omp remembers.
const MAX_ENDED: usize = 20;
/// Longest command line kept (headless Chrome has hundreds of flags).
const MAX_COMMAND: usize = 2000;
/// Log text kept (the newest part).
const MAX_LOG: usize = 256 * 1024;
const DEFAULT_LOG_LINES: u32 = 200;

pub async fn handle(ctx: &Ctx, req: HostMethod) -> Result<Value, ApiError> {
    match req {
        HostMethod::ServicesList(p) => {
            let mut list = cached_list(p.refresh.unwrap_or(false)).await?;
            link_agents(ctx, &mut list);
            to_value(list)
        }
        HostMethod::ServicesLogs(p) => {
            let target = Target::new(p.dir.as_deref(), p.global.as_deref(), &p.name)?;
            let lines = p.lines.unwrap_or(DEFAULT_LOG_LINES).clamp(1, 1000);
            let mut args = vec!["ps".to_string(), "logs".into(), target.name.clone()];
            args.extend(target.scope_args());
            args.extend(["-n".to_string(), lines.to_string()]);
            let out = omp(&args, ACTION_TIMEOUT).await?;
            to_value(parse_logs(&out, &target.name, now_ms()))
        }
        HostMethod::ServicesStop(r) => act(ctx, "stop", Target::new(r.dir.as_deref(), r.global.as_deref(), &r.name)?).await,
        HostMethod::ServicesKill(r) => act(ctx, "kill", Target::new(r.dir.as_deref(), r.global.as_deref(), &r.name)?).await,
        HostMethod::ServicesRestart(r) => act(ctx, "restart", Target::new(r.dir.as_deref(), r.global.as_deref(), &r.name)?).await,
        other => Err(ApiError::new("unknown_method", format!("unknown method `{}`", other.name()))),
    }
}

/// `omp ps stop|kill|restart <name> --json`: the process as omp left it.
async fn act(ctx: &Ctx, verb: &str, target: Target) -> Result<Value, ApiError> {
    let mut args = vec!["ps".to_string(), verb.to_string(), target.name.clone()];
    args.extend(target.scope_args());
    args.push("--json".into());
    let out = omp(&args, ACTION_TIMEOUT).await?;
    invalidate();
    let snapshot: PsDaemon = serde_json::from_str(out.trim())
        .map_err(|e| ApiError::new("omp_error", format!("omp ps {verb}: unexpected output: {e}")))?;
    info!(verb, name = %target.name, scope = %target.label(), state = %snapshot.state, "service action");
    let mut service = wire(snapshot);
    service.agent_id = service.owner.as_deref().and_then(|o| agents_by_session(ctx).remove(o));
    to_value(service)
}

/// A service named by a client: its scope and name, checked against omp's rules.
#[derive(Debug, Clone, PartialEq)]
struct Target {
    dir: Option<String>,
    global: Option<String>,
    name: String,
}

impl Target {
    fn new(dir: Option<&str>, global: Option<&str>, name: &str) -> Result<Target, ApiError> {
        let bad = |m: &str| Err(ApiError::new("invalid_params", m.to_string()));
        if !valid_name(name) {
            return bad("a service name is 1–48 letters, numbers, dots, underscores or hyphens");
        }
        match (dir.filter(|d| !d.is_empty()), global.filter(|g| !g.is_empty())) {
            (Some(d), None) => {
                if !Path::new(d).is_absolute() || d.contains('\0') || d.len() > 4096 {
                    return bad("dir must be an absolute project folder");
                }
                Ok(Target { dir: Some(d.to_string()), global: None, name: name.to_string() })
            }
            (None, Some(g)) => {
                if !valid_global(g) {
                    return bad("global must be a global service scope name");
                }
                Ok(Target { dir: None, global: Some(g.to_string()), name: name.to_string() })
            }
            _ => bad("name the service's scope: exactly one of dir and global"),
        }
    }

    fn scope_args(&self) -> Vec<String> {
        match (&self.dir, &self.global) {
            (Some(d), _) => vec!["--dir".into(), d.clone()],
            (_, Some(g)) => vec!["--global".into(), g.clone()],
            _ => vec![],
        }
    }

    fn label(&self) -> String {
        self.dir.clone().or_else(|| self.global.clone()).unwrap_or_default()
    }
}

/// omp's daemon names (`launch/broker.ts`).
fn valid_name(name: &str) -> bool {
    let b = name.as_bytes();
    (1..=48).contains(&b.len())
        && b[0].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/// omp's global service scope names (`getGlobalDaemonRuntimeDir`).
fn valid_global(name: &str) -> bool {
    let b = name.as_bytes();
    (1..=64).contains(&b.len())
        && b[0].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/// Runs `omp <args>`; its stdout, or omp's message as the error.
async fn omp(args: &[String], timeout: Duration) -> Result<String, ApiError> {
    let Some(bin) = omp_bin() else {
        return Err(ApiError::new("unsupported", "omp is not installed on this host").with_hint("Install omp from Host setup"));
    };
    let out = run_cmd(&bin, args, Some(&std::env::temp_dir()), &[("NO_COLOR", "1")], None, timeout).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::TimedOut {
            ApiError::new("timeout", format!("omp {} took longer than {} s", args[..2.min(args.len())].join(" "), timeout.as_secs())).retryable()
        } else {
            ApiError::new("omp_error", format!("omp {}: {e}", args.join(" ")))
        }
    })?;
    if !out.ok() {
        return Err(omp_failure(&args[..2.min(args.len())].join(" "), &strip_ansi(&out.message())));
    }
    Ok(strip_ansi(&out.stdout_str()))
}

/// omp's error text as an `ApiError`.
fn omp_failure(cmd: &str, message: &str) -> ApiError {
    let message = clip(message, 300);
    if message.contains("Unknown daemon") {
        return ApiError::new("not_found", message).with_hint("It may have exited and been cleaned up; refresh the list");
    }
    if message.contains("Unknown command") || message.contains("command ps not found") || message.contains("not found: ps") {
        return ApiError::new("unsupported", format!("this omp has no `omp ps`: {message}")).with_hint("Update omp on this host");
    }
    ApiError::new("omp_error", if message.is_empty() { format!("omp {cmd} failed") } else { message })
}

// ─── list ───────────────────────────────────────────────────────────────────────────────────

/// The latest list (without agent links), when it was read and the [`EPOCH`] it was read in.
static CACHE: LazyLock<tokio::sync::Mutex<Option<(Instant, u64, ServiceList)>>> = LazyLock::new(|| tokio::sync::Mutex::new(None));
/// Bumped by every action: a list read before it is stale, even one still being read.
static EPOCH: AtomicU64 = AtomicU64::new(0);

/// The next list asks omp again (after an action changed a service).
fn invalidate() {
    EPOCH.fetch_add(1, Ordering::SeqCst);
}

/// `omp ps --all --json`, at most once per [`LIST_TTL`]: callers that arrive while it runs wait
/// for it (the lock is held across the run) and get its answer.
async fn cached_list(refresh: bool) -> Result<ServiceList, ApiError> {
    let mut c = CACHE.lock().await;
    if !refresh && let Some((_, _, list)) = c.as_ref().filter(|(at, e, _)| at.elapsed() < LIST_TTL && *e == EPOCH.load(Ordering::SeqCst)) {
        return Ok(list.clone());
    }
    // An action during this read leaves the epoch ahead of it: what is stored is read again next time.
    let epoch = EPOCH.load(Ordering::SeqCst);
    let args = ["ps", "--all", "--json"].map(String::from);
    let out = omp(&args, LIST_TIMEOUT).await?;
    let mut list = parse_list(&out, now_ms()).map_err(|e| ApiError::new("omp_error", format!("omp ps --json: {e}")))?;
    let pids: Vec<u32> = list.scopes.iter().flat_map(|s| &s.services).filter(|s| live(&s.state)).filter_map(|s| s.pid).collect();
    let ports = tokio::task::spawn_blocking(move || ports::listening(&pids)).await.unwrap_or_default();
    for s in list.scopes.iter_mut().flat_map(|s| s.services.iter_mut()) {
        s.ports = match s.pid.filter(|_| live(&s.state)) {
            Some(pid) if ports::AVAILABLE => ports.get(&pid).cloned().unwrap_or_default(),
            _ if live(&s.state) => ready_match_port(s.ready_match.as_deref()).into_iter().collect(),
            _ => vec![],
        };
    }
    *c = Some((Instant::now(), epoch, list.clone()));
    Ok(list)
}

/// omp session id → board agent id, for this herdr session's board.
fn agents_by_session(ctx: &Ctx) -> HashMap<String, String> {
    ctx.state
        .snapshot()
        .agents
        .into_iter()
        .filter_map(|a| Some((a.omp?.session_id?, a.id)))
        .collect()
}

fn link_agents(ctx: &Ctx, list: &mut ServiceList) {
    let owners = agents_by_session(ctx);
    for s in list.scopes.iter_mut().flat_map(|s| s.services.iter_mut()) {
        s.agent_id = s.owner.as_ref().and_then(|o| owners.get(o).cloned());
    }
}

/// Not exited or failed (omp's `TERMINAL_STATES`).
fn live(state: &str) -> bool {
    !matches!(state, "exited" | "failed")
}

/// `omp ps --json`'s scopes (`cli/ps-cli.ts` `runList`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PsScope {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    project_dir: Option<String>,
    #[serde(default)]
    service: Option<String>,
    #[serde(default)]
    runtime_dir: String,
    #[serde(default)]
    broker_pid: Option<u32>,
    #[serde(default)]
    daemons: Vec<PsDaemon>,
}

/// One daemon (pi-tui `DaemonSnapshot` plus the listing's `command`, `cwd`, `supervised`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PsDaemon {
    name: String,
    #[serde(default)]
    id: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    created_at: Millis,
    #[serde(default)]
    started_at: Millis,
    #[serde(default)]
    ready_at: Option<Millis>,
    #[serde(default)]
    exited_at: Option<Millis>,
    #[serde(default)]
    exit_code: Option<i32>,
    #[serde(default)]
    exit_reason: Option<String>,
    #[serde(default)]
    restart_count: u32,
    #[serde(default)]
    output_bytes: u64,
    #[serde(default)]
    owner: Option<String>,
    #[serde(default)]
    ready_match: Option<String>,
    #[serde(default)]
    persist: bool,
    #[serde(default)]
    detached: bool,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    /// Absent in action results (a live broker answered).
    #[serde(default = "yes")]
    supervised: bool,
}

fn yes() -> bool {
    true
}

fn wire(d: PsDaemon) -> Service {
    Service {
        name: d.name,
        id: d.id,
        state: d.state,
        pid: d.pid,
        created_at: d.created_at,
        started_at: d.started_at,
        ready_at: d.ready_at,
        exited_at: d.exited_at,
        exit_code: d.exit_code,
        exit_reason: d.exit_reason.map(|r| clip(&r, 300)),
        restart_count: d.restart_count,
        output_bytes: d.output_bytes,
        owner: d.owner,
        agent_id: None,
        ready_match: d.ready_match.map(|m| clip(&m, 300)),
        persist: d.persist,
        detached: d.detached,
        command: d.command.map(|c| clip(&c, MAX_COMMAND)),
        cwd: d.cwd,
        supervised: d.supervised,
        ports: vec![],
    }
}

/// `omp ps --all --json` → scopes with services: live processes first (by name), then the newest
/// [`MAX_ENDED`] ended ones; scopes without any dropped; project scopes before global ones.
fn parse_list(stdout: &str, at: Millis) -> Result<ServiceList, String> {
    let scopes: Vec<PsScope> = serde_json::from_str(stdout.trim()).map_err(|e| e.to_string())?;
    let mut out: Vec<ServiceScope> = scopes
        .into_iter()
        .filter_map(|s| {
            let (mut running, mut ended): (Vec<Service>, Vec<Service>) = s.daemons.into_iter().map(wire).partition(|d| live(&d.state));
            running.sort_by(|a, b| a.name.cmp(&b.name));
            ended.sort_by_key(|d| std::cmp::Reverse(d.exited_at.unwrap_or(d.started_at)));
            ended.truncate(MAX_ENDED);
            running.extend(ended);
            (!running.is_empty()).then(|| ServiceScope {
                kind: if s.kind == "global" { ServiceScopeKind::Global } else { ServiceScopeKind::Project },
                runtime_dir: s.runtime_dir,
                project_dir: s.project_dir.filter(|d| !d.is_empty()),
                service: s.service.filter(|d| !d.is_empty()),
                broker_pid: s.broker_pid,
                services: running,
            })
        })
        .collect();
    // Scopes with something running first; then projects before globals, by folder.
    out.sort_by_key(|s| {
        (
            !s.services.iter().any(|d| live(&d.state)),
            s.kind == ServiceScopeKind::Global,
            s.project_dir.clone().or_else(|| s.service.clone()).unwrap_or_default(),
        )
    });
    Ok(ServiceList { scopes: out, at })
}

/// The port of a loopback `http(s)://` URL in a ready line (`Local: http://127.0.0.1:5173/`):
/// where `/proc` cannot tell which ports a process listens on.
fn ready_match_port(line: Option<&str>) -> Option<u16> {
    let line = line?;
    for scheme in ["http://", "https://"] {
        let mut rest = line;
        while let Some(i) = rest.find(scheme) {
            rest = &rest[i + scheme.len()..];
            for host in ["127.0.0.1:", "localhost:", "0.0.0.0:", "[::1]:", "[::]:"] {
                if let Some(after) = rest.strip_prefix(host) {
                    let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
                    if let Ok(port) = digits.parse::<u16>()
                        && port > 0
                    {
                        return Some(port);
                    }
                }
            }
        }
    }
    None
}

/// `omp ps logs` prints the log, then `[<name>: <state>]`.
fn parse_logs(stdout: &str, name: &str, at: Millis) -> ServiceLogs {
    let text = stdout.trim_end_matches(['\n', '\r']);
    let prefix = format!("[{name}: ");
    let (body, state) = match text.rsplit_once('\n').map_or(("", text), |(b, l)| (b, l)) {
        (body, last) if last.starts_with(&prefix) && last.ends_with(']') => {
            (body, Some(last[prefix.len()..last.len() - 1].to_string()))
        }
        _ => (text, None),
    };
    let mut body = body.to_string();
    if body.len() > MAX_LOG {
        let mut cut = body.len() - MAX_LOG;
        while !body.is_char_boundary(cut) {
            cut += 1;
        }
        let start = body[cut..].find('\n').map_or(cut, |i| cut + i + 1);
        body = body[start..].to_string();
    }
    ServiceLogs { text: body, state, at }
}

// ─── ports ──────────────────────────────────────────────────────────────────────────────────

/// Which TCP ports a process tree listens on, from `/proc` (Linux): sockets in `LISTEN` on a
/// loopback or unspecified address (`/proc/net/tcp`, `tcp6`), owned by the process or one of its
/// descendants (`/proc/<pid>/fd` → `socket:[inode]`). Previews tunnel to the host's `127.0.0.1`,
/// so a port bound to another address only would not answer there.
mod ports {
    use std::collections::{HashMap, HashSet};

    pub const AVAILABLE: bool = cfg!(target_os = "linux");

    /// Processes searched per tree (a dev server's workers and their children).
    const MAX_TREE: usize = 512;

    #[cfg(target_os = "linux")]
    pub fn listening(roots: &[u32]) -> HashMap<u32, Vec<u16>> {
        let mut inodes: HashMap<u64, u16> = HashMap::new();
        for file in ["/proc/net/tcp", "/proc/net/tcp6"] {
            if let Ok(text) = std::fs::read_to_string(file) {
                inodes.extend(parse_net(&text));
            }
        }
        if inodes.is_empty() || roots.is_empty() {
            return HashMap::new();
        }
        let children = children_of();
        roots
            .iter()
            .map(|&root| {
                let mut ports: Vec<u16> = tree(root, &children)
                    .into_iter()
                    .flat_map(socket_inodes)
                    .filter_map(|inode| inodes.get(&inode).copied())
                    .collect();
                ports.sort_unstable();
                ports.dedup();
                (root, ports)
            })
            .collect()
    }

    #[cfg(not(target_os = "linux"))]
    pub fn listening(_roots: &[u32]) -> HashMap<u32, Vec<u16>> {
        HashMap::new()
    }

    /// `/proc/net/tcp{,6}`: inode → port of every reachable listening socket.
    pub fn parse_net(text: &str) -> Vec<(u64, u16)> {
        text.lines()
            .skip(1)
            .filter_map(|line| {
                let f: Vec<&str> = line.split_whitespace().collect();
                if f.len() < 10 || f[3] != "0A" {
                    return None;
                }
                let (addr, port) = f[1].split_once(':')?;
                let port = u16::from_str_radix(port, 16).ok()?;
                let inode: u64 = f[9].parse().ok()?;
                (inode != 0 && reachable(addr)?).then_some((inode, port))
            })
            .collect()
    }

    /// A kernel-printed address (each 32-bit word in host byte order, as 8 hex digits) is loopback
    /// or unspecified (also v4-mapped).
    fn reachable(hex: &str) -> Option<bool> {
        let words: Vec<[u8; 4]> = (0..hex.len() / 8)
            .map(|i| u32::from_str_radix(hex.get(i * 8..i * 8 + 8)?, 16).ok().map(u32::to_le_bytes))
            .collect::<Option<_>>()?;
        match words.len() {
            1 => {
                let ip = std::net::Ipv4Addr::from(words[0]);
                Some(ip.is_loopback() || ip.is_unspecified())
            }
            4 => {
                let mut bytes = [0u8; 16];
                for (i, w) in words.iter().enumerate() {
                    bytes[i * 4..i * 4 + 4].copy_from_slice(w);
                }
                let ip = std::net::Ipv6Addr::from(bytes);
                Some(ip.is_loopback() || ip.is_unspecified() || ip.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback() || v4.is_unspecified()))
            }
            _ => None,
        }
    }

    /// ppid → children, from every `/proc/<pid>/stat`.
    #[cfg(target_os = "linux")]
    fn children_of() -> HashMap<u32, Vec<u32>> {
        let mut map: HashMap<u32, Vec<u32>> = HashMap::new();
        let Ok(dir) = std::fs::read_dir("/proc") else { return map };
        for entry in dir.flatten() {
            let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
            let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { continue };
            if let Some(ppid) = stat_ppid(&stat) {
                map.entry(ppid).or_default().push(pid);
            }
        }
        map
    }

    /// The parent pid in `/proc/<pid>/stat` (after the `(comm)`, which may hold spaces and parens).
    pub fn stat_ppid(stat: &str) -> Option<u32> {
        let rest = &stat[stat.rfind(')')? + 1..];
        rest.split_whitespace().nth(1)?.parse().ok()
    }

    /// `root` and its descendants, breadth first, at most [`MAX_TREE`].
    pub fn tree(root: u32, children: &HashMap<u32, Vec<u32>>) -> Vec<u32> {
        let mut out = vec![root];
        let mut seen: HashSet<u32> = HashSet::from([root]);
        let mut i = 0;
        while i < out.len() && out.len() < MAX_TREE {
            for &c in children.get(&out[i]).into_iter().flatten() {
                if seen.insert(c) && out.len() < MAX_TREE {
                    out.push(c);
                }
            }
            i += 1;
        }
        out
    }

    /// Socket inodes a process holds open.
    #[cfg(target_os = "linux")]
    fn socket_inodes(pid: u32) -> Vec<u64> {
        let Ok(dir) = std::fs::read_dir(format!("/proc/{pid}/fd")) else { return vec![] };
        dir.flatten()
            .filter_map(|e| std::fs::read_link(e.path()).ok())
            .filter_map(|link| {
                let s = link.to_str()?;
                s.strip_prefix("socket:[")?.strip_suffix(']')?.parse().ok()
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed from a real `omp ps --all --json` (omp 18.13.3).
    const PS: &str = r#"[
      { "kind": "project", "projectDir": "/root/TeleFlock", "runtimeDir": "/root/.omp/run/daemons/6d190fd66d150fe4", "brokerPid": 2437062,
        "daemons": [
          { "name": "omp.browser.headless", "id": "73ce", "state": "ready", "pid": 815962, "createdAt": 1793095575013,
            "startedAt": 1793095575013, "readyAt": 1793095575152, "restartCount": 0, "outputBytes": 18333,
            "readyMatch": "DevTools listening on ws://127.0.0.1:42881/devtools/browser/1126d2ab", "persist": false, "detached": false,
            "command": "/root/.omp/puppeteer/chrome --headless=new", "cwd": "/root/TeleFlock", "supervised": true },
          { "name": "subagents-vite", "id": "f094", "state": "failed", "createdAt": 1793276031840, "startedAt": 1793276031842,
            "readyAt": 1793276033353, "exitedAt": 1793276314129, "exitCode": 143, "restartCount": 0, "outputBytes": 164,
            "owner": "01a1878e-119b-710c-8e1c-281aace51370", "persist": false, "detached": false,
            "command": "/bin/bash -l -c bunx vite --host 127.0.0.1 --port 7434 --strictPort", "cwd": "/root/TeleFlock", "supervised": true },
          { "name": "vite-lastfixes2", "id": "ebb2", "state": "exited", "createdAt": 1793257387989, "startedAt": 1793257387993,
            "exitedAt": 1793257471325, "exitCode": 143, "restartCount": 0, "outputBytes": 163, "persist": false, "detached": false,
            "supervised": true },
          { "name": "lab-web", "id": "aa11", "state": "running", "pid": 4242, "createdAt": 1, "startedAt": 2, "restartCount": 1,
            "outputBytes": 10, "owner": "S1", "readyMatch": "Serving HTTP on 127.0.0.1 port 47591 (http://127.0.0.1:47591/) ...",
            "persist": false, "detached": false, "supervised": true }
        ] },
      { "kind": "project", "projectDir": "/tmp", "runtimeDir": "/root/.omp/run/daemons/0355", "brokerPid": 2497588, "daemons": [] },
      { "kind": "global", "service": "browser-relay", "runtimeDir": "/root/.omp/run/daemons/global/browser-relay",
        "daemons": [ { "name": "omp.browser.relay", "id": "018f", "state": "exited", "createdAt": 1793270899158,
          "startedAt": 1793270899159, "exitedAt": 1793271619927, "exitCode": 0, "restartCount": 0, "outputBytes": 241,
          "persist": false, "detached": false, "command": "/root/.local/bin/omp browser-relay --port 9224", "supervised": false } ] },
      { "kind": "project", "projectDir": "/root/a", "runtimeDir": "/r/a", "daemons": [
          { "name": "old", "id": "1", "state": "exited", "createdAt": 1, "startedAt": 1, "exitedAt": 5, "restartCount": 0,
            "outputBytes": 0, "persist": false, "detached": false, "supervised": false } ] }
    ]"#;

    #[test]
    fn parses_omp_ps_json() {
        let list = parse_list(PS, 99).unwrap();
        assert_eq!(list.at, 99);
        // Empty scopes dropped; the scope with something running first, then projects before globals.
        let keys: Vec<_> = list.scopes.iter().map(|s| s.project_dir.clone().or(s.service.clone()).unwrap()).collect();
        assert_eq!(keys, ["/root/TeleFlock", "/root/a", "browser-relay"]);
        let tf = &list.scopes[0];
        assert_eq!((tf.kind, tf.broker_pid), (ServiceScopeKind::Project, Some(2437062)));
        // Live ones by name, then ended ones newest first.
        let names: Vec<_> = tf.services.iter().map(|s| (s.name.as_str(), s.state.as_str())).collect();
        assert_eq!(names, [("lab-web", "running"), ("omp.browser.headless", "ready"), ("subagents-vite", "failed"), ("vite-lastfixes2", "exited")]);
        let web = &tf.services[0];
        assert_eq!((web.pid, web.restart_count, web.owner.as_deref(), web.supervised), (Some(4242), 1, Some("S1"), true));
        let vite = &tf.services[2];
        assert_eq!((vite.exit_code, vite.exited_at), (Some(143), Some(1793276314129)));
        assert_eq!(vite.command.as_deref(), Some("/bin/bash -l -c bunx vite --host 127.0.0.1 --port 7434 --strictPort"));
        let relay = &list.scopes[2];
        assert_eq!((relay.kind, relay.service.as_deref(), relay.services[0].supervised), (ServiceScopeKind::Global, Some("browser-relay"), false));
        assert!(parse_list("not json", 0).is_err());
    }

    #[test]
    fn caps_ended_services_per_scope() {
        let daemons: Vec<String> = (0..30)
            .map(|i| format!(r#"{{ "name": "d{i}", "state": "exited", "createdAt": 1, "startedAt": 1, "exitedAt": {i}, "persist": false, "detached": false }}"#))
            .collect();
        let json = format!(r#"[{{ "kind": "project", "projectDir": "/p", "runtimeDir": "/r", "daemons": [{}] }}]"#, daemons.join(","));
        let list = parse_list(&json, 0).unwrap();
        let s = &list.scopes[0].services;
        assert_eq!(s.len(), MAX_ENDED);
        assert_eq!((s[0].name.as_str(), s[MAX_ENDED - 1].name.as_str()), ("d29", "d10"));
    }

    #[test]
    fn ready_line_ports() {
        assert_eq!(ready_match_port(Some("  ➜  Local:   http://localhost:5173/")), Some(5173));
        assert_eq!(ready_match_port(Some("Serving HTTP on 127.0.0.1 port 47591 (http://127.0.0.1:47591/) ...")), Some(47591));
        assert_eq!(ready_match_port(Some("listening on https://[::1]:8443")), Some(8443));
        // DevTools' websocket and other hosts are no preview.
        assert_eq!(ready_match_port(Some("DevTools listening on ws://127.0.0.1:42881/devtools")), None);
        assert_eq!(ready_match_port(Some("http://10.0.0.5:3000")), None);
        assert_eq!(ready_match_port(None), None);
    }

    #[test]
    fn targets_follow_omps_rules() {
        let t = Target::new(Some("/root/TeleFlock"), None, "lab-web").unwrap();
        assert_eq!(t.scope_args(), ["--dir", "/root/TeleFlock"]);
        let g = Target::new(None, Some("browser-relay"), "omp.browser.relay").unwrap();
        assert_eq!(g.scope_args(), ["--global", "browser-relay"]);
        for (dir, global, name) in [
            (Some("/p"), None, "-rf"),
            (Some("/p"), None, ""),
            (Some("/p"), None, "a b"),
            (Some("/p"), None, &*"x".repeat(49)),
            (Some("relative"), None, "web"),
            (None, Some("--all"), "web"),
            (None, None, "web"),
            (Some("/p"), Some("g"), "web"),
        ] {
            assert!(Target::new(dir, global, name).is_err_and(|e| e.code == "invalid_params"), "{dir:?} {global:?} {name}");
        }
    }

    #[test]
    fn logs_trailer_is_the_state() {
        let l = parse_logs("VITE ready\n  ➜  Local: http://127.0.0.1:5173/\n[web: ready]\n", "web", 7);
        assert_eq!((l.text.as_str(), l.state.as_deref(), l.at), ("VITE ready\n  ➜  Local: http://127.0.0.1:5173/", Some("ready"), 7));
        let empty = parse_logs("[web: exited]\n", "web", 7);
        assert_eq!((empty.text.as_str(), empty.state.as_deref()), ("", Some("exited")));
        let plain = parse_logs("no trailer\n", "web", 7);
        assert_eq!((plain.text.as_str(), plain.state), ("no trailer", None));
        let big = format!("{}\n[web: running]", "line\n".repeat(80_000));
        let l = parse_logs(&big, "web", 7);
        assert!(l.text.len() <= MAX_LOG && l.text.starts_with("line\n"), "{}", l.text.len());
    }

    #[test]
    fn omp_failures_map_to_codes() {
        assert_eq!(omp_failure("ps stop", "Unknown daemon web. Available: api").code, "not_found");
        assert_eq!(omp_failure("ps logs", "boom").code, "omp_error");
        assert_eq!(omp_failure("ps logs", "").message, "omp ps logs failed");
    }

    #[test]
    fn proc_net_listening_sockets() {
        let tcp = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
           0: 0100007F:B867 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1001 1 0 100 0 0 10 0\n\
           1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1002 1 0 100 0 0 10 0\n\
           2: 0500000A:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1003 1 0 100 0 0 10 0\n\
           3: 0100007F:B867 0100007F:D2E4 01 00000000:00000000 00:00000000 00000000     0        0 1004 1 0 100 0 0 10 0\n";
        // 127.0.0.1:47207 and 0.0.0.0:8080 listen; 10.0.0.5:3000 is another address; an established socket is no listener.
        assert_eq!(ports::parse_net(tcp), [(1001, 0xB867), (1002, 8080)]);
        let tcp6 = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
           0: 00000000000000000000000001000000:1F91 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2001 1 0 100 0 0 10 0\n\
           1: 00000000000000000000000000000000:1F92 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2002 1 0 100 0 0 10 0\n\
           2: 0000000000000000FFFF00000100007F:1F93 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2003 1 0 100 0 0 10 0\n\
           3: B80D0120000000000000000001000000:1F94 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2004 1 0 100 0 0 10 0\n";
        // ::1, ::, ::ffff:127.0.0.1 listen; 2001:db8::1 is another address.
        assert_eq!(ports::parse_net(tcp6), [(2001, 8081), (2002, 8082), (2003, 8083)]);
    }

    #[test]
    fn proc_tree_and_stat() {
        assert_eq!(ports::stat_ppid("4242 (bun (worker) x) S 4200 4242 4242 0 -1"), Some(4200));
        let children = HashMap::from([(1, vec![2, 3]), (2, vec![4]), (4, vec![1])]);
        assert_eq!(ports::tree(1, &children), [1, 2, 3, 4]);
        assert_eq!(ports::tree(9, &children), [9]);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn finds_a_real_listener() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let me = std::process::id();
        let found = ports::listening(&[me]);
        assert!(found.get(&me).is_some_and(|p| p.contains(&port)), "{found:?} {port}");
    }
}
