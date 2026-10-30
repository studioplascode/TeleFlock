//! `agent.*` and `session.*` (architecture §3.4, §3.6, §3.7).
//!
//! Control order per method: the session's data path first where it can do it (prompt/steer,
//! abort, answers, subagents, transcripts): the bridge's data plane for sessions a bridge ≥ 2.0
//! serves, else the collab guest; then the companion bridge's control plane (model, thinking,
//! fast, plan, goal, compact, rename, fork/branch/tree, new session, handoff, export, btw,
//! follow-up queue), then herdr keystroke injection under the §3.6 safety rules.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use tf_herdr::{AgentStart, PaneSplit, SplitDirection, TabCreate, WorkspaceCreate, WorktreeOpen, WorktreeScope, WorktreeTarget};
use tf_proto::methods::*;
use tf_proto::model::{ActivityKind, Agent, HerdrState, LinkState, NeedsKind, OmpMode, ThinkingLevel};
use tf_proto::session::{HistoryPage, SessionSnapshot, TranscriptItem, UserItem};
use tf_proto::term::Split;
use tf_proto::{ApiError, Empty, HostMethod};

use crate::agentcfg::{AgentOmp, Store};
use crate::bridge::BridgeError;
use crate::clients::ClientHandle;
use crate::inject::{self, When};
use crate::omp::{MetaOverlay, OmpSession};
use crate::ops::{herdr_err, to_value, Ctx};
use crate::state::build;
use crate::state::parked::{self, PARK_GRACE};
use crate::state::persist::{ParkedRecord, ParkedWorktree};
use crate::state::subs::Sub;
use crate::util::now_ms;

const DEFAULT_LIMIT: usize = 200;

pub async fn handle(ctx: &Ctx, req: HostMethod, client: &ClientHandle) -> Result<Value, ApiError> {
    use HostMethod as M;
    match req {
        M::SessionOpen(p) => match parked_record(ctx, &p.agent_id) {
            Some(rec) => to_value(parked_snapshot(ctx, rec, p.limit).await?),
            None => to_value(session_open(ctx, p, client)?),
        },
        M::SessionClose(p) => {
            session_close(ctx, &p.agent_id, client);
            to_value(Empty {})
        }
        M::SessionHistory(p) => match parked_record(ctx, &p.agent_id) {
            Some(rec) => to_value(super::search::parked_history(rec.session_file, p, DEFAULT_LIMIT).await?),
            None => to_value(session_history(ctx, p)?),
        },
        M::SessionFind(p) => match parked_record(ctx, &p.agent_id) {
            Some(rec) => to_value(super::search::find_in_file(rec.session_file, p).await?),
            None => {
                let sid = session_id(ctx, &p.agent_id)?;
                let s = ctx.omp.session(&sid).ok_or_else(not_shared)?;
                to_value(super::search::find_in_session(s, p).await?)
            }
        },
        M::SubagentTranscript(p) => to_value(subagent_transcript(ctx, p).await?),
        M::SessionImage(p) => to_value(session_image(ctx, p).await?),
        M::SessionArtifactList(p) => to_value(super::artifact_files::list(ctx, &p.agent_id).await?),
        M::SessionArtifactRead(p) => to_value(super::artifact_files::read(ctx, p).await?),
        M::SessionWriteLocal(p) => to_value(super::artifact_files::write_local(ctx, p).await?),
        M::SessionContextXray(p) => to_value(super::xray::get(ctx, &p.agent_id).await?),

        M::AgentPrompt(p) => unit(prompt(ctx, p, client).await),
        M::AgentAbort(p) => unit(abort(ctx, &p.agent_id).await),
        M::AgentAnswer(p) => unit(answer(ctx, p).await),
        M::AgentSetModel(p) => unit(set_model(ctx, p).await),
        M::AgentSetThinking(p) => unit(set_thinking(ctx, p).await),
        M::AgentGetRoleModels(p) => to_value(super::roles::get(ctx, &p.agent_id).await?),
        M::AgentSetRoleModels(p) => to_value(super::roles::set(ctx, p).await?),
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
        M::AgentBtwCancel(p) => unit(btw_cancel(ctx, p).await),
        M::AgentBtwHistory(p) => to_value(btw_history(ctx, &p.agent_id).await?),
        M::AgentSlash(p) => unit(slash(ctx, p).await),
        M::AgentCommands(p) => to_value(commands(ctx, &p.agent_id).await?),
        M::AgentDequeue(p) => to_value(dequeue(ctx, &p.agent_id).await?),
        M::AgentKeys(p) => unit(keys(ctx, p).await),
        M::AgentSubagent(p) => unit(subagent(ctx, p).await),
        M::AgentArchive(p) => unit(archive(ctx, p).await),
        M::AgentConnect(p) => unit(connect(ctx, &p.agent_id).await),
        M::AgentStart(p) => to_value(start_agent(ctx, p.target, &p.spec, None).await?),
        M::AgentStop(p) => unit(stop(ctx, p).await),
        M::AgentRenameHandle(p) => unit(rename_handle(ctx, p).await),
        M::AgentResume(p) => to_value(resume_parked(ctx, &p.agent_id, None, None, Vec::new()).await?),
        M::AgentSetAutoAnswer(p) => unit(crate::autoanswer::set_agent(ctx, p)),
        M::AgentAutoAnswerCancel(p) => unit(crate::autoanswer::cancel(ctx, p)),
        M::AgentAutoAnswerPostpone(p) => unit(crate::autoanswer::postpone(ctx, p)),
        M::AgentAutoResumeNow(p) => to_value(crate::recovery::resume_now(ctx, &p.agent_id).await?),
        M::AgentAutoResumeCancel(p) => unit(crate::recovery::cancel(ctx, &p.agent_id)),
        M::AgentRetry(p) => to_value(crate::limit_resume::retry(ctx, &p.agent_id, p.subagent_id.as_deref()).await?),
        other => Err(ApiError::new("unknown_method", format!("`{}` is not an agent method", other.name()))),
    }
}

fn unit(r: Result<(), ApiError>) -> Result<Value, ApiError> {
    r.and_then(|()| to_value(Empty {}))
}

// ───────────────────────────── lookups ─────────────────────────────

fn agent(ctx: &Ctx, agent_id: &str) -> Result<Agent, ApiError> {
    let a = ctx.state.agent(agent_id).ok_or_else(|| ApiError::new("not_found", format!("no agent `{agent_id}`")))?;
    if a.parked.is_some() {
        return Err(ApiError::new("parked", format!("{} is done and its pane is closed", a.name)).with_hint("Resume it first"));
    }
    Ok(a)
}

/// The parked record of an agent that is parked on the board right now (a record whose pane is
/// still closing does not count).
fn parked_record(ctx: &Ctx, agent_id: &str) -> Option<ParkedRecord> {
    ctx.state.agent(agent_id).filter(|a| a.parked.is_some())?;
    ctx.state.parked(agent_id)
}

pub(crate) fn omp_agent(ctx: &Ctx, agent_id: &str) -> Result<Agent, ApiError> {
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

/// The live session of an agent (served by its bridge or by a collab guest).
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

/// The bridge session id of an agent, when the companion extension is loaded. Right after a session
/// switch the board's mapping (herdr / collab) can still name the old session while the bridge
/// already said hello for the new one: then the agent's omp process names the current session.
pub(crate) fn bridge_sid(ctx: &Ctx, agent_id: &str) -> Option<String> {
    let sid = ctx.state.omp_session_of(agent_id)?;
    if ctx.bridge.is_connected(&sid) {
        return Some(sid);
    }
    let pid = ctx.state.agent(agent_id)?.omp?.pid?;
    ctx.bridge.by_pid(pid).map(|s| s.session_id)
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
            goal: Some(b.state.goal.clone()),
            data_plane: None,
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
    let mut snap = s.subscribe(client, &p.agent_id, limit, p.have.as_ref());
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
    // A row the session does not have (a client kept it from before tf-hostd restarted): say so,
    // never answer with other rows.
    s.history(Some(&p.cursor), limit).ok_or_else(|| ApiError::new("not_found", format!("row {} is not in the session", p.cursor)))
}

async fn subagent_transcript(ctx: &Ctx, p: SubagentRef) -> Result<HistoryPage, ApiError> {
    guest(ctx, &p.agent_id)?.transcript(&p.subagent_id).await
}

/// Largest image `session.image` sends (its base64 must fit a client line, 64 MiB).
const IMAGE_MAX: u64 = 32 * 1024 * 1024;

/// A transcript image in full: an omp blob (content-addressed store), or an image original
/// (`ImageRef.original`, see [`crate::originals`]; sent with its sniffed mime).
async fn session_image(ctx: &Ctx, p: ImageParams) -> Result<ImageBlob, ApiError> {
    use base64::Engine as _;
    let is_original = p.original.is_some();
    let path = match (p.original, p.blob) {
        (Some(original), _) => {
            let sid = match &p.agent_id {
                // A parked agent's read-only transcript still shows its images.
                Some(agent_id) if original.starts_with("local://") => Some(match parked_record(ctx, agent_id).and_then(|r| r.session_id) {
                    Some(sid) => sid,
                    None => session_id(ctx, agent_id)?,
                }),
                _ => None,
            };
            tokio::task::spawn_blocking(move || crate::originals::resolve(&original, sid.as_deref()))
                .await
                .map_err(|e| ApiError::new("internal", e.to_string()))??
        }
        (None, Some(blob)) if blob.len() == 64 && blob.bytes().all(|c| c.is_ascii_hexdigit()) => {
            crate::ops::host::omp_agent_dir().join("blobs").join(blob.to_ascii_lowercase())
        }
        _ => return Err(ApiError::new("invalid_params", "pass a blob (sha256 hex digest) or an original")),
    };
    let meta = tokio::fs::metadata(&path).await.map_err(|e| crate::ops::fs::io_error(e, &path))?;
    if meta.len() > IMAGE_MAX {
        return Err(ApiError::new("too_large", format!("image is {} MiB", meta.len() >> 20)));
    }
    let bytes = tokio::fs::read(&path).await.map_err(|e| crate::ops::fs::io_error(e, &path))?;
    let mime = crate::originals::sniff_mime(&bytes).map(str::to_owned);
    if mime.is_none() && is_original {
        return Err(ApiError::new("unsupported", format!("{} is not an image", path.display())));
    }
    Ok(ImageBlob { data: base64::engine::general_purpose::STANDARD.encode(bytes), mime })
}

// ───────────────────────────── collab-first ─────────────────────────────

async fn prompt(ctx: &Ctx, p: PromptParams, client: &ClientHandle) -> Result<(), ApiError> {
    if p.text.trim().is_empty() && p.images.is_empty() {
        return Err(ApiError::new("invalid_params", "empty prompt"));
    }
    crate::limit_resume::intervened(ctx, &p.agent_id, "prompted");
    crate::restart::intervened(ctx, &p.agent_id);
    if parked_record(ctx, &p.agent_id).is_some() {
        // Prompting a parked agent resumes it; the launch path submits the prompt once linked.
        info!(agent = %p.agent_id, device = %client.info().device, "prompt resumes a parked agent");
        let text = Some(p.text).filter(|t| !t.trim().is_empty());
        resume_parked(ctx, &p.agent_id, None, text, p.images).await?;
        return Ok(());
    }
    let a = omp_agent(ctx, &p.agent_id)?;
    if a.state == HerdrState::Blocked && a.needs.as_ref().is_some_and(|n| n.answerable) {
        return Err(ApiError::new("agent_blocked", "the agent is waiting for an answer").with_hint("Answer the pending question first"));
    }
    let streaming = a.state == HerdrState::Working;
    info!(agent = %p.agent_id, device = %client.info().device, delivery = ?p.delivery, "prompt");
    // Every device shares one collab guest; tell the replica who sent this prompt.
    let session = ctx.state.omp_session_of(&p.agent_id).and_then(|sid| ctx.omp.session(&sid));
    if let Some(s) = &session {
        s.expect_prompt(&p.text, &client.info().device);
    }
    if p.delivery == Delivery::FollowUp && streaming {
        // The bridge's data plane queues follow-ups with images; the v1 paths take text only.
        if let Some(s) = session.as_ref().filter(|s| s.follow_up_prompts()) {
            s.prompt(&p.text, image_contents(p.images), Delivery::FollowUp).await?;
            s.expect_queued(&p.text, true);
            ctx.state.mark_dirty();
            return Ok(());
        }
        if !p.images.is_empty() {
            return Err(ApiError::new("unsupported", "follow-ups cannot carry images; send it as a steer or after the turn"));
        }
        if let Some(sid) = bridge_sid(ctx, &p.agent_id) {
            ctx.bridge.follow_up(&sid, &p.text).await.map_err(bridge_err)?;
        } else {
            inject::follow_up(ctx, &p.agent_id, &p.text).await?;
        }
        if let Some(s) = &session {
            s.expect_queued(&p.text, true);
        }
        ctx.state.mark_dirty();
        return Ok(());
    }
    match guest(ctx, &p.agent_id) {
        Ok(s) => {
            // omp downscales images it queues (a prompt sent mid-turn) and keeps only that copy:
            // keep the originals here and let the replica link them to the echo.
            let mut images = p.images;
            if !images.is_empty() && (streaming || s.is_streaming()) {
                let dir = crate::originals::dir(&ctx.paths.home);
                let (back, kept) = tokio::task::spawn_blocking(move || {
                    let kept = crate::originals::store(&dir, &images);
                    (images, kept)
                })
                .await
                .map_err(|e| ApiError::new("internal", e.to_string()))?;
                images = back;
                if let Some(kept) = kept {
                    s.expect_originals(&p.text, kept);
                }
            }
            let images = image_contents(images);
            let delivery = if p.delivery == Delivery::FollowUp { Delivery::Auto } else { p.delivery };
            s.prompt(&p.text, images, delivery).await?;
            // omp queues a prompt sent mid-turn as a steer; its TUI band (what the bridge reads)
            // may not show it yet, so list it ourselves until it lands.
            s.expect_queued(&p.text, false);
            ctx.state.mark_dirty();
            Ok(())
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
    crate::limit_resume::intervened(ctx, agent_id, "stopped");
    if a.kind == "omp" {
        if let Ok(s) = guest(ctx, agent_id) {
            return s.abort().await;
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
    s.answer(&p.request_id, &p.answer).await?;
    let label = if p.answer.cancel {
        "Skipped".to_string()
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

async fn subagent(ctx: &Ctx, p: SubagentCmdParams) -> Result<(), ApiError> {
    let s = guest(ctx, &p.agent_id)?;
    let kind = match p.action {
        SubagentAction::Chat => tf_collab::AgentCmdKind::Chat,
        SubagentAction::Kill => tf_collab::AgentCmdKind::Kill,
        SubagentAction::Revive => tf_collab::AgentCmdKind::Revive,
    };
    if p.action == SubagentAction::Chat && p.message.as_deref().is_none_or(|m| m.trim().is_empty()) {
        return Err(ApiError::new("invalid_params", "chat needs a message"));
    }
    s.agent_cmd(kind, &p.subagent_id, p.message).await
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
    crate::limit_resume::intervened(ctx, &p.agent_id, "model changed");
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
    crate::limit_resume::intervened(ctx, agent_id, "new session");
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

/// First bridge whose `btw` is omp's own `/btw` and takes `btwId` follow-ups.
const BTW_FOLLOWUP_BRIDGE: &str = "1.1.0";

async fn btw(ctx: &Ctx, p: BtwParams) -> Result<BtwStarted, ApiError> {
    if p.question.trim().is_empty() {
        return Err(ApiError::new("invalid_params", "empty question"));
    }
    omp_agent(ctx, &p.agent_id)?;
    let sid = bridge_sid(ctx, &p.agent_id).ok_or_else(|| needs_bridge("Side questions"))?;
    // omp loads its bridge once per process: a session started before bridge 1.1.0 keeps the old
    // `btw`, which ignores `btwId` and would open a new hidden side turn instead of following up.
    let followups = |v: &str| tf_proto::version::cmp_semver(v, BTW_FOLLOWUP_BRIDGE).is_some_and(|o| o.is_ge());
    if p.btw_id.is_some() && ctx.bridge.by_session(&sid).is_some_and(|s| !followups(&s.bridge_version)) {
        return Err(ApiError::new("unsupported", "this session's TeleFlock bridge can't follow up on side questions")
            .with_hint("Restart the agent (resume its session) to load the current bridge."));
    }
    let started = ctx.bridge.btw(&sid, &p.question, p.btw_id.as_deref()).await.map_err(bridge_err)?;
    // Every client (other devices too) sees the question at once; bridges before 1.1.0 stream
    // the answer without it.
    if let Some(s) = ctx.omp.session(&sid) {
        s.send_extra(tf_proto::session::SessionEvent::Btw {
            btw_id: started.btw_id.clone(),
            turn: started.turn,
            question: Some(p.question.clone()),
            text: String::new(),
            done: false,
        });
    }
    Ok(started)
}

async fn btw_cancel(ctx: &Ctx, p: BtwRef) -> Result<(), ApiError> {
    omp_agent(ctx, &p.agent_id)?;
    let sid = bridge_sid(ctx, &p.agent_id).ok_or_else(|| needs_bridge("Side questions"))?;
    ctx.bridge.btw_cancel(&sid, &p.btw_id).await.map_err(bridge_err)
}

async fn btw_history(ctx: &Ctx, agent_id: &str) -> Result<BtwHistory, ApiError> {
    omp_agent(ctx, agent_id)?;
    let sid = bridge_sid(ctx, agent_id).ok_or_else(|| needs_bridge("Side questions"))?;
    ctx.bridge.btw_history(&sid).await.map_err(bridge_err)
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
/// The queue chips update through the bridge's `queue_update` event (and the prompts we listed
/// ourselves drop the pulled-back text).
async fn dequeue(ctx: &Ctx, agent_id: &str) -> Result<Dequeued, ApiError> {
    omp_agent(ctx, agent_id)?;
    let sid = bridge_sid(ctx, agent_id).ok_or_else(|| needs_bridge("Pulling back queued messages"))?;
    let out = ctx.bridge.dequeue(&sid).await.map_err(bridge_err)?;
    if let (Some(text), Some(s)) = (&out.text, ctx.omp.session(&sid)) {
        s.forget_queued(text);
        ctx.state.mark_dirty();
    }
    Ok(out)
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

/// `agent.archive`. With `close`, a pending close parks the agent after the undo window
/// ([`PARK_GRACE`]); un-archiving cancels it, and un-archiving a parked agent resumes it.
async fn archive(ctx: &Ctx, p: ArchiveParams) -> Result<(), ApiError> {
    if let Some(rec) = parked_record(ctx, &p.agent_id) {
        if !p.archived {
            resume_parked(ctx, &p.agent_id, None, None, Vec::new()).await?;
        } else if rec.ended.is_some() {
            // Ended without anyone closing it and not brought back: Mark done files it under Done.
            crate::restart::mark_done(ctx, &p.agent_id);
        }
        return Ok(());
    }
    agent(ctx, &p.agent_id)?;
    if !ctx.state.set_archived(&p.agent_id, p.archived) {
        return Err(ApiError::new("not_found", format!("no agent `{}`", p.agent_id)));
    }
    if p.archived {
        crate::limit_resume::intervened(ctx, &p.agent_id, "marked done");
    }
    match (p.archived, p.close) {
        (true, Some(true)) => {
            let (generation, cancel) = ctx.state.schedule_park(&p.agent_id);
            let ctx = ctx.arc();
            let agent_id = p.agent_id;
            tokio::spawn(async move {
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    _ = ctx.cancel.cancelled() => return,
                    _ = tokio::time::sleep(PARK_GRACE) => {}
                }
                if !ctx.state.park_due(&agent_id, generation) {
                    return;
                }
                // The wait stays pending until the close is done: an Undo now still cancels it.
                let res = park(&ctx, &agent_id, &cancel).await;
                ctx.state.finish_park_wait(&agent_id, generation);
                if let Err(e) = res {
                    warn!(agent = %agent_id, "closing a done agent failed: {e}");
                    ctx.state.record_activity(&agent_id, ActivityKind::Error, "Closing the pane failed".into(), Some(e.to_string()));
                }
            });
        }
        (true, Some(false)) => {
            ctx.state.cancel_park(&p.agent_id);
        }
        _ => {}
    }
    Ok(())
}

/// End of the undo window: parks the agent and closes its pane, if it is still archived (not
/// undone: `undo` not cancelled), idle, an omp agent and its session file exists. Otherwise
/// the pane stays open.
async fn park(ctx: &Ctx, agent_id: &str, undo: &CancellationToken) -> Result<(), ApiError> {
    let Some(a) = ctx.state.agent(agent_id).filter(|a| a.parked.is_none()) else { return Ok(()) };
    let Some(file) = parked::parkable(&a).map(str::to_string) else {
        info!(agent = %agent_id, state = ?a.state, archived = a.archived, "done agent not idle (or not omp); keeping its pane");
        return Ok(());
    };
    if !tokio::fs::metadata(&file).await.is_ok_and(|m| m.is_file()) {
        info!(agent = %agent_id, %file, "session file missing; keeping the pane");
        return Ok(());
    }
    let snap = ctx.state.snapshot();
    let ws = snap.workspaces.iter().find(|w| w.id == a.workspace_id);
    let worktree = ws.and_then(|w| {
        let wt = w.worktree.as_ref()?;
        Some(ParkedWorktree { path: wt.path.clone(), repo_root: w.repo.as_ref().map(|r| r.root.clone()).unwrap_or_default() })
    });
    let Some(archived_at) = ctx.state.archived_at(agent_id) else { return Ok(()) };
    let Some(rec) = parked::record_from_agent(&a, archived_at, now_ms(), worktree, ws.map(|w| w.cwd.clone())) else { return Ok(()) };
    if undo.is_cancelled() {
        return Ok(());
    }
    ctx.state.park(rec);
    match parked::close_agent(ctx, &a, Some(undo)).await {
        Ok(true) => {}
        Ok(false) => {
            ctx.state.unpark(agent_id);
            return Ok(());
        }
        Err(e) => {
            ctx.state.unpark(agent_id);
            return Err(herdr_err(e));
        }
    }
    ctx.state.record_activity(agent_id, ActivityKind::Stopped, format!("Closed {} (done)", a.name), Some("Pane closed; resume it from Done".into()));
    Ok(())
}

/// `agent.resume` (also prompting or un-archiving a parked agent, `host.resume` of its session
/// file, and `crate::restart` bringing an ended agent back): `omp --resume=<file>` in a new pane
/// with the parked name, model and thinking level. `target` overrides where (default: its
/// worktree / folder, see [`reopen_target`]).
pub(crate) async fn resume_parked(
    ctx: &Ctx,
    agent_id: &str,
    target: Option<StartTarget>,
    prompt: Option<String>,
    images: Vec<ImageInput>,
) -> Result<Started, ApiError> {
    let Some(rec) = parked_record(ctx, agent_id) else {
        return Err(match ctx.state.agent(agent_id) {
            Some(a) => ApiError::new("invalid_params", format!("{} is not parked; it still has a pane", a.name)),
            None => ApiError::new("not_found", format!("no agent `{agent_id}`")),
        });
    };
    // A move to another host runs (`ops::moves`): it resumes the agent here itself if it fails.
    if let Some(m) = rec.moved.as_ref().filter(|m| m.state == tf_proto::ParkedMoveState::Moving) {
        return Err(ApiError::new("busy", format!("{} is being moved to {}", rec.name, m.to)).retryable());
    }
    let claim = ctx.state.claim_resume(agent_id).ok_or_else(|| {
        ApiError::new("busy", format!("{} is already being resumed", rec.name)).retryable()
    })?;
    let file = rec.session_file.clone();
    // Never a second omp on a session that one still runs (the board may not show it yet; herdr
    // may have been taken down around it): that would fork it.
    if let Some(pid) = crate::restart::still_running(ctx, agent_id, &file, rec.session_id.as_deref()) {
        return Err(ApiError::new("busy", format!("omp already runs this session (pid {pid}); it shows up on the board in a moment")).retryable());
    }
    if crate::restart::is_fileless(&rec) {
        // An agent that ended before omp told its session (no id, no file): nothing to check; its
        // card starts its kept prompt as a new session (Continue), typed input is refused.
        return crate::restart::resume_without_file(ctx, agent_id, claim, target, prompt, images).await;
    }
    let check = {
        let file = file.clone();
        tokio::task::spawn_blocking(move || parked::check_file(Path::new(&file))).await
    };
    match check {
        Ok(parked::FileCheck::Present) => {}
        Ok(parked::FileCheck::Missing) if rec.ended.is_some() => {
            // An ended card keeps its prompts and settings: omp never wrote a file when its first
            // turn was cut off, and that is no deleted session. It starts again as a new session
            // with the prompts it had been given (and what is typed now); a session that was
            // deleted leaves the card for the user to dismiss. Never pruned here.
            return crate::restart::resume_without_file(ctx, agent_id, claim, target, prompt, images).await;
        }
        Ok(parked::FileCheck::Missing) => {
            drop(claim);
            ctx.state.prune_parked(agent_id);
            return Err(ApiError::new("not_found", format!("the omp session file {file} was deleted"))
                .with_hint("Nothing left to resume; the agent was removed from Done"));
        }
        Ok(parked::FileCheck::Unknown(why)) => {
            return Err(ApiError::new("io_error", format!("cannot read the omp session file: {why}"))
                .with_hint("The agent stays in Done; try again once the file is reachable")
                .retryable());
        }
        Err(e) => return Err(ApiError::new("internal", format!("checking the session file: {e}"))),
    }
    let target = match target {
        Some(t) => LaunchPane::Target(t),
        None => reopen_target(ctx, &rec).await?,
    };
    let taken: Vec<String> = ctx.state.snapshot().agents.into_iter().filter(|a| a.parked.is_none()).map(|a| a.name).collect();
    let name = if valid_handle(&rec.name) && !taken.contains(&rec.name) { rec.name.clone() } else { derive_handle(&rec.name, &taken) };
    // The agent's own omp settings (§3.7) come along; the new agent gets its own overlay. The agent
    // ledger keeps copies for an agent whose own stores lost them (`crate::restart`).
    let kept = crate::restart::settings_of(ctx, agent_id);
    let own = Store::new(&ctx.paths).get(&ctx.herdr_session, agent_id).map(|r| r.omp).or_else(|| kept.as_ref().map(|k| k.0.clone())).unwrap_or_default();
    let spec = AgentSpec {
        name: Some(name.clone()),
        kind: "omp".into(),
        model: rec.model.as_ref().map(|m| format!("{}/{}", m.provider, m.id)),
        thinking: rec.thinking,
        plan: false,
        prompt,
        images,
        role_models: own.role_models,
        fallback_chains: own.fallback_chains,
        // Its own decide-for-me policy comes along too.
        auto_answer: crate::autoanswer::own(ctx, agent_id).or_else(|| kept.and_then(|k| k.1)),
    };
    info!(agent = %agent_id, %name, %file, "resuming parked agent");
    let session = SessionArg::Resume(&file);
    let started = start_agent(ctx, target, &spec, Some(session)).await?;
    let new_id = started.agent_id.clone().unwrap_or_default();
    if let Err(e) = Store::new(&ctx.paths).forget(&ctx.herdr_session, agent_id) {
        warn!(agent = %agent_id, "dropping the parked agent's omp settings: {e}");
    }
    crate::autoanswer::forget(ctx, agent_id);
    ctx.state.resumed(claim, &new_id);
    let title = format!("Resumed {name}");
    ctx.state.record_activity_as(&new_id, &name, ActivityKind::Unarchived, title, Some(file));
    Ok(started)
}

/// Where a parked agent reopens: a new tab in its old workspace when that is still open at the
/// same folder; its linked worktree through herdr `worktree.open` (grouped under its repo);
/// else a new workspace at its folder.
async fn reopen_target(ctx: &Ctx, rec: &ParkedRecord) -> Result<LaunchPane, ApiError> {
    let cwd = rec
        .cwd
        .clone()
        .or_else(|| rec.workspace_cwd.clone())
        .ok_or_else(|| ApiError::new("not_found", format!("no folder is known for {}", rec.name)))?;
    let path = crate::paths::expand_tilde(&cwd);
    if !path.is_dir() {
        return Err(ApiError::new("not_found", format!("{} no longer exists", path.display())).with_hint(
            "Its folder or worktree was removed. Recreate it, or resume the session from Sessions in another folder.",
        ));
    }
    if let (Some(ws_id), Some(ws_cwd)) = (&rec.workspace_id, &rec.workspace_cwd) {
        if ctx.state.snapshot().workspaces.iter().any(|w| &w.id == ws_id && &w.cwd == ws_cwd) {
            return Ok(LaunchPane::Target(StartTarget::Workspace { workspace_id: ws_id.clone(), split: Some(Split::Tab) }));
        }
    }
    if let Some((checkout, repo_root)) = linked_worktree(rec, &path).await {
        let open = WorktreeOpen {
            scope: WorktreeScope::Cwd(repo_root),
            target: WorktreeTarget::Path(checkout.clone()),
            label: None,
            focus: false,
            trust_repository: false,
        };
        match ctx.herdr.worktree_open(&open).await {
            Ok(o) => {
                ctx.state.refresh();
                return Ok(match o.root_pane.filter(|_| !o.already_open) {
                    Some(p) => LaunchPane::New(p.pane_id),
                    None => LaunchPane::Target(StartTarget::Workspace { workspace_id: o.workspace.workspace_id, split: Some(Split::Tab) }),
                });
            }
            Err(e) => warn!(%checkout, "worktree open failed ({e}); resuming in a plain workspace"),
        }
    }
    Ok(LaunchPane::Target(StartTarget::Cwd { cwd: path.display().to_string(), label: None }))
}

/// `(checkout, main worktree root)` when the parked agent ran in a linked git worktree: from the
/// record, else asked from git.
async fn linked_worktree(rec: &ParkedRecord, cwd: &Path) -> Option<(String, String)> {
    if let Some(wt) = rec.worktree.as_ref().filter(|w| !w.repo_root.is_empty() && Path::new(&w.path).is_dir()) {
        return Some((wt.path.clone(), wt.repo_root.clone()));
    }
    let args = ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"];
    let out = crate::ops::git::git(cwd, &args, Duration::from_secs(5)).await.ok().filter(|o| o.ok())?;
    let text = out.stdout_str();
    let mut lines = text.lines().map(PathBuf::from);
    let (top, git_dir, common) = (lines.next()?, lines.next()?, lines.next()?);
    if git_dir == common {
        return None;
    }
    let root = if common.file_name().is_some_and(|n| n == ".git") { common.parent()?.to_path_buf() } else { return None };
    Some((top.display().to_string(), root.display().to_string()))
}

/// `session.open` on a parked agent: a read-only snapshot (meta from the parked record, the last
/// rows of its session file mapped like a live replica; `session.history` pages older ones). No
/// subscription.
async fn parked_snapshot(ctx: &Ctx, rec: ParkedRecord, limit: Option<u32>) -> Result<SessionSnapshot, ApiError> {
    let limit = limit.map(|l| l.clamp(1, 2000) as usize).unwrap_or(DEFAULT_LIMIT);
    let (items, has_more, cursor) = match super::search::parked_rows(rec.session_file.clone(), limit).await {
        Ok(rows) => rows,
        Err(e) if e.code == "not_found" => {
            if rec.ended.is_some() {
                // An ended agent's first turn may have been cut off before omp wrote its session
                // file: the prompts the ledger kept stand in for the transcript. The card stays
                // (it holds those prompts for the relaunch); only a dismissal removes it.
                let items = kept_prompt_rows(crate::restart::kept_prompts(ctx, &rec.agent_id), rec.parked_at);
                return Ok(SessionSnapshot { agent_id: rec.agent_id.clone(), meta: parked::parked_meta(&rec), items, has_more: false, cursor: None, ui: None, sync: None });
            }
            let file = rec.session_file.clone();
            let check = tokio::task::spawn_blocking(move || parked::check_file(Path::new(&file))).await.ok();
            if prunable(&rec, check.as_ref()) {
                ctx.state.prune_parked(&rec.agent_id);
            }
            return Err(e);
        }
        Err(e) => return Err(e),
    };
    Ok(SessionSnapshot { agent_id: rec.agent_id.clone(), meta: parked::parked_meta(&rec), items, has_more, cursor, ui: None, sync: None })
}

/// The user rows of the prompts an ended card's agent was given before omp saved its session.
fn kept_prompt_rows(prompts: Vec<String>, at: tf_proto::Millis) -> Vec<TranscriptItem> {
    prompts
        .into_iter()
        .enumerate()
        .map(|(i, text)| TranscriptItem::User(UserItem { id: format!("kept-{i}"), at, text, images: Vec::new(), author: None, steering: false, synthetic: false }))
        .collect()
}

/// A parked card whose session file is missing goes only when the file is certainly gone (its
/// folder is there, `parked::check_file`) and the card is not an ended agent's: that card keeps
/// the prompts and settings its relaunch needs, and only a dismissal removes it.
fn prunable(rec: &ParkedRecord, check: Option<&parked::FileCheck>) -> bool {
    rec.ended.is_none() && matches!(check, Some(parked::FileCheck::Missing))
}

async fn connect(ctx: &Ctx, agent_id: &str) -> Result<(), ApiError> {
    let a = omp_agent(ctx, agent_id)?;
    if let Some(o) = a.omp.as_ref().filter(|o| matches!(o.link, LinkState::Live | LinkState::Connecting)) {
        // Already shared: retry a pending join now (the session view's "Retry now" lands here).
        match o.session_id.as_deref() {
            Some(sid) => ctx.omp.retry_now(sid).await,
            None => ctx.omp.repoll(),
        }
        return Ok(());
    }
    if !ctx.omp.relay_listening() {
        return Err(ApiError::new("unsupported", format!("the TeleFlock relay is not listening on port {}", ctx.relay_port))
            .with_hint("Another program holds the port; check hostd.log"));
    }
    // omp runs builtins such as /collab at once even while the agent streams (they dispatch before
    // the steer path), so sharing never has to wait for the turn to end.
    let cmd = format!("/collab ws://127.0.0.1:{}", ctx.relay_port);
    if let Some(sid) = bridge_sid(ctx, agent_id) {
        ctx.bridge.slash(&sid, &cmd).await.map_err(bridge_err)?;
    } else {
        inject::slash(ctx, agent_id, &cmd, When::AlsoStreaming).await?;
    }
    ctx.omp.repoll();
    Ok(())
}

async fn stop(ctx: &Ctx, p: StopParams) -> Result<(), ApiError> {
    let a = agent(ctx, &p.agent_id)?;
    crate::limit_resume::intervened(ctx, &p.agent_id, "stopped");
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

/// How long the shell of a pane hostd made (new workspace, worktree, tab or split) may take to
/// reach its prompt: heavy startup files on slow machines (WSL laptops) need far more than 2 s.
const NEW_PANE_SHELL_WAIT: Duration = Duration::from_secs(45);
/// How long the shell of an existing pane the client picked may stay busy: it should be idle already.
const PICKED_PANE_SHELL_WAIT: Duration = Duration::from_secs(2);
/// herdr's wait for the launched agent to become interactive (`agent.start` `timeout_ms`, ≤ 300 s).
const INTERACTIVE_TIMEOUT: Duration = Duration::from_secs(90);
/// How long [`after_launch`] waits for the new agent to be idle with a live collab link.
const LINK_WAIT: Duration = Duration::from_secs(90);

/// Where [`start_agent`] launches.
#[derive(Debug)]
pub enum LaunchPane {
    /// A client's target: `StartTarget::Pane` is an existing pane the client picked (a busy shell
    /// fails fast); `Workspace` / `Cwd` make a new pane.
    Target(StartTarget),
    /// The root pane of a workspace or worktree hostd just created (its shell may still be starting).
    New(String),
}

impl From<StartTarget> for LaunchPane {
    fn from(target: StartTarget) -> Self {
        Self::Target(target)
    }
}

impl LaunchPane {
    /// How long herdr's `agent_pane_busy` is retried in the resolved pane.
    fn shell_wait(&self) -> Duration {
        match self {
            Self::Target(StartTarget::Pane { .. }) => PICKED_PANE_SHELL_WAIT,
            _ => NEW_PANE_SHELL_WAIT,
        }
    }
}

/// Maps a failed herdr `agent_start`: a shell still busy once [`LaunchPane::shell_wait`] is over
/// is explained for whose pane it is; anything else goes through [`herdr_err`].
fn launch_err(e: tf_herdr::HerdrError, target: &LaunchPane) -> ApiError {
    if !e.is(tf_herdr::code::AGENT_PANE_BUSY) {
        return herdr_err(e);
    }
    // Hints without a final period: callers append to them (`worktree.create`, automation runs).
    let err = match target {
        LaunchPane::Target(StartTarget::Pane { pane_id }) => {
            ApiError::new("busy", format!("the shell in pane {pane_id} is not at an idle prompt")).with_hint(
                "Something is running in that pane, or its shell is still starting; pick another pane or start the agent in a new tab",
            )
        }
        _ => ApiError::new("busy", format!("the new pane's shell never became ready (waited {} s)", target.shell_wait().as_secs())).with_hint(
            "Slow shell startup files such as ~/.bashrc, ~/.zshrc, ~/.profile or conda/nvm init delay the shell prompt; try again, or make them faster",
        ),
    };
    err.retryable()
}

/// The §3.7 launch recipe: resolves (or creates) the pane, then
/// `herdr agent start <name> --kind omp --pane <pane> -- --config <overlay> [--config <agent overlay>] -e <ext> …`
/// once its shell is at a prompt (`LaunchPane::shell_wait`), giving the agent `INTERACTIVE_TIMEOUT`
/// to come up. Plan mode and the initial prompt are applied once the agent is idle and linked.
pub async fn start_agent(ctx: &Ctx, target: impl Into<LaunchPane>, spec: &AgentSpec, session: Option<SessionArg<'_>>) -> Result<Started, ApiError> {
    let target: LaunchPane = target.into();
    if let Some(name) = &spec.name {
        if !valid_handle(name) {
            return Err(ApiError::new("invalid_params", "names are lowercase `[a-z][a-z0-9_-]`, at most 32 chars"));
        }
    }
    if let Some(m) = &spec.model {
        check_model(m)?;
    }
    let kind = if spec.kind.trim().is_empty() { "omp".to_string() } else { spec.kind.trim().to_string() };
    let own = Some(AgentOmp::of(spec)).filter(|o| kind == "omp" && !o.is_empty());
    if let Some(o) = &own {
        o.validate()?;
    }
    if let Some(p) = spec.auto_answer.as_ref().filter(|_| kind == "omp") {
        p.validate()?;
    }
    let (pane_id, workspace_id, cwd) = resolve_pane(ctx, &target).await?;

    let taken: Vec<String> = ctx.state.snapshot().agents.into_iter().map(|a| a.name).collect();
    let name = match &spec.name {
        Some(n) => n.clone(),
        None => derive_handle(cwd.as_deref().unwrap_or(&kind), &taken),
    };

    let store = Store::new(&ctx.paths);
    let mut launch = None;
    let mut args: Vec<String> = Vec::new();
    if kind == "omp" {
        let overlay = ctx.paths.overlay.is_file().then(|| ctx.paths.overlay.display().to_string());
        if overlay.is_none() {
            warn!(path = %ctx.paths.overlay.display(), "collab overlay missing; the agent will not be shared");
        }
        let ext = ctx.paths.ext.is_file().then(|| ctx.paths.ext.display().to_string());
        if ext.is_none() {
            warn!(path = %ctx.paths.ext.display(), "bridge extension missing; controls fall back to injection");
        }
        if let Some(o) = &own {
            launch = store.prepare(o, &name).map_err(|e| ApiError::new("io_error", format!("writing the agent's omp settings: {e}")))?;
        }
        let agent_overlay = launch.as_ref().map(|l| l.path.display().to_string());
        args = omp_args(spec, overlay.as_deref(), agent_overlay.as_deref(), ext.as_deref(), session);
    }
    // A launch that opens a new omp session records its first prompt and images in the ledger
    // by hostd itself, durably, before any turn can run (images first, as files; the entry as soon
    // as the agent id is known): an agent that ends before omp saved its session keeps what it was
    // given (`crate::restart`). A resume of an existing session records nothing.
    let first_prompt = if records_first_prompt(&kind, session) {
        let at = crate::restart::LaunchAt { name: name.clone(), pane_id: pane_id.clone(), workspace_id: workspace_id.clone(), cwd: cwd.clone() };
        crate::restart::keep_first_prompt(ctx, spec, at).await
    } else {
        None
    };
    info!(%name, %kind, pane = %pane_id, ?args, "agent start");
    let start = AgentStart { name: name.clone(), kind: kind.clone(), pane_id: pane_id.clone(), args, timeout_ms: Some(INTERACTIVE_TIMEOUT.as_millis() as u64) };
    let started = match ctx.herdr.agent_start(&start, target.shell_wait()).await {
        Ok(s) => s,
        Err(e) => {
            // herdr gave up waiting for it to be ready (busy at once, slow): it may run anyway,
            // and herdr dropped its name then (`crate::restart::launch`).
            let adopted = if e.is(tf_herdr::code::TIMEOUT) {
                crate::restart::launch::after_timeout(&ctx.herdr, &pane_id, &name, &kind, crate::restart::launch::ADOPT_WAIT).await
            } else {
                None
            };
            match adopted {
                Some(agent) => tf_herdr::AgentStarted { agent, argv: Vec::new() },
                None => {
                    if let Some(l) = launch {
                        store.discard(l);
                    }
                    return Err(launch_err(e, &target));
                }
            }
        }
    };
    let agent_id = build::agent_id(&started.agent);
    if let Some(o) = &own
        && let Err(e) = store.bind(&ctx.herdr_session, &agent_id, launch.as_ref(), o, now_ms())
    {
        warn!(agent = %agent_id, "recording the agent's omp settings: {e}");
    }
    if let Some(p) = spec.auto_answer.as_ref().filter(|_| kind == "omp") {
        crate::autoanswer::bind(ctx, &agent_id, p);
    }
    if let Some(k) = first_prompt {
        crate::restart::record_first_prompt(ctx, &agent_id, k);
    }
    ctx.state.refresh();
    ctx.omp.repoll();

    if kind == "omp" && needs_after_launch(spec) {
        let ctx = ctx.arc();
        let agent_id = agent_id.clone();
        let plan = spec.plan;
        let prompt = spec.prompt.clone();
        let images = spec.images.clone();
        tokio::spawn(async move {
            if let Err(e) = after_launch(&ctx, &agent_id, plan, prompt, images).await {
                warn!(agent = %agent_id, "post-launch setup failed: {e}");
                ctx.state.record_activity(&agent_id, ActivityKind::Error, "Initial setup failed".into(), Some(e.to_string()));
            }
        });
    }
    let workspace_id = if started.agent.workspace_id.is_empty() { workspace_id } else { started.agent.workspace_id.clone() };
    Ok(Started { agent_id: Some(agent_id), pane_id, workspace_id })
}

/// The omp session a launch opens: `--resume=<file>`. Never `--restore`: omp's restore runs a
/// cut-off tool call again verbatim; only `crate::restart` decides what may go on, through the
/// bridge once the agent is back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionArg<'a> {
    Resume(&'a str),
}

impl SessionArg<'_> {
    pub fn flag(self) -> String {
        match self {
            Self::Resume(file) => format!("--resume={file}"),
        }
    }
}

/// omp's arguments in the §3.7 recipe: TeleFlock's overlay, then the agent's own (its model roles
/// and fallback chains, merged over the host's config), the bridge, `--model` / `--thinking`
/// unless the agent's roles set `default` (omp applies `--model` as a runtime `default` override
/// above every config file, so `roleModels.default` wins by leaving them out), the session flag.
/// Also the resume command hostd reports to herdr (`crate::restart`, model and thinking left out).
pub(crate) fn omp_args(spec: &AgentSpec, overlay: Option<&str>, agent_overlay: Option<&str>, ext: Option<&str>, session: Option<SessionArg<'_>>) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    for file in [overlay, agent_overlay].into_iter().flatten() {
        args.push("--config".into());
        args.push(file.into());
    }
    if let Some(ext) = ext {
        args.push("-e".into());
        args.push(ext.into());
    }
    if !spec.role_models.contains_key("default") {
        if let Some(m) = &spec.model {
            args.push("--model".into());
            args.push(m.clone());
        }
        if let Some(l) = spec.thinking {
            args.push("--thinking".into());
            args.push(level_str(l).into());
        }
    }
    if let Some(session) = session {
        args.push(session.flag());
    }
    args
}

/// Only a launch that opens a NEW omp session records its first prompt in the ledger (and gates the
/// observer, and moves an earlier agent's entry under the id aside): a `--resume` of an existing
/// session is the same agent under a new id, and its entry follows it with its history.
fn records_first_prompt(kind: &str, session: Option<SessionArg<'_>>) -> bool {
    kind == "omp" && session.is_none()
}

/// Plan mode, a prompt or images to hand over once the agent is up.
fn needs_after_launch(spec: &AgentSpec) -> bool {
    spec.plan || spec.prompt.as_deref().is_some_and(|p| !p.trim().is_empty()) || !spec.images.is_empty()
}

/// Prompt images as collab image content (`agent.prompt` and the first prompt of a launch).
fn image_contents(images: Vec<ImageInput>) -> Vec<tf_collab::ImageContent> {
    images.into_iter().map(|i| tf_collab::ImageContent { kind: "image".into(), data: i.data, mime_type: i.mime }).collect()
}

/// Waits for idle + `link=live`, then applies plan mode and submits the initial prompt with its
/// images. Without a live link the text still goes in through herdr, but images cannot (herdr
/// only types text): that is reported as a failure instead of dropping them silently.
async fn after_launch(ctx: &Arc<Ctx>, agent_id: &str, plan: bool, prompt: Option<String>, images: Vec<ImageInput>) -> Result<(), ApiError> {
    let deadline = tokio::time::Instant::now() + LINK_WAIT;
    let mut live = false;
    let mut tick = 0u32;
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
        // The state is checked every 250 ms; a registry poll queries every omp process over IPC,
        // which loads exactly the slow hosts this wait is long for, so ask for one per second.
        if tick.is_multiple_of(4) {
            ctx.omp.repoll();
        }
        tick += 1;
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
    let text = prompt.filter(|t| !t.trim().is_empty());
    if text.is_none() && images.is_empty() {
        return Ok(());
    }
    if live {
        guest(ctx, agent_id)?.prompt(&text.unwrap_or_default(), image_contents(images), Delivery::Auto).await?;
        return Ok(());
    }
    if let Some(text) = &text {
        let a = agent(ctx, agent_id)?;
        warn!(agent = %agent_id, "link not live after launch; submitting the prompt through herdr");
        ctx.herdr.agent_prompt(&a.pane_id, text, None).await.map_err(herdr_err)?;
    }
    if images.is_empty() {
        return Ok(());
    }
    warn!(agent = %agent_id, count = images.len(), "link not live after launch; images not delivered");
    let (title, detail) = undelivered_images(images.len(), text.is_some());
    ctx.state.record_activity(agent_id, ActivityKind::Error, title, Some(detail));
    Ok(())
}

/// Activity `(title, detail)` for first-prompt images that could not be handed over (omp's
/// collab link never came up; herdr can only type text).
fn undelivered_images(count: usize, text_sent: bool) -> (String, String) {
    let title = if count == 1 { "Image not delivered".to_string() } else { format!("{count} images not delivered") };
    let sent = if text_sent { " The task text was sent without them." } else { "" };
    (title, format!("The agent's collab link never came up, so the first prompt's images could not be attached.{sent} Attach them again from the session once the agent is live."))
}

/// Resolves a launch target to an idle shell pane: `(pane, workspace, cwd)`. An existing pane
/// (picked, or one hostd just created) must not run an agent already.
async fn resolve_pane(ctx: &Ctx, target: &LaunchPane) -> Result<(String, String, Option<String>), ApiError> {
    match target {
        LaunchPane::New(pane_id) | LaunchPane::Target(StartTarget::Pane { pane_id }) => {
            let p = ctx.herdr.pane_get(pane_id).await.map_err(herdr_err)?;
            if p.agent.is_some() {
                return Err(ApiError::new("busy", format!("pane {pane_id} already runs an agent")));
            }
            let cwd = p.foreground_cwd.clone().or(p.cwd.clone());
            Ok((p.pane_id, p.workspace_id, cwd))
        }
        LaunchPane::Target(StartTarget::Workspace { workspace_id, split }) => {
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
        LaunchPane::Target(StartTarget::Cwd { cwd, label }) => {
            let (pane, workspace, cwd) = open_workspace(ctx, cwd, label.clone()).await?;
            Ok((pane, workspace, Some(cwd)))
        }
    }
}

/// A new (unfocused) workspace at `cwd`: `(root pane, workspace, cwd)`.
pub(crate) async fn open_workspace(ctx: &Ctx, cwd: &str, label: Option<String>) -> Result<(String, String, String), ApiError> {
    let path = crate::paths::expand_tilde(cwd);
    if !path.is_dir() {
        return Err(ApiError::new("not_found", format!("{} is not a folder", path.display())));
    }
    let created = ctx
        .herdr
        .workspace_create(&WorkspaceCreate { cwd: Some(path.display().to_string()), label, focus: false, ..Default::default() })
        .await
        .map_err(herdr_err)?;
    Ok((created.root_pane.pane_id, created.workspace.workspace_id, path.display().to_string()))
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

    #[test]
    fn an_ended_card_is_never_pruned_for_a_missing_session_file() {
        use crate::state::parked::FileCheck;
        let done = ParkedRecord { agent_id: "t1".into(), session_file: "/s/a.jsonl".into(), ..Default::default() };
        let ended = ParkedRecord {
            ended: Some(tf_proto::autoresume::AgentEnded {
                at: 1,
                cause: tf_proto::autoresume::EndCause::HerdrCrashed,
                reason: "herdr crashed".into(),
                turn: tf_proto::autoresume::EndedTurn::Working,
                last_action: None,
            }),
            ..done.clone()
        };
        // A Done card whose file is certainly gone goes; no verdict (unmounted home) keeps it.
        assert!(prunable(&done, Some(&FileCheck::Missing)));
        assert!(!prunable(&done, Some(&FileCheck::Unknown("empty (unmounted?)".into()))));
        assert!(!prunable(&done, None));
        // An agent that ended in its first turn has no file, and its card holds the prompts the
        // relaunch gives again: never.
        assert!(!prunable(&ended, Some(&FileCheck::Missing)));
    }

    #[test]
    fn the_ledgers_prompts_stand_in_for_the_transcript_of_a_card_without_a_file() {
        let rows = kept_prompt_rows(vec!["fix the build".into(), "and run the tests".into()], 42);
        let texts: Vec<(&str, String, i64)> = rows
            .iter()
            .map(|r| match r {
                TranscriptItem::User(u) => (u.id.as_str(), u.text.clone(), u.at),
                other => panic!("not a user row: {other:?}"),
            })
            .collect();
        assert_eq!(texts, vec![("kept-0", "fix the build".to_string(), 42), ("kept-1", "and run the tests".to_string(), 42)]);
        assert!(kept_prompt_rows(Vec::new(), 1).is_empty(), "nothing kept: an empty transcript, not an error");
    }

    fn spec(prompt: Option<&str>, images: usize, plan: bool) -> AgentSpec {
        AgentSpec {
            name: None,
            kind: "omp".into(),
            model: None,
            thinking: None,
            plan,
            prompt: prompt.map(str::to_string),
            images: (0..images).map(|i| ImageInput { mime: "image/png".into(), data: format!("AAA{i}") }).collect(),
            role_models: Default::default(),
            fallback_chains: Default::default(),
            auto_answer: None,
        }
    }

    #[test]
    fn launch_args_and_role_precedence() {
        let mut s = spec(None, 0, false);
        s.model = Some("openai/gpt-5".into());
        s.thinking = Some(ThinkingLevel::High);
        let args = |s: &AgentSpec, own: Option<&str>| omp_args(s, Some("/h/omp-overlay.yml"), own, Some("/h/ext/b.ts"), Some(SessionArg::Resume("/s/x.jsonl")));
        // Without own settings: today's recipe.
        assert_eq!(
            args(&s, None),
            ["--config", "/h/omp-overlay.yml", "-e", "/h/ext/b.ts", "--model", "openai/gpt-5", "--thinking", "high", "--resume=/s/x.jsonl"]
        );
        // The agent's overlay comes right after TeleFlock's (omp merges later files over earlier).
        s.role_models.insert("smol".into(), "openai/gpt-5-mini:low".into());
        assert_eq!(
            args(&s, Some("/h/agent-config/ab.yml")),
            ["--config", "/h/omp-overlay.yml", "--config", "/h/agent-config/ab.yml", "-e", "/h/ext/b.ts", "--model", "openai/gpt-5", "--thinking", "high", "--resume=/s/x.jsonl"]
        );
        // `roleModels.default` is the main model: no --model / --thinking to override it.
        s.role_models.insert("default".into(), "anthropic/claude-opus-5:max".into());
        assert_eq!(
            args(&s, Some("/h/agent-config/ab.yml")),
            ["--config", "/h/omp-overlay.yml", "--config", "/h/agent-config/ab.yml", "-e", "/h/ext/b.ts", "--resume=/s/x.jsonl"]
        );
        // Nothing deployed yet: only what exists.
        assert_eq!(omp_args(&spec(None, 0, false), None, None, None, None), Vec::<String>::new());
        // The session flag goes last.
        assert_eq!(
            omp_args(&spec(None, 0, false), Some("/h/omp-overlay.yml"), None, Some("/h/ext/b.ts"), Some(SessionArg::Resume("/s/x.jsonl"))),
            ["--config", "/h/omp-overlay.yml", "-e", "/h/ext/b.ts", "--resume=/s/x.jsonl"]
        );
    }

    #[test]
    fn only_a_launch_that_starts_a_new_omp_session_records_a_first_prompt() {
        // New agent, Dispatch, automations, an ended fileless card's Continue: a new session.
        assert!(records_first_prompt("omp", None));
        // A resume of an existing session (herdr's/TeleFlock's relaunch, host.resume, a move's
        // receive, resume_parked) never records, never gates the observer, never moves an entry
        // aside: the ledger follows the session to the new agent id (`ends`, end record, plan).
        assert!(!records_first_prompt("omp", Some(SessionArg::Resume("/s/a.jsonl"))));
        assert!(!records_first_prompt("claude", None), "only omp agents have a ledger entry");
    }

    #[test]
    fn first_prompt_trigger() {
        assert!(!needs_after_launch(&spec(None, 0, false)));
        assert!(!needs_after_launch(&spec(Some("  "), 0, false)));
        assert!(needs_after_launch(&spec(Some("fix it"), 0, false)));
        assert!(needs_after_launch(&spec(None, 0, true)));
        // Image-only first prompts are delivered too.
        assert!(needs_after_launch(&spec(None, 1, false)));
        assert!(needs_after_launch(&spec(Some(""), 2, false)));
    }

    #[test]
    fn images_become_collab_image_content() {
        let out = image_contents(spec(None, 2, false).images);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].kind, "image");
        assert_eq!(out[0].mime_type, "image/png");
        assert_eq!(out[1].data, "AAA1");
        let wire = serde_json::to_value(&out[0]).unwrap();
        assert_eq!(wire, serde_json::json!({ "type": "image", "data": "AAA0", "mimeType": "image/png" }));
    }

    #[test]
    fn undelivered_images_are_explained() {
        // Ordinary launches (New agent, Dispatch, automations): exactly as in 0.6.1.
        let (title, detail) = undelivered_images(1, true);
        assert_eq!(title, "Image not delivered");
        assert!(detail.contains("text was sent without them"));
        let (title, detail) = undelivered_images(3, false);
        assert_eq!(title, "3 images not delivered");
        assert!(!detail.contains("text was sent"));
    }

    #[test]
    fn busy_shell_is_explained_for_whose_pane_it_is() {
        let busy = || tf_herdr::HerdrError::new(tf_herdr::code::AGENT_PANE_BUSY, "agent target pane w1:p2 is not an available shell");
        // A pane the client picked: its shell should be idle already.
        let picked = LaunchPane::from(StartTarget::Pane { pane_id: "w1:p2".into() });
        assert_eq!(picked.shell_wait(), PICKED_PANE_SHELL_WAIT);
        let e = launch_err(busy(), &picked);
        assert_eq!((e.code.as_str(), e.retryable), ("busy", true));
        assert_eq!(e.message, "the shell in pane w1:p2 is not at an idle prompt");
        assert!(e.hint.as_deref().is_some_and(|h| h.contains("pick another pane")));
        // Panes hostd makes or just made: a long wait, then the shell's startup files are the suspect.
        for created in [
            LaunchPane::New("w3:p1".into()),
            StartTarget::Cwd { cwd: "/tmp".into(), label: None }.into(),
            StartTarget::Workspace { workspace_id: "w1".into(), split: Some(Split::Tab) }.into(),
            StartTarget::Workspace { workspace_id: "w1".into(), split: None }.into(),
        ] {
            assert_eq!(created.shell_wait(), NEW_PANE_SHELL_WAIT, "{created:?}");
            let e = launch_err(busy(), &created);
            assert_eq!((e.code.as_str(), e.retryable), ("busy", true));
            assert_eq!(e.message, "the new pane's shell never became ready (waited 45 s)");
            assert!(e.hint.as_deref().is_some_and(|h| h.contains("~/.bashrc")));
        }
        // Other launch failures keep herdr's error.
        let e = launch_err(tf_herdr::HerdrError::new(tf_herdr::code::AGENT_START_FAILED, "agent process exited before becoming interactive"), &picked);
        assert_eq!(e.code, "herdr_error");
        let e = launch_err(tf_herdr::HerdrError::new(tf_herdr::code::TIMEOUT, "agent a did not become interactive in time"), &picked);
        assert_eq!((e.code.as_str(), e.retryable), ("timeout", true));
    }
}
