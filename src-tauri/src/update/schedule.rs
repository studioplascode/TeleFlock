//! When the shell checks for updates by itself (module docs of `update`): once shortly after
//! launch, then periodically while the app runs, and when it comes back to the front. Every
//! completed check (manual ones included) restarts the clock, failures back off exponentially,
//! so a device stays at a few requests per hour at most (GitHub allows 60 anonymous ones per
//! hour and IP).
//!
//! The decision ([`Schedule::due`]) is pure; [`run`] only produces the triggers.

use std::{future::Future, time::Duration};

use tf_proto::UpdatePhase;
use tokio::sync::Notify;

/// Periodic check interval while the app runs (plus up to [`JITTER_MS`]).
pub const PERIOD_MS: i64 = 60 * 60_000;
/// Random spread added to every period, so devices behind one IP don't check in lockstep.
pub const JITTER_MS: i64 = 10 * 60_000;
/// Back in front: check if the last check is at least this old.
pub const FOREGROUND_AFTER_MS: i64 = 20 * 60_000;
/// Wait after a failure (check or install), doubled per consecutive failure up to [`BACKOFF_MAX_MS`].
pub const BACKOFF_BASE_MS: i64 = 30 * 60_000;
pub const BACKOFF_MAX_MS: i64 = 12 * 60 * 60_000;

/// What woke the scheduler.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// First check of the process, [`Timing::launch_delay`] after setup.
    Launch,
    /// Timer tick ([`Timing::tick`]); due once the period is over.
    Tick,
    /// Window focused (desktop) or activity resumed (Android).
    Foreground,
}

/// Delays of [`run`]. The tick is only how often the wall clock is compared against the period:
/// the monotonic timers behind it stand still while a laptop sleeps, the wall clock doesn't.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    pub launch_delay: Duration,
    pub tick: Duration,
}

pub const TIMING: Timing = Timing { launch_delay: Duration::from_secs(8), tick: Duration::from_secs(5 * 60) };

/// How a check ended, for the backoff.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Nothing left to retry: up to date, or a manual (macOS) release was reported.
    Done,
    /// A newer release is being installed: its result decides ([`Schedule::failed`] or a restart).
    Installing,
    /// The check itself failed.
    Failed,
}

/// Automatic check bookkeeping (wall-clock milliseconds).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Schedule {
    /// End of the last completed check, manual or automatic.
    last: Option<i64>,
    /// Consecutive failed checks, installs and dismissed install prompts.
    failures: u32,
    /// Extra wait for the next periodic check, `0..JITTER_MS`.
    jitter: i64,
}

impl Schedule {
    /// Whether an automatic check should run now. Never while a check or an install runs or
    /// waits for the user (Android permission screen / installer prompt, a downloaded desktop
    /// update that is `ready`).
    pub fn due(&self, trigger: Trigger, now: i64, phase: UpdatePhase) -> bool {
        if matches!(
            phase,
            UpdatePhase::Checking
                | UpdatePhase::Downloading
                | UpdatePhase::Installing
                | UpdatePhase::NeedsPermission
                | UpdatePhase::Ready
        ) {
            return false;
        }
        let Some(last) = self.last else { return true };
        let elapsed = now - last;
        // The clock was set back: the stored time means nothing anymore.
        if elapsed < 0 {
            return true;
        }
        let wait = match trigger {
            Trigger::Launch | Trigger::Tick => PERIOD_MS + self.jitter,
            Trigger::Foreground => FOREGROUND_AFTER_MS,
        };
        elapsed >= wait.max(backoff(self.failures))
    }

    /// A check finished at `now`; `jitter` (`0..JITTER_MS`) spreads the next periodic one.
    pub fn checked(&mut self, now: i64, outcome: Outcome, jitter: i64) {
        self.last = Some(now);
        self.jitter = jitter.clamp(0, JITTER_MS);
        match outcome {
            Outcome::Done => self.failures = 0,
            Outcome::Installing => {}
            Outcome::Failed => self.failures = self.failures.saturating_add(1),
        }
    }

    /// An install failed or its prompt was dismissed.
    pub fn failed(&mut self) {
        self.failures = self.failures.saturating_add(1);
    }
}

/// Minimum wait after `failures` consecutive failures.
pub fn backoff(failures: u32) -> i64 {
    match failures {
        0 => 0,
        n => BACKOFF_BASE_MS.saturating_mul(1i64 << (n - 1).min(16)).min(BACKOFF_MAX_MS),
    }
}

/// A random `0..JITTER_MS` (std's per-instance random hasher keys; no RNG crate needed).
pub fn jitter() -> i64 {
    use std::hash::{BuildHasher, Hasher};
    let r = std::collections::hash_map::RandomState::new().build_hasher().finish();
    (r % JITTER_MS as u64) as i64
}

/// Calls `attempt` with [`Trigger::Launch`] after the launch delay, then on every tick and every
/// `foreground` notification, forever. `attempt` decides ([`Schedule::due`]); a foreground
/// notification that arrives while it runs is kept and handled right after.
pub async fn run<F, Fut>(timing: Timing, foreground: &Notify, mut attempt: F)
where
    F: FnMut(Trigger) -> Fut,
    Fut: Future<Output = ()>,
{
    tokio::time::sleep(timing.launch_delay).await;
    let mut trigger = Trigger::Launch;
    loop {
        attempt(trigger).await;
        trigger = tokio::select! {
            () = tokio::time::sleep(timing.tick) => Trigger::Tick,
            () = foreground.notified() => Trigger::Foreground,
        };
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    const MIN: i64 = 60_000;
    const IDLE: UpdatePhase = UpdatePhase::UpToDate;

    fn checked_at(now: i64, outcome: Outcome) -> Schedule {
        let mut s = Schedule::default();
        s.checked(now, outcome, 0);
        s
    }

    #[test]
    fn first_check_is_due_for_any_trigger() {
        let s = Schedule::default();
        for t in [Trigger::Launch, Trigger::Tick, Trigger::Foreground] {
            assert!(s.due(t, 0, UpdatePhase::Idle), "{t:?}");
        }
    }

    #[test]
    fn periodic_after_period_plus_jitter() {
        let mut s = Schedule::default();
        s.checked(0, Outcome::Done, 7 * MIN);
        assert!(!s.due(Trigger::Tick, PERIOD_MS, IDLE));
        assert!(!s.due(Trigger::Tick, PERIOD_MS + 7 * MIN - 1, IDLE));
        assert!(s.due(Trigger::Tick, PERIOD_MS + 7 * MIN, IDLE));
    }

    #[test]
    fn foreground_after_threshold() {
        let s = checked_at(0, Outcome::Done);
        assert!(!s.due(Trigger::Foreground, MIN, IDLE));
        assert!(!s.due(Trigger::Foreground, FOREGROUND_AFTER_MS - 1, IDLE));
        assert!(s.due(Trigger::Foreground, FOREGROUND_AFTER_MS, IDLE));
    }

    #[test]
    fn a_manual_check_restarts_the_clock() {
        let mut s = checked_at(0, Outcome::Done);
        s.checked(50 * MIN, Outcome::Done, 0);
        assert!(!s.due(Trigger::Tick, PERIOD_MS, IDLE));
        assert!(!s.due(Trigger::Foreground, 60 * MIN, IDLE));
        assert!(s.due(Trigger::Tick, 50 * MIN + PERIOD_MS, IDLE));
    }

    #[test]
    fn never_while_busy_or_waiting_for_the_user() {
        let s = Schedule::default();
        for p in [
            UpdatePhase::Checking,
            UpdatePhase::Downloading,
            UpdatePhase::Installing,
            UpdatePhase::NeedsPermission,
            UpdatePhase::Ready,
        ] {
            assert!(!s.due(Trigger::Foreground, 0, p), "{p:?}");
        }
        for p in [UpdatePhase::Idle, UpdatePhase::UpToDate, UpdatePhase::Available, UpdatePhase::Error] {
            assert!(s.due(Trigger::Tick, 0, p), "{p:?}");
        }
    }

    #[test]
    fn failures_back_off() {
        assert_eq!(backoff(0), 0);
        assert_eq!(backoff(1), 30 * MIN);
        assert_eq!(backoff(2), 60 * MIN);
        assert_eq!(backoff(3), 120 * MIN);
        assert_eq!(backoff(6), BACKOFF_MAX_MS);
        assert_eq!(backoff(u32::MAX), BACKOFF_MAX_MS);

        // One failure: focus no longer retries after 20 minutes, only after the backoff.
        let mut s = checked_at(0, Outcome::Failed);
        assert!(!s.due(Trigger::Foreground, FOREGROUND_AFTER_MS, UpdatePhase::Error));
        assert!(s.due(Trigger::Foreground, 30 * MIN, UpdatePhase::Error));
        // Three in a row: two hours, whatever the trigger.
        s.checked(0, Outcome::Failed, 0);
        s.checked(0, Outcome::Failed, 0);
        assert!(!s.due(Trigger::Tick, PERIOD_MS, UpdatePhase::Error));
        assert!(!s.due(Trigger::Foreground, 119 * MIN, UpdatePhase::Error));
        assert!(s.due(Trigger::Tick, 120 * MIN, UpdatePhase::Error));
        // A clean result resets it.
        s.checked(0, Outcome::Done, 0);
        assert!(s.due(Trigger::Foreground, FOREGROUND_AFTER_MS, IDLE));
    }

    #[test]
    fn failing_installs_back_off_too() {
        // Check finds the release (failures kept), the install fails: repeated each round, the
        // wait grows instead of retrying (e.g. a cancelled pkexec prompt) every hour.
        let mut s = Schedule::default();
        let mut now = 0;
        let mut waits = Vec::new();
        for _ in 0..5 {
            s.checked(now, Outcome::Installing, 0);
            s.failed();
            let mut next = now + 1;
            while !s.due(Trigger::Tick, next, UpdatePhase::Error) {
                next += MIN;
            }
            waits.push((next - now) / MIN);
            now = next;
        }
        assert_eq!(waits, [60, 60, 120, 240, 480]);
    }

    #[test]
    fn clock_set_back_counts_as_due() {
        let s = checked_at(10 * PERIOD_MS, Outcome::Done);
        assert!(s.due(Trigger::Tick, 0, IDLE));
    }

    #[test]
    fn jitter_in_range() {
        for _ in 0..100 {
            assert!((0..JITTER_MS).contains(&jitter()));
        }
    }

    /// The whole loop within one process: launch check, a periodic one once the hour is over
    /// and a foreground one, each deciding through `Schedule::due` on a simulated clock (each
    /// timer tick advances it by 10 minutes), with real (short) timers and a real `Notify`.
    #[test]
    fn later_automatic_checks_fire_in_one_process() {
        #[derive(Default)]
        struct Sim {
            now: i64,
            schedule: Schedule,
            /// (trigger, simulated minute) of every check that ran.
            checks: Vec<(Trigger, i64)>,
            wakes: usize,
        }
        let sim = Arc::new(Mutex::new(Sim::default()));
        let foreground = Arc::new(Notify::new());
        let timing = Timing { launch_delay: Duration::from_millis(1), tick: Duration::from_millis(5) };

        let s2 = Arc::clone(&sim);
        let fg = Arc::clone(&foreground);
        tauri::async_runtime::block_on(async move {
            let attempt = |t: Trigger| {
                let mut s = s2.lock().unwrap();
                s.wakes += 1;
                if t == Trigger::Tick {
                    s.now += 10 * MIN;
                }
                let now = s.now;
                if s.schedule.due(t, now, IDLE) {
                    s.checks.push((t, now / MIN));
                    s.schedule.checked(now, Outcome::Done, 0);
                }
                // Back in front 30 simulated minutes after the periodic check: due again.
                if s.checks.len() == 2 && now / MIN == s.checks[1].1 + 30 {
                    fg.notify_one();
                }
                std::future::ready(())
            };
            let stop = async {
                while s2.lock().unwrap().checks.len() < 3 {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            };
            tokio::select! {
                () = run(timing, &foreground, attempt) => unreachable!(),
                () = stop => {}
                () = tokio::time::sleep(Duration::from_secs(10)) => panic!("checks did not fire"),
            }
        });
        let s = sim.lock().unwrap();
        assert_eq!(s.checks, [(Trigger::Launch, 0), (Trigger::Tick, 60), (Trigger::Foreground, 90)]);
        // Ticks in between ran and decided "not yet".
        assert!(s.wakes > 3);
    }
}
