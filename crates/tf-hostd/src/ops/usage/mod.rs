//! `host.usage` (architecture §3.16): spend, tokens and request facts from omp's own stats index
//! (`stats.db`, omp-stats), which tf-hostd keeps current by running omp's sync.
//!
//! - [`dbpath`]: where omp keeps the index (config dir, profile, XDG, dotenv), resolved like omp.
//! - [`sync`]: `omp stats --summary` in the background, one at a time, when a request finds the
//!   index older than 10 min (`refresh: true`: now), plus a warm-up every 30 min on the real
//!   daemon (`TF_HOSTD_USAGE_WARMUP=1|0` overrides for lab homes), so first views are fast.
//! - [`report`]: bounded queries → [`UsageInsights`] (hourly buckets, breakdowns, records).
//! - [`legacy`]: the answer of apps < 0.7.0 (requests without `view`).
//!
//! Answers never wait for a sync: they report what the index holds with `index.syncing`, and
//! the next poll gets the fresh figures. A report is cached per (index file stamp, view,
//! window) and versioned, so a client holding the current one (`have`) gets `unchanged`.
//! [`UsageLive`] is what TeleFlock's live ledger (state.json) saw since the last sync: the board
//! keeps ticking between syncs without counting anything twice.

pub(crate) mod dbpath;
mod legacy;
pub(crate) mod report;
pub(crate) mod sync;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime};

use serde_json::Value;
use tokio_util::sync::CancellationToken;
use tracing::info;

use tf_proto::{ApiError, Millis, UsageIndex, UsageInsights, UsageLive, UsageParams, UsageReport, UsageTotals, UsageView};

use crate::ops::{to_value, Ctx};
use crate::paths::Paths;
use crate::state::persist::{zero, Persist};
use crate::util::{local_day, now_ms};
use report::{IndexFacts, SessionInfo, Window};
use sync::{SyncCmd, Syncer, Want, SYNC_TIMEOUT};

/// Warm-up cadence (and how old the last sync may be before a warm-up runs one).
const WARMUP_EVERY: Duration = Duration::from_secs(30 * 60);
/// First warm-up after the daemon starts (bridges reconnect, sessions load first).
const WARMUP_FIRST: Duration = Duration::from_secs(90);
/// Reports kept (views × windows × index states; several devices in several time zones).
const CACHE_SIZE: usize = 8;
/// Bumped whenever a report's meaning changes: a client's `have` from an older build never
/// matches.
const REPORT_FORMAT: u32 = 1;

/// The daemon's usage service (one per daemon; [`start`]).
#[derive(Clone)]
pub struct Usage {
    inner: Arc<Inner>,
}

struct Inner {
    syncer: Arc<Syncer>,
    /// The live ledger (`state.json`); absent in tests that don't need it.
    persist: Option<Arc<Persist>>,
    /// The ledger when the last sync finished: live spend counts from there.
    mark: Mutex<Option<LiveMark>>,
    cache: Mutex<VecDeque<(Key, Arc<Built>)>>,
    db: Box<dyn Fn() -> PathBuf + Send + Sync>,
}

#[derive(Debug, Clone)]
struct LiveMark {
    at: Millis,
    /// Host-local day of the mark and the ledger's total of that day then.
    day: String,
    base: UsageTotals,
}

/// Identity of a report: what it was built from and over.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Key {
    stamp: Stamp,
    view: UsageView,
    window: Window,
}

/// Size and mtime of `stats.db` and its WAL: every write omp makes moves one of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct Stamp {
    db: Option<(u64, u128)>,
    wal: Option<(u64, u128)>,
}

struct Built {
    facts: IndexFacts,
    insights: Option<Arc<UsageInsights>>,
}

static SERVICE: OnceLock<Usage> = OnceLock::new();

/// Creates the daemon's service and, on the real daemon (or with `TF_HOSTD_USAGE_WARMUP=1`),
/// its warm-up loop (off on Windows by default).
pub fn start(paths: &Paths, persist: Arc<Persist>, cancel: CancellationToken) {
    let svc = SERVICE.get_or_init(|| Usage::for_daemon(paths, Some(persist)));
    let warmup = match std::env::var("TF_HOSTD_USAGE_WARMUP").ok().as_deref() {
        Some("1") => true,
        Some("0") => false,
        _ => paths.is_default_home() && !cfg!(windows),
    };
    if warmup {
        svc.spawn_warmup(cancel);
    }
}

/// The host runs on battery (Linux: a power-supply battery reports `Discharging`; elsewhere unknown).
fn on_battery() -> bool {
    #[cfg(target_os = "linux")]
    {
        let Ok(rd) = std::fs::read_dir("/sys/class/power_supply") else { return false };
        rd.flatten().any(|e| {
            let read = |f: &str| std::fs::read_to_string(e.path().join(f)).map(|s| s.trim().to_string()).unwrap_or_default();
            read("type") == "Battery" && read("status") == "Discharging"
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// `host.usage`.
pub async fn handle(ctx: &Ctx, p: UsageParams) -> Result<Value, ApiError> {
    to_value(usage_report(ctx, p).await?)
}

/// `host.usage`'s answer, for other hostd reports too (Flock Wrapped): the same index, cache and
/// sync policy (a stale index starts a background sync; this never waits for it).
pub(crate) async fn usage_report(ctx: &Ctx, p: UsageParams) -> Result<UsageReport, ApiError> {
    let svc = SERVICE.get_or_init(|| Usage::for_daemon(&ctx.paths, None)).clone();
    svc.answer(p, ctx.state.usage_today()).await
}

/// The empty directory `omp stats` runs in (no project `.env` for omp or Bun to load).
fn sync_cwd(paths: &Paths) -> PathBuf {
    paths.home.join("cache").join("omp-stats")
}

impl Usage {
    fn for_daemon(paths: &Paths, persist: Option<Arc<Persist>>) -> Self {
        let cwd = sync_cwd(paths);
        let db_cwd = cwd.clone();
        let db: Arc<dyn Fn() -> PathBuf + Send + Sync> = Arc::new(move || {
            let env: HashMap<String, String> = std::env::vars().collect();
            dbpath::stats_db_path(&env, &crate::ops::fs::home_dir(), &db_cwd)
        });
        let watched = db.clone();
        let cmd = Arc::new(move || {
            let program = crate::ops::host::omp_bin().ok_or_else(|| "omp is not installed on this host".to_string())?;
            Ok(SyncCmd { program, args: vec!["stats".into(), "--summary".into()], cwd: cwd.clone(), watch: Some(watched()) })
        });
        Self::new(Syncer::new(cmd, SYNC_TIMEOUT), persist, Box::new(move || db()))
    }

    fn new(syncer: Arc<Syncer>, persist: Option<Arc<Persist>>, db: Box<dyn Fn() -> PathBuf + Send + Sync>) -> Self {
        let inner = Arc::new(Inner { syncer, persist, mark: Mutex::new(None), cache: Mutex::new(VecDeque::new()), db });
        let weak = Arc::downgrade(&inner);
        inner.syncer.set_on_done(Arc::new(move || {
            if let Some(inner) = weak.upgrade() {
                inner.take_mark();
            }
        }));
        Self { inner }
    }

    fn spawn_warmup(&self, cancel: CancellationToken) {
        let syncer = self.inner.syncer.clone();
        tokio::spawn(async move {
            let mut wait = WARMUP_FIRST;
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    _ = tokio::time::sleep(wait) => {}
                }
                // A laptop on battery is left alone: a view that finds the index stale still syncs.
                if !on_battery() && syncer.request(Want::Warmup(WARMUP_EVERY - Duration::from_secs(60))) {
                    info!("usage: warming omp's stats index");
                }
                // ±2 min, so several daemons on one machine (lab homes) spread out.
                let jitter = u64::from(std::process::id() % 240);
                wait = WARMUP_EVERY - Duration::from_secs(120) + Duration::from_secs(jitter);
            }
        });
    }

    async fn answer(&self, p: UsageParams, ledger_today: UsageTotals) -> Result<UsageReport, ApiError> {
        let db = (self.inner.db)();
        self.inner.syncer.request(if p.refresh == Some(true) { Want::Now } else { Want::IfStale });
        let Some(view) = p.view else {
            let days = p.days.clamp(1, 366);
            return tokio::task::spawn_blocking(move || legacy::usage(&db, days)).await.map_err(join_err)?;
        };
        let window = Window { since: p.since.filter(|s| *s > 0), until: p.until, offset_min: p.hour_offset.unwrap_or(0).min(59) };
        let key = Key { stamp: stamp(&db), view, window };
        let version = version_of(&key);
        let inner = self.inner.clone();
        let db2 = db.clone();
        let k2 = key.clone();
        let built = tokio::task::spawn_blocking(move || inner.built(&db2, &k2)).await.map_err(join_err)??;
        let unchanged = built.insights.is_some() && p.have.as_deref() == Some(version.as_str());
        let insights = match &built.insights {
            Some(i) if !unchanged => Some(UsageInsights { version: version.clone(), ..(**i).clone() }),
            _ => None,
        };
        let status = self.inner.syncer.status();
        Ok(UsageReport {
            today: None,
            days: None,
            models: None,
            index: Some(UsageIndex {
                path: db.display().to_string(),
                ready: built.facts.ready,
                syncing: status.running,
                synced_at: status.synced_at,
                added: status.added,
                error: status.error,
                error_at: status.error_at,
                newest: built.facts.newest,
            }),
            insights,
            unchanged: unchanged.then_some(true),
            live: self.inner.live(ledger_today),
        })
    }
}

impl Inner {
    /// The report for `key`, from the cache or built now (blocking).
    fn built(&self, db: &Path, key: &Key) -> Result<Arc<Built>, ApiError> {
        if let Some(b) = lock(&self.cache).iter().find(|(k, _)| k == key).map(|(_, b)| b.clone()) {
            return Ok(b);
        }
        let built = Arc::new(build(db, key.view, key.window, now_ms())?);
        let mut cache = lock(&self.cache);
        cache.retain(|(k, _)| k != key);
        cache.push_front((key.clone(), built.clone()));
        cache.truncate(CACHE_SIZE);
        Ok(built)
    }

    fn take_mark(&self) {
        let Some(persist) = &self.persist else { return };
        let at = now_ms();
        let day = local_day(at);
        let base = persist.read(|d| d.usage.day(&day));
        *lock(&self.mark) = Some(LiveMark { at, day, base });
    }

    /// What the ledger gained since the mark (days after the mark day count whole).
    fn live(&self, ledger_today: UsageTotals) -> Option<UsageLive> {
        let persist = self.persist.as_ref()?;
        let mark = lock(&self.mark).clone()?;
        let since = persist.read(|d| {
            let mut t = zero();
            for (_, v) in d.usage.days.range(mark.day.clone()..) {
                t.cost_usd += v.cost_usd;
                t.tokens += v.tokens;
                t.input += v.input;
                t.output += v.output;
            }
            t
        });
        Some(UsageLive {
            since: mark.at,
            cost_usd: (since.cost_usd - mark.base.cost_usd).max(0.0),
            tokens: since.tokens.saturating_sub(mark.base.tokens),
            input: since.input.saturating_sub(mark.base.input),
            output: since.output.saturating_sub(mark.base.output),
            ledger_today,
        })
    }
}

/// Builds a report from the index at `db` (read-only).
fn build(db: &Path, view: UsageView, window: Window, now: Millis) -> Result<Built, ApiError> {
    let sql = |e: rusqlite::Error| ApiError::new("io_error", format!("stats.db: {e}"));
    let Some(conn) = crate::ops::host::open_ro(db)? else {
        return Ok(Built { facts: IndexFacts::default(), insights: None });
    };
    let facts = report::index_facts(&conn).map_err(sql)?;
    if !facts.ready {
        return Ok(Built { facts, insights: None });
    }
    let insights = report::build(&conn, view, window, now, &Heads::load()).map_err(sql)?;
    Ok(Built { facts, insights: insights.map(Arc::new) })
}

/// Session titles (omp's `history.db`, else the file's title slot), ids and folders.
struct Heads {
    titles: HashMap<String, String>,
}

impl Heads {
    fn load() -> Self {
        Self { titles: crate::ops::host::session_titles() }
    }
}

impl SessionInfo for Heads {
    fn head(&self, file: &Path) -> (Option<String>, Option<String>, Option<String>) {
        let head = crate::ops::host::read_head(file);
        let id = head.id.clone().or_else(|| crate::ops::host::id_from_file_name(file));
        let title = id.as_ref().and_then(|i| self.titles.get(i).cloned()).or(head.title);
        (id, title, head.cwd)
    }
}

fn stamp(db: &Path) -> Stamp {
    let of = |p: &Path| {
        std::fs::metadata(p).ok().map(|m| (m.len(), m.modified().ok().and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0)))
    };
    let mut wal = db.as_os_str().to_owned();
    wal.push("-wal");
    Stamp { db: of(db), wal: of(Path::new(&wal)) }
}

fn version_of(key: &Key) -> String {
    let mut h = std::hash::DefaultHasher::new();
    REPORT_FORMAT.hash(&mut h);
    key.hash(&mut h);
    format!("{:016x}", h.finish())
}

fn join_err(e: tokio::task::JoinError) -> ApiError {
    ApiError::new("internal", e.to_string())
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}
