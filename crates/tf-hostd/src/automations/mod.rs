//! Automations (architecture §3.11): scheduled omp agents. One [`Automations`] per daemon owns
//! the store (`<home>/automations.json`), the scheduler loop and the systemd keepalive; the
//! `automation.*` handlers (`ops/automation.rs`) reach it through [`get`].
//!
//! - [`cron`]: 5-field schedules in local time (DST-safe next/latest fire times, descriptions).
//! - [`store`]: definitions, run history (≤ 100), per-automation schedule cursors.
//! - [`systemd`]: keepalive units so the daemon (and thus the scheduler) survives reboots.

pub mod cron;
pub mod store;
pub mod systemd;

use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use tracing::{info, warn};

use tf_proto::{
    ActivityKind, Agent, AgentSpec, ApiError, Automation, AutomationDraft, AutomationList, AutomationRun, AutomationRunStatus,
    AutomationScheduler, AutomationTrigger, HerdrState, Millis, Notification, NotifyKind, SchedulePreview, StartTarget,
    WorktreeCreateParams,
};

use crate::daemon::Daemon;
use crate::ops::Ctx;
use crate::paths::Paths;
use crate::util::{clip, new_id, now_ms};
use cron::Cron;
use store::StoreData;

/// A scheduled time up to this late still runs as `schedule`; later (the daemon was down, the
/// machine slept) it is a missed run: `catchUp` runs it once, else it is passed over.
pub const LATE_MS: Millis = 2 * 60_000;
/// The scheduler re-reads the wall clock at least this often (sleep/suspend, clock changes).
const MAX_SLEEP: Duration = Duration::from_secs(60);
/// Attempts at a free branch name when a run's branch already exists.
const BRANCH_ATTEMPTS: u32 = 5;

static GLOBAL: OnceLock<Arc<Automations>> = OnceLock::new();

/// The daemon's automations service (absent until [`start`] ran).
pub fn get() -> Option<Arc<Automations>> {
    GLOBAL.get().cloned()
}

pub struct Automations {
    paths: Paths,
    relay_port: u16,
    daemon: Weak<Daemon>,
    data: Mutex<StoreData>,
    scheduler: Mutex<AutomationScheduler>,
    /// Wakes the scheduler loop (definitions changed).
    kick: tokio::sync::Notify,
    /// Serializes keepalive reconciliation.
    keepalive: tokio::sync::Mutex<()>,
    /// Automations whose run is launching right now.
    inflight: Mutex<HashSet<String>>,
}

/// Loads the store and starts the scheduler and keepalive tasks (once per process).
pub fn start(daemon: &Arc<Daemon>) -> Arc<Automations> {
    let data = StoreData::load(&daemon.paths.automations);
    let a = Arc::new(Automations {
        paths: daemon.paths.clone(),
        relay_port: daemon.relay_port,
        daemon: Arc::downgrade(daemon),
        data: Mutex::new(data),
        scheduler: Mutex::new(AutomationScheduler {
            kind: "daemon".into(),
            persistent: false,
            note: None,
            timezone: cron::tz_name(&cron::local_tz()),
        }),
        kick: tokio::sync::Notify::new(),
        keepalive: tokio::sync::Mutex::new(()),
        inflight: Mutex::new(HashSet::new()),
    });
    if GLOBAL.set(a.clone()).is_err() {
        warn!("automations already started");
        return get().expect("set");
    }
    let n = a.data.lock().unwrap().automations.len();
    info!(automations = n, "automations: scheduler starting");
    tokio::spawn(a.clone().scheduler_loop(daemon.shutdown.clone()));
    tokio::spawn({
        let a = a.clone();
        async move { a.sync_keepalive().await }
    });
    a
}

/// What the scheduler does with one automation now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Nothing due; the next fire time (absent: never).
    Wait(Option<Millis>),
    /// Run now; afterwards times up to `through` count as handled.
    Fire { trigger: AutomationTrigger, through: Millis },
    /// Missed runs without catch-up: mark them handled.
    Pass { through: Millis },
}

/// Decides one automation: `through` is its cursor (latest schedule time already handled).
/// Only the latest missed time counts, so a long outage runs at most once.
pub fn decide(cron: &Cron, through: Millis, now: Millis, catch_up: bool, tz: &jiff::tz::TimeZone) -> Decision {
    match cron.next_after(through, tz) {
        None => Decision::Wait(None),
        Some(next) if next > now => Decision::Wait(Some(next)),
        Some(_) => {
            let latest = cron.latest_between(through, now, tz).unwrap_or(now);
            if now - latest <= LATE_MS {
                Decision::Fire { trigger: AutomationTrigger::Schedule, through: latest }
            } else if catch_up {
                Decision::Fire { trigger: AutomationTrigger::CatchUp, through: latest }
            } else {
                Decision::Pass { through: latest }
            }
        }
    }
}

/// Why a scheduled run must not start: the previous run's agent is still busy (pile-up guard).
pub fn skip_reason(previous: Option<&AutomationRun>, agent: Option<&Agent>) -> Option<String> {
    let previous = previous?;
    let agent = agent.filter(|a| Some(&a.id) == previous.agent_id.as_ref())?;
    match agent.state {
        HerdrState::Working => Some(format!("{} from the previous run is still working", agent.name)),
        HerdrState::Blocked => Some(format!("{} from the previous run needs you", agent.name)),
        _ => None,
    }
}

/// `automation.preview`.
pub fn preview(schedule: &str) -> SchedulePreview {
    match Cron::parse(schedule) {
        Err(e) => SchedulePreview { valid: false, error: Some(e), next: vec![], description: None },
        Ok(c) => {
            let next = c.upcoming(now_ms(), 5, &cron::local_tz());
            if next.is_empty() {
                SchedulePreview { valid: false, error: Some("This schedule never runs.".into()), next, description: Some(c.describe()) }
            } else {
                SchedulePreview { valid: true, error: None, next, description: Some(c.describe()) }
            }
        }
    }
}

fn invalid(msg: impl Into<String>) -> ApiError {
    ApiError::new("invalid_params", msg)
}

fn not_found(id: &str) -> ApiError {
    ApiError::new("not_found", format!("automation {id} does not exist"))
}

impl Automations {
    fn persist(&self, data: &StoreData) {
        if let Err(e) = data.save(&self.paths.automations) {
            warn!(path = %self.paths.automations.display(), "automations: save failed: {e}");
        }
    }

    /// Adds `nextRunAt` / `lastRun` to a stored definition.
    fn decorate(data: &StoreData, a: &Automation, now: Millis, tz: &jiff::tz::TimeZone) -> Automation {
        let mut a = a.clone();
        a.next_run_at = if a.enabled { Cron::parse(&a.schedule).ok().and_then(|c| c.next_after(now, tz)) } else { None };
        a.last_run = data.last_run(&a.id).cloned();
        a
    }

    /// `automation.list` for one herdr session.
    pub fn list(&self, session: &str) -> AutomationList {
        let tz = cron::local_tz();
        let now = now_ms();
        let data = self.data.lock().unwrap();
        let automations: Vec<Automation> =
            data.automations.iter().filter(|a| a.herdr_session == session).map(|a| Self::decorate(&data, a, now, &tz)).collect();
        let ids: HashSet<&str> = automations.iter().map(|a| a.id.as_str()).collect();
        let runs = data.runs.iter().filter(|r| ids.contains(r.automation_id.as_str())).cloned().collect();
        AutomationList { automations, runs, scheduler: self.scheduler.lock().unwrap().clone() }
    }

    /// `automation.save`: creates (no id) or replaces an automation of `session`.
    pub fn save(&self, session: &str, draft: AutomationDraft) -> Result<Automation, ApiError> {
        let d = store::validate(draft).map_err(invalid)?;
        let now = now_ms();
        let mut data = self.data.lock().unwrap();
        let id = match &d.id {
            Some(id) => {
                let Some(cur) = data.automations.iter_mut().find(|a| &a.id == id && a.herdr_session == session) else {
                    return Err(not_found(id));
                };
                cur.name = d.name;
                cur.enabled = d.enabled;
                cur.schedule = d.schedule;
                cur.cwd = d.cwd;
                cur.worktree = d.worktree;
                cur.prompt = d.prompt;
                cur.model = d.model;
                cur.thinking = d.thinking;
                cur.plan = d.plan;
                cur.catch_up = d.catch_up;
                cur.updated_at = now;
                id.clone()
            }
            None => {
                let id = new_id("au");
                data.automations.push(Automation {
                    id: id.clone(),
                    name: d.name,
                    enabled: d.enabled,
                    schedule: d.schedule,
                    cwd: d.cwd,
                    worktree: d.worktree,
                    prompt: d.prompt,
                    model: d.model,
                    thinking: d.thinking,
                    plan: d.plan,
                    catch_up: d.catch_up,
                    herdr_session: session.to_string(),
                    created_at: now,
                    updated_at: now,
                    next_run_at: None,
                    last_run: None,
                });
                id
            }
        };
        // Times before an edit never fire (nor count as missed).
        data.scheduled_through.insert(id.clone(), now);
        self.persist(&data);
        let a = data.get(&id).expect("just saved");
        info!(id = %a.id, name = %a.name, schedule = %a.schedule, enabled = a.enabled, "automation saved");
        let out = Self::decorate(&data, a, now, &cron::local_tz());
        drop(data);
        self.kick.notify_one();
        Ok(out)
    }

    /// `automation.delete`.
    pub fn delete(&self, session: &str, id: &str) -> Result<(), ApiError> {
        let mut data = self.data.lock().unwrap();
        if !data.get(id).is_some_and(|a| a.herdr_session == session) {
            return Err(not_found(id));
        }
        data.remove(id);
        self.persist(&data);
        drop(data);
        info!(id, "automation deleted");
        self.kick.notify_one();
        Ok(())
    }

    /// `automation.run`: runs an automation of the client's session now.
    pub async fn run_now(&self, ctx: &Ctx, id: &str) -> Result<AutomationRun, ApiError> {
        let def = {
            let data = self.data.lock().unwrap();
            data.get(id).filter(|a| a.herdr_session == ctx.herdr_session).cloned().ok_or_else(|| not_found(id))?
        };
        Ok(self.execute(ctx, &def, AutomationTrigger::Manual).await)
    }

    async fn scheduler_loop(self: Arc<Self>, shutdown: tokio_util::sync::CancellationToken) {
        loop {
            let tz = cron::local_tz();
            let now = now_ms();
            let mut due: Vec<(Automation, AutomationTrigger)> = Vec::new();
            let mut wake: Option<Millis> = None;
            {
                let mut data = self.data.lock().unwrap();
                let mut changed = false;
                for a in data.automations.clone() {
                    if !a.enabled {
                        continue;
                    }
                    let Ok(c) = Cron::parse(&a.schedule) else { continue };
                    let through = *data.scheduled_through.entry(a.id.clone()).or_insert(a.updated_at);
                    match decide(&c, through, now, a.catch_up, &tz) {
                        Decision::Wait(next) => wake = wake.into_iter().chain(next).min(),
                        Decision::Fire { trigger, through } => {
                            data.scheduled_through.insert(a.id.clone(), through);
                            changed = true;
                            due.push((a, trigger));
                        }
                        Decision::Pass { through } => {
                            info!(id = %a.id, name = %a.name, "automation: missed run passed over (catch-up off)");
                            data.scheduled_through.insert(a.id.clone(), through);
                            changed = true;
                        }
                    }
                }
                if changed {
                    self.persist(&data);
                }
            }
            if !due.is_empty() {
                // Some fired: re-plan right away for their next times.
                for (a, trigger) in due {
                    tokio::spawn(self.clone().fire(a, trigger));
                }
                continue;
            }
            let sleep = wake.map(|w| Duration::from_millis((w - now).max(0) as u64)).unwrap_or(MAX_SLEEP).min(MAX_SLEEP);
            tokio::select! {
                _ = shutdown.cancelled() => return,
                _ = self.kick.notified() => {}
                _ = tokio::time::sleep(sleep) => {}
            }
        }
    }

    /// Installs or removes the systemd keepalive to match the enabled set and refreshes the
    /// reported scheduler status. Serialized; `save`/`delete` callers await it so the next
    /// `automation.list` reports the new state.
    pub async fn sync_keepalive(&self) {
        let _one = self.keepalive.lock().await;
        let want = self.data.lock().unwrap().any_enabled();
        let status = systemd::reconcile(&self.paths, self.relay_port, want).await;
        *self.scheduler.lock().unwrap() = status;
    }

    /// A scheduled (or catch-up) run in the automation's own herdr session.
    async fn fire(self: Arc<Self>, def: Automation, trigger: AutomationTrigger) {
        let Some(daemon) = self.daemon.upgrade() else { return };
        info!(id = %def.id, name = %def.name, ?trigger, "automation: firing");
        match daemon.ctx_for(&def.herdr_session).await {
            Ok(ctx) => {
                self.execute(&ctx, &def, trigger).await;
            }
            Err(e) => {
                let run = self.new_run(&def, trigger, AutomationRunStatus::Failed);
                self.record(None, &def, AutomationRun { error: Some(format!("herdr session {}: {}", def.herdr_session, e.message)), ..run });
            }
        }
    }

    fn new_run(&self, def: &Automation, trigger: AutomationTrigger, status: AutomationRunStatus) -> AutomationRun {
        AutomationRun {
            id: new_id("ar"),
            automation_id: def.id.clone(),
            at: now_ms(),
            trigger,
            status,
            agent_id: None,
            workspace_id: None,
            branch: None,
            path: None,
            error: None,
        }
    }

    /// Runs one automation in `ctx`, records the run and tells the session's clients.
    async fn execute(&self, ctx: &Ctx, def: &Automation, trigger: AutomationTrigger) -> AutomationRun {
        if trigger != AutomationTrigger::Manual {
            let previous = self.data.lock().unwrap().last_started(&def.id).cloned();
            let agent = previous.as_ref().and_then(|p| p.agent_id.as_deref()).and_then(|id| ctx.state.agent(id));
            if let Some(why) = skip_reason(previous.as_ref(), agent.as_ref()) {
                let run = AutomationRun { error: Some(why), agent_id: agent.map(|a| a.id), ..self.new_run(def, trigger, AutomationRunStatus::Skipped) };
                return self.record(Some(ctx), def, run);
            }
        }
        if !self.inflight.lock().unwrap().insert(def.id.clone()) {
            let run = AutomationRun { error: Some("the previous run is still starting".into()), ..self.new_run(def, trigger, AutomationRunStatus::Skipped) };
            return self.record(Some(ctx), def, run);
        }
        let run = self.launch(ctx, def, trigger).await;
        self.inflight.lock().unwrap().remove(&def.id);
        self.record(Some(ctx), def, run)
    }

    /// The run recipe: a fresh worktree (`automation/<slug>-<yyyymmdd-hhmm>` from the default
    /// base) with the agent in it, or the agent in a new workspace at `cwd`.
    async fn launch(&self, ctx: &Ctx, def: &Automation, trigger: AutomationTrigger) -> AutomationRun {
        let mut run = self.new_run(def, trigger, AutomationRunStatus::Started);
        let slug = store::slug(&def.name);
        let taken: Vec<String> = ctx.state.snapshot().agents.into_iter().map(|a| a.name).collect();
        let spec = AgentSpec {
            name: Some(crate::ops::agent::derive_handle(&format!("auto-{slug}"), &taken)),
            kind: "omp".into(),
            model: def.model.clone(),
            thinking: def.thinking,
            plan: def.plan,
            prompt: Some(def.prompt.clone()).filter(|p| !p.trim().is_empty()),
            images: vec![],
        };
        let result = if def.worktree {
            let base = format!("automation/{slug}-{}", cron::stamp(run.at, &cron::local_tz()));
            let mut attempt = 1;
            loop {
                let branch = if attempt == 1 { base.clone() } else { format!("{base}-{attempt}") };
                let params = WorktreeCreateParams {
                    cwd: def.cwd.clone(),
                    branch,
                    base: None,
                    path: None,
                    label: Some(def.name.clone()),
                    existing: false,
                    trust: false,
                    agent: Some(spec.clone()),
                };
                match crate::ops::worktree::create(ctx, params).await {
                    Err(e) if e.code == "branch_exists" && attempt < BRANCH_ATTEMPTS => attempt += 1,
                    Err(e) => break Err(e),
                    Ok(w) => {
                        run.branch = Some(w.branch);
                        run.path = Some(w.path);
                        run.workspace_id = Some(w.workspace_id);
                        break Ok(w.agent);
                    }
                }
            }
        } else {
            run.path = Some(def.cwd.clone());
            crate::ops::agent::start_agent(ctx, StartTarget::Cwd { cwd: def.cwd.clone(), label: Some(def.name.clone()) }, &spec, None)
                .await
                .map(Some)
        };
        match result {
            Ok(started) => {
                if let Some(s) = started {
                    run.agent_id = s.agent_id;
                    if !s.workspace_id.is_empty() {
                        run.workspace_id = Some(s.workspace_id);
                    }
                }
            }
            Err(e) => {
                run.status = AutomationRunStatus::Failed;
                run.error = Some(match e.hint {
                    Some(h) => format!("{} ({h})", e.message),
                    None => e.message,
                });
            }
        }
        run
    }

    /// Stores the run, logs it to the activity feed and notifies the session's clients.
    fn record(&self, ctx: Option<&Ctx>, def: &Automation, run: AutomationRun) -> AutomationRun {
        {
            let mut data = self.data.lock().unwrap();
            data.push_run(run.clone());
            self.persist(&data);
        }
        info!(id = %def.id, name = %def.name, status = ?run.status, agent = ?run.agent_id, error = ?run.error, "automation run");
        let Some(ctx) = ctx else { return run };
        let agent_id = run.agent_id.clone().unwrap_or_default();
        let agent_name = ctx.state.agent(&agent_id).map(|a| a.name).or_else(|| run.agent_id.clone()).unwrap_or_default();
        let (title, body) = match run.status {
            AutomationRunStatus::Started => {
                let where_ = run.branch.as_deref().or(run.path.as_deref()).unwrap_or_default();
                (format!("Automation {} started {agent_name}", def.name), format!("{where_} · {}", clip(&def.prompt, 120)))
            }
            AutomationRunStatus::Failed => (format!("Automation {} failed", def.name), run.error.clone().unwrap_or_default()),
            AutomationRunStatus::Skipped => (format!("Automation {} skipped", def.name), run.error.clone().unwrap_or_default()),
        };
        if !agent_id.is_empty() {
            let kind = match run.status {
                AutomationRunStatus::Started => ActivityKind::Started,
                _ => ActivityKind::Error,
            };
            ctx.state.record_activity(&agent_id, kind, title.clone(), Some(body.clone()));
        }
        // Skips are routine (the pile-up guard); only starts and failures notify.
        if run.status != AutomationRunStatus::Skipped {
            ctx.state.broadcast_notification(Notification {
                id: new_id("n"),
                at: run.at,
                kind: NotifyKind::Info,
                agent_id,
                title,
                body,
                request_id: None,
                actions: vec![],
            });
        }
        run
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jiff::tz::TimeZone;

    const H: Millis = 3_600_000;
    const T0: Millis = 1_767_225_600_000; // 2026-01-01T00:00:00Z

    #[test]
    fn decide_waits_fires_and_catches_up() {
        let tz = TimeZone::UTC;
        let hourly = Cron::parse("0 * * * *").unwrap();
        // Before the next time: wait for it.
        assert_eq!(decide(&hourly, T0, T0 + H / 2, true, &tz), Decision::Wait(Some(T0 + H)));
        // On time (slightly late): a normal run.
        assert_eq!(
            decide(&hourly, T0, T0 + H + 30_000, false, &tz),
            Decision::Fire { trigger: AutomationTrigger::Schedule, through: T0 + H }
        );
        // Down for 5 h 30 m: only the latest missed time, once, as catch-up…
        assert_eq!(
            decide(&hourly, T0, T0 + 5 * H + H / 2, true, &tz),
            Decision::Fire { trigger: AutomationTrigger::CatchUp, through: T0 + 5 * H }
        );
        // …or passed over without catch-up.
        assert_eq!(decide(&hourly, T0, T0 + 5 * H + H / 2, false, &tz), Decision::Pass { through: T0 + 5 * H });
        // Down for hours but a time just passed: that one is a regular run.
        assert_eq!(
            decide(&hourly, T0, T0 + 5 * H + 60_000, false, &tz),
            Decision::Fire { trigger: AutomationTrigger::Schedule, through: T0 + 5 * H }
        );
        // After firing, the cursor makes the next decision wait.
        assert_eq!(decide(&hourly, T0 + 5 * H, T0 + 5 * H + 61_000, true, &tz), Decision::Wait(Some(T0 + 6 * H)));
        // Never fires.
        assert_eq!(decide(&Cron::parse("0 0 30 2 *").unwrap(), T0, T0, true, &tz), Decision::Wait(None));
    }

    fn agent(id: &str, state: HerdrState) -> Agent {
        let info = tf_herdr::AgentInfo { pane_id: "w1:p1".into(), terminal_id: "t".into(), ..Default::default() };
        let mut a = crate::state::build::build_agent(&crate::state::build::AgentInputs {
            herdr: &info,
            omp: None,
            link: (tf_proto::model::LinkState::NotShared, None),
            omp_session_id: None,
            omp_pid: None,
            bridge: None,
            archived: false,
            turns: 0,
            first_seen: None,
            state_since: 0,
            needs_since: 0,
            pane_activity: None,
            repo: None,
            turn_started_at: None,
            last_turn_ended_at: None,
            blocked_grace: false,
        });
        a.id = id.into();
        a.name = "auto-nightly".into();
        a.state = state;
        a
    }

    #[test]
    fn skips_while_previous_agent_busy() {
        let prev = AutomationRun {
            id: "r1".into(),
            automation_id: "au1".into(),
            at: 1,
            trigger: AutomationTrigger::Schedule,
            status: AutomationRunStatus::Started,
            agent_id: Some("ag1".into()),
            workspace_id: None,
            branch: None,
            path: None,
            error: None,
        };
        assert_eq!(skip_reason(None, None), None);
        assert_eq!(skip_reason(Some(&prev), None), None, "agent gone: run");
        assert!(skip_reason(Some(&prev), Some(&agent("ag1", HerdrState::Working))).unwrap().contains("still working"));
        assert!(skip_reason(Some(&prev), Some(&agent("ag1", HerdrState::Blocked))).unwrap().contains("needs you"));
        assert_eq!(skip_reason(Some(&prev), Some(&agent("ag1", HerdrState::Idle))), None);
        assert_eq!(skip_reason(Some(&prev), Some(&agent("ag1", HerdrState::Done))), None);
        // Another agent (pane reused): not ours.
        assert_eq!(skip_reason(Some(&prev), Some(&agent("ag2", HerdrState::Working))), None);
    }

    #[test]
    fn previews() {
        let p = preview("*/5 * * * *");
        assert!(p.valid);
        assert_eq!(p.next.len(), 5);
        assert!(p.next.windows(2).all(|w| w[1] - w[0] == 5 * 60_000));
        assert_eq!(p.description.as_deref(), Some("Every 5 minutes"));
        let bad = preview("every day");
        assert!(!bad.valid && bad.error.is_some() && bad.next.is_empty());
        let never = preview("0 0 31 4 *");
        assert!(!never.valid && never.error.as_deref() == Some("This schedule never runs."));
    }
}
