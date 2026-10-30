//! What a subagent's status is, and how a replica learns how a finished one ended.
//!
//! Three sources say something about a subagent, none complete on its own:
//!
//! * omp's bus frames (`task:subagent:lifecycle` / `:progress`) carry `completed`, `failed`,
//!   `aborted` — but only live: a hostd restart, a resync or a rebuilt replica never sees them.
//! * The agent roster (`agents` frames) has `running`, `idle`, `parked` and `aborted`. omp moves a
//!   finished agent from `idle` to `parked` after its idle TTL (minutes) and lists every persisted
//!   subagent as `parked` after a restart, whatever its outcome was.
//! * The session file: omp delivers a background task's outcome to the parent as an `async-result`
//!   custom message (`details.jobs[]`: `agentId`, `status`), and a synchronous or settled `task`
//!   call carries `details.results[]` / `details.progress[]`. These are durable, so every replica
//!   built from the file learns the same outcome.
//!
//! The roster's `parked` therefore says *finished*, never *how*: a known outcome wins over it.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;
use tf_proto::{Millis, SubagentStatus};

use super::util::{arr, b, f, s};
use super::{Replica, SubState};

/// How a subagent's run ended, as a session file recorded it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Outcome {
    pub status: SubagentStatus,
    /// omp's own measure of the run (`durationMs`), when the record has one.
    pub ran: Option<Millis>,
}

fn duration(v: &Value) -> Option<Millis> {
    f(v, "durationMs").filter(|d| d.is_finite() && *d > 0.0).map(|d| d.round() as Millis)
}

/// The outcomes one record settles, in file order (a later record of the same agent wins).
/// `details` is the `details` of an `async-result` custom message or of a tool result; `tool` the
/// tool's name (empty for a custom message).
///
/// * `details.jobs[]` is shared by both deliveries of a background job: the `async-result` message
///   (`jobId`, `agentId`) and the `wait` / `poll` result (`id`, `agentUrlId`). A job that is still
///   `running` settles nothing; a shell job is not a subagent.
/// * A `task` result carries `details.results[]` (exit code, `aborted`) and the final
///   `details.progress[]`; a just-spawned background call (`details.async.state == "running"`) has
///   settled nothing yet.
pub(super) fn recorded(details: &Value, tool: &str) -> Vec<(String, Outcome)> {
    let mut out = Vec::new();
    for job in arr(details, "jobs") {
        if s(job, "type").is_some_and(|t| t != "task") {
            continue;
        }
        let status = match s(job, "status") {
            Some("completed") => SubagentStatus::Done,
            Some("failed") => SubagentStatus::Failed,
            Some("cancelled") => SubagentStatus::Aborted,
            _ => continue,
        };
        // The job id can differ from the agent id (`WslFix-2`: a messaged agent's next turn); the
        // roster and the transcript are keyed by the agent.
        let id = ["agentId", "agentUrlId", "id", "jobId"].into_iter().find_map(|k| s(job, k).filter(|id| !id.is_empty()));
        if let Some(id) = id {
            out.push((id.to_owned(), Outcome { status, ran: duration(job) }));
        }
    }
    if tool != "task" || details.get("async").and_then(|a| s(a, "state")) == Some("running") {
        return out;
    }
    let settled = out.len();
    for r in arr(details, "results") {
        let Some(id) = s(r, "id").filter(|id| !id.is_empty()) else { continue };
        let status = match (b(r, "aborted"), r.get("exitCode").and_then(Value::as_i64)) {
            (true, _) => SubagentStatus::Aborted,
            (false, Some(0)) => SubagentStatus::Done,
            (false, Some(_)) => SubagentStatus::Failed,
            (false, None) => continue,
        };
        out.push((id.to_owned(), Outcome { status, ran: duration(r) }));
    }
    for p in arr(details, "progress") {
        let Some(id) = s(p, "id").filter(|id| !id.is_empty()) else { continue };
        let status = match s(p, "status") {
            Some("completed") => SubagentStatus::Done,
            Some("failed") => SubagentStatus::Failed,
            Some("aborted") => SubagentStatus::Aborted,
            _ => continue,
        };
        // `results[]` is the authority on a settled call; progress only fills what it lacks.
        if !out[settled..].iter().any(|(known, _)| known == id) {
            out.push((id.to_owned(), Outcome { status, ran: duration(p) }));
        }
    }
    out
}

impl Replica {
    /// Records what a session-file entry says about how subagents ended. Called for the live
    /// message and for the file entry alike (the second just records the same outcome again).
    pub(super) fn learn_outcomes(&mut self, details: Option<&Value>, tool: &str) {
        for (id, outcome) in details.map(|d| recorded(d, tool)).unwrap_or_default() {
            self.outcomes.insert(id, outcome);
        }
    }

    /// The recorded outcome of `id`: the session file's, else the one found in the subagent
    /// transcripts (a nested subagent's end is recorded by its parent's transcript only).
    pub(super) fn outcome_of(&self, id: &str) -> Option<Outcome> {
        self.outcomes.get(id).or_else(|| self.artifact_outcomes.get(id)).copied()
    }

    pub(super) fn set_artifact_outcomes(&mut self, outcomes: BTreeMap<String, Outcome>, interrupted: BTreeSet<String>) {
        self.artifact_outcomes = outcomes;
        self.interrupted = interrupted;
    }
}

/// How far a subagent's own transcript got, kept while the ledger tails it: the port of omp's
/// `hasRestorableTurn` (`restorable` in tf-hostd's `restart/detect.rs`), which says its process
/// left the transcript mid-turn. A turn is cut off when the last message is a prompt, a tool
/// result the model never answered (unless the reply before it already ended in an error or an
/// abort) or an assistant message with tool calls, and no normal `session_exit` follows it.
#[derive(Debug, Default)]
pub(super) struct TailTurn {
    tail: Option<Tail>,
    /// `stopReason` of the last assistant message.
    last_assistant_stop: Option<String>,
    /// The tail is omp's abort record for a turn its process never finished.
    interrupted_abort: bool,
    /// A `session_exit` of kind `normal` came after the last message.
    normal_exit: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Tail {
    User,
    Assistant { calls: bool },
    ToolResult,
    Other,
}

/// omp's abort record for a turn its process never finished (`INTERRUPTED_TURN_ERROR`).
const INTERRUPTED_TURN_ERROR: &str = "Previous OMP process exited before completing the turn.";

impl TailTurn {
    /// Folds one transcript entry (file order).
    pub(super) fn note(&mut self, entry: &Value) {
        match s(entry, "type") {
            Some("message") => {
                let Some(m) = entry.get("message") else { return };
                let stop = s(m, "stopReason");
                self.tail = Some(match s(m, "role") {
                    Some("user") => Tail::User,
                    Some("assistant") => Tail::Assistant { calls: arr(m, "content").iter().any(|c| s(c, "type") == Some("toolCall")) },
                    Some("toolResult") => Tail::ToolResult,
                    _ => Tail::Other,
                });
                if matches!(self.tail, Some(Tail::Assistant { .. })) {
                    self.last_assistant_stop = stop.map(str::to_owned);
                }
                self.interrupted_abort = matches!(self.tail, Some(Tail::Assistant { .. })) && stop == Some("aborted") && s(m, "errorMessage") == Some(INTERRUPTED_TURN_ERROR);
                self.normal_exit = false;
            }
            Some("custom") if s(entry, "customType") == Some("session_exit") => {
                self.normal_exit |= entry.get("data").and_then(|d| s(d, "kind")) == Some("normal");
            }
            _ => {}
        }
    }

    /// The process that wrote this transcript left it mid-turn.
    pub(super) fn cut_off(&self) -> bool {
        let Some(tail) = self.tail else { return false };
        if self.normal_exit {
            return false;
        }
        if self.interrupted_abort {
            return true;
        }
        match tail {
            Tail::Assistant { calls: false } => false,
            Tail::ToolResult => !matches!(self.last_assistant_stop.as_deref(), Some("error" | "aborted")),
            _ => true,
        }
    }
}

/// A subagent's status from everything known about it. `outcome` is what the session file
/// recorded and `interrupted` that its own transcript ends mid-turn (see the module docs).
///
/// Order, strongest first:
/// 1. `failed` / `aborted` from the live frames or a tombstoned (`aborted`) roster entry;
/// 2. `completed` from the live frames;
/// 3. a roster entry that says `running` (a revived agent is running again whatever it did before);
/// 4. the recorded outcome (green or red, however long ago omp parked the agent);
/// 5. a roster `idle` or `parked` entry with no known outcome whose transcript ends mid-turn: its
///    process died under it (a crash, a herdr outage, a reboot), so it is **Aborted** ("stopped"),
///    never a green Done;
/// 6. a roster `idle` or `parked` entry with no known outcome and a transcript that ended
///    normally (or is not read): **Done**. omp parks an agent only after it went idle, i.e.
///    finished its turn, and lists every persisted subagent as parked; "finished, outcome
///    unknown" is closest to done. A neutral state would put these in a third colour the user
///    cannot read (this was the blue "Parked" chip) and would split the completed group in two;
/// 7. otherwise still running.
pub(super) fn status(st: &SubState, outcome: Option<SubagentStatus>, interrupted: bool) -> SubagentStatus {
    let lifecycle = st.lifecycle.as_deref();
    let progress = st.progress.as_ref().and_then(|p| s(p, "status"));
    let roster = st.snapshot.as_ref().map(|a| a.status.as_str());
    let any = |want: &str| lifecycle == Some(want) || progress == Some(want);
    if any("failed") {
        SubagentStatus::Failed
    } else if any("aborted") || roster == Some("aborted") {
        SubagentStatus::Aborted
    } else if any("completed") {
        SubagentStatus::Done
    } else if roster == Some("running") {
        SubagentStatus::Running
    } else if let Some(outcome) = outcome {
        outcome
    } else if matches!(roster, Some("idle" | "parked")) {
        if interrupted { SubagentStatus::Aborted } else { SubagentStatus::Done }
    } else {
        SubagentStatus::Running
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use tf_proto::SubagentStatus::{self, *};

    use crate::frame::{HostFrame, Welcome};
    use crate::guest::{GuestEvent, Snapshot};
    use crate::replica::Replica;

    const NOW: i64 = 1_792_000_000_000;

    fn agent(id: &str, status: &str) -> Value {
        json!({ "id": id, "displayName": "task", "kind": "sub", "parentId": "Main", "status": status, "hasSessionFile": true,
                "createdAt": NOW - 600_000, "lastActivity": NOW })
    }

    fn main_agent() -> Value {
        json!({ "id": "Main", "displayName": "main", "kind": "main", "status": "running", "hasSessionFile": true, "createdAt": NOW - 700_000, "lastActivity": NOW })
    }

    /// A replica rebuilt from a snapshot: this roster and these session-file entries.
    fn rebuilt(agents: Vec<Value>, entries: Vec<Value>) -> Replica {
        let welcome: Welcome = serde_json::from_value(json!({
            "proto": 1, "header": { "id": "s1", "timestamp": "2026-10-21T17:00:00.000Z", "cwd": "/w" }, "state": {},
            "agents": agents, "entryCount": entries.len(),
        }))
        .unwrap();
        let mut r = Replica::new("Main");
        r.apply(&GuestEvent::Snapshot(Snapshot { welcome, entries, resync: false }), NOW);
        r
    }

    fn frame(r: &mut Replica, v: Value) {
        r.apply(&GuestEvent::Frame(HostFrame::from_value(v)), NOW);
    }

    fn lifecycle(r: &mut Replica, id: &str, status: &str) {
        frame(r, json!({ "t": "bus", "channel": "task:subagent:lifecycle", "data": { "id": id, "status": status } }));
    }

    fn roster(r: &mut Replica, agents: Vec<Value>) {
        frame(r, json!({ "t": "agents", "agents": agents }));
    }

    fn status_of(r: &Replica, id: &str) -> SubagentStatus {
        r.meta().subagents.iter().find(|s| s.id == id).unwrap_or_else(|| panic!("no subagent {id}: {:?}", r.meta().subagents)).status
    }

    fn async_result(jobs: Value) -> Value {
        json!({ "type": "custom_message", "id": "e1", "parentId": null, "customType": "async-result", "display": true, "attribution": "agent",
                "content": "<system-notice>done</system-notice>", "timestamp": "2026-10-21T17:05:00.000Z", "details": { "jobs": jobs } })
    }

    #[test]
    fn completed_stays_done_when_omp_parks_it() {
        let mut r = rebuilt(vec![main_agent(), agent("A", "running")], vec![]);
        assert_eq!(status_of(&r, "A"), Running);
        lifecycle(&mut r, "A", "completed");
        roster(&mut r, vec![main_agent(), agent("A", "parked")]);
        assert_eq!(status_of(&r, "A"), Done, "completed, then parked after the idle TTL: still done (was blue)");
    }

    #[test]
    fn failed_stays_failed_when_omp_parks_it() {
        let mut r = rebuilt(vec![main_agent(), agent("A", "running")], vec![]);
        lifecycle(&mut r, "A", "failed");
        roster(&mut r, vec![main_agent(), agent("A", "parked")]);
        assert_eq!(status_of(&r, "A"), Failed);
    }

    #[test]
    fn a_newer_running_clears_a_stale_failed() {
        // The roster says it runs again (a retry or resume) with no fresh lifecycle frame.
        let mut r = rebuilt(vec![main_agent(), agent("A", "running")], vec![]);
        lifecycle(&mut r, "A", "failed");
        roster(&mut r, vec![main_agent(), agent("A", "parked")]);
        assert_eq!(status_of(&r, "A"), Failed);
        roster(&mut r, vec![main_agent(), agent("A", "running")]);
        assert_eq!(status_of(&r, "A"), Running, "running again: the earlier failure is stale");
        lifecycle(&mut r, "A", "failed");
        assert_eq!(status_of(&r, "A"), Failed, "and a new failure counts again");

        // A progress frame that says running does the same, and so does an aborted lifecycle.
        let mut r = rebuilt(vec![main_agent(), agent("B", "parked")], vec![]);
        lifecycle(&mut r, "B", "aborted");
        assert_eq!(status_of(&r, "B"), Aborted);
        frame(&mut r, json!({ "t": "bus", "channel": "task:subagent:progress", "data": { "progress": { "id": "B", "status": "running" } } }));
        roster(&mut r, vec![main_agent(), agent("B", "running")]);
        assert_eq!(status_of(&r, "B"), Running);
    }

    #[test]
    fn a_repeated_running_roster_does_not_hide_a_failure() {
        let mut r = rebuilt(vec![main_agent(), agent("A", "running")], vec![]);
        lifecycle(&mut r, "A", "failed");
        roster(&mut r, vec![main_agent(), agent("A", "running")]);
        assert_eq!(status_of(&r, "A"), Failed, "running before and after: nothing restarted");
    }

    #[test]
    fn aborted_wins_over_everything() {
        let mut r = rebuilt(vec![main_agent(), agent("A", "parked"), agent("B", "parked")], vec![async_result(json!([
            { "jobId": "A", "type": "task", "status": "completed", "agentId": "A" },
            { "jobId": "B", "type": "task", "status": "completed", "agentId": "B" },
        ]))]);
        assert_eq!((status_of(&r, "A"), status_of(&r, "B")), (Done, Done));
        lifecycle(&mut r, "A", "aborted");
        roster(&mut r, vec![main_agent(), agent("A", "parked"), agent("B", "aborted")]);
        assert_eq!(status_of(&r, "A"), Aborted, "a live aborted frame beats parked and a recorded outcome");
        assert_eq!(status_of(&r, "B"), Aborted, "a tombstoned roster entry beats a recorded outcome");
    }

    #[test]
    fn rebuilt_replica_learns_outcomes_from_async_results() {
        let entries = vec![async_result(json!([
            { "jobId": "Ok", "type": "task", "status": "completed", "agentId": "Ok", "durationMs": 1535 },
            { "jobId": "Bad", "type": "task", "status": "failed", "agentId": "Bad" },
            { "jobId": "Gone", "type": "task", "status": "cancelled", "agentId": "Gone" },
            { "jobId": "sh1", "type": "bash", "status": "failed" },
        ]))];
        // After a restart omp lists every persisted subagent as parked, with no bus frames.
        let r = rebuilt(vec![main_agent(), agent("Ok", "parked"), agent("Bad", "parked"), agent("Gone", "parked"), agent("sh1", "parked")], entries);
        assert_eq!(status_of(&r, "Ok"), Done);
        assert_eq!(status_of(&r, "Bad"), Failed);
        assert_eq!(status_of(&r, "Gone"), Aborted);
        assert_eq!(status_of(&r, "sh1"), Done, "a bash job's result says nothing about a subagent of that name");
    }

    #[test]
    fn rebuilt_replica_learns_outcomes_from_task_results() {
        let result = json!({ "type": "message", "id": "t1", "parentId": null, "timestamp": "2026-10-21T17:05:00.000Z", "message": {
            "role": "toolResult", "toolCallId": "c1", "toolName": "task", "isError": false, "content": [{ "type": "text", "text": "x" }],
            "details": { "results": [{ "id": "Ok", "exitCode": 0 }, { "id": "Bad", "exitCode": 1 }, { "id": "Stop", "exitCode": 1, "aborted": true }],
                         "progress": [{ "id": "Late", "status": "completed" }, { "id": "Ok", "status": "failed" }] } } });
        let spawned = json!({ "type": "message", "id": "t2", "parentId": "t1", "timestamp": "2026-10-21T17:06:00.000Z", "message": {
            "role": "toolResult", "toolCallId": "c2", "toolName": "task", "isError": false, "content": [{ "type": "text", "text": "x" }],
            "details": { "async": { "state": "running", "jobId": "Fresh", "type": "task" }, "results": [{ "id": "Fresh", "exitCode": 0 }] } } });
        let parked = ["Ok", "Bad", "Stop", "Late", "Fresh"].map(|id| agent(id, "parked")).to_vec();
        let mut agents = vec![main_agent()];
        agents.extend(parked);
        let r = rebuilt(agents, vec![result, spawned]);
        assert_eq!(status_of(&r, "Ok"), Done, "results[] is the authority; progress only fills gaps");
        assert_eq!(status_of(&r, "Bad"), Failed);
        assert_eq!(status_of(&r, "Stop"), Aborted);
        assert_eq!(status_of(&r, "Late"), Done);
        assert_eq!(status_of(&r, "Fresh"), Done, "no outcome recorded from a still-running spawn: the parked roster entry reads finished");
    }

    #[test]
    fn parked_without_a_known_outcome_is_finished_not_blue() {
        let r = rebuilt(vec![main_agent(), agent("A", "parked"), agent("B", "idle")], vec![]);
        assert_eq!(status_of(&r, "A"), Done);
        assert_eq!(status_of(&r, "B"), Done);
    }

    #[test]
    fn a_revived_agent_is_running_again() {
        let mut r = rebuilt(vec![main_agent(), agent("A", "parked")], vec![async_result(json!([{ "jobId": "A", "type": "task", "status": "failed", "agentId": "A" }]))]);
        assert_eq!(status_of(&r, "A"), Failed);
        roster(&mut r, vec![main_agent(), agent("A", "running")]);
        assert_eq!(status_of(&r, "A"), Running, "the recorded outcome is the previous run's");
    }

    /// A `wait` result (`details.jobs[]`: `id`, `agentUrlId`), trimmed from the coordinator session of
    /// TeleFlock 0.6.5 (16:39:03 and 16:54:41 UTC).
    fn wait_result(id: &str, jobs: Value) -> Value {
        json!({ "type": "message", "id": id, "parentId": null, "timestamp": "2026-10-29T16:39:03.632Z", "message": {
            "role": "toolResult", "toolCallId": format!("c-{id}"), "toolName": "wait", "isError": false, "content": [{ "type": "text", "text": "x" }],
            "details": { "op": "wait", "meta": { "source": { "type": "report", "value": "background jobs snapshot" } }, "jobs": jobs } } })
    }

    fn ran_ms(r: &Replica, id: &str) -> i64 {
        let s = r.meta().subagents.iter().find(|s| s.id == id).unwrap().clone();
        s.ended_at.unwrap() - s.started_at.unwrap()
    }

    /// The usage limit failed seven background tasks at 15:55:32; the coordinator revived them and
    /// `wait` later delivered their real ends (the file keeps the early `failed` delivery). The last
    /// record wins, and a parked agent's run is omp's `durationMs`, not the roster's `lastActivity`
    /// (which moves when omp parks the agent or touches its transcript after a relaunch).
    #[test]
    fn a_revived_task_shows_its_last_recorded_outcome_and_run_time() {
        let entries = vec![
            async_result(json!([
                { "jobId": "SearchC", "type": "task", "status": "failed", "agentId": "SearchC", "durationMs": 1_830_480 },
                { "jobId": "HerdrGuard", "type": "task", "status": "failed", "agentId": "HerdrGuard", "durationMs": 1_874_702 },
            ])),
            wait_result("w1", json!([
                { "id": "SearchC", "type": "task", "status": "completed", "label": "SearchC", "durationMs": 754_712, "agentUrlId": "SearchC" },
                { "id": "Slow", "type": "task", "status": "running", "label": "Slow", "durationMs": 1_000, "agentUrlId": "Slow" },
            ])),
            wait_result("w2", json!([
                { "id": "WslFix", "type": "task", "status": "completed", "label": "WslFix", "durationMs": 4_825_650, "agentUrlId": "WslFix" },
                { "id": "WslFix-2", "type": "task", "status": "completed", "label": "WslFix", "durationMs": 578_429, "agentUrlId": "WslFix" },
            ])),
        ];
        let agents = ["SearchC", "HerdrGuard", "WslFix", "Slow"].map(|id| agent(id, "parked")).into_iter().chain([main_agent()]).collect();
        let r = rebuilt(agents, entries);
        assert_eq!(status_of(&r, "SearchC"), Done, "failed at 15:55, completed at 16:39: the later record");
        assert_eq!(status_of(&r, "HerdrGuard"), Failed, "nothing later says otherwise");
        assert_eq!(status_of(&r, "WslFix"), Done);
        assert_eq!(status_of(&r, "Slow"), Done, "a `running` job settles nothing: the parked roster entry reads finished");
        assert_eq!(ran_ms(&r, "SearchC"), 754_712);
        assert_eq!(ran_ms(&r, "HerdrGuard"), 1_874_702);
        assert_eq!(ran_ms(&r, "WslFix"), 578_429, "keyed by the agent, the job `WslFix-2` is its latest run");
        assert_eq!(ran_ms(&r, "Slow"), 600_000, "no record of its run: the roster's last activity");
    }

    /// A nested subagent's end is only in its parent's transcript (`AutoAnswerC.jsonl` records its
    /// children `AutoAnswerC.AALaunch` (failed) and `AutoAnswerC.AACountdown`), which tf-hostd feeds
    /// through the artifact ledger.
    #[test]
    fn a_nested_subagents_outcome_comes_from_its_parents_transcript() {
        use crate::replica::ArtifactLedger;
        let mut agents = vec![main_agent()];
        agents.extend(["AutoAnswerC", "AutoAnswerC.AALaunch", "AutoAnswerC.AACountdown"].map(|id| agent(id, "parked")));
        let mut r = rebuilt(agents, vec![]);
        assert_eq!(status_of(&r, "AutoAnswerC.AALaunch"), Done, "before the transcript is read");

        let line = |v: Value| format!("{v}\n");
        let mut transcript = line(json!({ "type": "session", "version": 3, "id": "x", "timestamp": "2026-10-29T15:24:24.000Z", "cwd": "/w" }));
        transcript += &line(wait_result("w1", json!([
            { "id": "AutoAnswerC.AALaunch", "type": "task", "status": "failed", "label": "AALaunch", "durationMs": 1_281_098, "agentUrlId": "AutoAnswerC.AALaunch" },
            { "id": "AutoAnswerC.AACountdown", "type": "task", "status": "completed", "label": "AACountdown", "durationMs": 735_635, "agentUrlId": "AutoAnswerC.AACountdown" },
        ])));
        transcript += &line(json!({ "type": "message", "id": "m9", "message": { "role": "assistant", "content": [{ "type": "text", "text": "done" }], "stopReason": "stop" } }));
        let mut ledger = ArtifactLedger::default();
        r.apply_artifacts(&ledger, &[], NOW);
        assert!(!r.artifacts_stale(&ledger));
        let calls = ledger.ingest("AutoAnswerC.jsonl", transcript.as_bytes());
        assert!(r.artifacts_stale(&ledger), "an outcome alone makes the replica's view stale");
        r.apply_artifacts(&ledger, &calls, NOW);
        assert!(!r.artifacts_stale(&ledger));

        assert_eq!(status_of(&r, "AutoAnswerC.AALaunch"), Failed);
        assert_eq!(status_of(&r, "AutoAnswerC.AACountdown"), Done);
        assert_eq!(status_of(&r, "AutoAnswerC"), Done);
        assert_eq!(ran_ms(&r, "AutoAnswerC.AALaunch"), 1_281_098);
        assert_eq!(ran_ms(&r, "AutoAnswerC.AACountdown"), 735_635);
    }

    /// Trimmed from the 0.6.5 coordinator session: the 13:58 herdr outage killed the omp process
    /// under HostTools (a `wait` call in flight, `session_exit` kind `signal`) and its child
    /// `GhSignIn` (a tool result nobody answered); Move finished its turn and omp exited normally.
    /// The file has no record of how they ended, so a parked roster entry must not read Done.
    #[test]
    fn a_parked_subagent_cut_off_by_a_crash_is_stopped_not_done() {
        use crate::replica::ArtifactLedger;
        let line = |v: Value| format!("{v}\n");
        let header = line(json!({ "type": "session", "version": 3, "id": "x", "timestamp": "2026-10-29T12:34:47.000Z", "cwd": "/w" }));
        let msg = |role: &str, content: Value, stop: Option<&str>| line(json!({ "type": "message", "id": "m", "message": { "role": role, "content": content, "stopReason": stop } }));
        let call = json!([{ "type": "toolCall", "id": "toolu_01", "name": "wait", "arguments": { "i": "Waiting for subagents to finish" } }]);
        let exit = |kind: &str| line(json!({ "type": "custom", "customType": "session_exit", "data": { "reason": "sighup", "kind": kind, "recordedAt": "2026-10-29T13:58:08.999Z" } }));
        let text = json!([{ "type": "text", "text": "ok" }]);

        let hosttools = header.clone() + &msg("user", text.clone(), None) + &msg("assistant", call.clone(), Some("toolUse")) + &exit("signal");
        let ghsignin = header.clone() + &msg("assistant", call.clone(), Some("toolUse")) + &msg("toolResult", text.clone(), None);
        let move_ = header.clone() + &msg("assistant", call.clone(), Some("toolUse")) + &msg("toolResult", text.clone(), None) + &msg("assistant", text.clone(), Some("stop")) + &exit("normal");
        let after_error = header.clone() + &msg("assistant", text.clone(), Some("error")) + &msg("toolResult", text.clone(), None);
        let recorded = header.clone() + &msg("assistant", call, Some("toolUse")) + &exit("signal");

        let mut agents = vec![main_agent()];
        agents.extend(["HostTools", "HostTools.GhSignIn", "Move", "Errored", "Recorded", "Unread"].map(|id| agent(id, "parked")));
        let mut r = rebuilt(agents, vec![async_result(json!([{ "jobId": "Recorded", "type": "task", "status": "completed", "agentId": "Recorded", "durationMs": 1000 }]))]);
        let mut ledger = ArtifactLedger::default();
        let mut calls = Vec::new();
        for (rel, text) in [
            ("HostTools.jsonl", hosttools),
            ("HostTools/HostTools.GhSignIn.jsonl", ghsignin),
            ("Move.jsonl", move_),
            ("Errored.jsonl", after_error),
            ("Recorded.jsonl", recorded),
        ] {
            calls.extend(ledger.ingest(rel, text.as_bytes()));
        }
        assert_eq!(status_of(&r, "HostTools"), Done, "before the transcripts are read");
        r.apply_artifacts(&ledger, &calls, NOW);

        assert_eq!(status_of(&r, "HostTools"), Aborted);
        assert_eq!(status_of(&r, "HostTools.GhSignIn"), Aborted, "an unanswered tool result is a cut-off turn too");
        assert_eq!(status_of(&r, "Move"), Done, "its turn ended and omp exited normally");
        assert_eq!(status_of(&r, "Errored"), Done, "a tool result after a reply that ended in an error is not a cut-off turn (hasRestorableTurn)");
        assert_eq!(status_of(&r, "Recorded"), Done, "recorded as completed: a recorded outcome beats the transcript's tail");
        assert_eq!(status_of(&r, "Unread"), Done, "no transcript, nothing known: parked reads finished");
        roster(&mut r, {
            let mut a = vec![main_agent()];
            a.extend(["HostTools"].map(|id| agent(id, "running")));
            a
        });
        assert_eq!(status_of(&r, "HostTools"), Running, "revived");
    }
}
