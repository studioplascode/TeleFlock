//! Resuming omp agents without a new prompt (architecture §3.22): `agent.retry`, omp's F5, for an
//! agent or one of its subagents; and auto-resume, which brings agents (and their subagents) back
//! by themselves: after a provider usage limit once usage is available again, and after omp or the
//! host went away mid-turn (`restart`, architecture §3.25).

use crate::Millis;

wire_struct! {
    /// `agent.retry`: omp's F5 (`/retry`): retries the agent's failed or interrupted last turn
    /// without a new prompt.
    pub struct RetryParams {
        pub agent_id: String,
        /// One of the session's subagents (`Subagent.id`) instead of the agent: it is revived and
        /// retried, and its result reaches its parent as a background job result (bridge ≥ 2.1.0,
        /// `Capabilities.subagentRetry`).
        pub subagent_id: Option<String>,
    }
}

wire_enum! {
    /// How a retry reached omp.
    /// * `retry`: omp's own retry ran (TeleFlock bridge ≥ 2.1.0) and `started` is omp's answer.
    /// * `command`: `/retry` went into omp's TUI (an older bridge, or keystrokes): omp runs it but
    ///   does not say whether there was a turn to retry.
    /// * `restore`: a `restart` ticket brought the agent back (relaunched with `--resume` and its
    ///   TeleFlock launch) and it went on by omp's restore, its retry, or a note (`crate::restart`).
    pub enum RetryVia { Retry, Command, Restore }
}

wire_struct! {
    /// `agent.retry` / `agent.autoResumeNow`.
    pub struct RetryResult {
        /// A retry started (`via: command`: `/retry` was submitted). False: the agent is busy, or
        /// its last turn neither failed nor was stopped.
        pub started: bool,
        pub via: RetryVia,
    }
}

wire_enum! {
    /// * `waiting`: resumes around `resumeAt` by itself (a limit: once usage is back; a restart:
    ///   after a short grace in which herdr's own restore may bring the agent back first).
    /// * `checking`: due: hostd is reading the accounts' usage before it resumes.
    /// * `resuming`: resuming now (a restart relaunches omp, which can take a minute), or resumed
    ///   and waiting to see the agents work again.
    /// * `manual`: will not resume by itself (`reason` says why): Resume (Continue) by hand.
    pub enum AutoResumeStatus { Waiting, Checking, Resuming, Manual }
}

wire_enum! {
    /// What stopped the agents.
    /// * `usageLimit`: an account usage or quota limit (a plan window, credits).
    /// * `rateLimit`: a temporary rate limit (HTTP 429) that outlasted omp's own retries.
    /// * `overloaded`: the provider was overloaded or unavailable (HTTP 529, 503) beyond omp's retries.
    /// * `providerError`: another server error of the provider (HTTP 5xx) beyond omp's retries.
    /// * `restart`: an agent's omp process ended without anyone closing it (herdr stopped or
    ///   crashed, the host restarted, omp crashed or was killed; `Parked.ended`) or was cut off
    ///   mid-turn; continuing brings it back and goes on safely (`crate::restart`).
    pub enum AutoResumeKind { UsageLimit, RateLimit, Overloaded, ProviderError, Restart }
}

wire_enum! {
    /// What `AutoResume.resumeAt` rests on.
    /// * `window`: the reset of an exhausted usage window of the account (omp's usage report).
    /// * `hint`: the provider's own retry-after / reset time in the error.
    /// * `backoff`: neither is known: usage is checked again at growing intervals (15 → 60 min).
    pub enum ResumeBasis { Window, Hint, Backoff }
}

wire_struct! {
    /// `Agent.autoResume`: the agent, or subagents of its session, stopped on a provider limit, or
    /// its omp ended without anyone closing it (`kind: restart`; also on its ended card).
    pub struct AutoResume {
        pub status: AutoResumeStatus,
        pub kind: AutoResumeKind,
        /// One line: what stopped the agents, or (`manual`) why they will not resume by themselves.
        pub reason: String,
        pub provider: Option<String>,
        pub model: Option<String>,
        /// When usage is expected back (host clock); absent while `manual`.
        pub resume_at: Option<Millis>,
        pub basis: Option<ResumeBasis>,
        /// When the first agent of the session stopped (a restart: when hostd found it cut off).
        pub since: Millis,
        /// Resumes tried so far that stopped on the limit again (a restart: that failed).
        pub attempts: u32,
        /// The agent itself stopped (else only subagents did).
        pub root: bool,
        /// Subagents (`Subagent.id`) that stopped; they resume before the agent.
        pub subagent_ids: Vec<String>,
    }
}

wire_struct! {
    /// The host's auto-resume setting (`host.autoResume`, `host.autoResumeSet`).
    pub struct AutoResumeConfig {
        /// Resume agents that stopped on a provider usage limit once usage is back (and keep those
        /// limit errors out of what the agents see), and bring back agents whose omp ended without
        /// anyone closing it: herdr stopped or crashed, the host restarted, omp crashed (default
        /// on). Off: both wait for Resume / Continue by hand.
        pub enabled: bool,
        /// Bring agents back after a reboot: the host may install a boot-time service (systemd
        /// timer) that starts tf-hostd while agents wait to come back (default on). Off: they
        /// come back only once tf-hostd runs again. Absent from older daemons.
        pub bring_back: Option<bool>,
        /// Whether this host can start tf-hostd at boot (what "Bring agents back after a reboot"
        /// installs) and whether it does. Absent from older daemons.
        pub boot_service: Option<BootService>,
        /// Why the settings are off although nobody may have turned them off: the settings file
        /// could not be read, so the host fails closed (set aside, both off) until they are set
        /// again. Absent when there is nothing to say.
        pub notice: Option<String>,
    }
}

wire_struct! {
    /// The boot-time service of a host (`AutoResumeConfig.bootService`): a systemd timer that
    /// starts tf-hostd at boot. systemd hosts only (root, or a user with lingering).
    pub struct BootService {
        /// A boot service can be installed on this host now.
        pub available: bool,
        /// It is installed and active.
        pub installed: bool,
        /// Why it is not available (macOS, Windows, no systemd, no lingering, a development home),
        /// or what is wrong with it.
        pub note: Option<String>,
    }
}

wire_struct! {
    /// `host.autoResumeSet`: the settings to change (at least one).
    pub struct AutoResumeSetParams {
        pub enabled: Option<bool>,
        pub bring_back: Option<bool>,
    }
}

wire_enum! {
    /// Why an agent's omp process ended without anyone closing it (`AgentEnded.cause`).
    /// * `herdrStopped`, `herdrCrashed`, `herdrNotAnswering`, `herdrRestart`, `herdrUpdate`: its
    ///   herdr server went away, and every pane with it (herdr health, `HostInfo.herdrHealth`).
    /// * `reboot`: the host restarted.
    /// * `ompKilled`: a signal ended omp (SIGHUP when its terminal went away, SIGTERM, …).
    /// * `ompCrashed`: omp ended on a fatal error, or left no exit record (SIGKILL, out of memory).
    /// * `paneClosed`: its herdr pane went away while TeleFlock was not running.
    pub enum EndCause { HerdrStopped, HerdrCrashed, HerdrNotAnswering, HerdrRestart, HerdrUpdate, Reboot, OmpKilled, OmpCrashed, PaneClosed }
}

wire_enum! {
    /// What an ended agent was doing: `idle`, `working` (mid-turn: in a tool call, or on a prompt
    /// the model had not answered yet), `replying` (a reply was streaming).
    pub enum EndedTurn { Idle, Working, Replying }
}

wire_struct! {
    /// `Parked.ended`: the agent's omp process ended without anyone closing it (hosts ≥ 0.7.0,
    /// architecture §3.25). Its card stays in Review with its transcript and comes back by itself
    /// while the host's auto-resume is on (`Agent.autoResume`, kind `restart`, once herdr runs),
    /// else on Continue.
    pub struct AgentEnded {
        /// When it ended (herdr's outage start, omp's exit record, or when hostd last saw it).
        pub at: Millis,
        pub cause: EndCause,
        /// One line: `herdr stopped`, `the host restarted`, `omp was stopped (SIGHUP)`, …
        pub reason: String,
        pub turn: EndedTurn,
        /// The tool call it was in, `<tool>: <short args>` (`bash: sleep 30; echo done >> c.out`).
        pub last_action: Option<String>,
    }
}
