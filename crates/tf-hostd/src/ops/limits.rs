//! `host.limits`: subscription / account usage limits exactly as omp knows them.
//!
//! omp fetches per-account quota reports (Claude 5 h / 7 d windows, Codex weekly, …) from each
//! provider's usage endpoint and caches them ~5 min per account in `<agent dir>/agent.db`
//! (`cache` rows `usage_cache:report:…`); while an omp process works it also refreshes the window
//! rows of its account from the provider's response headers, at most once a minute.
//! `omp usage --json` prints those reports (without tokens); `omp usage --history --json` prints
//! the hourly `usage_history` rows omp records whenever a fresh report lands. hostd runs those two
//! commands and reads the cached report rows itself — no provider calls, no credentials — and
//! keeps its own readings so the client can estimate the pace of each window from its newest
//! readings: every answer reads the rows again, and while an omp session on this host runs a
//! turn, [`start`] reads them once a minute.
//!
//! The session → account mapping reads omp's persisted session pin (`cache` row
//! `session:sticky:<provider>:<session id>` → credential id) and that credential's
//! `identity_key` from `agent.db`, read-only. The credential payload column is never read.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use serde_json::Value;
use tf_proto::{AccountLimits, ApiError, LimitAccount, LimitSample, LimitSession, LimitStatus, LimitWindow, Millis};

use crate::daemon::Daemon;
use crate::ops::git::run_cmd;
use crate::ops::host::{omp_agent_dir, omp_bin, open_ro};
use crate::ops::Ctx;
use crate::util::now_ms;

/// hostd's own cache of `omp usage --json`: omp itself serves a per-account cache of ~5 min, so
/// re-running it sooner (0.7 s CPU, ~200 MB) mostly re-reads the same report; window rows omp
/// refreshed since come from its cache rows ([`cached_reports`]). `refresh: true` asks again after
/// [`REFRESH_MIN`].
const TTL: Duration = Duration::from_secs(300);
/// Minimum spacing of explicit refreshes.
const REFRESH_MIN: Duration = Duration::from_secs(10);
/// `omp usage --history` only gains a row per hour.
const HISTORY_TTL: Duration = Duration::from_secs(600);
const HISTORY_DAYS: &str = "8";
/// One `omp usage` run. Public for the app's request timeouts (tf-client `timeout_for`): requests
/// that read a fresh report (`accounts.unlink`) must outlast it.
pub const OMP_USAGE_TIMEOUT: Duration = Duration::from_secs(45);
/// How often [`start`] reads omp's cached reports while an omp session runs a turn.
const SAMPLE_EVERY: Duration = Duration::from_secs(60);
/// Samples sent per window.
const MAX_SAMPLES: usize = 120;
/// Readings this recent are all sent: the client's pace compares the newest reading with one 5 min older.
const RECENT_MS: Millis = HOUR_MS;
/// Older readings keep at least this many of [`MAX_SAMPLES`].
const OLDER_MIN: usize = 30;
/// A full report followed this soon by a reading from response headers is left out of the samples:
/// the usage endpoint can read a step above the headers of the same moment, and mixing the two
/// would read as consumption.
const HEADERS_SUPERSEDE_MS: Millis = 2 * 60_000;
/// Own readings kept per window.
const RING_SPAN_MS: Millis = 8 * 86_400_000;
const RING_CAP: usize = 4000;
/// Two readings belong to different window periods when their reset times differ by more.
const PERIOD_SLACK_MS: Millis = 15 * 60_000;
/// A used-fraction drop larger than this means the window reset between two readings.
const RESET_DROP: f64 = 0.02;
const HOUR_MS: Millis = 3_600_000;

/// Who a report belongs to (omp `UsageReport.metadata`).
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Ident {
    pub email: Option<String>,
    pub account_id: Option<String>,
    pub project_id: Option<String>,
    pub org_id: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct Parsed {
    pub account: LimitAccount,
    pub ident: Ident,
    /// omp last refreshed the windows from response headers (`metadata.headersUpdatedAt` is the
    /// report's `fetchedAt`), not from a full report.
    pub headers: bool,
}

/// One `usage_history` row (`omp usage --history --json`).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct HistoryRow {
    pub provider: String,
    pub email: Option<String>,
    pub account_id: Option<String>,
    pub limit_id: String,
    pub at: Millis,
    pub used: Option<f64>,
    pub resets_at: Option<Millis>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Reading {
    at: Millis,
    used: f64,
    resets_at: Option<Millis>,
    /// From response headers ([`Parsed::headers`]).
    headers: bool,
}

#[derive(Default)]
struct Cache {
    /// Last refresh attempt (monotonic, wall).
    fetched: Option<(Instant, Millis)>,
    accounts: Vec<Parsed>,
    error: Option<String>,
    history: Option<(Instant, Vec<HistoryRow>)>,
    /// `account key \0 limit id` → own readings, oldest first.
    ring: HashMap<String, VecDeque<Reading>>,
}

static CACHE: LazyLock<tokio::sync::Mutex<Cache>> = LazyLock::new(Default::default);

/// Account limits for `host.limits`. Concurrent callers share one refresh.
pub async fn limits(ctx: &Ctx, refresh: bool) -> Result<AccountLimits, ApiError> {
    Ok(limits_with_idents(ctx, refresh).await?.0)
}

/// Forgets the cached report: the next call asks omp again (an account was linked or unlinked).
pub(crate) async fn invalidate() {
    CACHE.lock().await.fetched = None;
}

/// [`limits`] plus who each account is (`idents[i]` belongs to `accounts[i]`).
pub(crate) async fn limits_with_idents(ctx: &Ctx, refresh: bool) -> Result<(AccountLimits, Vec<Ident>), ApiError> {
    let live: Vec<(String, String)> = ctx
        .state
        .snapshot()
        .agents
        .into_iter()
        .filter_map(|a| {
            let omp = a.omp?;
            Some((omp.session_id?, omp.model?.provider))
        })
        .collect();
    limits_for(live, refresh).await
}

/// [`limits_with_idents`] for the given `(omp session id, provider)` pairs, without a [`Ctx`]: the
/// auto-resume checks run with no app connected (`crate::limit_resume`). Shares the cache.
pub(crate) async fn limits_for(live: Vec<(String, String)>, refresh: bool) -> Result<(AccountLimits, Vec<Ident>), ApiError> {
    let db = omp_agent_dir().join("agent.db");
    let cached = {
        let db = db.clone();
        tokio::task::spawn_blocking(move || cached_reports(&db)).await.unwrap_or_default()
    };
    let (fetched_at, accounts, error) = {
        let mut c = CACHE.lock().await;
        let max_age = if refresh { REFRESH_MIN } else { TTL };
        if c.fetched.is_none_or(|(t, _)| t.elapsed() >= max_age) {
            refresh_cache(&mut c).await;
        }
        let now = now_ms();
        note_readings(&mut c.ring, &cached, now);
        overlay(&mut c.accounts, &cached);
        let history = c.history.as_ref().map(|(_, h)| h.as_slice()).unwrap_or(&[]);
        let accounts: Vec<Parsed> = c
            .accounts
            .iter()
            .map(|p| {
                let mut p = p.clone();
                for w in &mut p.account.windows {
                    let ring = c.ring.get(&ring_key(&p.account.key, &w.id));
                    w.samples = window_samples(history, ring, &p.account.provider, &p.ident, w, now);
                }
                p
            })
            .collect();
        (c.fetched.map(|(_, at)| at).unwrap_or(now), accounts, c.error.clone())
    };
    let pairs: Vec<(String, Ident)> = accounts.iter().map(|p| (p.account.key.clone(), p.ident.clone())).collect();
    let sessions = tokio::task::spawn_blocking(move || session_accounts(&db, &live, &pairs))
        .await
        .map_err(|e| ApiError::new("internal", e.to_string()))?;
    let idents = accounts.iter().map(|p| p.ident.clone()).collect();
    Ok((AccountLimits { fetched_at, accounts: accounts.into_iter().map(|p| p.account).collect(), sessions, error }, idents))
}

/// While an omp session on this host runs a turn (and once more after the last one ends), reads
/// omp's cached reports into the readings every [`SAMPLE_EVERY`], so the pace has a reading about
/// every minute while agents work, with no app asking (`daemon::async_main`).
pub fn start(daemon: &Arc<Daemon>) {
    let weak = Arc::downgrade(daemon);
    let shutdown = daemon.shutdown.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(SAMPLE_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut was_busy = false;
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => return,
                _ = tick.tick() => {}
            }
            let Some(d) = weak.upgrade() else { return };
            let busy = d.omp.sessions().iter().any(|s| s.is_streaming());
            drop(d);
            if busy || was_busy {
                let db = omp_agent_dir().join("agent.db");
                let cached = tokio::task::spawn_blocking(move || cached_reports(&db)).await.unwrap_or_default();
                note_readings(&mut CACHE.lock().await.ring, &cached, now_ms());
            }
            was_busy = busy;
        }
    });
}

async fn refresh_cache(c: &mut Cache) {
    let now = now_ms();
    c.fetched = Some((Instant::now(), now));
    let Some(bin) = omp_bin() else {
        c.error = Some("omp is not installed on this host".into());
        return;
    };
    let want_history = c.history.as_ref().is_none_or(|(t, _)| t.elapsed() >= HISTORY_TTL);
    let (usage, history) = tokio::join!(omp_json(&bin, &["usage", "--json"]), async {
        if want_history { Some(omp_json(&bin, &["usage", "--history", "--json", "--days", HISTORY_DAYS]).await) } else { None }
    });
    match usage.and_then(|v| parse_usage(&v)) {
        Ok(accounts) => {
            note_readings(&mut c.ring, &accounts, now);
            c.accounts = accounts;
            c.error = None;
        }
        Err(e) => {
            tracing::warn!("omp usage --json failed: {e}");
            c.error = Some(e);
        }
    }
    match history {
        Some(Ok(v)) => c.history = Some((Instant::now(), parse_history(&v))),
        Some(Err(e)) => tracing::debug!("omp usage --history failed: {e}"),
        None => {}
    }
}

async fn omp_json(bin: &Path, args: &[&str]) -> Result<Value, String> {
    let out = run_cmd(bin, args, Some(&std::env::temp_dir()), &[("NO_COLOR", "1")], None, OMP_USAGE_TIMEOUT)
        .await
        .map_err(|e| format!("omp {}: {e}", args.join(" ")))?;
    if !out.ok() {
        return Err(format!("omp {} failed: {}", args.join(" "), out.message()));
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("omp {} output: {e}", args.join(" ")))
}

fn ring_key(account: &str, limit: &str) -> String {
    format!("{account}\0{limit}")
}

fn push_reading(ring: &mut VecDeque<Reading>, r: Reading, now: Millis) {
    if ring.back().is_some_and(|last| last.at >= r.at) {
        return;
    }
    ring.push_back(r);
    while ring.front().is_some_and(|f| f.at < now - RING_SPAN_MS) || ring.len() > RING_CAP {
        ring.pop_front();
    }
}

/// One reading per window of each report, at the report's `fetchedAt`.
fn note_readings(ring: &mut HashMap<String, VecDeque<Reading>>, accounts: &[Parsed], now: Millis) {
    for p in accounts {
        let Some(at) = p.account.fetched_at else { continue };
        for w in &p.account.windows {
            let Some(used) = w.used else { continue };
            push_reading(ring.entry(ring_key(&p.account.key, &w.id)).or_default(), Reading { at, used, resets_at: w.resets_at, headers: p.headers }, now);
        }
    }
}

/// omp's cached account reports (`cache` rows `usage_cache:report:…` of `agent.db`, read-only): what
/// `omp usage --json` prints without fetching, including the window rows omp refreshed from
/// response headers since. Rows past omp's retention and accounts without an identity (their key
/// depends on the report's position) are left out.
fn cached_reports(db: &Path) -> Vec<Parsed> {
    let Some(conn) = open_ro(db).ok().flatten() else { return vec![] };
    let rows: Vec<String> = match conn.prepare(
        "SELECT value FROM cache WHERE key >= 'usage_cache:report:' AND key < 'usage_cache:report;' AND expires_at > CAST(strftime('%s','now') AS INTEGER)",
    ) {
        Ok(mut stmt) => stmt.query_map([], |r| r.get::<_, String>(0)).map(|rows| rows.flatten().collect()).unwrap_or_default(),
        Err(_) => return vec![],
    };
    let reports: Vec<Value> = rows
        .iter()
        .filter_map(|raw| serde_json::from_str::<Value>(raw).ok().and_then(|mut v| v.get_mut("value").map(Value::take)))
        .filter(Value::is_object)
        .collect();
    parse_usage(&serde_json::json!({ "reports": reports }))
        .map(|accounts| accounts.into_iter().filter(|p| !p.account.windows.is_empty() && !p.account.key.contains("|#")).collect())
        .unwrap_or_default()
}

/// Brings the accounts of the `omp usage --json` snapshot up to omp's newer cached reports (window
/// rows omp refreshed from response headers since).
fn overlay(accounts: &mut [Parsed], cached: &[Parsed]) {
    for p in accounts.iter_mut().filter(|p| !p.account.windows.is_empty()) {
        if let Some(q) = cached.iter().find(|q| q.account.key == p.account.key && q.account.fetched_at > p.account.fetched_at) {
            p.account.windows = q.account.windows.clone();
            p.account.fetched_at = q.account.fetched_at;
            p.headers = q.headers;
        }
    }
}

// ───────────────────────────── parsing ─────────────────────────────

fn str_at(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

fn num_at(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64).filter(|n| n.is_finite())
}

fn ms_at(v: &Value, key: &str) -> Option<Millis> {
    num_at(v, key).map(|n| n as Millis)
}

fn ident_of(meta: &Value) -> Ident {
    Ident {
        email: str_at(meta, "email"),
        account_id: str_at(meta, "accountId"),
        project_id: str_at(meta, "projectId"),
        org_id: str_at(meta, "orgId"),
    }
}

/// `provider|email:…|org:…` (omp's org-scoped identity shape), else account / project id.
fn account_key(provider: &str, id: &Ident, fallback: usize) -> String {
    let base = id
        .email
        .as_ref()
        .map(|e| format!("email:{}", e.to_lowercase()))
        .or_else(|| id.account_id.as_ref().map(|a| format!("account:{a}")))
        .or_else(|| id.project_id.as_ref().map(|p| format!("project:{p}")));
    match (base, &id.org_id) {
        (Some(b), Some(o)) => format!("{provider}|{b}|org:{o}"),
        (Some(b), None) => format!("{provider}|{b}"),
        (None, Some(o)) => format!("{provider}|org:{o}"),
        (None, None) => format!("{provider}|#{fallback}"),
    }
}

fn label_of(id: &Ident, provider: &str) -> String {
    id.email.clone().or_else(|| id.account_id.clone()).or_else(|| id.project_id.clone()).unwrap_or_else(|| provider.to_string())
}

/// omp's `resolveUsedFraction`: explicit fraction > used/limit > percent used > 1 − remaining.
fn used_fraction(amount: &Value) -> Option<f64> {
    if let Some(f) = num_at(amount, "usedFraction") {
        return Some(f);
    }
    if let (Some(u), Some(l)) = (num_at(amount, "used"), num_at(amount, "limit"))
        && l > 0.0 {
            return Some(u / l);
        }
    if amount.get("unit").and_then(Value::as_str) == Some("percent")
        && let Some(u) = num_at(amount, "used") {
            return Some(u / 100.0);
        }
    num_at(amount, "remainingFraction").map(|r| (1.0 - r).max(0.0))
}

fn status_of(limit: &Value, used: Option<f64>) -> LimitStatus {
    match limit.get("status").and_then(Value::as_str) {
        Some("ok") => LimitStatus::Ok,
        Some("warning") => LimitStatus::Warning,
        Some("exhausted") => LimitStatus::Exhausted,
        _ => match used {
            Some(f) if f >= 1.0 => LimitStatus::Exhausted,
            Some(f) if f >= 0.8 => LimitStatus::Warning,
            Some(_) => LimitStatus::Ok,
            None => LimitStatus::Unknown,
        },
    }
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
}

fn parse_window(limit: &Value) -> Option<LimitWindow> {
    let id = str_at(limit, "id")?;
    let amount = limit.get("amount").cloned().unwrap_or(Value::Null);
    let window = limit.get("window").cloned().unwrap_or(Value::Null);
    let scope = limit.get("scope").cloned().unwrap_or(Value::Null);
    let unit = str_at(&amount, "unit").unwrap_or_else(|| "unknown".into());
    let used = used_fraction(&amount);
    let absolute = unit != "percent" && unit != "unknown";
    Some(LimitWindow {
        label: str_at(limit, "label").unwrap_or_else(|| id.clone()),
        window: str_at(&window, "label"),
        tier: str_at(&scope, "tier"),
        duration_ms: ms_at(&window, "durationMs").filter(|d| *d > 0),
        resets_at: ms_at(&window, "resetsAt"),
        status: status_of(limit, used),
        used,
        amount: if absolute { num_at(&amount, "used") } else { None },
        limit: if absolute { num_at(&amount, "limit") } else { None },
        unit,
        notes: strings(limit.get("notes")),
        samples: vec![],
        id,
    })
}

/// Parses `omp usage --json` (`{ generatedAt, reports, accountsWithoutUsage, disabledCredentials }`).
pub(crate) fn parse_usage(v: &Value) -> Result<Vec<Parsed>, String> {
    let reports = v.get("reports").and_then(Value::as_array).ok_or("omp usage --json: no `reports` array")?;
    let mut out: Vec<Parsed> = Vec::new();
    for (i, r) in reports.iter().enumerate() {
        let Some(provider) = str_at(r, "provider") else { continue };
        let meta = r.get("metadata").cloned().unwrap_or(Value::Null);
        let ident = ident_of(&meta);
        let key = account_key(&provider, &ident, i);
        let windows: Vec<LimitWindow> = r.get("limits").and_then(Value::as_array).map(|a| a.iter().filter_map(parse_window).collect()).unwrap_or_default();
        let fetched_at = ms_at(r, "fetchedAt");
        let headers = fetched_at.is_some() && ms_at(&meta, "headersUpdatedAt") == fetched_at;
        let credits = r.get("resetCredits");
        let resets_available = credits
            .and_then(|c| num_at(c, "redeemableCount").or_else(|| num_at(c, "availableCount")))
            .map(|n| n.max(0.0) as u32);
        let account = LimitAccount {
            label: label_of(&ident, &provider),
            org: str_at(&meta, "orgName").filter(|o| !o.ends_with("'s Organization")),
            plan: str_at(&meta, "planType").or_else(|| str_at(&meta, "subscriptionType")).or_else(|| str_at(&meta, "plan")).or_else(|| str_at(&meta, "tier")),
            fetched_at,
            resets_available,
            notes: strings(r.get("notes")),
            error: windows.is_empty().then(|| "omp reported no limit windows for this account".to_string()),
            disabled: false,
            windows,
            provider,
            key,
        };
        // Routing copies of one upstream quota (several base URLs) share a key: keep the newest.
        if let Some(prev) = out.iter_mut().find(|p| p.account.key == account.key) {
            if account.fetched_at > prev.account.fetched_at {
                *prev = Parsed { account, ident, headers };
            }
            continue;
        }
        out.push(Parsed { account, ident, headers });
    }
    let missing = |v: &Value, key: &str, error: &dyn Fn(&Value) -> String, disabled: bool, out: &mut Vec<Parsed>| {
        for (i, a) in v.get(key).and_then(Value::as_array).into_iter().flatten().enumerate() {
            let Some(provider) = str_at(a, "provider") else { continue };
            let ident = ident_of(a);
            let key = account_key(&provider, &ident, 10_000 + i);
            if out.iter().any(|p| p.account.key == key) {
                continue;
            }
            out.push(Parsed {
                account: LimitAccount {
                    label: label_of(&ident, &provider),
                    org: str_at(a, "orgName").filter(|o| !o.ends_with("'s Organization")),
                    plan: None,
                    fetched_at: None,
                    windows: vec![],
                    resets_available: None,
                    notes: vec![],
                    error: Some(error(a)),
                    disabled,
                    provider,
                    key,
                },
                ident,
                headers: false,
            });
        }
    };
    missing(v, "accountsWithoutUsage", &|_| "omp has no usage report for this account (the last fetch failed or is rate-limited)".into(), false, &mut out);
    missing(
        v,
        "disabledCredentials",
        &|a| {
            let cause = str_at(a, "cause").unwrap_or_else(|| "disabled".into());
            let cause: String = cause.chars().take(200).collect();
            format!("Disabled by omp: {cause}")
        },
        true,
        &mut out,
    );
    Ok(out)
}

/// Parses `omp usage --history --json` (`{ entries: UsageHistoryEntry[] }`).
pub(crate) fn parse_history(v: &Value) -> Vec<HistoryRow> {
    v.get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|e| {
            Some(HistoryRow {
                provider: str_at(e, "provider")?,
                email: str_at(e, "email"),
                account_id: str_at(e, "accountId"),
                limit_id: str_at(e, "limitId")?,
                at: ms_at(e, "recordedAt")?,
                used: num_at(e, "usedFraction"),
                resets_at: ms_at(e, "resetsAt"),
            })
        })
        .collect()
}

// ───────────────────────────── samples ─────────────────────────────

fn same_account(row: &HistoryRow, id: &Ident) -> bool {
    match (&row.account_id, &id.account_id) {
        (Some(a), Some(b)) => a == b,
        _ => matches!((&row.email, &id.email), (Some(a), Some(b)) if a.eq_ignore_ascii_case(b)),
    }
}

/// Readings of `w` in its current window period, oldest first, at most [`MAX_SAMPLES`] ([`downsample`]).
fn window_samples(history: &[HistoryRow], ring: Option<&VecDeque<Reading>>, provider: &str, id: &Ident, w: &LimitWindow, now: Millis) -> Vec<LimitSample> {
    let mut all: Vec<Reading> = history
        .iter()
        .filter(|h| h.provider == provider && h.limit_id == w.id && same_account(h, id))
        .filter_map(|h| Some(Reading { at: h.at, used: h.used?, resets_at: h.resets_at, headers: false }))
        .chain(ring.into_iter().flatten().copied())
        .collect();
    all.sort_by_key(|r| r.at);
    all.dedup_by(|b, a| (b.at - a.at).abs() < 1000);
    let span = w.duration_ms.unwrap_or(24 * HOUR_MS);
    let start = match w.resets_at {
        Some(r) if w.duration_ms.is_some() => r - span,
        _ => now - span.min(24 * HOUR_MS),
    };
    let mut cur: Vec<Reading> = all
        .into_iter()
        .filter(|r| r.at >= start && r.at <= now + 60_000)
        .filter(|r| match (r.resets_at, w.resets_at) {
            (Some(a), Some(b)) => (a - b).abs() <= PERIOD_SLACK_MS,
            _ => true,
        })
        .collect();
    // A full report soon followed by a reading from response headers gives way to it.
    let keep: Vec<bool> = (0..cur.len())
        .map(|i| cur[i].headers || !cur[i + 1..].iter().take_while(|r| r.at - cur[i].at <= HEADERS_SUPERSEDE_MS).any(|r| r.headers))
        .collect();
    let mut keep = keep.into_iter();
    cur.retain(|_| keep.next().unwrap_or(true));
    if let Some(cut) = (1..cur.len()).rev().find(|&i| cur[i].used + RESET_DROP < cur[i - 1].used) {
        cur.drain(..cut);
    }
    downsample(cur.into_iter().map(|r| LimitSample { at: r.at, used: r.used }).collect(), MAX_SAMPLES)
}

/// At most `max` samples: every one of the last [`RECENT_MS`] before the newest (thinned only past
/// `max` − [`OLDER_MIN`]), older ones evenly spaced, keeping the first and the last of each part.
fn downsample(v: Vec<LimitSample>, max: usize) -> Vec<LimitSample> {
    if v.len() <= max {
        return v;
    }
    let newest = v.last().map_or(0, |s| s.at);
    let (older, recent) = v.split_at(v.partition_point(|s| s.at < newest - RECENT_MS));
    let recent = evenly(recent, max.saturating_sub(older.len().min(OLDER_MIN)));
    let older = evenly(older, max - recent.len());
    [older, recent].concat()
}

/// `n` evenly spaced items of `v`, its first and last among them (just the last for `n` = 1).
fn evenly(v: &[LimitSample], n: usize) -> Vec<LimitSample> {
    match n {
        _ if v.len() <= n => v.to_vec(),
        0 => vec![],
        1 => v[v.len() - 1..].to_vec(),
        _ => (0..n).map(|i| v[i * (v.len() - 1) / (n - 1)].clone()).collect(),
    }
}

// ───────────────────────────── sessions ─────────────────────────────

/// Whether omp's credential `identity_key` (`email:…|org:…`, `account:…`, …) names `id`.
pub(crate) fn identity_matches(identity_key: &str, id: &Ident) -> bool {
    let mut matched = false;
    for part in identity_key.split('|') {
        let Some((kind, value)) = part.split_once(':') else { continue };
        let ok = match kind {
            "email" => id.email.as_deref().is_some_and(|e| e.eq_ignore_ascii_case(value)),
            "account" => id.account_id.as_deref() == Some(value),
            "project" => id.project_id.as_deref() == Some(value),
            "org" => id.org_id.as_deref() == Some(value),
            _ => continue,
        };
        if !ok {
            return false;
        }
        matched = true;
    }
    matched
}

/// Maps live omp sessions (`(session id, provider)`) to account keys via omp's session pins.
fn session_accounts(db: &Path, live: &[(String, String)], accounts: &[(String, Ident)]) -> Vec<LimitSession> {
    let conn = open_ro(db).ok().flatten();
    live.iter()
        .map(|(sid, provider)| {
            let identity = conn.as_ref().and_then(|c| pinned_identity(c, provider, sid));
            let prefix = format!("{provider}|");
            let account_key = identity
                .and_then(|ik| accounts.iter().find(|(k, id)| k.starts_with(&prefix) && identity_matches(&ik, id)).map(|(k, _)| k.clone()))
                .or_else(|| {
                    // A provider with exactly one account needs no pin.
                    let mut of = accounts.iter().filter(|(k, _)| k.starts_with(&prefix));
                    match (of.next(), of.next()) {
                        (Some((k, _)), None) => Some(k.clone()),
                        _ => None,
                    }
                });
            LimitSession { session_id: sid.clone(), provider: provider.clone(), account_key }
        })
        .collect()
}

/// The `identity_key` of the credential omp pinned `session` to (never reads credential data).
fn pinned_identity(conn: &rusqlite::Connection, provider: &str, session: &str) -> Option<String> {
    let raw: String = conn
        .query_row(
            "SELECT value FROM cache WHERE key = ?1 AND expires_at > CAST(strftime('%s','now') AS INTEGER)",
            [format!("session:sticky:{provider}:{session}")],
            |r| r.get(0),
        )
        .ok()?;
    let pin: Value = serde_json::from_str(&raw).ok()?;
    let id = pin.get("credentialId").and_then(Value::as_i64)?;
    conn.query_row("SELECT identity_key FROM auth_credentials WHERE id = ?1 AND provider = ?2", rusqlite::params![id, provider], |r| r.get::<_, Option<String>>(0))
        .ok()
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Shape of `omp usage --json` (omp 18.12.3), identities replaced.
    fn usage_fixture() -> Value {
        json!({
            "generatedAt": 1_792_578_474_573_i64,
            "reports": [
                {
                    "provider": "openai-codex",
                    "fetchedAt": 1_792_578_473_818_i64,
                    "limits": [{
                        "id": "openai-codex:primary", "label": "7 days",
                        "scope": { "provider": "openai-codex", "windowId": "7d", "shared": true },
                        "window": { "id": "7d", "label": "7 days", "durationMs": 604_800_000, "resetsAt": 1_793_102_764_000_i64 },
                        "amount": { "used": 23, "limit": 100, "remaining": 77, "usedFraction": 0.23, "remainingFraction": 0.77, "unit": "percent" },
                        "status": "ok"
                    }],
                    "resetCredits": { "availableCount": 0 },
                    "metadata": { "planType": "prolite", "email": "dev@example.com", "accountId": "acc-codex", "orgId": "acc-codex", "orgName": "plus" }
                },
                {
                    "provider": "anthropic",
                    "fetchedAt": 1_792_578_458_494_i64,
                    "limits": [
                        {
                            "id": "anthropic:5h", "label": "Claude 5 Hour",
                            "scope": { "provider": "anthropic", "windowId": "5h", "shared": true },
                            "window": { "id": "5h", "label": "5 Hour", "durationMs": 18_000_000, "resetsAt": 1_792_590_000_312_i64 },
                            "amount": { "used": 2, "limit": 100, "remaining": 98, "usedFraction": 0.02, "remainingFraction": 0.98, "unit": "percent" },
                            "status": "ok"
                        },
                        {
                            "id": "anthropic:7d", "label": "Claude 7 Day",
                            "scope": { "provider": "anthropic", "windowId": "7d", "shared": true },
                            "window": { "id": "7d", "label": "7 Day", "durationMs": 604_800_000, "resetsAt": 1_792_976_400_312_i64 },
                            "amount": { "used": 94, "limit": 100, "remaining": 6, "usedFraction": 0.94, "remainingFraction": 0.06, "unit": "percent" },
                            "status": "warning"
                        },
                        {
                            "id": "anthropic:7d:fable", "label": "Claude 7 Day (Fable)",
                            "scope": { "provider": "anthropic", "windowId": "7d", "tier": "fable" },
                            "window": { "id": "7d", "label": "7 Day", "durationMs": 604_800_000, "resetsAt": 1_792_976_400_312_i64 },
                            "amount": { "used": 9, "limit": 100, "unit": "percent" }
                        }
                    ],
                    "metadata": { "endpoint": "https://api.anthropic.com/api/oauth/usage", "accountId": "acc-a", "email": "Work@Example.com", "orgId": "org-a", "orgName": "work@example.com's Organization" },
                    "resetCredits": { "availableCount": 1, "redeemableCount": 1, "eligible": true }
                }
            ],
            "accountsWithoutUsage": [{ "provider": "anthropic", "email": "late@example.com", "orgId": "org-l" }],
            "disabledCredentials": [{ "id": 1, "provider": "anthropic", "type": "oauth", "cause": "oauth refresh failed: invalid_grant", "email": "old@example.com", "orgId": "org-o", "disabledAtMs": 1 }],
            "capacity": {}
        })
    }

    #[test]
    fn parses_reports_windows_and_missing_accounts() {
        let accts = parse_usage(&usage_fixture()).unwrap();
        assert_eq!(accts.len(), 4);
        let codex = &accts[0].account;
        assert_eq!(codex.key, "openai-codex|email:dev@example.com|org:acc-codex");
        assert_eq!(codex.label, "dev@example.com");
        assert_eq!(codex.plan.as_deref(), Some("prolite"));
        assert_eq!(codex.org.as_deref(), Some("plus"));
        assert_eq!(codex.resets_available, Some(0));
        assert_eq!(codex.windows[0].used, Some(0.23));
        assert_eq!(codex.windows[0].duration_ms, Some(604_800_000));
        assert_eq!(codex.windows[0].resets_at, Some(1_793_102_764_000));
        assert_eq!(codex.windows[0].status, LimitStatus::Ok);
        assert_eq!(codex.windows[0].amount, None, "percent windows carry no absolute amount");

        let claude = &accts[1].account;
        assert_eq!(claude.key, "anthropic|email:work@example.com|org:org-a");
        assert_eq!(claude.org, None, "omp's default `…'s Organization` name is noise");
        assert_eq!(claude.resets_available, Some(1));
        assert_eq!(claude.windows.len(), 3);
        assert_eq!(claude.windows[1].status, LimitStatus::Warning);
        let fable = &claude.windows[2];
        assert_eq!(fable.tier.as_deref(), Some("fable"));
        assert_eq!(fable.used, Some(0.09), "used/limit when no usedFraction");
        assert_eq!(fable.status, LimitStatus::Ok, "status derived like omp's resolveStatus");

        assert!(accts[2].account.error.is_some() && !accts[2].account.disabled);
        assert!(accts[3].account.disabled);
        assert!(accts[3].account.error.as_deref().unwrap().contains("invalid_grant"));
    }

    #[test]
    fn used_fraction_precedence() {
        assert_eq!(used_fraction(&json!({ "usedFraction": 0.5, "used": 10, "limit": 100, "unit": "tokens" })), Some(0.5));
        assert_eq!(used_fraction(&json!({ "used": 25, "limit": 100, "unit": "tokens" })), Some(0.25));
        assert_eq!(used_fraction(&json!({ "used": 40, "unit": "percent" })), Some(0.4));
        assert_eq!(used_fraction(&json!({ "remainingFraction": 0.75, "unit": "unknown" })), Some(0.25));
        assert_eq!(used_fraction(&json!({ "unit": "unknown" })), None);
        let w = parse_window(&json!({ "id": "x:tokens", "label": "Tokens", "amount": { "used": 5000, "limit": 20000, "unit": "tokens" } })).unwrap();
        assert_eq!((w.amount, w.limit, w.unit.as_str()), (Some(5000.0), Some(20000.0), "tokens"));
        assert_eq!(w.status, LimitStatus::Ok);
    }

    #[test]
    fn rejects_non_report_output() {
        assert!(parse_usage(&json!({ "error": "nope" })).is_err());
    }

    #[test]
    fn duplicate_routing_reports_keep_newest() {
        let mut v = usage_fixture();
        let mut older = v["reports"][1].clone();
        older["fetchedAt"] = json!(1);
        older["limits"][0]["amount"]["usedFraction"] = json!(0.5);
        v["reports"].as_array_mut().unwrap().insert(1, older);
        let accts = parse_usage(&v).unwrap();
        let claude: Vec<_> = accts.iter().filter(|p| p.account.provider == "anthropic" && !p.account.windows.is_empty()).collect();
        assert_eq!(claude.len(), 1);
        assert_eq!(claude[0].account.windows[0].used, Some(0.02));
    }

    #[test]
    fn parses_history_rows() {
        let rows = parse_history(&json!({ "entries": [
            { "recordedAt": 10, "provider": "anthropic", "accountKey": "k", "email": "a@b.c", "accountId": "acc", "limitId": "anthropic:5h", "label": "x", "usedFraction": 0.1, "status": "ok", "resetsAt": 99 },
            { "recordedAt": 11, "provider": "anthropic", "limitId": "anthropic:7d", "label": "x" },
            { "provider": "anthropic", "limitId": "broken" }
        ] }));
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].used, Some(0.1));
        assert_eq!(rows[0].resets_at, Some(99));
        assert_eq!(rows[1].used, None);
    }

    fn window(resets_at: Option<Millis>, duration: Option<i64>) -> LimitWindow {
        LimitWindow {
            id: "anthropic:5h".into(),
            label: "Claude 5 Hour".into(),
            window: None,
            tier: None,
            duration_ms: duration,
            resets_at,
            used: Some(0.5),
            status: LimitStatus::Ok,
            amount: None,
            limit: None,
            unit: "percent".into(),
            notes: vec![],
            samples: vec![],
        }
    }

    fn row(at: Millis, used: f64, resets_at: Option<Millis>) -> HistoryRow {
        HistoryRow { provider: "anthropic".into(), email: None, account_id: Some("acc".into()), limit_id: "anthropic:5h".into(), at, used: Some(used), resets_at }
    }

    #[test]
    fn samples_cover_current_period_only() {
        let id = Ident { account_id: Some("acc".into()), ..Default::default() };
        let now = 10 * HOUR_MS;
        let resets = now + 2 * HOUR_MS; // window started at now - 3 h
        let w = window(Some(resets), Some(5 * HOUR_MS));
        let history = vec![
            row(now - 4 * HOUR_MS, 0.9, Some(resets - 5 * HOUR_MS)), // previous period
            row(now - 2 * HOUR_MS, 0.1, Some(resets)),
            row(now - HOUR_MS, 0.3, Some(resets)),
            HistoryRow { account_id: Some("other".into()), ..row(now - HOUR_MS, 0.8, Some(resets)) },
        ];
        let mut ring = VecDeque::new();
        push_reading(&mut ring, Reading { at: now - 60_000, used: 0.45, resets_at: Some(resets), headers: false }, now);
        push_reading(&mut ring, Reading { at: now - 120_000, used: 0.44, resets_at: Some(resets), headers: false }, now); // out of order: dropped
        let s = window_samples(&history, Some(&ring), "anthropic", &id, &w, now);
        assert_eq!(s.iter().map(|x| x.used).collect::<Vec<_>>(), vec![0.1, 0.3, 0.45]);
    }

    #[test]
    fn samples_cut_at_a_reset_drop() {
        let id = Ident { account_id: Some("acc".into()), ..Default::default() };
        let now = 30 * HOUR_MS;
        let w = window(None, Some(5 * HOUR_MS));
        let history = vec![row(now - 3 * HOUR_MS, 0.7, None), row(now - 2 * HOUR_MS, 0.9, None), row(now - HOUR_MS, 0.05, None), row(now - 60_000, 0.1, None)];
        let s = window_samples(&history, None, "anthropic", &id, &w, now);
        assert_eq!(s.iter().map(|x| x.used).collect::<Vec<_>>(), vec![0.05, 0.1]);
    }

    #[test]
    fn full_reports_give_way_to_header_readings() {
        // omp's usage endpoint read 76 % where the response headers of the same minutes read 75 %.
        let id = Ident { account_id: Some("acc".into()), ..Default::default() };
        let now = 10 * HOUR_MS;
        let w = window(None, Some(5 * HOUR_MS));
        let mut ring = VecDeque::new();
        for (m, used, headers) in [(10, 0.75, true), (9, 0.76, false), (8, 0.75, true), (3, 0.75, true), (1, 0.76, false)] {
            push_reading(&mut ring, Reading { at: now - m * 60_000, used, resets_at: None, headers }, now);
        }
        let s = window_samples(&[], Some(&ring), "anthropic", &id, &w, now);
        assert_eq!(s.iter().map(|x| x.used).collect::<Vec<_>>(), vec![0.75, 0.75, 0.75, 0.76], "the newest full report stays until headers follow it");
    }

    #[test]
    fn recent_readings_survive_downsampling() {
        // A reading a minute for a week: the last hour stays whole (the pace needs one 5 min old).
        let v: Vec<LimitSample> = (0..7 * 24 * 60).map(|m| LimitSample { at: m * 60_000, used: m as f64 / 10_080.0 }).collect();
        let newest = v[v.len() - 1].at;
        let d = downsample(v, MAX_SAMPLES);
        assert_eq!(d.len(), MAX_SAMPLES);
        assert_eq!(d[0].at, 0, "the period's first reading stays");
        let recent: Vec<Millis> = d.iter().filter(|s| s.at >= newest - RECENT_MS).map(|s| s.at).collect();
        assert_eq!(recent, (0..=60).rev().map(|m| newest - m * 60_000).collect::<Vec<_>>());
        assert!(d.windows(2).all(|p| p[0].at < p[1].at));
        // More readings in the last hour than fit: thinned, older ones keep their share.
        let dense: Vec<LimitSample> = (0..2_000).map(|i| LimitSample { at: i * 3_000, used: 0.0 }).collect();
        let d = downsample(dense, MAX_SAMPLES);
        assert_eq!(d.len(), MAX_SAMPLES);
        assert_eq!(d[MAX_SAMPLES - 1].at, 1_999 * 3_000);
        assert_eq!(d.iter().filter(|s| s.at >= 1_999 * 3_000 - RECENT_MS).count(), MAX_SAMPLES - OLDER_MIN);
    }

    #[test]
    fn omps_cached_reports_bring_the_snapshot_up_to_date() {
        let td = tempfile::tempdir().unwrap();
        let db = td.path().join("agent.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);").unwrap();
        // omp refreshed Claude's windows from response headers a minute after `omp usage --json` ran.
        let mut claude = usage_fixture()["reports"][1].clone();
        let at = claude["fetchedAt"].as_i64().unwrap() + 60_000;
        claude["fetchedAt"] = json!(at);
        claude["metadata"]["headersUpdatedAt"] = json!(at);
        claude["limits"][1]["amount"]["usedFraction"] = json!(0.96);
        // An older Codex report, a row past omp's retention and a report without an identity.
        let mut codex = usage_fixture()["reports"][0].clone();
        codex["fetchedAt"] = json!(1);
        let mut gone = claude.clone();
        gone["metadata"]["email"] = json!("gone@example.com");
        let mut anon = claude.clone();
        anon["metadata"] = json!({});
        let insert = |key: &str, report: &Value, expires: i64| {
            conn.execute("INSERT INTO cache VALUES (?1, ?2, ?3)", rusqlite::params![key, json!({ "value": report, "expiresAt": 0 }).to_string(), expires]).unwrap();
        };
        insert("usage_cache:report:anthropic:default:oauth|email:work@example.com", &claude, 4_102_444_800);
        insert("usage_cache:report:openai-codex:default:oauth|email:dev@example.com", &codex, 4_102_444_800);
        insert("usage_cache:report:anthropic:default:oauth|email:gone@example.com", &gone, 1);
        insert("usage_cache:report:anthropic:default:oauth|anonymous", &anon, 4_102_444_800);
        insert("session:sticky:anthropic:s1", &json!({ "credentialId": 1 }), 4_102_444_800);
        drop(conn);
        let cached = cached_reports(&db);
        let mut keys: Vec<&str> = cached.iter().map(|p| p.account.key.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["anthropic|email:work@example.com|org:org-a", "openai-codex|email:dev@example.com|org:acc-codex"]);

        let mut accounts = parse_usage(&usage_fixture()).unwrap();
        overlay(&mut accounts, &cached);
        let claude = &accounts[1];
        assert_eq!((claude.account.fetched_at, claude.account.windows[1].used, claude.headers), (Some(at), Some(0.96), true));
        assert_eq!(accounts[0].account.fetched_at, Some(1_792_578_473_818), "an older cached report changes nothing");

        let mut ring = HashMap::new();
        note_readings(&mut ring, &cached, at);
        let r = ring.get(&ring_key("anthropic|email:work@example.com|org:org-a", "anthropic:7d")).and_then(|r| r.back().copied());
        assert_eq!(r.map(|r| (r.at, r.used, r.headers)), Some((at, 0.96, true)));
    }

    #[test]
    fn identity_keys_match_report_metadata() {
        let id = Ident { email: Some("Work@Example.com".into()), account_id: Some("acc".into()), project_id: None, org_id: Some("org-a".into()) };
        assert!(identity_matches("email:work@example.com|org:org-a", &id));
        assert!(!identity_matches("email:work@example.com|org:org-b", &id));
        assert!(identity_matches("account:acc", &id));
        assert!(!identity_matches("weird", &id));
    }

    #[test]
    fn sessions_map_through_omp_pins() {
        let td = tempfile::tempdir().unwrap();
        let db = td.path().join("agent.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);
             CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT, identity_key TEXT);
             INSERT INTO auth_credentials VALUES (7, 'anthropic', 'oauth', '{}', NULL, 'email:a@x.com|org:o1');
             INSERT INTO auth_credentials VALUES (8, 'anthropic', 'oauth', '{}', NULL, 'email:b@x.com|org:o2');
             INSERT INTO cache VALUES ('session:sticky:anthropic:s1', '{\"type\":\"oauth\",\"index\":1,\"credentialId\":8}', 4102444800);
             INSERT INTO cache VALUES ('session:sticky:anthropic:s3', '{\"type\":\"oauth\",\"index\":0,\"credentialId\":7}', 1);",
        )
        .unwrap();
        drop(conn);
        let a = Ident { email: Some("a@x.com".into()), org_id: Some("o1".into()), ..Default::default() };
        let b = Ident { email: Some("b@x.com".into()), org_id: Some("o2".into()), ..Default::default() };
        let c = Ident { email: Some("c@x.com".into()), ..Default::default() };
        let accounts = vec![
            (account_key("anthropic", &a, 0), a),
            (account_key("anthropic", &b, 1), b),
            (account_key("openai-codex", &c, 2), c),
        ];
        let live = vec![
            ("s1".to_string(), "anthropic".to_string()),
            ("s2".to_string(), "anthropic".to_string()), // no pin, two accounts → unknown
            ("s3".to_string(), "anthropic".to_string()), // pin expired
            ("s4".to_string(), "openai-codex".to_string()), // single account
        ];
        let s = session_accounts(&db, &live, &accounts);
        assert_eq!(s[0].account_key.as_deref(), Some("anthropic|email:b@x.com|org:o2"));
        assert_eq!(s[1].account_key, None);
        assert_eq!(s[2].account_key, None);
        assert_eq!(s[3].account_key.as_deref(), Some("openai-codex|email:c@x.com"));
    }
}
