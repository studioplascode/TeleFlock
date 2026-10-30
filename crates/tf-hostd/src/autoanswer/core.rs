//! The decide-for-me state machine of one herdr session (architecture §3.23), free of I/O and
//! clocks so it is tested exactly: the policies (host default, per agent) and one countdown per
//! agent whose pending question qualifies.
//!
//! A countdown counts the time a question waited under its policy: `elapsed_ms` plus the running
//! stretch since `running_since`. Its wait is the policy's `afterSecs` plus `extra_ms`
//! (postponing), so a changed policy applies at once and the time already counted stays counted.
//! The clock stands still while the policy wants no app connected and one is (or tf-hostd started
//! less than [`START_GRACE_MS`] ago), after a cancel, and once it fell due.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use tf_proto::autoanswer::{AgentAutoAnswer, AutoAnswer, AutoAnswerCountdown, AutoAnswerSource, AutoAnswerStatus, AUTO_ANSWER_MAX_SECS};
use tf_proto::model::{Agent, LinkState, NeedsKind};
use tf_proto::{ApiError, Millis};

/// For this long after the session's context started (a tf-hostd restart), an app counts as
/// connected: apps that were connected before reconnect within seconds, and a countdown that wants
/// no app must not run (or fire) in between.
pub const START_GRACE_MS: Millis = 60_000;
/// A delivery that failed for a reason that passes (the session's link is down) is tried again
/// after this long.
pub const RETRY_MS: Millis = 5_000;
/// A countdown whose agent the board stopped showing is dropped after this long.
pub const STALE_MS: Millis = 10 * 60_000;
/// An agent's own policy outlives its agent on the board this long (a launch binds it before
/// herdr reports the agent).
pub const SWEEP_GRACE_MS: Millis = 5 * 60_000;

const MAX_MS: i64 = AUTO_ANSWER_MAX_SECS as i64 * 1000;

/// What one herdr session keeps (`<home>/auto-answer.json`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionData {
    /// The host default (`host.autoAnswerSet`); never set = off.
    pub default: Option<AutoAnswer>,
    /// Agent id → its own policy (`AgentSpec.autoAnswer`, `agent.setAutoAnswer`).
    pub agents: BTreeMap<String, OwnPolicy>,
    /// Agent id → the countdown on its pending question.
    pub pending: BTreeMap<String, Countdown>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnPolicy {
    pub policy: AutoAnswer,
    /// When it was set.
    pub at: Millis,
}

/// The countdown on one agent's pending question.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Countdown {
    pub request_id: String,
    pub question: String,
    /// Exact option ids the answer sends (collab labels) and how the options read.
    pub picks: Vec<String>,
    pub labels: Vec<String>,
    /// When the countdown started.
    pub since: Millis,
    /// Added by postponing (negative when a cancelled countdown was started again with less time
    /// than its policy's wait had left): the wait is `afterSecs` plus this.
    pub extra_ms: i64,
    /// Time counted before the running stretch.
    pub elapsed_ms: i64,
    /// Start of the running stretch; `None` while the clock stands still.
    pub running_since: Option<Millis>,
    pub cancelled: bool,
    /// When it fell due: tf-hostd is answering, or waits to deliver the answer.
    pub due_at: Option<Millis>,
    /// The answer was delivered; the countdown waits for the question to go away.
    pub answered: bool,
    /// After a delivery that failed for a passing reason: the next attempt.
    pub retry_at: Option<Millis>,
    /// Last time the board showed the agent (not saved for this alone).
    pub seen_at: Millis,
    /// A delivery runs right now (never saved: a restart tries again).
    #[serde(skip)]
    pub in_flight: bool,
}

/// A question that qualifies: an answerable omp `ask` with a ★ recommended option.
#[derive(Debug, Clone, PartialEq)]
pub struct Question {
    pub request_id: String,
    pub question: String,
    pub ids: Vec<String>,
    pub labels: Vec<String>,
}

/// The question of `agent` decide-for-me may answer: an answerable `ask` (never approvals, plan
/// reviews, confirmations, free-text input or terminal-only prompts) with a ★ recommended option.
/// A single choice picks the first recommended option, a multi-select every recommended one.
pub fn qualifying(agent: &Agent) -> Option<Question> {
    if agent.kind != "omp" || agent.parked.is_some() {
        return None;
    }
    let n = agent.needs.as_ref()?;
    if n.kind != NeedsKind::Ask || !n.answerable {
        return None;
    }
    let request_id = n.request_id.clone()?;
    let rec: Vec<_> = n.options.iter().filter(|o| o.recommended).take(if n.multi { usize::MAX } else { 1 }).collect();
    if rec.is_empty() {
        return None;
    }
    Some(Question {
        request_id,
        question: n.question.clone(),
        ids: rec.iter().map(|o| o.id.clone()).collect(),
        labels: rec.iter().map(|o| o.label.clone()).collect(),
    })
}

/// A countdown that fell due: answer `request_id` of `agent_id` with `picks`.
#[derive(Debug, Clone, PartialEq)]
pub struct Fire {
    pub agent_id: String,
    pub request_id: String,
    pub picks: Vec<String>,
    pub labels: Vec<String>,
    pub question: String,
    pub source: AutoAnswerSource,
    /// The wait that ran out (the policy's plus postponements).
    pub waited_ms: i64,
}

/// How a delivery went.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// omp has the answer.
    Answered,
    /// The session's link is down (or a similar passing reason): try again.
    Retry,
    /// The question is gone (answered elsewhere, its turn ended).
    Gone,
    /// omp refused it: the question waits for a person.
    Failed,
    /// The policy no longer allows an answer (an app connected after the countdown fell due, the
    /// policy was turned off): nothing was sent; the countdown stands again.
    Hold,
}

pub struct Core {
    data: SessionData,
    /// Agents whose countdown came from disk and has not met its question since: the first
    /// qualifying question with the same text and picks adopts it (its request id may be new), and
    /// it never fires before that.
    restored: HashSet<String>,
    /// When the session's context started ([`START_GRACE_MS`]).
    started: Millis,
    /// Bumped by every change of what is saved (or shown); `saved`: as of the last save.
    changes: u64,
    saved: u64,
    /// Whether an app was connected when presence was last told (every delivery asks again).
    clients: bool,
}

impl Core {
    pub fn new(data: SessionData, now: Millis) -> Self {
        let restored = data.pending.keys().cloned().collect();
        Self { data, restored, started: now, changes: 0, saved: 0, clients: false }
    }

    pub fn data(&self) -> &SessionData {
        &self.data
    }

    /// Counts changes: a caller that saw it move rebuilds the board or reschedules.
    pub fn changes(&self) -> u64 {
        self.changes
    }

    pub fn is_dirty(&self) -> bool {
        self.changes != self.saved
    }

    /// The data to save, when something changed since the last call.
    pub fn take_dirty(&mut self) -> Option<SessionData> {
        self.is_dirty().then(|| {
            self.saved = self.changes;
            self.data.clone()
        })
    }

    fn touch(&mut self, changed: bool) {
        self.changes += u64::from(changed);
    }

    /// The host default (off until set).
    pub fn host_default(&self) -> AutoAnswer {
        self.data.default.clone().unwrap_or(AutoAnswer::OFF)
    }

    pub fn own(&self, agent_id: &str) -> Option<AutoAnswer> {
        self.data.agents.get(agent_id).map(|o| o.policy.clone())
    }

    /// The policy in force for an agent: its own, else the host default while that is on.
    pub fn effective(&self, agent_id: &str) -> Option<(AutoAnswer, AutoAnswerSource)> {
        match self.data.agents.get(agent_id) {
            Some(own) => Some((own.policy.clone(), AutoAnswerSource::Agent)),
            None => self.data.default.clone().filter(|d| d.enabled).map(|d| (d, AutoAnswerSource::Host)),
        }
    }

    fn enabled(&self, agent_id: &str) -> Option<(AutoAnswer, AutoAnswerSource)> {
        self.effective(agent_id).filter(|(p, _)| p.enabled)
    }

    /// An app counts as connected (or tf-hostd started too recently to tell).
    pub fn apps(&self, now: Millis, has_clients: bool) -> bool {
        has_clients || now - self.started < START_GRACE_MS
    }

    pub fn set_default(&mut self, policy: AutoAnswer, now: Millis, has_clients: bool) {
        if self.data.default.as_ref() != Some(&policy) {
            self.data.default = Some(policy);
            self.touch(true);
        }
        self.presence(now, has_clients);
    }

    /// Sets (`Some`) or clears an agent's own policy.
    pub fn set_own(&mut self, agent_id: &str, policy: Option<AutoAnswer>, now: Millis, has_clients: bool) {
        let changed = match policy {
            Some(policy) => self.data.agents.insert(agent_id.to_string(), OwnPolicy { policy: policy.clone(), at: now }).is_none_or(|old| old.policy != policy),
            None => self.data.agents.remove(agent_id).is_some(),
        };
        self.touch(changed);
        self.presence(now, has_clients);
    }

    /// Forgets an agent (resumed under another id).
    pub fn forget(&mut self, agent_id: &str) {
        let a = self.data.agents.remove(agent_id).is_some();
        let p = self.data.pending.remove(agent_id).is_some();
        self.restored.remove(agent_id);
        self.touch(a || p);
    }

    /// The board built `agent`: starts, keeps or drops its countdown and returns what the agent
    /// shows (`Agent.autoAnswer`). `has_clients`: an app is connected to the session.
    pub fn observe(&mut self, agent: &Agent, now: Millis, has_clients: bool) -> Option<AgentAutoAnswer> {
        if agent.kind != "omp" {
            return None;
        }
        let effective = self.effective(&agent.id);
        self.clients = has_clients;
        let apps = self.apps(now, has_clients);
        match (effective.as_ref().filter(|(p, _)| p.enabled), qualifying(agent)) {
            (Some((p, _)), Some(q)) => {
                let restored = self.restored.remove(&agent.id);
                let same = self
                    .data
                    .pending
                    .get(&agent.id)
                    .is_some_and(|e| e.request_id == q.request_id || (restored && e.question == q.question && e.picks == q.ids));
                if same {
                    let e = self.data.pending.get_mut(&agent.id).expect("checked above");
                    e.seen_at = now;
                    let adopted = e.request_id != q.request_id;
                    if adopted {
                        e.request_id = q.request_id;
                    }
                    let stood = p.only_when_no_app && apps && stands_down(e);
                    let run = runs(e, p, apps);
                    let changed = set_running(e, run, now) || stood;
                    self.touch(adopted || changed);
                } else {
                    let mut e = Countdown { request_id: q.request_id, question: q.question, picks: q.ids, labels: q.labels, since: now, seen_at: now, ..Default::default() };
                    let run = runs(&e, p, apps);
                    set_running(&mut e, run, now);
                    self.data.pending.insert(agent.id.clone(), e);
                    self.touch(true);
                }
            }
            (Some(_), None) => {
                // No qualifying question. Once the session is live that means it went away
                // (answered, its turn ended); while the link is down a resync brings it back.
                if agent.omp.as_ref().is_some_and(|o| o.link == LinkState::Live) {
                    self.restored.remove(&agent.id);
                    let gone = self.data.pending.remove(&agent.id).is_some();
                    self.touch(gone);
                } else if let Some(e) = self.data.pending.get_mut(&agent.id) {
                    e.seen_at = now;
                }
            }
            (None, _) => {
                self.restored.remove(&agent.id);
                let gone = self.data.pending.remove(&agent.id).is_some();
                self.touch(gone);
            }
        }
        let (policy, source) = effective?;
        let shown = agent.needs.as_ref().and_then(|n| n.request_id.as_deref());
        let countdown = self.data.pending.get(&agent.id).filter(|e| Some(e.request_id.as_str()) == shown).map(|e| view(e, &policy));
        Some(AgentAutoAnswer { policy, source, countdown })
    }

    /// Starts or stops every clock for the current presence of apps (and drops countdowns whose
    /// policy went off). True when anything changed.
    pub fn presence(&mut self, now: Millis, has_clients: bool) -> bool {
        self.clients = has_clients;
        let apps = self.apps(now, has_clients);
        let mut changed = false;
        let ids: Vec<String> = self.data.pending.keys().cloned().collect();
        for id in ids {
            let Some((p, _)) = self.enabled(&id) else {
                self.data.pending.remove(&id);
                self.restored.remove(&id);
                changed = true;
                continue;
            };
            let e = self.data.pending.get_mut(&id).expect("listed above");
            // It fell due while nobody was there (or an answer is waiting for its retry) and an
            // app is here now: that is not the time to answer. The clock stands at the full wait
            // and the answer follows the moment no app is connected again.
            if p.only_when_no_app && apps && stands_down(e) {
                changed = true;
            }
            let run = runs(e, &p, apps);
            changed |= set_running(e, run, now);
        }
        self.touch(changed);
        changed
    }

    /// Countdowns to answer now (each handed out once until [`Core::fired`] reports back).
    /// Marks the ones that ran out as due.
    pub fn due(&mut self, now: Millis) -> Vec<Fire> {
        let mut out = Vec::new();
        let ids: Vec<String> = self.data.pending.keys().cloned().collect();
        for id in ids {
            let Some((p, source)) = self.enabled(&id) else { continue };
            let apps = self.apps(now, self.clients);
            let restored = self.restored.contains(&id);
            let e = self.data.pending.get_mut(&id).expect("listed above");
            if e.answered || e.cancelled || e.in_flight {
                continue;
            }
            // The policy is asked again at every delivery, retries included: a countdown that fell
            // due once is no standing permission.
            if p.only_when_no_app && apps && stands_down(e) {
                self.changes += 1;
                continue;
            }
            if e.due_at.is_none() {
                let Some(rs) = e.running_since else { continue };
                let left = budget(e, &p) - e.elapsed_ms - (now - rs);
                if left > 0 {
                    continue;
                }
                // Due: the clock stops at the full wait.
                e.due_at = Some(now + left);
                e.elapsed_ms = budget(e, &p);
                e.running_since = None;
                self.changes += 1;
            }
            if restored || e.retry_at.is_some_and(|t| t > now) {
                continue;
            }
            e.in_flight = true;
            e.retry_at = None;
            out.push(Fire {
                agent_id: id.clone(),
                request_id: e.request_id.clone(),
                picks: e.picks.clone(),
                labels: e.labels.clone(),
                question: e.question.clone(),
                source,
                waited_ms: budget(e, &p),
            });
        }
        out
    }

    /// Records how the delivery of `fire` went.
    pub fn fired(&mut self, fire: &Fire, outcome: Outcome, now: Millis) {
        let Some(e) = self.data.pending.get_mut(&fire.agent_id).filter(|e| e.request_id == fire.request_id) else { return };
        e.in_flight = false;
        match outcome {
            Outcome::Answered => e.answered = true,
            Outcome::Retry => e.retry_at = Some(now + RETRY_MS),
            Outcome::Gone => {
                self.data.pending.remove(&fire.agent_id);
            }
            Outcome::Failed => {
                e.cancelled = true;
                e.due_at = None;
            }
            Outcome::Hold => {
                e.due_at = None;
                e.retry_at = None;
            }
        }
        self.touch(true);
    }

    /// Whether the policy allows delivering `fire` now (asked right before every delivery).
    pub fn permitted(&mut self, fire: &Fire, now: Millis, has_clients: bool) -> bool {
        self.clients = has_clients;
        let apps = self.apps(now, has_clients);
        self.enabled(&fire.agent_id).is_some_and(|(p, _)| !(p.only_when_no_app && apps))
    }

    /// When something next falls due or needs another look (a retry, the end of the start
    /// grace while a clock waits for it).
    pub fn next_wake(&self, now: Millis) -> Option<Millis> {
        let mut next: Option<Millis> = None;
        let mut at = |t: Millis| next = Some(next.map_or(t, |n| n.min(t)));
        for (id, e) in &self.data.pending {
            let Some((p, _)) = self.enabled(id) else { continue };
            if e.answered || e.cancelled || e.in_flight {
                continue;
            }
            if e.due_at.is_some() {
                if !self.restored.contains(id) {
                    at(e.retry_at.unwrap_or(now));
                }
            } else if let Some(rs) = e.running_since {
                at(rs + budget(e, &p) - e.elapsed_ms);
            } else if p.only_when_no_app && now - self.started < START_GRACE_MS {
                at(self.started + START_GRACE_MS);
            }
        }
        next
    }

    fn entry_mut(&mut self, agent_id: &str, request_id: &str) -> Result<&mut Countdown, ApiError> {
        self.data
            .pending
            .get_mut(agent_id)
            .filter(|e| e.request_id == request_id)
            .ok_or_else(|| ApiError::new("not_found", "this question has no decide-for-me countdown (it was answered, or decide for me is off)"))
    }

    /// `agent.autoAnswerCancel`: the question waits for a person.
    pub fn cancel(&mut self, agent_id: &str, request_id: &str, now: Millis) -> Result<(), ApiError> {
        let e = self.entry_mut(agent_id, request_id)?;
        if e.answered || e.in_flight || e.due_at.is_some() {
            return Err(ApiError::new("busy", "decide for me is already answering this question"));
        }
        if !e.cancelled {
            set_running(e, false, now);
            e.cancelled = true;
            self.touch(true);
        }
        Ok(())
    }

    /// `agent.autoAnswerPostpone`: `secs` more to wait (what is left is capped at 24 hours); a
    /// cancelled countdown, or one waiting to deliver its answer, starts again with `secs` left.
    pub fn postpone(&mut self, agent_id: &str, request_id: &str, secs: u32, now: Millis, has_clients: bool) -> Result<(), ApiError> {
        if secs == 0 || secs > AUTO_ANSWER_MAX_SECS {
            return Err(ApiError::new("invalid_params", format!("postpone by 1–{AUTO_ANSWER_MAX_SECS} seconds")));
        }
        let Some((p, _)) = self.enabled(agent_id) else { return Err(self.entry_mut(agent_id, request_id).err().unwrap_or_else(off)) };
        let apps = self.apps(now, has_clients);
        let e = self.entry_mut(agent_id, request_id)?;
        if e.answered || e.in_flight {
            return Err(ApiError::new("busy", "decide for me is already answering this question"));
        }
        let counted = e.elapsed_ms + e.running_since.map_or(0, |rs| (now - rs).max(0));
        let left = budget(e, &p) - counted;
        let base = if e.cancelled || e.due_at.is_some() { 0 } else { left.max(0) };
        let want = (base + secs as i64 * 1000).min(MAX_MS);
        e.extra_ms += want - left;
        e.cancelled = false;
        e.due_at = None;
        e.retry_at = None;
        let run = runs(e, &p, apps);
        set_running(e, run, now);
        self.touch(true);
        Ok(())
    }

    /// Drops what belongs to agents the board no longer knows (`keep`: every agent id it shows,
    /// parked ones included): countdowns not seen for [`STALE_MS`], own policies set over
    /// [`SWEEP_GRACE_MS`] ago.
    pub fn sweep(&mut self, keep: &HashSet<String>, now: Millis) -> usize {
        let before = self.data.pending.len() + self.data.agents.len();
        self.data.pending.retain(|id, e| keep.contains(id) || now - e.seen_at < STALE_MS);
        self.data.agents.retain(|id, o| keep.contains(id) || now - o.at < SWEEP_GRACE_MS);
        self.restored.retain(|id| self.data.pending.contains_key(id));
        let gone = before - self.data.pending.len() - self.data.agents.len();
        self.touch(gone > 0);
        gone
    }
}

fn off() -> ApiError {
    ApiError::new("not_found", "decide for me is off for this agent")
}

/// The wait of a countdown under `p` (ms).
fn budget(e: &Countdown, p: &AutoAnswer) -> i64 {
    p.after_secs as i64 * 1000 + e.extra_ms
}

/// Whether the clock of `e` runs under `p`.
fn runs(e: &Countdown, p: &AutoAnswer, apps: bool) -> bool {
    !e.cancelled && !e.answered && e.due_at.is_none() && !(p.only_when_no_app && apps)
}

/// A countdown that fell due, and whose answer is not being delivered right now, stands again
/// (the full wait counted, the clock still): it is due again the moment the policy allows an
/// answer. True when it did.
fn stands_down(e: &mut Countdown) -> bool {
    if e.due_at.is_none() || e.answered || e.in_flight {
        return false;
    }
    e.due_at = None;
    e.retry_at = None;
    true
}

/// Starts or stops the clock of `e`; true when it changed.
fn set_running(e: &mut Countdown, run: bool, now: Millis) -> bool {
    match (run, e.running_since) {
        (true, None) => {
            e.running_since = Some(now);
            true
        }
        (false, Some(rs)) => {
            e.elapsed_ms += (now - rs).max(0);
            e.running_since = None;
            true
        }
        _ => false,
    }
}

/// What the board shows of a countdown. Stable while nothing changes (a running clock shows its
/// deadline, a standing one what is left), so rebuilds patch nothing in between.
fn view(e: &Countdown, p: &AutoAnswer) -> AutoAnswerCountdown {
    let left = budget(e, p) - e.elapsed_ms;
    let (status, deadline, remaining_ms) = if e.answered || e.in_flight || e.due_at.is_some() {
        (AutoAnswerStatus::Answering, e.due_at, None)
    } else if e.cancelled {
        (AutoAnswerStatus::Cancelled, None, Some(left.max(0)))
    } else if let Some(rs) = e.running_since {
        (AutoAnswerStatus::Counting, Some(rs + left), None)
    } else {
        (AutoAnswerStatus::WaitingForNoApp, None, Some(left.max(0)))
    };
    AutoAnswerCountdown { request_id: e.request_id.clone(), status, deadline, remaining_ms, picks: e.labels.clone() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tf_proto::model::{NeedsOption, NeedsYou, OptionTone};

    const MIN: Millis = 60_000;
    /// Past the start grace.
    const T0: Millis = 1_000_000;

    fn policy(mins: u32, only_when_no_app: bool) -> AutoAnswer {
        AutoAnswer { enabled: true, after_secs: mins * 60, only_when_no_app }
    }

    /// An option as the replica maps it: a recommended one keeps omp's exact label as its id.
    fn opt(label: &str, recommended: bool) -> NeedsOption {
        let id = if recommended { format!("{label} (Recommended)") } else { label.to_string() };
        NeedsOption { id, label: label.into(), description: None, recommended, tone: OptionTone::Neutral }
    }

    fn needs(kind: NeedsKind, req: &str, options: Vec<NeedsOption>, multi: bool) -> NeedsYou {
        NeedsYou {
            kind,
            request_id: Some(req.into()),
            since: 0,
            title: "Question".into(),
            question: "Which database?".into(),
            detail: None,
            options,
            multi,
            allow_other: true,
            allow_chat: true,
            command: None,
            answerable: true,
        }
    }

    fn ask(req: &str) -> NeedsYou {
        needs(NeedsKind::Ask, req, vec![opt("Use SQLite", true), opt("Use Postgres", false)], false)
    }

    fn agent(id: &str, needs: Option<NeedsYou>, link: LinkState) -> Agent {
        let mut a: Agent = serde_json::from_value(json!({
            "id": id, "name": id, "kind": "omp", "paneId": "p1", "tabId": "t1", "workspaceId": "w1",
            "state": "blocked", "stateSince": 0, "column": "needs", "archived": false, "turns": 1, "title": "task",
            "omp": { "link": "live", "bridge": true, "fast": false, "mode": "normal", "queue": { "steering": [], "followUp": [] } },
            "live": { "streaming": false, "thinking": false }
        }))
        .unwrap();
        a.needs = needs;
        a.omp.as_mut().unwrap().link = link;
        a
    }

    fn live(id: &str, needs: Option<NeedsYou>) -> Agent {
        agent(id, needs, LinkState::Live)
    }

    /// A session whose host default is `p`, started long before `T0`.
    fn core_with(p: AutoAnswer) -> Core {
        let mut c = Core::new(SessionData::default(), 0);
        c.set_default(p, 0, false);
        c
    }

    fn countdown(c: &mut Core, a: &Agent, now: Millis, apps: bool) -> AutoAnswerCountdown {
        c.observe(a, now, apps).and_then(|v| v.countdown).expect("a countdown")
    }

    #[test]
    fn policy_matrix() {
        let a = live("a1", Some(ask("7")));
        // Host default off, nothing of its own: nothing to show.
        let mut c = Core::new(SessionData::default(), 0);
        assert_eq!(c.observe(&a, T0, false), None);
        // Host default on.
        c.set_default(policy(20, false), T0, false);
        let v = c.observe(&a, T0, false).unwrap();
        assert_eq!((v.source, v.policy.after_secs), (AutoAnswerSource::Host, 1200));
        assert_eq!(v.countdown.unwrap().deadline, Some(T0 + 20 * MIN));
        // The agent's own policy wins, also when it is off.
        c.set_own("a1", Some(AutoAnswer { enabled: false, ..policy(5, false) }), T0, false);
        let v = c.observe(&a, T0, false).unwrap();
        assert_eq!((v.source, v.policy.enabled, v.countdown), (AutoAnswerSource::Agent, false, None));
        // Its own on while the host default is off.
        c.set_default(AutoAnswer { enabled: false, ..policy(20, false) }, T0, false);
        c.set_own("a1", Some(policy(5, false)), T0, false);
        assert_eq!(countdown(&mut c, &a, T0, false).deadline, Some(T0 + 5 * MIN));
        // Back to the host default (off): no countdown, nothing shown.
        c.set_own("a1", None, T0, false);
        assert_eq!(c.observe(&a, T0, false), None);
        assert!(c.data().pending.is_empty());
        // Non-omp agents never take part.
        c.set_default(policy(20, false), T0, false);
        let mut claude = a.clone();
        claude.kind = "claude".into();
        assert_eq!(c.observe(&claude, T0, false), None);
    }

    #[test]
    fn only_recommended_asks_qualify() {
        let mut c = core_with(policy(1, false));
        let rec = |kind| needs(kind, "1", vec![opt("Approve", true), opt("Deny", false)], false);
        for kind in [NeedsKind::Approval, NeedsKind::PlanReview, NeedsKind::Confirm, NeedsKind::Input, NeedsKind::Blocked] {
            let v = c.observe(&live("a1", Some(rec(kind))), T0, false).unwrap();
            assert_eq!(v.countdown, None, "{kind:?} must never be answered");
        }
        // An ask without a recommendation.
        let plain = needs(NeedsKind::Ask, "2", vec![opt("A", false), opt("B", false)], false);
        assert_eq!(c.observe(&live("a1", Some(plain)), T0, false).unwrap().countdown, None);
        // Terminal-only prompts (not answerable in the app).
        let mut term = ask("3");
        term.answerable = false;
        assert_eq!(c.observe(&live("a1", Some(term)), T0, false).unwrap().countdown, None);
        assert!(c.data().pending.is_empty());
        assert!(c.due(T0 + 10 * MIN).is_empty());
        // A parked agent has no questions.
        let mut parked = live("a1", Some(ask("4")));
        parked.parked = Some(serde_json::from_value(json!({ "at": 0, "sessionFile": "/s.jsonl" })).unwrap());
        assert_eq!(c.observe(&parked, T0, false).unwrap().countdown, None);
    }

    #[test]
    fn picks_first_recommended_or_every_recommended_of_a_multi_select() {
        let one = needs(NeedsKind::Ask, "1", vec![opt("A", false), opt("B", true), opt("C", true)], false);
        let q = qualifying(&live("a", Some(one))).unwrap();
        assert_eq!((q.ids, q.labels), (vec!["B (Recommended)".to_string()], vec!["B".to_string()]));
        let multi = needs(NeedsKind::Ask, "1", vec![opt("A", true), opt("B", false), opt("C", true)], true);
        assert_eq!(qualifying(&live("a", Some(multi))).unwrap().labels, ["A", "C"]);
    }

    #[test]
    fn fires_at_the_deadline_once() {
        let mut c = core_with(policy(20, false));
        let a = live("a1", Some(ask("7")));
        let cd = countdown(&mut c, &a, T0, false);
        assert_eq!((cd.status, cd.deadline, cd.picks.as_slice()), (AutoAnswerStatus::Counting, Some(T0 + 20 * MIN), &["Use SQLite".to_string()][..]));
        assert_eq!(c.next_wake(T0), Some(T0 + 20 * MIN));
        // Rebuilds in between change nothing (no patch churn).
        assert_eq!(countdown(&mut c, &a, T0 + 5 * MIN, false), cd);
        assert!(c.due(T0 + 20 * MIN - 1).is_empty());
        let fires = c.due(T0 + 20 * MIN);
        assert_eq!(fires.len(), 1);
        assert_eq!((fires[0].picks.as_slice(), fires[0].waited_ms), (&["Use SQLite (Recommended)".to_string()][..], 20 * MIN));
        assert_eq!(countdown(&mut c, &a, T0 + 20 * MIN, false).status, AutoAnswerStatus::Answering);
        // In flight: never handed out twice.
        assert!(c.due(T0 + 21 * MIN).is_empty());
        c.fired(&fires[0], Outcome::Answered, T0 + 20 * MIN);
        assert!(c.due(T0 + 30 * MIN).is_empty());
        assert_eq!(c.next_wake(T0 + 30 * MIN), None);
        // The question goes away: the countdown with it.
        c.observe(&live("a1", None), T0 + 21 * MIN, false);
        assert!(c.data().pending.is_empty());
        // A new question starts a new countdown.
        assert_eq!(countdown(&mut c, &live("a1", Some(ask("8"))), T0 + 22 * MIN, false).deadline, Some(T0 + 42 * MIN));
    }

    #[test]
    fn retries_while_the_link_is_down_and_gives_up_on_refusals() {
        let mut c = core_with(policy(1, false));
        countdown(&mut c, &live("a1", Some(ask("7"))), T0, false);
        let f = c.due(T0 + MIN).pop().unwrap();
        c.fired(&f, Outcome::Retry, T0 + MIN);
        assert!(c.due(T0 + MIN + RETRY_MS - 1).is_empty());
        assert_eq!(c.next_wake(T0 + MIN), Some(T0 + MIN + RETRY_MS));
        let f = c.due(T0 + MIN + RETRY_MS).pop().unwrap();
        c.fired(&f, Outcome::Failed, T0 + MIN + RETRY_MS);
        assert_eq!(countdown(&mut c, &live("a1", Some(ask("7"))), T0 + 2 * MIN, false).status, AutoAnswerStatus::Cancelled);
        assert!(c.due(T0 + 60 * MIN).is_empty());
        // Gone: answered elsewhere meanwhile.
        let mut c = core_with(policy(1, false));
        countdown(&mut c, &live("a1", Some(ask("7"))), T0, false);
        let f = c.due(T0 + MIN).pop().unwrap();
        c.fired(&f, Outcome::Gone, T0 + MIN);
        assert!(c.data().pending.is_empty());
    }

    #[test]
    fn counts_only_while_no_app_is_connected() {
        let mut c = core_with(policy(20, true));
        let a = live("a1", Some(ask("7")));
        // Asked while an app is connected: it stands at the full wait.
        let cd = countdown(&mut c, &a, T0, true);
        assert_eq!((cd.status, cd.deadline, cd.remaining_ms), (AutoAnswerStatus::WaitingForNoApp, None, Some(20 * MIN)));
        assert!(c.due(T0 + 60 * MIN).is_empty());
        assert_eq!(c.next_wake(T0 + 60 * MIN), None);
        // The last app disconnects at +60: the clock runs from there.
        assert!(c.presence(T0 + 60 * MIN, false));
        assert_eq!(countdown(&mut c, &a, T0 + 61 * MIN, false).deadline, Some(T0 + 80 * MIN));
        // An app connects at +70 (10 left): it stops; it disconnects at +90: 10 left again.
        assert!(c.presence(T0 + 70 * MIN, true));
        assert!(!c.presence(T0 + 75 * MIN, true));
        let cd = countdown(&mut c, &a, T0 + 75 * MIN, true);
        assert_eq!((cd.status, cd.remaining_ms), (AutoAnswerStatus::WaitingForNoApp, Some(10 * MIN)));
        assert!(c.due(T0 + 89 * MIN).is_empty());
        c.presence(T0 + 90 * MIN, false);
        assert_eq!(c.next_wake(T0 + 90 * MIN), Some(T0 + 100 * MIN));
        assert!(c.due(T0 + 100 * MIN - 1).is_empty());
        assert_eq!(c.due(T0 + 100 * MIN).len(), 1);
    }

    #[test]
    fn a_policy_without_the_app_rule_counts_with_apps_connected() {
        let mut c = core_with(policy(20, false));
        let a = live("a1", Some(ask("7")));
        assert_eq!(countdown(&mut c, &a, T0, true).deadline, Some(T0 + 20 * MIN));
        assert!(!c.presence(T0 + MIN, true));
        assert_eq!(c.due(T0 + 20 * MIN).len(), 1);
    }

    #[test]
    fn rebuilds_apply_presence_too() {
        // The board's rebuild sees an app connect before the worker does.
        let mut c = core_with(policy(10, true));
        let a = live("a1", Some(ask("7")));
        countdown(&mut c, &a, T0, false);
        let cd = countdown(&mut c, &a, T0 + 4 * MIN, true);
        assert_eq!((cd.status, cd.remaining_ms), (AutoAnswerStatus::WaitingForNoApp, Some(6 * MIN)));
    }

    #[test]
    fn start_grace_counts_as_an_app() {
        // tf-hostd just started: apps that were connected may still reconnect.
        let mut c = Core::new(SessionData::default(), T0);
        c.set_default(policy(10, true), T0, false);
        let a = live("a1", Some(ask("7")));
        assert_eq!(countdown(&mut c, &a, T0 + 1_000, false).status, AutoAnswerStatus::WaitingForNoApp);
        assert_eq!(c.next_wake(T0 + 1_000), Some(T0 + START_GRACE_MS));
        assert!(c.presence(T0 + START_GRACE_MS, false));
        assert_eq!(countdown(&mut c, &a, T0 + START_GRACE_MS, false).deadline, Some(T0 + START_GRACE_MS + 10 * MIN));
        // Without the app rule the grace changes nothing.
        let mut c = Core::new(SessionData::default(), T0);
        c.set_default(policy(10, false), T0, false);
        assert_eq!(countdown(&mut c, &a, T0 + 1_000, false).deadline, Some(T0 + 1_000 + 10 * MIN));
    }

    #[test]
    fn cancel_and_postpone() {
        let mut c = core_with(policy(20, false));
        let a = live("a1", Some(ask("7")));
        countdown(&mut c, &a, T0, false);
        assert_eq!(c.cancel("a1", "8", T0).unwrap_err().code, "not_found");
        assert_eq!(c.postpone("a1", "7", 0, T0, false).unwrap_err().code, "invalid_params");
        // +10 min at +5: 25 left.
        c.postpone("a1", "7", 600, T0 + 5 * MIN, false).unwrap();
        assert_eq!(countdown(&mut c, &a, T0 + 5 * MIN, false).deadline, Some(T0 + 30 * MIN));
        // Cancelled at +10: waits for a person, keeps what was left.
        c.cancel("a1", "7", T0 + 10 * MIN).unwrap();
        c.cancel("a1", "7", T0 + 10 * MIN).unwrap();
        let cd = countdown(&mut c, &a, T0 + 11 * MIN, false);
        assert_eq!((cd.status, cd.remaining_ms), (AutoAnswerStatus::Cancelled, Some(20 * MIN)));
        assert!(c.due(T0 + 120 * MIN).is_empty());
        assert_eq!(c.next_wake(T0 + 120 * MIN), None);
        // Postponing a cancelled one starts it again with that much left.
        c.postpone("a1", "7", 300, T0 + 120 * MIN, false).unwrap();
        assert_eq!(countdown(&mut c, &a, T0 + 120 * MIN, false).deadline, Some(T0 + 125 * MIN));
        // What is left is capped at 24 h.
        c.postpone("a1", "7", AUTO_ANSWER_MAX_SECS, T0 + 120 * MIN, false).unwrap();
        assert_eq!(countdown(&mut c, &a, T0 + 120 * MIN, false).deadline, Some(T0 + 120 * MIN + MAX_MS));
        // Too late to cancel once it is answering; postponing a due one waiting for the link works.
        let mut c = core_with(policy(1, false));
        countdown(&mut c, &a, T0, false);
        let f = c.due(T0 + MIN).pop().unwrap();
        assert_eq!(c.cancel("a1", "7", T0 + MIN).unwrap_err().code, "busy");
        c.fired(&f, Outcome::Retry, T0 + MIN);
        c.postpone("a1", "7", 120, T0 + MIN + 1_000, false).unwrap();
        assert_eq!(countdown(&mut c, &a, T0 + MIN + 1_000, false).deadline, Some(T0 + 3 * MIN + 1_000));
        // Decide for me off: nothing to cancel or postpone.
        c.set_default(AutoAnswer { enabled: false, ..policy(1, false) }, T0, false);
        assert_eq!(c.postpone("a1", "7", 60, T0, false).unwrap_err().code, "not_found");
    }

    #[test]
    fn policy_changes_apply_to_a_running_countdown() {
        let mut c = core_with(policy(20, false));
        let a = live("a1", Some(ask("7")));
        countdown(&mut c, &a, T0, false);
        // 8 minutes counted, the wait becomes 5: due at once.
        c.set_own("a1", Some(policy(5, false)), T0 + 8 * MIN, false);
        assert_eq!(c.due(T0 + 8 * MIN).len(), 1);
        // The app rule switched on while an app is connected stops the clock.
        let mut c = core_with(policy(20, false));
        countdown(&mut c, &a, T0, false);
        c.set_own("a1", Some(policy(20, true)), T0 + 5 * MIN, true);
        let cd = countdown(&mut c, &a, T0 + 6 * MIN, true);
        assert_eq!((cd.status, cd.remaining_ms), (AutoAnswerStatus::WaitingForNoApp, Some(15 * MIN)));
        // Off drops it.
        c.set_own("a1", Some(AutoAnswer { enabled: false, ..policy(20, true) }), T0 + 7 * MIN, true);
        assert!(c.data().pending.is_empty());
    }

    #[test]
    fn a_link_that_drops_keeps_the_countdown() {
        let mut c = core_with(policy(20, false));
        countdown(&mut c, &live("a1", Some(ask("7"))), T0, false);
        // Resyncing: no needs for a moment.
        c.observe(&agent("a1", None, LinkState::Connecting), T0 + MIN, false);
        assert_eq!(c.data().pending.len(), 1);
        assert_eq!(countdown(&mut c, &live("a1", Some(ask("7"))), T0 + 2 * MIN, false).deadline, Some(T0 + 20 * MIN));
    }

    #[test]
    fn restart_keeps_countdowns_and_waits_for_the_question() {
        let mut c = core_with(policy(20, false));
        let a = live("a1", Some(ask("7")));
        countdown(&mut c, &a, T0, false);
        c.set_own("a2", Some(policy(30, true)), T0, false);
        let saved: SessionData = serde_json::from_str(&serde_json::to_string(&c.take_dirty().unwrap()).unwrap()).unwrap();
        assert!(c.take_dirty().is_none());

        // tf-hostd restarts at +25 (the deadline passed while it was down).
        let now = T0 + 25 * MIN;
        let mut c = Core::new(saved.clone(), now);
        assert_eq!(c.own("a2"), Some(policy(30, true)));
        // Not before the question is back on the board.
        assert!(c.due(now).is_empty());
        let mut back = a.clone();
        back.needs.as_mut().unwrap().request_id = Some("12".into()); // collab may number it anew
        let cd = countdown(&mut c, &back, now + 1_000, false);
        assert_eq!((cd.request_id.as_str(), cd.deadline), ("12", Some(T0 + 20 * MIN)));
        let fires = c.due(now + 1_000);
        assert_eq!((fires.len(), fires[0].request_id.as_str()), (1, "12"));

        // A different question after the restart starts over.
        let mut c = Core::new(saved, now);
        let mut other = ask("13");
        other.question = "Which ORM?".into();
        assert_eq!(countdown(&mut c, &live("a1", Some(other)), now, false).deadline, Some(now + 20 * MIN));
    }

    #[test]
    fn sweep_drops_what_belongs_to_gone_agents() {
        let mut c = core_with(policy(20, false));
        countdown(&mut c, &live("a1", Some(ask("7"))), T0, false);
        c.set_own("a1", Some(policy(5, false)), T0, false);
        c.set_own("new", Some(policy(5, false)), T0, false);
        let keep: HashSet<String> = ["a1".to_string()].into();
        assert_eq!(c.sweep(&keep, T0 + 60 * MIN), 1, "only the launch nobody saw goes");
        assert_eq!(c.sweep(&HashSet::new(), T0 + 2 * MIN), 0, "inside the graces");
        assert_eq!(c.sweep(&HashSet::new(), T0 + 60 * MIN), 2);
        assert!(c.data().pending.is_empty() && c.data().agents.is_empty());
    }

    #[test]
    fn forget_moves_nothing_along() {
        let mut c = core_with(policy(20, false));
        c.set_own("old", Some(policy(5, true)), T0, false);
        countdown(&mut c, &live("old", Some(ask("7"))), T0, false);
        c.forget("old");
        assert_eq!(c.own("old"), None);
        assert!(c.data().pending.is_empty());
    }

    #[test]
    fn a_countdown_that_fell_due_is_no_permission_to_answer_while_an_app_is_connected() {
        let mut c = core_with(policy(1, true));
        let a = live("a1", Some(ask("7")));
        countdown(&mut c, &a, T0, false);
        // The countdown runs out with no app: the answer is handed out, and its delivery fails
        // for a passing reason.
        let f = c.due(T0 + MIN).pop().unwrap();
        c.fired(&f, Outcome::Retry, T0 + MIN);
        // An app connects before the retry (the board's rebuild sees it first).
        assert_eq!(countdown(&mut c, &a, T0 + MIN + 1_000, true).status, AutoAnswerStatus::WaitingForNoApp);
        assert!(c.due(T0 + MIN + RETRY_MS).is_empty(), "the retry waits: somebody is here");
        assert!(c.due(T0 + 10 * MIN).is_empty());
        // The delivery itself asks again too (an app connected while it was handed out).
        assert!(!c.permitted(&f, T0 + MIN + RETRY_MS, true));
        assert!(c.permitted(&f, T0 + MIN + RETRY_MS, false));
        // The app goes: the answer is due again at once (the wait was counted in full).
        c.presence(T0 + 11 * MIN, false);
        let again = c.due(T0 + 11 * MIN);
        assert_eq!(again.len(), 1);
        c.fired(&again[0], Outcome::Answered, T0 + 11 * MIN);
    }

    #[test]
    fn an_answer_in_flight_when_an_app_connects_is_held_before_it_is_sent() {
        let mut c = core_with(policy(1, true));
        let a = live("a1", Some(ask("7")));
        countdown(&mut c, &a, T0, false);
        let f = c.due(T0 + MIN).pop().unwrap();
        // The driver asks right before sending: an app connected a moment ago.
        assert!(!c.permitted(&f, T0 + MIN + 10, true));
        c.fired(&f, Outcome::Hold, T0 + MIN + 10);
        assert_eq!(countdown(&mut c, &a, T0 + MIN + 20, true).status, AutoAnswerStatus::WaitingForNoApp);
        assert!(c.due(T0 + 5 * MIN).is_empty());
        c.presence(T0 + 6 * MIN, false);
        assert_eq!(c.due(T0 + 6 * MIN).len(), 1);
        // A policy that does not care about apps answers whoever is there; one turned off, nobody.
        let mut c = core_with(policy(1, false));
        countdown(&mut c, &a, T0, true);
        let f = c.due(T0 + MIN).pop().unwrap();
        assert!(c.permitted(&f, T0 + MIN, true));
        c.set_default(AutoAnswer { enabled: false, ..policy(1, false) }, T0 + MIN, true);
        assert!(!c.permitted(&f, T0 + MIN + 1, false), "turned off meanwhile");
    }
}
