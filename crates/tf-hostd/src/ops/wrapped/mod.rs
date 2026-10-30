//! `host.wrapped` (architecture §3.19): one host's share of the app's weekly Flock Wrapped card.
//!
//! - Agents, work time, busy stretches, model speeds and subagents come from `host.usage`'s
//!   report over the window ([`crate::ops::usage::usage_report`]: omp's stats index, which a
//!   stale request syncs in the background; the answer carries the index state, and never waits).
//! - Automation runs come from the scheduler's history (its last 100 runs).
//! - Commits and merged pull requests come from git and the GitHub CLI, in the repositories the
//!   agents worked in ([`code`]): gathered in the background and cached, so an answer waits for
//!   them a few seconds at most and says `pending` otherwise.
//!
//! The app adds the hosts' answers up and picks the awards; nothing here knows its time zone.

mod code;
#[cfg(test)]
mod tests;

use std::path::PathBuf;

use serde_json::Value;
use tf_proto::{
    ApiError, AutomationRun, AutomationRunStatus, Millis, UsageInsights, UsageKeyStat, UsageModelStat, UsageParams, UsageView, WrappedModel,
    WrappedParams, WrappedReport, WrappedSubagent,
};
use tracing::warn;

use crate::ops::{to_value, Ctx};
use crate::util::now_ms;

/// Subagents sent, most requests first.
const CREW: usize = 12;

pub async fn handle(ctx: &Ctx, p: WrappedParams) -> Result<Value, ApiError> {
    to_value(report(ctx, p).await?)
}

async fn report(ctx: &Ctx, p: WrappedParams) -> Result<WrappedReport, ApiError> {
    let now = now_ms();
    if p.since <= 0 || p.since >= now {
        return Err(ApiError::new("invalid_params", "host.wrapped: `since` must be an instant in the past"));
    }
    let until = window_end(p.since, p.until, now);
    let params = UsageParams {
        days: 0,
        view: Some(UsageView::Insights),
        since: Some(p.since),
        until: p.until,
        hour_offset: p.hour_offset,
        refresh: None,
        have: None,
    };
    // A stats index that cannot be read leaves those figures empty; git and GitHub still count.
    let (index, insights) = match crate::ops::usage::usage_report(ctx, params).await {
        Ok(r) => (r.index, r.insights),
        Err(e) => {
            warn!("wrapped: usage report failed: {e}");
            (None, None)
        }
    };
    let mut out = WrappedReport {
        since: p.since,
        until,
        index,
        agents: 0,
        subagents: 0,
        automation_runs: 0,
        work_ms: 0,
        busy: vec![],
        models: vec![],
        crew: vec![],
        code: None,
        prs: None,
        prs_note: None,
        pending: None,
    };
    if let Some(ins) = &insights {
        fill_from_insights(&mut out, ins);
    }
    let automations = crate::automations::get().map(|a| a.list(&ctx.herdr_session));
    if let Some(list) = &automations {
        out.automation_runs = count_runs(&list.runs, p.since, until);
    }
    let mut dirs: Vec<Option<String>> = vec![];
    if let Some(ins) = &insights {
        dirs.extend(ins.projects.iter().map(|p| p.cwd.clone()));
        dirs.extend(ins.sessions.iter().map(|s| s.cwd.clone()));
    }
    dirs.extend(ctx.state.snapshot().agents.into_iter().map(|a| a.cwd));
    if let Some(list) = automations {
        dirs.extend(list.automations.into_iter().map(|a| Some(a.cwd)));
    }
    let key = code::Key { session: ctx.herdr_session.clone(), since: p.since, until: p.until };
    match code::facts(key, work_dirs(dirs), p.refresh == Some(true), ctx.cancel.clone()).await {
        Some(f) => {
            out.code = Some(f.code.clone());
            out.prs = f.prs.clone();
            out.prs_note = f.prs_note.clone();
        }
        None => out.pending = Some(true),
    }
    Ok(out)
}

/// The window's end: `until` when it is after `since`, never past `now` (absent = now).
pub(super) fn window_end(since: Millis, until: Option<Millis>, now: Millis) -> Millis {
    until.filter(|u| *u > since).map_or(now, |u| u.min(now))
}

/// The figures that come from the usage report.
fn fill_from_insights(out: &mut WrappedReport, ins: &UsageInsights) {
    out.agents = ins.session_count;
    out.subagents = ins.subagent_count;
    out.work_ms = ins.work.agent_ms;
    out.busy = ins.work.stretches.clone();
    out.models = models_from(&ins.models);
    out.crew = crew_from(&ins.subagents);
}

/// Models whose requests have an output rate.
pub(super) fn models_from(models: &[UsageModelStat]) -> Vec<WrappedModel> {
    models
        .iter()
        .filter(|m| m.stat.tps_n > 0)
        .map(|m| WrappedModel { provider: m.provider.clone(), model: m.model.clone(), requests: m.stat.requests, tps: m.stat.tps, tps_n: m.stat.tps_n })
        .collect()
}

/// Subagents by name, most requests first (`key: ""` folds the ones past the report's top list:
/// not one subagent).
pub(super) fn crew_from(subagents: &[UsageKeyStat]) -> Vec<WrappedSubagent> {
    let mut crew: Vec<WrappedSubagent> = subagents
        .iter()
        .filter(|k| !k.key.is_empty())
        .map(|k| WrappedSubagent { name: k.key.clone(), requests: k.stat.requests, tokens: k.stat.tokens, output: k.stat.output, cost_usd: k.stat.cost_usd })
        .collect();
    crew.sort_by(|a, b| b.requests.cmp(&a.requests).then(b.output.cmp(&a.output)).then(a.name.cmp(&b.name)));
    crew.truncate(CREW);
    crew
}

/// Runs that started an agent within `since..until`.
pub(super) fn count_runs(runs: &[AutomationRun], since: Millis, until: Millis) -> u32 {
    runs.iter().filter(|r| r.status == AutomationRunStatus::Started && r.at >= since && r.at < until).count() as u32
}

/// Folders the agents worked in, each once, in the order given (most active first).
pub(super) fn work_dirs(dirs: Vec<Option<String>>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for d in dirs.into_iter().flatten() {
        let p = PathBuf::from(d.trim());
        if p.is_absolute() && !out.contains(&p) {
            out.push(p);
        }
    }
    out
}
