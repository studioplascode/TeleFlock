use super::*;

/// One JSONL line per entry: `(id, parent, json body without the envelope)`.
fn file(lines: &[&str]) -> String {
    lines.join("\n")
}

fn header() -> &'static str {
    r#"{"type":"session","version":3,"id":"01sess","timestamp":"2026-10-29T10:00:00.000Z","cwd":"/tmp/w"}"#
}

fn user(id: &str, parent: &str) -> String {
    format!(r#"{{"type":"message","id":"{id}","parentId":"{parent}","message":{{"role":"user","content":[{{"type":"text","text":"go"}}]}}}}"#)
}

fn assistant_text(id: &str, parent: &str, stop: &str) -> String {
    format!(r#"{{"type":"message","id":"{id}","parentId":"{parent}","message":{{"role":"assistant","content":[{{"type":"text","text":"done"}}],"stopReason":"{stop}"}}}}"#)
}

fn assistant_call(id: &str, parent: &str) -> String {
    format!(
        r#"{{"type":"message","id":"{id}","parentId":"{parent}","message":{{"role":"assistant","content":[{{"type":"text","text":"running"}},{{"type":"toolCall","id":"call_1","name":"bash","arguments":{{"command":"sleep 40"}}}}],"stopReason":"toolUse"}}}}"#
    )
}

fn tool_result(id: &str, parent: &str) -> String {
    format!(r#"{{"type":"message","id":"{id}","parentId":"{parent}","message":{{"role":"toolResult","toolCallId":"call_1","toolName":"bash","content":[{{"type":"text","text":"ok"}}],"isError":false}}}}"#)
}

fn exit(id: &str, parent: &str, kind: &str, pending: bool) -> String {
    let pending = if pending { r#","pendingToolCalls":[{"toolCallId":"call_1","toolName":"bash"}]"# } else { "" };
    format!(
        r#"{{"type":"custom","customType":"session_exit","data":{{"reason":"x","kind":"{kind}","recordedAt":"2026-10-29T10:05:00.000Z"{pending}}},"id":"{id}","parentId":"{parent}"}}"#
    )
}

fn interrupted_abort(id: &str, parent: &str) -> String {
    format!(
        r#"{{"type":"message","id":"{id}","parentId":"{parent}","message":{{"role":"assistant","content":[],"stopReason":"aborted","errorMessage":"{INTERRUPTED_TURN_ERROR}"}}}}"#
    )
}

fn root(lines: &[&str]) -> bool {
    root_restorable(&parse(&file(lines)))
}

#[test]
fn a_prompt_the_model_never_answered_is_cut_off() {
    // SIGKILL right after the prompt: no exit recorded, omp's restore assumes one.
    assert!(root(&[header(), &user("u1", "m0")]));
    // A recorded signal exit after it.
    assert!(root(&[header(), &user("u1", "m0"), &exit("x1", "u1", "signal", false)]));
    // A clean exit after it: nothing left unfinished.
    assert!(!root(&[header(), &user("u1", "m0"), &exit("x1", "u1", "normal", false)]));
}

#[test]
fn tool_calls_without_results_are_cut_off() {
    let call = assistant_call("a1", "u1");
    assert!(root(&[header(), &user("u1", "m0"), &call]));
    // A signal exit with the calls pending (SIGTERM while a tool ran).
    assert!(root(&[header(), &user("u1", "m0"), &call, &exit("x1", "a1", "signal", true)]));
    // Any clean exit after the tail ends it for --restore, pending calls or not (omp's
    // `hasRestorableTurn` stops at the first normal exit it meets from the end).
    assert!(!root(&[header(), &user("u1", "m0"), &call, &exit("x1", "a1", "normal", true)]));
    assert!(!root(&[header(), &user("u1", "m0"), &call, &exit("x1", "a1", "normal", false)]));
    // Results the model never answered.
    assert!(root(&[header(), &user("u1", "m0"), &call, &tool_result("t1", "a1")]));
}

#[test]
fn finished_failed_and_stopped_turns_stay() {
    assert!(!root(&[header(), &user("u1", "m0"), &assistant_text("a1", "u1", "stop")]));
    // A failed turn is terminal for --restore (omp's F5 retries it instead).
    assert!(!root(&[header(), &user("u1", "m0"), &assistant_text("a1", "u1", "error")]));
    // Tool results that close an aborted turn.
    let aborted_call = assistant_call("a1", "u1").replace(r#""stopReason":"toolUse""#, r#""stopReason":"aborted""#);
    assert!(!root(&[header(), &user("u1", "m0"), &aborted_call, &tool_result("t1", "a1")]));
    // Nothing at all.
    assert!(!root(&[header()]));
}

#[test]
fn exit_recovery_abort_counts_until_something_follows() {
    let call = assistant_call("a1", "u1");
    let lines = [header().to_string(), user("u1", "m0"), call.clone(), tool_result("t1", "a1"), interrupted_abort("ab", "t1")];
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    assert!(root(&refs));
    // ...even after another process exited without doing anything (a signal).
    let mut more = refs.clone();
    let sig = exit("x2", "ab", "signal", false);
    more.push(&sig);
    assert!(root(&more));
    // A clean exit after it ends it.
    let mut clean = refs.clone();
    let normal = exit("x2", "ab", "normal", false);
    clean.push(&normal);
    assert!(!root(&clean));
}

#[test]
fn the_current_branch_decides_not_file_order() {
    // u1 → a1 (finished); then the user navigated back to u1's parent and asked again (u2, cut
    // off). A late off-branch entry for the old branch records the leaf it interrupted.
    let lines = [
        header().to_string(),
        user("u1", "m0"),
        assistant_text("a1", "u1", "stop"),
        user("u2", "m0"),
        r#"{"type":"custom","customType":"bg","data":{},"id":"late","parentId":"a1","activeLeafId":"u2"}"#.to_string(),
    ];
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    assert!(root(&refs), "the leaf is u2 (activeLeafId), whose prompt was never answered");
    // The finished branch alone.
    let finished = [header().to_string(), user("u1", "m0"), assistant_text("a1", "u1", "stop")];
    let refs: Vec<&str> = finished.iter().map(String::as_str).collect();
    assert!(!root(&refs));
    // A leaf that no longer exists falls back to the newest self-selecting entry (a1: finished).
    let lost = [
        header().to_string(),
        user("u1", "m0"),
        assistant_text("a1", "u1", "stop"),
        r#"{"type":"custom","customType":"bg","data":{},"id":"late","parentId":"a1","activeLeafId":"gone"}"#.to_string(),
    ];
    let refs: Vec<&str> = lost.iter().map(String::as_str).collect();
    assert!(!root(&refs));
    // A cleared leaf: nothing on the branch.
    let cleared = [header().to_string(), user("u1", "m0"), r#"{"type":"custom","customType":"c","data":{},"id":"z","parentId":"u1","activeLeafId":null}"#.to_string()];
    let refs: Vec<&str> = cleared.iter().map(String::as_str).collect();
    assert!(!root(&refs));
}

#[test]
fn malformed_lines_and_odd_shapes_are_skipped() {
    let lines = [
        r#"{"type":"title","v":1,"title":"","updatedAt":"x","pad":"   "}"#.to_string(),
        header().to_string(),
        "{not json".to_string(),
        // A plain-string user content, and custom data that is a string.
        r#"{"type":"custom","customType":"system-prompt-digest","data":"36c4","id":"d1","parentId":"m0"}"#.to_string(),
        r#"{"type":"message","id":"u1","parentId":"d1","message":{"role":"user","content":"hello"}}"#.to_string(),
        // An invalid exit record (no recordedAt) is not an exit.
        r#"{"type":"custom","customType":"session_exit","data":{"reason":"x","kind":"normal"},"id":"x1","parentId":"u1"}"#.to_string(),
    ];
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    let entries = parse(&file(&refs));
    assert_eq!(header_id(&entries).as_deref(), Some("01sess"));
    assert!(root_restorable(&entries));
}

#[test]
fn subagents_need_a_revivable_contract() {
    let init = r#"{"type":"session_init","id":"i0","parentId":null,"task":"LAB-ROLE: worker","tools":["bash"],"systemPrompt":"x"}"#;
    let isolated = r#"{"type":"session_init","id":"i0","parentId":null,"task":"t","tools":[],"systemPrompt":"x","isolated":true}"#;
    let call = assistant_call("a1", "u1");
    let cut = |init: &str| subagent_restorable(&parse(&file(&[header(), init, &user("u1", "i0"), &call])));
    assert!(cut(init));
    assert!(!cut(isolated), "an isolated run's worktree is gone");
    assert!(!subagent_restorable(&parse(&file(&[header(), &user("u1", "i0"), &call]))), "no session_init: not revivable");
    let done = parse(&file(&[header(), init, &user("u1", "i0"), &call, &tool_result("t1", "a1"), &assistant_text("a2", "t1", "stop")]));
    assert!(!subagent_restorable(&done));
}

#[test]
fn files_with_subagent_transcripts() {
    let dir = tempfile::tempdir().unwrap();
    let main = dir.path().join("2026-10-29_01sess.jsonl");
    let sub_dir = dir.path().join("2026-10-29_01sess");
    std::fs::create_dir_all(sub_dir.join("Worker")).unwrap();
    let init = r#"{"type":"session_init","id":"i0","parentId":null,"task":"t","tools":["bash"],"systemPrompt":"x"}"#;
    let call = assistant_call("a1", "u1");
    let cut = file(&[header(), init, &user("u1", "i0"), &call]);
    let finished = file(&[header(), init, &user("u1", "i0"), &assistant_text("a1", "u1", "stop")]);
    // The main turn finished: it started background subagents and ended its turn.
    std::fs::write(&main, file(&[header(), &user("u1", "m0"), &assistant_text("a1", "u1", "stop")])).unwrap();
    std::fs::write(sub_dir.join("Worker.jsonl"), &cut).unwrap();
    std::fs::write(sub_dir.join("Worker").join("Nested.jsonl"), &cut).unwrap();
    std::fs::write(sub_dir.join("Done.jsonl"), &finished).unwrap();
    std::fs::write(sub_dir.join("Killed.jsonl"), &cut).unwrap();
    std::fs::write(sub_dir.join("Killed.jsonl.tombstone"), "").unwrap();
    std::fs::write(sub_dir.join("__advisor.jsonl"), &cut).unwrap();
    std::fs::write(sub_dir.join("Old.jsonl.bak"), &cut).unwrap();
    // The lab's Sleeper: its request streamed when the process ended, saved `aborted` with no
    // content and no exit record of its own. omp's restore skips it; its retry brings it back.
    let aborted = r#"{"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","content":[],"stopReason":"aborted"}}"#;
    std::fs::write(sub_dir.join("Sleeper.jsonl"), file(&[header(), init, &user("u1", "i0"), aborted])).unwrap();
    let got = ended(&main).unwrap();
    assert_eq!(got.session_id.as_deref(), Some("01sess"));
    assert!(!got.root.restorable);
    assert_eq!(got.subagents.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["Sleeper", "Worker", "Nested"]);
    let sleeper = &got.subagents[0].turn;
    assert!(sleeper.cut_reply && !sleeper.restorable);
    // Each cut off in `bash: sleep 40`, which omp's restore would run again.
    assert_eq!(got.subagents[1].turn.pending.iter().map(Call::label).collect::<Vec<_>>(), ["bash: sleep 40"]);
    assert_eq!(got.subagents[1].turn.replay.len(), 1);
    assert!(ended(&dir.path().join("missing.jsonl")).is_err());
}

fn turn(lines: &[&str]) -> Turn {
    let entries = parse(&file(lines));
    turn_of(&branch(&entries))
}

fn call_msg(id: &str, parent: &str, calls: &[(&str, &str, &str)], stop: &str) -> String {
    let parts: Vec<String> = calls.iter().map(|(cid, name, args)| format!(r#"{{"type":"toolCall","id":"{cid}","name":"{name}","arguments":{args}}}"#)).collect();
    format!(r#"{{"type":"message","id":"{id}","parentId":"{parent}","message":{{"role":"assistant","content":[{}],"stopReason":"{stop}"}}}}"#, parts.join(","))
}

fn result_msg(id: &str, parent: &str, call: &str, error: bool, text: &str) -> String {
    format!(r#"{{"type":"message","id":"{id}","parentId":"{parent}","message":{{"role":"toolResult","toolCallId":"{call}","toolName":"x","content":[{{"type":"text","text":"{text}"}}],"isError":{error}}}}}"#)
}

fn signal_exit(id: &str, parent: &str) -> String {
    format!(r#"{{"type":"custom","customType":"session_exit","data":{{"reason":"SIGHUP","kind":"signal","recordedAt":"2026-10-29T13:58:04.000Z"}},"id":"{id}","parentId":"{parent}"}}"#)
}

#[test]
fn a_tool_call_cut_off_by_sighup() {
    // The incident: `herdr server stop` ran when herdr's SIGHUP ended omp.
    let call = call_msg("a1", "u1", &[("c1", "bash", r#"{"command":"HERDR_SESSION=tf-lab-search herdr server stop","timeout":30}"#)], "toolUse");
    let t = turn(&[header(), &user("u1", "m0"), &call, &signal_exit("x1", "a1")]);
    assert!(t.restorable && !t.cut_reply);
    assert_eq!(t.pending.iter().map(Call::label).collect::<Vec<_>>(), ["bash: HERDR_SESSION=tf-lab-search herdr server stop"]);
    assert_eq!(t.replay, t.pending, "omp's restore would run it again");
    let exit = t.exit.unwrap();
    assert_eq!((exit.kind, exit.reason.as_str()), (ExitKind::Signal, "SIGHUP"));
    assert_eq!(exit.at, chrono::DateTime::parse_from_rfc3339("2026-10-29T13:58:04.000Z").ok().map(|t| t.timestamp_millis()));
    // After `omp --resume`: exit recovery's "outcome unknown" result and abort. Still pending.
    let unknown = result_msg("r1", "x1", "c1", true, "Previous OMP process exited before this tool returned; its outcome is unknown.");
    let t = turn(&[header(), &user("u1", "m0"), &call, &signal_exit("x1", "a1"), &unknown, &interrupted_abort("ab", "r1")]);
    assert!(t.restorable);
    assert_eq!(t.pending.len(), 1);
    assert_eq!(t.replay.len(), 1);
}

#[test]
fn what_omps_retry_would_run_again() {
    let batch = call_msg("a1", "u1", &[("c1", "read", r#"{"path":"src/a.rs"}"#), ("c2", "edit", r#"{"path":"src/b.rs","edits":[{"old":"x","new":"y"}]}"#)], "toolUse");
    // One call returned fine: omp never replays a partly successful batch; the other is pending.
    let t = turn(&[header(), &user("u1", "m0"), &batch, &result_msg("r1", "a1", "c1", false, "fn a()")]);
    assert!(t.replay.is_empty());
    assert_eq!(t.pending.iter().map(Call::label).collect::<Vec<_>>(), ["edit: src/b.rs"]);
    // Both failed: the whole batch would run again (results present, nothing pending).
    let t = turn(&[header(), &user("u1", "m0"), &batch, &result_msg("r1", "a1", "c1", true, "no"), &result_msg("r2", "r1", "c2", true, "no")]);
    assert_eq!(t.replay.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["read", "edit"]);
    assert!(t.pending.is_empty());
    // A batch cut off while its arguments streamed (aborted): never replayed.
    let partial = call_msg("a1", "u1", &[("c1", "write", r#"{"path":"x"}"#)], "aborted");
    let t = turn(&[header(), &user("u1", "m0"), &partial, &signal_exit("x1", "a1")]);
    assert!(t.replay.is_empty());
    assert_eq!(t.pending.len(), 1);
    // `lsp` keeps its action for the classifier.
    let lsp = call_msg("a1", "u1", &[("c1", "lsp", r#"{"action":"references","file":"src/a.rs","line":3}"#)], "toolUse");
    let t = turn(&[header(), &user("u1", "m0"), &lsp]);
    assert_eq!((t.pending[0].action.as_deref(), t.pending[0].what.as_deref()), (Some("references"), Some("src/a.rs")));
}

#[test]
fn a_reply_cut_off() {
    let reply = r#"{"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","content":[{"type":"text","text":"Here is the first half of"}],"stopReason":"aborted","errorMessage":"Request was aborted"}}"#;
    let t = turn(&[header(), &user("u1", "m0"), reply, &signal_exit("x1", "a1")]);
    assert!(t.cut_reply && !t.restorable, "omp's --restore would not go on with it; its retry does");
    assert!(t.replay.is_empty() && t.pending.is_empty());
    // The lab's D: a first reply cut off by SIGTERM. omp wrote the file with the aborted reply
    // and no exit record (it had no file to record one in); the same tail as a reply the user
    // stopped with Esc. Busy when last seen tells them apart (`decide`).
    let t = turn(&[header(), &user("u1", "m0"), reply]);
    assert!(t.cut_reply && !t.restorable);
    // exit recovery's own abort after an interrupted tool batch is no cut-off reply.
    let t = turn(&[header(), &user("u1", "m0"), &interrupted_abort("ab", "u1")]);
    assert!(!t.cut_reply);
    // A finished reply is just finished.
    let t = turn(&[header(), &user("u1", "m0"), &assistant_text("a1", "u1", "stop"), &signal_exit("x1", "a1")]);
    assert!(!t.cut_reply && !t.restorable);
}
