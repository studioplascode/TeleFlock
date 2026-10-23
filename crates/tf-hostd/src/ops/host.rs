//! `host.*` methods: health, usage (omp `stats.db`, read-only), model catalog, past
//! sessions + resume, setup checklist + fixes, activity; plus [`probe_info`] /
//! [`setup_status`] / [`health`] for the state store.
//!
//! Nothing here mutates omp or herdr configuration except [`setup_apply`], which only runs
//! when a client calls `host.setupApply` with explicit fix ids.

use std::collections::HashMap;
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde_json::{json, Value};
use tf_proto::{
    ActivityPage, AgentSpec, ApiError, HostHealth, HostInfo, HostMethod, ModelCatalog, ModelInfo, PastSession, PastSessions,
    ResumeParams, RoleBinding, SessionsParams, SetupIssue, SetupStatus, Severity, Started, ThinkingLevel, UsageDay,
    UsageModel, UsageReport, UsageTotals, VersionInfo,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

use crate::clients::ClientHandle;
use crate::ops::fs::{home_dir, resolve_path};
use crate::ops::git::{resolve_bin, run_cmd};
use crate::ops::scope::{self, FIX_HERDR_SCOPE};
use crate::ops::{herdr_err, to_value, Ctx};

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

pub(crate) fn omp_bin() -> Option<PathBuf> {
    resolve_bin("omp")
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
    ApiError::new("omp_error", "omp is not installed on this host").with_hint("Install omp (oh-my-pi) and make sure `omp` is on PATH or in ~/.local/bin.")
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

/// Past omp sessions, newest first. `live` maps session file / id → agent id.
pub(crate) fn scan_sessions(dir: &Path, cwd: Option<&Path>, limit: usize, live: &HashMap<String, String>) -> Vec<PastSession> {
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
        let agent_id = live.get(&file).or_else(|| live.get(&id)).cloned();
        out.push(PastSession {
            title: titles.get(&id).cloned().or(head.title),
            cwd: head.cwd,
            updated_at: mtime,
            messages,
            live: agent_id.is_some(),
            agent_id,
            file,
            id,
        });
    }
    out
}

/// Session file / session id → agent id for every omp agent on the board.
fn live_sessions(ctx: &Ctx) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for a in ctx.state.snapshot().agents {
        if let Some(omp) = &a.omp {
            if let Some(f) = &omp.session_file {
                m.insert(f.clone(), a.id.clone());
            }
            if let Some(s) = &omp.session_id {
                m.insert(s.clone(), a.id.clone());
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
    if let Some(agent_id) = live.get(&file_s).or_else(|| live.get(&id)) {
        let name = ctx.state.agent(agent_id).map(|a| a.name).unwrap_or_else(|| agent_id.clone());
        return Err(ApiError::new("busy", format!("this session is open in agent {name}"))
            .with_hint("Resuming a live session would fork it. Open that agent instead."));
    }
    let spec = AgentSpec { name: None, kind: "omp".into(), model: None, thinking: None, plan: false, prompt: None };
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
    let (integration, sharing, login_bound) = tokio::join!(herdr_integration(ctx), async {
        let bin = omp.as_ref()?;
        let (auto, url) = tokio::join!(omp_config_get(bin, "collab.autoStart"), omp_config_get(bin, "collab.relayUrl"));
        let get = |r: Result<Value, ApiError>| r.ok().and_then(|v| v.get("value").and_then(Value::as_str).map(str::to_string));
        Some((get(auto), get(url)))
    }, scope::herdr_in_login_session(&ctx.herdr.endpoint().socket));
    let installed = bridge_install_path();
    let bridge_installed = installed.is_file();
    let bridge_current = bridge_installed && std::fs::read(&installed).ok() == std::fs::read(&ctx.paths.ext).ok();
    let relay = ctx.omp.relay_listening();

    let mut issues = Vec::new();
    if omp.is_none() {
        issues.push(SetupIssue {
            id: "omp-missing".into(),
            severity: Severity::Error,
            title: "omp is not installed".into(),
            detail: "TeleFlock drives omp (oh-my-pi) sessions; install it on this host.".into(),
            fixable: false,
            recommended: true,
        });
    }
    match integration {
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
    SetupStatus { herdr_integration: integration == IntegrationState::Current, global_sharing, global_bridge: bridge_installed, relay, issues }
}

/// Applies the requested fixes (only ever on an explicit client request), then returns the
/// fresh checklist and republishes the host info.
pub async fn setup_apply(ctx: &Ctx, fixes: &[String]) -> Result<SetupStatus, ApiError> {
    for fix in fixes {
        match fix.as_str() {
            FIX_HERDR_INTEGRATION | FIX_GLOBAL_SHARING | FIX_GLOBAL_BRIDGE | FIX_HERDR_SCOPE => {}
            other => return Err(ApiError::new("invalid_params", format!("unknown setup fix `{other}`"))),
        }
    }
    for fix in fixes {
        match fix.as_str() {
            FIX_HERDR_INTEGRATION => {
                ctx.herdr.request::<Value>("integration.install", json!({ "target": "omp" })).await.map_err(|e| {
                    let mut err = herdr_err(e);
                    err.hint = Some("Try `herdr integration install omp` on the host.".into());
                    err
                })?;
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
            }
            FIX_GLOBAL_BRIDGE => {
                let src = ctx.paths.ext.clone();
                let dst = bridge_install_path();
                tokio::task::spawn_blocking(move || install_file(&src, &dst)).await.map_err(join_err)??;
            }
            FIX_HERDR_SCOPE => {
                // Already out of a login session (or gone): nothing to do.
                let Some(bound) = scope::herdr_in_login_session(&ctx.herdr.endpoint().socket).await else { continue };
                if !scope::can_adopt() {
                    return Err(ApiError::new("unsupported", "moving the herdr server needs root and systemd's busctl on this host")
                        .with_hint("See the setup item's details for what you can do instead."));
                }
                let session = ctx.herdr_session.clone();
                let unit = tokio::task::spawn_blocking(move || scope::adopt(bound.pid, &session)).await.map_err(join_err)?.map_err(|e| {
                    ApiError::new("io_error", e).with_hint("Nothing was stopped; the processes that did not move still run where they were.")
                })?;
                tracing::info!(pid = bound.pid, %unit, "moved the herdr server out of login session {}", bound.session);
            }
            _ => unreachable!("validated above"),
        }
    }
    let status = setup_status(ctx).await;
    let mut info = probe_info(ctx).await;
    info.setup = status.clone();
    ctx.state.set_info(info);
    Ok(status)
}

/// Copies through a temp file + rename so omp never loads a half-written extension.
fn install_file(src: &Path, dst: &Path) -> Result<(), ApiError> {
    if !src.is_file() {
        return Err(ApiError::new("not_found", format!("{} is missing", src.display())).with_hint("Reconnect the app so it uploads the extension, then retry."));
    }
    let dir = dst.parent().ok_or_else(|| ApiError::new("internal", "bad extension path"))?;
    std::fs::create_dir_all(dir).map_err(|e| ApiError::new("io_error", format!("create {}: {e}", dir.display())))?;
    let tmp = dir.join(".teleflock-bridge.ts.tmp");
    std::fs::copy(src, &tmp).map_err(|e| ApiError::new("io_error", format!("copy to {}: {e}", tmp.display())))?;
    std::fs::rename(&tmp, dst).map_err(|e| ApiError::new("io_error", format!("install {}: {e}", dst.display())))?;
    Ok(())
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

async fn omp_version() -> Option<VersionInfo> {
    let bin = omp_bin()?;
    let out = run_cmd(&bin, &["--version"], Some(&std::env::temp_dir()), &[("NO_COLOR", "1")], None, Duration::from_secs(10)).await.ok()?;
    if !out.ok() {
        return Some(VersionInfo { version: "unknown".into(), path: bin.display().to_string(), ok: false, note: Some(out.message()) });
    }
    let raw = out.line();
    let parsed = parse_version(&raw);
    let ok = parsed.map(|v| v >= MIN_OMP).unwrap_or(false);
    Some(VersionInfo {
        version: version_string(&raw),
        path: bin.display().to_string(),
        ok,
        note: (!ok).then(|| format!("TeleFlock needs omp ≥ {}.{}.{}", MIN_OMP.0, MIN_OMP.1, MIN_OMP.2)),
    })
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

/// Host facts for `HostInfo` (state store calls it at start, every 60 s and after setup).
pub async fn probe_info(ctx: &Ctx) -> HostInfo {
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
        let live: HashMap<String, String> = [("01a15b4c-aaaa".to_string(), "term_1".to_string())].into();
        let all = scan_sessions(td.path(), None, 10, &live);
        assert_eq!(all.len(), 2, "{all:?}");
        assert_eq!(all[0].id, "01a15b4d-bbbb");
        assert_eq!(all[0].messages, Some(1));
        assert!(!all[0].live);
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
    }
}
