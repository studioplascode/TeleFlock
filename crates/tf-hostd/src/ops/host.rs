//! `host.*` methods: health, usage (omp `stats.db`, read-only), model catalog, past
//! sessions + resume, setup checklist + fixes, activity; plus [`probe_info`] /
//! [`setup_status`] / [`health`] for the state store.
//!
//! Nothing here mutates omp or herdr configuration or installs anything except [`setup_apply`],
//! which only runs when a client calls `host.setupApply` with explicit fix ids, and
//! [`refresh_global_bridge`], which only replaces a global bridge copy the user installed.

use std::collections::HashMap;
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde_json::{json, Value};
use tf_proto::{
    ActivityPage, AgentSpec, ApiError, HostHealth, HostInfo, HostMethod, ModelCatalog, ModelInfo, PastSession, PastSessions,
    ResumeParams, RoleBinding, SessionsParams, SetupFixError, SetupIssue, SetupStatus, Severity, Started, ThinkingLevel,
    UsageDay, UsageModel, UsageReport, UsageTotals, VersionInfo,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tracing::{info, warn};

use crate::clients::ClientHandle;
use crate::ops::fs::{home_dir, resolve_path};
use crate::ops::git::{resolve_bin_all, run_cmd};
use crate::ops::install;
use crate::ops::scope::{self, FIX_HERDR_SCOPE};
use crate::ops::{herdr_err, to_value, Ctx};
use crate::paths::Paths;

pub const FIX_HERDR_INTEGRATION: &str = "install-herdr-integration";
pub const FIX_GLOBAL_SHARING: &str = "enable-global-sharing";
pub const FIX_GLOBAL_BRIDGE: &str = "install-global-bridge";
/// Minimum omp version TeleFlock is built against (collab relay + bridge ExtensionAPI).
const MIN_OMP: (u32, u32, u32) = (18, 12, 0);
const MODELS_TTL: Duration = Duration::from_secs(300);
const OMP_TIMEOUT: Duration = Duration::from_secs(20);
const SESSIONS_DEFAULT: usize = 50;
const SESSIONS_MAX: usize = 500;
/// Session files larger than this are not scanned for a message count.
const SESSION_COUNT_MAX: u64 = 16 * 1024 * 1024;

pub async fn handle(ctx: &Ctx, req: HostMethod, _client: &ClientHandle) -> Result<Value, ApiError> {
    match req {
        HostMethod::HostHealthReq(_) => to_value(health()),
        HostMethod::HostUsage(p) => {
            let days = p.days.clamp(1, 366);
            to_value(tokio::task::spawn_blocking(move || usage(&stats_db(), days)).await.map_err(join_err)??)
        }
        HostMethod::HostLimits(p) => to_value(crate::ops::limits::limits(ctx, p.refresh.unwrap_or(false)).await?),
        HostMethod::HostModels(_) => to_value(models().await?),
        HostMethod::HostSessions(p) => to_value(sessions(ctx, &p).await?),
        HostMethod::HostResume(p) => to_value(resume(ctx, p).await?),
        HostMethod::HostSetup(_) => to_value(setup_status(ctx).await),
        HostMethod::HostSetupApply(p) => to_value(setup_apply(ctx, &p.fixes).await?),
        HostMethod::HostActivity(p) => {
            let (events, has_more) = ctx.state.activity_page(p.before, p.limit.unwrap_or(50).clamp(1, 500) as usize, p.agent_id.as_deref());
            to_value(ActivityPage { events, has_more })
        }
        HostMethod::HostToolsUpdate(_) | HostMethod::HostToolsConfig(_) => crate::ops::tools::handle(ctx, req).await,
        other => Err(ApiError::new("unknown_method", format!("{} is not a host method", other.name()))),
    }
}

fn join_err(e: tokio::task::JoinError) -> ApiError {
    ApiError::new("internal", e.to_string())
}

// ───────────────────────────── paths ─────────────────────────────

/// omp's agent dir (`PI_CODING_AGENT_DIR`, else `~/.omp/agent`).
pub(crate) fn omp_agent_dir() -> PathBuf {
    std::env::var_os("PI_CODING_AGENT_DIR").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| home_dir().join(".omp").join("agent"))
}

fn stats_db() -> PathBuf {
    home_dir().join(".omp").join("stats.db")
}

/// The omp TeleFlock runs: the first one on PATH or in the well-known dirs that can start. A
/// script whose interpreter is missing (an npm or bun install whose runtime is gone) loses to a
/// later standalone binary, e.g. the one `install-omp` puts in ~/.local/bin; when none can start,
/// the first one (its setup issue says why).
pub(crate) fn omp_bin() -> Option<PathBuf> {
    let all = resolve_bin_all("omp");
    all.iter().find(|b| crate::userenv::missing_interpreter(b).is_none()).or(all.first()).cloned()
}

// ───────────────────────────── health ─────────────────────────────

/// CPU, memory, disk and uptime of the host. CPU% is measured against the previous call
/// (the first call measures a 100 ms window). Cheap; call it every few seconds.
pub fn health() -> HostHealth {
    platform::health()
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;

    /// (busy, total) jiffies of the previous sample.
    static LAST: LazyLock<Mutex<Option<(u64, u64)>>> = LazyLock::new(|| Mutex::new(None));

    fn cpu_times() -> Option<(u64, u64)> {
        let stat = std::fs::read_to_string("/proc/stat").ok()?;
        let line = stat.lines().next()?.strip_prefix("cpu ")?;
        let v: Vec<u64> = line.split_whitespace().filter_map(|x| x.parse().ok()).collect();
        if v.len() < 4 {
            return None;
        }
        // user nice system idle iowait irq softirq steal (guest* already in user/nice)
        let idle = v[3] + v.get(4).copied().unwrap_or(0);
        let total: u64 = v.iter().take(8).sum();
        Some((total - idle, total))
    }

    fn cpu_pct() -> f32 {
        let mut last = LAST.lock().unwrap_or_else(|p| p.into_inner());
        let prev = match *last {
            Some(p) => p,
            None => {
                let first = cpu_times().unwrap_or((0, 0));
                std::thread::sleep(Duration::from_millis(100));
                first
            }
        };
        let Some(now) = cpu_times() else { return 0.0 };
        *last = Some(now);
        let dt = now.1.saturating_sub(prev.1);
        if dt == 0 {
            return 0.0;
        }
        (now.0.saturating_sub(prev.0) as f32 / dt as f32 * 100.0).clamp(0.0, 100.0)
    }

    pub(crate) fn meminfo(text: &str) -> (u64, u64) {
        let field = |name: &str| -> u64 {
            text.lines()
                .find_map(|l| l.strip_prefix(name))
                .and_then(|r| r.trim().trim_end_matches("kB").trim().parse::<u64>().ok())
                .unwrap_or(0)
                * 1024
        };
        let total = field("MemTotal:");
        let avail = field("MemAvailable:");
        (total.saturating_sub(avail), total)
    }

    fn disk(path: &Path) -> (u64, u64) {
        use std::os::unix::ffi::OsStrExt;
        let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else { return (0, 0) };
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        // SAFETY: `c` is a valid NUL-terminated path and `st` a properly sized out-param.
        if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
            return (0, 0);
        }
        let frag = st.f_frsize as u64;
        (st.f_bavail as u64 * frag, st.f_blocks as u64 * frag)
    }

    pub fn health() -> HostHealth {
        let load1 = std::fs::read_to_string("/proc/loadavg").ok().and_then(|s| s.split_whitespace().next()?.parse().ok()).unwrap_or(0.0);
        let (mem_used, mem_total) = std::fs::read_to_string("/proc/meminfo").map(|s| meminfo(&s)).unwrap_or((0, 0));
        let uptime_s = std::fs::read_to_string("/proc/uptime").ok().and_then(|s| s.split_whitespace().next()?.parse::<f64>().ok()).unwrap_or(0.0) as u64;
        let (disk_free, disk_total) = disk(&home_dir());
        HostHealth {
            at: crate::util::now_ms(),
            cpu_pct: cpu_pct(),
            cores: std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(1),
            load1,
            mem_used,
            mem_total,
            disk_free,
            disk_total,
            uptime_s,
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod platform {
    use super::*;
    use sysinfo::{CpuRefreshKind, Disks, MemoryRefreshKind, RefreshKind, System};

    static SYS: LazyLock<Mutex<(System, bool)>> = LazyLock::new(|| {
        Mutex::new((
            System::new_with_specifics(RefreshKind::nothing().with_cpu(CpuRefreshKind::nothing().with_cpu_usage()).with_memory(MemoryRefreshKind::everything())),
            false,
        ))
    });

    pub fn health() -> HostHealth {
        let mut guard = SYS.lock().unwrap_or_else(|p| p.into_inner());
        let (sys, primed) = &mut *guard;
        if !*primed {
            sys.refresh_cpu_usage();
            std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL.max(Duration::from_millis(100)));
            *primed = true;
        }
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        let home = home_dir();
        let disks = Disks::new_with_refreshed_list();
        // The disk holding the home directory (longest matching mount point).
        let disk = disks.list().iter().filter(|d| home.starts_with(d.mount_point())).max_by_key(|d| d.mount_point().as_os_str().len());
        HostHealth {
            at: crate::util::now_ms(),
            cpu_pct: sys.global_cpu_usage().clamp(0.0, 100.0),
            cores: sys.cpus().len().max(1) as u32,
            load1: System::load_average().one as f32,
            mem_used: sys.used_memory(),
            mem_total: sys.total_memory(),
            disk_free: disk.map(|d| d.available_space()).unwrap_or(0),
            disk_total: disk.map(|d| d.total_space()).unwrap_or(0),
            uptime_s: System::uptime(),
        }
    }
}

// ───────────────────────────── usage ─────────────────────────────

pub(crate) fn open_ro(path: &Path) -> Result<Option<rusqlite::Connection>, ApiError> {
    if !path.exists() {
        return Ok(None);
    }
    let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let uri = format!("file:{}?mode=ro", uri_path(path));
    let conn = rusqlite::Connection::open_with_flags(uri, flags)
        .map_err(|e| ApiError::new("io_error", format!("open {}: {e}", path.display())))?;
    let _ = conn.busy_timeout(Duration::from_secs(2));
    Ok(Some(conn))
}

/// Percent-encodes the characters that are special in SQLite URIs.
fn uri_path(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '?' => out.push_str("%3f"),
            '#' => out.push_str("%23"),
            '%' => out.push_str("%25"),
            _ => out.push(c),
        }
    }
    if out.as_bytes().get(1) == Some(&b':') {
        // Windows drive path: file:/C:/...
        out.insert(0, '/');
    }
    out
}

fn sql_err(e: rusqlite::Error) -> ApiError {
    ApiError::new("io_error", format!("stats.db: {e}"))
}

/// Usage totals from omp's `stats.db` (read-only): today, the last `days` local days
/// (oldest first, zero-filled) and per-model totals over that window. `stats.db` is as
/// current as omp's last stats sync.
pub fn usage(db: &Path, days: u32) -> Result<UsageReport, ApiError> {
    let empty = || UsageTotals { cost_usd: 0.0, tokens: 0, input: 0, output: 0 };
    let Some(conn) = open_ro(db)? else {
        return Ok(UsageReport { today: empty(), days: zero_days(days), models: vec![] });
    };
    let today = conn
        .query_row(
            "SELECT COALESCE(SUM(cost_total),0), COALESCE(SUM(total_tokens),0),
                    COALESCE(SUM(input_tokens + cache_read_tokens + cache_write_tokens),0), COALESCE(SUM(output_tokens),0)
             FROM messages
             WHERE timestamp >= CAST(strftime('%s','now','localtime','start of day','utc') AS INTEGER) * 1000",
            [],
            |r| Ok(UsageTotals { cost_usd: r.get(0)?, tokens: r.get::<_, i64>(1)? as u64, input: r.get::<_, i64>(2)? as u64, output: r.get::<_, i64>(3)? as u64 }),
        )
        .map_err(sql_err)?;
    let back = format!("-{} days", days.saturating_sub(1));
    let mut stmt = conn
        .prepare(
            "WITH RECURSIVE d(day) AS (
                 SELECT date('now','localtime', ?1)
                 UNION ALL SELECT date(day, '+1 day') FROM d WHERE day < date('now','localtime')
             ),
             agg AS (
                 SELECT date(timestamp/1000,'unixepoch','localtime') AS day, SUM(cost_total) AS cost, SUM(total_tokens) AS tokens
                 FROM messages
                 WHERE timestamp >= CAST(strftime('%s', date('now','localtime', ?1), 'utc') AS INTEGER) * 1000
                 GROUP BY 1
             )
             SELECT d.day, COALESCE(agg.cost,0), COALESCE(agg.tokens,0) FROM d LEFT JOIN agg ON agg.day = d.day ORDER BY d.day",
        )
        .map_err(sql_err)?;
    let days_v = stmt
        .query_map([&back], |r| Ok(UsageDay { day: r.get(0)?, cost_usd: r.get(1)?, tokens: r.get::<_, i64>(2)? as u64 }))
        .map_err(sql_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_err)?;
    let mut stmt = conn
        .prepare(
            "SELECT provider || '/' || model, SUM(cost_total), SUM(total_tokens) FROM messages
             WHERE timestamp >= CAST(strftime('%s', date('now','localtime', ?1), 'utc') AS INTEGER) * 1000
             GROUP BY provider, model ORDER BY 2 DESC, 3 DESC",
        )
        .map_err(sql_err)?;
    let models = stmt
        .query_map([&back], |r| Ok(UsageModel { model: r.get(0)?, cost_usd: r.get(1)?, tokens: r.get::<_, i64>(2)? as u64 }))
        .map_err(sql_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_err)?;
    Ok(UsageReport { today, days: days_v, models })
}

fn zero_days(days: u32) -> Vec<UsageDay> {
    let now = crate::util::now_ms();
    (0..days as i64)
        .rev()
        .map(|i| UsageDay { day: crate::util::local_day(now - i * 86_400_000), cost_usd: 0.0, tokens: 0 })
        .collect()
}

/// Today's totals (host-local day) for the board ticker.
pub fn usage_today() -> UsageTotals {
    usage(&stats_db(), 1).map(|r| r.today).unwrap_or(UsageTotals { cost_usd: 0.0, tokens: 0, input: 0, output: 0 })
}

// ───────────────────────────── models ─────────────────────────────

static MODELS: LazyLock<tokio::sync::Mutex<Option<(Instant, ModelCatalog)>>> = LazyLock::new(|| tokio::sync::Mutex::new(None));

/// omp's model catalog and role bindings, cached for five minutes (concurrent callers
/// share one fetch).
pub async fn models() -> Result<ModelCatalog, ApiError> {
    let mut cache = MODELS.lock().await;
    if let Some((at, cat)) = cache.as_ref()
        && at.elapsed() < MODELS_TTL {
            return Ok(cat.clone());
        }
    let cat = fetch_models().await?;
    *cache = Some((Instant::now(), cat.clone()));
    Ok(cat)
}

/// Drops the cached catalog (next `host.models` re-fetches).
pub async fn invalidate_models() {
    *MODELS.lock().await = None;
}

fn omp_missing() -> ApiError {
    ApiError::new("omp_error", "omp is not installed on this host").with_hint("Install it from Host setup in TeleFlock, or make sure `omp` is on PATH or in ~/.local/bin.")
}

async fn fetch_models() -> Result<ModelCatalog, ApiError> {
    let bin = omp_bin().ok_or_else(omp_missing)?;
    let (roles, list) = tokio::join!(omp_config_get(&bin, "modelRoles"), rpc_models(&bin));
    let list = match list {
        Ok(v) => v,
        Err(rpc_err) => {
            tracing::warn!("rpc get_available_models failed ({rpc_err}); falling back to `omp models --json`");
            let out = run_cmd(&bin, &["models", "--json"], Some(&std::env::temp_dir()), &[("NO_COLOR", "1")], None, OMP_TIMEOUT)
                .await
                .map_err(|e| ApiError::new("omp_error", format!("omp models: {e}")))?;
            if !out.ok() {
                return Err(ApiError::new("omp_error", format!("omp models failed: {}", out.message())));
            }
            let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| ApiError::new("omp_error", format!("omp models output: {e}")))?;
            v.get("models").and_then(Value::as_array).cloned().unwrap_or_default()
        }
    };
    let roles = roles.ok().and_then(|v| v.get("value").cloned()).unwrap_or(Value::Null);
    Ok(ModelCatalog { models: list.iter().filter_map(parse_model).collect(), roles: parse_roles(&roles) })
}

/// `omp config get <key> --json` (read-only).
async fn omp_config_get(bin: &Path, key: &str) -> Result<Value, ApiError> {
    let out = run_cmd(bin, &["config", "get", key, "--json"], Some(&std::env::temp_dir()), &[("NO_COLOR", "1")], None, OMP_TIMEOUT)
        .await
        .map_err(|e| ApiError::new("omp_error", format!("omp config get {key}: {e}")))?;
    if !out.ok() {
        return Err(ApiError::new("omp_error", format!("omp config get {key}: {}", out.message())));
    }
    serde_json::from_slice(&out.stdout).map_err(|e| ApiError::new("omp_error", format!("omp config get {key}: {e}")))
}

/// Headless `omp --mode rpc --no-ui` → `get_available_models` (no LLM call, no session).
async fn rpc_models(bin: &Path) -> Result<Vec<Value>, ApiError> {
    let mut child = tokio::process::Command::new(bin)
        .args(["--mode", "rpc", "--no-ui", "--no-session", "--no-extensions", "--no-skills", "--no-tools"])
        .current_dir(std::env::temp_dir())
        .env("NO_COLOR", "1")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| ApiError::new("omp_error", format!("spawn omp rpc: {e}")))?;
    let mut stdin = child.stdin.take().ok_or_else(|| ApiError::new("internal", "rpc stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| ApiError::new("internal", "rpc stdout"))?;
    let work = async {
        stdin
            .write_all(b"{\"id\":\"tf-models\",\"type\":\"get_available_models\"}\n")
            .await
            .map_err(|e| ApiError::new("omp_error", format!("rpc write: {e}")))?;
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        while let Some(line) = lines.next_line().await.map_err(|e| ApiError::new("omp_error", format!("rpc read: {e}")))? {
            if !line.contains("\"tf-models\"") {
                continue;
            }
            let v: Value = serde_json::from_str(&line).map_err(|e| ApiError::new("omp_error", format!("rpc frame: {e}")))?;
            if v.get("success").and_then(Value::as_bool) != Some(true) {
                return Err(ApiError::new("omp_error", format!("get_available_models: {}", v.get("error").cloned().unwrap_or(Value::Null))));
            }
            return Ok(v.pointer("/data/models").and_then(Value::as_array).cloned().unwrap_or_default());
        }
        Err(ApiError::new("omp_error", "omp rpc exited before answering"))
    };
    let res = tokio::time::timeout(OMP_TIMEOUT, work).await.unwrap_or_else(|_| Err(ApiError::new("timeout", "omp rpc timed out")));
    let _ = child.kill().await;
    res
}

fn thinking_level(s: &str) -> Option<ThinkingLevel> {
    serde_json::from_value(Value::String(s.to_string())).ok()
}

/// One model from RPC `get_available_models` (`thinking: {mode, efforts}`) or
/// `omp models --json` (`thinking: Effort[] | null`).
pub(crate) fn parse_model(v: &Value) -> Option<ModelInfo> {
    let provider = v.get("provider")?.as_str()?.to_string();
    let id = v.get("id")?.as_str()?.to_string();
    let reasoning = v.get("reasoning").and_then(Value::as_bool).unwrap_or(false);
    let efforts: Vec<ThinkingLevel> = match v.get("thinking") {
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).filter_map(thinking_level).collect(),
        Some(Value::Object(o)) => o.get("efforts").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).filter_map(thinking_level).collect()).unwrap_or_default(),
        _ => vec![],
    };
    let mut thinking = Vec::new();
    if reasoning || !efforts.is_empty() {
        thinking.push(ThinkingLevel::Off);
        thinking.extend(efforts.into_iter().filter(|l| *l != ThinkingLevel::Off));
    }
    Some(ModelInfo {
        label: v.get("name").and_then(Value::as_str).map(str::to_string),
        context_window: v.get("contextWindow").and_then(Value::as_u64),
        provider,
        id,
        thinking,
    })
}

pub(crate) fn parse_roles(v: &Value) -> Vec<RoleBinding> {
    const ORDER: &[&str] = &["default", "smol", "slow", "plan", "task", "tiny", "commit", "vision", "advisor", "designer", "memory", "widget"];
    let mut roles: Vec<RoleBinding> = v
        .as_object()
        .map(|o| o.iter().filter_map(|(k, v)| Some(RoleBinding { role: k.clone(), model: v.as_str()?.to_string() })).collect())
        .unwrap_or_default();
    roles.sort_by_key(|r| (ORDER.iter().position(|o| *o == r.role).unwrap_or(ORDER.len()), r.role.clone()));
    roles
}

// ───────────────────────────── sessions ─────────────────────────────

/// Header facts of one session file.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct SessionHead {
    pub id: Option<String>,
    pub cwd: Option<String>,
    pub title: Option<String>,
}

/// Parses the title slot (line 1) and header (line 2) of an omp session file.
pub(crate) fn parse_session_head(first: &str, second: &str) -> SessionHead {
    let mut head = SessionHead::default();
    for line in [first, second] {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { continue };
        match v.get("type").and_then(Value::as_str) {
            Some("title") => head.title = v.get("title").and_then(Value::as_str).map(str::to_string).filter(|t| !t.is_empty()),
            Some("session") => {
                head.id = v.get("id").and_then(Value::as_str).map(str::to_string);
                head.cwd = v.get("cwd").and_then(Value::as_str).map(str::to_string);
                if head.title.is_none() {
                    head.title = v.get("title").and_then(Value::as_str).map(str::to_string).filter(|t| !t.is_empty());
                }
            }
            _ => {}
        }
    }
    head
}

/// `<ts>_<uuid>.jsonl` → `<uuid>`.
fn id_from_file_name(p: &Path) -> Option<String> {
    let stem = p.file_stem()?.to_str()?;
    stem.rsplit_once('_').map(|(_, id)| id.to_string())
}

fn read_head(p: &Path) -> SessionHead {
    let Ok(f) = std::fs::File::open(p) else { return SessionHead::default() };
    let mut r = std::io::BufReader::new(f.take(64 * 1024));
    let (mut a, mut b) = (String::new(), String::new());
    let _ = r.read_line(&mut a);
    let _ = r.read_line(&mut b);
    parse_session_head(&a, &b)
}

/// Number of `message` entries (user/assistant/tool results), `None` for huge files.
fn count_messages(p: &Path, size: u64) -> Option<u32> {
    if size > SESSION_COUNT_MAX {
        return None;
    }
    let f = std::fs::File::open(p).ok()?;
    let mut n = 0u32;
    for line in std::io::BufReader::new(f).split(b'\n').map_while(Result::ok) {
        if line.starts_with(b"{\"type\":\"message\"") {
            n += 1;
        }
    }
    Some(n)
}

fn session_titles() -> HashMap<String, String> {
    let db = omp_agent_dir().join("history.db");
    let Ok(Some(conn)) = open_ro(&db) else { return HashMap::new() };
    let Ok(mut stmt) = conn.prepare("SELECT session_id, title FROM session_titles") else { return HashMap::new() };
    stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

/// Past omp sessions, newest first. `live` maps session file / id → (agent id, running): a
/// parked agent's session lists its agent id but is not live (resuming it reopens that agent).
pub(crate) fn scan_sessions(dir: &Path, cwd: Option<&Path>, limit: usize, live: &HashMap<String, (String, bool)>) -> Vec<PastSession> {
    let mut files: Vec<(i64, u64, PathBuf)> = Vec::new();
    let Ok(buckets) = std::fs::read_dir(dir) else { return vec![] };
    for bucket in buckets.flatten() {
        if !bucket.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(bucket.path()) else { continue };
        for f in rd.flatten() {
            let p = f.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(meta) = f.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0);
            files.push((mtime, meta.len(), p));
        }
    }
    files.sort_by_key(|f| std::cmp::Reverse(f.0));
    let titles = session_titles();
    let mut out = Vec::new();
    for (mtime, size, path) in files {
        if out.len() >= limit {
            break;
        }
        let head = read_head(&path);
        if let Some(want) = cwd
            && head.cwd.as_deref().map(|c| Path::new(c) != want).unwrap_or(true) {
                continue;
            }
        let messages = count_messages(&path, size);
        if messages == Some(0) {
            continue; // never prompted: nothing to resume
        }
        let id = head.id.clone().or_else(|| id_from_file_name(&path)).unwrap_or_default();
        let file = path.display().to_string();
        let agent = live.get(&file).or_else(|| live.get(&id));
        out.push(PastSession {
            title: titles.get(&id).cloned().or(head.title),
            cwd: head.cwd,
            updated_at: mtime,
            messages,
            live: agent.is_some_and(|(_, running)| *running),
            agent_id: agent.map(|(a, _)| a.clone()),
            file,
            id,
        });
    }
    out
}

/// Session file / session id → (agent id, running) for every omp agent on the board (parked
/// agents are not running).
fn live_sessions(ctx: &Ctx) -> HashMap<String, (String, bool)> {
    let mut m = HashMap::new();
    for a in ctx.state.snapshot().agents {
        if let Some(omp) = &a.omp {
            let v = (a.id.clone(), a.parked.is_none());
            if let Some(f) = &omp.session_file {
                m.insert(f.clone(), v.clone());
            }
            if let Some(s) = &omp.session_id {
                m.insert(s.clone(), v);
            }
        }
    }
    m
}

pub async fn sessions(ctx: &Ctx, p: &SessionsParams) -> Result<PastSessions, ApiError> {
    let cwd = match p.cwd.as_deref().filter(|c| !c.trim().is_empty()) {
        Some(c) => Some(resolve_path(c)?),
        None => None,
    };
    let limit = p.limit.map(|l| l as usize).unwrap_or(SESSIONS_DEFAULT).clamp(1, SESSIONS_MAX);
    let live = live_sessions(ctx);
    let dir = omp_agent_dir().join("sessions");
    let sessions = tokio::task::spawn_blocking(move || scan_sessions(&dir, cwd.as_deref(), limit, &live)).await.map_err(join_err)?;
    Ok(PastSessions { sessions })
}

pub async fn resume(ctx: &Ctx, p: ResumeParams) -> Result<Started, ApiError> {
    let file = resolve_path(&p.session_file)?;
    if !file.is_file() || file.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return Err(ApiError::new("not_found", format!("{} is not an omp session file", file.display())));
    }
    let file_s = file.display().to_string();
    let live = live_sessions(ctx);
    let id = id_from_file_name(&file).unwrap_or_default();
    if let Some((agent_id, running)) = live.get(&file_s).or_else(|| live.get(&id)) {
        if !running {
            // A parked agent: reopen it (same name, model, archive cleared) at the asked target.
            return crate::ops::agent::resume_parked(ctx, agent_id, Some(p.target), None, Vec::new()).await;
        }
        let name = ctx.state.agent(agent_id).map(|a| a.name).unwrap_or_else(|| agent_id.clone());
        return Err(ApiError::new("busy", format!("this session is open in agent {name}"))
            .with_hint("Resuming a live session would fork it. Open that agent instead."));
    }
    let spec = AgentSpec { name: None, kind: "omp".into(), model: None, thinking: None, plan: false, prompt: None, images: Vec::new() };
    crate::ops::agent::start_agent(ctx, p.target, &spec, Some(&file_s)).await
}

// ───────────────────────────── setup ─────────────────────────────

fn bridge_install_path() -> PathBuf {
    omp_agent_dir().join("extensions").join("teleflock-bridge.ts")
}

fn relay_url(port: u16) -> String {
    format!("ws://127.0.0.1:{port}")
}

#[derive(Debug, PartialEq)]
enum IntegrationState {
    Current,
    Outdated,
    Missing,
    Unknown,
}

async fn herdr_integration(ctx: &Ctx) -> IntegrationState {
    match ctx.herdr.request::<Value>("integration.list", json!({})).await {
        Ok(v) => {
            let state = v
                .get("integrations")
                .and_then(Value::as_array)
                .and_then(|a| a.iter().find(|i| i.get("target").and_then(Value::as_str) == Some("omp")))
                .and_then(|i| i.get("state").and_then(Value::as_str))
                .unwrap_or("");
            match state {
                "current" | "installed" => IntegrationState::Current,
                "outdated" => IntegrationState::Outdated,
                "not_installed" => IntegrationState::Missing,
                _ => IntegrationState::Unknown,
            }
        }
        Err(_) => {
            if omp_agent_dir().join("extensions").join("herdr-omp-agent-state.ts").is_file() {
                IntegrationState::Current
            } else {
                IntegrationState::Unknown
            }
        }
    }
}

/// The setup checklist (no side effects).
pub async fn setup_status(ctx: &Ctx) -> SetupStatus {
    let port = ctx.relay_port;
    let omp = omp_bin();
    let (integration, sharing, login_bound, missing) = tokio::join!(
        herdr_integration(ctx),
        async {
            let bin = omp.as_ref()?;
            Some(collab_settings(bin).await)
        },
        scope::herdr_in_login_session(&ctx.herdr.endpoint().socket),
        install::missing(ctx)
    );
    let installed = bridge_install_path();
    let bridge_installed = installed.is_file();
    let bridge_current = bridge_installed && std::fs::read(&installed).ok() == std::fs::read(&ctx.paths.ext).ok();
    let relay = ctx.omp.relay_listening();

    // What is not installed comes first: everything else builds on omp and herdr.
    let mut issues = missing.core;
    match integration {
        // herdr's own installer installs it, once herdr is there.
        _ if missing.herdr => {}
        IntegrationState::Current => {}
        IntegrationState::Outdated => issues.push(SetupIssue {
            id: FIX_HERDR_INTEGRATION.into(),
            severity: Severity::Warn,
            title: "Update herdr's omp integration".into(),
            detail: "herdr's omp state integration is outdated; agent states may be reported incorrectly.".into(),
            fixable: true,
            recommended: true,
        }),
        IntegrationState::Missing | IntegrationState::Unknown => issues.push(SetupIssue {
            id: FIX_HERDR_INTEGRATION.into(),
            severity: Severity::Error,
            title: "Install herdr's omp integration".into(),
            detail: "Without it herdr cannot tell whether omp agents are working, blocked or idle (runs `herdr integration install omp`).".into(),
            fixable: true,
            recommended: true,
        }),
    }
    let want = relay_url(port);
    let global_sharing = matches!(&sharing, Some((Some(a), Some(u))) if a == "control" && *u == want);
    if omp.is_some() && !global_sharing {
        let current = match &sharing {
            Some((a, u)) => format!(" Now: autoStart={}, relayUrl={}.", a.as_deref().unwrap_or("?"), u.as_deref().unwrap_or("?")),
            None => String::new(),
        };
        issues.push(SetupIssue {
            id: FIX_GLOBAL_SHARING.into(),
            severity: Severity::Warn,
            title: "Share every omp session with TeleFlock".into(),
            detail: format!(
                "Sessions you start by hand (or that herdr restores) only appear live in TeleFlock if omp shares them on the private relay. Sets collab.autoStart=control and collab.relayUrl={want} in omp's global config; rooms stay on this host.{current}"
            ),
            fixable: true,
            recommended: true,
        });
    }
    if !bridge_current {
        let source = ctx.paths.ext.is_file();
        issues.push(SetupIssue {
            id: FIX_GLOBAL_BRIDGE.into(),
            severity: Severity::Info,
            title: if bridge_installed { "Update the TeleFlock omp extension".into() } else { "Install the TeleFlock omp extension globally".into() },
            detail: if source {
                format!(
                    "Gives precise remote controls (model, thinking, plan review, rename, compact, tree) for sessions TeleFlock did not start. Copies {} to {}.",
                    ctx.paths.ext.display(),
                    installed.display()
                )
            } else {
                format!("The extension has not been uploaded to {} yet; reconnect the app to upload it.", ctx.paths.ext.display())
            },
            fixable: source,
            recommended: true,
        });
    }
    issues.extend(login_bound.map(|b| scope::issue(&b, &ctx.herdr_session)));
    issues.extend(ctx.omp.relay_issue());
    issues.extend(missing.extras);
    let (applying, failed) = lock(&APPLYING).report(&issues);
    SetupStatus { herdr_integration: integration == IntegrationState::Current, global_sharing, global_bridge: bridge_installed, relay, issues, applying, failed }
}

/// (size, mtime) of a file: what the probe caches below are keyed on.
fn stamp(path: &Path) -> Option<(u64, std::time::SystemTime)> {
    std::fs::metadata(path).ok().and_then(|m| Some((m.len(), m.modified().ok()?)))
}

type CollabSettings = (Option<String>, Option<String>);
/// Last answer per (config.yml stamp, omp binary, its stamp).
static COLLAB: LazyLock<Mutex<Option<((Option<(u64, std::time::SystemTime)>, PathBuf, Option<(u64, std::time::SystemTime)>), CollabSettings)>>> =
    LazyLock::new(Default::default);

/// omp's global `collab.autoStart` and `collab.relayUrl`: read from its `config.yml` when the file
/// states both plainly, else from `omp config get` (two omp starts). Cached until config.yml or
/// the omp binary changes; failed CLI answers are not cached.
async fn collab_settings(bin: &Path) -> CollabSettings {
    let config = omp_agent_dir().join("config.yml");
    let key = (stamp(&config), bin.to_path_buf(), stamp(bin));
    if let Some((_, v)) = lock(&COLLAB).as_ref().filter(|(k, _)| *k == key) {
        return v.clone();
    }
    let from_file = std::fs::read_to_string(&config).ok().and_then(|t| collab_from_yaml(&t)).filter(|(a, u)| a.is_some() && u.is_some());
    let value = match from_file {
        Some(v) => v,
        None => {
            let (auto, url) = tokio::join!(omp_config_get(bin, "collab.autoStart"), omp_config_get(bin, "collab.relayUrl"));
            let failed = auto.is_err() || url.is_err();
            let get = |r: Result<Value, ApiError>| r.ok().and_then(|v| v.get("value").and_then(Value::as_str).map(str::to_string));
            let v = (get(auto), get(url));
            if failed {
                return v;
            }
            v
        }
    };
    *lock(&COLLAB) = Some((key, value.clone()));
    value
}

/// `collab.autoStart` / `collab.relayUrl` from omp's `config.yml` as omp writes it (a top-level
/// `collab:` block of `key: value` lines, plain or double-quoted). `None` for any other shape
/// (flow style, multi-line or tagged values, duplicates, tabs): the caller asks omp instead.
fn collab_from_yaml(text: &str) -> Option<CollabSettings> {
    let (mut in_collab, mut seen, mut indent) = (false, false, None);
    let (mut auto, mut url) = (None, None);
    for line in text.lines() {
        let body = line.trim_end();
        let trimmed = body.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let lead = &body[..body.len() - trimmed.len()];
        if lead.contains('\t') {
            return None;
        }
        if lead.is_empty() {
            in_collab = false;
            let (key, rest) = trimmed.split_once(':')?;
            if key == "collab" {
                if seen || !strip_comment(rest).trim().is_empty() {
                    return None;
                }
                (seen, in_collab, indent) = (true, true, None);
            }
            continue;
        }
        if !in_collab || *indent.get_or_insert(lead.len()) != lead.len() {
            continue;
        }
        let (key, rest) = trimmed.split_once(':')?;
        let slot = match key {
            "autoStart" => &mut auto,
            "relayUrl" => &mut url,
            _ => continue,
        };
        if slot.is_some() {
            return None;
        }
        *slot = Some(yaml_scalar(rest)?);
    }
    Some((auto, url))
}

/// `# comment` after a value (a `#` that starts the text or follows a space).
fn strip_comment(s: &str) -> &str {
    let b = s.as_bytes();
    (0..b.len()).find(|&i| b[i] == b'#' && (i == 0 || b[i - 1] == b' ')).map_or(s, |i| &s[..i])
}

/// A one-line plain or double-quoted YAML string (`None` for anything else).
fn yaml_scalar(raw: &str) -> Option<String> {
    let v = raw.trim();
    if v.starts_with('"') {
        let mut values = serde_json::Deserializer::from_str(v).into_iter::<String>();
        let s = values.next()?.ok()?;
        return strip_comment(&v[values.byte_offset()..]).trim().is_empty().then_some(s);
    }
    let plain = strip_comment(v).trim();
    let special = plain.starts_with(['\'', '[', ']', '{', '}', '&', '*', '!', '|', '>', '%', '@', '`']);
    (!plain.is_empty() && !special && !matches!(plain, "~" | "null" | "Null" | "NULL")).then(|| plain.to_string())
}

/// Fix order within one `host.setupApply`: installs first (later fixes configure what they
/// install), the optional tools last.
const APPLY_ORDER: [&str; 10] = [
    install::FIX_BUN,
    install::FIX_OMP,
    install::FIX_HERDR,
    FIX_HERDR_SCOPE,
    FIX_HERDR_INTEGRATION,
    FIX_GLOBAL_SHARING,
    FIX_GLOBAL_BRIDGE,
    install::FIX_GIT,
    install::FIX_GH,
    install::FIX_FFMPEG,
];
/// `host.setupApply` answers once its fixes are done or after this long (the app's request
/// timeout is 30 s); the rest arrives through `HostInfo.setup` (`applying`, then the outcome).
const APPLY_REPLY_WITHIN: Duration = Duration::from_secs(20);

/// Fixes queued or running and the last failure per fix. Host-wide: installs and global config
/// are the same for every herdr session's checklist.
#[derive(Debug, Default)]
struct Applying {
    /// Fix id → batches that still have it to do.
    pending: HashMap<String, usize>,
    /// Fix id → why its last attempt failed.
    failed: HashMap<String, ApiError>,
}

impl Applying {
    fn queue(&mut self, fixes: &[String]) {
        for fix in fixes {
            *self.pending.entry(fix.clone()).or_default() += 1;
        }
    }

    fn done(&mut self, fix: &str, outcome: Result<(), ApiError>) {
        if let Some(n) = self.pending.get_mut(fix) {
            *n -= 1;
            if *n == 0 {
                self.pending.remove(fix);
            }
        }
        match outcome {
            Ok(()) => self.failed.remove(fix),
            Err(e) => self.failed.insert(fix.to_string(), e),
        };
    }

    /// `applying` (in fix order) and `failed` (open issues not being retried, in checklist
    /// order) for a checklist of `issues`.
    fn report(&self, issues: &[SetupIssue]) -> (Vec<String>, Vec<SetupFixError>) {
        let applying = APPLY_ORDER.iter().filter(|f| self.pending.contains_key(**f)).map(|f| f.to_string()).collect();
        let failed = issues
            .iter()
            .filter(|i| !self.pending.contains_key(&i.id))
            .filter_map(|i| self.failed.get(&i.id).map(|e| SetupFixError { id: i.id.clone(), error: e.clone() }))
            .collect();
        (applying, failed)
    }
}

static APPLYING: LazyLock<Mutex<Applying>> = LazyLock::new(Default::default);
/// One batch at a time: installs and config writes never interleave.
static APPLY_ONE: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(Default::default);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Applies the requested fixes (only ever on an explicit client request), each on its own: a
/// failing fix lands in `failed` and the next one still runs. Answers with the fresh checklist
/// once they are done, or after [`APPLY_REPLY_WITHIN`] with `applying` naming the ones still
/// running; the job republishes `HostInfo` as it goes (after each fix when it installs anything).
pub async fn setup_apply(ctx: &Ctx, fixes: &[String]) -> Result<SetupStatus, ApiError> {
    if let Some(unknown) = fixes.iter().find(|f| !APPLY_ORDER.contains(&f.as_str())) {
        return Err(ApiError::new("invalid_params", format!("unknown setup fix `{unknown}`")));
    }
    let ordered: Vec<String> = APPLY_ORDER.iter().filter(|f| fixes.iter().any(|x| x == *f)).map(|f| f.to_string()).collect();
    lock(&APPLYING).queue(&ordered);
    let (tx, rx) = tokio::sync::oneshot::channel();
    let job = ctx.arc();
    tokio::spawn(async move {
        let _one = APPLY_ONE.lock().await;
        let installs = ordered.iter().any(|f| install::FIXES.contains(&f.as_str()));
        if installs {
            // Every client of this session sees what runs.
            publish(&job).await;
        }
        apply_each(
            &APPLYING,
            &ordered,
            |fix| {
                let job = job.clone();
                async move { apply_fix(&job, &fix).await }
            },
            |left| {
                let job = job.clone();
                async move {
                    if installs && left > 0 {
                        publish(&job).await;
                    }
                }
            },
        )
        .await;
        let _ = tx.send(publish(&job).await);
    });
    match tokio::time::timeout(APPLY_REPLY_WITHIN, rx).await {
        Ok(Ok(status)) => Ok(status),
        _ => Ok(setup_status(ctx).await),
    }
}

/// Runs `fixes` in order, each on its own: its outcome is recorded in `applying` and the next fix
/// runs whether or not it failed. `after` follows each outcome with the number of fixes left.
async fn apply_each<A, AF, B, BF>(applying: &Mutex<Applying>, fixes: &[String], mut apply: A, mut after: B)
where
    A: FnMut(String) -> AF,
    AF: Future<Output = Result<(), ApiError>>,
    B: FnMut(usize) -> BF,
    BF: Future<Output = ()>,
{
    for (i, fix) in fixes.iter().enumerate() {
        let outcome = apply(fix.clone()).await;
        match &outcome {
            Ok(()) => info!(fix = %fix, "setup fix applied"),
            Err(e) => warn!(fix = %fix, "setup fix failed: {e}"),
        }
        lock(applying).done(fix, outcome);
        after(fixes.len() - i - 1).await;
    }
}

/// Re-probes the host and publishes `HostInfo`; returns its checklist.
async fn publish(ctx: &Ctx) -> SetupStatus {
    let info = probe_info(ctx).await;
    let setup = info.setup.clone();
    ctx.state.set_info(info);
    setup
}

async fn apply_fix(ctx: &Arc<Ctx>, fix: &str) -> Result<(), ApiError> {
    match fix {
        FIX_HERDR_INTEGRATION => {
            ctx.herdr.request::<Value>("integration.install", json!({ "target": "omp" })).await.map(|_| ()).map_err(|e| {
                let mut err = herdr_err(e);
                err.hint = Some("Try `herdr integration install omp` on the host.".into());
                err
            })
        }
        FIX_GLOBAL_SHARING => {
            let bin = omp_bin().ok_or_else(omp_missing)?;
            let url = relay_url(ctx.relay_port);
            for (key, value) in [("collab.autoStart", "control"), ("collab.relayUrl", url.as_str())] {
                let out = run_cmd(&bin, &["config", "set", key, value], Some(&home_dir()), &[("NO_COLOR", "1")], None, OMP_TIMEOUT)
                    .await
                    .map_err(|e| ApiError::new("omp_error", format!("omp config set {key}: {e}")))?;
                if !out.ok() {
                    return Err(ApiError::new("omp_error", format!("omp config set {key}: {}", out.message())));
                }
            }
            Ok(())
        }
        FIX_GLOBAL_BRIDGE => {
            let src = ctx.paths.ext.clone();
            let dst = bridge_install_path();
            tokio::task::spawn_blocking(move || install_file(&src, &dst)).await.map_err(join_err)?
        }
        FIX_HERDR_SCOPE => {
            // Already out of a login session (or gone): nothing to do.
            let Some(bound) = scope::herdr_in_login_session(&ctx.herdr.endpoint().socket).await else { return Ok(()) };
            if !scope::can_adopt() {
                return Err(ApiError::new("unsupported", "moving the herdr server needs root and systemd's busctl on this host")
                    .with_hint("See the setup item's details for what you can do instead."));
            }
            let session = ctx.herdr_session.clone();
            let unit = tokio::task::spawn_blocking(move || scope::adopt(bound.pid, &session)).await.map_err(join_err)?.map_err(|e| {
                ApiError::new("io_error", e).with_hint("Nothing was stopped; the processes that did not move still run where they were.")
            })?;
            info!(pid = bound.pid, %unit, "moved the herdr server out of login session {}", bound.session);
            Ok(())
        }
        _ => install::apply(ctx, fix).await,
    }
}

/// Copies through a temp file + rename so omp never loads a half-written extension.
fn install_file(src: &Path, dst: &Path) -> Result<(), ApiError> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    if !src.is_file() {
        return Err(ApiError::new("not_found", format!("{} is missing", src.display())).with_hint("Reconnect the app so it uploads the extension, then retry."));
    }
    let dir = dst.parent().ok_or_else(|| ApiError::new("internal", "bad extension path"))?;
    std::fs::create_dir_all(dir).map_err(|e| ApiError::new("io_error", format!("create {}: {e}", dir.display())))?;
    // Own temp name per call: two sessions' probes may refresh the copy at the same moment.
    let tmp = dir.join(format!(".teleflock-bridge.ts.{}.{}.tmp", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    std::fs::copy(src, &tmp).map_err(|e| ApiError::new("io_error", format!("copy to {}: {e}", tmp.display())))?;
    std::fs::rename(&tmp, dst).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        ApiError::new("io_error", format!("install {}: {e}", dst.display()))
    })
}

/// Keeps a global bridge copy current: when `<omp agent dir>/extensions/teleflock-bridge.ts`
/// exists, is a TeleFlock bridge and differs from the uploaded `<home>/ext/teleflock-bridge.ts`, it
/// is replaced (atomically). Never created: installing it is the `install-global-bridge` fix, which
/// needs the user's consent. A stale copy loads next to the current `-e` one in every omp that
/// TeleFlock starts. Runs at daemon start and on every host probe (the app uploads a new
/// extension on deploy). Daemons on other homes (lab / dev) leave the user's agent dir alone
/// unless `PI_CODING_AGENT_DIR` gives them their own.
pub fn refresh_global_bridge(paths: &Paths) {
    if !paths.is_default_home() && std::env::var_os("PI_CODING_AGENT_DIR").is_none_or(|d| d.is_empty()) {
        return;
    }
    let dst = bridge_install_path();
    match refresh_bridge_copy(&paths.ext, &dst) {
        Ok(Some((from, to))) => info!(path = %dst.display(), from = %from, to = %to, "global TeleFlock bridge updated"),
        Ok(None) => {}
        Err(e) => warn!(path = %dst.display(), "global TeleFlock bridge stays outdated: {e}"),
    }
}

/// Replaces `installed` with `uploaded` when both are TeleFlock bridges and differ; the bridge
/// versions (before, after) when it did.
fn refresh_bridge_copy(uploaded: &Path, installed: &Path) -> Result<Option<(String, String)>, ApiError> {
    let (Ok(old), Ok(new)) = (std::fs::read(installed), std::fs::read(uploaded)) else { return Ok(None) };
    if old == new || !is_bridge(&old) || !is_bridge(&new) {
        return Ok(None);
    }
    install_file(uploaded, installed)?;
    Ok(Some((bridge_version(&old), bridge_version(&new))))
}

/// A TeleFlock companion extension, not some other file under that name.
fn is_bridge(source: &[u8]) -> bool {
    let has = |needle: &[u8]| source.windows(needle.len()).any(|w| w == needle);
    has(b"TeleFlock companion extension") && has(b"BRIDGE_VERSION")
}

/// `const BRIDGE_VERSION = "1.3.0";` → `1.3.0`.
fn bridge_version(source: &[u8]) -> String {
    String::from_utf8_lossy(source)
        .lines()
        .find_map(|l| l.trim().strip_prefix("const BRIDGE_VERSION = ").map(|v| v.trim_end_matches(';').trim_matches('"').to_string()))
        .unwrap_or_else(|| "?".into())
}

// ───────────────────────────── host info ─────────────────────────────

pub(crate) fn parse_version(s: &str) -> Option<(u32, u32, u32)> {
    let start = s.find(|c: char| c.is_ascii_digit())?;
    let mut it = s[start..].split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty()).map(|p| p.parse::<u32>().ok());
    Some((it.next()??, it.next().flatten().unwrap_or(0), it.next().flatten().unwrap_or(0)))
}

fn version_string(raw: &str) -> String {
    match parse_version(raw) {
        Some((a, b, c)) => format!("{a}.{b}.{c}"),
        None => raw.trim().to_string(),
    }
}

fn hostname() -> String {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        // SAFETY: buf is valid for `len` bytes; gethostname NUL-terminates on success.
        if unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0 {
            let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
            return String::from_utf8_lossy(&buf[..end]).into_owned();
        }
    }
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "localhost".into())
}

/// Last successful `omp --version` per binary (path, size, mtime): probes run on every connect.
static OMP_VERSION: LazyLock<Mutex<Option<(PathBuf, (u64, std::time::SystemTime), VersionInfo)>>> = LazyLock::new(Default::default);

async fn omp_version() -> Option<VersionInfo> {
    let bin = omp_bin()?;
    let id = stamp(&bin);
    if let Some((_, _, v)) = lock(&OMP_VERSION).as_ref().filter(|(p, s, _)| *p == bin && Some(*s) == id) {
        return Some(v.clone());
    }
    let out = run_cmd(&bin, &["--version"], Some(&std::env::temp_dir()), &[("NO_COLOR", "1")], None, Duration::from_secs(10)).await.ok()?;
    if !out.ok() {
        // Not cached: installing a missing interpreter fixes it without touching the binary.
        return Some(VersionInfo { version: "unknown".into(), path: bin.display().to_string(), ok: false, note: Some(out.message()) });
    }
    let raw = out.line();
    let parsed = parse_version(&raw);
    let ok = parsed.map(|v| v >= MIN_OMP).unwrap_or(false);
    let info = VersionInfo {
        version: version_string(&raw),
        path: bin.display().to_string(),
        ok,
        note: (!ok).then(|| format!("TeleFlock needs omp ≥ {}.{}.{}", MIN_OMP.0, MIN_OMP.1, MIN_OMP.2)),
    };
    if let Some(id) = id {
        *lock(&OMP_VERSION) = Some((bin, id, info.clone()));
    }
    Some(info)
}

async fn herdr_version(ctx: &Ctx) -> Option<VersionInfo> {
    let path = ctx.herdr.binary().display().to_string();
    let pong = match ctx.herdr.server() {
        Some(p) => Some(p),
        None => ctx.herdr.ping().await.ok(),
    };
    let min = tf_herdr::MIN_SERVER_VERSION;
    match pong {
        Some(p) => {
            let ok = parse_version(&p.version).map(|v| v >= min).unwrap_or(false);
            Some(VersionInfo {
                version: version_string(&p.version),
                path,
                ok,
                note: (!ok).then(|| format!("TeleFlock needs herdr ≥ {}.{}.{}", min.0, min.1, min.2)),
            })
        }
        None => {
            let out = run_cmd(ctx.herdr.binary(), &["--version"], None, &[], None, Duration::from_secs(10)).await.ok()?;
            Some(VersionInfo { version: version_string(&out.line()), path, ok: false, note: Some("herdr server is not running".into()) })
        }
    }
}

/// Host facts for `HostInfo` (state store calls it at start, every 60 s and after setup). Brings
/// a consented global bridge copy up to date first ([`refresh_global_bridge`]).
pub async fn probe_info(ctx: &Ctx) -> HostInfo {
    refresh_global_bridge(&ctx.paths);
    let (herdr, omp, setup, sessions) = tokio::join!(herdr_version(ctx), omp_version(), setup_status(ctx), ctx.herdr.list_sessions());
    let mut herdr_sessions: Vec<String> = sessions.map(|s| s.into_iter().map(|e| if e.default { "default".to_string() } else { e.name }).collect()).unwrap_or_default();
    if !herdr_sessions.contains(&ctx.herdr_session) {
        herdr_sessions.insert(0, ctx.herdr_session.clone());
    }
    HostInfo {
        hostname: hostname(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        home: home_dir().display().to_string(),
        hostd_version: crate::HOSTD_VERSION.to_string(),
        herdr,
        omp,
        herdr_session: ctx.herdr_session.clone(),
        herdr_sessions,
        relay_port: ctx.relay_port,
        setup,
        tools: None,
        pruned: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert_eq!(parse_version("omp/18.12.3"), Some((18, 12, 3)));
        assert_eq!(parse_version("herdr 0.9.0"), Some((0, 9, 0)));
        assert_eq!(parse_version("v2"), Some((2, 0, 0)));
        assert_eq!(version_string("omp/18.12.3"), "18.12.3");
    }

    #[test]
    fn health_is_sane() {
        let h = health();
        assert!(h.cores >= 1 && h.mem_total > 0 && h.mem_used <= h.mem_total);
        assert!(h.disk_total >= h.disk_free && h.cpu_pct >= 0.0 && h.cpu_pct <= 100.0);
        assert!(h.uptime_s > 0);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn meminfo_parse() {
        let (used, total) = platform::meminfo("MemTotal:       1000 kB\nMemFree:  10 kB\nMemAvailable:    250 kB\n");
        assert_eq!((used, total), (750 * 1024, 1000 * 1024));
    }

    #[test]
    fn models_and_roles() {
        let rpc = serde_json::json!({"provider":"openai-codex","id":"gpt-6-luna","name":"GPT-6 Luna","reasoning":true,
            "thinking":{"mode":"effort","efforts":["low","medium","high","xhigh","max"]},"contextWindow":272000});
        let m = parse_model(&rpc).unwrap();
        assert_eq!(m.label.as_deref(), Some("GPT-6 Luna"));
        assert_eq!(m.thinking, vec![ThinkingLevel::Off, ThinkingLevel::Low, ThinkingLevel::Medium, ThinkingLevel::High, ThinkingLevel::Xhigh, ThinkingLevel::Max]);
        assert_eq!(m.context_window, Some(272000));
        let cli = serde_json::json!({"provider":"anthropic","id":"claude-3-5-sonnet-20240620","name":"Claude Sonnet 3.5","reasoning":false,"thinking":null,"contextWindow":200000});
        assert!(parse_model(&cli).unwrap().thinking.is_empty());
        let roles = parse_roles(&serde_json::json!({"tiny":"a/b:low","designer":"x/y","default":"anthropic/claude-opus-5-5:max","plan":"p/q"}));
        let names: Vec<&str> = roles.iter().map(|r| r.role.as_str()).collect();
        assert_eq!(names, vec!["default", "plan", "tiny", "designer"]);
    }

    #[test]
    fn session_scan() {
        let td = tempfile::tempdir().unwrap();
        let bucket = td.path().join("-tmp-x");
        std::fs::create_dir_all(bucket.join("2026-10-20T21-52-05-658Z_01a15b4c-aaaa")).unwrap(); // artifacts dir ignored
        let write = |name: &str, cwd: &str, title: &str, msgs: usize| {
            let mut s = format!("{{\"type\":\"title\",\"v\":1,\"title\":\"{title}\",\"source\":\"auto\",\"pad\":\"   \"}}\n");
            let id = name.rsplit_once('_').unwrap().1.trim_end_matches(".jsonl");
            s.push_str(&format!("{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"timestamp\":\"x\",\"cwd\":\"{cwd}\"}}\n"));
            for _ in 0..msgs {
                s.push_str("{\"type\":\"message\",\"id\":\"1\",\"message\":{\"role\":\"user\"}}\n");
            }
            std::fs::write(bucket.join(name), s).unwrap();
        };
        write("2026-10-20T21-52-05-658Z_01a15b4c-aaaa.jsonl", "/tmp/x", "first", 3);
        std::thread::sleep(Duration::from_millis(20));
        write("2026-10-20T22-00-00-000Z_01a15b4d-bbbb.jsonl", "/tmp/y", "second", 1);
        write("2026-10-20T22-01-00-000Z_01a15b4e-cccc.jsonl", "/tmp/y", "empty", 0);
        let live: HashMap<String, (String, bool)> = [
            ("01a15b4c-aaaa".to_string(), ("term_1".to_string(), true)),
            ("01a15b4d-bbbb".to_string(), ("term_2".to_string(), false)),
        ]
        .into();
        let all = scan_sessions(td.path(), None, 10, &live);
        assert_eq!(all.len(), 2, "{all:?}");
        assert_eq!(all[0].id, "01a15b4d-bbbb");
        assert_eq!(all[0].messages, Some(1));
        assert!(!all[0].live, "parked: not live");
        assert_eq!(all[0].agent_id.as_deref(), Some("term_2"), "parked: its agent");
        assert!(all[1].live);
        assert_eq!(all[1].agent_id.as_deref(), Some("term_1"));
        assert_eq!(all[1].title.as_deref(), Some("first"));
        let only_x = scan_sessions(td.path(), Some(Path::new("/tmp/x")), 10, &HashMap::new());
        assert_eq!(only_x.len(), 1);
        assert_eq!(only_x[0].cwd.as_deref(), Some("/tmp/x"));
        assert_eq!(scan_sessions(td.path(), None, 1, &HashMap::new()).len(), 1);
    }

    fn stats_fixture(path: &Path) {
        let c = rusqlite::Connection::open(path).unwrap();
        c.execute_batch(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_file TEXT, model TEXT, provider TEXT, timestamp INTEGER,
               input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
               total_tokens INTEGER, cost_total REAL);",
        )
        .unwrap();
        let now = crate::util::now_ms();
        let rows = [
            (now, "m1", "p", 10, 5, 100, 0, 115, 1.5),
            (now, "m2", "q", 1, 1, 0, 0, 2, 0.25),
            (now - 2 * 86_400_000, "m1", "p", 1000, 0, 0, 0, 1000, 10.0),
            (now - 40 * 86_400_000, "m1", "p", 1, 1, 1, 1, 4, 99.0),
        ];
        for (ts, model, prov, i, o, cr, cw, t, cost) in rows {
            c.execute(
                "INSERT INTO messages (session_file, model, provider, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_total) VALUES ('f',?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                rusqlite::params![model, prov, ts, i, o, cr, cw, t, cost],
            )
            .unwrap();
        }
    }

    #[test]
    fn usage_report_from_stats_db() {
        let td = tempfile::tempdir().unwrap();
        let db = td.path().join("stats.db");
        stats_fixture(&db);
        let r = usage(&db, 7).unwrap();
        assert!((r.today.cost_usd - 1.75).abs() < 1e-9);
        assert_eq!((r.today.tokens, r.today.input, r.today.output), (117, 111, 6));
        assert_eq!(r.days.len(), 7);
        assert_eq!(r.days.last().unwrap().day, crate::util::local_day(crate::util::now_ms()));
        assert!((r.days.iter().map(|d| d.cost_usd).sum::<f64>() - 11.75).abs() < 1e-9);
        assert_eq!(r.models[0].model, "p/m1");
        assert!((r.models[0].cost_usd - 11.5).abs() < 1e-9);
        // read-only: the file is untouched and a missing db is just empty
        let missing = usage(&td.path().join("nope.db"), 3).unwrap();
        assert_eq!(missing.days.len(), 3);
        assert!(missing.models.is_empty());
    }

    #[test]
    fn install_file_atomic() {
        let td = tempfile::tempdir().unwrap();
        let src = td.path().join("src.ts");
        std::fs::write(&src, "export default () => {}").unwrap();
        let dst = td.path().join("ext").join("teleflock-bridge.ts");
        install_file(&src, &dst).unwrap();
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "export default () => {}");
        assert_eq!(install_file(&td.path().join("missing"), &dst).unwrap_err().code, "not_found");
        let leftovers: Vec<_> = std::fs::read_dir(td.path().join("ext")).unwrap().flatten().filter(|e| e.file_name() != "teleflock-bridge.ts").collect();
        assert!(leftovers.is_empty(), "no temp files left: {leftovers:?}");
    }

    fn issue(id: &str) -> SetupIssue {
        SetupIssue { id: id.into(), severity: Severity::Warn, title: id.into(), detail: String::new(), fixable: true, recommended: true }
    }

    #[tokio::test]
    async fn setup_fixes_run_past_a_failing_one() {
        let applying = Mutex::new(Applying::default());
        let fixes: Vec<String> = [install::FIX_OMP, FIX_HERDR_INTEGRATION, FIX_GLOBAL_SHARING, FIX_GLOBAL_BRIDGE].map(String::from).into();
        lock(&applying).queue(&fixes);
        let open: Vec<SetupIssue> = fixes.iter().map(|f| issue(f)).collect();
        let (running, _) = lock(&applying).report(&open);
        assert_eq!(running, fixes, "queued fixes show as applying, in fix order");

        let ran = Mutex::new(Vec::new());
        let lefts = Mutex::new(Vec::new());
        apply_each(
            &applying,
            &fixes,
            |fix| {
                lock(&ran).push(fix.clone());
                async move {
                    match fix.as_str() {
                        install::FIX_OMP => Err(ApiError::new("install_failed", "curl: (6) Could not resolve host: omp.sh (exit 1)")),
                        FIX_GLOBAL_SHARING => Err(ApiError::new("omp_error", "omp config set collab.autoStart: /usr/bin/env: 'bun': No such file or directory")),
                        _ => Ok(()),
                    }
                }
            },
            |left| {
                lock(&lefts).push(left);
                async {}
            },
        )
        .await;
        assert_eq!(*lock(&ran), fixes, "every fix ran, the failing ones included");
        assert_eq!(*lock(&lefts), vec![3, 2, 1, 0]);

        // The applied fixes' issues are gone; the failed ones stay open with why.
        let open = vec![issue(install::FIX_OMP), issue(FIX_GLOBAL_SHARING), issue(install::FIX_GH)];
        let (running, failed) = lock(&applying).report(&open);
        assert!(running.is_empty());
        assert_eq!(failed.iter().map(|f| (f.id.as_str(), f.error.code.as_str())).collect::<Vec<_>>(), vec![(install::FIX_OMP, "install_failed"), (FIX_GLOBAL_SHARING, "omp_error")]);

        // A retry hides the old failure while it runs; success clears it, a resolved issue drops it.
        lock(&applying).queue(&[install::FIX_OMP.to_string()]);
        let (running, failed) = lock(&applying).report(&open);
        assert_eq!((running, failed.len()), (vec![install::FIX_OMP.to_string()], 1));
        lock(&applying).done(install::FIX_OMP, Ok(()));
        let (_, failed) = lock(&applying).report(&[issue(install::FIX_OMP)]);
        assert!(failed.is_empty());
        let (_, failed) = lock(&applying).report(&[issue(install::FIX_GH)]);
        assert!(failed.is_empty(), "sharing is no longer an open issue");
    }

    #[test]
    fn global_bridge_copy_follows_the_upload() {
        let td = tempfile::tempdir().unwrap();
        let bridge = |v: &str| format!("// TeleFlock companion extension for omp (architecture §4).\nconst BRIDGE_VERSION = \"{v}\";\n");
        let uploaded = td.path().join("home/ext/teleflock-bridge.ts");
        let installed = td.path().join("agent/extensions/teleflock-bridge.ts");
        std::fs::create_dir_all(uploaded.parent().unwrap()).unwrap();
        std::fs::write(&uploaded, bridge("1.3.0")).unwrap();
        assert_eq!(refresh_bridge_copy(&uploaded, &installed).unwrap(), None, "never created");
        assert!(!installed.exists());

        std::fs::create_dir_all(installed.parent().unwrap()).unwrap();
        std::fs::write(&installed, bridge("1.1.0")).unwrap();
        assert_eq!(refresh_bridge_copy(&uploaded, &installed).unwrap(), Some(("1.1.0".into(), "1.3.0".into())));
        assert_eq!(std::fs::read_to_string(&installed).unwrap(), bridge("1.3.0"));
        assert_eq!(refresh_bridge_copy(&uploaded, &installed).unwrap(), None, "already current");

        std::fs::write(&installed, "export default function mine() {}\n").unwrap();
        assert_eq!(refresh_bridge_copy(&uploaded, &installed).unwrap(), None, "someone else's file stays");
        std::fs::write(&installed, bridge("1.1.0")).unwrap();
        std::fs::write(&uploaded, "garbage").unwrap();
        assert_eq!(refresh_bridge_copy(&uploaded, &installed).unwrap(), None, "only a real bridge replaces it");
        assert_eq!(bridge_version(b"nothing"), "?");
    }

    #[test]
    fn collab_settings_from_omps_config_file() {
        let s = |a: &str, u: &str| Some((Some(a.to_string()), Some(u.to_string())));
        // As `omp config set` writes it, with comments and quoting.
        let real = "modelRoles:\n  default: x/y:max\ncollab:\n  autoStart: control\n  relayUrl: ws://127.0.0.1:47466\nclaudeResets:\n  autoRedeem: \"yes\"\n";
        assert_eq!(collab_from_yaml(real), s("control", "ws://127.0.0.1:47466"));
        let quoted = "# mine\ncollab: # sharing\n    relayUrl: \"ws://127.0.0.1:1#x\" # note\n    nested:\n      autoStart: no\n    autoStart: view\n";
        assert_eq!(collab_from_yaml(quoted), s("view", "ws://127.0.0.1:1#x"));
        // Not stated: (None, None), and the caller asks omp for its defaults.
        assert_eq!(collab_from_yaml("other:\n  autoStart: control\n"), Some((None, None)));
        // Shapes this reader does not take on: omp answers.
        for odd in [
            "collab: {autoStart: control}\n",
            "collab:\n  autoStart: control\n  autoStart: view\n",
            "collab:\n  autoStart:\n    control\n",
            "collab:\n\tautoStart: control\n",
            "collab:\n  autoStart: &a control\n",
            "collab:\n  autoStart: ~\n",
            "- not a mapping\n",
        ] {
            assert_eq!(collab_from_yaml(odd), None, "{odd:?}");
        }
    }
}
