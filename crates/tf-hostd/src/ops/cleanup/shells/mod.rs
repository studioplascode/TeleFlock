//! Idle shells (architecture §3.17 "Idle shells"): herdr panes whose shell waits at its prompt in
//! a workspace without an agent, shown nowhere, with no input or output for a while (`rules`).
//!
//! One janitor per herdr session checks every minute, the first time 2 minutes after the daemon
//! started (apps re-attach their terminals meanwhile) and again 2 minutes after the host woke from
//! sleep, whose time is no idle time ([`Sleeps`]), and publishes what it finds as
//! `HostInfo.idleShells`. While the host's setting says so (`store`; default: on, after 24 h) it
//! closes them itself, whether or not an app is connected: one Activity entry per shell
//! (`shellClosed`), one notification per check. `cleanup.idleShellsClose` closes shells someone
//! picked, `cleanup.idleShellsSet` saves the settings. Every close checks its shell again right
//! before, against herdr's own view of the pane and fresh process facts, and herdr closes a
//! workspace with its last pane.

pub mod probe;
pub mod rules;
pub mod store;

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::{Hash, Hasher};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tf_herdr::{ReadOptions, ReadSource};
use tf_proto::model::ActivityKind;
use tf_proto::{
    ApiError, IdleShell, IdleShellKept, IdleShellRef, IdleShells, IdleShellsCloseParams, IdleShellsCloseResult, IdleShellsClosed, IdleShellsSetParams,
    HostPage, Millis, Notification, NotifyAction, NotifyKind,
};
use tokio::sync::Notify;
use tracing::{debug, info};

use self::rules::{Keep, PaneFacts, WorkspaceFacts};
use self::store::Settings;
use crate::ops::{Ctx, herdr_err};
use crate::util::{new_id, now_ms};

/// How often a session's shells are checked.
const CHECK_EVERY: Duration = Duration::from_secs(60);
/// The first check after the daemon started or the host woke: apps re-attach their terminals
/// meanwhile.
const FIRST_CHECK: Duration = Duration::from_secs(120);
/// Sleeps the janitor remembers (a laptop that sleeps ten times a day: a month and a half).
const SLEEPS_KEPT: usize = 512;
/// Lines of a pane's screen and scrollback compared to see it change, where the terminal's
/// times can't be read.
const WATCH_LINES: u32 = 200;

/// A screen hostd watches for changes: unchanged since `since`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Watched {
    terminal_id: String,
    hash: u64,
    since: Millis,
}

/// One herdr session's janitor, shared by its loop and the methods.
#[derive(Default)]
struct Janitor {
    watched: Mutex<HashMap<String, Watched>>,
    /// What was published last.
    listed: Mutex<Vec<IdleShell>>,
    last_closed: Mutex<Option<IdleShellsClosed>>,
    /// One close (by itself or asked for) at a time.
    closing: tokio::sync::Mutex<()>,
    /// Check now.
    poke: Notify,
    sleeps: Mutex<Sleeps>,
}

/// When the host slept, as the janitor tells: between two looks the wall clock ran ahead of the
/// monotonic clock (which stands still while the host sleeps, on Linux and macOS) by more than
/// [`CHECK_EVERY`]. Sleeps before the daemon started can't be told.
#[derive(Debug, Default)]
struct Sleeps {
    /// The last look: wall clock, monotonic clock.
    last: Option<(Millis, Instant)>,
    /// When it slept (wall clock, from, to), oldest first; at most [`SLEEPS_KEPT`].
    slept: VecDeque<(Millis, Millis)>,
}

impl Sleeps {
    /// Looks at the clocks: true when the host slept since the last look.
    fn look(&mut self, wall: Millis, mono: Instant) -> bool {
        let Some((wall0, mono0)) = self.last.replace((wall, mono)) else { return false };
        let awake = Millis::try_from(mono.saturating_duration_since(mono0).as_millis()).unwrap_or(Millis::MAX);
        let slept = (wall - wall0).saturating_sub(awake);
        if slept <= CHECK_EVERY.as_millis() as Millis {
            return false;
        }
        // Where in the gap it slept is not known: at its end takes the most off a shell used in it.
        self.slept.push_back((wall - slept, wall));
        if self.slept.len() > SLEEPS_KEPT {
            self.slept.pop_front();
        }
        true
    }

    /// `since` moved past the time the host slept between it and `now`: idle time is time awake.
    fn awake_since(&self, since: Millis, now: Millis) -> Millis {
        since + self.slept.iter().map(|&(from, to)| (to.min(now) - from.max(since)).max(0)).sum::<Millis>()
    }
}

static JANITORS: LazyLock<Mutex<HashMap<String, Arc<Janitor>>>> = LazyLock::new(Default::default);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn janitor(session: &str) -> Arc<Janitor> {
    lock(&JANITORS).entry(session.to_string()).or_default().clone()
}

/// Starts the session's janitor (`Ctx::create`).
pub fn start(ctx: &Arc<Ctx>) {
    tokio::spawn(run(ctx.arc()));
}

async fn run(ctx: Arc<Ctx>) {
    let j = janitor(&ctx.herdr_session);
    let mut settings = store::subscribe(&ctx.paths.home);
    let first = settings.borrow_and_update().clone();
    publish(&ctx, &j, &first, Vec::new());
    lock(&j.sleeps).look(now_ms(), Instant::now());
    // Apps re-attach their terminals before the first check: after the daemon started, and after
    // the host slept (their links dropped meanwhile).
    let mut wait = true;
    loop {
        if wait {
            tokio::select! {
                _ = ctx.cancel.cancelled() => return,
                _ = tokio::time::sleep(FIRST_CHECK) => {}
            }
        }
        wait = lock(&j.sleeps).look(now_ms(), Instant::now());
        if wait {
            info!(session = %ctx.herdr_session, "the host slept: idle shells wait for apps to re-attach");
            continue;
        }
        let s = settings.borrow_and_update().clone();
        check(&ctx, &j, &s).await;
        tokio::select! {
            _ = ctx.cancel.cancelled() => return,
            _ = tokio::time::sleep(CHECK_EVERY) => {}
            _ = settings.changed() => {}
            _ = j.poke.notified() => {}
        }
    }
}

/// One check: finds the idle shells, closes them while `auto` is on, publishes the rest.
async fn check(ctx: &Ctx, j: &Janitor, s: &Settings) {
    let mut shells = find(ctx, j, s.minutes).await;
    if s.auto && !shells.is_empty() {
        let refs: Vec<IdleShellRef> = shells.iter().map(|x| IdleShellRef { pane_id: x.pane_id.clone(), terminal_id: x.terminal_id.clone() }).collect();
        let (closed, kept) = close(ctx, j, &refs, How::Auto { minutes: s.minutes }).await;
        for k in &kept {
            debug!(session = %ctx.herdr_session, pane = %k.pane_id, "idle shell kept: {}", k.error.message);
        }
        if !closed.is_empty() {
            summarize(ctx, j, &closed, s.minutes);
            shells.retain(|x| !closed.iter().any(|c| c.pane_id == x.pane_id));
        }
    }
    publish(ctx, j, s, shells);
}

fn publish(ctx: &Ctx, j: &Janitor, s: &Settings, shells: Vec<IdleShell>) {
    *lock(&j.listed) = shells.clone();
    let last_closed = lock(&j.last_closed).clone();
    ctx.state.set_idle_shells(Some(IdleShells { auto: s.auto, minutes: s.minutes, shells, last_closed, notice: s.notice.clone() }));
}

/// The published shells with the given settings.
fn published(j: &Janitor, s: &Settings) -> IdleShells {
    IdleShells { auto: s.auto, minutes: s.minutes, shells: lock(&j.listed).clone(), last_closed: lock(&j.last_closed).clone(), notice: s.notice.clone() }
}

fn herdr_down(ctx: &Ctx) -> bool {
    crate::herdr_health::current(&ctx.herdr_session).is_some_and(|h| h.panes_lost())
}

/// A herdr window may show the session: Linux counts the herdr TUIs attached to it and the bridges
/// of herdr windows on other computers; elsewhere it can't be told.
fn herdr_window(ctx: &Ctx) -> bool {
    crate::herdr_health::idle::windows(&ctx.herdr_session, &ctx.herdr.endpoint().socket).is_none_or(|n| n > 0)
}

/// The board as the rules see it, now.
fn board(ctx: &Ctx, window: bool) -> Vec<WorkspaceFacts> {
    let state = ctx.state.snapshot();
    let parked = ctx.state.parked_all();
    let attached: HashSet<String> = ctx.terms.panes().into_iter().collect();
    rules::facts(&state.workspaces, &state.agents, &parked, &attached, window)
}

async fn find(ctx: &Ctx, j: &Janitor, minutes: u32) -> Vec<IdleShell> {
    if herdr_down(ctx) {
        lock(&j.watched).clear();
        return Vec::new();
    }
    let now = now_ms();
    let all = board(ctx, herdr_window(ctx));
    let candidates: Vec<&PaneFacts> = all.iter().flat_map(|w| w.panes.iter().filter(move |p| rules::screen(w, p).is_ok())).collect();
    {
        let ids: HashSet<&str> = candidates.iter().map(|p| p.id.as_str()).collect();
        lock(&j.watched).retain(|k, _| ids.contains(k.as_str()));
    }
    if candidates.is_empty() {
        return Vec::new();
    }
    let sys = probe::System::scan().await;
    let shells = ctx.state.pane_shells();
    let mut probes = HashMap::new();
    for p in candidates {
        let pr = probe_pane(ctx, j, &sys, &shells, p, now).await;
        probes.insert(p.id.clone(), pr);
    }
    let jobs = ctx.state.pane_last_jobs();
    let mut out: Vec<IdleShell> = rules::assess(&all, &probes, now, minutes)
        .into_iter()
        .filter_map(|(wi, pi, verdict)| {
            let since = verdict.ok()?;
            let (w, p) = (&all[wi], &all[wi].panes[pi]);
            Some(IdleShell {
                pane_id: p.id.clone(),
                terminal_id: p.terminal_id.clone(),
                workspace_id: w.id.clone(),
                workspace: w.label.clone(),
                cwd: p.cwd.clone().or_else(|| Some(w.cwd.clone())).filter(|c| !c.is_empty()),
                shell: shell_name(probes.get(&p.id)),
                idle_since: since,
                last_command: jobs.get(&p.id).cloned(),
                closes_workspace: w.panes.len() == 1,
            })
        })
        .collect();
    out.sort_by_key(|x| x.idle_since);
    out
}

/// `bash` for a login shell's `-bash`.
fn shell_name(p: Option<&rules::Probe>) -> String {
    p.and_then(|p| p.shell.as_deref()).unwrap_or("shell").trim_start_matches('-').to_string()
}

/// What the host says about a pane's shell: `/proc` where readable, else herdr; where the
/// terminal's times are unknown, since when its screen is unchanged. Its quiet time is moved past
/// the time the host slept since ([`Sleeps::awake_since`]): idle time is time awake.
async fn probe_pane(ctx: &Ctx, j: &Janitor, sys: &probe::System, shells: &HashMap<String, u32>, pane: &PaneFacts, now: Millis) -> rules::Probe {
    let known = shells.get(&pane.id).copied();
    let mut p = match known.and_then(|pid| sys.linux(pid)) {
        Some(p) => p,
        None => match ctx.herdr.pane_process_info(&pane.id).await {
            Ok(info) => info.shell_pid.filter(|pid| Some(*pid) != known).and_then(|pid| sys.linux(pid)).unwrap_or_else(|| sys.from_info(&info)),
            Err(_) => rules::Probe::default(),
        },
    };
    if p.quiet_since.is_none() {
        if p.at_prompt == Some(true) {
            p.quiet_since = watch_screen(ctx, j, pane, now).await;
        } else {
            // Something runs (or can't be told): watching starts over once it is back at its prompt.
            lock(&j.watched).remove(&pane.id);
        }
    }
    p.quiet_since = p.quiet_since.map(|q| lock(&j.sleeps).awake_since(q, now));
    p
}

/// Since when the pane's screen and scrollback are unchanged, as far as hostd watched them: a
/// screen seen for the first time (or changed) counts from now.
async fn watch_screen(ctx: &Ctx, j: &Janitor, pane: &PaneFacts, now: Millis) -> Option<Millis> {
    let read = ctx.herdr.pane_read(&pane.id, ReadOptions::new(ReadSource::Recent).lines(WATCH_LINES)).await.ok()?;
    let mut h = DefaultHasher::new();
    read.text.hash(&mut h);
    let hash = h.finish();
    let mut watched = lock(&j.watched);
    match watched.get(&pane.id) {
        Some(w) if w.terminal_id == pane.terminal_id && w.hash == hash => Some(w.since),
        _ => {
            watched.insert(pane.id.clone(), Watched { terminal_id: pane.terminal_id.clone(), hash, since: now });
            Some(now)
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum How {
    /// By itself, after `minutes` idle.
    Auto { minutes: u32 },
    /// Someone picked it in TeleFlock.
    Asked,
}

/// A shell closed.
struct Closed {
    pane_id: String,
    workspace: String,
}

/// Closes the shells, each checked again right before (one batch at a time per session).
async fn close(ctx: &Ctx, j: &Janitor, refs: &[IdleShellRef], how: How) -> (Vec<Closed>, Vec<IdleShellKept>) {
    let _one = j.closing.lock().await;
    let minutes = store::get(&ctx.paths.home).minutes;
    let sys = probe::System::scan().await;
    let window = herdr_window(ctx);
    let mut closed = Vec::new();
    let mut kept = Vec::new();
    for r in refs {
        match close_one(ctx, j, &sys, window, minutes, r, how).await {
            Ok(c) => closed.push(c),
            Err(error) => kept.push(IdleShellKept { pane_id: r.pane_id.clone(), error }),
        }
    }
    if !closed.is_empty() {
        ctx.state.refresh();
    }
    (closed, kept)
}

fn keep_err(k: Keep) -> ApiError {
    ApiError::new("busy", format!("Kept: {}.", k.reason()))
}

async fn close_one(ctx: &Ctx, j: &Janitor, sys: &probe::System, window: bool, minutes: u32, r: &IdleShellRef, how: How) -> Result<Closed, ApiError> {
    if herdr_down(ctx) {
        return Err(ApiError::new("unavailable", "herdr is not running").retryable());
    }
    let all = board(ctx, window);
    let Some((w, p)) = all.iter().find_map(|w| w.panes.iter().find(|p| p.id == r.pane_id).map(|p| (w, p))) else {
        return Err(ApiError::new("not_found", "It is closed already."));
    };
    let moved = || ApiError::new("conflict", "Kept: its pane shows another terminal now.");
    if p.terminal_id != r.terminal_id {
        return Err(moved());
    }
    rules::screen(w, p).map_err(keep_err)?;
    // herdr's own view, now: the pane, and what else its workspace holds.
    let pane = ctx.herdr.pane_get(&r.pane_id).await.map_err(herdr_err)?;
    if pane.terminal_id != r.terminal_id {
        return Err(moved());
    }
    if pane.agent.is_some() {
        return Err(keep_err(Keep::Agent));
    }
    let left = ctx.herdr.pane_list(Some(&w.id)).await.map_err(herdr_err)?;
    if left.iter().any(|x| x.agent.is_some()) {
        return Err(keep_err(Keep::WorkspaceAgent));
    }
    let now = now_ms();
    let probe = probe_pane(ctx, j, sys, &ctx.state.pane_shells(), p, now).await;
    let since = rules::close_check(w, p, Some(&probe), now, minutes, left.len()).map_err(keep_err)?;
    ctx.herdr.pane_close(&r.pane_id).await.map_err(|e| if e.code == "confirmation_required" { keep_err(Keep::LeadsGroup) } else { herdr_err(e) })?;
    lock(&j.watched).remove(&r.pane_id);
    let shell = shell_name(Some(&probe));
    let folder = p.cwd.as_deref().filter(|c| !c.is_empty()).unwrap_or(&w.cwd);
    info!(session = %ctx.herdr_session, pane = %r.pane_id, workspace = %w.label, cwd = %folder, ?how, "closed idle shell");
    let how_text = match how {
        How::Auto { minutes } => format!("closed automatically after {} idle", span(i64::from(minutes) * 60_000)),
        How::Asked => "closed from TeleFlock".to_string(),
    };
    let detail = format!("{} · no input or output for {} · {how_text}", tilde(folder), span(now - since));
    ctx.state.record_activity_as("", &w.label, ActivityKind::ShellClosed, format!("Closed idle shell {shell}"), Some(detail));
    Ok(Closed { pane_id: r.pane_id.clone(), workspace: w.label.clone() })
}

/// One notification for the shells a check closed by itself; the page's `lastClosed`.
fn summarize(ctx: &Ctx, j: &Janitor, closed: &[Closed], minutes: u32) {
    let mut workspaces: Vec<String> = Vec::new();
    for c in closed {
        if !workspaces.contains(&c.workspace) {
            workspaces.push(c.workspace.clone());
        }
    }
    let n = closed.len();
    let title = if n == 1 { "Closed an idle shell".to_string() } else { format!("Closed {n} idle shells") };
    let body = format!("{}: no agent, nothing running, no input or output for {}.", list(&workspaces), span(i64::from(minutes) * 60_000));
    let at = now_ms();
    *lock(&j.last_closed) = Some(IdleShellsClosed { at, count: n as u32, workspaces });
    // Opening it (or its Review button) opens the host's Cleanup page at its idle shells.
    let review = NotifyAction { id: HostPage::IdleShells.action_id().to_string(), label: "Review".into(), answer: None };
    ctx.state.broadcast_notification(Notification { id: new_id("n"), at, kind: NotifyKind::Info, agent_id: String::new(), title, body, request_id: None, actions: vec![review] });
}

/// `a`, `a and b`, `a, b and c`, `a, b, c and 2 more`.
fn list(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [a] => a.clone(),
        [a, b] => format!("{a} and {b}"),
        [a, b, c] => format!("{a}, {b} and {c}"),
        [a, b, c, rest @ ..] => format!("{a}, {b}, {c} and {} more", rest.len()),
    }
}

/// `45 min`, `26 h`, `3 days`.
fn span(ms: Millis) -> String {
    let min = (ms / 60_000).max(0);
    if min < 120 {
        format!("{min} min")
    } else if min < 72 * 60 {
        format!("{} h", (min + 30) / 60)
    } else {
        format!("{} days", (min + 720) / 1440)
    }
}

fn tilde(path: &str) -> String {
    let home = crate::paths::home_dir();
    match std::path::Path::new(path).strip_prefix(&home) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".to_string(),
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => path.to_string(),
    }
}

/// `cleanup.idleShellsSet`.
pub fn set(ctx: &Ctx, p: &IdleShellsSetParams) -> Result<IdleShells, ApiError> {
    let s = store::set(&ctx.paths.home, p.auto, p.minutes)?;
    let j = janitor(&ctx.herdr_session);
    let now = now_ms();
    let mut shells = lock(&j.listed).clone();
    shells.retain(|x| now - x.idle_since >= i64::from(s.minutes) * 60_000);
    publish(ctx, &j, &s, shells);
    Ok(published(&j, &s))
}

/// `cleanup.idleShellsClose`.
pub async fn close_asked(ctx: &Ctx, p: &IdleShellsCloseParams) -> Result<IdleShellsCloseResult, ApiError> {
    let j = janitor(&ctx.herdr_session);
    let (closed, kept) = close(ctx, &j, &p.shells, How::Asked).await;
    let s = store::get(&ctx.paths.home);
    let mut shells = lock(&j.listed).clone();
    shells.retain(|x| !closed.iter().any(|c| c.pane_id == x.pane_id));
    publish(ctx, &j, &s, shells);
    // The list again, from what herdr shows once it settled.
    j.poke.notify_one();
    Ok(IdleShellsCloseResult { closed: closed.into_iter().map(|c| c.pane_id).collect(), kept, idle: published(&j, &s) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words() {
        assert_eq!(list(&["a".into()]), "a");
        assert_eq!(list(&["a".into(), "b".into(), "c".into()]), "a, b and c");
        assert_eq!(list(&["a".into(), "b".into(), "c".into(), "d".into(), "e".into()]), "a, b, c and 2 more");
        assert_eq!(span(45 * 60_000), "45 min");
        assert_eq!(span(26 * 3_600_000 + 10 * 60_000), "26 h");
        assert_eq!(span(24 * 3_600_000), "24 h");
        assert_eq!(span(7 * 86_400_000), "7 days");
        assert_eq!(tilde(&crate::paths::home_dir().join("src/spx").display().to_string()), "~/src/spx");
        assert_eq!(tilde("/srv/x"), "/srv/x");
        assert_eq!(shell_name(Some(&rules::Probe { shell: Some("-bash".into()), ..Default::default() })), "bash");
    }

    /// A laptop host asleep over a weekend: the time it slept is no idle time, and waking is
    /// seen (the janitor then waits for apps to re-attach before it checks).
    #[test]
    fn time_the_host_slept_is_not_idle_time() {
        const H: Millis = 3_600_000;
        let (wall, mono) = (1_000 * H, Instant::now());
        let mut s = Sleeps::default();
        assert!(!s.look(wall, mono), "nothing to compare yet");
        // A minute awake, then a check that ran long: no sleep.
        assert!(!s.look(wall + 60_000, mono + Duration::from_secs(60)));
        assert!(!s.look(wall + 200_000, mono + Duration::from_secs(200)));
        // 60 h on the wall clock, 50 s of them awake.
        let woke = wall + 200_000 + 60 * H;
        assert!(s.look(woke, mono + Duration::from_secs(250)));
        // Last used 2 h before the first look: idle since then for 2 h and 250 s awake.
        let used = wall - 2 * H;
        assert_eq!(woke - s.awake_since(used, woke), 2 * H + 250_000);
        // Used after waking: nothing to take off.
        assert_eq!(s.awake_since(woke + 1_000, woke + 5_000), woke + 1_000);
        // Awake again: a minute later is no new sleep, and the old one still counts.
        assert!(!s.look(woke + 60_000, mono + Duration::from_secs(310)));
        assert_eq!(woke + 60_000 - s.awake_since(used, woke + 60_000), 2 * H + 310_000);
    }
}
