//! Auto-resume tickets (architecture §3.22, §3.25): an omp session whose agent, or subagents,
//! stopped on something that passes (a provider usage or rate limit) or were cut off mid-turn (a
//! host restart or crash), whether it resumes by itself, and the Resume / Continue and Don't /
//! Dismiss controls. One service per daemon; tickets are kept per herdr session and keyed by the
//! root omp session id, in `<home>/autoresume.json` (owner-only, atomic writes).
//!
//! The API is small on purpose; noticing what stopped an agent lives with each kind:
//! * [`get`]: the daemon's [`Recovery`] once [`start`] ran (`None` in unit tests of other modules).
//! * [`Recovery::enabled`], [`Recovery::set_enabled`], [`Recovery::subscribe`]: the host setting
//!   (`host.autoResume` / `host.autoResumeSet`, default on). Off: every ticket waits for Resume.
//! * [`Recovery::open`]: opens or refreshes a ticket. It resumes by itself at `resume_at` while the
//!   setting is on (`waiting`), else waits for Resume (`manual`). A refresh keeps `since`,
//!   `attempts` and a `Don't`.
//! * [`Recovery::close`]: drops a ticket (the session works again, or the kind's detection says
//!   it is over).
//! * [`attach`]: the board rebuild puts `Agent.autoResume` on every card, live or parked, whose
//!   omp session (id, else file) has a ticket.
//! * The worker resumes due tickets through [`execute`] (`restart` → `crate::restart`; limits →
//!   the bridge's `resumeTree`, else omp's F5) and closes a ticket once its agent works again by
//!   other means (a prompt, the TUI, herdr's own restore) or is marked done, and one whose session
//!   no card shows any more after [`ORPHAN_MS`].
//! * Methods: `agent.autoResumeNow` ([`resume_now`]), `agent.autoResumeCancel` ([`cancel`]),
//!   `host.autoResume` ([`config`]), `host.autoResumeSet` ([`set_config`]).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::{watch, Notify};
use tracing::{info, warn};

use tf_proto::autoresume::{AutoResume, AutoResumeConfig, AutoResumeKind, AutoResumeStatus, ResumeBasis, RetryResult, RetryVia};
use tf_proto::model::{ActivityKind, Agent, HerdrState};
use tf_proto::{ApiError, Millis};

use crate::daemon::Daemon;
use crate::ops::Ctx;
use crate::paths::write_atomic;
use crate::util::{clip, now_ms};

pub const FILE: &str = "autoresume.json";
/// The worker looks at the boards at least this often (tickets to close or sweep).
const TICK: Duration = Duration::from_secs(5);
/// A ticket whose omp session no card shows is dropped after this long (a new session, a pruned
/// card, an agent closed for good).
pub const ORPHAN_MS: Millis = 10 * 60_000;
/// An agent that has been working this long resumed by other means: its ticket closes.
const WORKING_MS: Millis = 3_000;
/// Automatic tries after a retryable failure (`busy`, a bridge still connecting), 30 s apart × n.
const AUTO_TRIES: u32 = 3;
const RETRY_STEP_MS: Millis = 30_000;
/// Bridge ops of the limit kinds.
const BRIDGE_TIMEOUT: Duration = Duration::from_secs(30);
/// Error code an executor answers after re-opening its ticket with a later `resume_at` (too early:
/// e.g. a usage window still exhausted): the try is not counted.
pub const RESCHEDULED: &str = "rescheduled";
/// Error code of an executor whose agent's omp went away (its pane closed, its process exited):
/// the ticket waits for Resume, saying why (the error's message).
pub const GONE: &str = "gone";
/// How long a dismissed limit ticket keeps `failedTails` from bringing its stop back.
const DISMISSED_KEEP_MS: Millis = 24 * 3_600_000;

static GLOBAL: OnceLock<Arc<Recovery>> = OnceLock::new();

/// The daemon's recovery service (absent until [`start`] ran).
pub fn get() -> Option<Arc<Recovery>> {
    GLOBAL.get().cloned()
}

/// One auto-resume ticket (what `<home>/autoresume.json` keeps; `Agent.autoResume` on the wire).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ticket {
    pub kind: AutoResumeKind,
    /// What stopped the agents, one line.
    pub reason: String,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// When it resumes by itself (while the setting is on and nobody said Don't).
    #[serde(default)]
    pub resume_at: Option<Millis>,
    #[serde(default)]
    pub basis: Option<ResumeBasis>,
    pub since: Millis,
    #[serde(default)]
    pub attempts: u32,
    /// The agent itself stopped (else only subagents did).
    #[serde(default)]
    pub root: bool,
    #[serde(default)]
    pub subagent_ids: Vec<String>,
    /// The session's file: cards that only know the file (a parked card from an older build)
    /// still match, and a restart relaunches it.
    #[serde(default)]
    pub session_file: Option<String>,
    /// Why it does not resume by itself (the user said Don't, or tries failed); `None`: it
    /// follows the host setting.
    #[serde(default)]
    pub manual: Option<String>,
    /// Since when no card shows its session (in memory).
    #[serde(skip)]
    missing_since: Option<Millis>,
}

/// What a kind's detection knows when it opens a ticket ([`Recovery::open`]).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TicketInit {
    pub reason: String,
    pub session_file: Option<String>,
    pub root: bool,
    pub subagent_ids: Vec<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    /// Earliest automatic resume; `None`: as soon as the worker sees it.
    pub resume_at: Option<Millis>,
    pub basis: Option<ResumeBasis>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Data {
    enabled: bool,
    /// Bring agents back after a reboot: lets the agent ledger install the boot-time service.
    bring_back: bool,
    /// herdr session → root omp session id → ticket.
    sessions: BTreeMap<String, BTreeMap<String, Ticket>>,
    /// Root omp session id → when the user dismissed its limit ticket: what failed before that does
    /// not come back with `failedTails` after a hostd restart. Kept a day.
    dismissed: BTreeMap<String, Millis>,
    /// Why both settings are off although the user may never have turned them off: the file that
    /// kept them could not be read ([`load`]). Shown with the setting until the user changes it.
    notice: Option<String>,
}

impl Default for Data {
    fn default() -> Self {
        Self { enabled: true, bring_back: true, sessions: BTreeMap::new(), dismissed: BTreeMap::new(), notice: None }
    }
}

pub struct Recovery {
    file: PathBuf,
    daemon: Weak<Daemon>,
    data: Mutex<Data>,
    /// `(herdr session, omp session id)` being resumed now (`resuming`).
    running: Mutex<HashSet<(String, String)>>,
    /// The contexts the worker looks at (registered by [`register`]).
    ctxs: Mutex<HashMap<String, Weak<Ctx>>>,
    setting: watch::Sender<bool>,
    wake: Notify,
}

/// Starts the service (`daemon::async_main`): loads the tickets, starts the contexts of herdr
/// sessions with tickets that resume by themselves (so a restarted daemon resumes them with no app
/// connected), and runs the worker.
pub fn start(daemon: &Arc<Daemon>) {
    let file = daemon.paths.home.join(FILE);
    let data = load(&file);
    let (setting, _) = watch::channel(data.enabled);
    let r = Arc::new(Recovery {
        file,
        daemon: Arc::downgrade(daemon),
        data: Mutex::new(data),
        running: Mutex::new(HashSet::new()),
        ctxs: Mutex::new(HashMap::new()),
        setting,
        wake: Notify::new(),
    });
    if GLOBAL.set(r.clone()).is_err() {
        return;
    }
    let shutdown = daemon.shutdown.child_token();
    tokio::spawn(async move {
        tokio::select! {
            _ = shutdown.cancelled() => {}
            _ = worker(r) => {}
        }
    });
}

/// The tickets and settings. No file: the defaults (auto-resume on, bring back on). A file that
/// exists but cannot be read or parsed is copied to `autoresume.json.bad-<ms>` (when it can be)
/// and the host **fails closed**: auto-resume and bring-back are off until the user switches them
/// on, with a notice saying why. The file held the user's decisions (an opt-out, a Don't on a
/// ticket); not knowing them, nothing may run unattended, nothing may start a boot service. The
/// closed state replaces the damaged file at once in one atomic step. The primary is never moved
/// away, so there is no moment without a file (a crash in between would load as "no file":
/// defaults on): the next start, with nothing changed in between, loads the closed state.
fn load(file: &std::path::Path) -> Data {
    let why = match std::fs::read(file) {
        Ok(bytes) => match serde_json::from_slice::<Data>(&bytes) {
            Ok(data) => return data,
            Err(e) => e.to_string(),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Data::default(),
        Err(e) => format!("read: {e}"),
    };
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    fail_closed(file, &why, &file.with_file_name(format!("{name}.bad-{}", now_ms())))
}

/// The fail-closed settings of a damaged `file`: its bytes copied to `copy` when possible (a
/// failure is logged and the file is replaced anyway), then replaced atomically.
fn fail_closed(file: &std::path::Path, why: &str, copy: &std::path::Path) -> Data {
    let kept = match std::fs::copy(file, copy) {
        Ok(_) => format!("The damaged file was kept as {}.", copy.display()),
        Err(e) => {
            tracing::error!(file = %file.display(), "the damaged auto-resume settings could not be copied aside ({e})");
            "The damaged file could not be kept.".to_string()
        }
    };
    tracing::error!(file = %file.display(), "the auto-resume settings are unreadable ({why}); the host fails closed. {kept}");
    let data = Data {
        enabled: false,
        bring_back: false,
        notice: Some(format!("The auto-resume settings file could not be read ({why}), so auto-resume and bringing agents back after a reboot are off on this host until you switch them on. {kept}")),
        ..Data::default()
    };
    match serde_json::to_vec(&data).map_err(std::io::Error::other).and_then(|b| crate::paths::write_atomic(file, &b)) {
        Ok(()) => {}
        Err(e) => tracing::error!(file = %file.display(), "writing the fail-closed auto-resume settings: {e}"),
    }
    data
}

/// A context the worker follows (board, executor); called when it starts (`Ctx::create`).
pub fn register(ctx: &Arc<Ctx>) {
    if let Some(r) = get() {
        r.ctxs_lock().insert(ctx.herdr_session.clone(), Arc::downgrade(ctx));
        r.mark_dirty(&ctx.herdr_session);
    }
}

impl Recovery {
    fn lock(&self) -> MutexGuard<'_, Data> {
        self.data.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn ctxs_lock(&self) -> MutexGuard<'_, HashMap<String, Weak<Ctx>>> {
        self.ctxs.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn running_lock(&self) -> MutexGuard<'_, HashSet<(String, String)>> {
        self.running.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The host's auto-resume setting.
    pub fn enabled(&self) -> bool {
        self.lock().enabled
    }

    /// Follows the setting (bridges get it with `setAutoResume`, `crate::limit_resume`).
    pub fn subscribe(&self) -> watch::Receiver<bool> {
        self.setting.subscribe()
    }

    /// The host lets tf-hostd install a boot-time service so agents come back after a reboot with
    /// no app connected (default on; `crate::automations` keeps its own units regardless).
    pub fn bring_back(&self) -> bool {
        self.lock().bring_back
    }

    /// Why the settings are off though the user may not have turned them off (the settings file was
    /// unreadable); until they set them again.
    pub fn notice(&self) -> Option<String> {
        self.lock().notice.clone()
    }

    /// Turning it off removes the units the agent ledger asked for ([`crate::restart::wants_keepalive`]).
    pub fn set_bring_back(&self, on: bool) -> std::io::Result<()> {
        {
            let mut d = self.lock();
            let cleared = d.notice.take().is_some();
            if d.bring_back == on {
                drop(d);
                return if cleared { self.save() } else { Ok(()) };
            }
            d.bring_back = on;
        }
        info!(on, "bring-agents-back-after-a-reboot setting changed");
        let saved = self.save();
        if let Some(a) = crate::automations::get() {
            tokio::spawn(async move { a.sync_keepalive().await });
        }
        saved
    }

    pub fn set_enabled(&self, enabled: bool) -> std::io::Result<()> {
        let sessions: Vec<String> = {
            let mut d = self.lock();
            let cleared = d.notice.take().is_some();
            if d.enabled == enabled {
                drop(d);
                return if cleared { self.save() } else { Ok(()) };
            }
            d.enabled = enabled;
            d.sessions.keys().cloned().collect()
        };
        info!(enabled, "auto-resume setting changed");
        let saved = self.save();
        self.setting.send_replace(enabled);
        for s in sessions {
            self.mark_dirty(&s);
        }
        self.wake.notify_one();
        saved
    }

    /// Opens a ticket for `session_id` (root omp session) of herdr session `session`, or refreshes
    /// the one it has (a refresh keeps `since`, `attempts` and a Don't). True when it is new.
    pub fn open(&self, session: &str, kind: AutoResumeKind, session_id: &str, init: TicketInit) -> bool {
        let now = now_ms();
        let new = {
            let mut d = self.lock();
            let tickets = d.sessions.entry(session.to_string()).or_default();
            match tickets.get_mut(session_id) {
                Some(t) if t.kind == kind => {
                    t.reason = init.reason;
                    t.session_file = init.session_file.or(t.session_file.take());
                    t.root = init.root;
                    t.subagent_ids = init.subagent_ids;
                    t.provider = init.provider;
                    t.model = init.model;
                    t.resume_at = init.resume_at;
                    t.basis = init.basis;
                    t.missing_since = None;
                    false
                }
                _ => {
                    tickets.insert(
                        session_id.to_string(),
                        Ticket {
                            kind,
                            reason: init.reason,
                            provider: init.provider,
                            model: init.model,
                            resume_at: init.resume_at,
                            basis: init.basis,
                            since: now,
                            attempts: 0,
                            root: init.root,
                            subagent_ids: init.subagent_ids,
                            session_file: init.session_file,
                            manual: None,
                            missing_since: None,
                        },
                    );
                    true
                }
            }
        };
        if new {
            info!(session, session_id, ?kind, "auto-resume ticket opened");
        }
        self.changed(session);
        new
    }

    /// Drops the ticket of `session_id` when it is of `kind` (any kind: `None`). True when one went.
    pub fn close(&self, session: &str, session_id: &str, kind: Option<AutoResumeKind>) -> bool {
        let gone = {
            let mut d = self.lock();
            let Some(tickets) = d.sessions.get_mut(session) else { return false };
            let gone = tickets.get(session_id).is_some_and(|t| kind.is_none_or(|k| t.kind == k)) && tickets.remove(session_id).is_some();
            if tickets.is_empty() {
                d.sessions.remove(session);
            }
            gone
        };
        if gone {
            info!(session, session_id, "auto-resume ticket closed");
            self.changed(session);
        }
        gone
    }

    /// Makes the ticket of `session_id` wait for Resume, `why` saying so (unless it already does).
    pub fn hold(&self, session: &str, session_id: &str, why: String) -> bool {
        let held = {
            let mut d = self.lock();
            match d.sessions.get_mut(session).and_then(|s| s.get_mut(session_id)) {
                Some(t) if t.manual.is_none() => {
                    t.manual = Some(why);
                    true
                }
                _ => false,
            }
        };
        if held {
            self.changed(session);
        }
        held
    }

    /// Opens the `restart` ticket of an ended card (`crate::restart`). A card that ended is gone
    /// for good as far as a limit ticket goes (its omp is not there to resume): the limit ticket
    /// makes way for the restart, which waits at least until the limit's `resume_at` and keeps a
    /// Don't the user said. `hold` makes a new ticket wait for Continue (it keeps ending, or it
    /// was stopped on purpose). An existing restart ticket stays as it is. True when one was opened.
    pub fn open_restart(&self, session: &str, session_id: &str, init: TicketInit, hold: Option<String>) -> bool {
        let now = now_ms();
        {
            let mut d = self.lock();
            let tickets = d.sessions.entry(session.to_string()).or_default();
            let (mut resume_at, mut manual) = (init.resume_at, hold);
            if let Some(t) = tickets.get(session_id) {
                if t.kind == AutoResumeKind::Restart {
                    return false;
                }
                resume_at = resume_at.max(t.resume_at);
                if let Some(m) = t.manual.clone().filter(|m| m != crate::limit_resume::OMP_GONE) {
                    manual = Some(m);
                }
            }
            tickets.insert(
                session_id.to_string(),
                Ticket {
                    kind: AutoResumeKind::Restart,
                    reason: init.reason,
                    provider: None,
                    model: None,
                    resume_at,
                    basis: None,
                    since: now,
                    attempts: 0,
                    root: init.root,
                    subagent_ids: init.subagent_ids,
                    session_file: init.session_file,
                    manual,
                    missing_since: None,
                },
            );
        }
        info!(session, session_id, "auto-resume ticket opened (restart of an ended card)");
        self.changed(session);
        true
    }

    /// A due ticket that found it too early (a usage window still exhausted) resumes at `at`.
    fn reschedule(&self, session: &str, session_id: &str, at: Millis, basis: ResumeBasis) {
        if let Some(t) = self.lock().sessions.get_mut(session).and_then(|s| s.get_mut(session_id)) {
            t.resume_at = Some(at);
            t.basis = Some(basis);
        }
        self.changed(session);
    }

    /// When the user dismissed the limit ticket of root omp session `session_id` (within a day).
    pub fn dismissed_at(&self, session_id: &str) -> Option<Millis> {
        self.lock().dismissed.get(session_id).copied()
    }

    /// The ticket of a root omp session.
    pub fn ticket(&self, session: &str, session_id: &str) -> Option<Ticket> {
        self.lock().sessions.get(session)?.get(session_id).cloned()
    }

    fn changed(&self, session: &str) {
        if let Err(e) = self.save() {
            warn!("saving auto-resume tickets: {e}");
        }
        self.mark_dirty(session);
        self.wake.notify_one();
    }

    fn save(&self) -> std::io::Result<()> {
        let bytes = {
            let d = self.lock();
            serde_json::to_vec(&*d).map_err(std::io::Error::other)?
        };
        write_atomic(&self.file, &bytes)
    }

    fn ctx(&self, session: &str) -> Option<Arc<Ctx>> {
        self.ctxs_lock().get(session).and_then(Weak::upgrade)
    }

    fn mark_dirty(&self, session: &str) {
        if let Some(ctx) = self.ctx(session) {
            ctx.state.mark_dirty();
        }
    }

    /// The wire form of a ticket.
    fn wire(&self, t: &Ticket, enabled: bool, notice: Option<&str>, running: bool) -> AutoResume {
        let (status, reason, resume_at) = if running {
            (AutoResumeStatus::Resuming, t.reason.clone(), None)
        } else if let Some(why) = &t.manual {
            (AutoResumeStatus::Manual, why.clone(), None)
        } else if !enabled {
            (AutoResumeStatus::Manual, notice.unwrap_or("Auto-resume is off on this host").to_string(), None)
        } else {
            (AutoResumeStatus::Waiting, t.reason.clone(), t.resume_at)
        };
        AutoResume {
            status,
            kind: t.kind,
            reason,
            provider: t.provider.clone(),
            model: t.model.clone(),
            resume_at,
            basis: t.basis,
            since: t.since,
            attempts: t.attempts,
            root: t.root,
            subagent_ids: t.subagent_ids.clone(),
        }
    }

    fn attach_to(&self, session: &str, agents: &mut [Agent]) {
        let running = self.running_lock().clone();
        let d = self.lock();
        let Some(tickets) = d.sessions.get(session).filter(|t| !t.is_empty()) else { return };
        let by_file: HashMap<&str, &str> =
            tickets.iter().filter_map(|(sid, t)| t.session_file.as_deref().filter(|f| !f.is_empty()).map(|f| (f, sid.as_str()))).collect();
        for a in agents.iter_mut() {
            let Some(o) = &a.omp else { continue };
            let sid = o
                .session_id
                .as_deref()
                .filter(|s| tickets.contains_key(*s))
                .or_else(|| o.session_file.as_deref().filter(|f| !f.is_empty()).and_then(|f| by_file.get(f).copied()));
            if let Some(sid) = sid {
                let t = &tickets[sid];
                a.auto_resume = Some(self.wire(t, d.enabled, d.notice.as_deref(), running.contains(&(session.to_string(), sid.to_string()))));
            }
        }
    }

    /// Tickets due now: waiting (setting on, no Don't, not running) with `resume_at` passed; and
    /// the earliest future `resume_at`.
    fn due(&self, now: Millis) -> (Vec<(String, String)>, Option<Millis>) {
        let running = self.running_lock().clone();
        let d = self.lock();
        if !d.enabled {
            return (Vec::new(), None);
        }
        let mut due = Vec::new();
        let mut next: Option<Millis> = None;
        for (session, tickets) in &d.sessions {
            for (sid, t) in tickets {
                if t.manual.is_some() || running.contains(&(session.clone(), sid.clone())) {
                    continue;
                }
                match t.resume_at {
                    Some(at) if at > now => next = Some(next.map_or(at, |n| n.min(at))),
                    _ => due.push((session.clone(), sid.clone())),
                }
            }
        }
        (due, next)
    }

    /// Closes tickets whose agent works again, was marked done or moved to another host, sweeps
    /// those no card shows, keeps the stopped subagents of an agent that works again, and holds
    /// limit tickets whose omp went away.
    fn maintain(&self, session: &str, agents: &[Agent], now: Millis) {
        let running = self.running_lock().clone();
        let mut closed: Vec<(String, Option<String>, String)> = Vec::new();
        let mut changed = false;
        {
            let mut d = self.lock();
            let Some(tickets) = d.sessions.get_mut(session) else { return };
            for (sid, t) in tickets.iter_mut() {
                if running.contains(&(session.to_string(), sid.clone())) {
                    continue;
                }
                match agents.iter().find(|a| shows_ticket(a, sid, t)) {
                    None => {
                        let since = *t.missing_since.get_or_insert(now);
                        if now - since >= ORPHAN_MS {
                            closed.push((sid.clone(), None, "no card shows its session any more".into()));
                        }
                    }
                    Some(a) => {
                        t.missing_since = None;
                        if a.parked.as_ref().is_some_and(|p| p.moved.is_some()) {
                            // Its session goes on on another host (`ops::moves`): never resumed here.
                            closed.push((sid.clone(), Some(a.id.clone()), "moved to another host".into()));
                        } else if a.archived {
                            closed.push((sid.clone(), Some(a.id.clone()), "marked done".into()));
                        } else if a.parked.is_none() && (t.root || t.kind == AutoResumeKind::Restart) && working(a, now) {
                            if t.kind != AutoResumeKind::Restart && !t.subagent_ids.is_empty() {
                                // The agent goes on (its own turn resumed by other means); its stopped
                                // subagents still resume at their time. (Only subagents stopped: their
                                // parent working says nothing about them.)
                                t.root = false;
                                changed = true;
                            } else {
                                closed.push((sid.clone(), Some(a.id.clone()), "working again".into()));
                            }
                        } else if t.kind != AutoResumeKind::Restart && t.manual.is_none() && !ended(a) && crate::limit_resume::omp_gone(a) {
                            t.manual = Some(crate::limit_resume::OMP_GONE.into());
                            changed = true;
                        }
                    }
                }
            }
            for (sid, _, _) in &closed {
                tickets.remove(sid);
            }
            if tickets.is_empty() {
                d.sessions.remove(session);
            }
        }
        for (sid, agent, why) in &closed {
            info!(session, session_id = %sid, agent = agent.as_deref().unwrap_or(""), "auto-resume ticket closed: {why}");
        }
        if !closed.is_empty() || changed {
            self.changed(session);
        }
    }

    /// Runs one ticket now (the worker, or `agent.autoResumeNow`) and records the outcome.
    async fn run(self: &Arc<Self>, session: &str, session_id: &str) -> Result<RetryResult, ApiError> {
        let Some(ticket) = self.ticket(session, session_id) else {
            return Err(ApiError::new("not_found", "nothing to resume for this agent"));
        };
        let key = (session.to_string(), session_id.to_string());
        if !self.running_lock().insert(key.clone()) {
            return Err(ApiError::new("busy", "it is being resumed right now").retryable());
        }
        self.mark_dirty(session);
        let ctx = match self.ctx(session) {
            Some(c) => Some(c),
            None => match self.daemon.upgrade() {
                Some(d) => d.ctx_for(session).await.ok(),
                None => None,
            },
        };
        let res = match ctx {
            Some(ctx) => execute(&ctx, session_id, &ticket).await,
            None => Err(ApiError::new("not_connected", format!("herdr session `{session}` is not available")).retryable()),
        };
        self.running_lock().remove(&key);
        self.finish(session, session_id, &ticket, &res);
        res
    }

    /// Applies the outcome of a run: closes the ticket once something started, else counts the
    /// failure (a retryable one is tried again by itself a few times, 30 s × n apart). An executor
    /// that found it too early re-opens the ticket with a later `resume_at` and answers
    /// [`RESCHEDULED`]: nothing is counted.
    fn finish(&self, session: &str, session_id: &str, ticket: &Ticket, res: &Result<RetryResult, ApiError>) {
        let now = now_ms();
        match res {
            Err(e) if e.code == RESCHEDULED => {
                info!(session, session_id, kind = ?ticket.kind, "auto-resume rescheduled: {}", e.message);
                self.changed(session);
            }
            Ok(r) => {
                info!(session, session_id, started = r.started, via = ?r.via, kind = ?ticket.kind, "auto-resume ran");
                self.close(session, session_id, None);
                if r.started && ticket.kind != AutoResumeKind::Restart {
                    crate::limit_resume::resumed(session_id, now);
                }
                self.activity(session, session_id, ticket, r.started, None);
            }
            Err(e) => {
                warn!(session, session_id, kind = ?ticket.kind, "auto-resume failed: {e}");
                {
                    let mut d = self.lock();
                    if let Some(t) = d.sessions.get_mut(session).and_then(|s| s.get_mut(session_id)) {
                        t.attempts += 1;
                        if e.code == GONE {
                            t.manual = Some(e.message.clone());
                        } else if e.retryable && t.attempts < AUTO_TRIES && t.manual.is_none() {
                            t.resume_at = Some(now + RETRY_STEP_MS * t.attempts as Millis);
                        } else {
                            t.manual = Some(clip(&format!("Couldn't {}: {}", verb(ticket.kind), e.message), 200));
                        }
                    }
                }
                self.changed(session);
                self.activity(session, session_id, ticket, false, Some(e));
            }
        }
    }

    fn activity(&self, session: &str, session_id: &str, ticket: &Ticket, started: bool, err: Option<&ApiError>) {
        let Some(ctx) = self.ctx(session) else { return };
        let snap = ctx.state.snapshot();
        let agent = snap.agents.iter().find(|a| shows_ticket(a, session_id, ticket));
        let Some(a) = agent else { return };
        let (kind, title, detail) = match (err, started, ticket.kind) {
            (Some(e), _, _) => (ActivityKind::Error, format!("Couldn't {} {}", verb(ticket.kind), a.name), Some(e.message.clone())),
            (None, true, AutoResumeKind::Restart) => (ActivityKind::Started, format!("Continued {} where it stopped", a.name), Some(ticket.reason.clone())),
            (None, true, _) => (ActivityKind::Started, format!("Resumed {}", a.name), Some(ticket.reason.clone())),
            (None, false, _) => (ActivityKind::Stopped, format!("Nothing left to {} for {}", verb(ticket.kind), a.name), None),
        };
        ctx.state.record_activity(&a.id.clone(), kind, title, detail);
    }

    /// [`cancel`] of the ticket of `session_id`: Don't (`Some(None)`), or Dismiss (`Some(Some(kind))`;
    /// a dismissed limit stop is remembered so `failedTails` does not bring it back). `None`: no ticket.
    fn dont_or_dismiss(&self, session: &str, session_id: &str, now: Millis) -> Option<Option<AutoResumeKind>> {
        let dismissed = {
            let mut d = self.lock();
            let enabled = d.enabled;
            let t = d.sessions.get_mut(session).and_then(|s| s.get_mut(session_id))?;
            let kind = t.kind;
            if t.manual.is_none() && enabled {
                t.manual = Some(match kind {
                    AutoResumeKind::Restart => "You asked not to continue it by itself".to_string(),
                    _ => "You asked not to resume it by itself".to_string(),
                });
                None
            } else {
                if kind != AutoResumeKind::Restart {
                    d.dismissed.retain(|_, at| now - *at < DISMISSED_KEEP_MS);
                    d.dismissed.insert(session_id.to_string(), now);
                }
                Some(kind)
            }
        };
        match dismissed {
            None => self.changed(session),
            Some(_) => {
                self.close(session, session_id, None);
            }
        }
        Some(dismissed)
    }
}

fn verb(kind: AutoResumeKind) -> &'static str {
    match kind {
        AutoResumeKind::Restart => "continue",
        _ => "resume",
    }
}

/// The agent runs a turn again (for longer than a blip of omp's own background work).
fn working(a: &Agent, now: Millis) -> bool {
    let turn = a.omp.as_ref().and_then(|o| o.turn_started_at).is_some_and(|t| now - t >= WORKING_MS);
    a.state == HerdrState::Working && (turn || a.live.streaming)
}

/// The card is an ended agent's (its omp ended without anyone closing it; `crate::restart`).
fn ended(a: &Agent) -> bool {
    a.parked.as_ref().is_some_and(|p| p.ended.is_some())
}

/// The card shows the ticket's root omp session (its id, else its file).
fn shows_ticket(a: &Agent, session_id: &str, t: &Ticket) -> bool {
    a.omp.as_ref().is_some_and(|o| names_session(o, session_id, t.session_file.as_deref()))
}

/// The omp session of an agent or card is `session_id` (the `fresh:` key of a fileless card is
/// one), or its file is `file`. An empty file identifies nothing: every fileless card has one.
pub(crate) fn names_session(o: &tf_proto::model::OmpInfo, session_id: &str, file: Option<&str>) -> bool {
    o.session_id.as_deref() == Some(session_id) || file.is_some_and(|f| !f.is_empty() && o.session_file.as_deref() == Some(f))
}

async fn worker(r: Arc<Recovery>) {
    // Contexts of herdr sessions with tickets that resume by themselves: a daemon started by the
    // keepalive timer (or right after a reboot) resumes them with no app connected.
    if let Some(daemon) = r.daemon.upgrade() {
        let sessions: Vec<String> = {
            let d = r.lock();
            if d.enabled { d.sessions.iter().filter(|(_, t)| t.values().any(|t| t.manual.is_none())).map(|(s, _)| s.clone()).collect() } else { Vec::new() }
        };
        for s in sessions {
            if let Err(e) = daemon.ctx_for(&s).await {
                warn!(session = %s, "auto-resume: herdr session not available yet: {e}");
            }
        }
    }
    loop {
        let now = now_ms();
        let ctxs: Vec<Arc<Ctx>> = r.ctxs_lock().values().filter_map(Weak::upgrade).collect();
        for ctx in &ctxs {
            // Only a board built from a loaded herdr snapshot says which agents are gone.
            if ctx.state.agent_ids_in_use().is_some() {
                r.maintain(&ctx.herdr_session, &ctx.state.snapshot().agents, now);
            }
        }
        let (due, next) = r.due(now);
        for (session, sid) in due {
            let r = r.clone();
            tokio::spawn(async move {
                let _ = r.run(&session, &sid).await;
            });
        }
        let sleep = next.map_or(TICK, |at| Duration::from_millis((at - now).clamp(50, TICK.as_millis() as Millis) as u64));
        tokio::select! {
            _ = tokio::time::sleep(sleep) => {}
            _ = r.wake.notified() => {}
        }
    }
}

/// Resumes one ticket by its kind.
async fn execute(ctx: &Arc<Ctx>, session_id: &str, ticket: &Ticket) -> Result<RetryResult, ApiError> {
    match ticket.kind {
        AutoResumeKind::Restart => crate::restart::continue_session(ctx, session_id, ticket).await,
        AutoResumeKind::UsageLimit | AutoResumeKind::RateLimit | AutoResumeKind::Overloaded | AutoResumeKind::ProviderError => resume_limit(ctx, session_id, ticket).await,
    }
}

/// A limit ticket: the bridge's `resumeTree` (the stopped subagents as jobs of their parents, then
/// the agent through omp's F5), else omp's F5 for the agent ([`crate::limit_resume::f5`]). Never
/// for a card that moved to another host; an agent whose omp went away waits for Resume ([`GONE`]).
async fn resume_limit(ctx: &Ctx, session_id: &str, ticket: &Ticket) -> Result<RetryResult, ApiError> {
    let card = ctx.state.snapshot().agents.into_iter().find(|a| shows_ticket(a, session_id, ticket));
    if card.as_ref().is_some_and(|a| a.parked.as_ref().is_some_and(|p| p.moved.is_some())) {
        return Err(ApiError::new("invalid_params", "it moved to another host; resume it there"));
    }
    let bridge = ctx.bridge.by_session(session_id);
    if card.as_ref().is_some_and(ended) {
        // Its omp ended: the restart ticket opened for the card takes over (`crate::restart`),
        // and the limit comes back with the relaunched agent if it still holds.
        return Err(ApiError::new("busy", "it ended; its restart takes over").retryable());
    }
    if bridge.is_none() && card.as_ref().is_some_and(crate::limit_resume::omp_gone) {
        return Err(ApiError::new(GONE, crate::limit_resume::OMP_GONE));
    }
    // A due usage-limit ticket (not Resume by hand): usage is read afresh; still exhausted → later.
    if ticket.manual.is_none()
        && ticket.resume_at.is_none_or(|at| at <= now_ms())
        && let Some((at, basis)) = crate::limit_resume::still_exhausted(session_id, ticket).await
        && let Some(r) = get()
    {
        r.reschedule(&ctx.herdr_session, session_id, at, basis);
        return Err(ApiError::new(RESCHEDULED, "the account's usage window is still exhausted"));
    }
    let b = bridge.ok_or_else(|| {
        ApiError::new("not_connected", "TeleFlock's bridge in omp is not connected").with_hint("Resume it in the terminal: press F5 in omp").retryable()
    })?;
    if b.caps.resume_tree {
        let v = ctx
            .bridge
            .call(session_id, "resumeTree", json!({ "subagentIds": ticket.subagent_ids, "root": ticket.root }), BRIDGE_TIMEOUT)
            .await
            .map_err(ApiError::from)?;
        let root = v.get("root").and_then(|r| r.as_bool()).unwrap_or(false);
        let subs = v.get("subagents").and_then(|s| s.as_array()).is_some_and(|s| s.iter().any(|x| x.get("started").and_then(|b| b.as_bool()) == Some(true)));
        return Ok(RetryResult { started: root || subs, via: RetryVia::Retry });
    }
    // A bridge without omp's task internals: F5 for the agent; its subagents cannot be resumed.
    match card.filter(|_| ticket.root) {
        Some(a) => crate::limit_resume::f5(ctx, &a.id, Some(&b)).await,
        None => Err(ApiError::new("unsupported", "this omp cannot resume subagents from TeleFlock").with_hint("Resume them in omp")),
    }
}

/// Board rebuild: `Agent.autoResume` on every card (live or parked) whose omp session has a ticket.
pub fn attach(session: &str, agents: &mut [Agent]) {
    if let Some(r) = get() {
        r.attach_to(session, agents);
    }
}

/// The root omp session (id, else file) of an agent card, and the card.
fn session_of(ctx: &Ctx, agent_id: &str) -> Result<(Agent, String), ApiError> {
    let a = ctx.state.agent(agent_id).ok_or_else(|| ApiError::new("not_found", format!("no agent `{agent_id}`")))?;
    let o = a.omp.as_ref().ok_or_else(|| ApiError::new("invalid_params", format!("{} is not an omp agent", a.name)))?;
    let sid = match &o.session_id {
        Some(s) => s.clone(),
        None => {
            let file = o.session_file.clone().unwrap_or_default();
            let r = get().ok_or_else(unavailable)?;
            let d = r.lock();
            d.sessions
                .get(&ctx.herdr_session)
                .filter(|_| !file.is_empty())
                .and_then(|t| t.iter().find(|(_, t)| t.session_file.as_deref() == Some(file.as_str())).map(|(s, _)| s.clone()))
                .ok_or_else(|| ApiError::new("not_found", format!("nothing to resume for {}", a.name)))?
        }
    };
    Ok((a, sid))
}

fn unavailable() -> ApiError {
    ApiError::new("unavailable", "auto-resume is not running in this tf-hostd")
}

#[cfg(test)]
mod settings_tests {
    use super::*;

    fn recovery(file: PathBuf) -> Recovery {
        let data = load(&file);
        let (setting, _) = watch::channel(data.enabled);
        Recovery {
            file,
            daemon: Weak::new(),
            data: Mutex::new(data),
            running: Mutex::new(HashSet::new()),
            ctxs: Mutex::new(HashMap::new()),
            setting,
            wake: Notify::new(),
        }
    }

    #[test]
    fn bring_back_is_on_by_default_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(FILE);
        let r = recovery(file.clone());
        assert!(r.enabled() && r.bring_back());
        r.set_bring_back(false).unwrap();
        let again = recovery(file);
        assert!(!again.bring_back() && again.enabled(), "saved with the file, auto-resume untouched");
        again.set_bring_back(true).unwrap();
        assert!(recovery(dir.path().join(FILE)).bring_back());
        // A file of an older build has no such setting: on.
        std::fs::write(dir.path().join(FILE), br#"{"enabled":false,"sessions":{}}"#).unwrap();
        let old = recovery(dir.path().join(FILE));
        assert!(old.bring_back() && !old.enabled());
    }

    fn aside(dir: &std::path::Path) -> usize {
        std::fs::read_dir(dir).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("autoresume.json.bad-")).count()
    }

    #[test]
    fn a_corrupt_settings_file_fails_closed_and_says_why() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(FILE);
        std::fs::write(&file, b"{\"enabled\":fal").unwrap();
        let r = recovery(file.clone());
        assert!(r.lock().sessions.is_empty());
        assert_eq!(aside(dir.path()), 1, "the damaged bytes are kept");
        let bad = std::fs::read_dir(dir.path()).unwrap().flatten().find(|e| e.file_name().to_string_lossy().starts_with("autoresume.json.bad-")).unwrap().path();
        assert_eq!(std::fs::read(bad).unwrap(), b"{\"enabled\":fal");
        assert!(file.exists(), "and the closed state replaced the damaged file at once");
        // Two consecutive starts with nothing changed in between: closed both times, one bad file.
        let (second, third) = (recovery(file.clone()), recovery(file.clone()));
        for r in [&second, &third] {
            assert!(!r.enabled() && !r.bring_back(), "a restart must not turn unattended work back on");
            assert!(r.notice().is_some_and(|n| n.contains("could not be read")));
        }
        assert_eq!(aside(dir.path()), 1, "a readable file is not quarantined again");
        // The user's opt-out may have been in it: nothing runs unattended, no boot service.
        assert!(!r.enabled() && !r.bring_back());
        let why = r.notice().expect("the host says why both are off");
        assert!(why.contains("could not be read") && why.contains("autoresume.json.bad-"), "{why}");
        // …on the settings, and on the cards that wait for Continue.
        r.open("s", AutoResumeKind::Restart, "sid", TicketInit { reason: "herdr stopped".into(), resume_at: Some(1), root: true, ..Default::default() });
        let t = r.ticket("s", "sid").unwrap();
        let w = r.wire(&t, r.enabled(), r.notice().as_deref(), false);
        assert_eq!(w.status, AutoResumeStatus::Manual);
        assert!(w.reason.contains("could not be read"), "{}", w.reason);
        // The decision survives a restart: still off, still explained, the bad file still there.
        r.save().unwrap();
        let again = recovery(file.clone());
        assert!(!again.enabled() && !again.bring_back() && again.notice().is_some());
        assert_eq!(aside(dir.path()), 1);
        // The user switching either on acknowledges it.
        again.set_enabled(true).unwrap();
        assert!(again.enabled() && !again.bring_back() && again.notice().is_none(), "only what the user switched on is on");
        let after = recovery(file.clone());
        assert!(after.enabled() && !after.bring_back() && after.notice().is_none());
        after.set_bring_back(true).unwrap();
        assert!(recovery(file).bring_back());
    }

    #[test]
    fn an_unreadable_settings_file_fails_closed_too_but_a_missing_one_keeps_the_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(FILE);
        let fresh = recovery(file.clone());
        assert!(fresh.enabled() && fresh.bring_back() && fresh.notice().is_none(), "no file: a new host, defaults on");
        assert_eq!(aside(dir.path()), 0);
        // Something is there but it cannot be read as a file: closed, and nothing is moved away.
        std::fs::create_dir(&file).unwrap();
        let r = recovery(file.clone());
        assert!(!r.enabled() && !r.bring_back() && r.notice().is_some());
        assert_eq!(aside(dir.path()), 0);
        assert!(file.is_dir(), "the primary was never renamed away");
        std::fs::remove_dir(&file).unwrap();
        // An empty file (a torn write) is damage as well.
        std::fs::write(&file, b"").unwrap();
        assert!(!recovery(file).enabled());
    }

    #[test]
    fn when_the_damaged_bytes_cannot_be_copied_aside_the_file_is_still_replaced_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(FILE);
        std::fs::write(&file, b"{\"enabled\":tru").unwrap();
        // The copy cannot be made (its folder is not there): logged, and the closed state replaces the file.
        let data = fail_closed(&file, "EOF", &dir.path().join("no-such-folder").join("autoresume.json.bad-1"));
        assert!(!data.enabled && !data.bring_back);
        assert!(data.notice.as_deref().is_some_and(|n| n.contains("could not be kept")));
        assert!(file.exists(), "there is a primary file at every moment, and now it is the closed one");
        assert_eq!(aside(dir.path()), 0);
        // Two consecutive starts with nothing changed: still closed.
        for _ in 0..2 {
            let r = recovery(file.clone());
            assert!(!r.enabled() && !r.bring_back() && r.notice().is_some());
        }
    }
}

/// `agent.autoResumeNow`: resumes (Continue) the agent's ticket now, whatever its status.
pub async fn resume_now(ctx: &Ctx, agent_id: &str) -> Result<RetryResult, ApiError> {
    // The card's old id (the client may still hold it) names the live successor of a pending launch.
    if let Some(r) = crate::restart::starting_again(ctx, agent_id) {
        return r;
    }
    let r = get().ok_or_else(unavailable)?;
    let (a, sid) = session_of(ctx, agent_id)?;
    if r.ticket(&ctx.herdr_session, &sid).is_none() {
        return Err(ApiError::new("not_found", format!("nothing to resume for {}", a.name)));
    }
    r.run(&ctx.herdr_session, &sid).await
}

/// `agent.autoResumeCancel`: a ticket that would resume by itself stops doing so (Don't: it stays,
/// for Resume by hand); one that waits for Resume goes (Dismiss). A dismissed restart of an agent
/// whose omp is gone leaves its card in Done (`crate::restart::dismissed`).
pub fn cancel(ctx: &Ctx, agent_id: &str) -> Result<(), ApiError> {
    let r = get().ok_or_else(unavailable)?;
    let (a, sid) = session_of(ctx, agent_id)?;
    match r.dont_or_dismiss(&ctx.herdr_session, &sid, now_ms()) {
        None => Err(ApiError::new("not_found", format!("nothing to resume for {}", a.name))),
        Some(Some(AutoResumeKind::Restart)) => {
            crate::restart::dismissed(ctx, &a);
            Ok(())
        }
        Some(_) => Ok(()),
    }
}

/// `host.autoResume`.
pub fn config() -> Result<AutoResumeConfig, ApiError> {
    let r = get().ok_or_else(unavailable)?;
    Ok(AutoResumeConfig { enabled: r.enabled(), bring_back: Some(r.bring_back()), boot_service: crate::automations::get().map(|a| a.boot_service()), notice: r.notice() })
}

/// `host.autoResumeSet`: either or both settings.
pub fn set_config(enabled: Option<bool>, bring_back: Option<bool>) -> Result<AutoResumeConfig, ApiError> {
    if enabled.is_none() && bring_back.is_none() {
        return Err(ApiError::new("invalid_params", "enabled or bringBack is required"));
    }
    let r = get().ok_or_else(unavailable)?;
    let io = |e: std::io::Error| ApiError::new("io_error", format!("saving the auto-resume setting: {e}"));
    if let Some(on) = enabled {
        r.set_enabled(on).map_err(io)?;
    }
    if let Some(on) = bring_back {
        r.set_bring_back(on).map_err(io)?;
    }
    config()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recovery(dir: &std::path::Path) -> Arc<Recovery> {
        let (setting, _) = watch::channel(true);
        Arc::new(Recovery {
            file: dir.join(FILE),
            daemon: Weak::new(),
            data: Mutex::new(Data::default()),
            running: Mutex::new(HashSet::new()),
            ctxs: Mutex::new(HashMap::new()),
            setting,
            wake: Notify::new(),
        })
    }

    fn init(resume_at: Option<Millis>) -> TicketInit {
        TicketInit { reason: "omp stopped mid-turn".into(), session_file: Some("/s/a.jsonl".into()), root: true, resume_at, ..Default::default() }
    }

    fn card(id: &str, sid: Option<&str>, file: Option<&str>) -> Agent {
        let mut a = crate::state::parked::parked_agent(&crate::state::persist::ParkedRecord {
            agent_id: id.into(),
            kind: "omp".into(),
            session_file: file.unwrap_or("").into(),
            session_id: sid.map(str::to_string),
            ..Default::default()
        });
        a.parked = None;
        a.archived = false;
        if file.is_none() {
            a.omp.as_mut().unwrap().session_file = None;
        }
        a
    }

    #[test]
    fn status_follows_setting_dont_and_running() {
        let dir = tempfile::tempdir().unwrap();
        let r = recovery(dir.path());
        assert!(r.open("s", AutoResumeKind::Restart, "sid", init(Some(5_000))));
        let t = r.ticket("s", "sid").unwrap();
        let w = r.wire(&t, true, None, false);
        assert_eq!((w.status, w.resume_at, w.kind), (AutoResumeStatus::Waiting, Some(5_000), AutoResumeKind::Restart));
        // Setting off: waits for Continue, and says why.
        let w = r.wire(&t, false, None, false);
        assert_eq!(w.status, AutoResumeStatus::Manual);
        assert_eq!(w.resume_at, None);
        assert!(w.reason.contains("off"));
        assert_eq!(r.wire(&t, true, None, true).status, AutoResumeStatus::Resuming);
        // A refresh keeps since and attempts.
        r.lock().sessions.get_mut("s").unwrap().get_mut("sid").unwrap().attempts = 2;
        assert!(!r.open("s", AutoResumeKind::Restart, "sid", init(Some(9_000))));
        let t2 = r.ticket("s", "sid").unwrap();
        assert_eq!((t2.since, t2.attempts, t2.resume_at), (t.since, 2, Some(9_000)));
        // The file holds it.
        let saved: Data = serde_json::from_slice(&std::fs::read(dir.path().join(FILE)).unwrap()).unwrap();
        assert!(saved.enabled);
        assert_eq!(saved.sessions["s"]["sid"].kind, AutoResumeKind::Restart);
    }

    #[test]
    fn due_tickets_wait_for_their_time_and_the_setting() {
        let dir = tempfile::tempdir().unwrap();
        let r = recovery(dir.path());
        r.open("s", AutoResumeKind::Restart, "early", init(Some(1_000)));
        r.open("s", AutoResumeKind::Restart, "late", init(Some(9_000)));
        r.open("t", AutoResumeKind::UsageLimit, "held", init(None));
        r.lock().sessions.get_mut("t").unwrap().get_mut("held").unwrap().manual = Some("Don't".into());
        let (due, next) = r.due(5_000);
        assert_eq!(due, vec![("s".to_string(), "early".to_string())]);
        assert_eq!(next, Some(9_000));
        r.running_lock().insert(("s".into(), "early".into()));
        assert!(r.due(5_000).0.is_empty(), "a running ticket is not due again");
        r.lock().enabled = false;
        assert_eq!(r.due(10_000), (Vec::new(), None));
    }

    #[test]
    fn attach_matches_session_id_then_file() {
        let dir = tempfile::tempdir().unwrap();
        let r = recovery(dir.path());
        r.open("s", AutoResumeKind::Restart, "sid", init(Some(1)));
        let mut agents = vec![card("a", Some("sid"), None), card("b", None, Some("/s/a.jsonl")), card("c", Some("other"), Some("/s/c.jsonl"))];
        r.attach_to("s", &mut agents);
        assert!(agents[0].auto_resume.is_some());
        assert!(agents[1].auto_resume.is_some(), "a card that only knows the file matches too");
        assert!(agents[2].auto_resume.is_none());
        let mut other = vec![card("a", Some("sid"), None)];
        r.attach_to("another-herdr-session", &mut other);
        assert!(other[0].auto_resume.is_none());
    }

    #[test]
    fn an_empty_session_file_identifies_nothing_so_two_fresh_cards_keep_their_own_tickets() {
        let dir = tempfile::tempdir().unwrap();
        let r = recovery(dir.path());
        // Every fileless card has an empty session file and the `fresh:` key as its session id.
        let fresh = |reason: &str| TicketInit { reason: reason.into(), session_file: Some(String::new()), root: true, ..Default::default() };
        r.open_restart("s", "fresh:a:1", fresh("A ended"), None);
        r.open_restart("s", "fresh:b:2", fresh("B ended"), None);
        let a = card("a", Some("fresh:a:1"), Some(""));
        let b = card("b", Some("fresh:b:2"), Some(""));
        let (ta, tb) = (r.ticket("s", "fresh:a:1").unwrap(), r.ticket("s", "fresh:b:2").unwrap());
        // Continue on B names B's ticket and B's card, never A's.
        assert!(shows_ticket(&b, "fresh:b:2", &tb) && !shows_ticket(&a, "fresh:b:2", &tb));
        assert!(shows_ticket(&a, "fresh:a:1", &ta) && !shows_ticket(&b, "fresh:a:1", &ta));
        assert!(names_session(b.omp.as_ref().unwrap(), "fresh:b:2", Some("")) && !names_session(a.omp.as_ref().unwrap(), "fresh:b:2", Some("")));
        // A card that knows no session at all matches neither (an empty file is not an identity).
        let nameless = card("c", None, Some(""));
        assert!(!shows_ticket(&nameless, "fresh:a:1", &ta) && !shows_ticket(&nameless, "fresh:b:2", &tb));
        let mut agents = vec![a, b, nameless];
        r.attach_to("s", &mut agents);
        let reason = |a: &Agent| a.auto_resume.as_ref().map(|t| t.reason.clone());
        assert_eq!((reason(&agents[0]).as_deref(), reason(&agents[1]).as_deref()), (Some("A ended"), Some("B ended")));
        assert!(agents[2].auto_resume.is_none());
    }

    #[test]
    fn maintenance_closes_working_done_and_orphaned_tickets() {
        let dir = tempfile::tempdir().unwrap();
        let r = recovery(dir.path());
        for sid in ["w", "d", "o", "k"] {
            r.open("s", AutoResumeKind::Restart, sid, TicketInit { reason: "x".into(), ..Default::default() });
        }
        let now = 100_000;
        let mut working_card = card("1", Some("w"), None);
        working_card.state = HerdrState::Working;
        working_card.omp.as_mut().unwrap().turn_started_at = Some(now - 10_000);
        let mut done_card = card("2", Some("d"), None);
        done_card.archived = true;
        let idle_card = card("3", Some("k"), None);
        let agents = vec![working_card, done_card, idle_card];
        r.maintain("s", &agents, now);
        let left: Vec<String> = r.lock().sessions["s"].keys().cloned().collect();
        assert_eq!(left, vec!["k".to_string(), "o".to_string()]);
        // The orphan goes once no card showed it for ORPHAN_MS.
        r.maintain("s", &agents, now + ORPHAN_MS + 1);
        let left: Vec<String> = r.lock().sessions["s"].keys().cloned().collect();
        assert_eq!(left, vec!["k".to_string()]);
    }

    #[test]
    fn retryable_failures_try_again_then_wait_for_resume() {
        let dir = tempfile::tempdir().unwrap();
        let r = recovery(dir.path());
        r.open("s", AutoResumeKind::Restart, "sid", init(Some(1)));
        let t = r.ticket("s", "sid").unwrap();
        let busy = Err(ApiError::new("busy", "the shell is busy").retryable());
        r.finish("s", "sid", &t, &busy);
        let t1 = r.ticket("s", "sid").unwrap();
        assert_eq!((t1.attempts, t1.manual.is_none()), (1, true));
        assert!(t1.resume_at.unwrap() > now_ms());
        r.finish("s", "sid", &t, &Err(ApiError::new("io_error", "gone")));
        let t2 = r.ticket("s", "sid").unwrap();
        assert_eq!(t2.attempts, 2);
        assert!(t2.manual.as_deref().unwrap().starts_with("Couldn't continue: gone"));
        // Success closes it.
        r.finish("s", "sid", &t, &Ok(RetryResult { started: true, via: RetryVia::Restore }));
        assert!(r.ticket("s", "sid").is_none());
    }

    fn limit(root: bool, subagent_ids: &[&str]) -> TicketInit {
        TicketInit {
            reason: "Usage limit".into(),
            root,
            subagent_ids: subagent_ids.iter().map(|s| s.to_string()).collect(),
            provider: Some("mocklab".into()),
            resume_at: Some(1),
            basis: Some(ResumeBasis::Hint),
            ..Default::default()
        }
    }

    #[test]
    fn limit_tickets_follow_the_card_moved_gone_and_subagent_only() {
        let dir = tempfile::tempdir().unwrap();
        let r = recovery(dir.path());
        r.open("s", AutoResumeKind::UsageLimit, "moved", limit(true, &[]));
        r.open("s", AutoResumeKind::UsageLimit, "parked", limit(true, &["Sub"]));
        r.open("s", AutoResumeKind::UsageLimit, "subs", limit(false, &["Sub"]));
        r.open("s", AutoResumeKind::UsageLimit, "both", limit(true, &["Sub"]));
        r.open("s", AutoResumeKind::UsageLimit, "alone", limit(true, &[]));
        r.open("s", AutoResumeKind::Restart, "restart", init(Some(1)));
        r.open("s", AutoResumeKind::UsageLimit, "ended", limit(true, &[]));
        let now = 100_000;
        let mut moved = card("1", Some("moved"), None);
        moved.parked = Some(tf_proto::model::Parked {
            at: 1,
            session_file: "/s/m.jsonl".into(),
            worktree: None,
            moved: Some(tf_proto::ParkedMove { state: tf_proto::ParkedMoveState::Moved, move_id: "mv".into(), to: "build".into(), host_id: None, agent_id: None, at: 2 }),
            ended: None,
        });
        let mut parked = card("2", Some("parked"), None);
        parked.parked = Some(tf_proto::model::Parked { at: 1, session_file: "/s/p.jsonl".into(), worktree: None, moved: None, ended: None });
        let mut restart = parked.clone();
        restart.id = "4".into();
        restart.omp.as_mut().unwrap().session_id = Some("restart".into());
        let mut ended_card = parked.clone();
        ended_card.id = "7".into();
        ended_card.omp.as_mut().unwrap().session_id = Some("ended".into());
        ended_card.parked.as_mut().unwrap().ended = Some(tf_proto::autoresume::AgentEnded { at: 1, cause: tf_proto::autoresume::EndCause::HerdrStopped, reason: "herdr stopped".into(), turn: tf_proto::autoresume::EndedTurn::Idle, last_action: None });
        // Only subagents stopped: the root working (on their absence) says nothing about them.
        let mut subs = card("3", Some("subs"), None);
        subs.state = HerdrState::Working;
        subs.omp.as_mut().unwrap().turn_started_at = Some(now - 10_000);
        // The agent works again by other means: its own part is over, its subagents still wait.
        let mut both = subs.clone();
        both.id = "5".into();
        both.omp.as_mut().unwrap().session_id = Some("both".into());
        let mut alone = subs.clone();
        alone.id = "6".into();
        alone.omp.as_mut().unwrap().session_id = Some("alone".into());
        r.maintain("s", &[moved, parked, subs, both, alone, restart, ended_card], now);
        let d = r.lock();
        let left: Vec<&str> = d.sessions["s"].keys().map(String::as_str).collect();
        assert_eq!(left, vec!["both", "ended", "parked", "restart", "subs"], "moved: never resumed here; alone: working again");
        assert_eq!(d.sessions["s"]["parked"].manual.as_deref(), Some(crate::limit_resume::OMP_GONE), "a Done card's limit ticket cannot resume it");
        assert_eq!(d.sessions["s"]["ended"].manual, None, "an ended card's limit ticket is left for its restart to replace");
        assert_eq!(d.sessions["s"]["restart"].manual, None, "a parked restart card relaunches");
        assert_eq!((d.sessions["s"]["subs"].manual.as_deref(), d.sessions["s"]["subs"].root), (None, false));
        assert_eq!((d.sessions["s"]["both"].root, d.sessions["s"]["both"].subagent_ids.as_slice()), (false, ["Sub".to_string()].as_slice()));
    }

    #[test]
    fn gone_omp_waits_for_resume_without_retries() {
        let dir = tempfile::tempdir().unwrap();
        let r = recovery(dir.path());
        r.open("s", AutoResumeKind::UsageLimit, "sid", limit(true, &[]));
        let t = r.ticket("s", "sid").unwrap();
        r.finish("s", "sid", &t, &Err(ApiError::new(GONE, crate::limit_resume::OMP_GONE).retryable()));
        let t1 = r.ticket("s", "sid").unwrap();
        assert_eq!(t1.manual.as_deref(), Some(crate::limit_resume::OMP_GONE));
        assert_eq!(r.wire(&t1, true, None, false).status, AutoResumeStatus::Manual);
        // Rescheduled (usage still exhausted): nothing counted.
        r.open("s", AutoResumeKind::UsageLimit, "late", limit(true, &[]));
        r.reschedule("s", "late", 9_000_000, ResumeBasis::Window);
        let late = r.ticket("s", "late").unwrap();
        r.finish("s", "late", &late, &Err(ApiError::new(RESCHEDULED, "still exhausted")));
        let late = r.ticket("s", "late").unwrap();
        assert_eq!((late.attempts, late.resume_at, late.basis, late.manual), (0, Some(9_000_000), Some(ResumeBasis::Window), None));
    }

    #[test]
    fn dont_then_dismiss_and_the_dismissal_is_remembered() {
        let dir = tempfile::tempdir().unwrap();
        let r = recovery(dir.path());
        r.open("s", AutoResumeKind::UsageLimit, "sid", limit(true, &["Sub"]));
        assert_eq!(r.dont_or_dismiss("s", "sid", 5_000), Some(None), "Don't first");
        assert!(r.ticket("s", "sid").unwrap().manual.is_some());
        assert_eq!(r.dismissed_at("sid"), None);
        assert_eq!(r.dont_or_dismiss("s", "sid", 6_000), Some(Some(AutoResumeKind::UsageLimit)), "then Dismiss");
        assert!(r.ticket("s", "sid").is_none());
        assert_eq!(r.dismissed_at("sid"), Some(6_000));
        assert_eq!(r.dont_or_dismiss("s", "sid", 7_000), None);
        // Kept a day, then forgotten at the next dismissal.
        r.open("s", AutoResumeKind::RateLimit, "other", limit(true, &[]));
        r.lock().enabled = false;
        assert_eq!(r.dont_or_dismiss("s", "other", 6_000 + DISMISSED_KEEP_MS), Some(Some(AutoResumeKind::RateLimit)), "setting off: Dismiss at once");
        assert_eq!((r.dismissed_at("sid"), r.dismissed_at("other")), (None, Some(6_000 + DISMISSED_KEEP_MS)));
        // A restart ticket's dismissal is not a limit stop to remember.
        r.open("s", AutoResumeKind::Restart, "rs", init(Some(1)));
        assert_eq!(r.dont_or_dismiss("s", "rs", 9_000), Some(Some(AutoResumeKind::Restart)));
        assert_eq!(r.dismissed_at("rs"), None);
        let saved: Data = serde_json::from_slice(&std::fs::read(dir.path().join(FILE)).unwrap()).unwrap();
        assert_eq!(saved.dismissed.keys().collect::<Vec<_>>(), vec!["other"]);
    }

    #[test]
    fn hold_makes_a_ticket_wait_for_resume_once() {
        let dir = tempfile::tempdir().unwrap();
        let r = recovery(dir.path());
        r.open("s", AutoResumeKind::UsageLimit, "sid", limit(true, &[]));
        assert!(r.hold("s", "sid", "Hit the limit again".into()));
        assert!(!r.hold("s", "sid", "again".into()), "a held ticket keeps its reason");
        assert_eq!(r.ticket("s", "sid").unwrap().manual.as_deref(), Some("Hit the limit again"));
        assert!(r.due(now_ms()).0.is_empty());
        assert!(!r.hold("s", "none", "x".into()));
    }

    #[test]
    fn an_ended_card_always_gets_a_restart_ticket_that_waits_for_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        let r = recovery(dir.path());
        let at = now_ms() + 3_600_000;
        // A limit ticket that waits for the window to reset, then herdr goes down: the card ended.
        r.open("s", AutoResumeKind::UsageLimit, "sid", TicketInit { resume_at: Some(at), ..limit(true, &["Sub"]) });
        let restart = |resume_at| TicketInit { reason: "herdr stopped".into(), session_file: Some("/s/a.jsonl".into()), root: true, resume_at: Some(resume_at), ..Default::default() };
        assert!(r.open_restart("s", "sid", restart(1_000), None), "replaces the limit ticket");
        let t = r.ticket("s", "sid").unwrap();
        assert_eq!((t.kind, t.resume_at, t.manual.as_deref(), t.attempts), (AutoResumeKind::Restart, Some(at), None, 0), "not before the limit passes");
        assert!(t.subagent_ids.is_empty() && t.provider.is_none(), "nothing of the limit stays");
        // A later grace wins over an earlier limit time.
        r.open("s", AutoResumeKind::RateLimit, "other", TicketInit { resume_at: Some(5), ..limit(true, &[]) });
        assert!(r.open_restart("s", "other", restart(9_000), None));
        assert_eq!(r.ticket("s", "other").unwrap().resume_at, Some(9_000));
        // An existing restart ticket stays as it is (its tries, its time).
        r.lock().sessions.get_mut("s").unwrap().get_mut("sid").unwrap().attempts = 2;
        assert!(!r.open_restart("s", "sid", restart(1), Some("keeps crashing".into())));
        assert_eq!(r.ticket("s", "sid").unwrap().attempts, 2);
        // A Don't the user said on the limit ticket stays; "omp exited" (the old reason an ended
        // card's limit ticket was held) does not.
        r.open("s", AutoResumeKind::UsageLimit, "dont", limit(true, &[]));
        r.hold("s", "dont", "You asked not to resume it by itself".into());
        r.open_restart("s", "dont", restart(1), None);
        assert_eq!(r.ticket("s", "dont").unwrap().manual.as_deref(), Some("You asked not to resume it by itself"));
        r.open("s", AutoResumeKind::UsageLimit, "gone", limit(true, &[]));
        r.hold("s", "gone", crate::limit_resume::OMP_GONE.into());
        r.open_restart("s", "gone", restart(1), None);
        assert_eq!(r.ticket("s", "gone").unwrap().manual, None);
        // A crash loop is held from the start: never due, so nothing relaunches by itself.
        assert!(r.open_restart("s", "loop", restart(1), Some("keeps crashing — continue when ready".into())));
        let t = r.ticket("s", "loop").unwrap();
        assert_eq!(r.wire(&t, true, None, false).status, AutoResumeStatus::Manual);
        assert!(!r.due(now_ms()).0.contains(&("s".to_string(), "loop".to_string())));
    }
}
