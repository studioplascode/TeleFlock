//! Discovery of hosted omp sessions (`omp-collab.md` §8).
//!
//! Primary path: the registry IPC. Each host publishes `~/.omp/run/collab-hosts/<entry>.json`
//! (`{version, instanceId, pid, endpoint, createdAt, token}`); the endpoint (unix socket / named
//! pipe) answers one newline-delimited JSON request per connection:
//!
//! ```text
//! → {"v":1,"token":"…","op":"snapshot"}                         ← {"ok":true,"v":1,"snapshot":{…}}
//! → {"v":1,"token":"…","op":"link","access":"control","generation":N}  ← {"ok":true,"v":1,"url":"…"}
//!                                                                ← {"ok":false,"v":1,"error":"stale_generation"}
//! ```
//!
//! Fallback: `omp collab list --json` / `omp collab link <id> [--view] --json` (used when the
//! directory cannot be read, or a host speaks another registry protocol version).
//!
//! [`Registry::poll`] returns the current hosts; the consumer diffs (key by
//! `(instance_id, generation)`). omp answers on its event loop, which a slow or busy machine can
//! stall for seconds: a host that accepts the connection but does not answer in time
//! ([`RegistryError::Busy`]) keeps its last snapshot for [`BUSY_GRACE`] instead of dropping out
//! of the poll, and [`Registry::link`] waits longer than a poll does.
//!
//! A poll lists the directory once (one blocking task); a publication file is read again only
//! when its size or mtime changed. omp leaves the files of crashed or killed processes behind:
//! one that refuses the connection while its process is gone (Linux: no `/proc/<pid>`) is not
//! asked again until the file changes.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::link::CollabLink;

pub const REGISTRY_VERSION: u32 = 1;
/// Per-host connect + response deadline during [`Registry::poll`] (omp's own lister: 1.5 s).
const POLL_DEADLINE: Duration = Duration::from_millis(2500);
/// Per-request deadline of [`Registry::link`]: one join, and the host may be busy serializing.
const LINK_DEADLINE: Duration = Duration::from_secs(10);
/// How long a host that stops answering polls in time keeps its last snapshot.
pub const BUSY_GRACE: Duration = Duration::from_secs(45);
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const CLI_TIMEOUT: Duration = Duration::from_secs(10);
const LINK_ATTEMPTS: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelId {
    pub provider: String,
    pub id: String,
}

/// One live collab host (a `snapshot` reply / `omp collab list` row).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostEntry {
    pub instance_id: String,
    #[serde(default)]
    pub generation: u64,
    #[serde(default)]
    pub pid: u32,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_name: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub model: Option<ModelId>,
    #[serde(default)]
    pub started_at: Option<i64>,
    #[serde(default)]
    pub participants: u32,
    #[serde(default)]
    pub relay_connected: bool,
    #[serde(default)]
    pub input_required: bool,
    #[serde(default)]
    pub busy: bool,
    /// `control` | `view`.
    #[serde(default)]
    pub access: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Control,
    View,
}

impl Access {
    pub fn as_str(self) -> &'static str {
        match self {
            Access::Control => "control",
            Access::View => "view",
        }
    }
}

#[derive(Debug, Clone)]
pub struct LinkInfo {
    pub instance_id: String,
    /// Generation the link belongs to (may be newer than the one polled).
    pub generation: u64,
    /// Browser deep link as returned by omp (contains the room secret; keep on the host).
    pub url: String,
    pub link: CollabLink,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistryError {
    /// No live host with that instance id / pid.
    NotFound(String),
    /// Registry error code from omp (`stale_generation`, `access_unavailable`, `snapshot_unavailable`, …).
    Host(String),
    /// The endpoint accepted the connection but did not answer in time (busy or stalled host).
    Busy(String),
    /// Endpoint unreachable / malformed reply.
    Unreachable(String),
    Io(String),
    /// The `omp` CLI fallback failed.
    Cli(String),
    /// omp returned a URL we cannot parse.
    BadLink(String),
}

impl fmt::Display for RegistryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound(s) => write!(f, "collab host not found: {s}"),
            Self::Host(s) => write!(f, "collab registry error: {s}"),
            Self::Unreachable(s) => write!(f, "collab host unreachable: {s}"),
            Self::Busy(s) => write!(f, "collab host did not answer in time: {s}"),
            Self::Io(s) => write!(f, "collab registry io error: {s}"),
            Self::Cli(s) => write!(f, "omp collab cli failed: {s}"),
            Self::BadLink(s) => write!(f, "bad collab link from registry: {s}"),
        }
    }
}
impl std::error::Error for RegistryError {}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    version: u32,
    instance_id: String,
    #[serde(default)]
    pid: u32,
    endpoint: String,
    token: String,
    /// Publication file name (in the registry dir).
    #[serde(skip)]
    file: OsString,
}

/// What the last directory scan learned about one publication file.
#[derive(Debug, Clone)]
struct Seen {
    len: u64,
    modified: Option<SystemTime>,
    /// `None`: valid JSON of another registry version.
    meta: Option<Meta>,
    /// Refused a connection while its process was gone: skipped until the file changes.
    dead: bool,
}

/// Registry client. Cheap; holds the last seen endpoint metadata.
pub struct Registry {
    dir: PathBuf,
    omp_bin: PathBuf,
    metas: Mutex<HashMap<String, Meta>>,
    /// Last answered snapshot per instance id, and when it was answered (busy-host grace).
    answered: Mutex<HashMap<String, (HostEntry, Instant)>>,
    /// Publication file name → what its last read said (shared with the blocking scan).
    files: Arc<Mutex<HashMap<OsString, Seen>>>,
    poll_deadline: Duration,
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

/// `~/.omp/run/collab-hosts`.
pub fn default_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".omp").join("run").join("collab-hosts")
}

enum Query {
    Ok(Value),
    Err(String),
}

impl Registry {
    pub fn new() -> Registry {
        Self::with_dir(default_dir())
    }

    pub fn with_dir(dir: PathBuf) -> Registry {
        Registry {
            dir,
            omp_bin: PathBuf::from("omp"),
            metas: Mutex::new(HashMap::new()),
            answered: Mutex::new(HashMap::new()),
            files: Arc::new(Mutex::new(HashMap::new())),
            poll_deadline: POLL_DEADLINE,
        }
    }

    /// `omp` binary for the CLI fallback (default: `omp` on PATH).
    pub fn omp_bin(mut self, bin: impl Into<PathBuf>) -> Registry {
        self.omp_bin = bin.into();
        self
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Current hosts, sorted by `startedAt`, `pid`, `instanceId`.
    pub async fn poll(&self) -> Result<Vec<HostEntry>, RegistryError> {
        let metas = match self.read_metas().await {
            Ok(m) => m,
            Err(e) => {
                log::debug!("registry dir unreadable ({e}); falling back to omp collab list");
                return self.cli_list().await;
            }
        };
        let deadline = self.poll_deadline;
        let queries = metas.iter().map(|m| async move { (m, query(m, json!({"op": "snapshot"}), deadline).await) });
        let results = futures_util::future::join_all(queries).await;
        let Some((mut hosts, seen)) = self.collect(results) else { return self.cli_list().await };
        *self.metas.lock().unwrap() = seen;
        sort_hosts(&mut hosts);
        Ok(hosts)
    }

    /// Poll answers → listed hosts and their metadata; `None` when a host needs the CLI fallback.
    fn collect(&self, results: Vec<(&Meta, Result<Query, RegistryError>)>) -> Option<(Vec<HostEntry>, HashMap<String, Meta>)> {
        let now = Instant::now();
        let mut hosts = Vec::new();
        let mut fallback = false;
        let mut seen = HashMap::new();
        let mut answered = self.answered.lock().unwrap();
        for (meta, res) in results {
            match res {
                Ok(Query::Ok(v)) => match serde_json::from_value::<HostEntry>(v["snapshot"].clone()) {
                    Ok(h) => {
                        seen.insert(h.instance_id.clone(), meta.clone());
                        answered.insert(h.instance_id.clone(), (h.clone(), now));
                        hosts.push(h);
                    }
                    Err(e) => log::debug!("registry: bad snapshot from {}: {e}", meta.endpoint),
                },
                Ok(Query::Err(code)) if code == "unsupported_protocol" => fallback = true,
                // snapshot_unavailable (ending / transitioning) and auth failures: skip this round.
                Ok(Query::Err(code)) => log::debug!("registry: {} → {code}", meta.instance_id),
                // Alive but not answering in time (its event loop is busy): the last snapshot
                // stands for a while, so the session neither drops off nor restarts its join.
                Err(RegistryError::Busy(e)) => match answered.get(&meta.instance_id) {
                    Some((h, at)) if now.duration_since(*at) < BUSY_GRACE => {
                        log::debug!("registry: {} busy ({e}); keeping its last snapshot", meta.instance_id);
                        seen.insert(meta.instance_id.clone(), meta.clone());
                        hosts.push(h.clone());
                    }
                    _ => log::debug!("registry: {} busy: {e}", meta.instance_id),
                },
                // ENOENT / ECONNREFUSED: crashed publication; omp's next lister prunes it. Its
                // process gone too, it is not asked again until the file changes.
                Err(e) => {
                    log::debug!("registry: {} unreachable: {e}", meta.endpoint);
                    if process_gone(meta.pid) {
                        if let Some(seen) = self.files.lock().unwrap().get_mut(&meta.file) {
                            seen.dead = true;
                        }
                    }
                }
            }
        }
        answered.retain(|id, _| seen.contains_key(id));
        (!fallback).then_some((hosts, seen))
    }

    /// A join link for `instance_id` (or a pid). Handles `stale_generation` by re-reading the
    /// current generation and retrying.
    pub async fn link(&self, instance_id: &str, access: Access) -> Result<LinkInfo, RegistryError> {
        let mut meta = self.metas.lock().unwrap().get(instance_id).cloned();
        if meta.is_none() {
            if let Ok(metas) = self.read_metas().await {
                meta = metas.into_iter().find(|m| m.instance_id == instance_id || m.pid.to_string() == instance_id);
            }
        }
        let Some(meta) = meta else { return self.cli_link(instance_id, access).await };
        let mut last = RegistryError::NotFound(instance_id.to_owned());
        for _ in 0..LINK_ATTEMPTS {
            let snap = match query(&meta, json!({"op": "snapshot"}), LINK_DEADLINE).await {
                Ok(Query::Ok(v)) => v,
                Ok(Query::Err(code)) if code == "unsupported_protocol" => return self.cli_link(instance_id, access).await,
                Ok(Query::Err(code)) => return Err(RegistryError::Host(code)),
                Err(e) => return Err(e),
            };
            let generation = snap["snapshot"]["generation"].as_u64().unwrap_or(0);
            match query(&meta, json!({"op": "link", "access": access.as_str(), "generation": generation}), LINK_DEADLINE).await? {
                Query::Ok(v) => {
                    let url = v["url"].as_str().unwrap_or_default().to_owned();
                    let link = CollabLink::parse(&url).map_err(|e| RegistryError::BadLink(e.0))?;
                    return Ok(LinkInfo { instance_id: meta.instance_id.clone(), generation, url, link });
                }
                Query::Err(code) if code == "stale_generation" => {
                    last = RegistryError::Host(code);
                    continue;
                }
                Query::Err(code) => return Err(RegistryError::Host(code)),
            }
        }
        Err(last)
    }

    async fn read_metas(&self) -> std::io::Result<Vec<Meta>> {
        let (dir, files) = (self.dir.clone(), self.files.clone());
        tokio::task::spawn_blocking(move || scan_dir(&dir, &files)).await.map_err(std::io::Error::other)?
    }

    async fn run_cli(&self, args: &[&str]) -> Result<Value, RegistryError> {
        let mut cmd = tokio::process::Command::new(&self.omp_bin);
        cmd.args(args).stdin(std::process::Stdio::null()).kill_on_drop(true);
        let out = tokio::time::timeout(CLI_TIMEOUT, cmd.output())
            .await
            .map_err(|_| RegistryError::Cli(format!("omp {} timed out", args.join(" "))))?
            .map_err(|e| RegistryError::Cli(e.to_string()))?;
        let parsed: Option<Value> = serde_json::from_slice(&out.stdout).ok();
        if !out.status.success() {
            let code = parsed.as_ref().and_then(|v| v["error"].as_str().map(str::to_owned));
            return Err(match code {
                Some(c) if c == "not_found" => RegistryError::NotFound(args.get(2).copied().unwrap_or("").to_owned()),
                Some(c) => RegistryError::Host(c),
                None => RegistryError::Cli(String::from_utf8_lossy(&out.stderr).trim().to_owned()),
            });
        }
        parsed.ok_or_else(|| RegistryError::Cli("omp printed no JSON".into()))
    }

    async fn cli_list(&self) -> Result<Vec<HostEntry>, RegistryError> {
        let v = self.run_cli(&["collab", "list", "--json"]).await?;
        let mut hosts: Vec<HostEntry> =
            serde_json::from_value(v["hosts"].clone()).map_err(|e| RegistryError::Cli(e.to_string()))?;
        sort_hosts(&mut hosts);
        Ok(hosts)
    }

    async fn cli_link(&self, selector: &str, access: Access) -> Result<LinkInfo, RegistryError> {
        let mut args = vec!["collab", "link", selector, "--json"];
        if access == Access::View {
            args.push("--view");
        }
        let v = self.run_cli(&args).await?;
        let url = v["url"].as_str().unwrap_or_default().to_owned();
        let link = CollabLink::parse(&url).map_err(|e| RegistryError::BadLink(e.0))?;
        Ok(LinkInfo {
            instance_id: v["instanceId"].as_str().unwrap_or(selector).to_owned(),
            generation: v["generation"].as_u64().unwrap_or(0),
            url,
            link,
        })
    }
}

fn sort_hosts(hosts: &mut [HostEntry]) {
    hosts.sort_by(|a, b| {
        (a.started_at.unwrap_or(0), a.pid, &a.instance_id).cmp(&(b.started_at.unwrap_or(0), b.pid, &b.instance_id))
    });
}

/// Lists `dir` and returns the publications to ask: a file is read again only when its size or
/// mtime changed since the last scan, and dead ones are left out.
fn scan_dir(dir: &Path, files: &Mutex<HashMap<OsString, Seen>>) -> std::io::Result<Vec<Meta>> {
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            files.lock().unwrap().clear();
            return Ok(Vec::new());
        }
        Err(e) => return Err(e),
    };
    let mut cache = files.lock().unwrap();
    let mut next = HashMap::with_capacity(cache.len());
    let mut out = Vec::new();
    for entry in rd {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        // Publications are 0600 regular files; skip symlinks like omp does.
        let md = match std::fs::symlink_metadata(&path) {
            Ok(md) if md.file_type().is_file() => md,
            _ => continue,
        };
        let name = entry.file_name();
        let (len, modified) = (md.len(), md.modified().ok());
        let seen = match cache.remove(&name) {
            Some(s) if s.len == len && s.modified == modified => s,
            // Unreadable or not JSON (yet): not remembered, so the next scan reads it again.
            _ => match read_meta(&path, &name) {
                Some(meta) => Seen { len, modified, meta, dead: false },
                None => continue,
            },
        };
        if let Some(m) = seen.meta.as_ref().filter(|_| !seen.dead) {
            out.push(m.clone());
        }
        next.insert(name, seen);
    }
    *cache = next;
    Ok(out)
}

/// Reads one publication: `None` when unreadable or not JSON, `Some(None)` for another
/// registry version.
fn read_meta(path: &Path, name: &OsString) -> Option<Option<Meta>> {
    let raw = std::fs::read(path).ok()?;
    match serde_json::from_slice::<Meta>(&raw) {
        Ok(m) if m.version == REGISTRY_VERSION => Some(Some(Meta { file: name.clone(), ..m })),
        Ok(m) => {
            log::debug!("registry: {} has version {}", path.display(), m.version);
            Some(None)
        }
        Err(_) => None,
    }
}

/// The publishing process has exited: Linux only (`/proc/<pid>` is gone while `/proc` is
/// mounted); never for pid 0 (not published).
fn process_gone(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        pid != 0 && Path::new("/proc/self").exists() && !Path::new(&format!("/proc/{pid}")).exists()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        false
    }
}

/// One request on a fresh connection, bounded by `deadline` (connect + response).
async fn query(meta: &Meta, mut req: Value, deadline: Duration) -> Result<Query, RegistryError> {
    req["v"] = json!(REGISTRY_VERSION);
    req["token"] = json!(meta.token);
    let mut line = serde_json::to_vec(&req).expect("json");
    line.push(b'\n');
    let reply = tokio::time::timeout(deadline, exchange(&meta.endpoint, &line))
        .await
        .map_err(|_| RegistryError::Busy(format!("{}: no answer within {:.1} s", meta.endpoint, deadline.as_secs_f32())))??;
    let v: Value = serde_json::from_slice(&reply)
        .map_err(|e| RegistryError::Unreachable(format!("{}: malformed reply: {e}", meta.endpoint)))?;
    if v["ok"].as_bool() == Some(true) {
        Ok(Query::Ok(v))
    } else {
        Ok(Query::Err(v["error"].as_str().unwrap_or("malformed_response").to_owned()))
    }
}

async fn exchange(endpoint: &str, line: &[u8]) -> Result<Vec<u8>, RegistryError> {
    let unreachable = |e: std::io::Error| RegistryError::Unreachable(format!("{endpoint}: {e}"));
    #[cfg(unix)]
    let stream = tokio::net::UnixStream::connect(endpoint).await.map_err(unreachable)?;
    #[cfg(windows)]
    let stream = tokio::net::windows::named_pipe::ClientOptions::new().open(endpoint).map_err(unreachable)?;
    let (rd, mut wr) = tokio::io::split(stream);
    wr.write_all(line).await.map_err(unreachable)?;
    let mut reader = BufReader::new(tokio::io::AsyncReadExt::take(rd, MAX_RESPONSE_BYTES as u64 + 1));
    let mut buf = Vec::new();
    reader.read_until(b'\n', &mut buf).await.map_err(unreachable)?;
    if buf.len() > MAX_RESPONSE_BYTES {
        return Err(RegistryError::Unreachable(format!("{endpoint}: oversized reply")));
    }
    if buf.last() == Some(&b'\n') {
        buf.pop();
    }
    Ok(buf)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use tokio::net::UnixListener;

    type Gen = std::sync::Arc<std::sync::atomic::AtomicU64>;
    type Flag = std::sync::Arc<std::sync::atomic::AtomicBool>;

    /// A fake omp registry endpoint speaking the observed protocol. When `rotate` is set, the
    /// next snapshot reports the current generation and then rotates (generation + 1), so the
    /// following `link` is stale exactly once — the race `omp collab link` also handles. While
    /// `stall` is set it accepts connections but answers nothing (a busy event loop).
    async fn fake_host(dir: &Path, instance: &str, generation: Gen, rotate: Flag, stall: Flag) {
        let sock = dir.join(format!("{instance}.sock"));
        let listener = UnixListener::bind(&sock).unwrap();
        let meta = json!({"version":1,"instanceId":instance,"pid":4242,"endpoint":sock,"createdAt":1,"token":"secret"});
        std::fs::write(dir.join(format!("{instance}.json")), meta.to_string()).unwrap();
        let instance = instance.to_owned();
        tokio::spawn(async move {
            loop {
                let (s, _) = listener.accept().await.unwrap();
                let generation = generation.clone();
                let rotate = rotate.clone();
                let stall = stall.clone();
                let instance = instance.clone();
                tokio::spawn(async move {
                    let (rd, mut wr) = tokio::io::split(s);
                    let mut line = String::new();
                    BufReader::new(rd).read_line(&mut line).await.unwrap();
                    if stall.load(std::sync::atomic::Ordering::SeqCst) {
                        tokio::time::sleep(Duration::from_secs(30)).await;
                        return;
                    }
                    let req: Value = serde_json::from_str(&line).unwrap();
                    let g = generation.load(std::sync::atomic::Ordering::SeqCst);
                    let resp = if req["token"] != "secret" {
                        json!({"ok":false,"v":1,"error":"authentication_failed"})
                    } else if req["op"] == "snapshot" {
                        let snap = json!({"ok":true,"v":1,"snapshot":{"instanceId":instance,"generation":g,"pid":4242,
                            "sessionId":"s-1","sessionName":null,"cwd":"/tmp/x","model":{"provider":"p","id":"m"},
                            "startedAt":10,"participants":1,"relayConnected":true,"inputRequired":false,"busy":false,"access":"control"}});
                        if rotate.swap(false, std::sync::atomic::Ordering::SeqCst) {
                            generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        }
                        snap
                    } else if req["op"] == "link" {
                        if req["generation"].as_u64() != Some(g) {
                            json!({"ok":false,"v":1,"error":"stale_generation"})
                        } else {
                            let secret = crate::link::b64url_encode(&[9u8; 48]);
                            json!({"ok":true,"v":1,"url":format!("http://127.0.0.1:7466/#ws://127.0.0.1:7466/r/AAAAAAAAAAAAAAAAAAAAAA.{secret}")})
                        }
                    } else {
                        json!({"ok":false,"v":1,"error":"invalid_operation"})
                    };
                    wr.write_all(format!("{resp}\n").as_bytes()).await.unwrap();
                });
            }
        });
    }

    #[tokio::test]
    async fn poll_and_link_with_stale_generation() {
        let dir = std::env::temp_dir().join(format!("tf-collab-reg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let generation = Gen::default();
        generation.store(1, std::sync::atomic::Ordering::SeqCst);
        let rotate = Flag::default();
        fake_host(&dir, "abcd1234abcd1234", generation.clone(), rotate.clone(), Flag::default()).await;
        // A crashed publication (no socket) is skipped.
        std::fs::write(
            dir.join("dead.json"),
            json!({"version":1,"instanceId":"dead","pid":1,"endpoint":dir.join("dead.sock"),"createdAt":1,"token":"x"}).to_string(),
        )
        .unwrap();
        let reg = Registry::with_dir(dir.clone()).omp_bin("/nonexistent/omp");
        let hosts = reg.poll().await.unwrap();
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].instance_id, "abcd1234abcd1234");
        assert_eq!(hosts[0].session_id.as_deref(), Some("s-1"));
        assert_eq!(hosts[0].generation, 1);
        // Rotation between snapshot and link: the first link is stale_generation, link()
        // re-snapshots and returns the gen-2 link.
        rotate.store(true, std::sync::atomic::Ordering::SeqCst);
        let info = reg.link("abcd1234abcd1234", Access::Control).await.unwrap();
        assert_eq!(info.generation, 2);
        assert!(info.link.can_write());
        assert_eq!(info.link.ws_url, "ws://127.0.0.1:7466/r/AAAAAAAAAAAAAAAAAAAAAA");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn busy_host_keeps_its_last_snapshot_within_the_grace() {
        let dir = std::env::temp_dir().join(format!("tf-collab-reg-busy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let generation = Gen::default();
        generation.store(1, std::sync::atomic::Ordering::SeqCst);
        let stall = Flag::default();
        fake_host(&dir, "b05b05b05b05b05b", generation, Flag::default(), stall.clone()).await;
        let mut reg = Registry::with_dir(dir.clone()).omp_bin("/nonexistent/omp");
        reg.poll_deadline = Duration::from_millis(200);
        assert_eq!(reg.poll().await.unwrap().len(), 1);
        // Accepts but does not answer: still listed with its last snapshot.
        stall.store(true, std::sync::atomic::Ordering::SeqCst);
        let hosts = reg.poll().await.unwrap();
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].instance_id, "b05b05b05b05b05b");
        assert!(reg.metas.lock().unwrap().contains_key("b05b05b05b05b05b"), "link() can still find it");
        // Busy for longer than the grace: dropped.
        for (_, at) in reg.answered.lock().unwrap().values_mut() {
            *at = at.checked_sub(BUSY_GRACE).unwrap();
        }
        assert!(reg.poll().await.unwrap().is_empty());
        // Answers again: back at once.
        stall.store(false, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(reg.poll().await.unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn files_are_reread_only_when_they_change_and_dead_publications_are_skipped() {
        let dir = std::env::temp_dir().join(format!("tf-collab-reg-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let generation = Gen::default();
        generation.store(1, std::sync::atomic::Ordering::SeqCst);
        fake_host(&dir, "cafecafecafecafe", generation, Flag::default(), Flag::default()).await;
        let reg = Registry::with_dir(dir.clone()).omp_bin("/nonexistent/omp");
        assert_eq!(reg.poll().await.unwrap().len(), 1);
        // Other bytes, same size and mtime: the scan keeps what it read before.
        let file = dir.join("cafecafecafecafe.json");
        let md = std::fs::metadata(&file).unwrap();
        std::fs::write(&file, " ".repeat(md.len() as usize)).unwrap();
        let touch = |t: SystemTime| std::fs::File::options().write(true).open(&file).unwrap().set_modified(t).unwrap();
        touch(md.modified().unwrap());
        assert_eq!(reg.poll().await.unwrap().len(), 1, "not read again");
        // A new mtime: read again (no publication any more).
        touch(md.modified().unwrap() + Duration::from_secs(5));
        assert!(reg.poll().await.unwrap().is_empty());

        let publish = |name: &str, pid: u32| {
            let meta = json!({"version":1,"instanceId":name,"pid":pid,"endpoint":dir.join(format!("{name}.sock")),"createdAt":1,"token":"x"});
            std::fs::write(dir.join(format!("{name}.json")), meta.to_string()).unwrap();
        };
        let dead = |name: &str| reg.files.lock().unwrap().get(&OsString::from(format!("{name}.json"))).is_some_and(|s| s.dead);
        // Refused while its process lives (omp still starting, or busy): asked again next poll.
        publish("starting", std::process::id());
        reg.poll().await.unwrap();
        assert!(!dead("starting"));
        #[cfg(target_os = "linux")]
        {
            // Refused and its process is gone (a killed omp's leftover): not asked again …
            let mut child = std::process::Command::new("true").spawn().unwrap();
            let gone = child.id();
            child.wait().unwrap();
            publish("crashed", gone);
            reg.poll().await.unwrap();
            assert!(dead("crashed"));
            assert!(reg.read_metas().await.unwrap().iter().all(|m| m.instance_id != "crashed"));
            // … until its file changes.
            publish("crashed", std::process::id());
            assert!(reg.read_metas().await.unwrap().iter().any(|m| m.instance_id == "crashed"));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn missing_dir_is_empty() {
        let reg = Registry::with_dir(PathBuf::from("/nonexistent/tf-collab-dir"));
        assert_eq!(reg.poll().await.unwrap(), vec![]);
    }

    #[test]
    fn sample_rows_deserialize() {
        let raw = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/research/omp-collab-samples/registry-list-input-required.json"
        ))
        .unwrap();
        let v: Value = serde_json::from_str(&raw).unwrap();
        let hosts: Vec<HostEntry> = serde_json::from_value(v["hosts"].clone()).unwrap();
        assert!(hosts[0].input_required && hosts[0].busy);
        assert_eq!(hosts[0].model.as_ref().unwrap().id, "gpt-6-luna");
    }
}
