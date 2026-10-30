//! herdr's server lifecycle (architecture §3.29). One worker per served herdr session watches the
//! server with no app connected: it notices within seconds that the server is gone or replaced
//! (`HerdrHealth`, with an `epoch` per server instance), drops the dead agents from the board,
//! starts the server again with backoff, and loads a newer installed herdr into it once the
//! session has been idle long enough (live handoff when the server supports it, else stop +
//! start). Servers TeleFlock starts read `<home>/herdr-config.toml` ([`managed`]) so TeleFlock,
//! not herdr, relaunches the agents. Saved agent sessions whose files are gone are cleared
//! ([`saved`]).
//!
//! API for the rest of hostd: [`subscribe`] / [`current`] (Lifeboat's recovery keys off the epoch),
//! [`down_error`] for requests that need the server, [`handle`] for `host.herdr*`.

pub mod idle;
pub mod machine;
pub mod managed;
pub mod saved;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot, watch};
use tracing::{debug, info, warn};

use tf_herdr::{LiveHandoff, ProbeFailure};
use tf_proto::{
    ApiError, HerdrConfigParams, HerdrDownCause, HerdrGuardConfig, HerdrHealth, HerdrServerState, HerdrUpdate, HerdrUpdateMode,
    HerdrUpdateState, HostMethod, Millis, Notification, NotifyKind,
};

use crate::daemon::Daemon;
use crate::ops::{Ctx, to_value};
use crate::util::{new_id, now_ms};
use machine::{Change, Machine, Probe, ServerId};

/// Probe cadence while nothing is wrong: an outage shows within ~2–4 s.
const PROBE_EVERY: Duration = Duration::from_millis(1500);
/// Re-probe cadence while a missing socket waits for confirmation.
const PROBE_CONFIRM: Duration = Duration::from_millis(300);
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// The idle check reads the board this often while an update waits.
const BLOCKERS_EVERY: Duration = Duration::from_secs(5);
/// The installed herdr binary is checked for changes this often.
const INSTALLED_EVERY: Duration = Duration::from_secs(30);
/// Stale saved agent sessions are looked for this long after a server started, then this often.
const CLEANUP_AFTER_START: Duration = Duration::from_secs(10);
const CLEANUP_EVERY: Duration = Duration::from_secs(600);
/// `host.herdr*` answer once the action is done or after this long (the app waits 30 s);
/// progress keeps arriving through `HostInfo.herdrHealth`.
const REPLY_WITHIN: Duration = Duration::from_secs(20);
/// A finished load stays on the tools card this long.
const RESULT_KEPT: Millis = 24 * 3_600_000;
/// How long the replacement server of a live handoff gets to answer.
const HANDOFF_CONFIRM: Duration = Duration::from_secs(30);
/// An unresponsive server gets this long after SIGTERM before SIGKILL.
const TERM_WAIT: Duration = Duration::from_secs(10);

// ───────────────────────────── registry ─────────────────────────────

struct Slot {
    tx: watch::Sender<HerdrHealth>,
    cmds: Option<mpsc::UnboundedSender<Cmd>>,
}

static SESSIONS: LazyLock<Mutex<HashMap<String, Slot>>> = LazyLock::new(Default::default);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn slot<'a>(map: &'a mut HashMap<String, Slot>, session: &str) -> &'a mut Slot {
    map.entry(session.to_string()).or_insert_with(|| Slot { tx: watch::channel(HerdrHealth::unknown(now_ms(), config())).0, cmds: None })
}

/// The health of `session`'s server, now and on every change (before its worker runs: `down` at
/// epoch 0). Never closes.
pub fn subscribe(session: &str) -> watch::Receiver<HerdrHealth> {
    slot(&mut lock(&SESSIONS), session).tx.subscribe()
}

/// The health of `session`'s server, when TeleFlock watches it.
pub fn current(session: &str) -> Option<HerdrHealth> {
    lock(&SESSIONS).get(session).map(|s| s.tx.borrow().clone())
}

/// The error for a request that needs `session`'s server while it is not up.
pub fn down_error(session: &str) -> Option<ApiError> {
    current(session).filter(|h| !h.is_up() && (h.epoch > 0 || h.attempt > 0)).map(|h| down_api_error(Some(&h)))
}

/// "herdr stopped on this host" with what happens next.
pub fn down_api_error(h: Option<&HerdrHealth>) -> ApiError {
    let message = match h.and_then(HerdrHealth::reason) {
        Some(r) => format!("{r}: its panes and terminals are not available"),
        None => "herdr isn't running on this host".to_string(),
    };
    let hint = match h {
        Some(h) if h.state == HerdrServerState::Unresponsive => "Its programs still run. Restart herdr from the board if it does not recover.",
        Some(h) if h.restart_held => "TeleFlock stopped restarting it by itself: it kept stopping soon after each start. Restart herdr starts it.",
        Some(h) if !h.config.auto_restart => "Automatic restart is off for this host: Restart herdr starts it.",
        _ => "TeleFlock starts it again by itself; Restart herdr starts it now.",
    };
    let mut e = ApiError::new("herdr_down", message).with_hint(hint);
    e.retryable = true;
    e
}

/// herdr's own words for "no server" (`herdr terminal session` and the CLI).
pub fn is_connect_failure(message: &str) -> bool {
    ["failed to connect to server", "Is herdr server running", "no herdr server is reachable"].iter().any(|m| message.contains(m))
}

// ───────────────────────────── settings ─────────────────────────────

/// `<home>/herdr.json`: the per-host settings and the herdr sessions TeleFlock serves.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Stored {
    config: Option<HerdrGuardConfig>,
    sessions: Vec<String>,
}

struct Settings {
    file: Option<PathBuf>,
    stored: Stored,
    tx: watch::Sender<HerdrGuardConfig>,
}

static SETTINGS: LazyLock<Mutex<Settings>> =
    LazyLock::new(|| Mutex::new(Settings { file: None, stored: Stored::default(), tx: watch::channel(HerdrGuardConfig::default()).0 }));

fn load_settings(home: &Path) {
    let mut s = lock(&SETTINGS);
    if s.file.is_some() {
        return;
    }
    let file = home.join("herdr.json");
    s.stored = match std::fs::read(&file) {
        Ok(b) => serde_json::from_slice(&b).unwrap_or_else(|e| {
            warn!(file = %file.display(), "ignoring unreadable herdr settings: {e}");
            Stored::default()
        }),
        Err(_) => Stored::default(),
    };
    let config = s.stored.config.clone().unwrap_or_default();
    s.tx.send_replace(config);
    s.file = Some(file);
}

fn save(s: &Settings) {
    let Some(file) = &s.file else { return };
    match serde_json::to_vec_pretty(&s.stored) {
        Ok(b) => {
            if let Err(e) = crate::paths::write_atomic(file, &b) {
                warn!(file = %file.display(), "save herdr settings: {e}");
            }
        }
        Err(e) => warn!("encode herdr settings: {e}"),
    }
}

/// The per-host settings.
pub fn config() -> HerdrGuardConfig {
    lock(&SETTINGS).tx.borrow().clone()
}

fn set_config(p: &HerdrConfigParams) -> Result<HerdrGuardConfig, ApiError> {
    if let Some(m) = p.idle_minutes
        && !(1..=1440).contains(&m)
    {
        return Err(ApiError::new("invalid_params", "idleMinutes must be 1–1440"));
    }
    let mut s = lock(&SETTINGS);
    let mut c = s.tx.borrow().clone();
    if let Some(v) = p.auto_restart {
        c.auto_restart = v;
    }
    if let Some(v) = p.idle_update {
        c.idle_update = v;
    }
    if let Some(v) = p.idle_minutes {
        c.idle_minutes = v;
    }
    s.stored.config = Some(c.clone());
    save(&s);
    s.tx.send_replace(c.clone());
    info!(auto_restart = c.auto_restart, idle_update = c.idle_update, idle_minutes = c.idle_minutes, "herdr settings changed");
    Ok(c)
}

fn remember(session: &str) {
    let mut s = lock(&SETTINGS);
    if !s.stored.sessions.iter().any(|x| x == session) {
        s.stored.sessions.push(session.to_string());
        save(&s);
    }
}

// ───────────────────────────── entry points ─────────────────────────────

/// Daemon start: opens the context of every herdr session TeleFlock served before (while
/// automatic restarts are on), so their servers are watched, and started, with no app connected.
pub fn start(daemon: &Arc<Daemon>) {
    load_settings(&daemon.paths.home);
    let (auto, sessions) = {
        let s = lock(&SETTINGS);
        (s.tx.borrow().auto_restart, s.stored.sessions.clone())
    };
    if !auto {
        return;
    }
    for session in sessions {
        let d = daemon.clone();
        tokio::spawn(async move {
            if let Err(e) = d.ctx_for(&session).await {
                warn!(session, "herdr session not opened at start: {}", e.message);
            }
        });
    }
}

/// The launch of a server TeleFlock starts outside a worker (context start, Host setup).
pub fn launch(home: &Path) -> tf_herdr::ServerLaunch {
    managed::launch(home)
}

/// A session's worker, built and with its server started, not running yet (see [`begin`]).
pub struct Watch {
    worker: Worker,
    cmds: mpsc::UnboundedReceiver<Cmd>,
    cfg: watch::Receiver<HerdrGuardConfig>,
}

impl Watch {
    /// Runs the worker (one per herdr session context).
    pub fn spawn(self) {
        tokio::spawn(self.worker.run(self.cmds, self.cfg));
    }
}

/// Builds the session's worker and, when no server answers, starts one through the worker's own
/// bookkeeping (attempt count, backoff, `started`), so a herdr that dies right after the first
/// start is handled like any other restart loop. Waits for the start (up to 45 s); the caller
/// finishes setting the context up, then [`Watch::spawn`]s it.
pub async fn begin(ctx: &Arc<Ctx>) -> Watch {
    load_settings(&ctx.paths.home);
    remember(&ctx.herdr_session);
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    let tx = {
        let mut map = lock(&SESSIONS);
        let s = slot(&mut map, &ctx.herdr_session);
        s.cmds = Some(cmd_tx);
        s.tx.clone()
    };
    let cfg = lock(&SETTINGS).tx.subscribe();
    let config = cfg.borrow().clone();
    let mut worker = Worker {
        ctx: ctx.clone(),
        m: Machine::new(now_ms(), config),
        tx,
        managed: managed::Managed::new(&ctx.paths.home),
        live_handoff: false,
        started: false,
        handing_off: false,
        own_stop: false,
        uses_managed: false,
        installed: None,
        installed_at: None,
        idle_since: None,
        blockers: Vec::new(),
        blockers_at: None,
        loading: false,
        result: None,
        cleanup_at: None,
        pending_stale: saved::Pending::default(),
        unresponsive_notified: false,
        edited_notified: false,
    };
    worker.first_step().await;
    Watch { worker, cmds: cmd_rx, cfg }
}

/// `host.herdrRestart`, `host.herdrLoad`, `host.herdrConfig`.
pub async fn handle(ctx: &Ctx, req: HostMethod) -> Result<Value, ApiError> {
    let mut config = None;
    match req {
        HostMethod::HostHerdrRestart(p) => {
            let force = p.force.unwrap_or(false);
            send(ctx, |reply| Cmd::Restart { force, reply }).await?;
        }
        HostMethod::HostHerdrLoad(_) => send(ctx, |reply| Cmd::Load { reply }).await?,
        HostMethod::HostHerdrConfig(p) => config = Some(set_config(&p)?),
        other => return Err(ApiError::new("unknown_method", format!("{} is not a herdr method", other.name()))),
    }
    let mut h = current(&ctx.herdr_session).unwrap_or_else(|| HerdrHealth::unknown(now_ms(), self::config()));
    if let Some(c) = config {
        h.config = c;
    }
    to_value(h)
}

async fn send(ctx: &Ctx, make: impl FnOnce(oneshot::Sender<Result<(), ApiError>>) -> Cmd) -> Result<(), ApiError> {
    let cmds = lock(&SESSIONS).get(&ctx.herdr_session).and_then(|s| s.cmds.clone());
    let cmds = cmds.ok_or_else(|| ApiError::new("unavailable", "TeleFlock is not watching this herdr session yet").retryable())?;
    let (reply, answer) = oneshot::channel();
    cmds.send(make(reply)).map_err(|_| ApiError::new("unavailable", "herdr's health watch stopped").retryable())?;
    match tokio::time::timeout(REPLY_WITHIN, answer).await {
        Ok(Ok(r)) => r,
        // Still running: the answer is the current state; progress follows in `HostInfo`.
        _ => Ok(()),
    }
}

// ───────────────────────────── worker ─────────────────────────────

enum Cmd {
    Restart { force: bool, reply: oneshot::Sender<Result<(), ApiError>> },
    Load { reply: oneshot::Sender<Result<(), ApiError>> },
}

struct LoadResult {
    ok: bool,
    from: String,
    to: String,
    mode: HerdrUpdateMode,
    at: Millis,
    error: Option<String>,
}

struct Worker {
    ctx: Arc<Ctx>,
    m: Machine,
    tx: watch::Sender<HerdrHealth>,
    managed: managed::Managed,
    /// The answering server can hand its panes over (`ping` capabilities).
    live_handoff: bool,
    /// The next new server is one this worker started (with the managed config).
    started: bool,
    /// The next new server comes from this worker's live handoff (its panes kept running).
    handing_off: bool,
    /// This outage began with TeleFlock's own stop: keep starting even with automatic restarts off.
    own_stop: bool,
    /// The running server reads the managed config (reloaded when the user's config changes).
    uses_managed: bool,
    /// The installed herdr binary's stamp and version.
    installed: Option<(Option<(u64, std::time::SystemTime)>, String)>,
    installed_at: Option<Instant>,
    /// Since when nothing kept the session busy (while an update waits).
    idle_since: Option<Millis>,
    blockers: Vec<String>,
    blockers_at: Option<Instant>,
    loading: bool,
    result: Option<LoadResult>,
    cleanup_at: Option<Instant>,
    unresponsive_notified: bool,
    /// Saved sessions seen without a file, and since when ([`saved::Pending`]).
    pending_stale: saved::Pending,
    /// The managed config's edit was announced.
    edited_notified: bool,
}

impl Worker {
    /// The first look at the session: a server that runs is taken as it is, else TeleFlock starts one.
    async fn first_step(&mut self) {
        self.step().await;
        if self.m.h.state == HerdrServerState::Down && crate::ops::git::is_executable(self.ctx.herdr.binary()) {
            self.start().await;
        }
        self.publish();
    }

    async fn run(mut self, mut cmds: mpsc::UnboundedReceiver<Cmd>, mut cfg: watch::Receiver<HerdrGuardConfig>) {
        // Still no server (herdr is not installed yet, or the first start failed).
        if self.m.h.state == HerdrServerState::Down && self.m.h.retry_at.is_none() {
            self.m.schedule_retry(now_ms());
        }
        loop {
            let wait = self.wait();
            tokio::select! {
                _ = self.ctx.cancel.cancelled() => return,
                Some(cmd) = cmds.recv() => self.command(cmd).await,
                Ok(()) = cfg.changed() => {
                    let c = cfg.borrow_and_update().clone();
                    self.m.set_config(c, now_ms());
                }
                _ = tokio::time::sleep(wait) => {}
            }
            self.tick().await;
            self.publish();
        }
    }

    fn wait(&self) -> Duration {
        if self.m.confirming() {
            return PROBE_CONFIRM;
        }
        match self.m.h.retry_at {
            Some(at) => PROBE_EVERY.min(Duration::from_millis((at - now_ms()).max(0) as u64)),
            None => PROBE_EVERY,
        }
    }

    async fn tick(&mut self) {
        self.step().await;
        let now = now_ms();
        if self.m.retry_due(now) {
            if crate::ops::git::is_executable(self.ctx.herdr.binary()) {
                self.start().await;
            } else {
                self.m.start_failed(now, "herdr is not installed on this host".into(), false);
            }
        }
        if self.m.h.state == HerdrServerState::Up {
            self.sync_config().await;
            self.cleanup().await;
            self.evaluate_update().await;
        }
    }

    fn publish(&mut self) {
        let mut h = self.m.h.clone();
        h.config_edited = self.managed.edited();
        h.update = self.update_view(now_ms());
        self.ctx.state.set_herdr_health(Some(h.clone()));
        self.tx.send_if_modified(|cur| {
            if *cur == h {
                return false;
            }
            *cur = h;
            true
        });
    }

    async fn probe(&mut self) -> Probe {
        match self.ctx.herdr.probe(PROBE_TIMEOUT).await {
            Ok(p) => {
                self.live_handoff = p.pong.capabilities.as_ref().is_some_and(|c| c.live_handoff);
                let start = p.pid.and_then(tf_herdr::lifecycle::process_start_ticks);
                Probe::Up { id: ServerId { pid: p.pid, start }, version: p.pong.version }
            }
            Err(f) => match (f, self.m.server().and_then(alive)) {
                // Its process still runs: a socket swap (live handoff) or a deleted socket.
                (ProbeFailure::Missing | ProbeFailure::Refused, Some(true)) => Probe::Silent,
                (ProbeFailure::Missing, Some(false)) => Probe::Gone { crashed: false },
                (ProbeFailure::Refused, Some(false)) => Probe::Gone { crashed: true },
                (ProbeFailure::Missing, None) => Probe::Missing,
                (ProbeFailure::Refused, None) => Probe::Refused,
                (ProbeFailure::Silent, _) => Probe::Silent,
                (ProbeFailure::Other(e), _) => Probe::Failed(e),
            },
        }
    }

    /// One probe and what follows from it.
    async fn step(&mut self) -> Option<Change> {
        let probe = self.probe().await;
        let ctx = &self.ctx;
        let change = self.m.observe(probe, now_ms(), || live_omp(ctx));
        match change {
            Some(Change::WentDown) => self.on_down(),
            Some(Change::NewServer { outage }) => self.on_new_server(outage),
            Some(Change::Answering) => {
                info!(session = %self.ctx.herdr_session, "herdr answers again");
                if std::mem::take(&mut self.unresponsive_notified) {
                    notify(&self.ctx, NotifyKind::Info, "herdr answers again".into(), "Its agents and terminals kept running.".into());
                }
                self.ctx.state.refresh();
            }
            Some(Change::Unresponsive) => {
                warn!(session = %self.ctx.herdr_session, pid = ?self.m.h.pid, "herdr does not answer");
                self.unresponsive_notified = true;
                notify(
                    &self.ctx,
                    NotifyKind::Error,
                    "herdr is not answering".into(),
                    "Its agents and terminals still run, but TeleFlock can't reach them. Restart herdr from the board if it does not recover.".into(),
                );
            }
            None => {}
        }
        change
    }

    fn on_down(&mut self) {
        let h = &self.m.h;
        warn!(session = %self.ctx.herdr_session, cause = ?h.cause, ended = h.ended_agents, "herdr server is gone");
        // Agent recovery parks the session's live agents as ended cards first, so the board's
        // drop and their cards land in the same rebuild (no moment without cards).
        crate::restart::herdr_down(&self.ctx, &self.m.h);
        self.ctx.state.herdr_gone();
        self.uses_managed = false;
        self.m.schedule_retry(now_ms());
        let h = &self.m.h;
        let body = if h.restart_held {
            warn!(session = %self.ctx.herdr_session, attempt = h.attempt, "herdr keeps stopping soon after it starts; automatic restarts are held");
            "It kept stopping soon after each start, so TeleFlock stopped restarting it by itself. Restart herdr on the board starts it."
                .to_string()
        } else if h.config.auto_restart {
            "TeleFlock is starting it again and brings the agents back.".to_string()
        } else {
            "Automatic restart is off for this host: Restart herdr on the board starts it.".to_string()
        };
        notify(&self.ctx, NotifyKind::Error, down_title(h), body);
    }

    fn on_new_server(&mut self, outage: bool) {
        let pid = self.m.h.pid;
        // The server's own `HERDR_CONFIG_PATH` (Linux); else whether this worker started it.
        let env = pid.and_then(server_config_env);
        self.uses_managed = match &env {
            Some(v) => v.as_deref().is_some_and(|p| Path::new(p) == self.managed.path),
            None => self.started,
        };
        self.m.h.herdr_resumes = !self.uses_managed && self.managed.server_resumes(env.flatten().as_deref());
        self.m.h.kept_panes = std::mem::take(&mut self.handing_off);
        self.started = false;
        self.pending_stale = saved::Pending::default();
        self.own_stop = false;
        let h = &self.m.h;
        info!(
            session = %self.ctx.herdr_session,
            epoch = h.epoch,
            pid = ?h.pid,
            version = ?h.version,
            kept_panes = h.kept_panes,
            herdr_resumes = h.herdr_resumes,
            outage,
            "herdr server up"
        );
        self.ctx.state.refresh();
        self.cleanup_at = Some(Instant::now() + CLEANUP_AFTER_START);
        if outage {
            // Agent recovery decides which ended agents come back (one that never wrote its
            // session file has nothing to resume), so no count here.
            let body = match (h.ended_agents, h.herdr_resumes) {
                (0, _) => "Its panes are back.".to_string(),
                (_, true) => "herdr relaunches the agents of its panes; TeleFlock continues them.".to_string(),
                (_, false) => "Its panes are back; TeleFlock brings the agents back.".to_string(),
            };
            notify(&self.ctx, NotifyKind::Info, "herdr is running again".into(), body);
        }
    }

    /// Starts the server (automatic restart, Restart herdr, after TeleFlock's own stop).
    async fn start(&mut self) -> bool {
        self.m.start_attempt(now_ms());
        info!(session = %self.ctx.herdr_session, attempt = self.m.h.attempt, "starting herdr");
        self.publish();
        let launch = self.managed.launch();
        self.started = true;
        match self.ctx.herdr.ensure_server_with(&launch).await {
            Ok(_) => {
                self.step().await;
                if self.m.h.state == HerdrServerState::Starting {
                    self.started = false;
                    // It answered the start and was gone again: the same loop as a quick death.
                    self.m.quick_death();
                    self.m.start_failed(now_ms(), "herdr started, then went away".into(), self.own_stop);
                    if self.m.h.restart_held {
                        warn!(session = %self.ctx.herdr_session, "herdr keeps going away right after it starts; automatic restarts are held");
                    }
                }
            }
            Err(e) => {
                self.started = false;
                if self.m.h.attempt <= 3 {
                    warn!(session = %self.ctx.herdr_session, attempt = self.m.h.attempt, "herdr did not start: {e}");
                } else {
                    debug!(session = %self.ctx.herdr_session, attempt = self.m.h.attempt, "herdr did not start: {e}");
                }
                self.m.start_failed(now_ms(), e.message, self.own_stop);
            }
        }
        self.m.h.is_up()
    }

    async fn command(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Restart { force, reply } => {
                let r = self.restart(force).await;
                let _ = reply.send(r);
            }
            Cmd::Load { reply } => {
                let r = self.load(true).await;
                let _ = reply.send(r);
            }
        }
        self.publish();
    }

    async fn restart(&mut self, force: bool) -> Result<(), ApiError> {
        match self.m.h.state {
            HerdrServerState::Down => {
                // Asked for: keep trying even with automatic restarts off, and forgive quick deaths.
                self.own_stop = true;
                self.m.user_start();
                self.start().await;
                Ok(())
            }
            HerdrServerState::Starting | HerdrServerState::Restarting => Ok(()),
            HerdrServerState::Updating => Err(ApiError::new("busy", "herdr is loading an update").retryable()),
            HerdrServerState::Up | HerdrServerState::Unresponsive if !force => Ok(()),
            HerdrServerState::Up | HerdrServerState::Unresponsive => self.stop_and_start(HerdrDownCause::Restart).await.map_err(|e| ApiError::new("herdr_error", e)),
        }
    }

    /// Stops the server (its pane processes end) and starts it again.
    async fn stop_and_start(&mut self, cause: HerdrDownCause) -> Result<(), String> {
        let ended = live_omp(&self.ctx);
        let hung = self.m.h.state == HerdrServerState::Unresponsive;
        let server = self.m.server();
        self.m.begin_restart(now_ms(), cause, ended);
        self.own_stop = true;
        crate::restart::herdr_down(&self.ctx, &self.m.h);
        self.ctx.state.herdr_gone();
        self.uses_managed = false;
        let title = match cause {
            HerdrDownCause::Update => "Restarting herdr to load the installed version".to_string(),
            _ => "Restarting herdr".to_string(),
        };
        let body = if ended > 0 { format!("{} end; TeleFlock brings them back.", plural(ended, "agent", "agents")) } else { "Its terminals end.".into() };
        notify(&self.ctx, NotifyKind::Info, title, body);
        self.publish();
        info!(session = %self.ctx.herdr_session, ?cause, hung, "stopping herdr");
        let stopped = if hung {
            match server {
                Some(id) => terminate(id).await,
                None => Err("the herdr server's process is unknown".into()),
            }
        } else {
            self.ctx.herdr.stop_server().await.map_err(|e| e.message)
        };
        if let Err(e) = &stopped {
            warn!(session = %self.ctx.herdr_session, "herdr did not stop: {e}");
        }
        self.start().await;
        stopped
    }

    // ── loading the installed herdr ──

    fn pending(&self) -> Option<String> {
        let (_, installed) = self.installed.as_ref()?;
        let running = self.m.h.version.as_deref()?;
        idle::newer(installed, running).then(|| installed.clone())
    }

    async fn refresh_installed(&mut self, force: bool) {
        if !force && self.installed_at.is_some_and(|t| t.elapsed() < INSTALLED_EVERY) {
            return;
        }
        self.installed_at = Some(Instant::now());
        let stamp = std::fs::metadata(self.ctx.herdr.binary()).ok().and_then(|m| Some((m.len(), m.modified().ok()?)));
        if !force && self.installed.as_ref().is_some_and(|(s, _)| *s == stamp) {
            return;
        }
        match self.ctx.herdr.installed_version().await {
            Ok(v) => {
                if self.installed.as_ref().is_none_or(|(_, old)| *old != v) {
                    info!(session = %self.ctx.herdr_session, installed = %v, running = ?self.m.h.version, "installed herdr");
                }
                self.installed = Some((stamp, v));
            }
            Err(e) => {
                debug!("herdr --version: {e}");
                self.installed = None;
            }
        }
    }

    fn compute_blockers(&self, mode: HerdrUpdateMode) -> Vec<String> {
        let snap = self.ctx.state.snapshot();
        let shells = if mode == HerdrUpdateMode::Restart { self.ctx.state.pane_shells() } else { HashMap::new() };
        let panes: Vec<idle::PaneFacts> = snap
            .workspaces
            .iter()
            .flat_map(|w| w.tabs.iter())
            .flat_map(|t| t.panes.iter())
            .map(|p| idle::PaneFacts {
                pane_id: p.id.clone(),
                agent_id: p.agent_id.clone(),
                process: p.process.clone(),
                background: shells.get(&p.id).is_some_and(|pid| idle::has_background_jobs(*pid)),
            })
            .collect();
        let mut out = idle::blockers(&snap.agents, &panes, self.ctx.terms.controlled(), mode);
        // Someone looks at the session through herdr's own interface (a live handoff makes its
        // window reconnect): where that can be told, an automatic load waits for it to close.
        let windows = idle::tui_clients(&self.ctx.herdr_session, &self.ctx.herdr.endpoint().socket).unwrap_or(0);
        out.extend(idle::tui_blocker(windows));
        out
    }

    async fn evaluate_update(&mut self) {
        if self.loading {
            return;
        }
        self.refresh_installed(false).await;
        if self.pending().is_none() {
            self.idle_since = None;
            self.blockers.clear();
            return;
        }
        let mode = idle::mode(self.live_handoff);
        if mode != HerdrUpdateMode::Handoff {
            // Without a live handoff, loading stops herdr and ends every agent and terminal: only
            // the user does that (`HerdrUpdateState::Ready`), however idle the session is.
            self.idle_since = None;
            self.blockers.clear();
            return;
        }
        if self.blockers_at.is_none_or(|t| t.elapsed() >= BLOCKERS_EVERY) {
            self.blockers = self.compute_blockers(mode);
            self.blockers_at = Some(Instant::now());
            if self.blockers.is_empty() {
                self.idle_since.get_or_insert(now_ms());
            } else {
                self.idle_since = None;
            }
        }
        let c = &self.m.h.config;
        if c.idle_update
            && let Some(since) = self.idle_since
            && now_ms() >= idle::due_at(since, c.idle_minutes)
            && let Err(e) = self.load(false).await
        {
            debug!(session = %self.ctx.herdr_session, "automatic herdr load: {}", e.message);
        }
    }

    /// Loads the installed herdr into the running server: by live handoff when it supports one,
    /// else stop + start. Automatic loads re-check that nothing is busy right before.
    async fn load(&mut self, manual: bool) -> Result<(), ApiError> {
        if self.loading {
            return Err(ApiError::new("busy", "herdr is already loading an update").retryable());
        }
        if self.m.h.state != HerdrServerState::Up {
            return Err(ApiError::new("unavailable", "herdr is not running").retryable());
        }
        self.refresh_installed(true).await;
        let from = self.m.h.version.clone().unwrap_or_default();
        let Some(to) = self.pending() else {
            return Err(ApiError::new("invalid_params", format!("herdr {from} already runs the installed version")));
        };
        let mode = idle::mode(self.live_handoff);
        if !manual && mode != HerdrUpdateMode::Handoff {
            return Ok(());
        }
        if !manual {
            // Right before acting: a fresh look, and the server must still be the one judged idle.
            let before = self.m.server();
            self.step().await;
            let blockers = self.compute_blockers(mode);
            if !blockers.is_empty() || self.m.server() != before || self.m.h.state != HerdrServerState::Up {
                self.blockers = blockers;
                self.blockers_at = Some(Instant::now());
                self.idle_since = None;
                return Ok(());
            }
        }
        self.loading = true;
        self.result = None;
        self.publish();
        info!(session = %self.ctx.herdr_session, %from, %to, ?mode, manual, "loading the installed herdr");
        let outcome = match mode {
            HerdrUpdateMode::Handoff => self.handoff(&to).await,
            HerdrUpdateMode::Restart => self.restart_for_update(&to).await,
        };
        self.loading = false;
        self.idle_since = None;
        self.blockers_at = None;
        match &outcome {
            Ok(()) => {
                info!(session = %self.ctx.herdr_session, %to, ?mode, "herdr loaded");
                let body = match mode {
                    HerdrUpdateMode::Handoff => "Agents and terminals kept running.".to_string(),
                    HerdrUpdateMode::Restart => "herdr restarted; TeleFlock brings the agents back.".to_string(),
                };
                notify(&self.ctx, NotifyKind::Info, format!("herdr {to} is running"), body);
            }
            Err(e) => {
                warn!(session = %self.ctx.herdr_session, %to, ?mode, "herdr load failed: {e}");
                notify(&self.ctx, NotifyKind::Error, format!("Couldn't load herdr {to}"), e.clone());
            }
        }
        self.result = Some(LoadResult { ok: outcome.is_ok(), from, to, mode, at: now_ms(), error: outcome.as_ref().err().cloned() });
        outcome.map_err(|e| ApiError::new("herdr_error", e))
    }

    async fn handoff(&mut self, to: &str) -> Result<(), String> {
        self.m.begin_update(now_ms());
        self.handing_off = true;
        self.publish();
        let params = LiveHandoff { import_exe: Some(self.ctx.herdr.binary().display().to_string()), expected_version: Some(to.to_string()) };
        match self.ctx.herdr.live_handoff(&params).await {
            Ok(()) => {}
            // The old server may close the connection as it hands over: see who answers.
            Err(e) if e.code == tf_herdr::code::TRANSPORT => debug!("live handoff answer lost: {e}"),
            Err(e) => {
                // herdr rolled back: the old server kept its panes.
                self.handing_off = false;
                self.m.end_update(now_ms());
                return Err(format!("herdr refused the handoff: {}", e.message));
            }
        }
        let deadline = Instant::now() + HANDOFF_CONFIRM;
        while Instant::now() < deadline {
            match self.step().await {
                Some(Change::NewServer { .. }) => {
                    return match self.m.h.version.as_deref() {
                        Some(v) if v == to => Ok(()),
                        v => Err(format!("the new herdr server reports {}", v.unwrap_or("no version"))),
                    };
                }
                Some(Change::WentDown) => {
                    self.handing_off = false;
                    return Err("the herdr server went away during the handoff".into());
                }
                _ => tokio::time::sleep(Duration::from_millis(250)).await,
            }
        }
        self.handing_off = false;
        self.m.end_update(now_ms());
        Err(format!("herdr did not finish the handoff within {} s; the old server keeps running", HANDOFF_CONFIRM.as_secs()))
    }

    async fn restart_for_update(&mut self, to: &str) -> Result<(), String> {
        let stopped = self.stop_and_start(HerdrDownCause::Update).await;
        match (self.m.h.state, self.m.h.version.as_deref()) {
            (HerdrServerState::Up, Some(v)) if v == to => Ok(()),
            (HerdrServerState::Up, v) => Err(match stopped {
                Err(e) => format!("herdr did not stop: {e}"),
                Ok(()) => format!("herdr restarted, but the server reports {}", v.unwrap_or("no version")),
            }),
            _ => Err(self.m.h.error.clone().unwrap_or_else(|| "herdr did not start again; TeleFlock keeps trying".into())),
        }
    }

    fn update_view(&self, now: Millis) -> Option<HerdrUpdate> {
        let from = self.m.h.version.clone().unwrap_or_default();
        let mode = idle::mode(self.live_handoff);
        if self.loading {
            let to = self.pending().unwrap_or_default();
            return Some(HerdrUpdate { state: HerdrUpdateState::Running, from, to, mode, idle_since: None, due_at: None, blockers: vec![], at: None, error: None });
        }
        if self.m.h.state == HerdrServerState::Up
            && let Some(to) = self.pending()
        {
            let c = &self.m.h.config;
            let failed = self.result.as_ref().filter(|r| !r.ok && r.to == to);
            let state = idle::update_state(failed.is_some(), c.idle_update, mode);
            return Some(HerdrUpdate {
                state,
                from,
                to,
                mode,
                idle_since: self.idle_since,
                due_at: self.idle_since.filter(|_| c.idle_update).map(|s| idle::due_at(s, c.idle_minutes)),
                blockers: self.blockers.clone(),
                at: failed.map(|r| r.at),
                error: failed.and_then(|r| r.error.clone()),
            });
        }
        let r = self.result.as_ref().filter(|r| r.ok && now - r.at < RESULT_KEPT)?;
        Some(HerdrUpdate {
            state: HerdrUpdateState::Done,
            from: r.from.clone(),
            to: r.to.clone(),
            mode: r.mode,
            idle_since: None,
            due_at: None,
            blockers: vec![],
            at: Some(r.at),
            error: None,
        })
    }

    // ── upkeep while up ──

    /// Keeps the managed config equal to the user's and reloads it into a server that reads it.
    async fn sync_config(&mut self) {
        match self.managed.sync() {
            Ok(true) if self.uses_managed => {
                info!(session = %self.ctx.herdr_session, "herdr config changed; reloading it in the server");
                if let Err(e) = self.ctx.herdr.request::<Value>("server.reload_config", json!({})).await {
                    warn!(session = %self.ctx.herdr_session, "herdr reload-config: {e}");
                }
            }
            Ok(_) => {}
            Err(e) => debug!(file = %self.managed.path.display(), "herdr managed config: {e}"),
        }
        if !self.managed.edited() {
            self.edited_notified = false;
        } else if !std::mem::replace(&mut self.edited_notified, true) {
            warn!(session = %self.ctx.herdr_session, file = %self.managed.path.display(), "herdr's managed config was edited; keeping it and no longer copying the user's config into it");
            notify(
                &self.ctx,
                NotifyKind::Info,
                "herdr's managed config was edited".into(),
                format!(
                    "Changes to {} are kept, so TeleFlock no longer copies your herdr config into it. Delete that file to start copying again.",
                    self.managed.path.display()
                ),
            );
        }
    }

    /// Clears saved agent sessions whose files are gone ([`saved`]). A session whose file is
    /// missing is only cleared when it has been missing for [`saved::GRACE_MS`]: an agent that
    /// just started has no file until omp's first reply, and its pane may show no agent for a moment.
    async fn cleanup(&mut self) {
        if self.cleanup_at.is_some_and(|t| Instant::now() < t) {
            return;
        }
        self.cleanup_at = Some(Instant::now() + CLEANUP_EVERY);
        let Ok(panes) = self.ctx.herdr.pane_list(None).await else { return };
        let found = tokio::task::spawn_blocking(move || saved::stale(&panes, saved::missing)).await.unwrap_or_default();
        let (due, waiting) = self.pending_stale.due(found, now_ms(), saved::GRACE_MS);
        if waiting {
            self.cleanup_at = Some(Instant::now() + Duration::from_millis(saved::GRACE_MS as u64 + 5_000));
        }
        for s in due {
            info!(session = %self.ctx.herdr_session, pane = s.pane, source = s.source, "clearing herdr's saved agent session: its session file is gone");
            let params = json!({ "pane_id": s.pane, "source": s.source, "agent": s.agent });
            if let Err(e) = self.ctx.herdr.request::<Value>("pane.release_agent", params).await {
                debug!(pane = s.pane, "pane.release_agent: {e}");
            }
        }
    }
}

// ───────────────────────────── helpers ─────────────────────────────

/// omp agents the board shows live (not parked).
fn live_omp(ctx: &Ctx) -> u32 {
    ctx.state.snapshot().agents.iter().filter(|a| a.kind == "omp" && a.parked.is_none() && !a.pane_id.is_empty()).count() as u32
}

fn plural(n: u32, one: &str, many: &str) -> String {
    if n == 1 { format!("1 {one}") } else { format!("{n} {many}") }
}

fn hhmm(at: Millis) -> String {
    use chrono::TimeZone;
    chrono::Local.timestamp_millis_opt(at).single().map(|t| t.format("%H:%M").to_string()).unwrap_or_default()
}

/// "herdr stopped at 13:58 · 9 agents ended".
fn down_title(h: &HerdrHealth) -> String {
    let what = match h.cause {
        Some(HerdrDownCause::Crashed) => "herdr crashed",
        _ => "herdr stopped",
    };
    let at = h.down_at.map(|t| format!(" at {}", hhmm(t))).unwrap_or_default();
    match h.ended_agents {
        0 => format!("{what}{at}"),
        n => format!("{what}{at} · {} ended", plural(n, "agent", "agents")),
    }
}

fn notify(ctx: &Ctx, kind: NotifyKind, title: String, body: String) {
    ctx.state.broadcast_notification(Notification {
        id: new_id("n"),
        at: now_ms(),
        kind,
        agent_id: String::new(),
        title,
        body,
        request_id: None,
        actions: vec![],
    });
}

/// The server process's `HERDR_CONFIG_PATH`: `Some(None)` when it has none, `None` when its
/// environment cannot be read (not Linux).
fn server_config_env(pid: u32) -> Option<Option<String>> {
    let environ = std::fs::read(format!("/proc/{pid}/environ")).ok()?;
    Some(tf_herdr::lifecycle::environ_value(&environ, managed::ENV))
}

/// Whether the process of a server instance still exists (`None`: unknown).
fn alive(id: ServerId) -> Option<bool> {
    let pid = id.pid?;
    #[cfg(target_os = "linux")]
    {
        Some(match tf_herdr::lifecycle::process_start_ticks(pid) {
            Some(t) => id.start.is_none_or(|s| s == t),
            None => false,
        })
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        // SAFETY: signal 0 only checks that the process exists.
        let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
        Some(r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
    }
    #[cfg(windows)]
    {
        let _ = pid;
        None
    }
}

/// Stops a server that no longer answers: SIGTERM, SIGKILL after [`TERM_WAIT`]. Only a process that
/// is still the same herdr server (pid and start time; its executable a herdr binary).
async fn terminate(id: ServerId) -> Result<(), String> {
    #[cfg(unix)]
    {
        let pid = id.pid.ok_or("the herdr server's process is unknown")?;
        if alive(id) != Some(true) {
            return Ok(());
        }
        #[cfg(target_os = "linux")]
        {
            let exe = tf_herdr::lifecycle::process_exe(pid);
            let name = exe.as_ref().and_then(|e| e.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if !name.starts_with("herdr") {
                return Err(format!("process {pid} is not a herdr server ({name})"));
            }
        }
        for (signal, wait) in [(libc::SIGTERM, TERM_WAIT), (libc::SIGKILL, Duration::from_secs(5))] {
            // SAFETY: plain kill(2) on a pid checked right above.
            unsafe { libc::kill(pid as libc::pid_t, signal) };
            let deadline = Instant::now() + wait;
            while Instant::now() < deadline {
                if alive(id) != Some(true) {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
        Err(format!("herdr server {pid} did not exit"))
    }
    #[cfg(windows)]
    {
        let _ = id;
        Err("an unresponsive herdr can't be stopped from TeleFlock on Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_and_errors() {
        let mut h = HerdrHealth::unknown(0, HerdrGuardConfig::default());
        h.epoch = 3;
        h.down_at = Some(1_761_746_280_000);
        h.cause = Some(HerdrDownCause::Stopped);
        h.ended_agents = 9;
        let title = down_title(&h);
        assert!(title.starts_with("herdr stopped at ") && title.ends_with(" · 9 agents ended"), "{title}");
        h.cause = Some(HerdrDownCause::Crashed);
        h.ended_agents = 1;
        assert!(down_title(&h).starts_with("herdr crashed at ") && down_title(&h).ends_with("1 agent ended"));
        h.ended_agents = 0;
        assert!(!down_title(&h).contains('·'));

        let e = down_api_error(Some(&h));
        assert_eq!(e.code, "herdr_down");
        assert!(e.retryable);
        assert!(e.message.starts_with("herdr crashed"), "{}", e.message);
        assert!(down_api_error(None).message.contains("isn't running"));
        assert!(is_connect_failure(
            "transport: herdr: failed to connect to server: No such file or directory (os error 2) Is herdr server running?"
        ));
        assert!(is_connect_failure("no herdr server is reachable at /x/herdr.sock: refused"));
        assert!(!is_connect_failure("agent_blocked"));
    }

    #[test]
    fn settings_persist_and_validate() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("herdr.json");
        let s = Settings { file: Some(file.clone()), stored: Stored { config: None, sessions: vec!["default".into()] }, tx: watch::channel(HerdrGuardConfig::default()).0 };
        save(&s);
        let back: Stored = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(back.sessions, ["default"]);
        assert!(back.config.is_none());
        assert!(set_config(&HerdrConfigParams { auto_restart: None, idle_update: None, idle_minutes: Some(0) }).is_err());
        assert!(set_config(&HerdrConfigParams { auto_restart: None, idle_update: None, idle_minutes: Some(1441) }).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn liveness_follows_pid_and_start_time() {
        let me = std::process::id();
        let start = tf_herdr::lifecycle::process_start_ticks(me);
        assert!(start.is_some());
        assert_eq!(alive(ServerId { pid: Some(me), start }), Some(true));
        assert_eq!(alive(ServerId { pid: Some(me), start: start.map(|s| s + 1) }), Some(false), "a reused pid is another process");
        assert_eq!(alive(ServerId { pid: None, start: None }), None);
        assert_eq!(server_config_env(me).map(|v| v.is_some()), Some(std::env::var_os(managed::ENV).is_some()));
    }
}
