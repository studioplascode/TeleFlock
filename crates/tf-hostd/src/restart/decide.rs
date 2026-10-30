//! How a brought-back agent goes on (architecture §3.25): the decision table over how its session
//! stood when its omp ended ([`detect::Ended`](super::detect::Ended)) and what hostd saw of it last
//! ([`Seen`]), and the note an agent gets when going on by itself could repeat something.
//!
//! | how it stood | going on |
//! |---|---|
//! | idle | nothing: `--resume` alone |
//! | mid-turn, every call omp would run again only reads ([`safe`]) | omp's restore (runs them again) |
//! | mid-turn, a call that changes something (bash, eval, edit, write, …) or an unknown tool | no re-run: one note |
//! | a reply cut off while it was being written (busy when last seen) | omp's retry (the reply is written again) |
//! | subagents cut off mid-turn or in a reply | the safe ones by omp's restore or retry, the others named in the note |
//! | background jobs (bash, eval) were running | their handles are gone: the note says so |
//!
//! omp's restore re-executes the last tool batch verbatim when none of its calls returned a result
//! (`toolReplayStart`): after the 13:58 incident it would have run `herdr server stop` again. So a
//! turn goes on by itself only when every call it would repeat is in [`safe`]'s list.

use serde::{Deserialize, Serialize};

use tf_proto::autoresume::EndedTurn;
use tf_proto::Millis;

use super::detect::{Call, Ended, Sub, Turn};

/// Tools whose calls only read: running one again changes nothing. `task` is not one: running a
/// cut-off `task` call again would start its subagents a second time (omp's restore brings the
/// cut-off subagents back itself, each by these rules).
const READ_ONLY: &[&str] = &["read", "grep", "search", "glob", "find", "ls", "ast_grep", "web_search", "fetch", "web_fetch", "wait", "think", "recall"];
/// `lsp` actions that only ask (`rename`, `rename_file`, `code_actions`, `reload` and raw
/// `request`s can change files or the server).
const LSP_QUERIES: &[&str] = &["diagnostics", "definition", "references", "hover", "symbols", "type_definition", "implementation", "status", "capabilities"];
/// A note names at most this many calls or subagents of each kind.
const NAMED: usize = 4;

/// A call omp may run again without harm.
pub fn safe(call: &Call) -> bool {
    match call.name.as_str() {
        "lsp" => call.action.as_deref().is_some_and(|a| LSP_QUERIES.contains(&a)),
        name => READ_ONLY.contains(&name),
    }
}

/// What hostd saw of the agent last (its ledger entry).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Seen {
    /// It was working (or writing a reply): a reply cut off then was not stopped by the user.
    pub busy: bool,
    /// Background jobs it had running that omp's restore does not bring back (`bash: npm test`).
    pub jobs: Vec<String>,
}

/// How it goes on once it runs again (kept in the ledger until done).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// What it was doing (the card's `ended.turn`).
    pub turn: EndedTurn,
    /// omp's restore of its own turn: every call it repeats only reads.
    #[serde(default)]
    pub restore_turn: bool,
    /// Subagents brought back first, parents first: cut off mid-turn and safe (omp's restore), or
    /// cut off in a reply while the agent was busy (omp's retry; `restoreSelect` bridges).
    #[serde(default)]
    pub restore_subagents: Vec<String>,
    /// omp's retry of its cut-off reply.
    #[serde(default)]
    pub retry: bool,
    /// The note it gets once it is live on its bridge.
    #[serde(default)]
    pub note: Option<String>,
    /// The card's `ended.lastAction`: the call(s) it was in.
    #[serde(default)]
    pub last_action: Option<String>,
    /// omp never wrote its session file (it writes it with the first reply): it comes back as a
    /// new session in the same place, with the prompts it had been given (`ledger::Entry::prompts`).
    #[serde(default)]
    pub fresh: bool,
}

impl Plan {
    /// Nothing but `--resume`.
    pub fn idle() -> Self {
        Self { turn: EndedTurn::Idle, restore_turn: false, restore_subagents: Vec::new(), retry: false, note: None, last_action: None, fresh: false }
    }

    /// Anything to do once it runs again.
    pub fn any(&self) -> bool {
        self.restore_turn || self.retry || self.fresh || self.note.is_some() || !self.restore_subagents.is_empty()
    }

    /// The note follows a turn that goes on by itself (restored or retried): it is queued as a
    /// follow-up; otherwise it is the prompt that goes on.
    pub fn note_follows(&self) -> bool {
        self.restore_turn || self.retry
    }
}

/// What the agent's bridge can do once it is back (`hello.caps`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Can {
    /// omp's restore for the whole session (`restore`): its turn and every revivable subagent.
    pub restore: bool,
    /// omp's restore for chosen parts (`restoreSelect`).
    pub select: bool,
}

impl Can {
    pub const ALL: Can = Can { restore: true, select: true };
}

/// The plan for a session that ended at `at` (host clock) because of `reason` ("herdr stopped").
pub fn decide(e: &Ended, seen: &Seen, at: Millis, reason: &str, can: Can) -> Plan {
    let root = &e.root;
    let root_safe = root.replay.iter().all(safe);
    let turn = if root.restorable {
        EndedTurn::Working
    } else if root.cut_reply && seen.busy {
        EndedTurn::Replying
    } else {
        EndedTurn::Idle
    };
    // Subagents cut off mid-turn go on by omp's restore when what it repeats only reads; one cut
    // off in a reply (its transcript records no exit; the parent was busy) by omp's retry, which
    // only a bridge that restores chosen parts does. Everything else is named in the note.
    let can_go_on = |s: &Sub| {
        let quiet = s.turn.replay.iter().all(safe);
        if s.turn.restorable { quiet && (can.select || can.restore) } else { quiet && s.turn.cut_reply && seen.busy && can.select }
    };
    let cut: Vec<&Sub> = e.subagents.iter().filter(|s| s.turn.restorable || (s.turn.cut_reply && seen.busy)).collect();
    // omp's whole-session restore (no `restoreSelect`) revives every cut-off subagent with the
    // turn: only when none is left out, and never on its own.
    let restore_turn = turn == EndedTurn::Working && root_safe && cut.iter().all(|s| can_go_on(s)) && (can.select || can.restore);
    let goes = |s: &Sub| (can.select || restore_turn) && can_go_on(s);
    let (restored, left): (Vec<&Sub>, Vec<&Sub>) = cut.into_iter().partition(|s| goes(s));
    let mut plan = Plan {
        turn,
        restore_turn,
        restore_subagents: restored.iter().map(|s| s.id.clone()).collect(),
        retry: turn == EndedTurn::Replying && root_safe,
        note: None,
        last_action: last_action(root),
        fresh: false,
    };
    let stays = match turn {
        EndedTurn::Working => !plan.restore_turn,
        EndedTurn::Replying => !plan.retry,
        EndedTurn::Idle => false,
    };
    if stays || !left.is_empty() || !seen.jobs.is_empty() {
        plan.note = Some(note(at, reason, root, &plan, &left, &seen.jobs));
    }
    plan
}

/// `bash: sleep 30; echo done >> c.out` (one call), else the first few joined.
fn labels(calls: &[Call]) -> String {
    let mut out: Vec<String> = calls.iter().take(NAMED).map(Call::label).collect();
    if calls.len() > NAMED {
        out.push(format!("{} more", calls.len() - NAMED));
    }
    out.join("; ")
}

/// The call(s) the agent was in: the ones that never returned, else the batch omp would repeat.
fn last_action(t: &Turn) -> Option<String> {
    if !t.pending.is_empty() {
        Some(labels(&t.pending))
    } else if t.restorable && !t.replay.is_empty() {
        Some(labels(&t.replay))
    } else {
        None
    }
}

/// `13:58` in the host's time zone.
pub fn hhmm(at: Millis) -> String {
    use chrono::TimeZone;
    match chrono::Local.timestamp_millis_opt(at) {
        chrono::LocalResult::Single(t) | chrono::LocalResult::Ambiguous(t, _) => t.format("%H:%M").to_string(),
        chrono::LocalResult::None => "an unknown time".into(),
    }
}

const JOBS_GONE: &str = "handles of background jobs started before are gone; their processes may still be running or may have finished — check processes and output files before re-running anything.";

/// The note (see the module docs); one paragraph.
fn note(at: Millis, reason: &str, root: &Turn, plan: &Plan, left: &[&Sub], jobs: &[String]) -> String {
    let mut s = format!("Your previous process ended unexpectedly at {} ({reason}).", hhmm(at));
    if plan.note_follows() {
        let how = if plan.retry { "Your cut-off reply was started again" } else { "Your turn went on where it stopped" };
        s.push_str(&format!(" {how}, but {JOBS_GONE}"));
    } else if let Some(calls) = [&root.pending, &root.replay].into_iter().find(|c| !c.is_empty()).filter(|_| plan.turn == EndedTurn::Working || !root.pending.is_empty()) {
        // A call killed with its process returned an error result just before omp ended; one
        // that never returned has none. Either may or may not have done its work.
        let noun = if calls.len() == 1 { "Its last action" } else { "Its last actions" };
        s.push_str(&format!(" {noun} ({}) may or may not have run, and {JOBS_GONE}", labels(calls)));
    } else if plan.turn == EndedTurn::Replying {
        s.push_str(&format!(" Your reply was cut off, and {JOBS_GONE}"));
    } else {
        let mut gone = JOBS_GONE.to_string();
        gone[..1].make_ascii_uppercase();
        s.push_str(&format!(" {gone}"));
    }
    if !jobs.is_empty() {
        let mut named: Vec<&str> = jobs.iter().take(NAMED).map(String::as_str).collect();
        let more = (jobs.len() > NAMED).then(|| format!("{} more", jobs.len() - NAMED));
        named.extend(more.as_deref());
        s.push_str(&format!(" Background jobs it had running: {}.", named.join("; ")));
    }
    if !left.is_empty() {
        let mut named: Vec<String> = left
            .iter()
            .take(NAMED)
            .map(|sub| match last_action(&sub.turn) {
                Some(a) => format!("{} ({a})", sub.id),
                None => sub.id.clone(),
            })
            .collect();
        if left.len() > NAMED {
            named.push(format!("{} more", left.len() - NAMED));
        }
        s.push_str(&format!(" Subagents it was running were not restored: {}; check what they did before starting them again.", named.join(", ")));
    }
    if !plan.note_follows() && !plan.restore_subagents.is_empty() {
        s.push_str(&format!(" Restored and running again as background jobs: {}.", plan.restore_subagents.join(", ")));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::restart::detect::{Exit, ExitKind};

    fn call(name: &str, what: &str) -> Call {
        Call { id: Some(format!("c-{name}")), name: name.into(), what: Some(what.into()), action: None }
    }

    /// Mid-turn in `calls` (none returned).
    fn cut(calls: Vec<Call>) -> Turn {
        Turn {
            restorable: true,
            cut_reply: false,
            replay: calls.clone(),
            pending: calls,
            exit: Some(Exit { kind: ExitKind::Signal, reason: "SIGHUP".into(), at: Some(1) }),
        }
    }

    fn ended(root: Turn, subagents: Vec<Sub>) -> Ended {
        Ended { session_id: Some("s".into()), root, subagents }
    }

    const AT: Millis = 1_793_000_000_000;
    const ALL: Can = Can::ALL;

    #[test]
    fn read_only_tools_are_safe_to_repeat() {
        for t in ["read", "grep", "search", "glob", "find", "ls", "ast_grep", "web_search", "fetch", "wait"] {
            assert!(safe(&call(t, "x")), "{t}");
        }
        for t in ["bash", "eval", "edit", "write", "ast_edit", "task", "browser", "computer", "github", "todo", "mcp__git_commit", "something_new"] {
            assert!(!safe(&call(t, "x")), "{t}");
        }
        let lsp = |a: &str| Call { action: Some(a.into()), ..call("lsp", "") };
        assert!(safe(&lsp("references")) && safe(&lsp("diagnostics")) && safe(&lsp("hover")));
        assert!(!safe(&lsp("rename")) && !safe(&lsp("code_actions")) && !safe(&lsp("request")));
        assert!(!safe(&Call { action: None, ..call("lsp", "") }), "an lsp call that does not say what it does");
    }

    #[test]
    fn idle_resumes_alone() {
        let p = decide(&ended(Turn::default(), vec![]), &Seen::default(), AT, "herdr stopped", ALL);
        assert_eq!(p, Plan::idle());
        assert!(!p.any());
    }

    #[test]
    fn a_safe_turn_is_restored() {
        let p = decide(&ended(cut(vec![call("wait", "")]), vec![]), &Seen { busy: true, jobs: vec![] }, AT, "herdr stopped", ALL);
        assert_eq!(p.turn, EndedTurn::Working);
        assert!(p.restore_turn && !p.retry && p.note.is_none());
        assert_eq!(p.last_action.as_deref(), Some("wait"));
        // Waiting for the model (a prompt or results it never answered): nothing to repeat.
        let waiting = Turn { restorable: true, ..Turn::default() };
        assert!(decide(&ended(waiting.clone(), vec![]), &Seen::default(), AT, "x", ALL).restore_turn);
        // A bridge without omp's restore: the turn goes on by the note instead.
        let p = decide(&ended(waiting, vec![]), &Seen::default(), AT, "x", Can::default());
        assert!(!p.restore_turn && p.note.is_some());
    }

    #[test]
    fn an_unsafe_call_is_never_repeated_and_the_agent_is_told() {
        let bash = call("bash", "sleep 30; echo done >> /tmp/tf-lab-lifeboat/c.out");
        let p = decide(&ended(cut(vec![bash]), vec![]), &Seen { busy: true, jobs: vec![] }, AT, "herdr stopped", ALL);
        assert!(!p.restore_turn && !p.retry);
        assert_eq!(p.last_action.as_deref(), Some("bash: sleep 30; echo done >> /tmp/tf-lab-lifeboat/c.out"));
        let note = p.note.unwrap();
        assert_eq!(
            note,
            format!(
                "Your previous process ended unexpectedly at {} (herdr stopped). Its last action (bash: sleep 30; echo done >> /tmp/tf-lab-lifeboat/c.out) may or may not have run, and handles of background jobs started before are gone; their processes may still be running or may have finished — check processes and output files before re-running anything.",
                hhmm(AT)
            )
        );
        // A safe call next to an unsafe one in the same batch: omp would repeat both.
        let mixed = decide(&ended(cut(vec![call("read", "a.rs"), call("edit", "b.rs")]), vec![]), &Seen::default(), AT, "x", ALL);
        assert!(!mixed.restore_turn);
        assert!(mixed.note.unwrap().contains("Its last actions (read: a.rs; edit: b.rs) may or may not have run"));
        // The bash returned an error just before omp ended (SIGHUP kills the pane's process group:
        // the command first) and the model never answered: still not repeated, and it may or may
        // not have done its work.
        let answered = Turn { pending: vec![], ..cut(vec![call("bash", "git push")]) };
        let p = decide(&ended(answered, vec![]), &Seen::default(), AT, "x", ALL);
        assert!(!p.restore_turn);
        assert!(p.note.unwrap().contains("Its last action (bash: git push) may or may not have run, and handles of background jobs"));
    }

    #[test]
    fn a_cut_off_reply_is_retried_unless_the_user_stopped_it() {
        // Whether or not omp recorded an exit (a first reply cut off has none).
        let reply = Turn { cut_reply: true, ..Turn::default() };
        let p = decide(&ended(reply.clone(), vec![]), &Seen { busy: true, jobs: vec![] }, AT, "herdr stopped", ALL);
        assert_eq!(p.turn, EndedTurn::Replying);
        assert!(p.retry && p.note.is_none());
        // Idle when last seen: the user had stopped that reply (Esc) before omp ended.
        let p = decide(&ended(reply, vec![]), &Seen::default(), AT, "herdr stopped", ALL);
        assert_eq!(p, Plan::idle());
        // The batch before the reply failed entirely and would run again: no retry, a note.
        let after_failed = Turn { cut_reply: true, replay: vec![call("bash", "make deploy")], ..Turn::default() };
        let p = decide(&ended(after_failed, vec![]), &Seen { busy: true, jobs: vec![] }, AT, "x", ALL);
        assert!(!p.retry);
        assert!(p.note.unwrap().contains("Your reply was cut off"));
    }

    #[test]
    fn subagents_go_on_only_when_safe_and_are_named_otherwise() {
        let subs = vec![
            Sub { id: "Sleeper".into(), turn: Turn { restorable: true, ..Turn::default() } },
            Sub { id: "Reader".into(), turn: cut(vec![call("read", "docs/a.md")]) },
            Sub { id: "Builder".into(), turn: cut(vec![call("bash", "cargo build")]) },
        ];
        // The parent waits for them (safe), but one of them cannot go on by itself: the parent
        // gets the note instead of repeating its wait.
        let p = decide(&ended(cut(vec![call("wait", "")]), subs.clone()), &Seen { busy: true, jobs: vec![] }, AT, "herdr crashed", ALL);
        assert!(!p.restore_turn);
        assert_eq!(p.restore_subagents, ["Sleeper", "Reader"]);
        let note = p.note.unwrap();
        assert!(note.contains("Its last action (wait) may or may not have run"), "{note}");
        assert!(note.contains("Subagents it was running were not restored: Builder (bash: cargo build); check what they did"), "{note}");
        assert!(note.contains("Restored and running again as background jobs: Sleeper, Reader."), "{note}");
        // All safe: everything goes on by omp's restore, no note.
        let p = decide(&ended(cut(vec![call("wait", "")]), subs[..2].to_vec()), &Seen { busy: true, jobs: vec![] }, AT, "x", ALL);
        assert!(p.restore_turn && p.note.is_none());
        assert_eq!(p.restore_subagents, ["Sleeper", "Reader"]);
        // A bridge that restores only the whole session (no `restoreSelect`): the safe subagents
        // come back with the turn when nothing is unsafe, else none does and all are named.
        let whole = Can { restore: true, select: false };
        let p = decide(&ended(cut(vec![call("wait", "")]), subs[..2].to_vec()), &Seen { busy: true, jobs: vec![] }, AT, "x", whole);
        assert!(p.restore_turn && p.note.is_none());
        assert_eq!(p.restore_subagents, ["Sleeper", "Reader"]);
        let p = decide(&ended(cut(vec![call("wait", "")]), subs.clone()), &Seen { busy: true, jobs: vec![] }, AT, "x", whole);
        assert!(!p.restore_turn && p.restore_subagents.is_empty());
        assert!(p.note.unwrap().contains("were not restored: Sleeper, Reader (read: docs/a.md), Builder (bash: cargo build)"));
    }

    #[test]
    fn a_subagent_cut_off_in_its_reply_is_retried_while_the_parent_waits() {
        // The lab's B: waits for a subagent whose model request streamed when herdr stopped
        // (saved `aborted`, no exit record of its own).
        let sleeper = Sub { id: "Sleeper".into(), turn: Turn { cut_reply: true, ..Turn::default() } };
        let busy = Seen { busy: true, jobs: vec![] };
        let p = decide(&ended(cut(vec![call("wait", "")]), vec![sleeper.clone()]), &busy, AT, "herdr stopped", ALL);
        assert!(p.restore_turn && p.note.is_none());
        assert_eq!(p.restore_subagents, ["Sleeper"], "retried first, so the restored wait finds its job");
        // A bridge that cannot choose: it is named, and the parent does not wait in vain.
        let p = decide(&ended(cut(vec![call("wait", "")]), vec![sleeper.clone()]), &busy, AT, "x", Can { restore: true, select: false });
        assert!(!p.restore_turn && p.restore_subagents.is_empty());
        assert!(p.note.unwrap().contains("were not restored: Sleeper;"));
        // The parent was idle: that reply had been stopped before; nothing to bring back.
        let p = decide(&ended(Turn::default(), vec![sleeper]), &Seen::default(), AT, "x", ALL);
        assert_eq!(p, Plan::idle());
    }

    #[test]
    fn lost_background_jobs_are_mentioned() {
        let seen = Seen { busy: false, jobs: vec!["bash: npm test -- --shard 2".into()] };
        let p = decide(&ended(Turn::default(), vec![]), &seen, AT, "the host restarted", ALL);
        assert_eq!(p.turn, EndedTurn::Idle);
        let note = p.note.unwrap();
        assert!(note.starts_with(&format!("Your previous process ended unexpectedly at {} (the host restarted). Handles of background jobs", hhmm(AT))), "{note}");
        assert!(note.ends_with("Background jobs it had running: bash: npm test -- --shard 2."), "{note}");
        // A turn that goes on by itself keeps going; the note follows it.
        let p = decide(&ended(cut(vec![call("wait", "")]), vec![]), &Seen { busy: true, jobs: seen.jobs.clone() }, AT, "x", ALL);
        assert!(p.restore_turn && p.note_follows());
        assert!(p.note.unwrap().contains("Your turn went on where it stopped, but handles of background jobs"));
    }

    /// The lab's agents as session files: the plan when omp ended, and again after `omp --resume`
    /// wrote exit recovery's records (what `go_on` reads once the agent is back).
    mod files {
        use super::*;
        use crate::restart::detect;

        const HEADER: &str = r#"{"type":"session","version":3,"id":"01s","timestamp":"2026-10-29T13:50:00.000Z","cwd":"/w"}"#;

        fn user(id: &str, parent: &str, text: &str) -> String {
            format!(r#"{{"type":"message","id":"{id}","parentId":"{parent}","message":{{"role":"user","content":[{{"type":"text","text":"{text}"}}]}}}}"#)
        }
        fn calls(id: &str, parent: &str, name: &str, args: &str) -> String {
            format!(r#"{{"type":"message","id":"{id}","parentId":"{parent}","message":{{"role":"assistant","content":[{{"type":"toolCall","id":"c1","name":"{name}","arguments":{args}}}],"stopReason":"toolUse"}}}}"#)
        }
        fn sighup(id: &str, parent: &str) -> String {
            format!(r#"{{"type":"custom","customType":"session_exit","data":{{"reason":"SIGHUP","kind":"signal","recordedAt":"2026-10-29T13:58:04.000Z","pendingToolCalls":[{{"toolCallId":"c1","toolName":"x"}}]}},"id":"{id}","parentId":"{parent}"}}"#)
        }
        /// What `omp --resume` appends after a recorded signal exit (sdk.ts exit recovery).
        fn recovered(parent: &str) -> [String; 2] {
            [
                format!(r#"{{"type":"message","id":"r1","parentId":"{parent}","message":{{"role":"toolResult","toolCallId":"c1","toolName":"x","content":[{{"type":"text","text":"Previous OMP process exited before this tool returned; its outcome is unknown."}}],"isError":true}}}}"#),
                format!(r#"{{"type":"message","id":"ab","parentId":"r1","message":{{"role":"assistant","content":[],"stopReason":"aborted","errorMessage":"{}"}}}}"#, detect::INTERRUPTED_TURN_ERROR),
            ]
        }

        fn plan_of(dir: &std::path::Path, name: &str, lines: &[String], busy: bool) -> Plan {
            let file = dir.join(format!("{name}.jsonl"));
            std::fs::write(&file, lines.join("\n")).unwrap();
            decide(&detect::ended(&file).unwrap(), &Seen { busy, jobs: vec![] }, AT, "herdr stopped", ALL)
        }

        #[test]
        fn the_same_plan_before_and_after_resume() {
            let dir = tempfile::tempdir().unwrap();
            // C: in `bash: sleep 30; …` when herdr stopped. Never run again; the note names it.
            let c = vec![HEADER.to_string(), user("u1", "", "go"), calls("a1", "u1", "bash", r#"{"command":"sleep 30; echo done >> /tmp/tf-lab-lifeboat/c.out"}"#), sighup("x1", "a1")];
            let before = plan_of(dir.path(), "c", &c, true);
            let mut resumed = c.clone();
            resumed.extend(recovered("x1"));
            let after = plan_of(dir.path(), "c2", &resumed, false);
            assert_eq!(before.turn, EndedTurn::Working);
            assert!(!before.restore_turn && !after.restore_turn);
            assert_eq!(before.note, after.note);
            assert!(after.note.unwrap().contains("Its last action (bash: sleep 30; echo done >> /tmp/tf-lab-lifeboat/c.out) may or may not have run"));
            // B: in `wait` (only reads): omp's restore, before and after.
            let b = vec![HEADER.to_string(), user("u1", "", "go"), calls("a1", "u1", "wait", "{}"), sighup("x1", "a1")];
            let before = plan_of(dir.path(), "b", &b, true);
            let mut resumed = b.clone();
            resumed.extend(recovered("x1"));
            let after = plan_of(dir.path(), "b2", &resumed, false);
            assert!(before.restore_turn && after.restore_turn && before.note.is_none() && after.note.is_none());
            // D: writing a reply when SIGHUP came (saved aborted); `--resume` appends nothing.
            let reply = r#"{"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","content":[{"type":"text","text":"Part one of"}],"stopReason":"aborted"}}"#;
            let d = vec![HEADER.to_string(), user("u1", "", "write"), reply.to_string(), sighup("x1", "a1").replace(r#","pendingToolCalls":[{"toolCallId":"c1","toolName":"x"}]"#, "")];
            let p = plan_of(dir.path(), "d", &d, true);
            assert_eq!(p.turn, EndedTurn::Replying);
            assert!(p.retry && p.note.is_none());
            // A: idle. Nothing to do.
            let done = r#"{"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","content":[{"type":"text","text":"Ready."}],"stopReason":"stop"}}"#;
            let a = vec![HEADER.to_string(), user("u1", "", "hi"), done.to_string(), sighup("x1", "a1").replace(r#","pendingToolCalls":[{"toolCallId":"c1","toolName":"x"}]"#, "")];
            assert_eq!(plan_of(dir.path(), "a", &a, false), Plan::idle());
        }
    }
}
