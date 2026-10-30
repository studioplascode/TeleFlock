//! `mcp.*` methods: omp's MCP servers on this host (architecture §3.15, wire types `tf_proto::mcp`).
//!
//! - **Config** is read and written here, in omp's own files and format (`files.rs`, `json.rs`,
//!   `model.rs`): user scope `<omp agent dir>/mcp.json`, project scope `<folder>/.omp/mcp.json`
//!   (plus their `.mcp.json` siblings, edited in place), under omp's cross-process lock. Enabling
//!   and disabling follows omp's `setMcpServerEnabled` exactly (the entry's `enabled` flag, else
//!   the user-level `disabledServers` / `enabledServers` lists for servers of other tools).
//! - **Status and tools** come from omp: a "check" runs the helper (`helper.rs`) in a throwaway omp
//!   that discovers every source and connects the servers like a session (startup window 20 s,
//!   the whole check bounded at 60 s, the servers it started stopped with it). One check per
//!   folder at a time; results are kept per server with a fingerprint of its definition (and of
//!   whether it is on and hidden), so a list answers at once and only changed servers are checked
//!   again. Other tools' servers are on or off as the user-level lists say at the time of the list.
//! - **Secrets** never leave the host (`secrets.rs`).
//! - **Running sessions** get every change through omp's `/mcp reload` (`reload.rs`).
//! - **Sign-in** (`auth.rs`) and sign-out, test and registry search run omp's own code through
//!   the helper too, on the row's own definition.

mod auth;
pub mod files;
pub(crate) mod helper;
pub mod json;
mod model;
pub(crate) mod reload;
mod secrets;
pub(crate) mod sync;

use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use tf_proto::{
    ApiError, HostMethod, McpChanged, McpCheckState, McpEnableParams, McpFileError, McpList, McpOrigin, McpRegistryEntry, McpRegistryInput,
    McpSaveParams, McpScope, McpSearchParams, McpSearchResult, McpServer, McpServerDraft, McpServerInfo, McpServerRef, McpStatus,
    McpTestParams, McpTestResult, McpTool, McpTransport, Millis,
};
use tokio::sync::watch;

use crate::clients::ClientHandle;
use crate::ops::host::{omp_agent_dir, omp_bin};
use crate::ops::{to_value, Ctx};
use crate::util::now_ms;
use files::Loaded;
use helper::HelperEnv;
use json::{Obj, J};

/// Connect window of a check (omp's sessions wait 250 ms by default, then keep connecting; a check
/// waits for slow first starts such as an `npx` download).
const CHECK_WINDOW_MS: u64 = 20_000;
/// The whole check, waiting for a helper slot included.
const CHECK_TIMEOUT: Duration = Duration::from_secs(60);
/// A check result older than this is redone on the next list.
const CHECK_TTL_MS: Millis = 10 * 60 * 1000;
/// `mcp.test` must answer within the app's 30 s request timeout: an unanswered server is
/// `pending` after the window, well before [`TEST_TIMEOUT`].
const TEST_WINDOW_MS: u64 = 18_000;
const TEST_TIMEOUT: Duration = Duration::from_secs(26);
const SEARCH_TIMEOUT: Duration = Duration::from_secs(26);
/// Longest `mcp.list { waitMs }`.
const MAX_WAIT_MS: u32 = 25_000;

pub async fn handle(ctx: &Ctx, req: HostMethod, _client: &ClientHandle) -> Result<Value, ApiError> {
    let mcp = Mcp::from_ctx(ctx);
    match req {
        HostMethod::McpListReq(p) => {
            let folder = folder(p.cwd.as_deref())?;
            to_value(list(ctx, &mcp, folder, p.refresh.unwrap_or(false), p.wait_ms.unwrap_or(0).min(MAX_WAIT_MS)).await?)
        }
        HostMethod::McpSave(p) => to_value(save(ctx, &mcp, p).await?),
        HostMethod::McpRemove(p) => to_value(remove(ctx, &mcp, p).await?),
        HostMethod::McpSetEnabled(p) => to_value(set_enabled(ctx, &mcp, p).await?),
        HostMethod::McpTest(p) => to_value(test(&mcp, p).await?),
        HostMethod::McpReloadReq(p) => {
            let folder = folder(p.cwd.as_deref())?;
            to_value(reload::reload(ctx, folder.as_deref()).await)
        }
        HostMethod::McpAuthStart(p) => {
            let folder = folder(p.cwd.as_deref())?;
            let (target, _) = auth_target(&mcp, folder, &p.name, p.scope).await?;
            to_value(auth::start(ctx, &mcp.helper, target).await?)
        }
        HostMethod::McpSignOut(p) => to_value(sign_out(ctx, &mcp, p).await?),
        HostMethod::McpSearch(p) => to_value(search(&mcp, p).await?),
        other => Err(ApiError::new("unknown_method", format!("{} is not an mcp method", other.name()))),
    }
}

/// Where omp's files are and how the helper runs. Tests build one over temp dirs.
#[derive(Debug, Clone)]
struct Mcp {
    /// omp's agent dir (user scope: `<agent dir>/mcp.json`).
    agent_dir: PathBuf,
    helper: HelperEnv,
    /// An empty folder the helper runs in for user-level answers: no project config applies.
    neutral: PathBuf,
}

impl Mcp {
    fn from_ctx(ctx: &Ctx) -> Mcp {
        Mcp {
            agent_dir: omp_agent_dir(),
            helper: HelperEnv {
                spec: &helper::MCP,
                omp: omp_bin(),
                ext_dir: ctx.paths.home.join("ext"),
                run_dir: ctx.paths.run.clone(),
                agent_dir: None,
                slots: helper::Slots::shared(),
            },
            neutral: ctx.paths.home.join("cache").join("mcp-user"),
        }
    }

    /// omp's cwd for answers about `folder` (user level: the neutral folder, created on demand).
    fn cwd_for(&self, folder: Option<&Path>) -> Result<PathBuf, ApiError> {
        match folder {
            Some(f) => Ok(f.to_path_buf()),
            None => {
                std::fs::create_dir_all(&self.neutral).map_err(|e| ApiError::new("io_error", format!("{}: {e}", self.neutral.display())))?;
                Ok(self.neutral.clone())
            }
        }
    }

    fn user_file(&self) -> PathBuf {
        self.agent_dir.join("mcp.json")
    }
}

/// The `cwd` param: an existing absolute folder, resolved like omp's `process.cwd()` (symlinks
/// followed), or `None` for the user level.
pub(crate) fn folder(cwd: Option<&str>) -> Result<Option<PathBuf>, ApiError> {
    let Some(raw) = cwd.map(str::trim).filter(|s| !s.is_empty()) else { return Ok(None) };
    let p = Path::new(raw);
    if !p.is_absolute() {
        return Err(ApiError::new("invalid_params", format!("cwd: `{raw}` is not an absolute path")));
    }
    let real = std::fs::canonicalize(p)
        .map_err(|e| ApiError::new("not_found", format!("{raw}: {e}")).with_hint("The folder is gone from the host: pick another project."))?;
    if !real.is_dir() {
        return Err(ApiError::new("invalid_params", format!("cwd: `{raw}` is not a folder")));
    }
    Ok(Some(match real.to_str().and_then(strip_verbatim) {
        Some(plain) => PathBuf::from(plain),
        None => real,
    }))
}

/// Windows `canonicalize` answers verbatim paths (`\\?\C:\x`, `\\?\UNC\srv\share\x`); omp works
/// with plain ones (`C:\x`, `\\srv\share\x`), and the two must agree: they name omp's config
/// lock and the paths a check result is matched by. `None`: nothing to strip (also elsewhere: a
/// Unix path never starts with `\\?\`).
fn strip_verbatim(path: &str) -> Option<String> {
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        return Some(format!(r"\\{unc}"));
    }
    let rest = path.strip_prefix(r"\\?\")?;
    let b = rest.as_bytes();
    (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':').then(|| rest.to_string())
}

// ───────────────────────────── files ─────────────────────────────

/// One native config file in omp's read order (project files first, then user files).
struct NativeFile {
    path: PathBuf,
    origin: McpOrigin,
    loaded: Loaded,
}

fn native_files(mcp: &Mcp, folder: Option<&Path>) -> Vec<NativeFile> {
    let mut out = Vec::new();
    if let Some(f) = folder {
        for path in files::scope_files(&files::project_dir(f)) {
            out.push(NativeFile { loaded: files::read(&path), path, origin: McpOrigin::Project });
        }
    }
    for path in files::scope_files(&mcp.agent_dir) {
        out.push(NativeFile { loaded: files::read(&path), path, origin: McpOrigin::User });
    }
    out
}

fn servers_of(loaded: &Loaded) -> Option<&Obj> {
    match loaded {
        Loaded::Ok(root) => root.obj("mcpServers"),
        _ => None,
    }
}

/// omp's user-level `disabledServers` / `enabledServers` lists (from `<agent dir>/mcp.json` only).
#[derive(Debug, Default)]
struct UserLists {
    denied: HashSet<String>,
    forced: HashSet<String>,
}

impl UserLists {
    fn of(files: &[NativeFile], user_file: &Path) -> UserLists {
        let root = files.iter().find(|f| f.path == user_file).and_then(|f| match &f.loaded {
            Loaded::Ok(r) => Some(r),
            _ => None,
        });
        let list = |key: &str| -> HashSet<String> {
            root.and_then(|r| r.get(key)).and_then(J::as_arr).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default()
        };
        UserLists { denied: list("disabledServers"), forced: list("enabledServers") }
    }

    /// Whether sessions start `name` whose definition says `entry_enabled` (the denylist wins).
    fn enabled(&self, name: &str, entry_enabled: bool) -> bool {
        !self.denied.contains(name) && (entry_enabled || self.forced.contains(name))
    }
}

/// Fingerprint of a definition, whether it's on and whether another one hides it: a check result
/// applies while it matches.
fn fingerprint(path: &Path, entry: &Obj, enabled: bool, shadowed: bool) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut h);
    json::compact(&J::Obj(entry.clone())).hash(&mut h);
    enabled.hash(&mut h);
    shadowed.hash(&mut h);
    h.finish()
}

/// A native server as the files define it.
struct Native {
    name: String,
    origin: McpOrigin,
    path: PathBuf,
    entry: Obj,
    enabled: bool,
    shadowed: bool,
    fp: u64,
}

fn natives(files: &[NativeFile], lists: &UserLists) -> Vec<Native> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for f in files {
        let Some(servers) = servers_of(&f.loaded) else { continue };
        for (name, v) in &servers.0 {
            let Some(entry) = v.as_obj() else { continue };
            let enabled = lists.enabled(name, model::entry_enabled(entry));
            let shadowed = !seen.insert(name.clone());
            let fp = fingerprint(&f.path, entry, enabled, shadowed);
            out.push(Native { name: name.clone(), origin: f.origin, path: f.path.clone(), entry: entry.clone(), enabled, shadowed, fp });
        }
    }
    out
}

// ───────────────────────────── checks ─────────────────────────────

/// One server in the helper's `probe` answer.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Probed {
    name: String,
    #[serde(default)]
    provider: String,
    provider_name: Option<String>,
    path: Option<String>,
    #[serde(default = "yes")]
    enabled: bool,
    /// The definition's own `enabled` flag (the user-level lists aside).
    #[serde(default = "yes")]
    entry_enabled: bool,
    #[serde(default)]
    shadowed: bool,
    #[serde(default)]
    signed_in: bool,
    /// Other tools' definitions (omp's own are read from the files).
    config: Option<Value>,
    status: String,
    error: Option<String>,
    auth_type: Option<String>,
    note: Option<String>,
    #[serde(default)]
    tools: Vec<McpTool>,
    server_info: Option<McpServerInfo>,
    /// When this result was established (hostd side).
    #[serde(default)]
    at: Millis,
}

fn yes() -> bool {
    true
}

#[derive(Default)]
struct Slot {
    /// Last known result per (name, path) of every source.
    servers: Vec<Probed>,
    /// Native definitions those results were taken with: `name\0path` → fingerprint.
    fps: HashMap<String, u64>,
    /// Servers to check again whatever their fingerprint (signed in / out, switched).
    dirty: HashSet<String>,
    /// Servers the running partial check re-checks (shown as `checking` meanwhile).
    rechecking: HashSet<String>,
    finished_at: Option<Millis>,
    started_at: Option<Millis>,
    running: Option<watch::Receiver<bool>>,
    error: Option<String>,
    omp_version: Option<String>,
    /// The user config file this folder's list reads (`<omp agent dir>/mcp.json`).
    user_file: Option<PathBuf>,
}

static CHECKS: LazyLock<Mutex<HashMap<PathBuf, Slot>>> = LazyLock::new(Default::default);

fn checks() -> MutexGuard<'static, HashMap<PathBuf, Slot>> {
    CHECKS.lock().unwrap_or_else(|p| p.into_inner())
}

fn fp_key(name: &str, path: &Path) -> String {
    format!("{name}\0{}", path.display())
}

/// Checks `name` again on the next list of `key`'s folder.
pub(crate) fn mark_dirty(key: &Path, name: &str) {
    checks().entry(key.to_path_buf()).or_default().dirty.insert(name.to_string());
}

/// Checks `name` again on the next list of every folder that reads `user_file` (a user-level
/// change: every such list has it).
pub(crate) fn mark_dirty_everywhere(user_file: &Path, name: &str) {
    for slot in checks().values_mut().filter(|s| s.user_file.as_deref() == Some(user_file)) {
        slot.dirty.insert(name.to_string());
    }
}

/// Starts a check when results are missing, old or stale (unless one runs). `only`: these
/// servers; `None`: everything.
fn maybe_check(mcp: &Mcp, key: &Path, cwd: &Path, natives: &[Native], lists: &UserLists, refresh: bool) {
    let mut map = checks();
    let slot = map.entry(key.to_path_buf()).or_default();
    slot.user_file = Some(mcp.user_file());
    if slot.running.is_some() {
        return;
    }
    let now = now_ms();
    // A failing helper (omp missing or too old) is retried at most every 30 s unless asked.
    if !refresh && slot.error.is_some() && slot.finished_at.is_some_and(|t| now - t < 30_000) {
        return;
    }
    let full = refresh || slot.finished_at.is_none_or(|t| now - t > CHECK_TTL_MS) || (slot.error.is_some() && slot.servers.is_empty());
    // Other tools' servers switched on since their result (through the user-level lists).
    let switched_on = slot.servers.iter().filter(|p| p.provider != "native" && !p.enabled && lists.enabled(&p.name, p.entry_enabled)).map(|p| p.name.clone());
    let stale: Vec<String> = natives
        .iter()
        .filter(|n| n.enabled && !n.shadowed && slot.fps.get(&fp_key(&n.name, &n.path)) != Some(&n.fp))
        .map(|n| n.name.clone())
        .chain(switched_on)
        .chain(slot.dirty.iter().cloned())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if !full && stale.is_empty() {
        return;
    }
    let only = (!full).then_some(stale);
    let fps: HashMap<String, u64> = natives.iter().map(|n| (fp_key(&n.name, &n.path), n.fp)).collect();
    let (tx, rx) = watch::channel(false);
    slot.running = Some(rx);
    slot.started_at = Some(now);
    let covered: Option<HashSet<String>> = only.as_ref().map(|o| o.iter().cloned().collect());
    if let Some(c) = &covered {
        slot.dirty.retain(|d| !c.contains(d));
        slot.rechecking = c.clone();
    } else {
        slot.dirty.clear();
        slot.rechecking.clear();
    }
    let (env, key, cwd) = (mcp.helper.clone(), key.to_path_buf(), cwd.to_path_buf());
    tokio::spawn(async move {
        let req = json!({ "op": "probe", "only": only, "timeoutMs": CHECK_WINDOW_MS });
        let deadline = Instant::now() + CHECK_TIMEOUT;
        let mut version = None;
        let res = match helper::Running::start(&env, &cwd, req, deadline).await {
            Ok(mut run) => {
                run.finish(deadline, |l| {
                    if l.get("t").and_then(Value::as_str) == Some("hello") {
                        version = l.get("ompVersion").and_then(Value::as_str).map(str::to_string);
                    }
                })
                .await
            }
            Err(e) => Err(e),
        };
        let mut map = checks();
        let slot = map.entry(key).or_default();
        match res {
            Ok(v) => {
                let at = now_ms();
                let fresh: Vec<Probed> = v
                    .get("servers")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(|s| serde_json::from_value::<Probed>(s.clone()).ok()).map(|p| Probed { at, ..p }).collect())
                    .unwrap_or_default();
                slot.servers = merge(&slot.servers, fresh, covered.as_ref());
                slot.fps.extend(fps);
                slot.finished_at = Some(at);
                slot.error = None;
                if version.is_some() {
                    slot.omp_version = version;
                }
            }
            Err(e) => {
                tracing::warn!("mcp check: {} {}", e.code, e.message);
                slot.error = Some([Some(e.message), e.hint].into_iter().flatten().collect::<Vec<_>>().join(" — "));
                slot.finished_at = Some(now_ms());
                // Servers a failed partial check was asked about are asked about again.
                slot.dirty.extend(covered.into_iter().flatten());
            }
        }
        slot.rechecking.clear();
        slot.running = None;
        let _ = tx.send(true);
    });
}

/// A check's answer over the previous results: servers it didn't connect (`unchanged`, or not in
/// `only`) keep their earlier status.
fn merge(prev: &[Probed], fresh: Vec<Probed>, only: Option<&HashSet<String>>) -> Vec<Probed> {
    fresh
        .into_iter()
        .map(|p| {
            let kept = p.status == "unchanged" || only.is_some_and(|o| !o.contains(&p.name) && p.status != "disabled");
            match prev.iter().find(|q| q.name == p.name && q.path == p.path).filter(|_| kept) {
                Some(q) => Probed { enabled: p.enabled, entry_enabled: p.entry_enabled, shadowed: p.shadowed, signed_in: p.signed_in, config: p.config.clone(), ..q.clone() },
                None if p.status == "unchanged" => Probed { status: "unknown".into(), ..p },
                None => p,
            }
        })
        .collect()
}

/// Waits up to `ms` for the running check of `key` (if any).
async fn wait_check(key: &Path, ms: u32) {
    let rx = checks().get(key).and_then(|s| s.running.clone());
    if let Some(mut rx) = rx {
        let _ = tokio::time::timeout(Duration::from_millis(u64::from(ms)), rx.wait_for(|done| *done)).await;
    }
}

fn status_of(p: &Probed) -> McpStatus {
    match p.status.as_str() {
        "connected" => McpStatus::Connected,
        "needsAuth" => McpStatus::NeedsAuth,
        "failed" => McpStatus::Failed,
        "pending" => McpStatus::Pending,
        "disabled" => McpStatus::Disabled,
        "skipped" | "notLoaded" => McpStatus::Skipped,
        _ => McpStatus::Unknown,
    }
}

/// Extra words for an auth failure that a sign-in can't fix.
fn auth_note(p: &Probed) -> Option<String> {
    (p.status == "needsAuth" && p.auth_type.as_deref() == Some("apikey"))
        .then(|| "The server wants an API key or token, not a sign-in: add it as a header.".to_string())
}

// ───────────────────────────── list ─────────────────────────────

async fn list(ctx: &Ctx, mcp: &Mcp, folder: Option<PathBuf>, refresh: bool, wait_ms: u32) -> Result<McpList, ApiError> {
    let live = reload::reachable(&ctx.bridge, folder.as_deref());
    list_with(mcp, folder, refresh, wait_ms, live).await
}

/// The list of `folder` (starting a check when one is due), `live_sessions` given.
async fn list_with(mcp: &Mcp, folder: Option<PathBuf>, refresh: bool, wait_ms: u32, live_sessions: u32) -> Result<McpList, ApiError> {
    let cwd = mcp.cwd_for(folder.as_deref())?;
    let key = cwd.clone();
    let (m, f) = (mcp.clone(), folder.clone());
    let files = tokio::task::spawn_blocking(move || native_files(&m, f.as_deref())).await.map_err(|e| ApiError::new("internal", e.to_string()))?;
    let lists = UserLists::of(&files, &mcp.user_file());
    let nat = natives(&files, &lists);
    maybe_check(mcp, &key, &cwd, &nat, &lists, refresh);
    if wait_ms > 0 {
        wait_check(&key, wait_ms).await;
        // The finished check may have left changed servers behind (edited meanwhile).
        maybe_check(mcp, &key, &cwd, &nat, &lists, false);
    }
    Ok(build_list(mcp, folder.as_deref(), &files, &nat, &lists, &key, live_sessions))
}

fn build_list(mcp: &Mcp, folder: Option<&Path>, files: &[NativeFile], nat: &[Native], lists: &UserLists, key: &Path, live_sessions: u32) -> McpList {
    let map = checks();
    let slot = map.get(key);
    let running = slot.is_some_and(|s| s.running.is_some());
    let empty = Vec::new();
    let probed = slot.map(|s| &s.servers).unwrap_or(&empty);
    let mut servers = Vec::new();
    for n in nat {
        let (server, extra) = model::to_draft(&n.entry);
        let rechecking = running && slot.is_some_and(|s| s.rechecking.contains(&n.name));
        let current = !rechecking && slot.is_some_and(|s| s.fps.get(&fp_key(&n.name, &n.path)) == Some(&n.fp) && !s.dirty.contains(&n.name));
        let known = probed.iter().find(|p| p.provider == "native" && p.name == n.name && p.path.as_deref() == Some(&*n.path.to_string_lossy()));
        let p = known.filter(|_| current);
        let (status, note) = if !n.enabled {
            (McpStatus::Disabled, None)
        } else if n.shadowed {
            (McpStatus::Skipped, Some("Not loaded: a server with the same name takes precedence.".to_string()))
        } else {
            match p {
                Some(p) if status_of(p) != McpStatus::Unknown => (status_of(p), p.note.clone().or_else(|| auth_note(p))),
                _ if running => (McpStatus::Checking, None),
                _ => (McpStatus::Unknown, None),
            }
        };
        let live = status != McpStatus::Disabled && status != McpStatus::Checking && status != McpStatus::Unknown;
        servers.push(McpServer {
            name: n.name.clone(),
            origin: n.origin,
            path: Some(n.path.display().to_string()),
            source_label: None,
            server,
            enabled: n.enabled,
            signed_in: model::has_oauth_block(&n.entry) || known.is_some_and(|p| p.signed_in),
            shadowed: n.shadowed,
            status,
            error: p.filter(|_| live).and_then(|p| p.error.clone()),
            note,
            tools: p.filter(|_| status == McpStatus::Connected).map(|p| p.tools.clone()).unwrap_or_default(),
            server_info: p.filter(|_| live).and_then(|p| p.server_info.clone()),
            checked_at: p.filter(|_| live).map(|p| p.at),
            extra,
        });
    }
    // Other tools' servers, as omp's discovery found them (only known after a check); on or off
    // as the user-level lists say now (they may have changed in another folder's list since).
    for p in probed.iter().filter(|p| p.provider != "native") {
        let entry = p.config.as_ref().map(J::from_value).and_then(|j| match j {
            J::Obj(o) => Some(o),
            _ => None,
        });
        let (server, _) = entry.as_ref().map(model::to_draft).unwrap_or_else(|| {
            (McpServerDraft { transport: McpTransport::Stdio, command: None, args: vec![], cwd: None, env: vec![], url: None, headers: vec![], timeout_ms: None, oauth: None }, vec![])
        });
        let enabled = lists.enabled(&p.name, p.entry_enabled);
        let rechecking = running && slot.is_some_and(|s| s.rechecking.contains(&p.name));
        // A result taken while it was switched the other way says nothing about it now.
        let current = enabled == p.enabled && !rechecking && !slot.is_some_and(|s| s.dirty.contains(&p.name));
        let shadowed = p.shadowed || nat.iter().any(|n| n.name == p.name);
        let status = if !enabled {
            McpStatus::Disabled
        } else if shadowed {
            McpStatus::Skipped
        } else if current && status_of(p) != McpStatus::Unknown {
            status_of(p)
        } else if running {
            McpStatus::Checking
        } else {
            McpStatus::Unknown
        };
        let live = current && status != McpStatus::Disabled && status != McpStatus::Checking && status != McpStatus::Unknown;
        servers.push(McpServer {
            name: p.name.clone(),
            origin: McpOrigin::Imported,
            path: p.path.clone(),
            source_label: Some(p.provider_name.clone().unwrap_or_else(|| p.provider.clone())),
            server,
            enabled,
            signed_in: p.signed_in,
            shadowed,
            status,
            error: p.error.clone().filter(|_| live),
            note: if shadowed { Some("Not loaded: a server with the same name takes precedence.".into()) } else { p.note.clone().or_else(|| auth_note(p)).filter(|_| live) },
            tools: if live && status == McpStatus::Connected { p.tools.clone() } else { vec![] },
            server_info: p.server_info.clone().filter(|_| live),
            checked_at: (live && p.at > 0).then_some(p.at),
            extra: vec![],
        });
    }
    let file_errors = files
        .iter()
        .filter_map(|f| match &f.loaded {
            Loaded::Bad(message) => Some(McpFileError { path: f.path.display().to_string(), message: message.clone() }),
            _ => None,
        })
        .collect();
    McpList {
        cwd: folder.map(|f| f.display().to_string()),
        user_path: mcp.user_file().display().to_string(),
        project_path: folder.map(|f| files::project_dir(f).join("mcp.json").display().to_string()),
        servers,
        check: McpCheckState { running, started_at: slot.and_then(|s| s.started_at), finished_at: slot.and_then(|s| s.finished_at), error: slot.and_then(|s| s.error.clone()) },
        omp_version: slot.and_then(|s| s.omp_version.clone()),
        live_sessions,
        file_errors,
    }
}

// ───────────────────────────── changes ─────────────────────────────

/// The scope's config folder (`project` needs `cwd`).
fn scope_dir(mcp: &Mcp, scope: McpScope, folder: Option<&Path>) -> Result<PathBuf, ApiError> {
    match scope {
        McpScope::User => Ok(mcp.agent_dir.clone()),
        McpScope::Project => folder.map(files::project_dir).ok_or_else(|| ApiError::new("invalid_params", "cwd: the project folder is needed for a project server")),
    }
}

/// The file of `scope` that defines `name` (`mcp.json`, else `.mcp.json`), else `mcp.json`.
fn file_defining(dir: &Path, name: &str) -> (PathBuf, bool) {
    let [main, alt] = files::scope_files(dir);
    for f in [&main, &alt] {
        if servers_of(&files::read(f)).is_some_and(|s| s.contains(name)) {
            return (f.clone(), true);
        }
    }
    (main, false)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, ApiError> + Send + 'static) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(f).await.map_err(|e| ApiError::new("internal", e.to_string()))?
}

fn servers_mut(root: &mut Obj) -> Result<&mut Obj, ApiError> {
    if !root.contains("mcpServers") {
        root.set("mcpServers", J::Obj(Obj::default()));
    }
    root.obj_mut("mcpServers").ok_or_else(|| ApiError::new("invalid_params", "the file's `mcpServers` is not an object").with_hint("Fix the file on the host first."))
}

/// What a change answers: reloads the sessions it concerns and lists again.
async fn changed(ctx: &Ctx, mcp: &Mcp, folder: Option<PathBuf>, scope_project: bool) -> Result<McpChanged, ApiError> {
    let reload = reload::reload(ctx, if scope_project { folder.as_deref() } else { None }).await;
    let list = list(ctx, mcp, folder, false, 0).await?;
    Ok(McpChanged { list, reload })
}

async fn save(ctx: &Ctx, mcp: &Mcp, p: McpSaveParams) -> Result<McpChanged, ApiError> {
    let (folder, project) = save_files(mcp, &p).await?;
    changed(ctx, mcp, folder, project).await
}

/// `mcp.save` on the files. Answers the folder and whether the change is project-scoped.
async fn save_files(mcp: &Mcp, p: &McpSaveParams) -> Result<(Option<PathBuf>, bool), ApiError> {
    let name = p.name.trim().to_string();
    model::validate_name(&name)?;
    let folder = folder(p.cwd.as_deref())?;
    let dir = scope_dir(mcp, p.scope, folder.as_deref())?;
    let prev = p.previous_name.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let (file, _) = file_defining(&dir, prev.as_deref().unwrap_or(&name));
    let (draft, enabled, f2, n2, prev2) = (p.server.clone(), p.enabled, file.clone(), name.clone(), prev.clone());
    blocking(move || {
        files::modify(&f2, |root| {
            let servers = servers_mut(root)?;
            match &prev2 {
                Some(old) => {
                    let Some(J::Obj(entry)) = servers.get_mut(old) else {
                        return Err(ApiError::new("not_found", format!("no server named “{old}” in {}", f2.display())));
                    };
                    let stored = entry.clone();
                    model::apply_draft(entry, &draft, Some(&stored))?;
                    if let Some(e) = enabled
                        && e != model::entry_enabled(entry)
                    {
                        entry.set("enabled", J::Bool(e));
                    }
                    if *old != n2 {
                        if servers.contains(&n2) {
                            return Err(ApiError::new("already_exists", format!("name: “{n2}” is already used in {}", f2.display())));
                        }
                        servers.rename(old, &n2);
                    }
                }
                None => {
                    if servers.contains(&n2) {
                        return Err(ApiError::new("already_exists", format!("name: “{n2}” is already used in {}", f2.display())));
                    }
                    let mut entry = Obj::default();
                    model::apply_draft(&mut entry, &draft, None)?;
                    if enabled == Some(false) {
                        entry.set("enabled", J::Bool(false));
                    }
                    servers.set(&n2, J::Obj(entry));
                }
            }
            Ok(())
        })
    })
    .await?;
    // A rename carries the user-level list entries along (they are keyed by name).
    let renamed = prev.filter(|o| *o != name);
    if let Some(old) = &renamed {
        let (user, old2, new2) = (mcp.user_file(), old.clone(), name.clone());
        if user.exists() {
            blocking(move || {
                files::modify(&user, |root| {
                    rename_in_lists(root, &old2, &new2);
                    Ok(())
                })
            })
            .await?;
        }
    }
    tracing::info!(scope = ?p.scope, name = %name, "mcp server saved");
    let project = p.scope == McpScope::Project;
    let key = mcp.cwd_for(folder.as_deref())?;
    mark_dirty(&key, &name);
    // A renamed server may have hidden another one of its old name.
    if let Some(old) = renamed {
        recheck_where_shown(mcp, &key, project, &old);
    }
    Ok((folder, project))
}

/// Checks `name` again in the lists a change of `key`'s folder shows in: that folder's for a
/// project change, every folder's for a user-level one (a removed or renamed server may have hidden
/// another of its name, which no definition change of that one tells).
fn recheck_where_shown(mcp: &Mcp, key: &Path, project: bool, name: &str) {
    mark_dirty(key, name);
    if !project {
        mark_dirty_everywhere(&mcp.user_file(), name);
    }
}

fn rename_in_lists(root: &mut Obj, old: &str, new: &str) {
    for key in ["disabledServers", "enabledServers"] {
        if let Some(J::Arr(a)) = root.get_mut(key)
            && a.iter().any(|v| v.as_str() == Some(old))
        {
            let mut names: Vec<String> = a.iter().filter_map(|v| v.as_str()).map(|s| if s == old { new.to_string() } else { s.to_string() }).collect();
            names.sort();
            names.dedup();
            *a = names.into_iter().map(J::Str).collect();
        }
    }
}

/// The native file and scope `name` is defined in (`scope` given: that scope only), in omp's
/// precedence order.
fn locate(mcp: &Mcp, folder: Option<&Path>, name: &str, scope: Option<McpScope>) -> Option<(PathBuf, McpScope)> {
    let mut scopes = Vec::new();
    if folder.is_some() && scope != Some(McpScope::User) {
        scopes.push(McpScope::Project);
    }
    if scope != Some(McpScope::Project) {
        scopes.push(McpScope::User);
    }
    scopes.into_iter().find_map(|s| {
        let dir = scope_dir(mcp, s, folder).ok()?;
        let (file, found) = file_defining(&dir, name);
        found.then_some((file, s))
    })
}

async fn remove(ctx: &Ctx, mcp: &Mcp, p: McpServerRef) -> Result<McpChanged, ApiError> {
    let (folder, project) = remove_files(mcp, &p).await?;
    changed(ctx, mcp, folder, project).await
}

async fn remove_files(mcp: &Mcp, p: &McpServerRef) -> Result<(Option<PathBuf>, bool), ApiError> {
    let folder = folder(p.cwd.as_deref())?;
    let (file, scope) = locate(mcp, folder.as_deref(), &p.name, p.scope).ok_or_else(|| ApiError::new("not_found", format!("no server named “{}” in omp's config", p.name)))?;
    let (f2, n2) = (file.clone(), p.name.clone());
    blocking(move || {
        files::modify(&f2, |root| {
            servers_mut(root)?.remove(&n2).map(drop).ok_or_else(|| ApiError::new("not_found", format!("no server named “{n2}” in {}", f2.display())))
        })
    })
    .await?;
    tracing::info!(scope = ?scope, name = %p.name, "mcp server removed");
    let project = scope == McpScope::Project;
    recheck_where_shown(mcp, &mcp.cwd_for(folder.as_deref())?, project, &p.name);
    Ok((folder, project))
}

/// omp's `setMcpServerEnabled`: the `enabled` flag of the first writable definition (the row's
/// own file, then project, then user), else the user-level lists; stale list entries are cleaned.
async fn set_enabled(ctx: &Ctx, mcp: &Mcp, p: McpEnableParams) -> Result<McpChanged, ApiError> {
    let (folder, project) = set_enabled_files(mcp, &p).await?;
    changed(ctx, mcp, folder, project).await
}

async fn set_enabled_files(mcp: &Mcp, p: &McpEnableParams) -> Result<(Option<PathBuf>, bool), ApiError> {
    let folder = folder(p.cwd.as_deref())?;
    let name = p.name.clone();
    let own = locate(mcp, folder.as_deref(), &name, p.scope).map(|(f, _)| f);
    let mut candidates: Vec<PathBuf> = own.into_iter().collect();
    if let Some(f) = &folder {
        candidates.push(files::project_dir(f).join("mcp.json"));
    }
    candidates.push(mcp.user_file());
    candidates.dedup();
    let (user, enabled, n2) = (mcp.user_file(), p.enabled, name.clone());
    let project_dir = folder.as_deref().map(files::project_dir);
    let project_scope = blocking(move || {
        let mut updated: Option<PathBuf> = None;
        for f in &candidates {
            if servers_of(&files::read(f)).is_some_and(|s| s.contains(&n2)) {
                files::modify(f, |root| {
                    if let Some(J::Obj(entry)) = servers_mut(root)?.get_mut(&n2) {
                        entry.set("enabled", J::Bool(enabled));
                    }
                    Ok(())
                })?;
                updated = Some(f.clone());
                break;
            }
        }
        let lists = |root: &Obj| (list_has(root, "disabledServers", &n2), list_has(root, "enabledServers", &n2));
        let (denied, forced) = match files::read(&user) {
            Loaded::Ok(root) => lists(&root),
            _ => (false, false),
        };
        let change: Vec<(&str, bool)> = if enabled {
            let mut c = Vec::new();
            if denied {
                c.push(("disabledServers", false));
            }
            if updated.is_none() && !forced {
                c.push(("enabledServers", true));
            } else if updated.is_some() && forced {
                c.push(("enabledServers", false));
            }
            c
        } else {
            let mut c = Vec::new();
            if forced {
                c.push(("enabledServers", false));
            }
            if updated.is_none() {
                c.push(("disabledServers", true));
            }
            c
        };
        if !change.is_empty() {
            files::modify(&user, |root| {
                for (key, add) in &change {
                    set_in_list(root, key, &n2, *add);
                }
                Ok(())
            })?;
        }
        Ok(updated.is_some_and(|f| project_dir.is_some_and(|d| f.parent() == Some(d.as_path()))))
    })
    .await?;
    let key = mcp.cwd_for(folder.as_deref())?;
    mark_dirty(&key, &name);
    tracing::info!(name = %name, enabled = p.enabled, "mcp server switched");
    Ok((folder, project_scope))
}

fn list_has(root: &Obj, key: &str, name: &str) -> bool {
    root.get(key).and_then(J::as_arr).is_some_and(|a| a.iter().any(|v| v.as_str() == Some(name)))
}

/// omp's `setServerDisabled` / `setServerForceEnabled`: a sorted name list, dropped when empty.
fn set_in_list(root: &mut Obj, key: &str, name: &str, present: bool) {
    let mut names: Vec<String> = root.get(key).and_then(J::as_arr).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
    names.retain(|n| n != name);
    if present {
        names.push(name.to_string());
    }
    names.sort();
    names.dedup();
    if names.is_empty() {
        root.remove(key);
    } else {
        root.set(key, J::Arr(names.into_iter().map(J::Str).collect()));
    }
}

// ───────────────────────────── test, sign-in, search ─────────────────────────────

async fn test(mcp: &Mcp, p: McpTestParams) -> Result<McpTestResult, ApiError> {
    let folder = folder(p.cwd.as_deref())?;
    let cwd = mcp.cwd_for(folder.as_deref())?;
    let mut req = json!({ "op": "test", "name": p.name, "timeoutMs": TEST_WINDOW_MS, "scope": p.scope });
    // The row's own definition (`scope`): a hidden one is never mistaken for the one hiding it.
    let stored = match p.scope {
        Some(s) => {
            let (file, found) = file_defining(&scope_dir(mcp, s, folder.as_deref())?, &p.name);
            let entry = found.then(|| servers_of(&files::read(&file)).and_then(|sv| sv.obj(&p.name)).cloned()).flatten();
            if entry.is_none() && p.server.is_none() {
                return Err(ApiError::new("not_found", format!("no server named “{}” in {}", p.name, file.display())));
            }
            entry
        }
        None => locate(mcp, folder.as_deref(), &p.name, None).and_then(|(f, _)| servers_of(&files::read(&f)).and_then(|sv| sv.obj(&p.name)).cloned()),
    };
    if let Some(draft) = &p.server {
        // Fill the draft's hidden values from the saved definition, if there is one.
        let mut entry = stored.clone().unwrap_or_default();
        model::apply_draft(&mut entry, draft, stored.as_ref())?;
        req["config"] = J::Obj(entry).to_value();
    } else if let Some(entry) = stored.filter(|_| p.scope.is_some()) {
        req["config"] = J::Obj(entry).to_value();
    }
    let res = helper::call(&mcp.helper, &cwd, req, Instant::now() + TEST_TIMEOUT).await?;
    let probed: Probed = serde_json::from_value(json!({
        "name": p.name, "status": res.get("status").cloned().unwrap_or(json!("failed")),
        "error": res.get("error"), "authType": res.get("authType"), "tools": res.get("tools").cloned().unwrap_or(json!([])),
        "serverInfo": res.get("serverInfo"),
    }))
    .map_err(|e| ApiError::new("omp_error", format!("test answer: {e}")))?;
    let status = match status_of(&probed) {
        McpStatus::Unknown | McpStatus::Disabled | McpStatus::Skipped | McpStatus::Checking => McpStatus::Failed,
        s => s,
    };
    Ok(McpTestResult {
        status,
        error: probed.error.clone().or_else(|| auth_note(&probed)),
        tools: probed.tools,
        server_info: probed.server_info,
        ms: res.get("ms").and_then(Value::as_u64).unwrap_or(0) as u32,
    })
}

/// The sign-in target: a native http/sse server that is on, defined in an `mcp.json` (omp's
/// `/mcp reauth` and `/mcp unauth` don't read the `.mcp.json` siblings). omp looks it up from the
/// project folder for a project server and from the neutral folder for a user one, so a hidden
/// user server is never taken for the project server of its name.
async fn auth_target(mcp: &Mcp, folder: Option<PathBuf>, name: &str, scope: Option<McpScope>) -> Result<(auth::Target, McpScope), ApiError> {
    let (file, s) = locate(mcp, folder.as_deref(), name, scope)
        .ok_or_else(|| ApiError::new("not_found", format!("no server named “{name}” in omp's config")).with_hint("Sign-in works for servers in omp's own config files."))?;
    if file.file_name().is_some_and(|n| n != "mcp.json") {
        return Err(ApiError::new("invalid_params", format!("“{name}” is defined in {}: omp signs in servers of its mcp.json files only", file.display()))
            .with_hint(format!("Move it to {} to sign in.", file.with_file_name("mcp.json").display())));
    }
    let entry = servers_of(&files::read(&file)).and_then(|sv| sv.obj(name)).cloned().unwrap_or_default();
    if model::transport_of(&entry) == McpTransport::Stdio {
        return Err(ApiError::new("invalid_params", format!("“{name}” is a local (stdio) server: it has no sign-in")).with_hint("Give it its credentials through its environment."));
    }
    if !model::entry_enabled(&entry) {
        return Err(ApiError::new("invalid_params", format!("“{name}” is switched off")).with_hint("Switch it on first."));
    }
    let project = (s == McpScope::Project).then_some(folder.clone()).flatten();
    let target = auth::Target {
        name: name.to_string(),
        path: file,
        check_key: mcp.cwd_for(folder.as_deref())?,
        cwd: mcp.cwd_for(project.as_deref())?,
        project,
    };
    Ok((target, s))
}

async fn sign_out(ctx: &Ctx, mcp: &Mcp, p: McpServerRef) -> Result<McpChanged, ApiError> {
    let folder = folder(p.cwd.as_deref())?;
    let (target, scope) = auth_target(mcp, folder.clone(), &p.name, p.scope).await?;
    helper::call(&mcp.helper, &target.cwd, json!({ "op": "unauth", "name": p.name, "path": target.path }), Instant::now() + TEST_TIMEOUT).await?;
    recheck_where_shown(mcp, &target.check_key, scope == McpScope::Project, &p.name);
    tracing::info!(name = %p.name, "mcp server signed out");
    changed(ctx, mcp, folder, scope == McpScope::Project).await
}

async fn search(mcp: &Mcp, p: McpSearchParams) -> Result<McpSearchResult, ApiError> {
    let query = p.query.trim();
    if query.is_empty() {
        return Ok(McpSearchResult { entries: vec![] });
    }
    let cwd = mcp.cwd_for(None)?;
    let limit = p.limit.unwrap_or(12).clamp(1, 30);
    let res = helper::call(&mcp.helper, &cwd, json!({ "op": "search", "query": query, "limit": limit }), Instant::now() + SEARCH_TIMEOUT).await?;
    let entries = res.get("entries").and_then(Value::as_array).map(|a| a.iter().filter_map(registry_entry).collect()).unwrap_or_default();
    Ok(McpSearchResult { entries })
}

fn registry_entry(v: &Value) -> Option<McpRegistryEntry> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let config = match J::from_value(v.get("config")?) {
        J::Obj(o) => o,
        _ => return None,
    };
    let inputs = v
        .get("inputs")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|i| {
                    let g = |k: &str| i.get(k).and_then(Value::as_str).map(str::to_string);
                    Some(McpRegistryInput {
                        key: g("key")?,
                        label: g("label").unwrap_or_default(),
                        kind: g("type").unwrap_or_else(|| "string".into()),
                        required: i.get("required").and_then(Value::as_bool).unwrap_or(false),
                        default_value: g("defaultValue"),
                        description: g("description"),
                        choices: i.get("enumValues").and_then(Value::as_array).map(|e| e.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default(),
                        secret: i.get("sensitive").and_then(Value::as_bool).unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(McpRegistryEntry {
        id: s("id")?,
        name: s("name")?,
        title: s("title").unwrap_or_default(),
        description: s("description"),
        use_count: v.get("useCount").and_then(Value::as_u64).unwrap_or(0),
        verified: v.get("verified").and_then(Value::as_bool).unwrap_or(false),
        remote: v.get("remote").and_then(Value::as_bool).unwrap_or(false),
        homepage: s("homepage"),
        icon_url: s("iconUrl"),
        server: model::to_draft(&config).0,
        inputs,
        warnings: v.get("warnings").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default(),
        tools: v.get("tools").and_then(|t| serde_json::from_value(t.clone()).ok()).unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests;
