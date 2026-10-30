//! Pure board mapping (architecture §3.5): herdr + replica + bridge → `Agent` /
//! `Workspace`, columns, needs-you, notifications. No I/O here.

use std::collections::HashMap;

use tf_herdr::{AgentInfo, AgentStatus, PaneInfo, TabInfo, WorkspaceInfo};
use tf_proto::model::{
    Agent, Answer, Column, DiffStat, HerdrState, Liveness, NeedsKind, NeedsOption, NeedsYou, Notification,
    NotifyAction, NotifyKind, OmpInfo, OptionTone, PaneInfo as WirePane, RepoInfo, SubagentSummary, Tab, TodoSummary,
    Workspace, WorktreeInfo,
};
use tf_proto::session::{Capabilities, ChangedFile, PlanReview, Refusal, Subagent, SubagentStatus, TodoPhase, TodoStatus, UiKind, UiRequest};
use tf_proto::Millis;

use crate::bridge::{BridgeCaps, BridgeSession, PlanReviewInfo};
use crate::omp::{BoardMeta, LinkStatus, OmpView};
use crate::util::{clip, new_id};

/// Quiet notification threshold (no events while working).
pub const QUIET_MS: Millis = 120_000;

pub fn herdr_state(s: AgentStatus) -> HerdrState {
    match s {
        AgentStatus::Working => HerdrState::Working,
        AgentStatus::Blocked => HerdrState::Blocked,
        AgentStatus::Idle => HerdrState::Idle,
        AgentStatus::Done => HerdrState::Done,
        AgentStatus::Unknown => HerdrState::Unknown,
    }
}

/// How long herdr's `working` may outlive the end of an agent's wait for background jobs.
pub const JOBS_SETTLE_MS: Millis = 5_000;

/// An agent whose turn ended while background jobs ran (omp's "Waiting for background jobs").
/// herdr's omp integration ignores that `agent_end` (`willContinue`), so herdr keeps the agent
/// `working` until a result wakes it. A job that is cancelled instead delivers nothing: nothing
/// continues, omp's own screen goes idle, and herdr stays `working` for good. This tells the two
/// apart: the wait is over (no job running or queued) while herdr still says `working` and the
/// replica's turn is over, for [`JOBS_SETTLE_MS`] (a result that ends the wait starts its turn
/// within that).
#[derive(Debug, Default, Clone, Copy)]
pub struct JobsWait {
    waited: bool,
    over_since: Option<Millis>,
}

impl JobsWait {
    /// One board build: the agent is `working` by herdr's word, the replica's turn is `turn_active`,
    /// and omp `waiting`s on jobs by the bridge's. Returns `(settled, recheck)`: `settled` when the
    /// wait is over and herdr's `working` is stale (the agent is idle), `recheck` while that is
    /// still to be decided (build again after the grace).
    pub fn observe(&mut self, now: Millis, working: bool, turn_active: bool, waiting: bool) -> (bool, bool) {
        if waiting {
            self.waited = true;
            self.over_since = None;
            return (false, false);
        }
        if !self.waited || !working || turn_active {
            *self = Self::default();
            return (false, false);
        }
        let since = *self.over_since.get_or_insert(now);
        let settled = now - since >= JOBS_SETTLE_MS;
        (settled, !settled)
    }
}

/// Column mapping (§3.5): needs > running > done (archived) > review.
pub fn column(state: HerdrState, has_needs: bool, archived: bool) -> Column {
    if state == HerdrState::Blocked || has_needs {
        Column::Needs
    } else if state == HerdrState::Working {
        Column::Running
    } else if archived {
        Column::Done
    } else {
        Column::Review
    }
}

/// Stable agent id: the herdr terminal id, falling back to the pane id.
pub fn agent_id(a: &AgentInfo) -> String {
    if a.terminal_id.is_empty() { a.pane_id.clone() } else { a.terminal_id.clone() }
}

/// Everything known about one herdr agent, gathered by the store.
pub struct AgentInputs<'a> {
    pub herdr: &'a AgentInfo,
    pub omp: Option<&'a OmpView>,
    /// Link when no replica serves the session (`omp` is `None`).
    pub link: LinkStatus,
    /// When the agent's current link (state, reason, path) began.
    pub link_since: Option<Millis>,
    pub omp_session_id: Option<String>,
    pub omp_pid: Option<u32>,
    pub bridge: Option<&'a BridgeSession>,
    pub archived: bool,
    pub turns: u32,
    pub first_seen: Option<Millis>,
    pub state_since: Millis,
    pub needs_since: Millis,
    pub pane_activity: Option<Millis>,
    pub repo: Option<&'a RepoInfo>,
    pub turn_started_at: Option<Millis>,
    pub last_turn_ended_at: Option<Millis>,
    /// herdr says `blocked` but the dialog is not visible yet (or herdr lags after an
    /// answer): keep the agent in Running instead of a terminal-only Needs.
    pub blocked_grace: bool,
}

pub fn is_omp(a: &AgentInfo) -> bool {
    a.agent.as_deref() == Some("omp")
}

pub fn build_agent(i: &AgentInputs<'_>) -> Agent {
    let a = i.herdr;
    let state = herdr_state(a.agent_status);
    let provider = provider_wait(state, i.omp, i.bridge);
    let needs = needs_for(i, state, provider);
    let col_state = match provider {
        _ if i.blocked_grace => HerdrState::Working,
        Some(ProviderWait::Retrying) => HerdrState::Working,
        Some(ProviderWait::Failed) => HerdrState::Idle,
        None => state,
    };
    let col = column(col_state, needs.is_some(), i.archived);
    let kind = a.agent.clone().unwrap_or_else(|| "unknown".into());
    let name = a.name.clone().or_else(|| a.display_agent.clone()).unwrap_or_else(|| kind.clone());
    let cwd = a.foreground_cwd.clone().or_else(|| a.cwd.clone()).filter(|c| !c.is_empty());
    let meta = i.omp.map(|v| &v.meta);
    let ctl = i.bridge.map(|b| &b.state);

    let title = meta
        .and_then(|m| m.title.clone())
        .or_else(|| ctl.and_then(|c| c.title.clone()))
        .or_else(|| i.omp.and_then(|v| v.first_prompt.clone()))
        .or_else(|| a.title.clone().filter(|t| !t.is_empty()))
        .or_else(|| a.terminal_title_stripped.as_deref().map(strip_spinner).filter(|t| !t.is_empty()))
        .unwrap_or_else(|| name.clone());

    let omp = is_omp(a).then(|| omp_info(i, meta));
    let mut live = match i.omp {
        Some(v) => v.live.clone(),
        None => Liveness { last_event_at: None, streaming: false, thinking: false, tool: None, tps: None, tps_split: None, line: None },
    };
    if live.last_event_at.is_none() || i.omp.is_none() {
        live.last_event_at = max_opt(live.last_event_at, i.pane_activity);
    }
    let diff = meta.and_then(|m| m.diff.clone());
    Agent {
        id: agent_id(a),
        name,
        kind,
        pane_id: a.pane_id.clone(),
        tab_id: a.tab_id.clone(),
        workspace_id: a.workspace_id.clone(),
        state,
        state_since: i.state_since,
        column: col,
        archived: i.archived && col == Column::Done,
        turns: i.turns,
        title: clip(&title, 120),
        cwd,
        repo: i.repo.map(|r| r.name.clone()),
        branch: i.repo.and_then(|r| r.branch.clone()),
        started_at: meta.and_then(|m| m.started_at).or(i.first_seen),
        omp,
        live,
        needs,
        diff,
        parked: None,
        // Filled by the state store from the auto-resume worker's tickets (`crate::recovery`).
        auto_resume: None,
        // Filled by the state store from the session's decide-for-me state (`crate::autoanswer`).
        auto_answer: None,
    }
}

fn max_opt(a: Option<Millis>, b: Option<Millis>) -> Option<Millis> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.max(y)),
        (x, y) => x.or(y),
    }
}

/// omp puts a spinner glyph in its OSC title (`π ⠧ repo`); drop it.
pub fn strip_spinner(t: &str) -> String {
    t.split_whitespace()
        .filter(|w| !w.chars().all(|c| ('\u{2800}'..='\u{28ff}').contains(&c) || c == 'π'))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Todo progress on a card: done of total, and the task in progress.
pub fn todo_summary(phases: &[TodoPhase]) -> Option<TodoSummary> {
    let tasks: Vec<_> = phases.iter().flat_map(|p| p.tasks.iter()).collect();
    (!tasks.is_empty()).then(|| TodoSummary {
        done: tasks.iter().filter(|t| t.status == TodoStatus::Completed).count() as u32,
        total: tasks.len() as u32,
        current: tasks.iter().find(|t| t.status == TodoStatus::InProgress).map(|t| t.content.clone()),
    })
}

/// Subagents on a card: running of total, and their mean reported completion.
pub fn subagent_summary(subagents: &[Subagent]) -> Option<SubagentSummary> {
    (!subagents.is_empty()).then(|| {
        let (sum, n) = subagents.iter().filter_map(|s| s.completion_pct).fold((0.0f32, 0u32), |(sum, n), p| (sum + p, n + 1));
        SubagentSummary {
            live: subagents.iter().filter(|s| s.status == SubagentStatus::Running).count() as u32,
            total: subagents.len() as u32,
            completion_pct: (n > 0).then(|| sum / n as f32),
        }
    })
}

/// Lines added / removed over the files the session changed.
pub fn diff_stat(files: &[ChangedFile]) -> Option<DiffStat> {
    (!files.is_empty()).then(|| DiffStat {
        added: files.iter().map(|f| f.added).sum(),
        removed: files.iter().map(|f| f.removed).sum(),
        files: files.len() as u32,
    })
}

/// The agent's link: the replica's when one serves the session, else what the registry and the
/// bridge say.
pub fn link_of(i: &AgentInputs<'_>) -> LinkStatus {
    match i.omp {
        Some(v) => LinkStatus::new(v.link, v.link_reason, v.link_via, v.link_error.clone()),
        None => i.link.clone(),
    }
}

fn omp_info(i: &AgentInputs<'_>, meta: Option<&BoardMeta>) -> OmpInfo {
    let ctl = i.bridge.map(|b| &b.state);
    let link = link_of(i);
    OmpInfo {
        session_id: i.omp_session_id.clone().or_else(|| meta.and_then(|m| m.session_id.clone())),
        session_file: i
            .herdr
            .agent_session
            .as_ref()
            .and_then(|s| s.path().map(str::to_string))
            .or_else(|| meta.and_then(|m| m.session_file.clone()))
            .or_else(|| i.bridge.and_then(|b| b.session_file.clone())),
        pid: i.omp.map(|v| v.pid).or(i.omp_pid).or(i.bridge.map(|b| b.pid)),
        version: i.bridge.and_then(|b| b.omp_version.clone()).filter(|v| !v.is_empty()),
        link: link.state,
        link_error: link.error,
        link_reason: link.reason,
        link_via: link.via,
        link_since: i.link_since,
        bridge: i.bridge.is_some(),
        model: ctl.and_then(|c| c.model.clone()).or_else(|| meta.and_then(|m| m.model.clone())),
        thinking: ctl.and_then(|c| c.thinking).or_else(|| meta.and_then(|m| m.thinking)),
        fast: ctl.map(|c| c.fast).or(meta.map(|m| m.fast)).unwrap_or(false),
        mode: ctl.map(|c| c.mode).or(meta.map(|m| m.mode)).unwrap_or(tf_proto::model::OmpMode::Normal),
        // The bridge is authoritative for goal state (including "no goal" after drop/complete).
        goal: match ctl {
            Some(c) => c.goal.clone(),
            None => meta.and_then(|m| m.goal.clone()),
        },
        context: ctl.and_then(|c| c.context.clone()).or_else(|| meta.and_then(|m| m.context.clone())),
        cost: meta.and_then(|m| m.cost.clone()),
        todos: meta.and_then(|m| m.todos.clone()),
        subagents: meta.and_then(|m| m.subagents.clone()),
        jobs: i.bridge.and_then(|b| b.jobs.clone()),
        retry: i.omp.and_then(|v| v.retry.clone()),
        // The session meta carries the bridge's queue merged with the prompts we queued.
        queue: match (ctl, meta) {
            (Some(c), Some(m)) => tf_collab::replica::merge_queue(&c.queue, &m.queue),
            (Some(c), None) => c.queue.clone(),
            (None, Some(m)) => m.queue.clone(),
            (None, None) => tf_proto::model::QueueInfo { steering: vec![], follow_up: vec![] },
        },
        turn_started_at: i.turn_started_at,
        last_turn_ended_at: i.last_turn_ended_at,
        // Filled by the state store from omp's recap journal (`crate::recaps`).
        recap: None,
    }
}

/// Why herdr's `blocked` is not a question (§3.5). herdr's omp integration reports `blocked` while
/// omp waits to retry a provider error and after a run ended in one, with no dialog behind it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderWait {
    /// omp is waiting to retry a provider error (`OmpInfo.retry`): the agent keeps running.
    Retrying,
    /// The last run ended in a provider error and nothing runs since: the agent's turn is over (Review).
    Failed,
}

/// What the live omp session explains about herdr's state without a prompt: no dialog or plan review
/// is pending, and omp waits to retry a provider error (`blocked`, or, with herdr's omp integration
/// missing or lagging, `idle` while the replica's run is still on) or, `blocked` only, its last run
/// ended in one. Without a live link, or with a bridge whose dialogs never reach us (a
/// terminal-only prompt could be what herdr sees after a failed run), `blocked` stays what herdr says.
pub fn provider_wait(state: HerdrState, omp: Option<&OmpView>, bridge: Option<&BridgeSession>) -> Option<ProviderWait> {
    let v = omp.filter(|v| v.link == tf_proto::model::LinkState::Live && v.needs.is_none())?;
    if bridge.is_some_and(|b| b.state.plan_review.is_some()) {
        return None;
    }
    let mid_run = matches!(state, HerdrState::Idle | HerdrState::Done | HerdrState::Unknown) && v.turn_active;
    if v.retry.is_some() && (state == HerdrState::Blocked || mid_run) {
        return Some(ProviderWait::Retrying);
    }
    let dialogs_seen = bridge.is_none_or(|b| b.caps.live == 0 || b.caps.dialogs);
    (state == HerdrState::Blocked && v.tail_error.is_some() && dialogs_seen).then_some(ProviderWait::Failed)
}

/// Needs-you (§3.5): replica dialog, then bridge plan review, then herdr `blocked` that no
/// provider wait explains.
fn needs_for(i: &AgentInputs<'_>, state: HerdrState, provider: Option<ProviderWait>) -> Option<NeedsYou> {
    if let Some(mut n) = i.omp.and_then(|v| v.needs.clone()) {
        n.since = i.needs_since;
        return Some(n);
    }
    if let Some(review) = i.bridge.and_then(|b| b.state.plan_review.as_ref()) {
        return Some(plan_review_needs(review, i.needs_since));
    }
    if state == HerdrState::Blocked && !i.blocked_grace && provider.is_none() {
        return Some(NeedsYou {
            kind: NeedsKind::Blocked,
            request_id: None,
            since: i.needs_since,
            title: "Waiting in the terminal".into(),
            question: "The agent shows a prompt TeleFlock cannot answer here.".into(),
            detail: Some("Open the terminal to respond.".into()),
            options: vec![],
            multi: false,
            allow_other: false,
            allow_chat: false,
            command: None,
            answerable: false,
        });
    }
    None
}

pub fn plan_review_options(review: &PlanReviewInfo) -> Vec<NeedsOption> {
    review
        .choices
        .iter()
        .filter(|c| !c.disabled)
        .enumerate()
        .map(|(n, c)| {
            let lower = c.label.to_lowercase();
            NeedsOption {
                id: c.id.clone(),
                label: c.label.clone(),
                description: None,
                recommended: n == 0,
                tone: if n == 0 {
                    OptionTone::Primary
                } else if lower.contains("reject") || lower.contains("discard") || lower.contains("cancel") {
                    OptionTone::Danger
                } else {
                    OptionTone::Neutral
                },
            }
        })
        .collect()
}

pub fn plan_review_needs(review: &PlanReviewInfo, since: Millis) -> NeedsYou {
    NeedsYou {
        kind: NeedsKind::PlanReview,
        request_id: Some(review.review_id.clone()),
        since,
        title: "Review plan".into(),
        question: review.title.clone().unwrap_or_else(|| "The plan is ready for review".into()),
        detail: Some(clip(&review.content, 600)),
        options: plan_review_options(review),
        multi: false,
        allow_other: true,
        allow_chat: false,
        command: None,
        answerable: true,
    }
}

/// The plan review as a session dialog (`SessionEvent::Ui`).
pub fn plan_review_ui(review: &PlanReviewInfo) -> UiRequest {
    UiRequest {
        id: review.review_id.clone(),
        kind: UiKind::PlanReview,
        title: review.title.clone().unwrap_or_else(|| "Review plan".into()),
        message: None,
        options: plan_review_options(review),
        allow_other: true,
        allow_chat: false,
        initial: None,
        plan: Some(PlanReview { title: review.title.clone(), content: review.content.clone(), path: review.plan_path.clone() }),
        call_id: None,
    }
}

/// Key identifying a needs-you episode (a new key means a new notification).
pub fn needs_key(n: &NeedsYou) -> String {
    format!("{:?}:{}", n.kind, n.request_id.as_deref().unwrap_or(&n.question))
}

/// Session capabilities given the link, the bridge, and the bridge's data plane while it serves
/// the session (§3.4: bridge first, collab second, injection last). Without the data plane's
/// dialog or subagent support those controls are left to the terminal.
pub fn capabilities(live: bool, bridge: bool, data_plane: Option<BridgeCaps>) -> Capabilities {
    let dialogs = data_plane.is_none_or(|c| c.dialogs);
    let subagents = data_plane.is_none_or(|c| c.subagent_ctl);
    Capabilities {
        prompt: live,
        steer: live,
        follow_up: live,
        abort: live,
        answer: live && dialogs,
        model: true,
        thinking: true,
        fast: true,
        plan: true,
        goal: true,
        compact: true,
        rename: true,
        fork: true,
        branch: bridge,
        tree: bridge,
        btw: bridge,
        export: true,
        handoff: true,
        subagents: live && subagents,
        bridge,
        // `/retry` through the bridge's composer or keystrokes when omp's own retry is missing.
        retry: true,
        subagent_retry: live && data_plane.is_some_and(|c| c.resume_tree),
    }
}

// ───────────────────────────── workspaces ─────────────────────────────

/// `repo_of`: the repository facts of a folder, when known.
pub fn build_workspaces<'a>(
    workspaces: &[WorkspaceInfo],
    tabs: &[TabInfo],
    panes: &[PaneInfo],
    agent_by_pane: &HashMap<String, String>,
    repo_of: impl Fn(&str) -> Option<&'a RepoInfo>,
    procs: &super::procs::PaneProcs,
) -> Vec<Workspace> {
    let mut out: Vec<Workspace> = workspaces
        .iter()
        .map(|w| {
            let mut ws_tabs: Vec<&TabInfo> = tabs.iter().filter(|t| t.workspace_id == w.workspace_id).collect();
            ws_tabs.sort_by_key(|t| t.number);
            let tabs: Vec<Tab> = ws_tabs
                .iter()
                .map(|t| Tab {
                    id: t.tab_id.clone(),
                    label: t.label.clone(),
                    panes: panes
                        .iter()
                        .filter(|p| p.tab_id == t.tab_id)
                        .map(|p| WirePane {
                            id: p.pane_id.clone(),
                            terminal_id: (!p.terminal_id.is_empty()).then(|| p.terminal_id.clone()),
                            title: p
                                .label
                                .clone()
                                .or_else(|| p.title.clone())
                                .or_else(|| p.terminal_title_stripped.as_deref().map(strip_spinner))
                                .filter(|s| !s.is_empty()),
                            cwd: p.foreground_cwd.clone().or_else(|| p.cwd.clone()),
                            agent_id: agent_by_pane.get(&p.pane_id).cloned(),
                            focused: p.focused,
                            process: procs.name(&p.pane_id).map(str::to_string),
                        })
                        .collect(),
                })
                .collect();
            let cwd = workspace_cwd(w, &ws_tabs, panes);
            let repo = repo_of(&cwd).cloned();
            let worktree = w.worktree.as_ref().filter(|wt| wt.is_linked_worktree).map(|wt| WorktreeInfo {
                path: wt.checkout_path.clone(),
                branch: repo.as_ref().and_then(|r| r.branch.clone()),
                primary_workspace_id: workspaces
                    .iter()
                    .find(|o| {
                        o.workspace_id != w.workspace_id
                            && o.worktree.as_ref().is_some_and(|x| x.repo_key == wt.repo_key && !x.is_linked_worktree)
                    })
                    .map(|o| o.workspace_id.clone()),
            });
            Workspace {
                id: w.workspace_id.clone(),
                label: w.label.clone(),
                cwd,
                repo,
                worktree,
                tabs,
                rollup: herdr_state(w.agent_status),
                order: w.number,
            }
        })
        .collect();
    out.sort_by_key(|w| w.order);
    out
}

/// Workspace folder: the checkout path, else the cwd of the first pane of its first tab.
pub fn workspace_cwd(w: &WorkspaceInfo, ws_tabs: &[&TabInfo], panes: &[PaneInfo]) -> String {
    if let Some(wt) = &w.worktree {
        if !wt.checkout_path.is_empty() {
            return wt.checkout_path.clone();
        }
    }
    let first_tab = w.active_tab_id.as_deref().or(ws_tabs.first().map(|t| t.tab_id.as_str()));
    panes
        .iter()
        .find(|p| Some(p.tab_id.as_str()) == first_tab)
        .or_else(|| panes.iter().find(|p| p.workspace_id == w.workspace_id))
        .and_then(|p| p.cwd.clone())
        .unwrap_or_default()
}

// ───────────────────────────── notifications ─────────────────────────────

pub fn needs_notification(agent: &Agent, at: Millis) -> Option<Notification> {
    let n = agent.needs.as_ref()?;
    let mut body = if n.question.is_empty() { n.title.clone() } else { clip(&n.question, 200) };
    if let Some(note) = crate::autoanswer::needs_note(agent, at) {
        body = format!("{body}\n{note}");
    }
    let actions = if n.answerable && !n.multi {
        n.options
            .iter()
            .take(3)
            .map(|o| NotifyAction {
                id: o.id.clone(),
                label: o.label.clone(),
                answer: Some(Answer { choices: vec![o.id.clone()], text: None, cancel: false, chat: false }),
            })
            .collect()
    } else {
        vec![]
    };
    Some(Notification {
        id: new_id("n"),
        at,
        kind: NotifyKind::Needs,
        agent_id: agent.id.clone(),
        title: format!("{} · {}", agent.name, n.title),
        body,
        request_id: n.request_id.clone(),
        actions,
    })
}

pub fn finished_notification(agent: &Agent, at: Millis) -> Notification {
    let body = agent.live.line.clone().unwrap_or_else(|| agent.title.clone());
    Notification {
        id: new_id("n"),
        at,
        kind: NotifyKind::Finished,
        agent_id: agent.id.clone(),
        title: format!("{} finished", agent.name),
        body: clip(&body, 200),
        request_id: None,
        actions: vec![],
    }
}

pub fn quiet_notification(agent: &Agent, at: Millis, silent_ms: Millis) -> Notification {
    Notification {
        id: new_id("n"),
        at,
        kind: NotifyKind::Quiet,
        agent_id: agent.id.clone(),
        title: format!("{} has been quiet", agent.name),
        body: format!("No activity for {} s while working.", silent_ms / 1000),
        request_id: None,
        actions: vec![],
    }
}

pub fn error_notification(agent_id: &str, agent_name: &str, text: &str, at: Millis) -> Notification {
    Notification {
        id: new_id("n"),
        at,
        kind: NotifyKind::Error,
        agent_id: agent_id.to_string(),
        title: format!("{agent_name} hit an error"),
        body: clip(text, 200),
        request_id: None,
        actions: vec![],
    }
}

/// How a provider refusal reads on the board's activity and in notifications, the transcript's
/// words: `Refused · cyber` (`sensitive`: `Flagged by safety filters`).
pub fn refusal_title(refusal: &Refusal) -> String {
    let what = if refusal.kind == "sensitive" { "Flagged by safety filters" } else { "Refused" };
    match refusal.category.as_deref() {
        Some(category) => format!("{what} · {category}"),
        None => what.to_owned(),
    }
}

/// The provider refused the agent's turn: `text` is omp's error for it.
pub fn refusal_notification(agent_id: &str, agent_name: &str, refusal: &Refusal, text: &str, at: Millis) -> Notification {
    Notification {
        id: new_id("n"),
        at,
        kind: NotifyKind::Error,
        agent_id: agent_id.to_string(),
        title: format!("{agent_name}: {}", refusal_title(refusal)),
        body: clip(refusal.explanation.as_deref().unwrap_or(text), 200),
        request_id: None,
        actions: vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn columns() {
        assert_eq!(column(HerdrState::Blocked, false, true), Column::Needs);
        assert_eq!(column(HerdrState::Working, true, false), Column::Needs);
        assert_eq!(column(HerdrState::Working, false, true), Column::Running);
        assert_eq!(column(HerdrState::Idle, false, true), Column::Done);
        assert_eq!(column(HerdrState::Idle, false, false), Column::Review);
        assert_eq!(column(HerdrState::Done, false, false), Column::Review);
        assert_eq!(column(HerdrState::Unknown, false, false), Column::Review);
    }

    #[test]
    fn spinner_is_stripped() {
        assert_eq!(strip_spinner("π ⠧ tmp"), "tmp");
        assert_eq!(strip_spinner("omp: fix bug"), "omp: fix bug");
    }

    fn herdr_agent(status: AgentStatus) -> AgentInfo {
        AgentInfo {
            pane_id: "w1:p1".into(),
            terminal_id: "term_1".into(),
            workspace_id: "w1".into(),
            tab_id: "w1:t1".into(),
            name: Some("lab".into()),
            agent: Some("claude".into()),
            agent_status: status,
            ..Default::default()
        }
    }

    fn inputs(a: &AgentInfo) -> AgentInputs<'_> {
        AgentInputs {
            herdr: a,
            omp: None,
            link: LinkStatus::new(tf_proto::model::LinkState::NotShared, None, None, None),
            link_since: None,
            omp_session_id: None,
            omp_pid: None,
            bridge: None,
            archived: false,
            turns: 2,
            first_seen: Some(1),
            state_since: 5,
            needs_since: 7,
            pane_activity: Some(9),
            repo: None,
            turn_started_at: None,
            last_turn_ended_at: None,
            blocked_grace: false,
        }
    }

    #[test]
    fn non_omp_agent_maps_herdr_state() {
        let a = herdr_agent(AgentStatus::Blocked);
        let agent = build_agent(&inputs(&a));
        assert_eq!(agent.id, "term_1");
        assert_eq!(agent.column, Column::Needs);
        assert!(agent.omp.is_none());
        let needs = agent.needs.as_ref().unwrap();
        assert_eq!(needs.kind, NeedsKind::Blocked);
        assert!(!needs.answerable);
        assert_eq!(needs.since, 7);
        assert_eq!(agent.live.last_event_at, Some(9));

        let a = herdr_agent(AgentStatus::Idle);
        let mut i = inputs(&a);
        i.archived = true;
        let agent = build_agent(&i);
        assert_eq!(agent.column, Column::Done);
        assert!(agent.archived);
    }

    #[test]
    fn herdr_working_outliving_a_cancelled_jobs_wait_settles() {
        let mut w = JobsWait::default();
        // Waiting on jobs: herdr's `working` is right (a result will wake the agent).
        assert_eq!(w.observe(1_000, true, false, true), (false, false));
        assert_eq!(w.observe(9_000, true, false, true), (false, false));
        // The last job was cancelled: nothing runs or is queued, nothing continues. Wait out the grace.
        assert_eq!(w.observe(10_000, true, false, false), (false, true));
        assert_eq!(w.observe(10_000 + JOBS_SETTLE_MS - 1, true, false, false), (false, true));
        assert_eq!(w.observe(10_000 + JOBS_SETTLE_MS, true, false, false), (true, false));
        // Stays settled while nothing starts.
        assert_eq!(w.observe(60_000, true, false, false), (true, false));
        // A new turn starts: the episode is over.
        assert_eq!(w.observe(61_000, true, true, false), (false, false));
        assert_eq!(w.observe(62_000, true, false, false), (false, false));
    }

    #[test]
    fn a_result_that_wakes_the_agent_is_never_settled_over() {
        let mut w = JobsWait::default();
        assert_eq!(w.observe(1_000, true, false, true), (false, false));
        // The job finished; its delivery starts the turn within the grace.
        assert_eq!(w.observe(2_000, true, false, false), (false, true));
        assert_eq!(w.observe(3_000, true, true, false), (false, false));
        // herdr's own idle ends the episode too, and an agent that never waited is never touched.
        assert_eq!(w.observe(4_000, false, false, false), (false, false));
        assert_eq!(w.observe(50_000, true, false, false), (false, false));
    }

    fn goal(status: &str) -> tf_proto::model::GoalInfo {
        tf_proto::model::GoalInfo { objective: "ship it".into(), status: status.into(), tokens_used: Some(1200), budget: Some(50_000) }
    }

    fn bridged(goal: Option<tf_proto::model::GoalInfo>) -> BridgeSession {
        BridgeSession {
            pid: 7,
            session_id: "s1".into(),
            session_file: None,
            cwd: "/tmp".into(),
            omp_version: None,
            bridge_version: "1".into(),
            tui: true,
            state: crate::bridge::CtlState { goal, ..Default::default() },
            connected_at: 0,
            caps: Default::default(),
            jobs: None,
            conn: 0,
        }
    }

    #[test]
    fn bridge_goal_reaches_board_and_session_meta() {
        let mut a = herdr_agent(AgentStatus::Working);
        a.agent = Some("omp".into());

        // Active → paused: the board agent follows the bridge state.
        for status in ["active", "paused"] {
            let b = bridged(Some(goal(status)));
            let mut i = inputs(&a);
            i.bridge = Some(&b);
            let g = build_agent(&i).omp.unwrap().goal.unwrap();
            assert_eq!((g.objective.as_str(), g.status.as_str(), g.tokens_used, g.budget), ("ship it", status, Some(1200), Some(50_000)));
        }

        // Session meta: the overlay sets the goal, and a bridge saying "no goal" (drop/complete) clears it.
        let mut meta = tf_collab::Replica::new("t").meta().clone();
        let overlay = |g| crate::omp::MetaOverlay { bridge: true, goal: Some(g), ..Default::default() };
        overlay(Some(goal("active"))).apply(&mut meta, true);
        assert_eq!(meta.goal.as_ref().map(|g| g.status.as_str()), Some("active"));
        overlay(None).apply(&mut meta, true);
        assert_eq!(meta.goal, None);
        // Without the bridge the replica's goal is kept.
        meta.goal = Some(goal("active"));
        crate::omp::MetaOverlay::default().apply(&mut meta, true);
        assert!(meta.goal.is_some());

        // Dropped/completed per the bridge: no goal on the board either.
        let b = bridged(None);
        let mut i = inputs(&a);
        i.bridge = Some(&b);
        assert_eq!(build_agent(&i).omp.unwrap().goal, None);
    }

    #[test]
    fn needs_notification_has_three_actions() {
        let a = herdr_agent(AgentStatus::Blocked);
        let mut agent = build_agent(&inputs(&a));
        let n = agent.needs.as_mut().unwrap();
        n.answerable = true;
        n.request_id = Some("r1".into());
        n.options = (0..5)
            .map(|k| NeedsOption {
                id: format!("o{k}"),
                label: format!("O{k}"),
                description: None,
                recommended: false,
                tone: OptionTone::Neutral,
            })
            .collect();
        let note = needs_notification(&agent, 1).unwrap();
        assert_eq!(note.actions.len(), 3);
        assert_eq!(note.actions[0].answer.as_ref().unwrap().choices, vec!["o0".to_string()]);
        assert_eq!(note.request_id.as_deref(), Some("r1"));
    }

    // ── herdr `blocked` that omp's provider retry explains (§3.5) ──

    fn omp_view(link: tf_proto::model::LinkState, asking: bool, retrying: bool, failed: bool) -> OmpView {
        let wait = tf_proto::model::RetryWait {
            kind: tf_proto::model::RetryKind::RateLimit,
            attempt: 1,
            max_attempts: 10,
            since: 1_000,
            retry_at: 295_000,
            error: "429 rate_limit_error".into(),
        };
        let ask = NeedsYou {
            kind: NeedsKind::Ask,
            request_id: Some("r1".into()),
            since: 0,
            title: "Question".into(),
            question: "Which one?".into(),
            detail: None,
            options: vec![],
            multi: false,
            allow_other: false,
            allow_chat: false,
            command: None,
            answerable: true,
        };
        OmpView {
            session_id: "s1".into(),
            pid: 7,
            link,
            link_error: None,
            link_reason: None,
            link_via: None,
            meta: BoardMeta {
                session_id: Some("s1".into()),
                session_file: None,
                title: None,
                model: None,
                thinking: None,
                fast: false,
                mode: tf_proto::model::OmpMode::Normal,
                goal: None,
                context: None,
                cost: None,
                queue: tf_proto::model::QueueInfo { steering: vec![], follow_up: vec![] },
                started_at: None,
                todos: None,
                subagents: None,
                diff: None,
            },
            live: Liveness { last_event_at: Some(2_000), streaming: false, thinking: false, tool: None, tps: None, tps_split: None, line: None },
            needs: asking.then_some(ask),
            streaming: false,
            first_prompt: None,
            turn_active: retrying,
            last_turn_row_at: None,
            retry: retrying.then_some(wait),
            tail_error: failed.then(|| "429 rate_limit_error".to_string()),
        }
    }

    /// How the board maps a herdr-blocked omp agent: (column, needs kind) per combination of
    /// pending dialog, retry wait, provider-error tail, bridge and link.
    #[test]
    fn blocked_omp_maps_by_what_explains_it() {
        use tf_proto::model::LinkState::{Live, NotShared};
        #[derive(Clone, Copy, PartialEq, Debug)]
        enum Br {
            None,
            Dialogs,
            NoDialogs,
        }
        let mut a = herdr_agent(AgentStatus::Blocked);
        a.agent = Some("omp".into());
        let blocked = Some(NeedsKind::Blocked);
        //   link     ask    retry  tail   bridge        → column            needs
        let cases = [
            (Live, false, false, false, Br::Dialogs, Column::Needs, blocked),
            (Live, false, false, false, Br::None, Column::Needs, blocked),
            (Live, false, true, false, Br::Dialogs, Column::Running, None),
            (Live, false, true, false, Br::None, Column::Running, None),
            (Live, false, true, false, Br::NoDialogs, Column::Running, None),
            (Live, false, true, true, Br::Dialogs, Column::Running, None),
            (Live, false, false, true, Br::Dialogs, Column::Review, None),
            (Live, false, false, true, Br::None, Column::Review, None),
            // a bridge whose dialogs never reach us: a terminal-only prompt is possible
            (Live, false, false, true, Br::NoDialogs, Column::Needs, blocked),
            // a dialog always wins
            (Live, true, true, false, Br::Dialogs, Column::Needs, Some(NeedsKind::Ask)),
            (Live, true, false, true, Br::Dialogs, Column::Needs, Some(NeedsKind::Ask)),
            // no live structured link: herdr's word stands
            (NotShared, false, true, true, Br::Dialogs, Column::Needs, blocked),
        ];
        for (link, ask, retry, tail, br, column, needs) in cases {
            let view = omp_view(link, ask, retry, tail);
            let bridge = match br {
                Br::None => None,
                Br::Dialogs | Br::NoDialogs => {
                    let mut b = bridged(None);
                    b.caps.live = 1;
                    b.caps.dialogs = br == Br::Dialogs;
                    Some(b)
                }
            };
            let mut i = inputs(&a);
            i.omp = Some(&view);
            i.bridge = bridge.as_ref();
            let agent = build_agent(&i);
            let got = (agent.column, agent.needs.as_ref().map(|n| n.kind));
            assert_eq!(got, (column, needs), "{link:?} ask={ask} retry={retry} tail={tail} bridge={br:?}");
            assert_eq!(agent.state, HerdrState::Blocked, "herdr's own state is reported as it is");
            assert_eq!(agent.omp.as_ref().unwrap().retry.is_some(), retry, "the wait reaches the card");
        }
    }

    #[test]
    fn only_a_blocked_agent_needs_an_explanation() {
        let mut a = herdr_agent(AgentStatus::Working);
        a.agent = Some("omp".into());
        let view = omp_view(tf_proto::model::LinkState::Live, false, true, true);
        let mut i = inputs(&a);
        i.omp = Some(&view);
        let agent = build_agent(&i);
        assert_eq!((agent.column, agent.needs.is_none()), (Column::Running, true));
        assert_eq!(agent.omp.unwrap().retry.map(|r| r.max_attempts), Some(10));

        // The session's one-off grace for a dialog that is not visible yet keeps it running as before.
        let a = {
            let mut a = herdr_agent(AgentStatus::Blocked);
            a.agent = Some("omp".into());
            a
        };
        let view = omp_view(tf_proto::model::LinkState::Live, false, false, false);
        let mut i = inputs(&a);
        i.omp = Some(&view);
        i.blocked_grace = true;
        assert_eq!(build_agent(&i).column, Column::Running);

        // An archived agent whose run ended in a provider error stays archived.
        let view = omp_view(tf_proto::model::LinkState::Live, false, false, true);
        let mut i = inputs(&a);
        i.omp = Some(&view);
        i.archived = true;
        assert_eq!(build_agent(&i).column, Column::Done);
    }

    /// herdr's omp integration missing or behind (it says `idle`) while omp's run is on and it waits to retry.
    #[test]
    fn an_idle_agent_in_a_retry_wait_is_still_running() {
        let mut a = herdr_agent(AgentStatus::Idle);
        a.agent = Some("omp".into());
        let mut view = omp_view(tf_proto::model::LinkState::Live, false, true, false);
        let mut i = inputs(&a);
        i.omp = Some(&view);
        let agent = build_agent(&i);
        assert_eq!((agent.column, agent.needs.is_none()), (Column::Running, true));
        // The replica's run is over: the stale wait explains nothing.
        view.turn_active = false;
        let mut i = inputs(&a);
        i.omp = Some(&view);
        assert_eq!(build_agent(&i).column, Column::Review);
    }
}
