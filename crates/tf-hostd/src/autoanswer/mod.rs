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
//! * Review: every answer sent becomes a review item ([`core::Decided`]), published as
//!   `HostInfo.decisions` (unreviewed ones) in the snapshot every app gets on connect, until
//!   `host.autoAnswerReview` ([`review`]) marks it reviewed for every device and retracts its
//!   "decided for you" notification everywhere.
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

use tf_proto::autoanswer::{
    AgentAutoAnswer, AutoAnswer, AutoAnswerPostponeParams, AutoAnswerRef, AutoAnswerReviewParams, AutoAnswerReviewed, AutoAnswerStatus, AutoDecision,
    AutoDecisionOption, SetAutoAnswerParams,
};
use tf_proto::model::{ActivityKind, Agent, Answer, HostPage, LinkState, Notification, NotifyAction, NotifyKind};
use tf_proto::{ApiError, Millis};

use self::core::{Core, Fire, Outcome, SessionData};
use crate::daemon::Daemon;
use crate::notify::Notifier;
use crate::ops::Ctx;
use crate::paths::Paths;
use crate::state::StateHandle;
use crate::util::{clip, new_id, now_ms};

/// The worker looks again at least this often (sweeps, a clock that slipped past a sleep).
const IDLE: Duration = Duration::from_secs(30);
/// Changes are written at most this often.
const SAVE_EVERY: Duration = Duration::from_secs(1);
/// Countdowns and policies of gone agents, and review items past their time, are swept this often.
const SWEEP_EVERY: Duration = Duration::from_secs(60);
/// `deliver` found the policy no longer allows an answer now (not an error: the countdown stands).
const HOLD: &str = "hold";
/// Ids one `host.autoAnswerReview` looks at.
const REVIEW_MAX: usize = 500;
/// A review item keeps this much of its question, and of each option's label.
const QUESTION_MAX: usize = 2_000;
const LABEL_MAX: usize = 200;

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

    /// `HostInfo.decisions`: the review items nobody marked reviewed yet, oldest first.
    pub fn decisions(&self) -> Vec<AutoDecision> {
        self.core().decisions()
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

/// `host.autoAnswerReview` from device `by`: the decisions are reviewed for every device of the
/// session (`HostInfo.decisions` drops them at once) and their "decided for you" notifications are
/// read and retracted on every device.
pub fn review(ctx: &Ctx, by: &str, p: AutoAnswerReviewParams) -> Result<AutoAnswerReviewed, ApiError> {
    review_in(&ctx.auto_answer, &ctx.state, &ctx.notify, &ctx.herdr_session, by, p)
}

fn review_in(aa: &AutoAnswers, state: &StateHandle, notify: &Notifier, session: &str, by: &str, p: AutoAnswerReviewParams) -> Result<AutoAnswerReviewed, ApiError> {
    if p.ids.is_empty() && !p.all {
        return Err(ApiError::new("invalid_params", "name the decisions to mark reviewed (ids), or all"));
    }
    let ids = &p.ids[..p.ids.len().min(REVIEW_MAX)];
    let done = aa.core().review(ids, p.all, now_ms(), by);
    if !done.is_empty() {
        info!(session, by, n = done.len(), "decide for me: decisions reviewed");
        state.decisions_changed();
        notify.read_everywhere(session, done.iter().filter_map(|(_, n)| n.clone()).collect(), by);
        // Saved within a second.
        aa.wake();
    }
    Ok(AutoAnswerReviewed { reviewed: done.into_iter().map(|(id, _)| id).collect() })
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

/// What decide for me sends: `★ A, ★ B`, or the question's earlier answer ("your earlier answer (A)").
fn answer_text(labels: &[String], earlier: bool) -> String {
    if earlier { format!("your earlier answer ({})", labels.join(", ")) } else { stars(labels) }
}

/// What a needs-you notification adds about the question's countdown.
pub fn needs_note(agent: &Agent, now: Millis) -> Option<String> {
    let cd = agent.auto_answer.as_ref()?.countdown.as_ref()?;
    let picks = answer_text(&cd.picks, cd.earlier);
    let verb = if cd.earlier { "sends" } else { "picks" };
    match cd.status {
        AutoAnswerStatus::Counting => Some(format!("Decide for me {verb} {picks} in {} unless you answer.", wait_text(cd.deadline? - now))),
        AutoAnswerStatus::WaitingForNoApp => Some(format!("Decide for me {verb} {picks} after {} with no app connected.", wait_text(cd.remaining_ms?))),
        _ => None,
    }
}

// ───────────────────────────── worker ─────────────────────────────

/// Starts the session's worker and hands its handle to the board (called once per context), with
/// the review items it keeps (`HostInfo.decisions`, in the snapshot of every app that connects).
pub fn start_session(ctx: &Arc<Ctx>) {
    ctx.state.set_auto_answer(ctx.auto_answer.clone());
    ctx.state.decisions_changed();
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
            if aa.core().expire_decisions(now_ms()) {
                info!(session = %aa.inner.session, "decide for me: dropped review items past their time");
                ctx.state.decisions_changed();
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

/// Answers a countdown that fell due, and records what happened: an answer sent becomes a review
/// item, published before its notification goes out (opening the notification finds it).
async fn fire(ctx: Arc<Ctx>, f: Fire) {
    let (outcome, error, asked) = match deliver(&ctx, &f).await {
        Ok(asked) => (Outcome::Answered, None, Some(asked)),
        Err(e) if e.code == "not_found" || e.code == "gone" => (Outcome::Gone, None, None),
        Err(e) if e.code == HOLD => (Outcome::Hold, None, None),
        Err(e) if e.retryable => (Outcome::Retry, Some(e), None),
        Err(e) => (Outcome::Failed, Some(e), None),
    };
    let now = now_ms();
    let note = new_id("n");
    {
        let mut c = ctx.auto_answer.core();
        c.fired(&f, outcome, now);
        if let Some(agent) = &asked {
            c.decided(decision(&f, agent, now, &note), now);
        }
    }
    changed(&ctx);
    if asked.is_some() {
        ctx.state.decisions_changed();
    }
    let name = asked.map(|a| a.name).or_else(|| ctx.state.agent(&f.agent_id).map(|a| a.name)).unwrap_or_else(|| f.agent_id.clone());
    let picks = answer_text(&f.labels, f.earlier);
    match (outcome, error) {
        (Outcome::Answered, _) => {
            info!(session = %ctx.herdr_session, agent = %f.agent_id, request = %f.request_id, picks = ?f.picks, earlier = f.earlier, "decide for me: answered");
            let detail = format!("{} · nobody answered within {}", clip(&f.question, 200), wait_text(f.waited_ms));
            let what = if f.earlier { format!("Auto-sent {picks}") } else { format!("Auto-answered {picks}") };
            ctx.state.record_activity(&f.agent_id, ActivityKind::Answered, what, Some(detail));
            // Opening it (or its Review button) leads to its decision in the Inbox.
            let review = NotifyAction { id: HostPage::Decisions.action_id().to_string(), label: "Review".into(), answer: None };
            ctx.state.broadcast_notification(Notification {
                id: note,
                at: now,
                kind: NotifyKind::Info,
                agent_id: f.agent_id.clone(),
                title: format!("{name} · decided for you"),
                body: clip(&format!("{picks} — {}", f.question), 240),
                request_id: None,
                actions: vec![review],
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
/// `agent.answer` does. Only while the board still shows that very question; returns the agent as
/// the board showed it then (its question and options, for the review item).
async fn deliver(ctx: &Ctx, f: &Fire) -> Result<Agent, ApiError> {
    let agent = ctx.state.agent(&f.agent_id);
    let shown = agent.as_ref().and_then(|a| a.needs.as_ref()).is_some_and(|n| n.answerable && n.request_id.as_deref() == Some(f.request_id.as_str()));
    let Some(agent) = agent.filter(|_| shown) else {
        return Err(ApiError::new("gone", "the question is no longer pending"));
    };
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
    s.answer(&f.request_id, &Answer { choices: f.picks.clone(), text: f.text.clone(), cancel: false, chat: false, back: false }).await?;
    Ok(agent)
}

/// The review item of the answer `f` sent to `agent`'s question (as the board showed it right
/// before sending), whose notification is `note`.
fn decision(f: &Fire, agent: &Agent, now: Millis, note: &str) -> AutoDecision {
    let needs = agent.needs.as_ref();
    let options = needs
        .map(|n| n.options.iter().map(|o| AutoDecisionOption { label: clip(&o.label, LABEL_MAX), recommended: o.recommended, picked: f.picks.contains(&o.id) }).collect())
        .unwrap_or_default();
    let omp = agent.omp.as_ref();
    AutoDecision {
        id: new_id("d"),
        agent_id: f.agent_id.clone(),
        agent_name: agent.name.clone(),
        request_id: f.request_id.clone(),
        title: needs.map(|n| clip(&n.title, LABEL_MAX)).unwrap_or_default(),
        question: clip(&f.question, QUESTION_MAX),
        options,
        multi: needs.is_some_and(|n| n.multi),
        text: f.text.as_deref().map(|t| clip(t, QUESTION_MAX)),
        earlier: f.earlier,
        at: now,
        waited_ms: f.waited_ms,
        source: f.source,
        session_id: omp.and_then(|o| o.session_id.clone()),
        session_file: omp.and_then(|o| o.session_file.clone()),
        cwd: agent.cwd.clone(),
        notification_id: Some(note.to_string()),
    }
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

    /// The log, notifications and needs-you notes say what is sent: ★, or the earlier answer.
    #[test]
    fn answer_texts() {
        let labels = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(answer_text(&labels(&["A", "B"]), false), "★ A, ★ B");
        assert_eq!(answer_text(&labels(&["Postgres", "MySQL 8"]), true), "your earlier answer (Postgres, MySQL 8)");
    }

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

    /// The review item says what was asked, every option with what was sent, and where the
    /// agent's session is (to open it after the agent ended).
    #[test]
    fn a_review_item_keeps_the_question_its_options_and_the_session() {
        use tf_proto::autoanswer::AutoAnswerSource;
        let agent: Agent = serde_json::from_value(serde_json::json!({
            "id": "a1", "name": "push", "kind": "omp", "paneId": "p1", "tabId": "t1", "workspaceId": "w1",
            "state": "blocked", "stateSince": 0, "column": "needs", "archived": false, "turns": 1, "title": "task", "cwd": "/w/push",
            "omp": { "sessionId": "s-1", "sessionFile": "/s/push.jsonl", "link": "live", "bridge": true, "fast": false, "mode": "normal", "queue": { "steering": [], "followUp": [] } },
            "live": { "streaming": false, "thinking": false },
            "needs": { "kind": "ask", "requestId": "7", "since": 0, "title": "Database", "question": "Which databases?", "multi": true,
                "allowOther": true, "allowChat": true, "answerable": true, "options": [
                    { "id": "Use SQLite (Recommended)", "label": "Use SQLite", "recommended": true, "tone": "neutral" },
                    { "id": "Use Postgres", "label": "Use Postgres", "recommended": false, "tone": "neutral" },
                    { "id": "Use MySQL (Recommended)", "label": "Use MySQL", "recommended": true, "tone": "neutral" } ] }
        }))
        .unwrap();
        let f = Fire {
            agent_id: "a1".into(),
            request_id: "7".into(),
            picks: vec!["Use SQLite (Recommended)".into(), "Use MySQL (Recommended)".into()],
            labels: vec!["Use SQLite".into(), "Use MySQL".into()],
            text: None,
            earlier: false,
            question: "Which databases?".into(),
            source: AutoAnswerSource::Agent,
            waited_ms: 600_000,
        };
        let d = decision(&f, &agent, 5_000, "n9");
        let opts: Vec<(&str, bool, bool)> = d.options.iter().map(|o| (o.label.as_str(), o.recommended, o.picked)).collect();
        assert_eq!(opts, [("Use SQLite", true, true), ("Use Postgres", false, false), ("Use MySQL", true, true)]);
        assert_eq!((d.agent_name.as_str(), d.title.as_str(), d.question.as_str(), d.multi, d.earlier), ("push", "Database", "Which databases?", true, false));
        assert_eq!((d.at, d.waited_ms, d.source, d.notification_id.as_deref()), (5_000, 600_000, AutoAnswerSource::Agent, Some("n9")));
        assert_eq!((d.session_id.as_deref(), d.session_file.as_deref(), d.cwd.as_deref()), (Some("s-1"), Some("/s/push.jsonl"), Some("/w/push")));
        // An earlier answer with typed text: the text is kept, nothing reads as picked but its
        // own choices.
        let typed = Fire { picks: vec![], labels: vec!["MariaDB".into()], text: Some("MariaDB".into()), earlier: true, ..f };
        let d = decision(&typed, &agent, 5_000, "n10");
        assert!(d.earlier && d.text.as_deref() == Some("MariaDB") && d.options.iter().all(|o| !o.picked));
    }

    fn drain(c: &crate::clients::ClientHandle) -> Vec<tf_proto::host::ServerMsg> {
        let mut lines = Vec::new();
        c.take_batch(&mut lines);
        lines.iter().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    /// `HostInfo.decisions` of the snapshots and patches a client got.
    fn decision_ids(msgs: &[tf_proto::host::ServerMsg]) -> Vec<Vec<String>> {
        use tf_proto::host::ServerMsg;
        use tf_proto::model::StatePatch;
        let ids = |info: &tf_proto::model::HostInfo| info.decisions.iter().map(|d| d.id.clone()).collect::<Vec<_>>();
        msgs.iter()
            .flat_map(|m| match m {
                ServerMsg::Snapshot { state, .. } => vec![ids(&state.info)],
                ServerMsg::Patch { ops, .. } => ops.iter().filter_map(|op| if let StatePatch::Info { info } = op { Some(ids(info)) } else { None }).collect(),
                _ => vec![],
            })
            .collect()
    }

    /// Review items reach every app of the session: in the snapshot of an app that connects after
    /// they were made (also after a restart), and a review on one device drops them for every
    /// device and retracts their "decided for you" notification on every presence app.
    #[cfg(unix)]
    #[tokio::test]
    async fn review_items_reach_every_app_and_a_review_anywhere_clears_them_everywhere() {
        use crate::clients::{ClientHandle, Features};
        use tf_proto::host::ServerMsg;
        use tf_proto::ClientInfo;
        use tokio_util::sync::CancellationToken;

        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(store::FILE);
        let board = |name: &str| {
            let (dir, name) = (dir.path().to_path_buf(), name.to_string());
            async move {
                let persist = crate::state::persist::Persist::load(dir.join(format!("{name}-state.json")));
                let cancel = CancellationToken::new();
                cancel.cancel();
                let bridge = crate::bridge::BridgeHandle::bind(crate::bridge::BridgeEndpoint::Unix(dir.join(format!("{name}.sock"))), "s".into()).unwrap();
                let omp = crate::omp::OmpHandle::start(0, persist.clone(), cancel, bridge.clone()).await;
                StateHandle::new("lab", persist, omp, bridge)
            }
        };
        let app = |id: &str, device: &str, presence: bool| {
            let info = ClientInfo { app: "teleflock-desktop".into(), version: "0.9.0".into(), platform: "linux".into(), device: device.into(), features: None };
            ClientHandle::with_features(id.into(), info, Features { presence, ..Features::default() })
        };
        let now = now_ms();
        let aa = AutoAnswers::with(file.clone(), "lab", SessionData::default(), now);
        let state = board("a").await;
        let notify = Notifier::load(dir.path(), CancellationToken::new());
        state.route_notifications(notify.clone());
        state.set_auto_answer(aa.clone());
        // Decided while no app was connected.
        aa.core().decided(core::sample_decision("d1", now - 60_000), now);
        aa.core().decided(core::sample_decision("d2", now), now);
        state.decisions_changed();
        let (desk, phone, old) = (app("c1", "Desk", true), app("c2", "Pixel", true), app("c3", "Old", false));
        for c in [&desk, &phone, &old] {
            state.attach_client(c);
            notify.client_attached("lab", c);
            assert_eq!(decision_ids(&drain(c)), [["d1", "d2"]], "in the snapshot of an app that connects afterwards");
        }

        // Reviewed on the desk: every app's board drops it, and the presence apps (the desk too)
        // retract its notification.
        let p = |ids: &[&str]| AutoAnswerReviewParams { ids: ids.iter().map(|s| s.to_string()).collect(), all: false };
        assert_eq!(review_in(&aa, &state, &notify, "lab", "Desk", p(&["d1"])).unwrap().reviewed, ["d1"]);
        for c in [&desk, &phone] {
            let msgs = drain(c);
            assert_eq!(decision_ids(&msgs), [["d2"]]);
            assert!(msgs.contains(&ServerMsg::NotifyDone { ids: vec!["n-d1".into()], by: Some("Desk".into()) }), "{msgs:?}");
        }
        let msgs = drain(&old);
        assert_eq!(decision_ids(&msgs), [["d2"]]);
        assert!(!msgs.iter().any(|m| matches!(m, ServerMsg::NotifyDone { .. })), "an app without presence knows no notifyDone");
        // The phone reviews it too, a moment later: nothing left to do.
        assert!(review_in(&aa, &state, &notify, "lab", "Pixel", p(&["d1"])).unwrap().reviewed.is_empty());
        assert!(drain(&desk).is_empty() && drain(&phone).is_empty());
        assert_eq!(review_in(&aa, &state, &notify, "lab", "Pixel", p(&[])).unwrap_err().code, "invalid_params");
        let late = app("c4", "Laptop", true);
        state.attach_client(&late);
        assert_eq!(decision_ids(&drain(&late)), [["d2"]]);

        // tf-hostd restarts with d2 unreviewed: the session's new board publishes it again.
        save(&aa).await;
        let aa = AutoAnswers::with(file.clone(), "lab", store::load(&file, "lab"), now_ms());
        let state = board("b").await;
        state.set_auto_answer(aa.clone());
        state.decisions_changed();
        let back = app("c5", "Desk", true);
        state.attach_client(&back);
        assert_eq!(decision_ids(&drain(&back)), [["d2"]], "unreviewed items survive a restart");
    }
}
