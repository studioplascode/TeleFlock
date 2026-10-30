//! Auto-resume after provider limits (architecture §3.22): the limit half of [`crate::recovery`].
//!
//! A 2.1.0 bridge reports a terminal usage or rate-limit stop of the main agent or a subagent
//! (`turn_error`, after omp's own retries gave up). [`on_turn_error`] opens (or extends) the root
//! omp session's ticket with the time usage is expected back ([`due`], from [`provider_usage`] over
//! every account of the provider omp can rotate to): soon ([`ROTATE_MS`]) when another account has
//! room, else the earliest reset of the exhausted accounts (plus [`WINDOW_MARGIN_MS`]), else the
//! provider's own retry-after (plus [`HINT_MARGIN_MS`]), else usage is checked again after
//! [`BACKOFF_MS`]; a rate limit on an account out of usage is a usage limit. When the ticket is due,
//! [`still_exhausted`] reads omp's usage afresh and reschedules while every account is still out.
//! Every 2.1.0 bridge learns whether its `context` guard (limit errors out of the model's view) is
//! on, at connect and whenever the host setting changes ([`start`]); after a hostd restart,
//! `failedTails` brings back what stopped meanwhile ([`follow`]). `agent.retry` lives here too
//! ([`retry`], [`f5`]). The ticket store, scheduler, board publishing and executor are
//! `crate::recovery`'s.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::broadcast;
use tracing::{info, warn};

use tf_proto::model::Agent;
use tf_proto::{AccountLimits, ApiError, AutoResumeKind, LimitAccount, LimitStatus, Millis, ResumeBasis, RetryResult, RetryVia};

use crate::bridge::{BridgeEvent, BridgeHandle, BridgeSession, FailedTails, TurnError};
use crate::daemon::Daemon;
use crate::inject::{self, When};
use crate::ops::Ctx;
use crate::recovery::{Ticket, TicketInit};
use crate::util::{clip, now_ms};

/// After a window's reset, omp's usage report takes a moment to say so.
pub const WINDOW_MARGIN_MS: Millis = 2 * 60_000;
/// After the provider's own retry-after / reset time.
pub const HINT_MARGIN_MS: Millis = 30_000;
/// Another account of the provider has room: omp rotates its credentials to it after this pause.
pub const ROTATE_MS: Millis = 60_000;
/// Neither known: check again after 15 min, 30 min, then every hour.
pub const BACKOFF_MS: [Millis; 3] = [15 * 60_000, 30 * 60_000, 60 * 60_000];
/// Stops found after the fact (`failedTails` after a hostd restart or reconnect) open a ticket only
/// this recent; older ones are left for Resume by hand.
const HISTORY_MAX_AGE_MS: Millis = 12 * 3_600_000;
/// How much of a transcript's end [`went_on`] reads.
const AFTER_WINDOW: u64 = 1 << 20;
/// Bridges reconnect in a burst after a hostd restart; the board maps their sessions once herdr's
/// snapshot and the omp registry are in: the reconcile looks every [`MAP_GRACE`], [`MAP_WAITS`] times.
const MAP_GRACE: Duration = Duration::from_secs(2);
const MAP_WAITS: u32 = 30;
/// What a limit ticket says when its agent's omp went away while it waited.
pub const OMP_GONE: &str = "omp exited while it waited";
/// After this many automatic resumes in a row that ran straight into a limit again, the ticket
/// waits for Resume.
pub const MAX_RESTOPS: u32 = 8;

/// The ticket kind of a failure omp gave up on (`None`: not one that passes by itself). omp's
/// classifier names limits (`kind`); a "rate limit" whose HTTP status is a server error was the
/// provider failing: 529, 503 or an "overloaded" message → overloaded, another 5xx → provider error.
pub fn kind_of(e: &TurnError) -> Option<AutoResumeKind> {
    let limit = match e.kind.as_str() {
        "usageLimit" => AutoResumeKind::UsageLimit,
        "rateLimit" => AutoResumeKind::RateLimit,
        _ => return None,
    };
    let overloaded = || e.message.to_lowercase().contains("overloaded");
    Some(match e.error_status {
        Some(503 | 529) => AutoResumeKind::Overloaded,
        Some(500..=599) if overloaded() => AutoResumeKind::Overloaded,
        Some(500..=599) => AutoResumeKind::ProviderError,
        None if overloaded() => AutoResumeKind::Overloaded,
        _ => limit,
    })
}

/// A usage or rate limit (usage windows tell when it passes), not a provider failure.
fn is_limit(kind: AutoResumeKind) -> bool {
    matches!(kind, AutoResumeKind::UsageLimit | AutoResumeKind::RateLimit)
}

/// The cause a ticket names when its agents stopped on several: the one that lasts longest.
fn rank(kind: AutoResumeKind) -> u8 {
    match kind {
        AutoResumeKind::UsageLimit => 3,
        AutoResumeKind::RateLimit => 2,
        AutoResumeKind::Overloaded => 1,
        _ => 0,
    }
}

/// What omp's usage report says about the accounts a stopped session can go on with: its own (omp's
/// `session:sticky` pin, else the provider's only account) and every other enabled account of the
/// provider, which omp rotates its credentials to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Usage {
    /// No report for the provider's accounts (API keys, nothing fetched).
    Unknown,
    /// The session's own account has room.
    Available,
    /// Another account has room now; `own_out`: the session's own account is out of usage.
    Elsewhere { own_out: bool },
    /// Every reported account is out for the model; the earliest of their resets, when known.
    Exhausted(Option<Millis>),
}

impl Usage {
    /// The stop is a usage limit whatever omp called it (Anthropic answers an exhausted
    /// subscription window with `rate_limit_error`, which omp classifies as a rate limit).
    pub fn out(self) -> bool {
        matches!(self, Usage::Exhausted(_) | Usage::Elsewhere { own_out: true })
    }
}

/// One account, judged on the windows that meter `model` (lowercase; shared windows and
/// tier-scoped ones the model names, as the app's `windowsForModel`): `Exhausted` carries the
/// latest reset among its exhausted windows. Never `Elsewhere`.
fn account_usage(account: &LimitAccount, model: &str) -> Usage {
    let windows: Vec<_> = account.windows.iter().filter(|w| w.tier.as_deref().is_none_or(|t| model.contains(&t.to_lowercase()))).collect();
    if windows.is_empty() {
        return Usage::Unknown;
    }
    let exhausted: Vec<_> = windows.iter().filter(|w| w.status == LimitStatus::Exhausted).collect();
    if exhausted.is_empty() {
        return Usage::Available;
    }
    Usage::Exhausted(exhausted.iter().filter_map(|w| w.resets_at).max())
}

/// [`Usage`] of `session_id`'s accounts of `provider` for `model`.
pub fn provider_usage(limits: &AccountLimits, session_id: &str, provider: &str, model: Option<&str>) -> Usage {
    let model = model.unwrap_or_default().to_lowercase();
    let pinned = limits.sessions.iter().find(|s| s.session_id == session_id && s.provider == provider).and_then(|s| s.account_key.as_deref());
    let accounts: Vec<_> = limits.accounts.iter().filter(|a| a.provider == provider && !a.disabled).collect();
    let mut own = Usage::Unknown;
    let mut elsewhere = false;
    let mut resets: Vec<Option<Millis>> = Vec::new();
    for a in &accounts {
        let u = account_usage(a, &model);
        let mine = pinned.map_or(accounts.len() == 1, |k| a.key == k);
        if mine {
            own = u;
        }
        match u {
            Usage::Available if !mine => elsewhere = true,
            Usage::Exhausted(reset) => resets.push(reset),
            _ => {}
        }
    }
    match own {
        Usage::Available => Usage::Available,
        _ if elsewhere => Usage::Elsewhere { own_out: matches!(own, Usage::Exhausted(_)) },
        _ if resets.is_empty() => Usage::Unknown,
        _ => Usage::Exhausted(resets.into_iter().flatten().min()),
    }
}

/// When a stopped agent resumes, and why: soon when another account has room (omp rotates to
/// it); an exhausted window's coming reset + margin (the earliest of all accounts'); else the
/// provider's retry-after + margin; else backoff step `step` (the ticket's attempts so far).
pub fn due(usage: Usage, retry_at: Option<Millis>, step: u32, now: Millis) -> (Millis, ResumeBasis) {
    match usage {
        Usage::Elsewhere { .. } => return (now + ROTATE_MS, ResumeBasis::Window),
        Usage::Exhausted(Some(reset)) if reset > now => return (reset + WINDOW_MARGIN_MS, ResumeBasis::Window),
        _ => {}
    }
    if let Some(at) = retry_at {
        return (at.max(now) + HINT_MARGIN_MS, ResumeBasis::Hint);
    }
    (now + BACKOFF_MS[(step as usize).min(BACKOFF_MS.len() - 1)], ResumeBasis::Backoff)
}

fn reason(kind: AutoResumeKind, e: &TurnError) -> String {
    let what = match kind {
        AutoResumeKind::UsageLimit => "Usage limit",
        AutoResumeKind::RateLimit => "Rate limit",
        AutoResumeKind::Overloaded => "Overloaded",
        _ => "Provider error",
    };
    let on = match (&e.provider, &e.model) {
        (Some(p), Some(m)) => format!(" ({p}/{m})"),
        (Some(p), None) => format!(" ({p})"),
        _ => String::new(),
    };
    let who = if e.main { String::new() } else { format!(", subagent {}", e.agent_id) };
    format!("{what}{on}{who}: {}", clip(e.message.trim(), 160))
}

/// Usage of the failing session's accounts (`refresh`: ask omp again now).
async fn usage_of(session_id: &str, provider: &str, model: Option<&str>, refresh: bool) -> Usage {
    match crate::ops::limits::limits_for(vec![(session_id.to_owned(), provider.to_owned())], refresh).await {
        Ok((limits, _)) => provider_usage(&limits, session_id, provider, model),
        Err(e) => {
            warn!("auto-resume: usage of {provider}: {}", e.message);
            Usage::Unknown
        }
    }
}

/// A terminal limit stop of the main agent or a subagent of root omp session `root_sid`: opens
/// or extends its ticket (the stopped agents, the latest due time, a usage limit over a rate limit;
/// a rate limit on an account that is out of usage is a usage limit).
pub async fn on_turn_error(ctx: &Ctx, root_sid: &str, e: &TurnError) {
    let (Some(kind), Some(r)) = (kind_of(e), crate::recovery::get()) else { return };
    let own_sid = e.session_id.clone().unwrap_or_else(|| root_sid.to_owned());
    // Usage windows tell when a limit passes; an overloaded or failing provider just gets backoff.
    let limit = is_limit(kind);
    let usage = match &e.provider {
        Some(p) if limit => usage_of(&own_sid, p, e.model.as_deref(), false).await,
        _ => Usage::Unknown,
    };
    let kind = if usage.out() { AutoResumeKind::UsageLimit } else { kind };
    let prev = r.ticket(&ctx.herdr_session, root_sid).filter(|t| t.kind != AutoResumeKind::Restart);
    let now = now_ms();
    // Resumed and stopped again soon after: wait at least a backoff step, growing per repeat.
    let streak = if prev.is_none() { restop_streak(root_sid, now) } else { 0 };
    let (mut at, mut basis) = due(usage, e.retry_at.filter(|_| limit), prev.as_ref().map_or(0, |t| t.attempts), now);
    if streak > 0 {
        let floor = now + BACKOFF_MS[(streak as usize - 1).min(BACKOFF_MS.len() - 1)];
        if floor > at {
            (at, basis) = (floor, ResumeBasis::Backoff);
        }
    }
    let mut subagent_ids = prev.as_ref().map(|t| t.subagent_ids.clone()).unwrap_or_default();
    if !e.main && !subagent_ids.contains(&e.agent_id) {
        subagent_ids.push(e.agent_id.clone());
    }
    let kind = match prev.as_ref() {
        Some(t) if rank(t.kind) > rank(kind) => t.kind,
        _ => kind,
    };
    let (resume_at, basis) = match prev.as_ref().and_then(|t| t.resume_at.zip(t.basis)) {
        Some((p, pb)) if p > at => (p, pb),
        _ => (at, basis),
    };
    let init = TicketInit {
        reason: reason(kind, e),
        session_file: ctx.bridge.by_session(root_sid).and_then(|b| b.session_file).or_else(|| e.main.then(|| e.session_file.clone()).flatten()),
        root: e.main || prev.as_ref().is_some_and(|t| t.root),
        subagent_ids,
        provider: e.provider.clone(),
        model: e.model.clone(),
        resume_at: Some(resume_at),
        basis: Some(basis),
    };
    info!(session = %root_sid, agent = %e.agent_id, ?kind, resume_at, ?basis, streak, "auto-resume: the provider stopped the turn");
    r.open(&ctx.herdr_session, kind, root_sid, init);
    if streak >= MAX_RESTOPS {
        r.hold(&ctx.herdr_session, root_sid, format!("Stopped again right after {streak} automatic resumes"));
    }
}

/// A due limit ticket: usage read afresh. `Some((at, basis))`: every account the session can go on
/// with is still out, resume then (at the earliest reset, else checking again 15, 30, then 60 min
/// apart as the ticket keeps waiting).
pub async fn still_exhausted(session_id: &str, ticket: &Ticket) -> Option<(Millis, ResumeBasis)> {
    if !is_limit(ticket.kind) {
        return None;
    }
    let provider = ticket.provider.as_deref()?;
    let now = now_ms();
    match usage_of(session_id, provider, ticket.model.as_deref(), true).await {
        u @ Usage::Exhausted(_) => Some(due(u, None, waited_step(ticket.since, now), now)),
        _ => None,
    }
}

/// The [`BACKOFF_MS`] step of a ticket that has waited since `since`: the checks of a window that
/// stays exhausted with no known reset come 15, 30, then 60 min apart.
fn waited_step(since: Millis, now: Millis) -> u32 {
    let mut edge = 0;
    let mut step = 0;
    for ms in &BACKOFF_MS[..BACKOFF_MS.len() - 1] {
        edge += ms;
        if now - since < edge {
            break;
        }
        step += 1;
    }
    step
}

/// Automatic resumes of one root session and the stops right after them.
#[derive(Debug, Clone, Copy)]
struct Restops {
    /// Resumes in a row that ran straight into a limit again.
    streak: u32,
    /// The last resume, until the next stop.
    resumed_at: Option<Millis>,
    touched: Millis,
}

static RESTOPS: LazyLock<Mutex<HashMap<String, Restops>>> = LazyLock::new(Default::default);
/// A stop this soon after an automatic resume ran straight into the limit again.
const RESTOP_WINDOW_MS: Millis = 30 * 60_000;
/// Sessions not resumed or stopped for this long are forgotten.
const RESTOPS_KEEP_MS: Millis = 12 * 3_600_000;

/// The limit ticket of root omp session `root_sid` resumed its agents (`crate::recovery`).
pub fn resumed(root_sid: &str, now: Millis) {
    let mut m = RESTOPS.lock().unwrap_or_else(|p| p.into_inner());
    m.retain(|_, r| now - r.touched < RESTOPS_KEEP_MS);
    let r = m.entry(root_sid.to_owned()).or_insert(Restops { streak: 0, resumed_at: None, touched: now });
    r.resumed_at = Some(now);
    r.touched = now;
}

/// A new limit ticket of `root_sid`: how many automatic resumes in a row ran straight into a limit
/// again, each stop within [`RESTOP_WINDOW_MS`] of its resume (0: the first stop in a while).
fn restop_streak(root_sid: &str, now: Millis) -> u32 {
    let mut m = RESTOPS.lock().unwrap_or_else(|p| p.into_inner());
    let Some(r) = m.get_mut(root_sid) else { return 0 };
    let again = r.resumed_at.take().is_some_and(|at| now - at < RESTOP_WINDOW_MS);
    r.streak = if again { r.streak + 1 } else { 0 };
    r.touched = now;
    r.streak
}

/// The agent's omp is gone: its card is parked (pane closed), or its process exited.
pub fn omp_gone(a: &Agent) -> bool {
    a.parked.is_some() || a.omp.as_ref().and_then(|o| o.pid).is_some_and(|pid| !process_alive(pid))
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) }
}

#[cfg(not(unix))]
fn process_alive(_pid: u32) -> bool {
    true
}

/// The user acted on the agent (a prompt, Stop, another model, a new session): its ticket goes.
pub fn intervened(ctx: &Ctx, agent_id: &str, what: &str) {
    let (Some(r), Some(sid)) = (crate::recovery::get(), ctx.state.omp_session_of(agent_id)) else { return };
    if r.close(&ctx.herdr_session, &sid, None) {
        info!(agent = agent_id, session = %sid, "auto-resume ticket closed: {what}");
    }
}

/// The board of `ctx` shows omp session `session_id`.
fn shows(ctx: &Ctx, session_id: &str) -> bool {
    ctx.state.snapshot().agents.iter().any(|a| a.omp.as_ref().and_then(|o| o.session_id.as_deref()) == Some(session_id))
}

/// Sessions reconciled since this daemon started: once each, so a ticket the user dismissed does
/// not come back with a reconnect.
static RECONCILED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

/// What stopped on a limit while hostd was away (`failedTails` of a 2.1.0 bridge), once the board
/// maps the session.
fn reconcile(ctx: Weak<Ctx>, session: BridgeSession) {
    if !session.caps.turn_error || !session.caps.resume_tree {
        return;
    }
    if !RECONCILED.lock().unwrap_or_else(|p| p.into_inner()).insert(session.session_id.clone()) {
        return;
    }
    tokio::spawn(async move {
        for _ in 0..MAP_WAITS {
            tokio::time::sleep(MAP_GRACE).await;
            let Some(ctx) = ctx.upgrade() else { return };
            if !shows(&ctx, &session.session_id) {
                continue;
            }
            let Ok(tails) = ctx.bridge.failed_tails(&session.session_id).await else { return };
            // A stop the user dismissed before hostd went away stays dismissed.
            let dismissed = crate::recovery::get().and_then(|r| r.dismissed_at(&session.session_id));
            let root_file = session.session_file.clone();
            let kept = tokio::task::spawn_blocking(move || {
                let kept: Vec<TurnError> = reconcilable(&tails, root_file.as_deref().map(Path::new), now_ms(), dismissed, went_on).into_iter().cloned().collect();
                let left = tails.tails.iter().filter(|t| t.stop_reason == "error" && kind_of(t).is_some()).count() - kept.len();
                (kept, left)
            })
            .await;
            let Ok((kept, left)) = kept else { return };
            if left > 0 {
                info!(session = %session.session_id, left, "auto-resume: limit stops found after the fact are left for Resume by hand (old, or their parent went on)");
            }
            for t in &kept {
                on_turn_error(&ctx, &session.session_id, t).await;
            }
            return;
        }
        // Another herdr session's board shows it: that context reconciles it.
        RECONCILED.lock().unwrap_or_else(|p| p.into_inner()).remove(&session.session_id);
    });
}

/// Which `failedTails` stops, found after the fact (a hostd restart or reconnect: not seen when
/// they happened), open a ticket. Conservative: a limit stop at most [`HISTORY_MAX_AGE_MS`] old and
/// newer than the user's dismissal of the session's ticket; a subagent's only while its parent and
/// the root still wait for it, each having stopped on a limit itself or done nothing since but take
/// the failure in ([`went_on`]: no prompt, no tool call). Old or overtaken stops are left for Resume
/// by hand (the session's Resume, the subagent viewer's Retry).
fn reconcilable<'a>(
    tails: &'a FailedTails,
    root_file: Option<&Path>,
    now: Millis,
    dismissed: Option<Millis>,
    went_on: impl Fn(&Path, Millis) -> bool,
) -> Vec<&'a TurnError> {
    let main = tails.main_id.as_deref();
    let fresh: Vec<&TurnError> = tails
        .tails
        .iter()
        .filter(|t| t.stop_reason == "error" && t.status.as_deref() != Some("retrying") && kind_of(t).is_some())
        .filter(|t| now - t.at <= HISTORY_MAX_AGE_MS && dismissed.is_none_or(|d| t.at > d))
        .collect();
    let stopped: HashSet<&str> = fresh.iter().filter_map(|t| if t.main { main } else { Some(t.agent_id.as_str()) }).collect();
    let waits = |id: Option<&str>, file: Option<&Path>, at: Millis| id.is_some_and(|i| stopped.contains(i)) || file.is_some_and(|f| !went_on(f, at));
    fresh
        .into_iter()
        .filter(|t| {
            if t.main {
                return true;
            }
            let parent = t.parent_id.as_deref().or(main);
            if parent == main {
                return waits(main, root_file, t.at);
            }
            let parent_file = t.session_file.as_deref().and_then(parent_transcript);
            waits(parent, parent_file.as_deref(), t.at) && waits(main, root_file, t.at)
        })
        .collect()
}

/// The transcript of a subagent's parent: omp keeps a child's next to its parent's, in the
/// directory named after it (`<parent>.jsonl`, `<parent>/<child>.jsonl`; the root's is the session).
fn parent_transcript(child: &str) -> Option<PathBuf> {
    let mut p = Path::new(child).parent()?.as_os_str().to_owned();
    p.push(".jsonl");
    Some(PathBuf::from(p))
}

/// The agent of omp transcript `file` went on after `at`: someone gave it a prompt (a user or
/// agent message, an IRC message) or it called a tool. Its own replies, results delivered to it
/// and its own failures are not going on. Reads the last [`AFTER_WINDOW`] bytes: a window that
/// starts after `at` went on (that much happened since); an unreadable file did too.
fn went_on(file: &Path, at: Millis) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(file) else { return true };
    let start = f.metadata().map_or(0, |m| m.len()).saturating_sub(AFTER_WINDOW);
    let mut buf = Vec::new();
    if f.seek(SeekFrom::Start(start)).and_then(|_| f.read_to_end(&mut buf)).is_err() {
        return true;
    }
    let text = String::from_utf8_lossy(&buf);
    let mut earliest: Option<Millis> = None;
    // A window that starts mid-file starts mid-line.
    for line in text.lines().skip(usize::from(start > 0)) {
        let Ok(e) = serde_json::from_str::<Value>(line) else { continue };
        let Some(t) = entry_time(&e) else { continue };
        earliest = Some(earliest.map_or(t, |x| x.min(t)));
        if t <= at {
            continue;
        }
        let prompt = match e.get("type").and_then(Value::as_str) {
            Some("message") => {
                let m = &e["message"];
                match m.get("role").and_then(Value::as_str) {
                    Some("user" | "developer") => true,
                    Some("assistant") => m.get("content").and_then(Value::as_array).is_some_and(|c| c.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("toolCall"))),
                    _ => false,
                }
            }
            Some("custom_message") => e.get("customType").and_then(Value::as_str).is_some_and(|c| c.starts_with("irc")),
            _ => false,
        };
        if prompt {
            return true;
        }
    }
    start > 0 && earliest.is_none_or(|t| t > at)
}

/// When a transcript entry happened: its message's own time, else the entry's.
fn entry_time(e: &Value) -> Option<Millis> {
    e.get("message")
        .and_then(|m| m.get("timestamp"))
        .and_then(Value::as_i64)
        .or_else(|| e.get("timestamp").and_then(Value::as_str).and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).map(|d| d.timestamp_millis()))
}

/// Follows the bridges for the board of `ctx` (`Ctx::create`): limit stops of its sessions open
/// tickets; sessions that (re)connect, and those already connected, are reconciled.
pub fn follow(ctx: &Arc<Ctx>) {
    let weak = Arc::downgrade(ctx);
    let mut events = ctx.bridge.subscribe();
    let cancel = ctx.cancel.clone();
    let connected = ctx.bridge.sessions();
    tokio::spawn(async move {
        for s in connected {
            reconcile(weak.clone(), s);
        }
        loop {
            let ev = tokio::select! {
                _ = cancel.cancelled() => return,
                ev = events.recv() => ev,
            };
            match ev {
                Ok(BridgeEvent::Connected { session } | BridgeEvent::SessionSwitch { session, .. }) => reconcile(weak.clone(), session),
                Ok(BridgeEvent::TurnError { session_id, error }) => {
                    let Some(ctx) = weak.upgrade() else { return };
                    tokio::spawn(async move {
                        if shows(&ctx, &session_id) {
                            on_turn_error(&ctx, &session_id, &error).await;
                        }
                    });
                }
                Err(broadcast::error::RecvError::Closed) => return,
                _ => {}
            }
        }
    });
}

/// The daemon's part (`daemon::async_main`): every 2.1.0 bridge learns whether its `context` guard
/// is on when it says hello and whenever the host setting changes; a limit stop reported before any
/// board was built (no app connected since hostd started) brings up the contexts of the herdr
/// sessions this host knows, whose [`follow`] then reconciles it.
pub fn start(daemon: &Arc<Daemon>) {
    let weak = Arc::downgrade(daemon);
    let bridge = daemon.bridge.clone();
    let shutdown = daemon.shutdown.clone();
    let mut events = bridge.subscribe();
    let mut setting = crate::recovery::get().map(|r| r.subscribe());
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => return,
                changed = async {
                    match setting.as_mut() {
                        Some(rx) => rx.changed().await.is_ok(),
                        None => std::future::pending().await,
                    }
                } => {
                    let Some(on) = setting.as_mut().filter(|_| changed).map(|rx| *rx.borrow_and_update()) else {
                        setting = None;
                        continue;
                    };
                    for s in bridge.sessions().into_iter().filter(|s| s.caps.limit_guard) {
                        push_guard(&bridge, s.session_id, on);
                    }
                }
                ev = events.recv() => match ev {
                    Ok(BridgeEvent::Connected { session } | BridgeEvent::SessionSwitch { session, .. }) if session.caps.limit_guard => {
                        push_guard(&bridge, session.session_id, crate::recovery::get().is_some_and(|r| r.enabled()));
                    }
                    Ok(BridgeEvent::TurnError { .. }) => {
                        let Some(d) = weak.upgrade() else { return };
                        let known: Vec<String> = d.persist.read(|p| p.sessions.keys().cloned().collect());
                        tokio::spawn(async move {
                            for name in known {
                                if let Err(e) = d.ctx_for(&name).await {
                                    warn!(session = %name, "auto-resume: herdr session not available: {}", e.message);
                                }
                            }
                        });
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                    _ => {}
                },
            }
        }
    });
}

fn push_guard(bridge: &BridgeHandle, session_id: String, on: bool) {
    let bridge = bridge.clone();
    tokio::spawn(async move {
        if let Err(e) = bridge.set_auto_resume(&session_id, on).await {
            warn!(session = %session_id, "auto-resume: setAutoResume: {e:?}");
        }
    });
}

/// `agent.retry`: omp's F5. A subagent needs bridge 2.1.0 (`resumeTree`); the agent with a ticket
/// resumes its whole tree (= `agent.autoResumeNow`); else [`f5`].
pub async fn retry(ctx: &Ctx, agent_id: &str, subagent_id: Option<&str>) -> Result<RetryResult, ApiError> {
    let a = ctx.state.agent(agent_id).ok_or_else(|| ApiError::new("not_found", format!("no agent `{agent_id}`")))?;
    if a.kind != "omp" {
        return Err(ApiError::new("unsupported", format!("`{}` is a {} agent; use the terminal", a.name, a.kind)));
    }
    let sid = ctx.state.omp_session_of(agent_id).or_else(|| a.omp.as_ref().and_then(|o| o.session_id.clone()));
    let bridge = sid.as_deref().and_then(|s| ctx.bridge.by_session(s)).or_else(|| a.omp.as_ref().and_then(|o| o.pid).and_then(|p| ctx.bridge.by_pid(p)));
    if let Some(sub) = subagent_id {
        let b = bridge.filter(|b| b.caps.resume_tree).ok_or_else(|| {
            ApiError::new("unsupported", "retrying a subagent needs TeleFlock's bridge 2.1.0 in this omp")
                .with_hint("Restart the agent (Mark done, then Resume) so it loads the current bridge")
        })?;
        let started = ctx.bridge.retry(&b.session_id, Some(sub)).await.map_err(ApiError::from)?;
        return Ok(RetryResult { started, via: RetryVia::Retry });
    }
    if let (Some(r), Some(s)) = (crate::recovery::get(), sid.as_deref())
        && r.ticket(&ctx.herdr_session, s).is_some()
    {
        return crate::recovery::resume_now(ctx, agent_id).await;
    }
    if a.parked.is_some() {
        return Err(ApiError::new("parked", format!("{} is done and its pane is closed", a.name)).with_hint("Resume it first"));
    }
    f5(ctx, agent_id, bridge.as_ref()).await
}

/// omp's F5 for the agent itself: omp's own retry through its 2.1.0 bridge, else `/retry` through
/// the bridge's composer (TUI), else `/retry` typed into the pane while omp is idle.
pub async fn f5(ctx: &Ctx, agent_id: &str, bridge: Option<&BridgeSession>) -> Result<RetryResult, ApiError> {
    if let Some(b) = bridge {
        if b.caps.retry {
            let started = ctx.bridge.retry(&b.session_id, None).await.map_err(ApiError::from)?;
            return Ok(RetryResult { started, via: RetryVia::Retry });
        }
        if b.tui {
            ctx.bridge.slash(&b.session_id, "/retry").await.map_err(ApiError::from)?;
            return Ok(RetryResult { started: true, via: RetryVia::Command });
        }
    }
    inject::slash(ctx, agent_id, "/retry", When::IdleOnly).await?;
    Ok(RetryResult { started: true, via: RetryVia::Command })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tf_proto::{LimitAccount, LimitSession, LimitWindow};

    fn window(id: &str, tier: Option<&str>, status: LimitStatus, resets_at: Option<Millis>) -> LimitWindow {
        LimitWindow {
            id: id.into(),
            label: id.into(),
            window: None,
            tier: tier.map(str::to_string),
            duration_ms: Some(5 * 3_600_000),
            resets_at,
            status,
            used: Some(if status == LimitStatus::Exhausted { 1.0 } else { 0.4 }),
            amount: None,
            limit: None,
            unit: "percent".into(),
            notes: vec![],
            samples: vec![],
        }
    }

    fn account(key: &str, provider: &str, windows: Vec<LimitWindow>) -> LimitAccount {
        LimitAccount {
            key: key.into(),
            provider: provider.into(),
            label: key.into(),
            org: None,
            plan: None,
            fetched_at: Some(1),
            resets_available: None,
            notes: vec![],
            error: None,
            disabled: false,
            windows,
        }
    }

    fn limits(accounts: Vec<LimitAccount>, sessions: Vec<LimitSession>) -> AccountLimits {
        AccountLimits { fetched_at: 1, accounts, sessions, error: None }
    }

    #[test]
    fn usage_follows_the_pinned_account_the_model_tier_and_the_other_accounts() {
        let a = account("anthropic|email:a", "anthropic", vec![window("5h", None, LimitStatus::Exhausted, Some(9_000)), window("opus", Some("opus"), LimitStatus::Exhausted, Some(20_000))]);
        let b = account("anthropic|email:b", "anthropic", vec![window("5h", None, LimitStatus::Ok, Some(9_000))]);
        let pinned = vec![LimitSession { session_id: "s1".into(), provider: "anthropic".into(), account_key: Some("anthropic|email:a".into()) }];
        // The opus window meters opus models only; the shared one meters every model.
        let only_a = limits(vec![a.clone()], pinned.clone());
        assert_eq!(provider_usage(&only_a, "s1", "anthropic", Some("claude-opus-5")), Usage::Exhausted(Some(20_000)));
        assert_eq!(provider_usage(&only_a, "s1", "anthropic", Some("claude-sonnet-5")), Usage::Exhausted(Some(9_000)));
        // Another account has room: omp rotates to it.
        let both = limits(vec![a.clone(), b.clone()], pinned.clone());
        assert_eq!(provider_usage(&both, "s1", "anthropic", Some("claude-opus-5")), Usage::Elsewhere { own_out: true });
        assert_eq!(provider_usage(&both, "s2", "anthropic", None), Usage::Elsewhere { own_out: false }, "no pin: own unknown");
        let mut off = b.clone();
        off.disabled = true;
        assert_eq!(provider_usage(&limits(vec![a.clone(), off], pinned), "s1", "anthropic", None), Usage::Exhausted(Some(9_000)), "a disabled account is not one omp rotates to");
        // One account: that one; nothing reported: unknown.
        assert_eq!(provider_usage(&limits(vec![b], vec![]), "s2", "anthropic", None), Usage::Available);
        assert_eq!(provider_usage(&limits(vec![a], vec![]), "s2", "openai", None), Usage::Unknown);
        assert_eq!(provider_usage(&limits(vec![account("x|#0", "x", vec![])], vec![]), "s", "x", None), Usage::Unknown);
    }

    #[test]
    fn four_subscription_accounts_one_with_room_resume_soon_else_the_earliest_reset() {
        // The 0.7.0 outage: Anthropic `rate_limit_error` (omp: a rate limit) with a 91 h retry-after
        // from an account whose 7-day window was at 100 %.
        let now = 1_000_000_000;
        let h = 3_600_000;
        let five = |status, reset| window("5h", None, status, Some(reset));
        let week = |status, reset| window("7d", None, status, Some(reset));
        let a = account("anthropic|a", "anthropic", vec![five(LimitStatus::Exhausted, now + 127 * 60_000), week(LimitStatus::Ok, now + 100 * h)]);
        let b = account("anthropic|b", "anthropic", vec![five(LimitStatus::Ok, now + h), week(LimitStatus::Exhausted, now + 81 * h)]);
        let c = account("anthropic|c", "anthropic", vec![five(LimitStatus::Ok, now + h), week(LimitStatus::Exhausted, now + 91 * h)]);
        let d = account("anthropic|d", "anthropic", vec![five(LimitStatus::Ok, now + 4 * h), week(LimitStatus::Ok, now + 50 * h)]);
        let pin = vec![LimitSession { session_id: "s".into(), provider: "anthropic".into(), account_key: Some("anthropic|c".into()) }];
        let all = limits(vec![a.clone(), b.clone(), c.clone(), d], pin.clone());
        let u = provider_usage(&all, "s", "anthropic", Some("claude-opus-5"));
        assert_eq!(u, Usage::Elsewhere { own_out: true });
        assert!(u.out(), "a rate limit on an account out of usage is a usage limit");
        assert_eq!(due(u, Some(now + 91 * h), 0, now), (now + ROTATE_MS, ResumeBasis::Window), "not the failed account's 91 h");
        // No account has room: the earliest reset among them.
        let none = limits(vec![a, b, c], pin);
        let u = provider_usage(&none, "s", "anthropic", Some("claude-opus-5"));
        assert_eq!(u, Usage::Exhausted(Some(now + 127 * 60_000)));
        assert_eq!(due(u, Some(now + 91 * h), 0, now), (now + 127 * 60_000 + WINDOW_MARGIN_MS, ResumeBasis::Window));
        assert!(!Usage::Available.out() && !Usage::Unknown.out() && !Usage::Elsewhere { own_out: false }.out());
    }

    #[test]
    fn due_prefers_the_window_reset_then_the_hint_then_backoff() {
        let now = 1_000_000;
        assert_eq!(due(Usage::Exhausted(Some(now + 3_600_000)), Some(now + 60_000), 0, now), (now + 3_600_000 + WINDOW_MARGIN_MS, ResumeBasis::Window));
        // A reset the report still shows as passed: not a window to wait for.
        assert_eq!(due(Usage::Exhausted(Some(now - 1)), Some(now + 60_000), 0, now), (now + 60_000 + HINT_MARGIN_MS, ResumeBasis::Hint));
        assert_eq!(due(Usage::Available, Some(now - 5_000), 0, now), (now + HINT_MARGIN_MS, ResumeBasis::Hint));
        assert_eq!(due(Usage::Elsewhere { own_out: false }, None, 3, now), (now + ROTATE_MS, ResumeBasis::Window));
        assert_eq!(due(Usage::Unknown, None, 0, now), (now + 15 * 60_000, ResumeBasis::Backoff));
        assert_eq!(due(Usage::Exhausted(None), None, 1, now), (now + 30 * 60_000, ResumeBasis::Backoff));
        assert_eq!(due(Usage::Unknown, None, 7, now), (now + 60 * 60_000, ResumeBasis::Backoff));
        // A window that stays exhausted with no known reset: checked 15, 30, then 60 min apart.
        let checks: Vec<u32> = [0, 14, 15, 44, 45, 300].iter().map(|m| waited_step(now, now + m * 60_000)).collect();
        assert_eq!(checks, vec![0, 0, 1, 1, 2, 2]);
    }

    #[test]
    fn turn_errors_parse_and_classify() {
        let e: TurnError = serde_json::from_value(serde_json::json!({
            "agentId": "explore", "parentId": "Main", "main": false, "sessionId": "sub-1", "sessionFile": "/s/explore.jsonl",
            "stopReason": "error", "kind": "usageLimit", "reason": "QUOTA_EXHAUSTED", "provider": "mocklab", "model": "mock-1",
            "errorStatus": 429, "message": "429 You have hit your usage limit. Try again in 2 minutes.", "retryAt": 121000, "at": 1000,
            "unknownLater": true
        }))
        .unwrap();
        assert_eq!(kind_of(&e), Some(AutoResumeKind::UsageLimit));
        assert_eq!((e.retry_at, e.error_status, e.main), (Some(121_000), Some(429), false));
        assert_eq!(reason(AutoResumeKind::UsageLimit, &e), "Usage limit (mocklab/mock-1), subagent explore: 429 You have hit your usage limit. Try again in 2 minutes.");
        assert_eq!(kind_of(&TurnError { kind: "other".into(), ..e.clone() }), None);
        assert_eq!(kind_of(&TurnError { kind: "rateLimit".into(), ..e }), Some(AutoResumeKind::RateLimit));
    }

    #[test]
    fn a_resume_that_runs_straight_into_the_limit_again_counts() {
        let sid = "restop-test-session";
        let t = 1_000_000_000;
        assert_eq!(restop_streak(sid, t), 0, "never resumed");
        resumed(sid, t);
        assert_eq!(restop_streak(sid, t + 60_000), 1);
        assert_eq!(restop_streak(sid, t + 120_000), 0, "a stop with no resume in between is a new stop");
        resumed(sid, t + 200_000);
        assert_eq!(restop_streak(sid, t + 201_000), 1);
        resumed(sid, t + 300_000);
        assert_eq!(restop_streak(sid, t + 301_000), 2);
        resumed(sid, t + 400_000);
        assert_eq!(restop_streak(sid, t + 400_000 + RESTOP_WINDOW_MS), 0, "a resume that worked for a while starts over");
    }

    #[test]
    fn omp_is_gone_with_its_pane_or_process() {
        let mut a = crate::state::parked::parked_agent(&crate::state::persist::ParkedRecord {
            agent_id: "a".into(),
            kind: "omp".into(),
            session_file: "/s/a.jsonl".into(),
            ..Default::default()
        });
        assert!(omp_gone(&a), "parked: its pane closed");
        a.parked = None;
        a.omp.as_mut().unwrap().pid = Some(std::process::id());
        assert!(!omp_gone(&a));
        a.omp.as_mut().unwrap().pid = None;
        assert!(!omp_gone(&a), "no pid known: not judged gone");
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        a.omp.as_mut().unwrap().pid = Some(pid);
        assert!(omp_gone(&a));
    }

    #[test]
    fn overloads_and_server_errors_are_their_own_kinds() {
        let e = TurnError { main: true, stop_reason: "error".into(), kind: "rateLimit".into(), error_status: Some(429), message: "429 rate_limit_error".into(), ..Default::default() };
        let with = |status: Option<u16>, message: &str| kind_of(&TurnError { error_status: status, message: message.into(), ..e.clone() });
        assert_eq!(with(Some(429), "429 rate_limit_error"), Some(AutoResumeKind::RateLimit));
        assert_eq!(with(Some(529), r#"529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#), Some(AutoResumeKind::Overloaded));
        assert_eq!(with(Some(503), "503 Service Unavailable"), Some(AutoResumeKind::Overloaded));
        assert_eq!(with(Some(500), "500 The server is overloaded"), Some(AutoResumeKind::Overloaded));
        assert_eq!(with(Some(502), "502 Bad Gateway"), Some(AutoResumeKind::ProviderError));
        assert_eq!(with(None, "provider overloaded, try later"), Some(AutoResumeKind::Overloaded));
        assert_eq!(kind_of(&TurnError { kind: "usageLimit".into(), ..e.clone() }), Some(AutoResumeKind::UsageLimit));
        assert_eq!(kind_of(&TurnError { kind: "other".into(), error_status: Some(503), ..e.clone() }), None, "omp did not call it passing");
        // Words and checks follow the kind: usage windows only for limits.
        assert!(reason(AutoResumeKind::Overloaded, &e).starts_with("Overloaded: "));
        assert!(reason(AutoResumeKind::ProviderError, &e).starts_with("Provider error: "));
        assert!(is_limit(AutoResumeKind::RateLimit) && !is_limit(AutoResumeKind::Overloaded) && !is_limit(AutoResumeKind::ProviderError));
        let order = [AutoResumeKind::ProviderError, AutoResumeKind::Overloaded, AutoResumeKind::RateLimit, AutoResumeKind::UsageLimit];
        assert!(order.windows(2).all(|w| rank(w[0]) < rank(w[1])));
    }

    fn at_of(iso: &str) -> Millis {
        chrono::DateTime::parse_from_rfc3339(iso).unwrap().timestamp_millis()
    }

    fn tail(agent: &str, parent: Option<&str>, main: bool, file: &Path, at: Millis) -> TurnError {
        TurnError {
            agent_id: agent.into(),
            parent_id: parent.map(str::to_string),
            main,
            session_file: Some(file.display().to_string()),
            stop_reason: "error".into(),
            kind: "rateLimit".into(),
            error_status: Some(429),
            at,
            ..Default::default()
        }
    }

    fn ids(kept: Vec<&TurnError>) -> Vec<String> {
        kept.into_iter().map(|t| t.agent_id.clone()).collect()
    }

    /// Trimmed real entries of the `resume` lab's root session (omp 18.13.3, mock usage-limit 429):
    /// it spawned Pineapple, replied, got Pineapple's failed result (Pineapple failed at
    /// 15:50:32.760) and stopped on the limit itself. No message times: the entries' are read.
    const LAB_ROOT: &str = r#"{"type":"session","version":3,"id":"01a1885b-08db-70ca-8bf3-36b1926d073c","timestamp":"2026-10-29T15:50:29.851Z"}
{"type":"message","id":"cbf03ed8","timestamp":"2026-10-29T15:50:32.305Z","message":{"role":"user","content":[{"type":"text"}]}}
{"type":"message","id":"e2b6cb75","parentId":"e3fad669","timestamp":"2026-10-29T15:50:32.522Z","message":{"role":"assistant","stopReason":"toolUse","content":[{"type":"toolCall","name":"task"}]}}
{"type":"message","id":"53749df9","parentId":"ac1cb6a9","timestamp":"2026-10-29T15:50:32.554Z","message":{"role":"toolResult","toolName":"task","content":[{"type":"text"}]}}
{"type":"message","id":"58e1f0f9","parentId":"53cb2d52","timestamp":"2026-10-29T15:50:32.858Z","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text"}]}}
{"type":"custom_message","id":"fa1ec4dd","parentId":"58e1f0f9","timestamp":"2026-10-29T15:50:32.874Z","customType":"async-result"}
{"type":"message","id":"28d5ec69","parentId":"fa1ec4dd","timestamp":"2026-10-29T15:50:32.934Z","message":{"role":"assistant","stopReason":"error","errorMessage":"429 You have hit your usage limit. Try again in 2 minutes.","content":[]}}
"#;

    #[test]
    fn going_on_is_a_prompt_or_a_tool_call_after_the_stop() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root.jsonl");
        std::fs::write(&root, LAB_ROOT).unwrap();
        let failed = at_of("2026-10-29T15:50:32.760Z");
        assert!(!went_on(&root, failed), "its reply, the delivered result and its own failure are not going on");
        assert!(went_on(&root, at_of("2026-10-29T15:50:32.000Z")), "the task call after it is");
        let irc = format!("{LAB_ROOT}{}\n", r#"{"type":"custom_message","id":"c1","timestamp":"2026-10-29T16:36:26.711Z","customType":"irc:incoming"}"#);
        std::fs::write(&root, irc).unwrap();
        assert!(went_on(&root, failed), "an IRC message to it");
        let prompt = format!("{LAB_ROOT}{}\n", r#"{"type":"message","id":"u2","timestamp":"2026-10-29T16:10:00.000Z","message":{"role":"user","content":[{"type":"text"}]}}"#);
        std::fs::write(&root, prompt).unwrap();
        assert!(went_on(&root, failed), "a prompt");
        assert!(went_on(&dir.path().join("missing.jsonl"), failed), "unreadable: went on");
        // More than the window happened since: went on.
        let pad = "x".repeat(1000);
        let big: String = (0..1200).map(|i| format!("{{\"type\":\"custom\",\"timestamp\":\"2026-10-29T16:{:02}:00.000Z\",\"data\":\"{pad}\"}}\n", i % 60)).collect();
        let file = dir.path().join("big.jsonl");
        std::fs::write(&file, format!("{LAB_ROOT}{big}")).unwrap();
        assert!(went_on(&file, failed));
    }

    #[test]
    fn after_a_restart_a_subagent_resumes_only_while_its_parent_waits() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root.jsonl");
        std::fs::write(&root, LAB_ROOT).unwrap();
        let sub_file = dir.path().join("root/Pineapple.jsonl");
        let (sub_at, root_at) = (at_of("2026-10-29T15:50:32.760Z"), at_of("2026-10-29T15:50:32.934Z"));
        let both = FailedTails {
            main_id: Some("Main".into()),
            tails: vec![tail("Main", None, true, &root, root_at), tail("Pineapple", Some("Main"), false, &sub_file, sub_at)],
        };
        let now = root_at + 120_000;
        assert_eq!(ids(reconcilable(&both, Some(&root), now, None, went_on)), ["Main", "Pineapple"], "the root stopped on the limit too");
        // The root only replied and got the failed result (its own turn did not fail): it waits.
        let waiting = FailedTails { main_id: both.main_id.clone(), tails: vec![both.tails[1].clone()] };
        assert_eq!(ids(reconcilable(&waiting, Some(&root), now, None, went_on)), ["Pineapple"]);
        // Old, dismissed since, still in omp's retries, or not a limit: nothing automatic.
        assert!(reconcilable(&both, Some(&root), root_at + HISTORY_MAX_AGE_MS + 1, None, went_on).is_empty());
        assert!(reconcilable(&both, Some(&root), now, Some(root_at), went_on).is_empty());
        let retrying = FailedTails { main_id: both.main_id.clone(), tails: vec![TurnError { status: Some("retrying".into()), ..both.tails[0].clone() }] };
        assert!(reconcilable(&retrying, Some(&root), now, None, went_on).is_empty());
        let other = FailedTails { main_id: both.main_id.clone(), tails: vec![TurnError { kind: "other".into(), ..both.tails[0].clone() }] };
        assert!(reconcilable(&other, Some(&root), now, None, went_on).is_empty());
        // Someone prompted the root since (it went on): the old stop is left for Resume by hand.
        let prompted = format!("{LAB_ROOT}{}\n", r#"{"type":"message","id":"u2","timestamp":"2026-10-29T16:10:00.000Z","message":{"role":"user","content":[{"type":"text"}]}}"#);
        std::fs::write(&root, prompted).unwrap();
        assert!(reconcilable(&waiting, Some(&root), now, None, went_on).is_empty());
        assert!(reconcilable(&waiting, None, now, None, went_on).is_empty(), "no root transcript: no ticket");
    }

    #[test]
    fn a_nested_subagent_whose_parent_went_on_is_left_alone() {
        // Trimmed real entries from a copy of a real session: AutoAnswerC.AALaunch stopped on
        // Anthropic's rate_limit_error (429) at 15:54:37; its parent AutoAnswerC got the failed
        // result, stopped on the limit itself at 15:55:31, was continued at 16:36 (IRC) and finished.
        let data = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/testdata/resume/aalaunch");
        let (parent, child) = (data.join("AutoAnswerC.jsonl"), data.join("AutoAnswerC/AutoAnswerC.AALaunch.jsonl"));
        assert_eq!(parent_transcript(&child.display().to_string()), Some(parent.clone()));
        let child_at = 1_793_289_227_657; // its failed message
        let lines = std::fs::read_to_string(&parent).unwrap();
        let parent_at = lines
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|e| e["message"]["stopReason"] == "error")
            .filter_map(|e| entry_time(&e))
            .find(|t| *t > child_at)
            .unwrap();
        // The root (not in the fixture): idle since it spawned AutoAnswerC.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root.jsonl");
        std::fs::write(&root, r#"{"type":"message","id":"r1","timestamp":"2026-10-29T15:20:00.000Z","message":{"role":"assistant","stopReason":"toolUse","content":[{"type":"toolCall","name":"task"}]}}"#).unwrap();
        // 80 minutes later (when a lab revived the copy): the parent went on.
        let late = FailedTails { main_id: Some("Main".into()), tails: vec![tail("AutoAnswerC.AALaunch", Some("AutoAnswerC"), false, &child, child_at)] };
        assert!(went_on(&parent, child_at));
        assert!(reconcilable(&late, Some(&root), child_at + 80 * 60_000, None, went_on).is_empty());
        // At 15:58 (the parent's transcript up to then) the parent waited, stopped on the limit itself.
        let cut = dir.path().join("cut");
        std::fs::create_dir_all(cut.join("AutoAnswerC")).unwrap();
        let before: String = lines.lines().take_while(|l| !l.contains("irc:incoming")).map(|l| format!("{l}\n")).collect();
        std::fs::write(cut.join("AutoAnswerC.jsonl"), before).unwrap();
        std::fs::copy(&child, cut.join("AutoAnswerC/AutoAnswerC.AALaunch.jsonl")).unwrap();
        let early = FailedTails {
            main_id: Some("Main".into()),
            tails: vec![
                tail("AutoAnswerC", Some("Main"), false, &cut.join("AutoAnswerC.jsonl"), parent_at),
                tail("AutoAnswerC.AALaunch", Some("AutoAnswerC"), false, &cut.join("AutoAnswerC/AutoAnswerC.AALaunch.jsonl"), child_at),
            ],
        };
        assert_eq!(ids(reconcilable(&early, Some(&root), at_of("2026-10-29T15:58:00Z"), None, went_on)), ["AutoAnswerC", "AutoAnswerC.AALaunch"]);
    }
}
