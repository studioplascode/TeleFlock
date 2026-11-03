//! `session.digest` (architecture §3.8, "Name it again"): what an omp session is about as a whole,
//! bounded for omp's tiny model, which names the agent from it. A session tf-hostd holds a copy of
//! is read from that copy (every row since the session started, its todo list and subagent roster)
//! under one lock on the blocking pool; any other from its session file (`crate::find::files`: the
//! rows a copy would rebuild, the todo list of the newest `todo` call, the subagents of the `task`
//! calls). The app composes the model's prompt from the digest.

use std::path::Path;

use serde_json::Value;
use tf_proto::session::{DigestPrompt, DigestSubagent, SessionDigest, SessionMeta, SubagentStatus, TodoPhase, TodoTask, ToolItem, ToolStatus, ToolView, TranscriptItem};
use tf_proto::{ApiError, Millis};

use crate::ops::agent::omp_agent;
use crate::ops::fs::io_error;
use crate::ops::Ctx;
use crate::util::clip;

/// The first prompt (the original objective) and the newest: up to this many chars each.
const PROMPT_MAX: usize = 4_000;
/// Each prompt between them: up to this many chars, on one line.
const BETWEEN_MAX: usize = 400;
/// Prompts between the first and the newest sent at most, spread over the session.
const BETWEEN_COUNT: usize = 40;
/// A prompt with fewer words ("yes", "go on") is left out first when not all fit.
const SUBSTANTIVE_WORDS: usize = 4;
/// The newest compaction summaries, up to [`SUMMARY_MAX`] chars each.
const SUMMARIES: usize = 3;
const SUMMARY_MAX: usize = 2_000;
const PHASES: usize = 12;
const PHASE_ITEMS: usize = 20;
const ITEM_MAX: usize = 120;
/// Subagents: the first ones and the newest, when there are more than both together.
const SUBAGENTS_FIRST: usize = 8;
const SUBAGENTS_NEWEST: usize = 32;
const NAME_MAX: usize = 64;
const TASK_MAX: usize = 160;

pub async fn get(ctx: &Ctx, agent_id: &str) -> Result<SessionDigest, ApiError> {
    let agent = omp_agent(ctx, agent_id)?;
    let session = ctx.state.omp_session_of(agent_id).and_then(|sid| ctx.omp.session(&sid));
    let file = agent.omp.and_then(|o| o.session_file);
    tokio::task::spawn_blocking(move || {
        if let Some(s) = session {
            let st = s.lock();
            if !st.replica.is_empty() {
                return Ok(build(st.replica.rows(), Some(st.replica.meta())));
            }
        }
        let file = file.ok_or_else(|| ApiError::new("not_connected", "this omp session is not known to TeleFlock yet").retryable())?;
        let path = Path::new(&file);
        let rows = crate::find::files::rows(path).map_err(|e| io_error(e, path))?;
        Ok(build(rows.iter(), None))
    })
    .await
    .map_err(|e| ApiError::new("internal", e.to_string()))?
}

/// The digest of a session's rows (oldest first) and, from a copy of the session, its meta: the
/// todo list with the user's own edits, the subagent roster. Without meta: the todo list of the
/// newest `todo` call, the subagents of the `task` calls.
pub(crate) fn build<'a>(rows: impl IntoIterator<Item = &'a TranscriptItem>, meta: Option<&SessionMeta>) -> SessionDigest {
    let (mut prompts, mut summaries, mut todo_call, mut task_calls) = (Vec::new(), Vec::new(), None, Vec::new());
    for row in rows {
        match row {
            TranscriptItem::User(u) if !u.synthetic && !u.text.trim().is_empty() => prompts.push(u.text.trim()),
            TranscriptItem::Compaction(c) if !c.summary.trim().is_empty() => summaries.push(c.summary.trim()),
            TranscriptItem::Tool(t) => match &t.view {
                Some(ToolView::Todo(v)) => todo_call = Some(v.phases.as_slice()),
                _ if t.tool == "task" => task_calls.push(t),
                _ => {}
            },
            _ => {}
        }
    }
    let todos = meta.map_or(todo_call.unwrap_or_default(), |m| m.todos.as_slice());
    let subagents = match meta.map(|m| m.subagents.as_slice()).filter(|r| !r.is_empty()) {
        Some(roster) => {
            let mut roster: Vec<_> = roster.iter().collect();
            roster.sort_by_key(|s| s.started_at.unwrap_or(Millis::MAX));
            roster
                .into_iter()
                .map(|s| DigestSubagent {
                    name: clip(if s.name.trim().is_empty() { &s.id } else { &s.name }, NAME_MAX),
                    task: s.description.as_deref().and_then(gist),
                    running: s.status == SubagentStatus::Running,
                })
                .collect()
        }
        None => once_each(task_calls.into_iter().flat_map(task_subagents)),
    };
    let subagent_count = subagents.len() as u32;
    let subagents = if subagents.len() <= SUBAGENTS_FIRST + SUBAGENTS_NEWEST {
        subagents
    } else {
        let newest = subagents.len() - SUBAGENTS_NEWEST;
        subagents.into_iter().enumerate().filter(|(i, _)| *i < SUBAGENTS_FIRST || *i >= newest).map(|(_, s)| s).collect()
    };
    SessionDigest {
        prompt_count: prompts.len() as u32,
        prompts: pick_prompts(&prompts),
        summaries: summaries[summaries.len().saturating_sub(SUMMARIES)..].iter().map(|s| cut(s, SUMMARY_MAX)).collect(),
        todos: todos
            .iter()
            .take(PHASES)
            .map(|p| TodoPhase {
                name: clip(&p.name, ITEM_MAX),
                tasks: p
                    .tasks
                    .iter()
                    .take(PHASE_ITEMS)
                    .map(|t| TodoTask { content: clip(&t.content, ITEM_MAX), status: t.status, blocker: t.blocker.as_deref().map(|b| clip(b, ITEM_MAX)) })
                    .collect(),
            })
            .collect(),
        subagents,
        subagent_count,
    }
}

/// The first prompt and the newest up to [`PROMPT_MAX`] chars; the ones between up to
/// [`BETWEEN_MAX`] on one line, at most [`BETWEEN_COUNT`] of them: the substantive ones first,
/// each group spread evenly over the session.
fn pick_prompts(all: &[&str]) -> Vec<DigestPrompt> {
    let whole = |i: usize| DigestPrompt { n: i as u32 + 1, text: cut(all[i], PROMPT_MAX) };
    let between_one = |i: usize| DigestPrompt { n: i as u32 + 1, text: cut(&squash(all[i]), BETWEEN_MAX) };
    let n = all.len();
    if n == 0 {
        return Vec::new();
    }
    let between: Vec<usize> = (1..n.saturating_sub(1)).collect();
    let keep = if between.len() <= BETWEEN_COUNT {
        between
    } else {
        let (substantive, short): (Vec<usize>, Vec<usize>) = between.into_iter().partition(|&i| all[i].split_whitespace().count() >= SUBSTANTIVE_WORDS);
        let mut keep = spread(&substantive, BETWEEN_COUNT);
        keep.extend(spread(&short, BETWEEN_COUNT - keep.len()));
        keep.sort_unstable();
        keep
    };
    let mut out = Vec::with_capacity(keep.len() + 2);
    out.push(whole(0));
    out.extend(keep.into_iter().map(between_one));
    if n > 1 {
        out.push(whole(n - 1));
    }
    out
}

/// `k` of `pool`'s items spread evenly over it, in order; with two or more, its first and last.
fn spread(pool: &[usize], k: usize) -> Vec<usize> {
    match k {
        _ if pool.len() <= k => pool.to_vec(),
        0 => Vec::new(),
        1 => pool[pool.len() - 1..].to_vec(),
        _ => (0..k).map(|j| pool[j * (pool.len() - 1) / (k - 1)]).collect(),
    }
}

/// `text` up to `max` chars: a longer one keeps its start (three quarters) and its end around ` … `.
fn cut(text: &str, max: usize) -> String {
    let n = text.chars().count();
    if n <= max {
        return text.to_owned();
    }
    let tail = max / 4;
    let head: String = text.chars().take(max.saturating_sub(tail + 3)).collect();
    let end: String = text.chars().skip(n - tail).collect();
    format!("{} … {}", head.trim_end(), end.trim_start())
}

/// Whitespace runs as one space.
fn squash(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The first line of `text` that says something, a markdown heading only when nothing else does,
/// up to [`TASK_MAX`] chars.
fn gist(text: &str) -> Option<String> {
    let lines = || text.lines().map(str::trim).filter(|l| l.chars().any(char::is_alphanumeric));
    let line = lines().find(|l| !l.starts_with('#')).or_else(|| lines().next())?;
    Some(clip(line.trim_start_matches('#'), TASK_MAX))
}

/// The subagents one `task` call started: from its progress when it has some, else from its
/// arguments (`tasks[]`, or a single task).
fn task_subagents(t: &ToolItem) -> Vec<DigestSubagent> {
    if let Some(ToolView::Task(v)) = &t.view {
        return v
            .agents
            .iter()
            .map(|a| DigestSubagent { name: clip(&a.name, NAME_MAX), task: a.description.as_deref().and_then(gist), running: a.status == SubagentStatus::Running })
            .collect();
    }
    let running = matches!(t.status, ToolStatus::Pending | ToolStatus::Running);
    let one = |v: &Value| {
        let name = ["name", "agent"].into_iter().find_map(|k| v.get(k).and_then(Value::as_str).filter(|s| !s.trim().is_empty()))?;
        Some(DigestSubagent { name: clip(name, NAME_MAX), task: v.get("task").and_then(Value::as_str).and_then(gist), running })
    };
    match t.args.get("tasks").and_then(Value::as_array) {
        Some(tasks) => tasks.iter().filter_map(one).collect(),
        None => one(&t.args).into_iter().collect(),
    }
}

/// One entry per name, where it first appears: running when any of its runs is.
fn once_each(all: impl Iterator<Item = DigestSubagent>) -> Vec<DigestSubagent> {
    let mut out: Vec<DigestSubagent> = Vec::new();
    for s in all {
        match out.iter_mut().find(|o| o.name == s.name) {
            Some(o) => {
                o.running |= s.running;
                if o.task.is_none() {
                    o.task = s.task;
                }
            }
            None => out.push(s),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tf_collab::Replica;
    use tf_proto::session::{CompactionItem, Subagent, TodoStatus, UserItem};

    /// A lead agent's session in omp's file shape: the objective, a phased todo list, five tracks on
    /// subagents, a compaction, a steer, omp's own notice of a finished job, and last a small edit.
    const LEAD: &str = include_str!("testdata/digest-lead-session.jsonl");

    fn user(i: usize, text: String, synthetic: bool) -> TranscriptItem {
        TranscriptItem::User(UserItem { id: format!("u{i}"), at: i as Millis, text, images: Vec::new(), author: None, steering: false, synthetic })
    }

    #[test]
    fn a_lead_session_is_digested_from_its_file_and_from_its_copy() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("2026-11-02T08-00-00-000Z_01a19c00-0000-7000-8000-00000000b100.jsonl");
        std::fs::write(&path, LEAD).unwrap();
        let rows = crate::find::files::rows(&path).unwrap();
        let d = build(rows.iter(), None);
        // Every prompt the user wrote, in order; omp's notice of a finished job is none.
        assert_eq!(d.prompt_count, 5);
        let prompts: Vec<(u32, &str)> = d.prompts.iter().map(|p| (p.n, p.text.as_str())).collect();
        assert_eq!(prompts.len(), 5);
        assert_eq!(prompts[0].0, 1);
        assert!(prompts[0].1.starts_with("Build Bloomworks, a cozy city-builder game") && prompts[0].1.ends_with("integrate, and ship M0."), "the objective whole");
        assert_eq!(prompts[1], (2, "yes"));
        assert_eq!(prompts[4], (5, "Update hud.rs to show the population counter next to the money display"));
        // The todo list as the newest todo call left it.
        let phases: Vec<&str> = d.todos.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(phases, ["Foundations", "Parallel tracks", "Integration", "Ship M0"]);
        let track_c = &d.todos[1].tasks[2];
        assert_eq!((track_c.content.as_str(), track_c.status, track_c.blocker.as_deref()), ("Track C: zoning and population", TodoStatus::Blocked, Some("waits for the new tile API")));
        assert_eq!(d.summaries, ["Foundations done; tracks A–E (render core, assets, zoning, HUD, Windows build) running in parallel."]);
        // The subagents of the task call: what each works on in a line (a heading is skipped).
        assert_eq!(d.subagent_count, 5);
        let render = DigestSubagent { name: "RenderCore".into(), task: Some("Build the wgpu render core: isometric tiles, camera, lighting.".into()), running: true };
        assert_eq!(d.subagents[0], render);
        assert_eq!(d.subagents.iter().map(|s| (s.name.as_str(), s.running)).collect::<Vec<_>>()[3], ("HudUi", false));

        // A copy of the session (what tf-hostd holds of a bridge-served one) says the same.
        let read = crate::journal::read_full(&path, None).unwrap();
        let mut replica = Replica::new("01a19c00-0000-7000-8000-00000000b100");
        let origin = crate::feed::Origin { session_id: "01a19c00-0000-7000-8000-00000000b100".into(), cwd: "/home/ada/src/bloomworks".into() };
        crate::feed::rebuild(&mut replica, read, &origin, false, 1_793_620_900_000);
        let copy = build(replica.rows(), Some(replica.meta()));
        assert_eq!(copy, d);
    }

    #[test]
    fn a_huge_session_stays_bounded() {
        let mut rows = vec![user(0, format!("Build the whole thing.\n{}", "spec ".repeat(5_000)), false)];
        for i in 1..600 {
            let text = if i % 3 == 0 { "yes".to_owned() } else { format!("Step {i}:\n{}", "detail ".repeat(200)) };
            rows.push(user(i, text, false));
            rows.push(user(10_000 + i, "<system-notice>todo reminder</system-notice>".into(), true));
        }
        rows.push(user(600, format!("Last {}", "x".repeat(10_000)), false));
        rows.extend((0..10).map(|i| TranscriptItem::Compaction(CompactionItem { id: format!("c{i}"), at: 0, summary: format!("Summary {i} {}", "s".repeat(5_000)), tokens_before: None })));
        let mut meta = Replica::new("x").meta().clone();
        meta.todos = (0..30)
            .map(|p| TodoPhase { name: format!("Phase {p}"), tasks: (0..50).map(|t| TodoTask { content: format!("Item {t} {}", "i".repeat(500)), status: TodoStatus::Pending, blocker: None }).collect() })
            .collect();
        // The roster lists them by id; they started in the other order.
        meta.subagents = (0..100)
            .map(|i| Subagent {
                id: format!("Agent{i:03}"),
                name: format!("Agent{i:03}"),
                description: Some(format!("Works on part {i} {}", "d".repeat(500))),
                status: if i < 16 { SubagentStatus::Running } else { SubagentStatus::Done },
                started_at: Some(1_000_000 - i),
                ended_at: None,
                cost_usd: None,
                tokens: None,
                model: None,
                line: None,
                completion_pct: None,
                context: None,
                tool_count: None,
                parent_id: None,
            })
            .collect();
        let d = build(rows.iter(), Some(&meta));

        assert_eq!(d.prompt_count, 601);
        assert_eq!(d.prompts.len(), 42);
        let (first, last) = (&d.prompts[0], &d.prompts[41]);
        assert_eq!((first.n, last.n), (1, 601));
        assert!(first.text.starts_with("Build the whole thing.\nspec") && first.text.chars().count() <= 4_000, "the objective's start, kept");
        assert!(last.text.starts_with("Last x") && last.text.ends_with("xxx") && last.text.contains(" … ") && last.text.chars().count() <= 4_000);
        let between = &d.prompts[1..41];
        assert!(between.iter().all(|p| p.text.chars().count() <= 400 && !p.text.contains('\n') && p.text != "yes"), "on one line, short, substantive ones first");
        assert!(between.windows(2).all(|w| w[0].n < w[1].n), "in order");
        assert_eq!((between[0].n, between[39].n), (2, 600), "spread over the whole session");

        assert_eq!(d.summaries.len(), 3);
        assert!(d.summaries[2].starts_with("Summary 9") && d.summaries.iter().all(|s| s.chars().count() <= 2_000), "the newest, cut");
        assert_eq!(d.todos.len(), 12);
        assert!(d.todos.iter().all(|p| p.tasks.len() == 20 && p.tasks.iter().all(|t| t.content.chars().count() <= 120)));
        assert_eq!((d.subagent_count, d.subagents.len()), (100, 40));
        let names: Vec<&str> = d.subagents.iter().map(|s| s.name.as_str()).collect();
        assert_eq!((names[0], names[7], names[8], names[39]), ("Agent099", "Agent092", "Agent031", "Agent000"), "the first 8 and the newest 32 to start");
        assert!(d.subagents[39].running && !d.subagents[0].running);
        assert!(d.subagents.iter().all(|s| s.task.as_deref().is_some_and(|t| t.chars().count() <= 160)));
        assert!(serde_json::to_string(&d).unwrap().len() < 100_000, "a bounded answer");
    }

    #[test]
    fn one_prompt_is_the_first_and_the_newest() {
        let d = build([user(1, "  fix it  ".into(), false), user(2, "reminder".into(), true)].iter(), None);
        assert_eq!((d.prompt_count, d.prompts), (1, vec![DigestPrompt { n: 1, text: "fix it".into() }]));
        assert!(build(std::iter::empty(), None).prompts.is_empty());
    }
}
