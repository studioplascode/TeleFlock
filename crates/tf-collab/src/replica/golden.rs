//! Golden tests: replay `docs/research/omp-collab-samples/*.jsonl` through the replica.
//!
//! Every scenario also checks **compaction correctness**: a client that only applies the emitted
//! `SessionEvent`s ends up with exactly the replica's rows.

use std::collections::HashMap;

use serde_json::Value;
use tf_proto::*;

use super::{Replica, Signal, Update};
use crate::frame::{HostFrame, SnapshotChunk, Welcome};
use crate::guest::{GuestEvent, Snapshot};

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/research/omp-collab-samples");

struct Row {
    at: Millis,
    dir: String,
    bytes: u64,
    frame: Value,
}

fn load(name: &str) -> Vec<Row> {
    let raw = std::fs::read_to_string(format!("{DIR}/{name}.jsonl")).unwrap();
    raw.lines()
        .map(|l| {
            let v: Value = serde_json::from_str(l).unwrap();
            Row {
                at: v["recvAt"].as_i64().unwrap_or(0),
                dir: v["dir"].as_str().unwrap_or("").to_owned(),
                bytes: v["bytes"].as_u64().unwrap_or(0),
                frame: v["frame"].clone(),
            }
        })
        .collect()
}

/// Client-side mirror built only from emitted events.
#[derive(Default)]
struct Mirror {
    order: Vec<String>,
    items: HashMap<String, TranscriptItem>,
    meta: Option<SessionMeta>,
    ui: Option<UiRequest>,
    ended: Option<String>,
}

impl Mirror {
    fn apply(&mut self, ev: &SessionEvent) {
        match ev {
            SessionEvent::Reset { snapshot } => {
                self.order = snapshot.items.iter().map(|i| i.id().to_owned()).collect();
                self.items = snapshot.items.iter().map(|i| (i.id().to_owned(), i.clone())).collect();
                self.meta = Some(snapshot.meta.clone());
                self.ui = snapshot.ui.clone();
            }
            SessionEvent::Upsert { item } => {
                let id = item.id().to_owned();
                if !self.items.contains_key(&id) {
                    self.order.push(id.clone());
                }
                self.items.insert(id, item.clone());
            }
            SessionEvent::Append { id, field, text } => match (self.items.get_mut(id), field) {
                (Some(TranscriptItem::Assistant(a)), AppendField::Text) => a.text.push_str(text),
                (Some(TranscriptItem::Thinking(t)), AppendField::Text) => t.text.push_str(text),
                (Some(TranscriptItem::User(u)), AppendField::Text) => u.text.push_str(text),
                (Some(TranscriptItem::Tool(t)), AppendField::Output) => t.output.get_or_insert_with(String::new).push_str(text),
                other => panic!("append to unknown row {id}: {:?}", other.0.map(|i| i.id().to_owned())),
            },
            SessionEvent::Remove { id } => {
                self.items.remove(id);
                self.order.retain(|x| x != id);
            }
            SessionEvent::Meta { meta } => self.meta = Some(meta.clone()),
            SessionEvent::Ui { request } => self.ui = request.clone(),
            SessionEvent::Ended { reason } => self.ended = Some(reason.clone()),
            SessionEvent::Btw { .. } => {}
        }
    }

    fn rows(&self) -> Vec<&TranscriptItem> {
        self.order.iter().map(|id| &self.items[id]).collect()
    }
}

struct Run {
    replica: Replica,
    mirror: Mirror,
    updates: Vec<Update>,
    raw_h2g: u64,
    raw_update_bytes: u64,
    out_bytes: u64,
}

impl Run {
    fn signals(&self) -> Vec<&Signal> {
        self.updates.iter().flat_map(|u| &u.signals).collect()
    }
    fn events(&self) -> Vec<&SessionEvent> {
        self.updates.iter().flat_map(|u| &u.events).collect()
    }
    fn rows(&self) -> Vec<TranscriptItem> {
        self.replica.snapshot(usize::MAX).items
    }
    fn tool(&self, name: &str) -> ToolItem {
        self.rows()
            .into_iter()
            .find_map(|i| match i {
                TranscriptItem::Tool(t) if t.tool == name => Some(t),
                _ => None,
            })
            .unwrap_or_else(|| panic!("no {name} tool row"))
    }
    fn assistant_text(&self) -> Vec<String> {
        self.rows()
            .into_iter()
            .filter_map(|i| match i {
                TranscriptItem::Assistant(a) if !a.text.is_empty() => Some(a.text),
                _ => None,
            })
            .collect()
    }
    fn check_mirror(&self) {
        let want = self.rows();
        let got: Vec<TranscriptItem> = self.mirror.rows().into_iter().cloned().collect();
        assert_eq!(got.len(), want.len(), "row count: mirror {} vs replica {}", got.len(), want.len());
        for (g, w) in got.iter().zip(&want) {
            assert_eq!(g, w, "mirror row differs");
        }
        assert_eq!(self.mirror.meta.as_ref(), Some(self.replica.meta()), "meta mirror");
        assert_eq!(self.mirror.ui.as_ref(), self.replica.ui(), "ui mirror");
    }
}

fn snapshot_from(rows: &[Row], resync: bool) -> Option<(Millis, Snapshot)> {
    let w = rows.iter().find(|r| r.frame["t"] == "welcome")?;
    let welcome: Welcome = serde_json::from_value(w.frame.clone()).unwrap();
    let entries = rows
        .iter()
        .filter(|r| r.frame["t"] == "snapshot-chunk")
        .flat_map(|r| serde_json::from_value::<SnapshotChunk>(r.frame.clone()).unwrap().entries)
        .collect();
    Some((w.at, Snapshot { welcome, entries, resync }))
}

/// Replay a scenario on top of the `00-join` snapshot (scenario slices start mid-session).
fn run(name: &str) -> Run {
    run_with(name, |_| {})
}

fn run_with(name: &str, setup: impl FnOnce(&mut Replica)) -> Run {
    let base = load("00-join");
    let (at0, snap) = snapshot_from(&base, false).unwrap();
    let mut replica = Replica::new("agent");
    setup(&mut replica);
    let mut r = Run {
        replica,
        mirror: Mirror::default(),
        updates: Vec::new(),
        raw_h2g: 0,
        raw_update_bytes: 0,
        out_bytes: 0,
    };
    let feed = |r: &mut Run, ev: GuestEvent, at: Millis| {
        let up = r.replica.apply(&ev, at);
        for e in &up.events {
            r.mirror.apply(e);
            r.out_bytes += serde_json::to_vec(e).unwrap().len() as u64;
        }
        r.updates.push(up);
    };
    feed(&mut r, GuestEvent::Snapshot(snap), at0);
    r.out_bytes = 0;
    let rows = load(name);
    let mut i = 0;
    while i < rows.len() {
        let row = &rows[i];
        if row.dir != "h2g" {
            i += 1;
            continue;
        }
        r.raw_h2g += row.bytes;
        if row.frame["t"] == "event" && row.frame["event"]["type"] == "message_update" {
            r.raw_update_bytes += row.bytes;
        }
        if row.frame["t"] == "welcome" {
            // Resync train: welcome + chunks until final.
            let mut j = i + 1;
            while j < rows.len() && !(rows[j].frame["t"] == "snapshot-chunk" && rows[j].frame["final"] == true) {
                j += 1;
            }
            let (at, snap) = snapshot_from(&rows[i..=j.min(rows.len() - 1)], true).unwrap();
            feed(&mut r, GuestEvent::Snapshot(snap), at);
            i = j + 1;
            continue;
        }
        feed(&mut r, GuestEvent::Frame(HostFrame::from_value(row.frame.clone())), row.at);
        i += 1;
    }
    r.check_mirror();
    r
}

#[test]
fn s00_join() {
    let r = run("00-join");
    let rows = r.rows();
    assert_eq!(rows.len(), 2);
    assert!(matches!(&rows[0], TranscriptItem::Mode(m) if m.text == "Model: openai-codex/gpt-6-luna"));
    assert!(matches!(&rows[1], TranscriptItem::Mode(m) if m.text == "Thinking: low"));
    let m = r.replica.meta();
    assert_eq!(m.model.as_ref().unwrap().id, "gpt-6-luna");
    assert_eq!(m.model.as_ref().unwrap().label.as_deref(), Some("GPT-6 Luna"));
    assert_eq!(m.thinking, Some(ThinkingLevel::Low));
    assert_eq!(m.session_id.as_deref(), Some("01a15b4d-6996-774c-9851-97cfcee9bfcf"));
    assert_eq!(m.cwd.as_deref(), Some("/tmp/tf-collab-work"));
    assert!(m.caps.prompt && m.caps.abort && m.caps.answer && !m.caps.model);
    assert!(m.started_at.is_some());
    // Our own "joined" notice is not a transcript row.
    assert!(!r.rows().iter().any(|i| matches!(i, TranscriptItem::Notice(_))));
}

#[test]
fn s01_prompt_text() {
    let r = run("01-prompt-text");
    let rows = r.rows();
    let user = rows.iter().find_map(|i| if let TranscriptItem::User(u) = i { Some(u) } else { None }).unwrap();
    assert_eq!(user.text, "Think briefly, then reply with exactly: pong");
    assert_eq!(user.author.as_deref(), Some("teleflock"));
    assert!(!user.synthetic && !user.steering);
    assert_eq!(user.id, "u1792533246786", "event and entry ids agree");
    assert_eq!(r.assistant_text(), ["pong"]);
    let a = rows.iter().find_map(|i| if let TranscriptItem::Assistant(a) = i { Some(a) } else { None }).unwrap();
    assert!(!a.streaming);
    assert_eq!(a.stop_reason.as_deref(), Some("stop"));
    assert_eq!(a.usage.as_ref().unwrap().output, 5);
    let sig = r.signals();
    assert!(sig.contains(&&Signal::TurnStarted));
    assert!(sig.contains(&&Signal::TurnEnded { aborted: false, error: None }));
    assert!(sig.iter().any(|s| matches!(s, Signal::Prompted { author: Some(a), .. } if a == "teleflock")));
    let cost = r.replica.usage().unwrap();
    assert_eq!(cost.output, 5);
    assert!(cost.usd > 0.0);
    assert!(!r.replica.is_streaming());
    let live = r.replica.liveness(0);
    assert!(!live.streaming && !live.thinking && live.tool.is_none());
}

#[test]
fn s01_prompt_attributed_to_sending_device() {
    let r = run_with("01-prompt-text", |rep| {
        rep.expect_prompt("something else", "laptop");
        rep.expect_prompt("  Think briefly, then reply with exactly: pong\n", "pixel");
    });
    let user = r.rows().into_iter().find_map(|i| if let TranscriptItem::User(u) = i { Some(u) } else { None }).unwrap();
    assert_eq!(user.author.as_deref(), Some("pixel"));
    assert!(r.signals().iter().any(|s| matches!(s, Signal::Prompted { author: Some(a), .. } if a == "pixel")));
}

#[test]
fn s01b_streaming_thinking_retries() {
    let r = run("01b-prompt-streaming-thinking");
    let rows = r.rows();
    // Six failed attempts collapse into one retry notice that ends "recovered".
    let notices: Vec<&NoticeItem> = rows.iter().filter_map(|i| if let TranscriptItem::Notice(n) = i { Some(n) } else { None }).collect();
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert_eq!(notices[0].text, "Recovered after 6 retries");
    assert!(!rows.iter().any(|i| matches!(i, TranscriptItem::Assistant(a) if a.error.is_some())), "error rows removed");
    assert_eq!(r.signals().iter().filter(|s| matches!(s, Signal::Retry { .. })).count(), 6);
    assert_eq!(r.signals().iter().filter(|s| matches!(s, Signal::TurnStarted)).count(), 1);
    let text = r.assistant_text().join("");
    assert!(text.len() > 100, "{text}");
    assert!(r.events().iter().filter(|e| matches!(e, SessionEvent::Append { .. })).count() > 20);
}

#[test]
fn s02_bash_tool() {
    let r = run("02-bash-tool");
    let t = r.tool("bash");
    assert_eq!(t.status, ToolStatus::Ok);
    assert_eq!(t.title, "echo hello-from-collab && uname -s");
    assert_eq!(t.intent.as_deref(), Some("Running requested shell command"));
    assert_eq!(t.output.as_deref(), Some("hello-from-collab\nLinux\n"));
    let Some(ToolView::Bash(v)) = &t.view else { panic!("{:?}", t.view) };
    assert_eq!(v.command, "echo hello-from-collab && uname -s");
    assert_eq!(v.output, "hello-from-collab\nLinux\n");
    assert!(!v.background && !v.timed_out);
    assert!(t.duration_ms.is_some());
    // Output streamed as deltas.
    let appends: Vec<&str> = r
        .events()
        .iter()
        .filter_map(|e| match e {
            SessionEvent::Append { field: AppendField::Output, text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(appends, ["hello-from-collab\n", "Linux\n"], "cumulative partial results become deltas");
    // Tool row sits between the prompt and the final answer.
    let rows = r.rows();
    let pos = |pred: &dyn Fn(&TranscriptItem) -> bool| rows.iter().position(|i| pred(i)).unwrap();
    assert!(pos(&|i| matches!(i, TranscriptItem::User(_))) < pos(&|i| matches!(i, TranscriptItem::Tool(_))));
    assert!(pos(&|i| matches!(i, TranscriptItem::Tool(_))) < pos(&|i| matches!(i, TranscriptItem::Assistant(a) if a.text == "done")));
    // Tool liveness came and went.
    assert!(r.updates.iter().any(|u| u.liveness_changed));
}

#[test]
fn s03_edit_tool() {
    let r = run("03-edit-tool");
    let read = r.tool("read");
    let Some(ToolView::Read(rv)) = &read.view else { panic!() };
    assert_eq!(rv.path, "notes.txt");
    assert_eq!(rv.lines, Some(3));
    assert_eq!(rv.preview.as_deref(), Some("alpha\nbeta\ngamma"));
    assert_eq!(rv.lang.as_deref(), Some("text"));
    let edit = r.tool("edit");
    assert_eq!(edit.status, ToolStatus::Ok);
    assert_eq!(edit.title, "notes.txt");
    let Some(ToolView::Diff(d)) = &edit.view else { panic!() };
    assert_eq!(d.files.len(), 1);
    let f = &d.files[0];
    assert_eq!(f.path, "/tmp/tf-collab-work/notes.txt");
    assert_eq!((f.added, f.removed), (1, 1));
    assert_eq!(f.status, FileStatus::Modified);
    assert!(f.patch.contains("-beta\n+BETA-EDITED\n"), "{}", f.patch);
    // The session's changed-files list folds every successful edit (relative to the cwd).
    let files = &r.replica.meta().files;
    assert_eq!(files.len(), 1, "{files:?}");
    assert_eq!(files[0].path, "notes.txt");
    assert_eq!((files[0].added, files[0].removed, files[0].status), (1, 1, FileStatus::Modified));
}

/// A fresh replica (hostd restarted) joining a session whose edits are already in the snapshot
/// still lists changed files relative to the cwd.
#[test]
fn s03_edit_replayed_from_snapshot() {
    let (at0, mut snap) = snapshot_from(&load("00-join"), false).unwrap();
    snap.entries.extend(load("03-edit-tool").into_iter().filter(|r| r.dir == "h2g" && r.frame["t"] == "entry").map(|r| r.frame["entry"].clone()));
    let mut rep = Replica::new("x");
    rep.apply(&GuestEvent::Snapshot(snap), at0);
    let files = &rep.meta().files;
    assert_eq!(files.len(), 1, "{files:?}");
    assert_eq!(files[0].path, "notes.txt");
}

#[test]
fn s04_todo() {
    let r = run("04-todo");
    let todos = &r.replica.meta().todos;
    assert_eq!(todos.len(), 1);
    assert_eq!(todos[0].name, "Work");
    let names: Vec<&str> = todos[0].tasks.iter().map(|t| t.content.as_str()).collect();
    assert_eq!(names, ["plan", "build", "ship"]);
    assert_eq!(todos[0].tasks[0].status, TodoStatus::InProgress);
    let t = r.tool("todo");
    assert!(matches!(&t.view, Some(ToolView::Todo(v)) if v.phases.len() == 1));
    assert!(r.updates.iter().any(|u| u.events.iter().any(|e| matches!(e, SessionEvent::Meta { meta } if !meta.todos.is_empty()))));
    // omp's todo reminders are synthetic user rows.
    assert!(r.rows().iter().any(|i| matches!(i, TranscriptItem::User(u) if u.synthetic && u.text.contains("incomplete todo"))));
}

#[test]
fn s05_ask_ui_response() {
    let mut r = run("05-ask-ui-response");
    // During the ask: a ui event with exact labels, sentinels as flags, linked to the ask call.
    let asked = r
        .events()
        .into_iter()
        .find_map(|e| match e {
            SessionEvent::Ui { request: Some(req) } => Some(req.clone()),
            _ => None,
        })
        .expect("ui request event");
    assert_eq!(asked.id, "2");
    assert_eq!(asked.kind, UiKind::Select);
    assert_eq!(asked.title, "Which color do you prefer?");
    assert_eq!(asked.options.iter().map(|o| o.label.as_str()).collect::<Vec<_>>(), ["Red", "Blue"]);
    assert!(asked.allow_other && asked.allow_chat);
    assert!(asked.call_id.as_deref().unwrap().starts_with("call_89b1f30f"));
    assert!(r.signals().iter().any(|s| matches!(s, Signal::Asked { request_id } if request_id == "2")));
    assert!(r.signals().iter().any(|s| matches!(s, Signal::UiSettled { request_id } if request_id == "2")));
    assert!(r.replica.ui().is_none(), "settled by ui-request-end");
    let ask = r.tool("ask");
    let Some(ToolView::Ask(v)) = &ask.view else { panic!() };
    assert_eq!(v.questions[0].answer.as_deref(), Some("Blue"));
    assert_eq!(v.questions[0].options, ["Red", "Blue"]);
    // Replaying the request alone: answer mapping is exact.
    let rows = load("05-ask-ui-response");
    let req = rows.iter().find(|r| r.frame["t"] == "ui-request").unwrap();
    r.replica.apply(&GuestEvent::Frame(HostFrame::from_value(req.frame.clone())), 0);
    let needs = r.replica.needs().unwrap();
    assert_eq!(needs.kind, NeedsKind::Ask);
    assert!(needs.allow_other && needs.allow_chat && !needs.multi);
    let ans = Answer { choices: vec!["Blue".into()], text: None, cancel: false, chat: false };
    assert_eq!(r.replica.answer("2", &ans).unwrap(), vec![super::UiReply { req_id: 2, value: Some("Blue".into()) }]);
    let wrong = Answer { choices: vec!["blue".into()], ..ans };
    assert_eq!(r.replica.answer("2", &wrong).unwrap_err().code, "invalid_params");
}

#[test]
fn s05a_ask_wrong_label() {
    let r = run("05a-ask-wrong-label");
    let ask = r.tool("ask");
    assert_eq!(ask.status, ToolStatus::Aborted);
    assert_eq!(ask.error.as_deref(), Some("Ask tool was cancelled by the user"));
}

#[test]
fn s06_abort_and_bandwidth() {
    let r = run("06-abort");
    let rows = r.rows();
    let a = rows.iter().rev().find_map(|i| if let TranscriptItem::Assistant(a) = i { Some(a) } else { None }).unwrap();
    assert_eq!(a.stop_reason.as_deref(), Some("aborted"));
    assert!(!a.streaming);
    assert!(a.text.contains("one") && a.text.len() > 500);
    assert!(r.signals().contains(&&Signal::TurnEnded { aborted: true, error: None }));
    assert!(rows.iter().any(|i| matches!(i, TranscriptItem::Notice(n) if n.text == "teleflock interrupted")));
    // Bandwidth: compacted session events vs. raw relay frames.
    let ratio = r.raw_h2g as f64 / r.out_bytes as f64;
    eprintln!(
        "06-abort bandwidth: raw h2g {} B (message_update {} B) → compacted {} B ({ratio:.1}× smaller)",
        r.raw_h2g, r.raw_update_bytes, r.out_bytes
    );
    assert!(ratio > 8.0, "compaction ratio {ratio:.1}");
    let appends = r.events().iter().filter(|e| matches!(e, SessionEvent::Append { .. })).count();
    // 303 raw updates; the host's lazy serialization folds some together, so fewer, larger deltas.
    assert!(appends > 150, "{appends} appends");
}

#[test]
fn s07_task_subagent() {
    let r = run("07-task-subagent");
    let t = r.tool("task");
    assert_eq!(t.status, ToolStatus::Ok);
    assert_eq!(t.title, "1 agent: ReplyOk");
    let Some(ToolView::Task(v)) = &t.view else { panic!() };
    assert_eq!(v.agents[0].id, "ReplyOk");
    assert_eq!(v.agents[0].status, SubagentStatus::Done, "late updates after end refresh the view");
    let subs = &r.replica.meta().subagents;
    assert_eq!(subs.len(), 1, "{subs:?}");
    assert_eq!(subs[0].id, "ReplyOk");
    assert_eq!(subs[0].status, SubagentStatus::Done);
    assert_eq!(subs[0].parent_id.as_deref(), Some("Main"));
    assert!(subs[0].tokens.unwrap() > 0);
    // omp's TUI row: `· 2.4%/272K` (contextTokens 6637 / contextWindow 272000).
    for sub in [&subs[0], &v.agents[0]] {
        let ctx = sub.context.as_ref().expect("subagent context usage");
        assert_eq!((ctx.tokens, ctx.window), (6637, 272_000));
        assert!((ctx.pct - 2.44).abs() < 0.01, "{}", ctx.pct);
        assert_eq!(sub.completion_pct, None, "no probe answered in a 2 s run");
    }
    assert!(r.rows().iter().any(|i| matches!(i, TranscriptItem::User(u) if u.synthetic && u.author.as_deref() == Some("async-result"))));
}

/// A ~3 min subagent outlives omp's first completion probe (2 min): its `AgentProgress.completionPercent`
/// (omp TUI `· 15%`) reaches the meta subagent and the task tool card while it runs, then drops once it ends.
#[test]
fn s17_task_completion_probe() {
    let r = run("17-task-completion-probe");
    let metas: Vec<&SessionMeta> = r.events().into_iter().filter_map(|e| match e { SessionEvent::Meta { meta } => Some(meta), _ => None }).collect();
    let live: Vec<&Subagent> = metas.iter().flat_map(|m| &m.subagents).filter(|s| s.completion_pct.is_some()).collect();
    assert!(!live.is_empty(), "no meta subagent carried the completion estimate");
    for s in &live {
        assert_eq!(s.status, SubagentStatus::Running);
        assert_eq!(s.completion_pct, Some(15.0));
        let ctx = s.context.as_ref().unwrap();
        assert_eq!(ctx.window, 272_000);
        assert!(ctx.pct > 0.0 && ctx.pct < 100.0, "{}", ctx.pct);
    }
    let cards: Vec<&Subagent> = r
        .events()
        .into_iter()
        .filter_map(|e| match e {
            SessionEvent::Upsert { item: TranscriptItem::Tool(t) } => match &t.view {
                Some(ToolView::Task(v)) => Some(&v.agents),
                _ => None,
            },
            _ => None,
        })
        .flatten()
        .filter(|a| a.completion_pct.is_some())
        .collect();
    assert!(cards.iter().any(|a| a.completion_pct == Some(15.0)), "task tool card never showed the estimate");
    // Finished: omp's TUI only prints the estimate on live rows.
    let subs = &r.replica.meta().subagents;
    assert_eq!(subs.len(), 1, "{subs:?}");
    assert_eq!(subs[0].status, SubagentStatus::Done);
    assert_eq!(subs[0].completion_pct, None);
    assert!(subs[0].context.is_some());
}

/// Session cost is omp's status-line total: main (assistant turns) + subagents (`max` of task
/// results, the artifact tree, live `progress.cost`) + advisor (`__advisor*.jsonl`). Sample 17 has
/// an async subagent (no `details.usage`) and an advisor note; the artifacts dir is fed through an
/// [`super::ArtifactLedger`] as tf-hostd does. Finished subagent/advisor replies replay into tok/s
/// and expire, so throughput idles after the turn.
#[test]
fn s17_cost_covers_subagents_and_advisor() {
    let mut r = run("17-task-completion-probe");
    let rows = load("17-task-completion-probe");
    let main: f64 = rows
        .iter()
        .filter(|row| row.frame["t"] == "entry" && row.frame["entry"]["message"]["role"] == "assistant")
        .filter_map(|row| row.frame["entry"]["message"]["usage"]["cost"]["total"].as_f64())
        .sum();
    let progress = rows
        .iter()
        .rev()
        .find_map(|row| (row.frame["channel"] == "task:subagent:progress").then(|| row.frame["data"]["progress"]["cost"].as_f64()).flatten())
        .unwrap();
    let c = r.replica.usage().unwrap();
    let split = c.split.clone().unwrap();
    assert!((split.main - main).abs() < 1e-12, "{split:?} vs {main}");
    assert!((split.subagents - progress).abs() < 1e-12, "async subagent bills through progress: {split:?}");
    assert_eq!(split.advisor, 0.0, "advisors are never mirrored over collab");
    assert!((c.usd - (main + progress)).abs() < 1e-12);
    assert_eq!(r.replica.meta().cost.as_ref(), Some(&c), "meta and board read the same total");

    // tf-hostd reads the artifacts dir: the subagent transcript bills slightly more than progress
    // (its `model_usage` probe calls), and the advisor transcript bills its own turns.
    let now = 1_792_576_400_000;
    let line = |v: Value| format!("{v}\n");
    let header = line(serde_json::json!({"type": "session", "id": "s"}));
    let reply = |usd: f64, output: u64| {
        line(serde_json::json!({"type": "message", "message": {"role": "assistant", "timestamp": now - 3_000, "duration": 2_500.0, "ttft": 500.0,
            "usage": {"input": 900, "output": output, "cacheRead": 0, "cacheWrite": 0, "cost": {"total": usd}}}}))
    };
    let mut ledger = super::ArtifactLedger::default();
    let mut calls = ledger.ingest("RequestedSleepCount.jsonl", format!("{header}{}", reply(progress, 40)).as_bytes());
    calls.extend(ledger.ingest(
        "RequestedSleepCount.jsonl",
        line(serde_json::json!({"type": "model_usage", "usage": {"output": 3, "cost": {"total": 0.0001}}})).as_bytes(),
    ));
    calls.extend(ledger.ingest("__advisor.default.jsonl", format!("{header}{}", reply(0.01, 120)).as_bytes()));
    assert_eq!(calls.len(), 3);
    let up = r.replica.apply_artifacts(&ledger, &calls, now);
    assert!(up.meta_changed && up.events.iter().any(|e| matches!(e, SessionEvent::Meta { .. })));
    let c = r.replica.usage().unwrap();
    let split = c.split.clone().unwrap();
    assert!((split.subagents - (progress + 0.0001)).abs() < 1e-12, "{split:?}");
    assert!((split.advisor - 0.01).abs() < 1e-12);
    assert!((c.usd - (split.main + split.subagents + split.advisor)).abs() < 1e-12, "parts sum to the total");
    assert!(!r.replica.artifacts_stale(&ledger));

    // Throughput: each reply replays at output / (duration − ttft) = n / 2 s; the turn is over, so
    // the main agent contributes nothing, and once the replays end tok/s is gone.
    let live = r.replica.liveness(now + 500);
    let tps = live.tps_split.unwrap();
    assert_eq!(tps.main, 0.0);
    assert!((tps.subagents - 20.0).abs() < 1e-3 && (tps.advisor - 60.0).abs() < 1e-3, "{tps:?}");
    assert!((live.tps.unwrap() - 80.0).abs() < 1e-3);
    assert!(r.replica.replaying(now + 500));
    let idle = r.replica.liveness(now + 2_001);
    assert!(idle.tps.is_none() && idle.tps_split.is_none());
    assert!(!r.replica.replaying(now + 2_001));
}

/// The artifacts dir of a real run (omp 18.12.3, advisor on, one sync subagent; captured
/// 2026-10-21 in `19-artifacts/`). Both transcripts open with omp's `title` slot line before the
/// session header. The ledger bills what omp bills: assistant turns (+ subagent `model_usage`).
#[test]
fn s19_artifact_transcripts() {
    let dir = format!("{DIR}/19-artifacts");
    let mut ledger = super::ArtifactLedger::default();
    let mut expect = (0.0, 0.0);
    for (name, advisor) in [("TinyFilesEssay.jsonl", false), ("__advisor.default.jsonl", true)] {
        let raw = std::fs::read(format!("{dir}/{name}")).unwrap();
        let first: Value = serde_json::from_slice(raw.split(|b| *b == b'\n').next().unwrap()).unwrap();
        assert_eq!(first["type"], "title", "{name}: title slot first");
        let billed: f64 = String::from_utf8_lossy(&raw)
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|e| (e["type"] == "message" && e["message"]["role"] == "assistant") || (!advisor && e["type"] == "model_usage"))
            .filter_map(|e| e["message"]["usage"]["cost"]["total"].as_f64().or_else(|| e["usage"]["cost"]["total"].as_f64()))
            .sum();
        if advisor {
            expect.1 += billed;
        } else {
            expect.0 += billed;
        }
        // Fed in two arbitrary chunks, as tf-hostd reads a file that is still growing.
        let (a, b) = raw.split_at(raw.len() / 3);
        let calls = [ledger.ingest(name, a), ledger.ingest(name, b)].concat();
        assert!(!calls.is_empty(), "{name}");
        assert!(calls.iter().all(|c| c.ended_at.is_some() && c.decode_ms.is_some_and(|d| d > 0)), "{name}: replayable");
    }
    assert!(expect.0 > 0.0 && expect.1 > 0.0);
    assert!((ledger.subagents().usd - expect.0).abs() < 1e-12, "{} vs {}", ledger.subagents().usd, expect.0);
    assert!((ledger.advisor().usd - expect.1).abs() < 1e-12, "{} vs {}", ledger.advisor().usd, expect.1);
}

#[test]
fn s08_fetch_transcript_page() {
    let rows = load("08-fetch-transcript");
    let t = rows.iter().find(|r| r.frame["t"] == "transcript" && r.frame["error"].is_null()).unwrap();
    let page = super::transcript_page(t.frame["text"].as_str().unwrap());
    assert!(!page.has_more);
    assert!(page.items.iter().any(|i| matches!(i, TranscriptItem::Assistant(a) if a.text.trim() == "ok")), "{:?}", page.items);
    assert!(page.items.iter().any(|i| matches!(i, TranscriptItem::User(_))));
    // The replica ignores transcript frames.
    let r = run("08-fetch-transcript");
    assert_eq!(r.rows().len(), 2);
}

#[test]
fn s09_agent_cmd_chat() {
    let r = run("09-agent-cmd-chat");
    let subs = &r.replica.meta().subagents;
    assert!(subs.iter().any(|s| s.id == "ReplyOk"), "{subs:?}");
    assert!(r.events().iter().any(|e| matches!(e, SessionEvent::Meta { .. })));
}

#[test]
fn s10_injected_switch_thinking() {
    let r = run("10-injected-switch-thinking");
    assert_eq!(r.replica.meta().thinking, Some(ThinkingLevel::Medium));
    assert!(r.rows().iter().any(|i| matches!(i, TranscriptItem::Mode(m) if m.text == "Thinking: medium")));
    assert!(r.signals().contains(&&Signal::ThinkingChanged { level: ThinkingLevel::Medium }));
}

#[test]
fn s11_guest_slash_and_visible_thinking() {
    let r = run("11-guest-slash-not-executed");
    let rows = r.rows();
    assert!(rows.iter().any(|i| matches!(i, TranscriptItem::User(u) if u.text == "/switch :low")));
    let thinking: Vec<&ThinkingItem> = rows.iter().filter_map(|i| if let TranscriptItem::Thinking(t) = i { Some(t) } else { None }).collect();
    assert!(thinking.iter().any(|t| t.text.starts_with("**Keeping reminder unchanged**") && !t.redacted));
    assert!(thinking.iter().any(|t| t.text.is_empty() && t.redacted), "encrypted reasoning shows as redacted");
    assert!(thinking.iter().all(|t| !t.streaming && t.duration_ms.is_some()));
    // The full message arrived before its deltas (lazy host serialization): the text is not doubled.
    assert!(r.assistant_text().iter().all(|t| t == "I can’t switch model modes from this chat."), "{:?}", r.assistant_text());
}

#[test]
fn s12_relay_restart_resync() {
    let r = run("12-relay-restart");
    let resets = r.events().iter().filter(|e| matches!(e, SessionEvent::Reset { .. })).count();
    assert_eq!(resets, 2, "initial + resync");
    let SessionEvent::Reset { snapshot } = r.events().into_iter().rev().find(|e| matches!(e, SessionEvent::Reset { .. })).unwrap() else {
        unreachable!()
    };
    assert!(snapshot.items.len() > 40, "{} rows", snapshot.items.len());
    assert!(snapshot.items.iter().any(|i| matches!(i, TranscriptItem::Tool(t) if t.tool == "bash" && t.status == ToolStatus::Ok)));
    assert!(snapshot.items.iter().all(|i| !matches!(i, TranscriptItem::Assistant(a) if a.streaming)));
    // Same ids as the live stream: retried error rows are superseded in the snapshot too.
    let errs: Vec<&TranscriptItem> =
        snapshot.items.iter().filter(|i| matches!(i, TranscriptItem::Assistant(a) if a.text.is_empty())).collect();
    assert!(errs.is_empty(), "{errs:?}");
    // Paging.
    let first = r.replica.snapshot(10);
    assert!(first.has_more);
    let older = r.replica.history(first.cursor.as_deref(), 10);
    assert_eq!(older.items.len(), 10);
    assert_ne!(older.items[9].id(), first.items[0].id());
}

#[test]
fn s13_view_only_guest() {
    let r = run("13-view-only-guest");
    assert!(r.replica.read_only());
    let m = r.replica.meta();
    assert!(!m.caps.prompt && !m.caps.abort && !m.caps.answer);
    let warns: Vec<String> = r
        .rows()
        .into_iter()
        .filter_map(|i| match i {
            TranscriptItem::Notice(n) if n.level == NoticeLevel::Warn => Some(n.text),
            _ => None,
        })
        .collect();
    assert!(warns.iter().any(|w| w == "prompting is disabled on a read-only link"), "{warns:?}");
    assert!(warns.iter().any(|w| w.starts_with("protocol mismatch")), "{warns:?}");
}

#[test]
fn s14_session_rotation_bye() {
    let r = run("14-session-rotation-bye");
    assert!(r.replica.ended());
    assert!(r.mirror.ended.as_deref().unwrap().starts_with("session switched"));
    assert!(r.signals().iter().any(|s| matches!(s, Signal::Ended { .. })));
    assert!(!r.replica.meta().caps.prompt);
}

#[test]
fn s15_tui_typed_prompt() {
    let r = run("15-tui-typed-prompt-mirrored");
    let user = r.rows().into_iter().find_map(|i| if let TranscriptItem::User(u) = i { Some(u) } else { None }).unwrap();
    assert_eq!(user.author, None, "typed locally in the TUI");
    assert!(!user.synthetic);
    assert!(!r.assistant_text().is_empty());
}

#[test]
fn s16_tool_approval() {
    let mut r = run("16-tool-approval");
    let bash = r.tool("bash");
    assert_eq!(bash.status, ToolStatus::Ok);
    assert_eq!(bash.output.as_deref(), Some("approved-run\n"));
    let req = r
        .events()
        .into_iter()
        .find_map(|e| match e {
            SessionEvent::Ui { request: Some(req) } => Some(req.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(req.title, "Allow tool: bash");
    assert_eq!(req.message.as_deref(), Some("Command: echo approved-run"));
    assert_eq!(req.call_id.as_deref(), Some(bash.call_id.as_str()));
    assert_eq!(req.options.iter().map(|o| o.label.as_str()).collect::<Vec<_>>(), ["Approve", "Approve bash for this session", "Deny"]);
    let rows = load("16-tool-approval");
    let f = rows.iter().find(|r| r.frame["t"] == "ui-request").unwrap();
    r.replica.apply(&GuestEvent::Frame(HostFrame::from_value(f.frame.clone())), 0);
    let n = r.replica.needs().unwrap();
    assert_eq!(n.kind, NeedsKind::Approval);
    assert_eq!(n.command.as_deref(), Some("echo approved-run"));
    let ans = Answer { choices: vec!["Approve".into()], text: None, cancel: false, chat: false };
    assert_eq!(r.replica.answer("1", &ans).unwrap()[0].value.as_deref(), Some("Approve"));
}

/// Joining mid-turn: drop everything before the first `message_update` of sample 06 and check
/// the in-flight message is synthesized and complete at the end.
#[test]
fn mid_turn_join() {
    let base = load("00-join");
    let (at0, mut snap) = snapshot_from(&base, false).unwrap();
    snap.welcome.state.is_streaming = true;
    let mut rep = Replica::new("x");
    let mut mirror = Mirror::default();
    for e in rep.apply(&GuestEvent::Snapshot(snap), at0).events {
        mirror.apply(&e);
    }
    assert!(rep.liveness(at0).thinking, "streaming snapshot shows activity before the first token");
    let rows = load("06-abort");
    let start = rows.iter().position(|r| r.frame["event"]["type"] == "message_update").unwrap() + 50;
    for row in rows[start..].iter().filter(|r| r.dir == "h2g") {
        for e in rep.apply(&GuestEvent::Frame(HostFrame::from_value(row.frame.clone())), row.at).events {
            mirror.apply(&e);
        }
    }
    let texts: Vec<String> = rep
        .snapshot(usize::MAX)
        .items
        .into_iter()
        .filter_map(|i| if let TranscriptItem::Assistant(a) = i { Some(a.text) } else { None })
        .collect();
    let full = rows
        .iter()
        .rev()
        .find(|r| r.frame["event"]["type"] == "message_end" && r.frame["event"]["message"]["role"] == "assistant")
        .unwrap();
    let want = full.frame["event"]["message"]["content"][0]["text"].as_str().unwrap();
    assert_eq!(texts, [want]);
    assert_eq!(mirror.rows().len(), rep.len());
}

#[test]
fn liveness_while_streaming() {
    let base = load("00-join");
    let (at0, snap) = snapshot_from(&base, false).unwrap();
    let mut rep = Replica::new("x");
    rep.apply(&GuestEvent::Snapshot(snap), at0);
    let rows = load("06-abort");
    let mut saw_streaming = false;
    let mut max_tps = 0.0f32;
    for row in rows.iter().filter(|r| r.dir == "h2g") {
        rep.apply(&GuestEvent::Frame(HostFrame::from_value(row.frame.clone())), row.at);
        let l = rep.liveness(row.at);
        if l.streaming {
            saw_streaming = true;
            assert!(l.line.is_some());
            max_tps = max_tps.max(l.tps.unwrap_or(0.0));
        }
    }
    assert!(saw_streaming);
    assert!(max_tps > 10.0, "tps {max_tps}");
    let end = rep.liveness(i64::MAX / 2);
    assert!(!end.streaming && !end.thinking && end.tps.is_none());
}

/// Compaction pays off on every streaming scenario (printed for the report).
#[test]
fn bandwidth_all_scenarios() {
    for (name, min) in [("01b-prompt-streaming-thinking", 4.0), ("02-bash-tool", 4.0), ("06-abort", 8.0), ("07-task-subagent", 3.0)] {
        let r = run(name);
        let ratio = r.raw_h2g as f64 / r.out_bytes as f64;
        eprintln!("{name}: raw h2g {} B → compacted {} B ({ratio:.1}×)", r.raw_h2g, r.out_bytes);
        assert!(ratio > min, "{name}: {ratio:.1}");
    }
}

fn ui_events(r: &Run) -> Vec<Option<String>> {
    r.events()
        .into_iter()
        .filter_map(|e| match e {
            SessionEvent::Ui { request } => Some(request.as_ref().map(|q| q.id.clone())),
            _ => None,
        })
        .collect()
}

/// `ui-request` opens a dialog (`Ui{Some}`), `ui-request-end` closes it (`Ui{None}`), for asks,
/// wrong-label asks and approvals; while pending, `SessionSnapshot.ui` carries it.
#[test]
fn ui_events_open_and_close() {
    for (name, id) in [("05-ask-ui-response", "2"), ("05a-ask-wrong-label", "1"), ("16-tool-approval", "1")] {
        let r = run(name);
        assert_eq!(ui_events(&r), [Some(id.to_owned()), None], "{name}");
        assert!(r.replica.snapshot(10).ui.is_none(), "{name}: closed");
        assert!(r.mirror.ui.is_none());

        // Replay up to (and including) the ui-request: snapshot.ui is filled.
        let base = load("00-join");
        let (at0, snap) = snapshot_from(&base, false).unwrap();
        let mut rep = Replica::new("x");
        rep.apply(&GuestEvent::Snapshot(snap.clone()), at0);
        let rows = load(name);
        let mut opened = None;
        for row in rows.iter().filter(|r| r.dir == "h2g") {
            let up = rep.apply(&GuestEvent::Frame(HostFrame::from_value(row.frame.clone())), row.at);
            if row.frame["t"] == "ui-request" {
                opened = up.events.iter().find_map(|e| match e {
                    SessionEvent::Ui { request } => request.clone(),
                    _ => None,
                });
                break;
            }
        }
        let opened = opened.unwrap_or_else(|| panic!("{name}: no Ui event on ui-request"));
        assert_eq!(opened.id, id);
        let s = rep.snapshot(10);
        assert_eq!(s.ui.as_ref(), Some(&opened), "{name}: snapshot.ui");

        // Resync while pending: Reset clears it (snapshot.ui = None), the host re-sends the
        // ui-request after the snapshot → Ui{Some} again.
        let up = rep.apply(&GuestEvent::Snapshot(Snapshot { resync: true, ..snap }), at0);
        assert!(matches!(&up.events[..], [SessionEvent::Reset { snapshot }] if snapshot.ui.is_none()));
        let req = rows.iter().find(|r| r.frame["t"] == "ui-request").unwrap();
        let up = rep.apply(&GuestEvent::Frame(HostFrame::from_value(req.frame.clone())), req.at);
        assert!(up.events.iter().any(|e| matches!(e, SessionEvent::Ui { request: Some(q) } if q.id == id)), "{name}: resync re-open");
        let end = rows.iter().find(|r| r.frame["t"] == "ui-request-end").unwrap();
        let up = rep.apply(&GuestEvent::Frame(HostFrame::from_value(end.frame.clone())), end.at);
        assert!(up.events.iter().any(|e| matches!(e, SessionEvent::Ui { request: None })), "{name}: close");
    }
}

/// Goal / plan mode / `/todo` edits come from the main session journal (collab mirrors neither
/// `mode_change` nor `custom` entries). Replays `omp-samples/session-lab1-main.jsonl` in
/// line-sized `fetch-transcript` chunks.
#[test]
fn journal_goal_plan_and_todo_edits() {
    let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/research/omp-samples/session-lab1-main.jsonl")).unwrap();
    let base = load("00-join");
    let (at0, snap) = snapshot_from(&base, false).unwrap();
    let mut rep = Replica::new("x");
    rep.apply(&GuestEvent::Snapshot(snap.clone()), at0);
    assert_eq!(rep.main_agent_id(), Some("Main"));
    let mut offset = 0u64;
    let mut after: Vec<(usize, Option<GoalInfo>, OmpMode, usize, bool)> = Vec::new();
    for (i, line) in raw.split_inclusive('\n').enumerate() {
        assert_eq!(rep.journal_offset(), offset);
        offset += line.len() as u64;
        let up = rep.apply_journal(&crate::guest::TranscriptChunk { text: line.to_owned(), new_size: offset, error: None });
        let meta = rep.meta();
        assert_eq!(up.meta_changed, up.events.iter().any(|e| matches!(e, SessionEvent::Meta { .. })));
        after.push((i + 1, meta.goal.clone(), meta.mode, meta.todos.len(), up.meta_changed));
    }
    let at = |line: usize| &after[line - 1];
    assert_eq!(at(19).2, OmpMode::Plan);
    assert!(at(19).4, "meta changed on plan");
    assert_eq!(at(22).2, OmpMode::PlanPaused);
    assert_eq!(at(23).2, OmpMode::Normal);
    let g = at(24).1.clone().expect("goal active");
    assert_eq!(g.objective, "Reply with the single word pong, then mark this goal complete.");
    assert_eq!((g.status.as_str(), g.tokens_used, g.budget), ("active", Some(0), None));
    assert_eq!(at(29).1.as_ref().unwrap().tokens_used, Some(8100));
    assert!(at(31).1.is_none(), "status complete clears the goal");
    assert!(at(35).1.is_none() && at(35).2 == OmpMode::Normal);
    assert_eq!(at(36).3, 1, "user_todo_edit sets todos");
    assert_eq!(rep.meta().todos[0].name, "Lab");
    // Journal lines never become transcript rows.
    assert_eq!(rep.len(), 2);

    // Resync of the same session keeps journal state and offset; rotation resets it.
    rep.apply(&GuestEvent::Snapshot(Snapshot { resync: true, ..snap.clone() }), at0);
    assert_eq!(rep.journal_offset(), offset);
    assert_eq!(rep.meta().todos[0].name, "Lab");
    let mut rotated = snap.clone();
    rotated.welcome.header.id = "other-session".into();
    rep.apply(&GuestEvent::Snapshot(rotated), at0);
    assert_eq!(rep.journal_offset(), 0);
    assert!(rep.meta().todos.is_empty());

    // goal_paused and budget-limited.
    let mut rep = Replica::new("y");
    let line = r#"{"type":"mode_change","mode":"goal_paused","data":{"goal":{"id":"g","objective":"o","status":"paused","tokensUsed":5,"tokenBudget":100,"timeUsedSeconds":1,"createdAt":1,"updatedAt":2}}}"#;
    rep.apply_journal(&crate::guest::TranscriptChunk { text: format!("{line}\n"), new_size: 10, error: None });
    let g = rep.meta().goal.clone().unwrap();
    assert_eq!((g.status.as_str(), g.tokens_used, g.budget), ("paused", Some(5), Some(100)));
    let line = line.replace("goal_paused", "goal").replace(r#""status":"paused""#, r#""status":"budget-limited""#);
    rep.apply_journal(&crate::guest::TranscriptChunk { text: format!("{line}\n"), new_size: 20, error: None });
    assert_eq!(rep.meta().goal.as_ref().unwrap().status, "budget-limited");
    // Errors are ignored; the offset stays.
    rep.apply_journal(&crate::guest::TranscriptChunk { text: String::new(), new_size: 0, error: Some("x".into()) });
    assert_eq!(rep.journal_offset(), 20);
}

/// Collab cuts a replicated entry over 1 MiB down to string prefixes, so a big pasted screenshot
/// arrives as `<base64 prefix>\n…[N chars elided for collab session]`; the journal keeps the image
/// as an omp blob. Whichever of the two arrives first, the row ends up with the blob, and history
/// pages read from the journal carry it too.
#[test]
fn cut_images_take_the_journal_blob() {
    let base = load("00-join");
    let (at0, snap) = snapshot_from(&base, false).unwrap();
    let hash = "69c53c63153a19ab8865c53aa3ff3f181aa4e4a7af7ab19308567f1569f97e75";
    let row = |data: &str| {
        serde_json::json!({
            "type": "custom_message", "id": "e920858c", "customType": "collab-prompt", "display": true,
            "details": { "from": "TeleFlock" }, "attribution": "user", "timestamp": "2026-10-21T17:11:08.264Z",
            "content": [{ "type": "text", "text": "2 columns wide" }, { "type": "image", "mimeType": "image/png", "data": data }],
        })
    };
    let cut = row("iVBORw0KGgoAAAANSUhEUgAACf4AAAVt\n…[1062044 chars elided for collab session]");
    let journal = format!("{}\n", row(&format!("blob:sha256:{hash}")));
    let chunk = crate::guest::TranscriptChunk { text: journal.clone(), new_size: journal.len() as u64, error: None };
    let image = |rep: &Replica| match rep.item("u1792602668264") {
        Some(TranscriptItem::User(u)) => u.images[0].clone(),
        other => panic!("no user row: {other:?}"),
    };

    // Live entry first: no payload until the journal catches up, then the row is upserted with the blob.
    let mut rep = Replica::new("x");
    rep.apply(&GuestEvent::Snapshot(snap.clone()), at0);
    rep.apply(&GuestEvent::Frame(HostFrame::Entry { entry: cut.clone() }), at0);
    let img = image(&rep);
    assert!(img.data.is_none() && img.url.is_none() && img.blob.is_none(), "a cut payload is not an image: {img:?}");
    let up = rep.apply_journal(&chunk);
    assert!(
        up.events.iter().any(|e| matches!(e, SessionEvent::Upsert { item: TranscriptItem::User(u) } if u.images[0].blob.as_deref() == Some(hash))),
        "{:?}",
        up.events
    );
    assert_eq!(image(&rep).mime, "image/png");

    // Journal first: the entry takes the blob at once.
    let mut rep = Replica::new("x");
    rep.apply(&GuestEvent::Snapshot(snap), at0);
    rep.apply_journal(&chunk);
    rep.apply(&GuestEvent::Frame(HostFrame::Entry { entry: cut }), at0);
    assert_eq!(image(&rep).blob.as_deref(), Some(hash));

    // History pages read the journal directly.
    let page = super::transcript_page(&journal);
    let Some(TranscriptItem::User(u)) = page.items.first() else { panic!("{:?}", page.items) };
    assert_eq!((u.images[0].blob.as_deref(), u.images[0].data.as_deref()), (Some(hash), None));
}

fn irc_rows(rows: &[TranscriptItem]) -> Vec<(String, IrcMessage, Option<ToolStatus>)> {
    rows.iter()
        .filter_map(|i| match i {
            TranscriptItem::Irc(r) => Some((r.id.clone(), r.message.clone(), None)),
            TranscriptItem::Tool(t) => match &t.view {
                Some(ToolView::Irc(m)) => Some((t.id.clone(), m.clone(), Some(t.status))),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

/// IRC (agent ↔ agent messages). Main spawns `Pinger`, consumes its ping with `wait` (inbound via
/// the tool result) and answers with `write agent://Pinger` (outbound, receipt `woken`).
#[test]
fn s18_irc_wait_and_send() {
    let r = run("18-irc");
    r.check_mirror();
    let irc = irc_rows(&r.rows());
    assert_eq!(irc.len(), 2, "{irc:#?}");
    let (_, ping, status) = &irc[0];
    assert_eq!((ping.direction, ping.peer.as_str(), ping.text.as_str()), (IrcDirection::In, "Pinger", "ping from Pinger: what is 2+2?"));
    assert_eq!(ping.message_id.as_deref(), Some("15aec6c15b16073c"));
    assert_eq!(*status, Some(ToolStatus::Ok), "carried by the wait call");
    // The row is stamped with the wait call's start; omp's send time rides along.
    assert_eq!(ping.sent_at, Some(1792576697708));
    let wait_at = r.rows().iter().find_map(|i| match i {
        TranscriptItem::Tool(t) if t.tool == "wait" => Some(t.at),
        _ => None,
    });
    assert!(wait_at.is_some_and(|at| at < 1792576697708), "wait started before the ping was sent");
    let (_, pong, status) = &irc[1];
    assert_eq!((pong.direction, pong.peer.as_str(), pong.text.as_str()), (IrcDirection::Out, "Pinger", "pong from Main: 4"));
    assert_eq!(pong.sent_at, None, "sends are stamped by the call");
    assert_eq!(pong.receipts, vec![IrcReceipt { to: "Pinger".into(), outcome: "woken".into(), error: None }]);
    assert_eq!(*status, Some(ToolStatus::Ok));
    // A message write is not a file edit.
    assert!(r.replica.meta().files.iter().all(|f| !f.path.starts_with("agent:")));
}

/// IRC to an idle main agent: the ping arrives as an `irc:incoming` custom message (live event
/// and entry share the row), wakes Main, and Main answers with `write agent://Pinger-2`.
#[test]
fn s18b_irc_incoming_wakes_main() {
    let r = run("18b-irc-incoming");
    r.check_mirror();
    let rows = r.rows();
    let irc = irc_rows(&rows);
    assert_eq!(irc.len(), 2, "{irc:#?}");
    let (id, ping, status) = &irc[0];
    assert_eq!(id, "u1792576920212");
    assert_eq!((ping.direction, ping.peer.as_str(), ping.text.as_str()), (IrcDirection::In, "Pinger-2", "ping from Pinger: what is 3+3?"));
    assert_eq!((ping.message_id.as_deref(), ping.from_parent, ping.wake_relay), (Some("15aec79aa5160741"), false, false));
    assert_eq!(*status, None, "a transcript row of its own");
    assert_eq!(ping.sent_at, Some(1792576920212));
    let (_, pong, _) = &irc[1];
    assert_eq!((pong.direction, pong.peer.as_str(), pong.text.as_str()), (IrcDirection::Out, "Pinger-2", "pong from Main: 6"));
    // No "System turn" (synthetic user row) for the IRC message.
    assert!(!rows.iter().any(|i| matches!(i, TranscriptItem::User(u) if u.author.as_deref() == Some("irc:incoming"))));
    assert!(r.signals().iter().any(|s| matches!(s, Signal::Prompted { author: Some(a), .. } if a == "Pinger-2 via IRC")));
}

/// The subagent's side (its session file, as `agent.subagentTranscript` reads it): the ping it
/// sent its parent, and the parent's answer (`irc:incoming` with `fromParent`).
#[test]
fn irc_subagent_transcript() {
    let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/research/omp-samples/session-irc-subagent.jsonl")).unwrap();
    let page = super::transcript_page(&raw);
    let irc = irc_rows(&page.items);
    assert_eq!(irc.len(), 2, "{irc:#?}");
    assert_eq!((irc[0].1.direction, irc[0].1.peer.as_str(), irc[0].1.text.as_str()), (IrcDirection::Out, "Main", "ping from Pinger: what is 3+3?"));
    assert_eq!((irc[1].1.direction, irc[1].1.peer.as_str(), irc[1].1.text.as_str()), (IrcDirection::In, "Main", "pong from Main: 6"));
    assert!(irc[1].1.from_parent);
}
