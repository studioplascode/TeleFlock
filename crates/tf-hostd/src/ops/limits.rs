//! `host.limits`: subscription / account usage limits exactly as omp knows them.
//!
//! omp fetches per-account quota reports (Claude 5 h / 7 d windows, Codex weekly, …) from each
//! provider's usage endpoint, caches them ~5 min per account in `<agent dir>/agent.db` and
//! refreshes the window rows from live response headers. `omp usage --json` prints that
//! snapshot (without tokens); `omp usage --history --json` prints the hourly `usage_history`
//! rows omp records whenever a fresh report lands. hostd only runs those two commands — no
//! provider calls, no credentials — and adds its own per-poll readings so the client can
//! estimate the pace of each window.
//!
//! The session → account mapping reads omp's persisted session pin (`cache` row
//! `session:sticky:<provider>:<session id>` → credential id) and that credential's
//! `identity_key` from `agent.db`, read-only. The credential payload column is never read.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use serde_json::Value;
use tf_proto::{AccountLimits, ApiError, LimitAccount, LimitSample, LimitSession, LimitStatus, LimitWindow, Millis};

use crate::ops::git::run_cmd;
use crate::ops::host::{omp_agent_dir, omp_bin, open_ro};
use crate::ops::Ctx;
use crate::util::now_ms;

/// hostd's own cache of `omp usage --json`: omp itself serves a per-account cache of ~5 min, so
/// re-running it sooner (0.7 s CPU, ~200 MB) mostly re-reads the same report. `refresh: true`
/// asks again after [`REFRESH_MIN`].
const TTL: Duration = Duration::from_secs(300);
/// Minimum spacing of explicit refreshes.
const REFRESH_MIN: Duration = Duration::from_secs(10);
/// `omp usage --history` only gains a row per hour.
const HISTORY_TTL: Duration = Duration::from_secs(600);
const HISTORY_DAYS: &str = "8";
const OMP_USAGE_TIMEOUT: Duration = Duration::from_secs(45);
/// Samples sent per window.
const MAX_SAMPLES: usize = 120;
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
    let (fetched_at, accounts, error) = {
        let mut c = CACHE.lock().await;
        let max_age = if refresh { REFRESH_MIN } else { TTL };
        if c.fetched.is_none_or(|(t, _)| t.elapsed() >= max_age) {
            refresh_cache(&mut c).await;
        }
        let now = now_ms();
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
    let db = omp_agent_dir().join("agent.db");
    let pairs: Vec<(String, Ident)> = accounts.iter().map(|p| (p.account.key.clone(), p.ident.clone())).collect();
    let sessions = tokio::task::spawn_blocking(move || session_accounts(&db, &live, &pairs))
        .await
        .map_err(|e| ApiError::new("internal", e.to_string()))?;
    let idents = accounts.iter().map(|p| p.ident.clone()).collect();
    Ok((AccountLimits { fetched_at, accounts: accounts.into_iter().map(|p| p.account).collect(), sessions, error }, idents))
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
            for p in &accounts {
                let Some(at) = p.account.fetched_at else { continue };
                for w in &p.account.windows {
                    let Some(used) = w.used else { continue };
                    push_reading(c.ring.entry(ring_key(&p.account.key, &w.id)).or_default(), Reading { at, used, resets_at: w.resets_at }, now);
                }
            }
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
        let credits = r.get("resetCredits");
        let resets_available = credits
            .and_then(|c| num_at(c, "redeemableCount").or_else(|| num_at(c, "availableCount")))
            .map(|n| n.max(0.0) as u32);
        let account = LimitAccount {
            label: label_of(&ident, &provider),
            org: str_at(&meta, "orgName").filter(|o| !o.ends_with("'s Organization")),
            plan: str_at(&meta, "planType").or_else(|| str_at(&meta, "subscriptionType")).or_else(|| str_at(&meta, "plan")).or_else(|| str_at(&meta, "tier")),
            fetched_at: ms_at(r, "fetchedAt"),
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
                *prev = Parsed { account, ident };
            }
            continue;
        }
        out.push(Parsed { account, ident });
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

/// Readings of `w` in its current window period, oldest first, at most [`MAX_SAMPLES`].
fn window_samples(history: &[HistoryRow], ring: Option<&VecDeque<Reading>>, provider: &str, id: &Ident, w: &LimitWindow, now: Millis) -> Vec<LimitSample> {
    let mut all: Vec<Reading> = history
        .iter()
        .filter(|h| h.provider == provider && h.limit_id == w.id && same_account(h, id))
        .filter_map(|h| Some(Reading { at: h.at, used: h.used?, resets_at: h.resets_at }))
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
    if let Some(cut) = (1..cur.len()).rev().find(|&i| cur[i].used + RESET_DROP < cur[i - 1].used) {
        cur.drain(..cut);
    }
    downsample(cur.into_iter().map(|r| LimitSample { at: r.at, used: r.used }).collect(), MAX_SAMPLES)
}

/// Keeps `max` evenly spaced samples, always including the first and the last.
fn downsample(v: Vec<LimitSample>, max: usize) -> Vec<LimitSample> {
    if v.len() <= max || max < 2 {
        return v;
    }
    let n = v.len();
    (0..max).map(|i| v[i * (n - 1) / (max - 1)].clone()).collect()
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
        push_reading(&mut ring, Reading { at: now - 60_000, used: 0.45, resets_at: Some(resets) }, now);
        push_reading(&mut ring, Reading { at: now - 120_000, used: 0.44, resets_at: Some(resets) }, now); // out of order: dropped
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
    fn downsample_keeps_ends() {
        let v: Vec<LimitSample> = (0..1000).map(|i| LimitSample { at: i, used: i as f64 }).collect();
        let d = downsample(v, 120);
        assert_eq!(d.len(), 120);
        assert_eq!(d[0].at, 0);
        assert_eq!(d[119].at, 999);
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
