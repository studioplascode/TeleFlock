//! herdr's server lifecycle on a host (architecture §3.29; `herdr_health` in tf-hostd): whether a
//! herdr session's server runs, TeleFlock starting it again when it goes away, and loading a newer
//! installed herdr into it once the session has been idle long enough. Published per herdr session
//! as `HostInfo.herdrHealth` (hosts ≥ 0.7.0; older hosts omit it and apps hide every control).

use crate::Millis;

wire_enum! {
    /// * `up`: the server answers.
    /// * `unresponsive`: its socket accepts connections but it has not answered for a while. Its
    ///   panes and agents keep running; TeleFlock never restarts it by itself.
    /// * `down`: no server runs for this session, so every pane process (agents, shells) ended.
    ///   With `config.autoRestart`, TeleFlock starts it again at `retryAt`.
    /// * `starting`: TeleFlock is starting it.
    /// * `restarting`: TeleFlock is stopping it to start it again (Load now on a herdr too old for
    ///   a live handoff, or a forced Restart herdr): its pane processes end.
    /// * `updating`: TeleFlock is handing its panes to the installed herdr (live handoff): pane
    ///   processes keep running.
    pub enum HerdrServerState { Up, Unresponsive, Down, Starting, Restarting, Updating }
}

wire_enum! {
    /// Why the server is not up (`HerdrHealth.cause`).
    /// * `stopped`: it shut down and removed its socket (`herdr server stop`, quitting herdr).
    /// * `crashed`: it went away without removing its socket (killed, crashed, out of memory).
    /// * `notAnswering`: it runs but does not answer (`unresponsive`).
    /// * `restart`: TeleFlock restarted it on request (Restart herdr).
    /// * `update`: TeleFlock restarted it to load the installed herdr (no live handoff).
    pub enum HerdrDownCause { Stopped, Crashed, NotAnswering, Restart, Update }
}

wire_struct! {
    /// Per-host herdr lifecycle settings (`host.herdrConfig`; tf-hostd `<home>/herdr.json`).
    pub struct HerdrGuardConfig {
        /// Start herdr again when its server goes away (default on).
        pub auto_restart: bool,
        /// Load a newer installed herdr into the running server once the session has been idle
        /// for `idleMinutes` (default on).
        pub idle_update: bool,
        /// 1–1440, default 20.
        pub idle_minutes: u32,
    }
}

wire_enum! {
    /// How the running server gets the installed herdr.
    /// * `handoff`: live handoff: herdr moves every pane to a server of the installed version;
    ///   agents and terminals keep running.
    /// * `restart`: the running server is too old for a live handoff: it stops (this session's
    ///   agents and terminals end) and starts again; TeleFlock brings the agents back. Only on
    ///   request: automatic idle loading uses live handoffs only (`ready`).
    pub enum HerdrUpdateMode { Handoff, Restart }
}

wire_enum! {
    /// * `waiting`: loads by itself once the session has been idle for `idleMinutes` (`blockers`
    ///   says what keeps it busy now).
    /// * `running`: loading now.
    /// * `done`: loaded (`at`).
    /// * `failed`: the last load failed (`error`); tried again after the next idle window.
    /// * `manual`: automatic loading is off for this host: Load now only.
    /// * `ready`: the installed herdr can only be loaded by stopping the server (`mode` `restart`:
    ///   no live handoff), which ends every agent and terminal. TeleFlock never does that by
    ///   itself: Load now / Restart herdr loads it when the user wants.
    pub enum HerdrUpdateState { Waiting, Running, Done, Failed, Manual, Ready }
}

wire_struct! {
    /// Loading the installed herdr into the running server (`HerdrHealth.update`): present while
    /// the server runs another version than the installed herdr, and for a day after a load.
    pub struct HerdrUpdate {
        pub state: HerdrUpdateState,
        /// The server's version before the load.
        pub from: String,
        /// The installed herdr's version.
        pub to: String,
        pub mode: HerdrUpdateMode,
        /// Since when nothing kept the session busy; absent while something does.
        pub idle_since: Option<Millis>,
        /// When it loads by itself (`idleSince` + the idle window) while the session stays idle.
        pub due_at: Option<Millis>,
        /// What keeps the session busy now, one short phrase each ("2 agents working").
        pub blockers: Vec<String>,
        /// When the last load finished (`done`, `failed`).
        pub at: Option<Millis>,
        pub error: Option<String>,
    }
}

wire_struct! {
    /// The health of one herdr session's server (`HostInfo.herdrHealth`).
    pub struct HerdrHealth {
        pub state: HerdrServerState,
        /// When `state` began.
        pub since: Millis,
        /// Server instances seen up: +1 each time a different herdr server process answers (a
        /// restart, a start after a crash, a live handoff). 0: not checked yet / never seen up.
        pub epoch: u64,
        /// The running server's version.
        pub version: Option<String>,
        /// The running server's process id (Linux, macOS).
        pub pid: Option<u32>,
        /// When the current outage began; kept until the server is up again.
        pub down_at: Option<Millis>,
        pub cause: Option<HerdrDownCause>,
        /// The current server took over its predecessor's panes by live handoff: agents and
        /// terminals kept running.
        pub kept_panes: bool,
        /// This server relaunches the agents of the panes it restores by itself (herdr's
        /// `session.resume_agents_on_restore`). False for servers TeleFlock started, which leave
        /// that to TeleFlock.
        pub herdr_resumes: bool,
        /// omp agents the board showed live when the server went away.
        pub ended_agents: u32,
        /// Start attempts in this outage.
        pub attempt: u32,
        /// Automatic restarts gave up: herdr kept going away shortly after each start. TeleFlock
        /// starts it again only when the user asks (Restart herdr).
        pub restart_held: bool,
        /// `<home>/herdr-config.toml` was edited after TeleFlock wrote it (herdr's own settings
        /// screen, `herdr channel set`, run from a pane), so TeleFlock stopped copying the user's
        /// config into it. Delete that file to start syncing again.
        pub config_edited: bool,
        /// When TeleFlock tries to start it next (`down` with `autoRestart`).
        pub retry_at: Option<Millis>,
        /// The last failed start or load attempt.
        pub error: Option<String>,
        pub config: HerdrGuardConfig,
        pub update: Option<HerdrUpdate>,
    }
}

impl Default for HerdrGuardConfig {
    fn default() -> Self {
        Self { auto_restart: true, idle_update: true, idle_minutes: 20 }
    }
}

impl HerdrHealth {
    /// Before the first check: `down` at epoch 0 with no outage (`downAt` absent).
    pub fn unknown(now: Millis, config: HerdrGuardConfig) -> Self {
        Self {
            state: HerdrServerState::Down,
            since: now,
            epoch: 0,
            version: None,
            pid: None,
            down_at: None,
            cause: None,
            kept_panes: false,
            herdr_resumes: true,
            ended_agents: 0,
            attempt: 0,
            restart_held: false,
            config_edited: false,
            retry_at: None,
            error: None,
            config,
            update: None,
        }
    }

    /// The server answers (an `updating` server keeps every pane process running too).
    pub fn is_up(&self) -> bool {
        matches!(self.state, HerdrServerState::Up | HerdrServerState::Updating)
    }

    /// Pane processes of the session are gone or going (the server stopped, crashed or is being
    /// restarted). `unresponsive` is not: a hung server still holds its panes.
    pub fn panes_lost(&self) -> bool {
        self.epoch > 0 && matches!(self.state, HerdrServerState::Down | HerdrServerState::Starting | HerdrServerState::Restarting)
    }

    /// Why the server is not up, in a few words: "herdr stopped", "herdr crashed", "herdr is not
    /// answering", "herdr is restarting", "herdr is updating", "herdr is starting". `None` while up
    /// and before the first check.
    pub fn reason(&self) -> Option<&'static str> {
        match self.state {
            HerdrServerState::Up => None,
            HerdrServerState::Updating => Some("herdr is updating"),
            HerdrServerState::Unresponsive => Some("herdr is not answering"),
            HerdrServerState::Restarting => Some("herdr is restarting"),
            HerdrServerState::Down | HerdrServerState::Starting if self.down_at.is_none() && self.epoch == 0 => {
                (self.state == HerdrServerState::Starting).then_some("herdr is starting")
            }
            HerdrServerState::Down | HerdrServerState::Starting => Some(match self.cause {
                Some(HerdrDownCause::Crashed) => "herdr crashed",
                Some(HerdrDownCause::Restart | HerdrDownCause::Update) => "herdr was restarted",
                Some(HerdrDownCause::NotAnswering) => "herdr stopped answering",
                Some(HerdrDownCause::Stopped) | None => "herdr stopped",
            }),
        }
    }
}

wire_struct! {
    /// `host.herdrRestart`: start the session's herdr server now when it is down (skips the
    /// backoff). `force` also replaces a running or unresponsive server: it stops (every agent
    /// and terminal of the session ends; TeleFlock brings the agents back) and starts again.
    pub struct HerdrRestartParams {
        pub force: Option<bool>,
    }
}

wire_struct! {
    /// `host.herdrConfig`: changes the per-host settings; absent fields stay.
    pub struct HerdrConfigParams {
        pub auto_restart: Option<bool>,
        pub idle_update: Option<bool>,
        pub idle_minutes: Option<u32>,
    }
}
