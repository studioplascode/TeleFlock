//! Decide for me (architecture §3.23): a question with a ★ recommended option that waits long
//! enough for a person is answered with the recommended option(s) by tf-hostd itself, whether or
//! not an app is connected.
//!
//! * [`core`]: the state machine (policies, countdowns, presence of apps); no I/O.
//! * [`store`]: `<home>/auto-answer.json`.
//! * [`AutoAnswers`]: one per herdr session (`Ctx::auto_answer`). The board's rebuild hands it
//!   every agent ([`AutoAnswers::observe`]: starts, keeps or drops the agent's countdown and gives
//!   `Agent.autoAnswer`); its worker ([`start_session`]) follows apps connecting and
//!   disconnecting, answers what falls due, saves, and sweeps what belongs to gone agents.
//! * [`start`]: at daemon start, the contexts of sessions that have something to watch, so a
//!   restarted tf-hostd answers with no app connected.

pub mod core;
pub mod store;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tokio::sync::Notify;
use tracing::{info, warn};

use tf_proto::autoanswer::{AgentAutoAnswer, AutoAnswer, AutoAnswerPostponeParams, AutoAnswerRef, AutoAnswerStatus, SetAutoAnswerParams};
use tf_proto::model::{ActivityKind, Agent, Answer, LinkState, Notification, NotifyKind};
use tf_proto::{ApiError, Millis};

use self::core::{Core, Fire, Outcome, SessionData};
use crate::daemon::Daemon;
use crate::ops::Ctx;
use crate::paths::Paths;
use crate::util::{clip, new_id, now_ms};

/// The worker looks again at least this often (sweeps, a clock that slipped past a sleep).
const IDLE: Duration = Duration::from_secs(30);
/// Changes are written at most this often.
const SAVE_EVERY: Duration = Duration::from_secs(1);
/// Countdowns and policies of gone agents are swept this often.
const SWEEP_EVERY: Duration = Duration::from_secs(60);
/// `deliver` found the policy no longer allows an answer now (not an error: the countdown stands).
const HOLD: &str = "hold";

/// The decide-for-me state of one herdr session. Cheap to clone.
#[derive(Clone)]
pub struct AutoAnswers {
    inner: Arc<Shared>,
}

struct Shared {
    session: String,
    file: PathBuf,
    core: Mutex<Core>,
    /// Wakes the worker: a policy changed, an app connected or disconnected, a countdown started.
    wake: Notify,
}

impl AutoAnswers {
    /// The session's handle, with what `<home>/auto-answer.json` keeps for it.
    pub fn open(paths: &Paths, session: &str) -> Self {
        let file = store::path(paths);
        let data = store::load(&file, session);
        Self::with(file, session, data, now_ms())
    }

    fn with(file: PathBuf, session: &str, data: SessionData, now: Millis) -> Self {
        Self { inner: Arc::new(Shared { session: session.to_string(), file, core: Mutex::new(Core::new(data, now)), wake: Notify::new() }) }
    }

    fn core(&self) -> MutexGuard<'_, Core> {
        self.inner.core.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn wake(&self) {
        self.inner.wake.notify_one();
    }

    /// The board built `agent` (`has_clients`: an app is connected to this session): starts,
    /// keeps or drops its countdown, and returns `Agent.autoAnswer`.
    pub fn observe(&self, agent: &Agent, now: Millis, has_clients: bool) -> Option<AgentAutoAnswer> {
        let mut c = self.core();
        let before = c.changes();
        let view = c.observe(agent, now, has_clients);
        if c.changes() != before {
            self.wake();
        }
        view
    }

    /// `HostInfo.autoAnswer`.
    pub fn host_default(&self) -> AutoAnswer {
        self.core().host_default()
    }

    /// An app connected to or disconnected from the session.
    pub fn clients_changed(&self) {
        self.wake();
    }
}

// ───────────────────────────── methods ─────────────────────────────

fn known_omp_agent(ctx: &Ctx, agent_id: &str) -> Result<Agent, ApiError> {
    let a = ctx.state.agent(agent_id).ok_or_else(|| ApiError::new("not_found", format!("no agent `{agent_id}`")))?;
    if a.kind != "omp" {
        return Err(ApiError::new("unsupported", format!("`{}` is a {} agent: decide for me answers omp questions only", a.name, a.kind)));
    }
    Ok(a)
}

/// After a change: the board shows it and the worker reschedules.
fn changed(ctx: &Ctx) {
    ctx.auto_answer.wake();
    ctx.state.mark_dirty();
}

/// `host.autoAnswerSet`: the session's default.
pub fn set_default(ctx: &Ctx, policy: AutoAnswer) -> Result<AutoAnswer, ApiError> {
    policy.validate()?;
    // The board's rebuild locks the store, then the core: never the other way round.
    let apps = ctx.state.has_clients();
    ctx.auto_answer.core().set_default(policy.clone(), now_ms(), apps);
    info!(session = %ctx.herdr_session, enabled = policy.enabled, after_secs = policy.after_secs, only_when_no_app = policy.only_when_no_app, "decide for me: host default set");
    changed(ctx);
    Ok(policy)
}

/// `agent.setAutoAnswer`.
pub fn set_agent(ctx: &Ctx, p: SetAutoAnswerParams) -> Result<(), ApiError> {
    known_omp_agent(ctx, &p.agent_id)?;
    if let Some(policy) = &p.policy {
        policy.validate()?;
    }
    info!(session = %ctx.herdr_session, agent = %p.agent_id, policy = ?p.policy, "decide for me: agent policy set");
    let apps = ctx.state.has_clients();
    ctx.auto_answer.core().set_own(&p.agent_id, p.policy, now_ms(), apps);
    changed(ctx);
    Ok(())
}

/// `agent.autoAnswerCancel`.
pub fn cancel(ctx: &Ctx, p: AutoAnswerRef) -> Result<(), ApiError> {
    known_omp_agent(ctx, &p.agent_id)?;
    ctx.auto_answer.core().cancel(&p.agent_id, &p.request_id, now_ms())?;
    info!(session = %ctx.herdr_session, agent = %p.agent_id, request = %p.request_id, "decide for me: cancelled for this question");
    changed(ctx);
    Ok(())
}

/// `agent.autoAnswerPostpone`.
pub fn postpone(ctx: &Ctx, p: AutoAnswerPostponeParams) -> Result<(), ApiError> {
    known_omp_agent(ctx, &p.agent_id)?;
    let apps = ctx.state.has_clients();
    ctx.auto_answer.core().postpone(&p.agent_id, &p.request_id, p.secs, now_ms(), apps)?;
    info!(session = %ctx.herdr_session, agent = %p.agent_id, request = %p.request_id, secs = p.secs, "decide for me: postponed");
    changed(ctx);
    Ok(())
}

/// A launch with `AgentSpec.autoAnswer` (checked before the launch with [`AutoAnswer::validate`])
/// gives the new agent its own policy.
pub fn bind(ctx: &Ctx, agent_id: &str, policy: &AutoAnswer) {
    let apps = ctx.state.has_clients();
    ctx.auto_answer.core().set_own(agent_id, Some(policy.clone()), now_ms(), apps);
    changed(ctx);
}

/// An agent's own policy (a parked agent's carries over to the agent that resumes it).
pub fn own(ctx: &Ctx, agent_id: &str) -> Option<AutoAnswer> {
    ctx.auto_answer.core().own(agent_id)
}

/// The agent was resumed under another id: its old id keeps nothing.
pub fn forget(ctx: &Ctx, agent_id: &str) {
    ctx.auto_answer.core().forget(agent_id);
    changed(ctx);
}

// ───────────────────────────── texts ─────────────────────────────

/// `20 min`, `1 h 30 min`, `45 s`: whole minutes, rounded up, from a minute on.
pub fn wait_text(ms: i64) -> String {
    let secs = (ms.max(0) + 999) / 1000;
    if secs < 60 {
        return format!("{secs} s");
    }
    let mins = (secs + 59) / 60;
    match (mins / 60, mins % 60) {
        (0, m) => format!("{m} min"),
        (h, 0) => format!("{h} h"),
        (h, m) => format!("{h} h {m} min"),
    }
}

fn stars(labels: &[String]) -> String {
    labels.iter().map(|l| format!("★ {l}")).collect::<Vec<_>>().join(", ")
}

/// What a needs-you notification adds about the question's countdown.
pub fn needs_note(agent: &Agent, now: Millis) -> Option<String> {
    let cd = agent.auto_answer.as_ref()?.countdown.as_ref()?;
    let picks = stars(&cd.picks);
    match cd.status {
        AutoAnswerStatus::Counting => Some(format!("Decide for me picks {picks} in {} unless you answer.", wait_text(cd.deadline? - now))),
        AutoAnswerStatus::WaitingForNoApp => Some(format!("Decide for me picks {picks} after {} with no app connected.", wait_text(cd.remaining_ms?))),
        _ => None,
    }
}

// ───────────────────────────── worker ─────────────────────────────

/// Starts the session's worker and hands its handle to the board (called once per context).
pub fn start_session(ctx: &Arc<Ctx>) {
    ctx.state.set_auto_answer(ctx.auto_answer.clone());
    tokio::spawn(run(ctx.clone()));
}

async fn run(ctx: Arc<Ctx>) {
    let aa = ctx.auto_answer.clone();
    let mut last_save: Option<Instant> = None;
    let mut last_sweep = Instant::now();
    loop {
        let now = now_ms();
        let has_clients = ctx.state.has_clients();
        let (fires, moved, next) = {
            let mut c = aa.core();
            let before = c.changes();
            c.presence(now, has_clients);
            let fires = c.due(now);
            (fires, c.changes() != before, c.next_wake(now))
        };
        if moved {
            ctx.state.mark_dirty();
        }
        for f in fires {
            tokio::spawn(fire(ctx.clone(), f));
        }
        if last_sweep.elapsed() >= SWEEP_EVERY {
            last_sweep = Instant::now();
            // Only a board built from a loaded herdr snapshot tells which agents are gone.
            if let Some(keep) = ctx.state.agent_ids_in_use() {
                let gone = aa.core().sweep(&keep, now_ms());
                if gone > 0 {
                    info!(session = %aa.inner.session, gone, "decide for me: dropped what belonged to gone agents");
                }
            }
        }
        let mut sleep = next.map_or(IDLE, |at| Duration::from_millis((at - now).clamp(0, IDLE.as_millis() as i64) as u64));
        if aa.core().is_dirty() {
            match last_save.map(|t| t.elapsed()) {
                Some(since) if since < SAVE_EVERY => sleep = sleep.min(SAVE_EVERY - since),
                _ => {
                    save(&aa).await;
                    last_save = Some(Instant::now());
                }
            }
        }
        tokio::select! {
            _ = aa.inner.wake.notified() => {}
            _ = tokio::time::sleep(sleep) => {}
            _ = ctx.cancel.cancelled() => {
                save(&aa).await;
                break;
            }
        }
    }
}

async fn save(aa: &AutoAnswers) {
    let Some(data) = aa.core().take_dirty() else { return };
    let (file, session) = (aa.inner.file.clone(), aa.inner.session.clone());
    let res = tokio::task::spawn_blocking(move || store::save(&file, &session, &data)).await;
    if let Ok(Err(e)) | Err(e) = res.map_err(std::io::Error::other) {
        warn!(session = %aa.inner.session, "decide for me: saving {}: {e}", store::FILE);
    }
}

/// Answers a countdown that fell due, and records what happened.
async fn fire(ctx: Arc<Ctx>, f: Fire) {
    let (outcome, error) = match deliver(&ctx, &f).await {
        Ok(()) => (Outcome::Answered, None),
        Err(e) if e.code == "not_found" || e.code == "gone" => (Outcome::Gone, None),
        Err(e) if e.code == HOLD => (Outcome::Hold, None),
        Err(e) if e.retryable => (Outcome::Retry, Some(e)),
        Err(e) => (Outcome::Failed, Some(e)),
    };
    let now = now_ms();
    ctx.auto_answer.core().fired(&f, outcome, now);
    changed(&ctx);
    let name = ctx.state.agent(&f.agent_id).map(|a| a.name).unwrap_or_else(|| f.agent_id.clone());
    let picks = stars(&f.labels);
    match (outcome, error) {
        (Outcome::Answered, _) => {
            info!(session = %ctx.herdr_session, agent = %f.agent_id, request = %f.request_id, picks = ?f.picks, "decide for me: answered");
            let detail = format!("{} · nobody answered within {}", clip(&f.question, 200), wait_text(f.waited_ms));
            ctx.state.record_activity(&f.agent_id, ActivityKind::Answered, format!("Auto-answered {picks}"), Some(detail));
            ctx.state.broadcast_notification(Notification {
                id: new_id("n"),
                at: now,
                kind: NotifyKind::Info,
                agent_id: f.agent_id.clone(),
                title: format!("{name} · decided for you"),
                body: clip(&format!("{picks} — {}", f.question), 240),
                request_id: None,
                actions: vec![],
            });
        }
        (Outcome::Failed, Some(e)) => {
            warn!(session = %ctx.herdr_session, agent = %f.agent_id, request = %f.request_id, "decide for me: omp refused the answer: {e}");
            ctx.state.record_activity(&f.agent_id, ActivityKind::Error, "Decide for me could not answer".into(), Some(format!("{}: {}", clip(&f.question, 160), e.message)));
            ctx.state.broadcast_notification(Notification {
                id: new_id("n"),
                at: now,
                kind: NotifyKind::Error,
                agent_id: f.agent_id.clone(),
                title: format!("{name} · decide for me could not answer"),
                body: clip(&format!("{}: {}", f.question, e.message), 240),
                request_id: None,
                actions: vec![],
            });
        }
        (Outcome::Retry, Some(e)) => info!(session = %ctx.herdr_session, agent = %f.agent_id, "decide for me: answer not delivered yet ({e}); trying again"),
        (Outcome::Hold, _) => info!(session = %ctx.herdr_session, agent = %f.agent_id, request = %f.request_id, "decide for me: an app is connected now; the answer waits until none is"),
        _ => info!(session = %ctx.herdr_session, agent = %f.agent_id, "decide for me: the question went away before it was answered"),
    }
}

/// Sends the answer through the session's data path (the bridge, else its collab guest), as
/// `agent.answer` does. Only while the board still shows that very question.
async fn deliver(ctx: &Ctx, f: &Fire) -> Result<(), ApiError> {
    let shown = ctx.state.agent(&f.agent_id).and_then(|a| a.needs).is_some_and(|n| n.answerable && n.request_id.as_deref() == Some(f.request_id.as_str()));
    if !shown {
        return Err(ApiError::new("gone", "the question is no longer pending"));
    }
    let down = || ApiError::new("not_connected", "the session's link is down").retryable();
    let sid = ctx.state.omp_session_of(&f.agent_id).ok_or_else(down)?;
    let s = ctx.omp.session(&sid).ok_or_else(down)?;
    if s.link().0 != LinkState::Live {
        return Err(down());
    }
    // The policy is asked again right before sending, at every attempt (a countdown that fell due
    // while nobody was there says nothing about now: an app may have connected since).
    let apps = ctx.state.has_clients();
    if !ctx.auto_answer.core().permitted(f, now_ms(), apps) {
        return Err(ApiError::new(HOLD, "decide for me may not answer now"));
    }
    s.answer(&f.request_id, &Answer { choices: f.picks.clone(), text: None, cancel: false, chat: false }).await
}

// ───────────────────────────── daemon start ─────────────────────────────

/// Whether a session has something decide for me watches.
fn wants_context(d: &SessionData) -> bool {
    d.default.as_ref().is_some_and(|p| p.enabled) || d.agents.values().any(|o| o.policy.enabled) || !d.pending.is_empty()
}

/// At daemon start: opens the context of every session with an active policy or a running
/// countdown whose herdr server runs (never starting one), so questions are answered after a
/// tf-hostd restart even when no app connects.
pub fn start(daemon: &Arc<Daemon>) {
    let daemon = daemon.clone();
    tokio::spawn(async move {
        let file = store::path(&daemon.paths);
        let sessions: BTreeMap<String, SessionData> = tokio::task::spawn_blocking(move || store::sessions(&file)).await.unwrap_or_default();
        for (session, data) in sessions {
            if !wants_context(&data) {
                continue;
            }
            let name = (session != "default").then_some(session.as_str());
            let running = match tf_herdr::HerdrClient::discover(name).await {
                Ok(h) => h.ping().await.is_ok(),
                Err(_) => false,
            };
            if !running {
                info!(session, "decide for me: herdr server not running; nothing to watch");
                continue;
            }
            match daemon.ctx_for(&session).await {
                Ok(_) => info!(session, "decide for me: watching the session"),
                Err(e) => warn!(session, "decide for me: cannot open the session: {e}"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wait_texts() {
        assert_eq!(wait_text(-5), "0 s");
        assert_eq!(wait_text(1), "1 s");
        assert_eq!(wait_text(45_000), "45 s");
        assert_eq!(wait_text(60_000), "1 min");
        assert_eq!(wait_text(60_001), "2 min");
        assert_eq!(wait_text(20 * 60_000), "20 min");
        assert_eq!(wait_text(60 * 60_000), "1 h");
        assert_eq!(wait_text(90 * 60_000), "1 h 30 min");
    }

    #[test]
    fn sessions_with_something_to_watch() {
        let on = AutoAnswer { enabled: true, after_secs: 600, only_when_no_app: false };
        let off = AutoAnswer { enabled: false, ..on.clone() };
        assert!(!wants_context(&SessionData::default()));
        assert!(!wants_context(&SessionData { default: Some(off.clone()), ..Default::default() }));
        assert!(wants_context(&SessionData { default: Some(on.clone()), ..Default::default() }));
        let mut d = SessionData { default: Some(off.clone()), ..Default::default() };
        d.agents.insert("t1".into(), core::OwnPolicy { policy: off, at: 0 });
        assert!(!wants_context(&d));
        d.agents.insert("t2".into(), core::OwnPolicy { policy: on, at: 0 });
        assert!(wants_context(&d));
    }
}
