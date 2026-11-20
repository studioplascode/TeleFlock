//! The Cleanup report kept fresh by the host itself (architecture §3.17 "Background scans"): one
//! worker per herdr session runs every scan, its own and the page's, one at a time.
//!
//! **When** ([`next`]): the first background scan [`FIRST`] after the session's context started
//! (startup is busy: agents come back, apps re-attach, herdr starts), then whenever the report is
//! [`EVERY`] old (wall clock, so time asleep counts), and [`DEBOUNCE`] after the board's worktrees,
//! workspaces or parked and done agents last changed ([`DEBOUNCE_MAX`] after the first change of a
//! burst at most, never sooner than [`GAP`] after the last scan). The worker looks every [`TICK`]
//! (the board's fingerprint, the clock) and at once when the page asks.
//!
//! Thirty minutes, because: changes that matter (a worktree made or removed with its workspace, an
//! agent parked or marked done) bring a scan within a minute or two by themselves, so the interval
//! only catches what nothing announces (an agent's own `git worktree add`, a pull request merged
//! on GitHub, edits by hand); settled pull requests hold 30 minutes anyway (`prs::ttl`), so a
//! background scan asks gh about each worktree at most once per scan, no more often than a page
//! open used to; and a scan with nothing changed costs a few file times per worktree, so the
//! report is never older than half an hour at next to no cost.
//!
//! **Below the agents.** Background scans run at the lowest priority (`priority::low`) and yield:
//! a page's request takes a running one over (it goes on at normal priority), a Rescan stops it and
//! runs right after (`scan::decide`). While the host is busy (1-minute load over [`BUSY_PER_CORE`]
//! per core) a background scan waits, [`HOLD_MAX`] at most; then it runs anyway, still below the
//! agents. The page's scans never wait.
//!
//! Labs: `TF_HOSTD_CLEANUP_PACE=<n>` in a home other than `~/.teleflock` divides every time here
//! and the scans' holding times (sizes, statuses) by `n`, so a lab sees hours pass in minutes.

use std::future::Future;
use std::hash::{Hash, Hasher};
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tf_proto::{CleanupScanKind, Column, Millis};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::scan::{self, Run, Scanner};
use super::signals::age;
use crate::ops::Ctx;

/// The first background scan, this long after the session's context started.
pub(crate) const FIRST: Duration = Duration::from_secs(3 * 60);
/// A report this old is scanned again by itself.
pub(crate) const EVERY: Duration = Duration::from_secs(30 * 60);
/// A scan this long after the board's last relevant change…
pub(crate) const DEBOUNCE: Duration = Duration::from_secs(60);
/// …and at most this long after the first change of a burst.
pub(crate) const DEBOUNCE_MAX: Duration = Duration::from_secs(5 * 60);
/// Never two background scans closer than this.
pub(crate) const GAP: Duration = Duration::from_secs(2 * 60);
/// The worker looks this often.
pub(crate) const TICK: Duration = Duration::from_secs(30);
/// A busy host holds a background scan back this long at most.
pub(crate) const HOLD_MAX: Duration = Duration::from_secs(10 * 60);
/// Busy: 1-minute load over this per core.
pub(crate) const BUSY_PER_CORE: f32 = 1.5;
/// Names the lab pace.
pub const PACE_VAR: &str = "TF_HOSTD_CLEANUP_PACE";

static PACE: OnceLock<u32> = OnceLock::new();

/// `d` at the lab's pace (unchanged outside labs).
pub(crate) fn paced(d: Duration) -> Duration {
    d / *PACE.get().unwrap_or(&1)
}

/// What the worker remembers between looks.
#[derive(Debug, Clone)]
pub(crate) struct Clock {
    /// The worker started.
    pub started: Instant,
    /// The last scan ended.
    pub last_end: Option<Instant>,
    /// Changes on the board since the last scan: the first and the latest.
    pub changed: Option<(Instant, Instant)>,
    /// A background scan was due but held back by load since then.
    pub held_since: Option<Instant>,
}

impl Clock {
    pub(crate) fn new(started: Instant) -> Self {
        Clock { started, last_end: None, changed: None, held_since: None }
    }
}

/// What the worker does now ([`next`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Next {
    /// A scan now.
    Run(CleanupScanKind),
    /// A background scan is due, but the host is busy: look again in a [`TICK`].
    Hold,
    /// Nothing before then (or a poke).
    Wait(Instant),
}

/// The worker's decision. `want`: what the page asked for; `report_at`: when the latest report's
/// scan ended (wall clock, `wall` now); `busy`: the host is under heavy load.
pub(crate) fn next(c: &Clock, want: Option<CleanupScanKind>, report_at: Option<Millis>, now: Instant, wall: Millis, busy: bool) -> Next {
    if let Some(kind) = want {
        return Next::Run(kind);
    }
    let first = c.started + paced(FIRST);
    // The interval: by the report's own age (time asleep counts); no report yet: the first scan.
    let periodic = match report_at {
        Some(at) => {
            let age = age(at, wall);
            now + paced(EVERY).saturating_sub(age)
        }
        None => first,
    };
    let change = c.changed.map(|(first_change, latest)| {
        let due = (latest + paced(DEBOUNCE)).min(first_change + paced(DEBOUNCE_MAX));
        c.last_end.map_or(due, |end| due.max(end + paced(GAP)))
    });
    let due = change.map_or(periodic, |c| c.min(periodic)).max(first);
    if due > now {
        return Next::Wait(due);
    }
    if busy && c.held_since.is_none_or(|h| now < h + paced(HOLD_MAX)) {
        return Next::Hold;
    }
    Next::Run(CleanupScanKind::Background)
}

/// What the worker needs of its host: the production one is a herdr session's context, tests use
/// a scripted one.
pub(crate) trait Host: Send + Sync + 'static {
    /// A fingerprint of what on the board brings a scan when it changes.
    fn board(&self) -> u64;
    /// The host is under heavy load.
    fn busy(&self) -> bool;
    /// Wall clock now.
    fn wall(&self) -> Millis;
    /// One scan.
    fn pass(&self, run: Run) -> Pin<Box<dyn Future<Output = ()> + Send>>;
}

/// The worker: decides, runs a scan at a time, sleeps until the next one is due, a [`TICK`], or a
/// poke from the page.
pub(crate) async fn drive(sc: Arc<Scanner>, host: Arc<dyn Host>, cancel: CancellationToken) {
    let mut clock = Clock::new(Instant::now());
    let mut board = host.board();
    loop {
        let now = Instant::now();
        let seen = host.board();
        if seen != board {
            board = seen;
            clock.changed = Some(clock.changed.map_or((now, now), |(first, _)| (first, now)));
        }
        let wall = host.wall();
        match next(&clock, sc.wanted(), sc.report_at(), now, wall, host.busy()) {
            Next::Run(kind) => {
                sc.set_next(None);
                let run = sc.begin(kind);
                clock.changed = None;
                clock.held_since = None;
                // A scan that panics must not stop the worker or leave the scanner busy.
                if let Err(e) = tokio::spawn(host.pass(run)).await {
                    warn!("cleanup scan failed: {e}");
                }
                sc.end();
                clock.last_end = Some(Instant::now());
                board = host.board();
                continue;
            }
            Next::Hold => {
                clock.held_since.get_or_insert(now);
                sc.set_next(Some(wall + paced(TICK).as_millis() as Millis));
                wait(&sc, &cancel, now + paced(TICK)).await;
            }
            Next::Wait(due) => {
                sc.set_next(Some(wall + due.saturating_duration_since(now).as_millis() as Millis));
                wait(&sc, &cancel, due.min(now + paced(TICK))).await;
            }
        }
        if cancel.is_cancelled() {
            return;
        }
    }
}

async fn wait(sc: &Scanner, cancel: &CancellationToken, until: Instant) {
    tokio::select! {
        _ = cancel.cancelled() => {}
        _ = tokio::time::sleep_until(until) => {}
        _ = sc.poke.notified() => {}
    }
}

/// A herdr session's context as the worker's host.
struct Session(Arc<Ctx>);

impl Host for Session {
    fn board(&self) -> u64 {
        board_print(&self.0)
    }

    fn busy(&self) -> bool {
        let cores = std::thread::available_parallelism().map_or(1, |n| n.get()) as f32;
        crate::ops::host::load1() > BUSY_PER_CORE * cores
    }

    fn wall(&self) -> Millis {
        crate::util::now_ms()
    }

    fn pass(&self, run: Run) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        let ctx = self.0.clone();
        let sc = scan::scanner(&ctx.herdr_session);
        Box::pin(scan::pass(ctx, sc, run))
    }
}

/// What on the board brings a scan when it changes: the workspaces and the worktrees they show, the
/// parked agents and where they ran, and which live agents are done.
fn board_print(ctx: &Ctx) -> u64 {
    let state = ctx.state.snapshot();
    let mut workspaces: Vec<(&str, Option<&str>)> = state.workspaces.iter().map(|w| (w.id.as_str(), w.worktree.as_ref().map(|t| t.path.as_str()))).collect();
    workspaces.sort_unstable();
    let mut done: Vec<&str> = state.agents.iter().filter(|a| a.parked.is_none() && a.column == Column::Done).map(|a| a.id.as_str()).collect();
    done.sort_unstable();
    let parked = ctx.state.parked_all();
    let mut gone: Vec<(&str, Option<&str>, Option<&str>)> = parked.iter().map(|r| (r.agent_id.as_str(), r.worktree.as_ref().map(|w| w.path.as_str()), r.cwd.as_deref())).collect();
    gone.sort_unstable();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (workspaces, done, gone).hash(&mut h);
    h.finish()
}

/// Starts the session's worker (`Ctx::create`); a lab home may set its pace ([`PACE_VAR`]).
pub fn start(ctx: &Arc<Ctx>) {
    if !ctx.paths.is_default_home()
        && let Some(pace) = std::env::var(PACE_VAR).ok().and_then(|v| v.parse::<u32>().ok()).filter(|&p| p > 1)
        && PACE.set(pace).is_ok()
    {
        info!("cleanup scans at a lab pace of {pace}x");
    }
    let sc = scan::scanner(&ctx.herdr_session);
    let host: Arc<dyn Host> = Arc::new(Session(ctx.clone()));
    tokio::spawn(drive(sc, host, ctx.cancel.clone()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use tf_proto::{CleanupScanKind::*, CleanupScanParams};

    const MIN: Duration = Duration::from_secs(60);

    fn at(c: &Clock, d: Duration) -> Instant {
        c.started + d
    }

    /// The decision itself: the first scan after FIRST, the interval by the report's age, a burst
    /// of changes coalesced, the gap after the last scan, the page first, a busy host holding a
    /// background scan back for a while only.
    #[test]
    fn when_the_worker_scans() {
        let t0 = Instant::now();
        let wall0: Millis = 1_800_000_000_000;
        let w = |d: Duration| wall0 + d.as_millis() as Millis;
        let mut c = Clock::new(t0);
        assert_eq!(next(&c, None, None, at(&c, MIN), w(MIN), false), Next::Wait(at(&c, FIRST)), "not during startup");
        assert_eq!(next(&c, None, None, at(&c, FIRST), w(FIRST), false), Next::Run(Background), "the first scan");
        assert_eq!(next(&c, Some(Page), None, at(&c, MIN), w(MIN), true), Next::Run(Page), "the page never waits, busy or not");
        let old_report = Some(wall0 - 5 * 60 * 60_000);
        assert_eq!(next(&c, None, old_report, at(&c, MIN), w(MIN), false), Next::Wait(at(&c, FIRST)), "a report kept from before the start waits for FIRST too");

        // A scan ended at 3 min: the next by the interval, at 33 min.
        c.last_end = Some(at(&c, 3 * MIN));
        let report = Some(w(3 * MIN));
        assert_eq!(next(&c, None, report, at(&c, 10 * MIN), w(10 * MIN), false), Next::Wait(at(&c, 33 * MIN)));
        assert_eq!(next(&c, None, report, at(&c, 33 * MIN), w(33 * MIN), false), Next::Run(Background));
        let slept = next(&c, None, report, at(&c, 10 * MIN), w(10 * MIN) + 3_600_000, false);
        assert_eq!(slept, Next::Run(Background), "the host slept an hour: the report is old by the wall clock");

        // A burst of changes from 10 min on, every 40 s: the scan waits for a quiet minute, at most 5.
        c.changed = Some((at(&c, 10 * MIN), at(&c, 10 * MIN)));
        assert_eq!(next(&c, None, report, at(&c, 10 * MIN), w(10 * MIN), false), Next::Wait(at(&c, 11 * MIN)));
        c.changed = Some((at(&c, 10 * MIN), at(&c, 14 * MIN + Duration::from_secs(40))));
        assert_eq!(next(&c, None, report, at(&c, 14 * MIN), w(14 * MIN), false), Next::Wait(at(&c, 15 * MIN)), "DEBOUNCE_MAX after the first change");
        // A change right after a scan: not before GAP has passed.
        c.last_end = Some(at(&c, 20 * MIN));
        c.changed = Some((at(&c, 20 * MIN), at(&c, 20 * MIN)));
        assert_eq!(next(&c, None, Some(w(20 * MIN)), at(&c, 20 * MIN), w(20 * MIN), false), Next::Wait(at(&c, 22 * MIN)));

        // Busy: held, then run anyway after HOLD_MAX.
        c.changed = None;
        let due = at(&c, 50 * MIN);
        assert_eq!(next(&c, None, Some(w(20 * MIN)), due, w(50 * MIN), true), Next::Hold);
        c.held_since = Some(due);
        assert_eq!(next(&c, None, Some(w(20 * MIN)), due + 9 * MIN, w(59 * MIN), true), Next::Hold);
        assert_eq!(next(&c, None, Some(w(20 * MIN)), due + HOLD_MAX, w(60 * MIN), true), Next::Run(Background), "never held back for good");
    }

    /// A scripted host: a board fingerprint to change, a load to set, and scans that take a while
    /// (cancelled ones stop early), recorded with how many ran at once.
    struct Fake {
        sc: Arc<Scanner>,
        board: AtomicU64,
        busy: AtomicBool,
        wall0: Millis,
        t0: Instant,
        takes: Duration,
        running: AtomicUsize,
        most: AtomicUsize,
        /// Each scan: its kind when it started, when it started, cancelled, still low at its end.
        ran: Mutex<Vec<(CleanupScanKind, Duration, bool, bool)>>,
    }

    impl Fake {
        fn new(takes: Duration) -> Arc<Fake> {
            Arc::new(Fake {
                sc: Arc::new(Scanner::default()),
                board: AtomicU64::new(1),
                busy: AtomicBool::new(false),
                wall0: 1_800_000_000_000,
                t0: Instant::now(),
                takes,
                running: AtomicUsize::new(0),
                most: AtomicUsize::new(0),
                ran: Mutex::new(Vec::new()),
            })
        }

        fn ran(&self) -> Vec<(CleanupScanKind, Duration, bool, bool)> {
            self.ran.lock().unwrap().clone()
        }
    }

    impl Host for Arc<Fake> {
        fn board(&self) -> u64 {
            self.board.load(Ordering::Relaxed)
        }
        fn busy(&self) -> bool {
            self.busy.load(Ordering::Relaxed)
        }
        fn wall(&self) -> Millis {
            self.wall0 + (Instant::now() - self.t0).as_millis() as Millis
        }
        fn pass(&self, run: Run) -> Pin<Box<dyn Future<Output = ()> + Send>> {
            let me = self.clone();
            Box::pin(async move {
                let n = me.running.fetch_add(1, Ordering::SeqCst) + 1;
                me.most.fetch_max(n, Ordering::SeqCst);
                let start = Instant::now() - me.t0;
                let cancelled = tokio::select! {
                    _ = tokio::time::sleep(me.takes) => false,
                    _ = run.cancel.cancelled() => true,
                };
                if !cancelled {
                    scan::finish_for_test(&me.sc, me.wall());
                }
                me.ran.lock().unwrap().push((run.kind, start, cancelled, run.low.load(Ordering::Relaxed)));
                me.running.fetch_sub(1, Ordering::SeqCst);
            })
        }
    }

    fn start_fake(f: &Arc<Fake>) -> CancellationToken {
        let cancel = CancellationToken::new();
        tokio::spawn(drive(f.sc.clone(), Arc::new(f.clone()), cancel.clone()));
        cancel
    }

    async fn sleep(d: Duration) {
        tokio::time::sleep(d).await;
    }

    /// The worker on a paused clock: the first scan after FIRST, the next by the interval, a change
    /// debounced, never two at once.
    #[tokio::test(start_paused = true)]
    async fn the_worker_scans_by_itself_one_at_a_time() {
        let f = Fake::new(Duration::from_secs(20));
        let stop = start_fake(&f);
        sleep(FIRST - Duration::from_secs(1)).await;
        assert!(f.ran().is_empty(), "nothing during startup");
        sleep(Duration::from_secs(30)).await;
        assert_eq!(f.ran().len(), 1);
        assert_eq!(f.ran()[0].0, Background);
        // The interval: ~EVERY after the first one ended.
        sleep(EVERY - Duration::from_secs(60)).await;
        assert_eq!(f.ran().len(), 1, "not before the interval");
        sleep(Duration::from_secs(90)).await;
        assert_eq!(f.ran().len(), 2, "the interval");
        // A workspace closes: a scan about a minute later (the worker looks every TICK).
        f.board.store(2, Ordering::Relaxed);
        sleep(Duration::from_secs(45)).await;
        assert_eq!(f.ran().len(), 2, "debounced");
        sleep(DEBOUNCE + TICK).await;
        assert_eq!(f.ran().len(), 3, "the change brought a scan");
        assert_eq!(f.most.load(Ordering::SeqCst), 1, "never two at once");
        stop.cancel();
    }

    /// The page's request while a background scan runs: a stale report takes it over (no second
    /// scan); a Rescan stops it and runs right after; never two at once.
    #[tokio::test(start_paused = true)]
    async fn a_page_takes_over_or_preempts_a_background_scan() {
        let f = Fake::new(Duration::from_secs(120));
        let stop = start_fake(&f);
        sleep(FIRST + Duration::from_secs(10)).await;
        assert!(f.sc.answer_for_test().background.unwrap().running, "the first background scan runs");
        let page = CleanupScanParams { refresh: false, wait_ms: None, latest: true };
        assert_eq!(f.sc.ask(&page, f.wall()), scan::Ask::Join, "no report yet: the running scan serves");
        sleep(Duration::from_secs(150)).await;
        let ran = f.ran();
        assert_eq!(ran.len(), 1, "taken over, not run twice");
        assert_eq!((ran[0].0, ran[0].2, ran[0].3), (Background, false, false), "started as a background scan, finished at normal priority");
        assert!(ran[0].1 >= FIRST && ran[0].1 <= FIRST + TICK);

        // 31 minutes on, the next background scan runs; Rescan stops it, runs right after.
        sleep(EVERY - Duration::from_secs(60)).await;
        assert_eq!(f.ran().len(), 1);
        sleep(Duration::from_secs(90)).await;
        let rescan = CleanupScanParams { refresh: true, wait_ms: None, latest: true };
        let asked = Instant::now() - f.t0;
        assert_eq!(f.sc.ask(&rescan, f.wall()), scan::Ask::Preempt);
        sleep(Duration::from_secs(1)).await;
        let ran = f.ran();
        assert_eq!(ran.len(), 2);
        assert!(ran[1].2, "the background scan stopped early");
        sleep(Duration::from_secs(130)).await;
        let ran = f.ran();
        assert_eq!((ran.len(), ran[2].0, ran[2].2), (3, Refresh, false), "the Rescan ran right after");
        assert!(ran[2].1 - asked < Duration::from_secs(2), "at once, not at the next tick");
        assert_eq!(f.most.load(Ordering::SeqCst), 1, "never two at once");
        stop.cancel();
    }

    /// A busy host holds background scans back (HOLD_MAX at most); the page's are never held.
    #[tokio::test(start_paused = true)]
    async fn a_busy_host_holds_background_scans_for_a_while() {
        let f = Fake::new(Duration::from_secs(5));
        f.busy.store(true, Ordering::Relaxed);
        let stop = start_fake(&f);
        sleep(FIRST + 2 * MIN).await;
        assert!(f.ran().is_empty(), "held while busy");
        let page = CleanupScanParams { refresh: false, wait_ms: None, latest: true };
        assert_eq!(f.sc.ask(&page, f.wall()), scan::Ask::Start(Page));
        sleep(Duration::from_secs(10)).await;
        assert_eq!(f.ran().len(), 1, "the page's scan runs busy or not");
        assert_eq!(f.ran()[0].0, Page);
        // Its report is fresh for 30 min; then the background scan is held for up to HOLD_MAX.
        sleep(EVERY + HOLD_MAX + 2 * MIN).await;
        assert_eq!(f.ran().len(), 2, "run anyway after HOLD_MAX");
        assert_eq!(f.ran()[1].0, Background);
        stop.cancel();
    }
}
