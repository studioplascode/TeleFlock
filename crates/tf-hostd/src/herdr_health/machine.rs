//! The pure part of the health watch: probe results → [`HerdrHealth`] state, epochs, outages and
//! the restart backoff. The worker (`mod.rs`) probes, acts and publishes; everything here is
//! deterministic in the times it is given.

use tf_proto::{HerdrDownCause, HerdrGuardConfig, HerdrHealth, HerdrServerState, Millis};

/// A missing or refused socket must still fail this long after the first failed probe before the
/// server counts as gone: a live handoff, or someone restarting herdr by hand, leaves its socket
/// missing for a moment.
pub const CONFIRM_MS: Millis = 800;
/// A server whose socket accepts but that has not answered for this long is `unresponsive`.
pub const UNRESPONSIVE_MS: Millis = 15_000;
/// A server TeleFlock started must stay up this long before its start counts as a success (the
/// restart backoff resets then, not when it first answers): a herdr that dies shortly after each
/// start would otherwise restart every few seconds, and every cycle ends every agent.
pub const STABLE_MS: Millis = 60_000;
/// After this many servers in a row that died within [`STABLE_MS`] of starting, TeleFlock stops
/// starting herdr by itself (`HerdrHealth.restart_held`); Restart herdr still starts it.
pub const MAX_QUICK_DEATHS: u32 = 3;

/// Delay before start attempt `n + 1` of an outage, after `n` failed ones: 2 s, 5 s, 15 s, then
/// every 60 s.
pub fn backoff(failed: u32) -> Millis {
    match failed {
        0 => 2_000,
        1 => 5_000,
        2 => 15_000,
        _ => 60_000,
    }
}

/// One server process. `start` (clock ticks since boot, Linux) keeps a reused pid apart. Without
/// a pid (Windows) only an outage tells two instances apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServerId {
    pub pid: Option<u32>,
    pub start: Option<u64>,
}

impl ServerId {
    fn known(&self) -> bool {
        self.pid.is_some()
    }
}

/// One probe of the session's socket.
#[derive(Debug, Clone, PartialEq)]
pub enum Probe {
    Up { id: ServerId, version: String },
    /// No socket: the server shut down (it removes its socket) or never ran.
    Missing,
    /// A socket nobody listens on: the server died without cleaning up.
    Refused,
    /// The socket accepts, the server does not answer (or its process still runs while its socket
    /// is gone: a live handoff swapping sockets, a socket someone deleted).
    Silent,
    /// The socket is gone or refuses, and the process that served it no longer exists: the
    /// server is gone for certain (`crashed`: it left its socket behind).
    Gone { crashed: bool },
    Failed(String),
}

/// What a probe changed, for the worker to act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    /// The server is gone: every pane process of the session ended with it.
    WentDown,
    /// A server instance answers that was not seen before; `epoch` was bumped. `outage`: one was
    /// declared since the previous instance answered.
    NewServer { outage: bool },
    /// The known server answers again after not answering.
    Answering,
    /// The known server stopped answering (it still runs, so do its panes).
    Unresponsive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Failing {
    /// Missing or refused (`crashed` when refused).
    Gone { crashed: bool },
    Silent,
}

#[derive(Debug)]
pub struct Machine {
    pub h: HerdrHealth,
    /// The last instance that answered.
    server: Option<ServerId>,
    /// A failure seen but not declared yet, and since when.
    failing: Option<(Millis, Failing)>,
    /// An outage was declared since `server` last answered.
    outage: bool,
    /// When the current server first answered, while it has not yet stayed up for [`STABLE_MS`]
    /// (a server TeleFlock started, or that replaced one after an outage).
    up_since: Option<Millis>,
    /// Servers in a row that died within [`STABLE_MS`] of first answering.
    quick_deaths: u32,
}

impl Machine {
    pub fn new(now: Millis, config: HerdrGuardConfig) -> Self {
        Self { h: HerdrHealth::unknown(now, config), server: None, failing: None, outage: false, up_since: None, quick_deaths: 0 }
    }

    /// A failure waits for confirmation: probe again soon.
    pub fn confirming(&self) -> bool {
        self.failing.is_some_and(|(_, f)| matches!(f, Failing::Gone { .. }))
    }

    /// The server instance that answered last.
    pub fn server(&self) -> Option<ServerId> {
        self.server
    }

    pub fn is_down(&self) -> bool {
        matches!(self.h.state, HerdrServerState::Down | HerdrServerState::Starting | HerdrServerState::Restarting)
    }

    /// Applies one probe. `ended` counts the omp agents the board shows live, read only when the
    /// server is declared gone.
    pub fn observe(&mut self, probe: Probe, now: Millis, ended: impl FnOnce() -> u32) -> Option<Change> {
        match probe {
            Probe::Up { id, version } => self.answered(id, version, now),
            Probe::Gone { crashed } => {
                if self.is_down() {
                    self.failing = None;
                    return None;
                }
                let cause = if crashed { HerdrDownCause::Crashed } else { HerdrDownCause::Stopped };
                self.went_down(now, cause, ended());
                Some(Change::WentDown)
            }
            Probe::Missing | Probe::Refused => {
                let crashed = probe == Probe::Refused;
                if self.is_down() {
                    // Nothing more to learn; a start attempt (or someone else) brings it back.
                    self.failing = None;
                    return None;
                }
                match self.failing {
                    Some((since, Failing::Gone { .. })) if now - since >= CONFIRM_MS => {
                        let cause = if crashed { HerdrDownCause::Crashed } else { HerdrDownCause::Stopped };
                        self.went_down(now, cause, ended());
                        Some(Change::WentDown)
                    }
                    Some((_, Failing::Gone { .. })) => None,
                    _ => {
                        self.failing = Some((now, Failing::Gone { crashed }));
                        None
                    }
                }
            }
            Probe::Silent | Probe::Failed(_) => {
                if let Probe::Failed(e) = &probe {
                    self.h.error = Some(e.clone());
                }
                if self.is_down() || self.h.state == HerdrServerState::Unresponsive {
                    return None;
                }
                match self.failing {
                    Some((since, Failing::Silent)) if now - since >= UNRESPONSIVE_MS => {
                        self.set_state(HerdrServerState::Unresponsive, now);
                        self.h.cause = Some(HerdrDownCause::NotAnswering);
                        Some(Change::Unresponsive)
                    }
                    Some((_, Failing::Silent)) => None,
                    _ => {
                        self.failing = Some((now, Failing::Silent));
                        None
                    }
                }
            }
        }
    }

    fn answered(&mut self, id: ServerId, version: String, now: Millis) -> Option<Change> {
        self.failing = None;
        let new = match self.server {
            None => true,
            Some(prev) if prev.known() && id.known() => prev != id,
            Some(_) => self.outage,
        };
        self.server = Some(id);
        self.h.version = Some(version);
        self.h.pid = id.pid;
        if new {
            let outage = std::mem::take(&mut self.outage);
            self.h.epoch += 1;
            self.set_state(HerdrServerState::Up, now);
            self.h.down_at = None;
            self.h.cause = None;
            self.h.retry_at = None;
            self.h.restart_held = false;
            self.h.error = None;
            self.h.kept_panes = false;
            if outage || self.h.attempt > 0 {
                // A start of ours, or a replacement after an outage: the backoff stays until it
                // has proved stable ([`Machine::settle`]).
                self.up_since = Some(now);
            } else {
                self.up_since = None;
                self.quick_deaths = 0;
            }
            return Some(Change::NewServer { outage });
        }
        match self.h.state {
            HerdrServerState::Up | HerdrServerState::Updating => {
                self.settle(now);
                None
            }
            _ => {
                self.outage = false;
                self.set_state(HerdrServerState::Up, now);
                self.h.down_at = None;
                self.h.cause = None;
                self.h.retry_at = None;
                self.h.error = None;
                self.settle(now);
                Some(Change::Answering)
            }
        }
    }

    /// The server has stayed up long enough: its start succeeded, the backoff starts over.
    fn settle(&mut self, now: Millis) {
        if self.h.state == HerdrServerState::Up && self.up_since.is_some_and(|t| now - t >= STABLE_MS) {
            self.up_since = None;
            self.h.attempt = 0;
            self.quick_deaths = 0;
        }
    }

    fn set_state(&mut self, state: HerdrServerState, now: Millis) {
        if self.h.state != state {
            self.h.state = state;
            self.h.since = now;
        }
    }

    /// The server is gone (`cause`), with `ended` live omp agents on the board.
    pub fn went_down(&mut self, now: Millis, cause: HerdrDownCause, ended: u32) {
        self.failing = None;
        self.set_state(HerdrServerState::Down, now);
        // Before the first answer there was no server to lose.
        self.h.down_at = (self.h.epoch > 0).then_some(now);
        self.h.cause = (self.h.epoch > 0).then_some(cause);
        self.h.ended_agents = ended;
        if self.up_since.take().is_some_and(|t| now - t < STABLE_MS) {
            // It had not stayed up: the backoff keeps growing and the death is counted.
            self.quick_deaths += 1;
            self.h.attempt = self.h.attempt.max(self.quick_deaths);
        } else {
            self.h.attempt = 0;
            self.quick_deaths = 0;
        }
        self.h.retry_at = None;
        self.h.restart_held = false;
        self.outage = true;
    }

    /// Plans the next start (`enabled`), or gives up when the last servers kept dying young.
    fn plan_retry(&mut self, now: Millis, enabled: bool) {
        let held = enabled && self.quick_deaths >= MAX_QUICK_DEATHS;
        self.h.restart_held = held;
        self.h.retry_at = (enabled && !held).then(|| now + backoff(self.h.attempt));
    }

    /// Plans the next automatic start (`None` while automatic restarts are off, or held).
    pub fn schedule_retry(&mut self, now: Millis) {
        self.plan_retry(now, self.h.config.auto_restart && self.h.state == HerdrServerState::Down);
    }

    /// An automatic or requested start is due.
    pub fn retry_due(&self, now: Millis) -> bool {
        self.h.state == HerdrServerState::Down && self.h.retry_at.is_some_and(|at| now >= at)
    }

    pub fn start_attempt(&mut self, now: Millis) {
        self.set_state(HerdrServerState::Starting, now);
        self.h.attempt += 1;
        self.h.retry_at = None;
        self.h.restart_held = false;
    }

    /// The user asks for a start (Restart herdr): the history of quick deaths is forgiven.
    pub fn user_start(&mut self) {
        self.quick_deaths = 0;
        self.h.attempt = 0;
        self.h.restart_held = false;
    }

    /// A server answered a start and was gone again right away: counts like a quick death.
    pub fn quick_death(&mut self) {
        self.quick_deaths += 1;
        self.up_since = None;
    }

    /// A start attempt failed: down again, next try after the backoff (`retry` even with
    /// automatic restarts off, after a stop TeleFlock made itself).
    pub fn start_failed(&mut self, now: Millis, error: String, retry: bool) {
        self.set_state(HerdrServerState::Down, now);
        self.h.error = Some(error);
        self.plan_retry(now, retry || self.h.config.auto_restart);
    }

    /// TeleFlock stops the server to start it again (Restart herdr, a load without live handoff).
    pub fn begin_restart(&mut self, now: Millis, cause: HerdrDownCause, ended: u32) {
        self.failing = None;
        self.set_state(HerdrServerState::Restarting, now);
        self.h.down_at = Some(now);
        self.h.cause = Some(cause);
        self.h.ended_agents = ended;
        self.up_since = None;
        self.user_start();
        self.h.retry_at = None;
        self.outage = true;
    }

    /// A live handoff starts: panes keep running, the next instance takes them over.
    pub fn begin_update(&mut self, now: Millis) {
        self.failing = None;
        self.set_state(HerdrServerState::Updating, now);
    }

    /// A live handoff that did not happen: the old server still runs everything.
    pub fn end_update(&mut self, now: Millis) {
        if self.h.state == HerdrServerState::Updating {
            self.set_state(HerdrServerState::Up, now);
        }
    }

    pub fn set_config(&mut self, config: HerdrGuardConfig, now: Millis) {
        let changed = self.h.config.auto_restart != config.auto_restart;
        self.h.config = config;
        if changed {
            self.schedule_retry(now);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(pid: u32, start: u64) -> ServerId {
        ServerId { pid: Some(pid), start: Some(start) }
    }

    fn up(pid: u32, start: u64) -> Probe {
        Probe::Up { id: id(pid, start), version: "0.9.5".into() }
    }

    fn m() -> Machine {
        Machine::new(0, HerdrGuardConfig::default())
    }

    #[test]
    fn first_answer_is_epoch_one_and_the_same_server_stays_there() {
        let mut m = m();
        assert_eq!(m.h.epoch, 0);
        assert_eq!(m.h.reason(), None);
        assert_eq!(m.observe(up(10, 1), 100, || 0), Some(Change::NewServer { outage: false }));
        assert_eq!((m.h.epoch, m.h.state, m.h.pid), (1, HerdrServerState::Up, Some(10)));
        assert_eq!(m.observe(up(10, 1), 2_100, || 0), None);
        assert_eq!(m.h.epoch, 1);
        assert!(m.h.is_up());
    }

    #[test]
    fn a_missing_socket_is_confirmed_before_the_server_counts_as_stopped() {
        let mut m = m();
        m.observe(up(10, 1), 0, || 0);
        assert_eq!(m.observe(Probe::Missing, 2_000, || 9), None);
        assert!(m.confirming());
        assert!(m.h.is_up(), "one missing socket is not an outage yet");
        // It came back within the window (a handoff's socket swap): nothing happened.
        assert_eq!(m.observe(up(10, 1), 2_500, || 9), None);
        assert!(!m.confirming());
        // Gone for good.
        assert_eq!(m.observe(Probe::Missing, 4_000, || 9), None);
        assert_eq!(m.observe(Probe::Missing, 4_900, || 9), Some(Change::WentDown));
        assert_eq!(m.h.state, HerdrServerState::Down);
        assert_eq!(m.h.cause, Some(HerdrDownCause::Stopped));
        assert_eq!(m.h.down_at, Some(4_900));
        assert_eq!(m.h.ended_agents, 9);
        assert_eq!(m.h.reason(), Some("herdr stopped"));
        assert!(m.h.panes_lost());
        // Further failures change nothing.
        assert_eq!(m.observe(Probe::Missing, 7_000, || 0), None);
        assert_eq!(m.h.down_at, Some(4_900));
    }

    #[test]
    fn a_refused_socket_reads_as_a_crash() {
        let mut m = m();
        m.observe(up(10, 1), 0, || 0);
        m.observe(Probe::Refused, 1_000, || 2);
        assert_eq!(m.observe(Probe::Refused, 2_000, || 2), Some(Change::WentDown));
        assert_eq!(m.h.cause, Some(HerdrDownCause::Crashed));
        assert_eq!(m.h.reason(), Some("herdr crashed"));
    }

    #[test]
    fn a_new_instance_bumps_the_epoch_after_an_outage_and_without_one() {
        let mut m = m();
        m.observe(up(10, 1), 0, || 0);
        m.observe(Probe::Missing, 1_000, || 3);
        m.observe(Probe::Missing, 2_000, || 3);
        assert_eq!(m.observe(up(20, 7), 9_000, || 0), Some(Change::NewServer { outage: true }));
        assert_eq!((m.h.epoch, m.h.state, m.h.down_at, m.h.cause), (2, HerdrServerState::Up, None, None));
        // Replaced between two probes (a live handoff, or a quick restart by hand).
        assert_eq!(m.observe(up(30, 9), 11_000, || 0), Some(Change::NewServer { outage: false }));
        assert_eq!(m.h.epoch, 3);
        // A reused pid with another start time is another server.
        assert_eq!(m.observe(up(30, 12), 13_000, || 0), Some(Change::NewServer { outage: false }));
        assert_eq!(m.h.epoch, 4);
    }

    #[test]
    fn without_pids_only_an_outage_tells_instances_apart() {
        let anon = |v: &str| Probe::Up { id: ServerId { pid: None, start: None }, version: v.into() };
        let mut m = m();
        assert_eq!(m.observe(anon("0.9.5"), 0, || 0), Some(Change::NewServer { outage: false }));
        assert_eq!(m.observe(anon("0.9.5"), 2_000, || 0), None);
        m.observe(Probe::Missing, 3_000, || 0);
        m.observe(Probe::Missing, 4_000, || 0);
        assert_eq!(m.observe(anon("0.9.5"), 6_000, || 0), Some(Change::NewServer { outage: true }));
        assert_eq!(m.h.epoch, 2);
    }

    #[test]
    fn silence_turns_unresponsive_and_an_answer_brings_it_back_in_the_same_epoch() {
        let mut m = m();
        m.observe(up(10, 1), 0, || 0);
        assert_eq!(m.observe(Probe::Silent, 1_000, || 0), None);
        assert_eq!(m.observe(Probe::Silent, 10_000, || 0), None);
        assert!(m.h.is_up());
        assert_eq!(m.observe(Probe::Silent, 16_000, || 0), Some(Change::Unresponsive));
        assert_eq!(m.h.state, HerdrServerState::Unresponsive);
        assert_eq!(m.h.reason(), Some("herdr is not answering"));
        assert!(!m.h.panes_lost(), "a hung server still holds its panes");
        assert_eq!(m.observe(Probe::Silent, 30_000, || 0), None);
        assert_eq!(m.observe(up(10, 1), 31_000, || 0), Some(Change::Answering));
        assert_eq!((m.h.state, m.h.epoch, m.h.cause), (HerdrServerState::Up, 1, None));
        // A hung server that then dies is an outage like any other.
        m.observe(Probe::Silent, 40_000, || 0);
        m.observe(Probe::Silent, 56_000, || 0);
        m.observe(Probe::Refused, 57_000, || 1);
        assert_eq!(m.observe(Probe::Refused, 58_000, || 1), Some(Change::WentDown));
    }

    #[test]
    fn backoff_and_retries() {
        assert_eq!([backoff(0), backoff(1), backoff(2), backoff(3), backoff(9)], [2_000, 5_000, 15_000, 60_000, 60_000]);
        let mut m = m();
        m.observe(up(10, 1), 0, || 0);
        m.observe(Probe::Missing, 1_000, || 4);
        m.observe(Probe::Missing, 2_000, || 4);
        m.schedule_retry(2_000);
        assert_eq!(m.h.retry_at, Some(4_000));
        assert!(!m.retry_due(3_999));
        assert!(m.retry_due(4_000));
        m.start_attempt(4_000);
        assert_eq!((m.h.state, m.h.attempt, m.h.retry_at), (HerdrServerState::Starting, 1, None));
        assert_eq!(m.h.reason(), Some("herdr stopped"), "still the outage's cause while starting");
        m.start_failed(5_000, "boom".into(), false);
        assert_eq!((m.h.state, m.h.retry_at), (HerdrServerState::Down, Some(10_000)));
        m.start_attempt(10_000);
        m.start_failed(11_000, "boom".into(), false);
        assert_eq!(m.h.retry_at, Some(26_000));
        m.start_attempt(26_000);
        m.start_failed(27_000, "boom".into(), false);
        assert_eq!(m.h.retry_at, Some(87_000));
        m.start_attempt(87_000);
        m.start_failed(88_000, "boom".into(), false);
        assert_eq!(m.h.retry_at, Some(148_000));
        assert_eq!(m.h.attempt, 4);
        assert_eq!(m.h.down_at, Some(2_000), "the outage began once");
        assert_eq!(m.observe(up(20, 5), 150_000, || 0), Some(Change::NewServer { outage: true }));
        // The start only counts as a success once the server has stayed up.
        assert_eq!((m.h.attempt, m.h.error.as_deref(), m.h.retry_at), (4, None, None));
        m.observe(up(20, 5), 150_000 + STABLE_MS - 1, || 0);
        assert_eq!(m.h.attempt, 4);
        m.observe(up(20, 5), 150_000 + STABLE_MS, || 0);
        assert_eq!(m.h.attempt, 0);
    }

    /// Takes the machine through one outage: gone at `t`, started and answering at `t + 3_000`.
    fn die_and_restart(m: &mut Machine, t: Millis, pid: u32) {
        m.observe(Probe::Missing, t, || 2);
        m.observe(Probe::Missing, t + 1_000, || 2);
        m.schedule_retry(t + 1_000);
        m.start_attempt(t + 2_000);
        m.observe(up(pid, u64::from(pid)), t + 3_000, || 0);
    }

    #[test]
    fn a_herdr_that_keeps_dying_young_backs_off_and_then_stops_restarting() {
        let mut m = m();
        m.observe(up(10, 1), 0, || 0);
        // The first server had been up for long: its death starts at the shortest backoff.
        m.observe(Probe::Missing, 300_000, || 2);
        m.observe(Probe::Missing, 301_000, || 2);
        m.schedule_retry(301_000);
        assert_eq!((m.h.attempt, m.h.retry_at, m.h.restart_held), (0, Some(303_000), false));
        m.start_attempt(303_000);
        assert_eq!(m.observe(up(11, 11), 304_000, || 0), Some(Change::NewServer { outage: true }));
        // It dies again after 10 s: the attempt count (and with it the backoff) is not reset.
        m.observe(Probe::Missing, 314_000, || 2);
        m.observe(Probe::Missing, 315_000, || 2);
        m.schedule_retry(315_000);
        assert_eq!((m.h.attempt, m.h.retry_at, m.h.restart_held), (1, Some(320_000), false));
        m.start_attempt(320_000);
        m.observe(up(12, 12), 321_000, || 0);
        m.observe(Probe::Missing, 330_000, || 2);
        m.observe(Probe::Missing, 331_000, || 2);
        m.schedule_retry(331_000);
        assert_eq!((m.h.attempt, m.h.retry_at, m.h.restart_held), (2, Some(346_000), false));
        m.start_attempt(346_000);
        m.observe(up(13, 13), 347_000, || 0);
        m.observe(Probe::Missing, 350_000, || 2);
        m.observe(Probe::Missing, 351_000, || 2);
        // The third quick death: no more automatic starts.
        m.schedule_retry(351_000);
        assert_eq!((m.h.state, m.h.retry_at, m.h.restart_held), (HerdrServerState::Down, None, true));
        assert!(!m.retry_due(10_000_000));
        // Restart herdr forgives the history; the start counts as the first again.
        m.user_start();
        assert!(!m.h.restart_held);
        m.start_attempt(400_000);
        assert_eq!((m.h.state, m.h.attempt), (HerdrServerState::Starting, 1));
        m.observe(up(14, 14), 401_000, || 0);
        // A start that stays up resets everything.
        m.observe(up(14, 14), 401_000 + STABLE_MS, || 0);
        assert_eq!(m.h.attempt, 0);
        m.observe(Probe::Missing, 500_000, || 2);
        m.observe(Probe::Missing, 501_000, || 2);
        m.schedule_retry(501_000);
        assert_eq!((m.h.retry_at, m.h.restart_held), (Some(503_000), false));
    }

    #[test]
    fn quick_deaths_are_forgotten_after_a_stable_run_and_off_means_no_hold() {
        let mut m = m();
        m.observe(up(10, 1), 0, || 0);
        die_and_restart(&mut m, 100_000, 11);
        die_and_restart(&mut m, 110_000, 12);
        // Up for a minute: stable.
        m.observe(up(12, 12), 113_000 + STABLE_MS, || 0);
        die_and_restart(&mut m, 200_000, 13);
        die_and_restart(&mut m, 210_000, 14);
        m.observe(Probe::Missing, 220_000, || 2);
        m.observe(Probe::Missing, 221_000, || 2);
        m.schedule_retry(221_000);
        assert!(!m.h.restart_held, "two quick deaths since the stable run");
        // Automatic restarts off: nothing planned, and nothing held either.
        let mut off = Machine::new(0, HerdrGuardConfig { auto_restart: false, ..Default::default() });
        off.observe(up(10, 1), 0, || 0);
        for i in 0..4u32 {
            die_and_restart(&mut off, 10_000 * i64::from(i + 1), 20 + i);
        }
        off.observe(Probe::Missing, 100_000, || 0);
        off.observe(Probe::Missing, 101_000, || 0);
        off.schedule_retry(101_000);
        assert_eq!((off.h.retry_at, off.h.restart_held), (None, false));
    }

    #[test]
    fn automatic_restarts_off_schedules_nothing_unless_teleflock_stopped_it() {
        let mut m = Machine::new(0, HerdrGuardConfig { auto_restart: false, ..Default::default() });
        m.observe(up(10, 1), 0, || 0);
        m.observe(Probe::Missing, 1_000, || 1);
        m.observe(Probe::Missing, 2_000, || 1);
        m.schedule_retry(2_000);
        assert_eq!(m.h.retry_at, None);
        m.start_attempt(3_000);
        m.start_failed(4_000, "x".into(), true);
        assert_eq!(m.h.retry_at, Some(9_000), "after its own stop, TeleFlock keeps trying");
        m.set_config(HerdrGuardConfig::default(), 5_000);
        assert_eq!(m.h.retry_at, Some(10_000), "switching it on plans the next try");
    }

    #[test]
    fn restart_and_update_bookkeeping() {
        let mut m = m();
        m.observe(up(10, 1), 0, || 0);
        m.begin_restart(1_000, HerdrDownCause::Update, 5);
        assert_eq!((m.h.state, m.h.down_at, m.h.ended_agents), (HerdrServerState::Restarting, Some(1_000), 5));
        assert_eq!(m.h.reason(), Some("herdr is restarting"));
        assert!(m.h.panes_lost());
        assert_eq!(m.observe(up(11, 2), 3_000, || 0), Some(Change::NewServer { outage: true }));
        m.begin_update(4_000);
        assert_eq!(m.h.state, HerdrServerState::Updating);
        assert!(m.h.is_up() && !m.h.panes_lost());
        // The old server answers during the handoff: still updating.
        assert_eq!(m.observe(up(11, 2), 4_500, || 0), None);
        assert_eq!(m.h.state, HerdrServerState::Updating);
        // The replacement answers.
        assert_eq!(m.observe(up(12, 3), 6_000, || 0), Some(Change::NewServer { outage: false }));
        assert_eq!((m.h.state, m.h.epoch), (HerdrServerState::Up, 3));
        m.begin_update(7_000);
        m.end_update(8_000);
        assert_eq!(m.h.state, HerdrServerState::Up);
    }
}
