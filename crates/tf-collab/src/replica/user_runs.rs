//! omp's quick commands in the transcript. A shell command (`!cmd`, `!!cmd`) or Python (`$ code`,
//! `$$ code`) the user ran in omp's composer, typed there or sent with `agent.shell`, is a
//! `bashExecution` / `pythonExecution` message: `{command | code, output, exitCode?, cancelled,
//! truncated, excludeFromContext?, timestamp}`. Its row is a tool row with `userRun`, keyed
//! `x<timestamp>`, built the same from the live `message_end` (TeleFlock's bridge ≥ 2.5.0 reports
//! each run as omp records it, mid-turn too) and from the session file's entry (omp appends a run
//! made during a turn once the turn ends), so the two reconcile into one row.

use serde_json::Value;
use tf_proto::{BashView, Millis, ToolItem, ToolStatus, ToolView, UserRun};

use super::util::{b, clip, first_line, s};

/// One of omp's message roles for the user's quick commands.
pub(super) fn is_user_run(role: &str) -> bool {
    matches!(role, "bashExecution" | "pythonExecution")
}

/// The row of omp's `bashExecution` / `pythonExecution` message `msg`, recorded at `at` (its
/// `timestamp`).
pub(super) fn row(msg: &Value, at: Millis) -> ToolItem {
    let python = s(msg, "role") == Some("pythonExecution");
    let command = s(msg, if python { "code" } else { "command" }).unwrap_or_default().to_owned();
    let (output, capped) = super::cap_output(s(msg, "output").unwrap_or_default());
    let exit_code = msg.get("exitCode").and_then(Value::as_i64).and_then(|c| i32::try_from(c).ok());
    let status = if b(msg, "cancelled") {
        ToolStatus::Aborted
    } else if exit_code.is_some_and(|c| c != 0) {
        ToolStatus::Error
    } else {
        ToolStatus::Ok
    };
    let id = format!("x{at}");
    ToolItem {
        call_id: id.clone(),
        id,
        at,
        tool: if python { "python" } else { "bash" }.into(),
        title: clip(first_line(&command), 160),
        intent: None,
        // The view holds the command; omp records no arguments beside it.
        args: Value::Null,
        status,
        duration_ms: None,
        output: None,
        truncated: b(msg, "truncated") || capped,
        view: Some(ToolView::Bash(BashView { command, cwd: None, output, exit_code, background: false, timed_out: false })),
        error: None,
        artifact: None,
        user_run: Some(UserRun { python, excluded: b(msg, "excludeFromContext") }),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::{json, Value};
    use tf_proto::*;

    use crate::frame::{HostFrame, SessionHeader, SessionState, Welcome};
    use crate::guest::{GuestEvent, Snapshot};
    use crate::replica::{Replica, OUTPUT_CAP};

    const SID: &str = "01a18769-c0ed-73ef-b9e0-c7c8190764dd";
    const T0: Millis = 1_793_400_000_000;

    /// A replica fed frame by frame, and a client that applies only what it emitted.
    struct Live {
        r: Replica,
        order: Vec<String>,
        items: HashMap<String, TranscriptItem>,
        now: Millis,
    }

    impl Live {
        fn new() -> Live {
            Live { r: Replica::new("agent"), order: Vec::new(), items: HashMap::new(), now: T0 }
        }

        /// Applies `ev`; the rows it upserted.
        fn apply(&mut self, ev: GuestEvent) -> Vec<String> {
            self.now += 10;
            let mut upserted = Vec::new();
            for e in self.r.apply(&ev, self.now).events {
                match e {
                    SessionEvent::Reset { snapshot } => {
                        self.order = snapshot.items.iter().map(|i| i.id().to_owned()).collect();
                        self.items = snapshot.items.into_iter().map(|i| (i.id().to_owned(), i)).collect();
                    }
                    SessionEvent::Upsert { item, .. } => {
                        upserted.push(item.id().to_owned());
                        if !self.items.contains_key(item.id()) {
                            self.order.push(item.id().to_owned());
                        }
                        self.items.insert(item.id().to_owned(), item);
                    }
                    SessionEvent::Append { id, text, .. } => match self.items.get_mut(&id) {
                        Some(TranscriptItem::Assistant(a)) => a.text.push_str(&text),
                        other => panic!("append to {id}: {other:?}"),
                    },
                    _ => {}
                }
            }
            upserted
        }

        fn event(&mut self, ev: Value) -> Vec<String> {
            self.apply(GuestEvent::Frame(HostFrame::Event { event: ev }))
        }

        fn entry(&mut self, msg: &Value) -> Vec<String> {
            self.apply(GuestEvent::Frame(HostFrame::Entry { entry: entry(msg) }))
        }

        /// The client's rows, checked against the replica's own.
        fn rows(&self) -> Vec<TranscriptItem> {
            let mine: Vec<TranscriptItem> = self.order.iter().map(|id| self.items[id].clone()).collect();
            assert_eq!(mine, self.r.snapshot(usize::MAX).items, "the client's rows equal the replica's");
            mine
        }

        fn run(&self, id: &str) -> ToolItem {
            match self.items.get(id) {
                Some(TranscriptItem::Tool(t)) => t.clone(),
                other => panic!("no tool row {id}: {other:?}"),
            }
        }
    }

    fn snapshot(entries: Vec<Value>) -> GuestEvent {
        let header = SessionHeader { id: SID.into(), timestamp: "2026-10-29T10:00:00.000Z".into(), cwd: "/w".into(), title: None, extra: Default::default() };
        let welcome = Welcome { proto: crate::COLLAB_PROTO, header, state: SessionState::default(), agents: Vec::new(), entry_count: entries.len() as u64, read_only: false };
        GuestEvent::Snapshot(Snapshot { welcome, entries, resync: true })
    }

    /// omp's session-file line of `msg` (entry timestamps are ISO, the message's own is epoch ms).
    fn entry(msg: &Value) -> Value {
        json!({ "type": "message", "id": format!("e{}", msg["timestamp"]), "parentId": null, "timestamp": "2026-10-29T10:00:05.000Z", "message": msg })
    }

    /// A replica rebuilt from the session file (a resync, or a tf-hostd restart).
    fn rebuilt(msgs: &[&Value]) -> Live {
        let mut fresh = Live::new();
        fresh.apply(snapshot(msgs.iter().map(|m| entry(m)).collect()));
        fresh
    }

    fn user(t: Millis, text: &str) -> Value {
        json!({ "role": "user", "content": [{ "type": "text", "text": text }], "timestamp": t })
    }

    fn reply(t: Millis, text: &str) -> Value {
        json!({ "role": "assistant", "content": [{ "type": "text", "text": text }], "stopReason": "stop", "model": "claude-opus-5", "timestamp": t,
            "usage": { "input": 120, "output": 8, "cacheRead": 0, "cacheWrite": 0, "cost": { "total": 0.0004 } } })
    }

    /// omp's record of `!command` (`excluded`: `!!command`).
    fn bash(t: Millis, command: &str, output: &str, exit_code: Option<i64>, excluded: bool) -> Value {
        let mut msg = json!({ "role": "bashExecution", "command": command, "output": output, "cancelled": false, "truncated": false,
            "meta": { "truncation": null }, "timestamp": t });
        if let Some(code) = exit_code {
            msg["exitCode"] = json!(code);
        }
        if excluded {
            msg["excludeFromContext"] = json!(true);
        }
        msg
    }

    /// omp's record of `$ code` (`excluded`: `$$ code`).
    fn python(t: Millis, code: &str, output: &str, excluded: bool) -> Value {
        let mut msg = json!({ "role": "pythonExecution", "code": code, "output": output, "exitCode": 0, "cancelled": false, "truncated": false, "timestamp": t });
        if excluded {
            msg["excludeFromContext"] = json!(true);
        }
        msg
    }

    #[test]
    fn a_shell_run_is_one_row_from_its_live_report_and_its_entry() {
        let ls = bash(T0 + 5, "ls --color", "\x1b[1;34msrc\x1b[0m  README.md\n", Some(0), false);
        let mut live = Live::new();
        live.apply(snapshot(Vec::new()));
        // The bridge reports the run as omp records it.
        assert_eq!(live.event(json!({ "type": "message_end", "message": ls })), [format!("x{}", T0 + 5)]);
        let row = live.run(&format!("x{}", T0 + 5));
        assert_eq!(
            row,
            ToolItem {
                id: format!("x{}", T0 + 5),
                at: T0 + 5,
                call_id: format!("x{}", T0 + 5),
                tool: "bash".into(),
                title: "ls --color".into(),
                intent: None,
                args: Value::Null,
                status: ToolStatus::Ok,
                duration_ms: None,
                output: None,
                truncated: false,
                view: Some(ToolView::Bash(BashView {
                    command: "ls --color".into(),
                    cwd: None,
                    output: "\x1b[1;34msrc\x1b[0m  README.md\n".into(),
                    exit_code: Some(0),
                    background: false,
                    timed_out: false,
                })),
                error: None,
                artifact: None,
                user_run: Some(UserRun { python: false, excluded: false }),
            }
        );
        // Its session-file entry is the same message: nothing changes, nothing is sent again.
        assert!(live.entry(&ls).is_empty());
        assert_eq!(live.rows(), [TranscriptItem::Tool(row.clone())]);
        // A run typed in omp's TUI under an older bridge reaches the replica as its entry alone.
        assert_eq!(rebuilt(&[&ls]).rows(), [TranscriptItem::Tool(row)]);
    }

    #[test]
    fn a_run_during_a_turn_lands_live_and_its_entry_after_the_turn_settles_it() {
        let prompt = user(T0 + 1, "fix the parser");
        let answer = reply(T0 + 3, "Fixed.");
        let status = bash(T0 + 2, "git status", "On branch main\n", Some(0), true);
        let mut live = Live::new();
        live.apply(snapshot(Vec::new()));
        live.event(json!({ "type": "agent_start" }));
        live.event(json!({ "type": "message_start", "message": prompt }));
        live.event(json!({ "type": "message_end", "message": prompt }));
        live.entry(&prompt);
        // `!!git status` typed while the agent works: reported at once, written after the turn.
        live.event(json!({ "type": "message_end", "message": status }));
        live.event(json!({ "type": "message_start", "message": answer }));
        live.event(json!({ "type": "message_end", "message": answer }));
        live.entry(&answer);
        live.event(json!({ "type": "agent_end" }));
        assert!(live.entry(&status).is_empty(), "the entry settles the row the live report built");
        let ids: Vec<String> = live.rows().iter().map(|i| i.id().to_owned()).collect();
        let run = format!("x{}", T0 + 2);
        assert_eq!(ids, [format!("u{}", T0 + 1), run.clone(), format!("a{}.0", T0 + 3)]);
        assert_eq!(live.run(&run).user_run, Some(UserRun { python: false, excluded: true }));
        // Rebuilt from the file the run comes after the turn, as omp wrote it, and is the same row.
        let fresh = rebuilt(&[&prompt, &answer, &status]);
        assert_eq!(fresh.rows().iter().map(|i| i.id().to_owned()).collect::<Vec<_>>(), [format!("u{}", T0 + 1), format!("a{}.0", T0 + 3), run.clone()]);
        assert_eq!(fresh.run(&run), live.run(&run));
    }

    #[test]
    fn python_runs_failures_and_cancelled_runs() {
        let mut live = Live::new();
        live.apply(snapshot(Vec::new()));
        // `$$ …`: Python whose output stays out of the agent's context.
        let py = python(T0 + 1, "import sys\nprint(sys.version)", "3.13.1\n", true);
        live.event(json!({ "type": "message_end", "message": py }));
        let row = live.run(&format!("x{}", T0 + 1));
        assert_eq!((row.tool.as_str(), row.title.as_str(), row.status), ("python", "import sys", ToolStatus::Ok));
        assert_eq!(row.user_run, Some(UserRun { python: true, excluded: true }));
        let Some(ToolView::Bash(v)) = &row.view else { panic!("{row:?}") };
        assert_eq!((v.command.as_str(), v.output.as_str()), ("import sys\nprint(sys.version)", "3.13.1\n"));
        // A command that failed shows its exit code; one omp cancelled is aborted.
        live.event(json!({ "type": "message_end", "message": bash(T0 + 2, "false", "", Some(1), false) }));
        let failed = live.run(&format!("x{}", T0 + 2));
        assert_eq!(failed.status, ToolStatus::Error);
        assert!(matches!(&failed.view, Some(ToolView::Bash(v)) if v.exit_code == Some(1) && v.output.is_empty()));
        let mut stopped = bash(T0 + 3, "sleep 60", "", None, false);
        stopped["cancelled"] = json!(true);
        live.event(json!({ "type": "message_end", "message": stopped }));
        assert_eq!(live.run(&format!("x{}", T0 + 3)).status, ToolStatus::Aborted);
        // Output past the replica's cap keeps its tail, as omp's own truncation does.
        let long = format!("{}end\n", "x".repeat(OUTPUT_CAP));
        live.event(json!({ "type": "message_end", "message": bash(T0 + 4, "yes", &long, Some(0), false) }));
        let capped = live.run(&format!("x{}", T0 + 4));
        assert!(capped.truncated);
        assert!(matches!(&capped.view, Some(ToolView::Bash(v)) if v.output.len() == OUTPUT_CAP && v.output.ends_with("end\n")));
        assert_eq!(live.rows().len(), 4);
    }
}
