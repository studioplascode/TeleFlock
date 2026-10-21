//! `agent.*` and `session.*` (architecture §3.4, §3.6, §3.7).
//!
//! Control order per method: collab guest first where collab can do it (prompt/steer,
//! abort, answers, subagents, transcripts), then the companion bridge (model, thinking,
//! fast, plan, goal, compact, rename, fork/branch/tree, new session, handoff, export,
//! btw, follow-up queue), then herdr keystroke injection under the §3.6 safety rules.

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tracing::{info, warn};

use tf_herdr::{AgentStart, PaneSplit, SplitDirection, TabCreate, WorkspaceCreate};
use tf_proto::methods::*;
use tf_proto::model::{ActivityKind, Agent, HerdrState, LinkState, NeedsKind, OmpMode, ThinkingLevel};
use tf_proto::session::{HistoryPage, SessionSnapshot};
use tf_proto::term::Split;
use tf_proto::{ApiError, Empty, HostMethod};

use crate::bridge::BridgeError;
use crate::clients::ClientHandle;
use crate::inject::{self, When};
use crate::omp::{guest_err, MetaOverlay, OmpSession};
use crate::ops::{herdr_err, to_value, Ctx};
use crate::state::build;
use crate::state::subs::Sub;

const DEFAULT_LIMIT: usize = 200;

pub async fn handle(ctx: &Ctx, req: HostMethod, client: &ClientHandle) -> Result<Value, ApiError> {
    use HostMethod as M;
    match req {
        M::SessionOpen(p) => to_value(session_open(ctx, p, client)?),
        M::SessionClose(p) => {
            session_close(ctx, &p.agent_id, client);
            to_value(Empty {})
        }
        M::SessionHistory(p) => to_value(session_history(ctx, p)?),
        M::SubagentTranscript(p) => to_value(subagent_transcript(ctx, p).await?),

        M::AgentPrompt(p) => unit(prompt(ctx, p, client).await),
        M::AgentAbort(p) => unit(abort(ctx, &p.agent_id).await),
        M::AgentAnswer(p) => unit(answer(ctx, p).await),
        M::AgentSetModel(p) => unit(set_model(ctx, p).await),
        M::AgentSetThinking(p) => unit(set_thinking(ctx, p).await),
        M::AgentSetFast(p) => unit(set_fast(ctx, p).await),
        M::AgentSetPlan(p) => unit(set_plan(ctx, p).await),
        M::AgentGoal(p) => unit(goal(ctx, p).await),
        M::AgentCompact(p) => unit(compact(ctx, p).await),
        M::AgentRename(p) => unit(rename(ctx, p).await),
        M::AgentFork(p) => unit(fork(ctx, p).await),
        M::AgentBranch(p) => unit(branch(ctx, p).await),
        M::AgentNavigate(p) => unit(navigate(ctx, p).await),
        M::AgentNewSession(p) => unit(new_session(ctx, &p.agent_id).await),
        M::AgentHandoff(p) => unit(handoff(ctx, p).await),
        M::AgentExport(p) => to_value(export(ctx, &p.agent_id).await?),
        M::AgentBtw(p) => to_value(btw(ctx, p).await?),
        M::AgentSlash(p) => unit(slash(ctx, p).await),
        M::AgentCommands(p) => to_value(commands(ctx, &p.agent_id).await?),
        M::AgentDequeue(p) => to_value(dequeue(ctx, &p.agent_id).await?),
        M::AgentKeys(p) => unit(keys(ctx, p).await),
        M::AgentSubagent(p) => unit(subagent(ctx, p)),
        M::AgentArchive(p) => unit(archive(ctx, p)),
        M::AgentConnect(p) => unit(connect(ctx, &p.agent_id).await),
        M::AgentStart(p) => to_value(start_agent(ctx, p.target, &p.spec, None).await?),
        M::AgentStop(p) => unit(stop(ctx, p).await),
        M::AgentRenameHandle(p) => unit(rename_handle(ctx, p).await),
        other => Err(ApiError::new("unknown_method", format!("`{}` is not an agent method", other.name()))),
    }
}

fn unit(r: Result<(), ApiError>) -> Result<Value, ApiError> {
    r.and_then(|()| to_value(Empty {}))
}

// ───────────────────────────── lookups ─────────────────────────────

fn agent(ctx: &Ctx, agent_id: &str) -> Result<Agent, ApiError> {
    ctx.state.agent(agent_id).ok_or_else(|| ApiError::new("not_found", format!("no agent `{agent_id}`")))
}

fn omp_agent(ctx: &Ctx, agent_id: &str) -> Result<Agent, ApiError> {
    let a = agent(ctx, agent_id)?;
    if a.kind != "omp" {
        return Err(ApiError::new("unsupported", format!("`{}` is a {} agent; use the terminal", a.name, a.kind)));
    }
    Ok(a)
}

fn session_id(ctx: &Ctx, agent_id: &str) -> Result<String, ApiError> {
    omp_agent(ctx, agent_id)?;
    ctx.state.omp_session_of(agent_id).ok_or_else(|| {
        ApiError::new("not_connected", "this omp session is not known to TeleFlock yet")
            .with_hint("Connect it (agent.connect) or wait for herdr to report the session")
            .retryable()
    })
}

/// The live collab guest of an agent.
fn guest(ctx: &Ctx, agent_id: &str) -> Result<Arc<OmpSession>, ApiError> {
    let sid = session_id(ctx, agent_id)?;
    match ctx.omp.session(&sid) {
        Some(s) if s.link().0 == LinkState::Live => Ok(s),
        Some(s) => Err(ApiError::new("not_connected", s.link().1.unwrap_or_else(|| "reconnecting to the session".into()))
            .retryable()),
        None => Err(not_shared()),
    }
}

fn not_shared() -> ApiError {
    ApiError::new("not_connected", "this omp session is not shared with TeleFlock")
        .with_hint("Use Connect to start sharing it on the host relay")
}

/// The bridge session id of an agent, when the companion extension is loaded.
fn bridge_sid(ctx: &Ctx, agent_id: &str) -> Option<String> {
    let sid = ctx.state.omp_session_of(agent_id)?;
    ctx.bridge.is_connected(&sid).then_some(sid)
}

fn bridge_err(e: BridgeError) -> ApiError {
    ApiError::from(e)
}

/// Refreshes the bridge overlay (meta fields + caps) of an omp session, and re-fetches the session
/// tree when the omp leaf moved.
pub fn push_meta_overlay(ctx: &Ctx, session_id: &str) {
    let Some(s) = ctx.omp.session(session_id) else { return };
    let bridge = ctx.bridge.by_session(session_id);
    let overlay = match &bridge {
        Some(b) => MetaOverlay {
            bridge: true,
            model: b.state.model.clone(),
            thinking: b.state.thinking,
            fast: Some(b.state.fast),
            mode: Some(b.state.mode),
            title: b.state.title.clone(),
            context: b.state.context.clone(),
            queue: Some(b.state.queue.clone()),
            tree: None,
            goal: Some(b.state.goal.clone()),
        },
        None => MetaOverlay::default(),
    };
    s.set_overlay(overlay);
    if let Some(b) = bridge
        && s.claim_tree_refresh(&b.state.leaf_id)
    {
        let handle = ctx.bridge.clone();
        let sid = session_id.to_owned();
        tokio::spawn(async move {
            let tree = handle.get_tree(&sid).await;
            if let Err(e) = &tree {
                tracing::debug!(session_id = %sid, "session tree fetch failed: {e:?}");
            }
            s.set_tree(tree.ok());
        });
    }
}

// ───────────────────────────── session.* ─────────────────────────────

fn session_open(ctx: &Ctx, p: SessionOpenParams, client: &ClientHandle) -> Result<SessionSnapshot, ApiError> {
    let sid = session_id(ctx, &p.agent_id)?;
    let s = ctx.omp.session(&sid).ok_or_else(not_shared)?;
    push_meta_overlay(ctx, &sid);
    let limit = p.limit.map(|l| l.clamp(1, 2000) as usize).unwrap_or(DEFAULT_LIMIT);
    let mut snap = s.subscribe(client, &p.agent_id, limit);
    if snap.ui.is_none() {
        if let Some(review) = ctx.bridge.by_session(&sid).and_then(|b| b.state.plan_review) {
            snap.ui = Some(build::plan_review_ui(&review));
        }
    }
    let prev = ctx.sessions.add(client.id(), Sub { agent_id: p.agent_id.clone(), omp_session: sid.clone() });
    if let Some(prev) = prev.filter(|prev| prev.omp_session != sid) {
        if let Some(old) = ctx.omp.session(&prev.omp_session) {
            old.unsubscribe(client.id(), &prev.agent_id);
        }
    }
    Ok(snap)
}

fn session_close(ctx: &Ctx, agent_id: &str, client: &ClientHandle) {
    if let Some(sub) = ctx.sessions.remove(client.id(), agent_id) {
        if let Some(s) = ctx.omp.session(&sub.omp_session) {
            s.unsubscribe(client.id(), agent_id);
        }
    }
}

/// Drops every session subscription of a disconnected client.
pub fn client_gone(ctx: &Ctx, client_id: &str) {
    for sub in ctx.sessions.take_client(client_id) {
        if let Some(s) = ctx.omp.session(&sub.omp_session) {
            s.unsubscribe_client(client_id);
        }
    }
}

fn session_history(ctx: &Ctx, p: SessionHistoryParams) -> Result<HistoryPage, ApiError> {
    let sid = session_id(ctx, &p.agent_id)?;
    let s = ctx.omp.session(&sid).ok_or_else(not_shared)?;
    let limit = p.limit.map(|l| l.clamp(1, 2000) as usize).unwrap_or(DEFAULT_LIMIT);
    Ok(s.history(Some(&p.cursor), limit))
}

async fn subagent_transcript(ctx: &Ctx, p: SubagentRef) -> Result<HistoryPage, ApiError> {
    let s = guest(ctx, &p.agent_id)?;
    let mut text = String::new();
    let mut from = 0u64;
    // Pull the whole transcript (chunked by the host at line boundaries).
    for _ in 0..64 {
        let chunk = s.guest.fetch_transcript(&p.subagent_id, from).await.map_err(guest_err)?;
        if let Some(err) = chunk.error {
            return Err(ApiError::new("omp_error", format!("transcript: {err}")));
        }
        let done = chunk.text.is_empty() || chunk.new_size <= from;
        text.push_str(&chunk.text);
        from = chunk.new_size;
        if done {
            break;
        }
    }
    Ok(tf_collab::replica::transcript_page(&text))
}

// ───────────────────────────── collab-first ─────────────────────────────

async fn prompt(ctx: &Ctx, p: PromptParams, client: &ClientHandle) -> Result<(), ApiError> {
    if p.text.trim().is_empty() && p.images.is_empty() {
        return Err(ApiError::new("invalid_params", "empty prompt"));
    }
    let a = omp_agent(ctx, &p.agent_id)?;
    if a.state == HerdrState::Blocked && a.needs.as_ref().is_some_and(|n| n.answerable) {
        return Err(ApiError::new("agent_blocked", "the agent is waiting for an answer").with_hint("Answer the pending question first"));
    }
    let streaming = a.state == HerdrState::Working;
    info!(agent = %p.agent_id, device = %client.info().device, delivery = ?p.delivery, "prompt");
    // Every device shares one collab guest; tell the replica who sent this prompt.
    if let Some(s) = ctx.state.omp_session_of(&p.agent_id).and_then(|sid| ctx.omp.session(&sid)) {
        s.expect_prompt(&p.text, &client.info().device);
    }
    if p.delivery == Delivery::FollowUp && streaming {
        if !p.images.is_empty() {
            return Err(ApiError::new("unsupported", "follow-ups cannot carry images; send it as a steer or after the turn"));
        }
        if let Some(sid) = bridge_sid(ctx, &p.agent_id) {
            ctx.bridge.follow_up(&sid, &p.text).await.map_err(bridge_err)?;
            return Ok(());
        }
        return inject::follow_up(ctx, &p.agent_id, &p.text).await;
    }
    match guest(ctx, &p.agent_id) {
        Ok(s) => {
            let images = p
                .images
                .into_iter()
                .map(|i| tf_collab::ImageContent { kind: "image".into(), data: i.data, mime_type: i.mime })
                .collect();
            s.guest.prompt(p.text, images).map_err(guest_err)
        }
        Err(e) if e.code == "not_connected" => {
            // Not shared: submit through herdr (Enter while streaming steers).
            if !p.images.is_empty() {
                return Err(e);
            }
            if let Some(sid) = bridge_sid(ctx, &p.agent_id) {
                return ctx.bridge.follow_up(&sid, &p.text).await.map(|_| ()).map_err(bridge_err);
            }
            ctx.herdr.agent_prompt(&a.pane_id, &p.text, None).await.map(|_| ()).map_err(herdr_err)
        }
        Err(e) => Err(e),
    }
}

async fn abort(ctx: &Ctx, agent_id: &str) -> Result<(), ApiError> {
    let a = agent(ctx, agent_id)?;
    if a.kind == "omp" {
        if let Ok(s) = guest(ctx, agent_id) {
            return s.guest.abort().map_err(guest_err);
        }
        if let Some(sid) = bridge_sid(ctx, agent_id) {
            return ctx.bridge.abort(&sid).await.map_err(bridge_err);
        }
        if a.state != HerdrState::Working {
            return Ok(());
        }
        // Esc on a streaming composer aborts the turn (omp.md §1.4).
        return ctx.herdr.agent_send_keys(&a.pane_id, &["esc"]).await.map_err(herdr_err);
    }
    ctx.herdr.agent_send_keys(&a.pane_id, &["ctrl+c"]).await.map_err(herdr_err)
}

async fn answer(ctx: &Ctx, p: AnswerParams) -> Result<(), ApiError> {
    let a = omp_agent(ctx, &p.agent_id)?;
    let needs = a.needs.clone();
    let sid = session_id(ctx, &p.agent_id)?;
    // Plan reviews are answered through the bridge.
    if let Some(review) = ctx.bridge.by_session(&sid).and_then(|b| b.state.plan_review) {
        if review.review_id == p.request_id {
            if p.answer.cancel {
                return Err(ApiError::new("invalid_params", "a plan review cannot be dismissed remotely")
                    .with_hint("Pick an option (keep, refine, …) or close it in the terminal"));
            }
            // "Other" (free text without a choice) is feedback for refining the plan.
            let feedback = p.answer.text.as_deref().map(str::trim).filter(|t| !t.is_empty());
            let choice = match p.answer.choices.first() {
                Some(c) => c.clone(),
                None if feedback.is_some() => "refine".to_string(),
                None => return Err(ApiError::new("invalid_params", "choose a plan review option")),
            };
            ctx.bridge
                .resolve_plan_review(&sid, &review.review_id, &choice, feedback, None)
                .await
                .map_err(bridge_err)?;
            ctx.state.record_activity(&p.agent_id, ActivityKind::Answered, format!("Plan review: {choice}"), None);
            return Ok(());
        }
    }
    let s = guest(ctx, &p.agent_id)?;
    s.answer(&p.request_id, &p.answer)?;
    let label = if p.answer.cancel {
        "Dismissed".to_string()
    } else if p.answer.chat {
        "Chat about this".to_string()
    } else if let Some(t) = &p.answer.text {
        t.clone()
    } else {
        p.answer.choices.join(", ")
    };
    let kind = match needs.as_ref().map(|n| n.kind) {
        Some(NeedsKind::Approval) if p.answer.cancel || label.starts_with("Deny") => ActivityKind::Denied,
        Some(NeedsKind::Approval) => ActivityKind::Approved,
        _ => ActivityKind::Answered,
    };
    let question = needs.map(|n| n.question);
    ctx.state.record_activity(&p.agent_id, kind, label, question);
    ctx.state.mark_dirty();
    Ok(())
}

fn subagent(ctx: &Ctx, p: SubagentCmdParams) -> Result<(), ApiError> {
    let s = guest(ctx, &p.agent_id)?;
    let kind = match p.action {
        SubagentAction::Chat => tf_collab::AgentCmdKind::Chat,
        SubagentAction::Kill => tf_collab::AgentCmdKind::Kill,
        SubagentAction::Revive => tf_collab::AgentCmdKind::Revive,
    };
    if p.action == SubagentAction::Chat && p.message.as_deref().is_none_or(|m| m.trim().is_empty()) {
        return Err(ApiError::new("invalid_params", "chat needs a message"));
    }
    s.guest.agent_cmd(kind, &p.subagent_id, p.message).map_err(guest_err)
}

// ───────────────────────────── bridge-first ─────────────────────────────

fn level_str(l: ThinkingLevel) -> &'static str {
    match l {
        ThinkingLevel::Off => "off",
        ThinkingLevel::Minimal => "minimal",
        ThinkingLevel::Low => "low",
        ThinkingLevel::Medium => "medium",
        ThinkingLevel::High => "high",
        ThinkingLevel::Xhigh => "xhigh",
        ThinkingLevel::Max => "max",
        ThinkingLevel::Auto => "auto",
    }
}

fn check_model(model: &str) -> Result<(), ApiError> {
    let ok = model.split_once('/').is_some_and(|(p, id)| !p.is_empty() && !id.is_empty())
        && !model.chars().any(|c| c.is_whitespace());
    if ok { Ok(()) } else { Err(ApiError::new("invalid_params", format!("model must be `provider/id`, got `{model}`"))) }
}

async fn set_model(ctx: &Ctx, p: SetModelParams) -> Result<(), ApiError> {
    check_model(&p.model)?;
    if let Some(sid) = bridge_sid(ctx, &p.agent_id) {
        ctx.bridge.set_model(&sid, &p.model, p.thinking).await.map_err(bridge_err)?;
        push_meta_overlay(ctx, &sid);
        return Ok(());
    }
    omp_agent(ctx, &p.agent_id)?;
    let cmd = match p.thinking {
        Some(l) => format!("/switch {}:{}", p.model, level_str(l)),
        None => format!("/switch {}", p.model),
    };
    inject::slash(ctx, &p.agent_id, &cmd, When::IdleOnly).await
}

async fn set_thinking(ctx: &Ctx, p: SetThinkingParams) -> Result<(), ApiError> {
    if let Some(sid) = bridge_sid(ctx, &p.agent_id) {
        ctx.bridge.set_thinking(&sid, p.level).await.map_err(bridge_err)?;
        push_meta_overlay(ctx, &sid);
        return Ok(());
    }
    omp_agent(ctx, &p.agent_id)?;
    inject::slash(ctx, &p.agent_id, &format!("/effort {}", level_str(p.level)), When::IdleOnly).await
}

async fn set_fast(ctx: &Ctx, p: ToggleParams) -> Result<(), ApiError> {
    if let Some(sid) = bridge_sid(ctx, &p.agent_id) {
        ctx.bridge.set_fast(&sid, p.on).await.map_err(bridge_err)?;
        push_meta_overlay(ctx, &sid);
        return Ok(());
    }
    omp_agent(ctx, &p.agent_id)?;
    inject::slash(ctx, &p.agent_id, if p.on { "/fast on" } else { "/fast off" }, When::IdleOnly).await
}

async fn set_plan(ctx: &Ctx, p: ToggleParams) -> Result<(), ApiError> {
    if let Some(sid) = bridge_sid(ctx, &p.agent_id) {
        ctx.bridge.set_plan(&sid, p.on).await.map_err(bridge_err)?;
        push_meta_overlay(ctx, &sid);
        return Ok(());
    }
    let a = omp_agent(ctx, &p.agent_id)?;
    let mode = a.omp.as_ref().map(|o| o.mode).unwrap_or(OmpMode::Normal);
    // `/plan` cycles off → on → paused → off.
    let presses = match (mode, p.on) {
        (OmpMode::Plan, true) | (OmpMode::Normal, false) => 0,
        (OmpMode::Normal, true) => 1,
        (OmpMode::PlanPaused, false) => 1,
        (OmpMode::PlanPaused, true) => 2,
        (OmpMode::Plan, false) => 2,
    };
    for _ in 0..presses {
        inject::slash(ctx, &p.agent_id, "/plan", When::IdleOnly).await?;
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    Ok(())
}

async fn goal(ctx: &Ctx, p: GoalParams) -> Result<(), ApiError> {
    if p.op == GoalOp::Set && p.objective.as_deref().is_none_or(|o| o.trim().is_empty()) {
        return Err(ApiError::new("invalid_params", "goal set needs an objective"));
    }
    if let Some(sid) = bridge_sid(ctx, &p.agent_id) {
        return ctx.bridge.goal(&sid, p.op, p.objective.as_deref(), p.budget).await.map_err(bridge_err);
    }
    omp_agent(ctx, &p.agent_id)?;
    let cmd = match p.op {
        GoalOp::Set => format!("/goal set {}", one_line(p.objective.as_deref().unwrap_or_default())),
        GoalOp::Pause => "/goal pause".into(),
        GoalOp::Resume => "/goal resume".into(),
        GoalOp::Drop => "/goal drop".into(),
        GoalOp::Budget => match p.budget {
            Some(n) => format!("/goal budget {n}"),
            None => "/goal budget off".into(),
        },
    };
    inject::slash(ctx, &p.agent_id, &cmd, When::IdleOnly).await
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

async fn compact(ctx: &Ctx, p: CompactParams) -> Result<(), ApiError> {
    if let Some(sid) = bridge_sid(ctx, &p.agent_id) {
        ctx.bridge.compact(&sid, p.instructions.as_deref()).await.map_err(bridge_err)?;
    } else {
        omp_agent(ctx, &p.agent_id)?;
        let cmd = match p.instructions.as_deref().map(one_line).filter(|s| !s.is_empty()) {
            Some(focus) => format!("/compact {focus}"),
            None => "/compact".into(),
        };
        inject::slash(ctx, &p.agent_id, &cmd, When::IdleOnly).await?;
    }
    Ok(())
}

async fn rename(ctx: &Ctx, p: RenameParams) -> Result<(), ApiError> {
    let title = one_line(&p.title);
    if title.is_empty() {
        return Err(ApiError::new("invalid_params", "empty title"));
    }
    if let Some(sid) = bridge_sid(ctx, &p.agent_id) {
        ctx.bridge.rename(&sid, &title).await.map_err(bridge_err)?;
        push_meta_overlay(ctx, &sid);
        return Ok(());
    }
    omp_agent(ctx, &p.agent_id)?;
    inject::slash(ctx, &p.agent_id, &format!("/rename {title}"), When::IdleOnly).await
}

async fn fork(ctx: &Ctx, p: ForkParams) -> Result<(), ApiError> {
    if let Some(sid) = bridge_sid(ctx, &p.agent_id) {
        ctx.bridge.fork(&sid, p.entry_id.as_deref(), p.placement).await.map_err(bridge_err)?;
        ctx.omp.repoll();
        ctx.state.refresh();
        return Ok(());
    }
    omp_agent(ctx, &p.agent_id)?;
    if p.entry_id.is_some() {
        return Err(needs_bridge("Forking from an entry"));
    }
    let cmd = match p.placement {
        ForkPlacement::InPlace => "/fork",
        ForkPlacement::Pane => "/fork pane",
    };
    inject::slash(ctx, &p.agent_id, cmd, When::IdleOnly).await?;
    ctx.omp.repoll();
    ctx.state.refresh();
    Ok(())
}

fn needs_bridge(what: &str) -> ApiError {
    ApiError::new("unsupported", format!("{what} needs the TeleFlock bridge extension in this omp session"))
        .with_hint("Start the agent from TeleFlock, or enable the global bridge in host setup")
}

async fn branch(ctx: &Ctx, p: EntryParams) -> Result<(), ApiError> {
    omp_agent(ctx, &p.agent_id)?;
    let sid = bridge_sid(ctx, &p.agent_id).ok_or_else(|| needs_bridge("Branching"))?;
    ctx.bridge.branch(&sid, &p.entry_id).await.map_err(bridge_err)?;
    ctx.omp.repoll();
    Ok(())
}

async fn navigate(ctx: &Ctx, p: EntryParams) -> Result<(), ApiError> {
    omp_agent(ctx, &p.agent_id)?;
    let sid = bridge_sid(ctx, &p.agent_id).ok_or_else(|| needs_bridge("Tree navigation"))?;
    ctx.bridge.navigate_tree(&sid, &p.entry_id, false).await.map_err(bridge_err)
}

async fn new_session(ctx: &Ctx, agent_id: &str) -> Result<(), ApiError> {
    if let Some(sid) = bridge_sid(ctx, agent_id) {
        ctx.bridge.new_session(&sid).await.map_err(bridge_err)?;
    } else {
        omp_agent(ctx, agent_id)?;
        inject::slash(ctx, agent_id, "/new", When::IdleOnly).await?;
    }
    ctx.omp.repoll();
    Ok(())
}

async fn handoff(ctx: &Ctx, p: CompactParams) -> Result<(), ApiError> {
    if let Some(sid) = bridge_sid(ctx, &p.agent_id) {
        return ctx.bridge.handoff(&sid, p.instructions.as_deref()).await.map_err(bridge_err);
    }
    omp_agent(ctx, &p.agent_id)?;
    let cmd = match p.instructions.as_deref().map(one_line).filter(|s| !s.is_empty()) {
        Some(focus) => format!("/handoff {focus}"),
        None => "/handoff".into(),
    };
    inject::slash(ctx, &p.agent_id, &cmd, When::IdleOnly).await
}

async fn export(ctx: &Ctx, agent_id: &str) -> Result<ExportResult, ApiError> {
    if let Some(sid) = bridge_sid(ctx, agent_id) {
        return ctx.bridge.export(&sid, None).await.map_err(bridge_err);
    }
    let a = omp_agent(ctx, agent_id)?;
    inject::slash(ctx, agent_id, "/export", When::IdleOnly).await?;
    // omp prints "Session exported to: <path>".
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(250)).await;
        let text = inject::recent_text(ctx, &a.pane_id, 40).await?;
        if let Some(path) = text.lines().rev().find_map(|l| l.split_once("exported to:").map(|(_, p)| p.trim().to_string())) {
            if !path.is_empty() {
                return Ok(ExportResult { path });
            }
        }
    }
    Err(ApiError::new("timeout", "omp did not report the export path").retryable())
}

async fn btw(ctx: &Ctx, p: BtwParams) -> Result<BtwStarted, ApiError> {
    if p.question.trim().is_empty() {
        return Err(ApiError::new("invalid_params", "empty question"));
    }
    omp_agent(ctx, &p.agent_id)?;
    let sid = bridge_sid(ctx, &p.agent_id).ok_or_else(|| needs_bridge("Side questions"))?;
    let btw_id = ctx.bridge.btw(&sid, &p.question).await.map_err(bridge_err)?;
    Ok(BtwStarted { btw_id })
}

async fn slash(ctx: &Ctx, p: SlashParams) -> Result<(), ApiError> {
    let bridge = bridge_sid(ctx, &p.agent_id);
    if let Err(e) = inject::validate(&p.command) {
        // Not a builtin: extension, prompt-template and skill commands are known only to the
        // session itself, so accept a name only when the session lists it.
        let known = match (&bridge, e.code.as_str()) {
            (Some(sid), "unsupported") => {
                let name = inject::command_name(&p.command);
                ctx.bridge.commands(sid).await.is_ok_and(|l| l.commands.iter().any(|c| c.name == name))
            }
            _ => false,
        };
        if !known {
            return Err(e);
        }
    }
    if let Some(sid) = bridge {
        ctx.bridge.slash(&sid, p.command.trim()).await.map_err(bridge_err)?;
    } else {
        omp_agent(ctx, &p.agent_id)?;
        inject::slash(ctx, &p.agent_id, &p.command, When::IdleOnly).await?;
    }
    let cmd = p.command.trim_start_matches('/');
    if ["new", "resume", "fork", "collab"].iter().any(|c| cmd.starts_with(c)) {
        ctx.omp.repoll();
    }
    Ok(())
}

/// Extension, prompt-template and skill commands of the session (builtins live in the client).
async fn commands(ctx: &Ctx, agent_id: &str) -> Result<CommandList, ApiError> {
    omp_agent(ctx, agent_id)?;
    let sid = bridge_sid(ctx, agent_id).ok_or_else(|| needs_bridge("Listing custom commands"))?;
    ctx.bridge.commands(&sid).await.map_err(bridge_err)
}

/// Pulls the last queued message back out of the queue so the client can edit or drop it.
/// The queue chips update through the bridge's `queue_update` event.
async fn dequeue(ctx: &Ctx, agent_id: &str) -> Result<Dequeued, ApiError> {
    omp_agent(ctx, agent_id)?;
    let sid = bridge_sid(ctx, agent_id).ok_or_else(|| needs_bridge("Pulling back queued messages"))?;
    ctx.bridge.dequeue(&sid).await.map_err(bridge_err)
}

// ───────────────────────────── herdr ─────────────────────────────

async fn keys(ctx: &Ctx, p: KeysParams) -> Result<(), ApiError> {
    if p.keys.is_empty() || p.keys.len() > 64 {
        return Err(ApiError::new("invalid_params", "send 1–64 keys"));
    }
    let a = agent(ctx, &p.agent_id)?;
    let keys: Vec<&str> = p.keys.iter().map(String::as_str).collect();
    ctx.herdr.agent_send_keys(&a.pane_id, &keys).await.map_err(herdr_err)
}

fn archive(ctx: &Ctx, p: ArchiveParams) -> Result<(), ApiError> {
    agent(ctx, &p.agent_id)?;
    if !ctx.state.set_archived(&p.agent_id, p.archived) {
        return Err(ApiError::new("not_found", format!("no agent `{}`", p.agent_id)));
    }
    Ok(())
}

async fn connect(ctx: &Ctx, agent_id: &str) -> Result<(), ApiError> {
    let a = omp_agent(ctx, agent_id)?;
    if a.omp.as_ref().is_some_and(|o| matches!(o.link, LinkState::Live | LinkState::Connecting)) {
        ctx.omp.repoll();
        return Ok(());
    }
    if !ctx.omp.relay_listening() {
        return Err(ApiError::new("unsupported", format!("the TeleFlock relay is not listening on port {}", ctx.relay_port))
            .with_hint("Another program holds the port; check hostd.log"));
    }
    let cmd = format!("/collab ws://127.0.0.1:{}", ctx.relay_port);
    if let Some(sid) = bridge_sid(ctx, agent_id) {
        ctx.bridge.slash(&sid, &cmd).await.map_err(bridge_err)?;
    } else {
        inject::slash(ctx, agent_id, &cmd, When::IdleOnly).await?;
    }
    ctx.omp.repoll();
    Ok(())
}

async fn stop(ctx: &Ctx, p: StopParams) -> Result<(), ApiError> {
    let a = agent(ctx, &p.agent_id)?;
    match p.mode {
        StopMode::Interrupt => abort(ctx, &p.agent_id).await?,
        StopMode::Exit => {
            if a.kind == "omp" {
                if a.state == HerdrState::Working {
                    abort(ctx, &p.agent_id).await?;
                    wait_idle(ctx, &p.agent_id, Duration::from_secs(10)).await;
                }
                if let Some(sid) = bridge_sid(ctx, &p.agent_id) {
                    ctx.bridge.slash(&sid, "/exit").await.map_err(bridge_err)?;
                } else {
                    inject::slash(ctx, &p.agent_id, "/exit", When::IdleOnly).await?;
                }
            } else {
                ctx.herdr.agent_send_keys(&a.pane_id, &["ctrl+c", "ctrl+c"]).await.map_err(herdr_err)?;
            }
        }
        StopMode::ClosePane => {
            ctx.herdr.pane_close(&a.pane_id).await.map_err(herdr_err)?;
            ctx.state.refresh();
        }
    }
    let how = match p.mode {
        StopMode::Interrupt => "Interrupted",
        StopMode::Exit => "Exited",
        StopMode::ClosePane => "Closed pane of",
    };
    ctx.state.record_activity(&p.agent_id, ActivityKind::Stopped, format!("{how} {}", a.name), None);
    Ok(())
}

async fn wait_idle(ctx: &Ctx, agent_id: &str, max: Duration) {
    let deadline = tokio::time::Instant::now() + max;
    while tokio::time::Instant::now() < deadline {
        if ctx.state.agent(agent_id).is_none_or(|a| a.state != HerdrState::Working) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// herdr agent names: `[a-z][a-z0-9_-]{0,31}`.
pub fn valid_handle(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some('a'..='z'))
        && name.len() <= 32
        && chars.all(|c| matches!(c, 'a'..='z' | '0'..='9' | '_' | '-'))
}

async fn rename_handle(ctx: &Ctx, p: HandleParams) -> Result<(), ApiError> {
    if !valid_handle(&p.name) {
        return Err(ApiError::new("invalid_params", "names are lowercase `[a-z][a-z0-9_-]`, at most 32 chars"));
    }
    let a = agent(ctx, &p.agent_id)?;
    ctx.herdr.agent_rename(&a.pane_id, Some(&p.name)).await.map_err(herdr_err)?;
    ctx.state.refresh();
    Ok(())
}

// ───────────────────────────── launch (§3.7) ─────────────────────────────

/// Derives a unique herdr agent name from a folder or branch.
pub fn derive_handle(seed: &str, taken: &[String]) -> String {
    let mut base: String = seed
        .rsplit(['/', '\\'])
        .find(|s| !s.is_empty())
        .unwrap_or("agent")
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' })
        .collect();
    base = base.trim_matches('-').to_string();
    if !base.starts_with(|c: char| c.is_ascii_lowercase()) {
        base = format!("a-{base}");
    }
    base.truncate(28);
    let base = base.trim_end_matches('-').to_string();
    if !taken.contains(&base) {
        return base;
    }
    (2..1000).map(|n| format!("{base}-{n}")).find(|c| !taken.contains(c)).unwrap_or_else(|| format!("{base}-x"))
}

/// The §3.7 launch recipe: resolves (or creates) the pane, then
/// `herdr agent start <name> --kind omp --pane <pane> -- --config <overlay> -e <ext> …`.
/// Plan mode and the initial prompt are applied once the agent is idle and linked.
pub async fn start_agent(ctx: &Ctx, target: StartTarget, spec: &AgentSpec, resume: Option<&str>) -> Result<Started, ApiError> {
    if let Some(name) = &spec.name {
        if !valid_handle(name) {
            return Err(ApiError::new("invalid_params", "names are lowercase `[a-z][a-z0-9_-]`, at most 32 chars"));
        }
    }
    if let Some(m) = &spec.model {
        check_model(m)?;
    }
    let kind = if spec.kind.trim().is_empty() { "omp".to_string() } else { spec.kind.trim().to_string() };
    let (pane_id, workspace_id, cwd) = resolve_pane(ctx, &target).await?;

    let taken: Vec<String> = ctx.state.snapshot().agents.into_iter().map(|a| a.name).collect();
    let name = match &spec.name {
        Some(n) => n.clone(),
        None => derive_handle(cwd.as_deref().unwrap_or(&kind), &taken),
    };

    let mut args: Vec<String> = Vec::new();
    if kind == "omp" {
        if ctx.paths.overlay.is_file() {
            args.push("--config".into());
            args.push(ctx.paths.overlay.display().to_string());
        } else {
            warn!(path = %ctx.paths.overlay.display(), "collab overlay missing; the agent will not be shared");
        }
        if ctx.paths.ext.is_file() {
            args.push("-e".into());
            args.push(ctx.paths.ext.display().to_string());
        } else {
            warn!(path = %ctx.paths.ext.display(), "bridge extension missing; controls fall back to injection");
        }
        if let Some(m) = &spec.model {
            args.push("--model".into());
            args.push(m.clone());
        }
        if let Some(l) = spec.thinking {
            args.push("--thinking".into());
            args.push(level_str(l).into());
        }
        if let Some(file) = resume {
            args.push(format!("--resume={file}"));
        }
    }
    info!(%name, %kind, pane = %pane_id, ?args, "agent start");
    let started = ctx
        .herdr
        .agent_start(&AgentStart { name: name.clone(), kind: kind.clone(), pane_id: pane_id.clone(), args, timeout_ms: Some(30_000) })
        .await
        .map_err(herdr_err)?;
    let agent_id = build::agent_id(&started.agent);
    ctx.state.refresh();
    ctx.omp.repoll();

    if kind == "omp" && (spec.plan || spec.prompt.as_deref().is_some_and(|p| !p.trim().is_empty())) {
        let ctx = ctx.arc();
        let agent_id = agent_id.clone();
        let plan = spec.plan;
        let prompt = spec.prompt.clone();
        tokio::spawn(async move {
            if let Err(e) = after_launch(&ctx, &agent_id, plan, prompt).await {
                warn!(agent = %agent_id, "post-launch setup failed: {e}");
                ctx.state.record_activity(&agent_id, ActivityKind::Error, "Initial setup failed".into(), Some(e.to_string()));
            }
        });
    }
    let workspace_id = if started.agent.workspace_id.is_empty() { workspace_id } else { started.agent.workspace_id.clone() };
    Ok(Started { agent_id: Some(agent_id), pane_id, workspace_id })
}

/// Waits for idle + `link=live`, then applies plan mode and submits the initial prompt.
async fn after_launch(ctx: &Arc<Ctx>, agent_id: &str, plan: bool, prompt: Option<String>) -> Result<(), ApiError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
    let mut live = false;
    while tokio::time::Instant::now() < deadline {
        if let Some(a) = ctx.state.agent(agent_id) {
            let link = a.omp.as_ref().map(|o| o.link);
            if a.state == HerdrState::Idle || a.state == HerdrState::Done {
                if link == Some(LinkState::Live) {
                    live = true;
                    break;
                }
            }
        }
        ctx.omp.repoll();
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    if plan {
        // Give the bridge a moment to say hello after the link is up.
        for _ in 0..20 {
            if bridge_sid(ctx, agent_id).is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        set_plan(ctx, ToggleParams { agent_id: agent_id.to_string(), on: true }).await?;
    }
    if let Some(text) = prompt.filter(|t| !t.trim().is_empty()) {
        if live {
            guest(ctx, agent_id)?.guest.prompt(text, vec![]).map_err(guest_err)?;
        } else {
            let a = agent(ctx, agent_id)?;
            warn!(agent = %agent_id, "link not live after launch; submitting the prompt through herdr");
            ctx.herdr.agent_prompt(&a.pane_id, &text, None).await.map_err(herdr_err)?;
        }
    }
    Ok(())
}

/// Resolves a start target to an idle shell pane: `(pane, workspace, cwd)`.
async fn resolve_pane(ctx: &Ctx, target: &StartTarget) -> Result<(String, String, Option<String>), ApiError> {
    match target {
        StartTarget::Pane { pane_id } => {
            let p = ctx.herdr.pane_get(pane_id).await.map_err(herdr_err)?;
            if p.agent.is_some() {
                return Err(ApiError::new("busy", format!("pane {pane_id} already runs an agent")));
            }
            let cwd = p.foreground_cwd.clone().or(p.cwd.clone());
            Ok((p.pane_id, p.workspace_id, cwd))
        }
        StartTarget::Workspace { workspace_id, split } => {
            let pane = match split {
                Some(Split::Tab) => {
                    let t = ctx
                        .herdr
                        .tab_create(&TabCreate { workspace_id: Some(workspace_id.clone()), focus: false, ..Default::default() })
                        .await
                        .map_err(herdr_err)?;
                    t.root_pane
                }
                other => {
                    let direction = if matches!(other, Some(Split::Down)) { SplitDirection::Down } else { SplitDirection::Right };
                    ctx.herdr
                        .pane_split(&PaneSplit { workspace_id: Some(workspace_id.clone()), direction, focus: false, ..Default::default() })
                        .await
                        .map_err(herdr_err)?
                }
            };
            let cwd = pane.foreground_cwd.clone().or(pane.cwd.clone());
            Ok((pane.pane_id, pane.workspace_id, cwd))
        }
        StartTarget::Cwd { cwd, label } => {
            let path = crate::paths::expand_tilde(cwd);
            if !path.is_dir() {
                return Err(ApiError::new("not_found", format!("{} is not a folder", path.display())));
            }
            let created = ctx
                .herdr
                .workspace_create(&WorkspaceCreate {
                    cwd: Some(path.display().to_string()),
                    label: label.clone(),
                    focus: false,
                    ..Default::default()
                })
                .await
                .map_err(herdr_err)?;
            Ok((created.root_pane.pane_id, created.workspace.workspace_id, Some(path.display().to_string())))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles() {
        assert!(valid_handle("lab-1"));
        assert!(!valid_handle("Lab"));
        assert!(!valid_handle("1lab"));
        assert!(!valid_handle(&"a".repeat(33)));
        assert_eq!(derive_handle("/tmp/My Repo", &[]), "my-repo");
        assert_eq!(derive_handle("/tmp/core", &["core".into(), "core-2".into()]), "core-3");
        assert_eq!(derive_handle("/tmp/123", &[]), "a-123");
        assert!(valid_handle(&derive_handle("/x/feat/very-long-branch-name-that-keeps-going-on", &[])));
    }

    #[test]
    fn model_format() {
        assert!(check_model("openai-codex/gpt-6-luna").is_ok());
        assert!(check_model("gpt").is_err());
        assert!(check_model("a/ b").is_err());
    }
}
