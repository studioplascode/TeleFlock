//! Turn errors, provider refusals and notices: every way a message can fail shows one error, omp's
//! auto-retried attempts stay hidden, and rows only seen live (warnings, a refusal omp never
//! persists) come back where they were after a resync or a tf-hostd restart.

use std::collections::HashMap;

use serde_json::{json, Value};
use tf_proto::*;

use super::{LiveRow, Replica, Signal};
use crate::frame::{HostFrame, SessionHeader, SessionState, Welcome};
use crate::guest::{GuestEvent, Snapshot};

const SID: &str = "01a18769-c0ed-73ef-b9e0-c7c8190764dd";
const T0: Millis = 1_793_300_000_000;

/// A replica fed event by event, a client that only applies what it emitted, and its signals.
struct Live {
    r: Replica,
    order: Vec<String>,
    items: HashMap<String, TranscriptItem>,
    signals: Vec<Signal>,
    now: Millis,
}

impl Live {
    fn new() -> Live {
        Live::with(Replica::new("agent"))
    }

    fn with(r: Replica) -> Live {
        Live { r, order: Vec::new(), items: HashMap::new(), signals: Vec::new(), now: T0 }
    }

    fn apply(&mut self, ev: GuestEvent) {
        self.now += 10;
        let up = self.r.apply(&ev, self.now);
        for e in up.events {
            match e {
                SessionEvent::Reset { snapshot } => {
                    self.order = snapshot.items.iter().map(|i| i.id().to_owned()).collect();
                    self.items = snapshot.items.into_iter().map(|i| (i.id().to_owned(), i)).collect();
                }
                SessionEvent::Upsert { item, .. } => {
                    if !self.items.contains_key(item.id()) {
                        self.order.push(item.id().to_owned());
                    }
                    self.items.insert(item.id().to_owned(), item);
                }
                SessionEvent::Append { id, text, .. } => match self.items.get_mut(&id) {
                    Some(TranscriptItem::Assistant(a)) => a.text.push_str(&text),
                    Some(TranscriptItem::Thinking(t)) => t.text.push_str(&text),
                    Some(TranscriptItem::Tool(t)) => t.output.get_or_insert_with(String::new).push_str(&text),
                    other => panic!("append to {id}: {other:?}"),
                },
                SessionEvent::Remove { id } => {
                    self.items.remove(&id);
                    self.order.retain(|x| *x != id);
                }
                _ => {}
            }
        }
        self.signals.extend(up.signals);
    }

    fn event(&mut self, ev: Value) {
        self.apply(GuestEvent::Frame(HostFrame::Event { event: ev }));
    }

    fn entry(&mut self, msg: &Value) {
        self.apply(GuestEvent::Frame(HostFrame::Entry { entry: entry(msg) }));
    }

    /// The client's rows, checked against the replica's own.
    fn rows(&self) -> Vec<TranscriptItem> {
        let mine: Vec<TranscriptItem> = self.order.iter().map(|id| self.items[id].clone()).collect();
        assert_eq!(mine, self.r.snapshot(usize::MAX).items, "the client's rows equal the replica's");
        mine
    }

    fn ids(&self) -> Vec<String> {
        self.rows().iter().map(|i| i.id().to_owned()).collect()
    }

    fn assistant(&self, id: &str) -> AssistantItem {
        match self.items.get(id) {
            Some(TranscriptItem::Assistant(a)) => a.clone(),
            other => panic!("no assistant row {id}: {other:?}"),
        }
    }

    fn turn_ended(&self) -> Vec<&Signal> {
        self.signals.iter().filter(|s| matches!(s, Signal::TurnEnded { .. })).collect()
    }

    fn kept(&self) -> Vec<LiveRow> {
        self.signals
            .iter()
            .filter_map(|s| match s {
                Signal::RowKept { row } => Some(row.clone()),
                _ => None,
            })
            .collect()
    }

    /// A user prompt and the assistant message that answers it, as omp streams them.
    fn turn(&mut self, prompt: &Value, reply: &Value) {
        self.event(json!({ "type": "agent_start" }));
        self.event(json!({ "type": "message_start", "message": prompt }));
        self.event(json!({ "type": "message_end", "message": prompt }));
        self.reply(reply);
        self.event(json!({ "type": "agent_end" }));
    }

    /// An assistant message streaming (each block growing in turn), then its end.
    fn reply(&mut self, msg: &Value) {
        let empty = json!({ "role": "assistant", "content": [], "timestamp": msg["timestamp"], "stopReason": "stop" });
        self.event(json!({ "type": "message_start", "message": empty }));
        let blocks = msg["content"].as_array().cloned().unwrap_or_default();
        for n in 1..=blocks.len() {
            let mut partial = msg.clone();
            partial["content"] = Value::Array(blocks[..n].to_vec());
            partial["stopReason"] = json!("stop");
            for key in ["errorMessage", "errorStatus", "errorId", "stopDetails", "fallbackCreditHandle"] {
                partial.as_object_mut().unwrap().remove(key);
            }
            self.event(json!({ "type": "message_update", "message": partial, "assistantMessageEvent": { "type": "text_delta" } }));
        }
        self.event(json!({ "type": "message_end", "message": msg }));
    }
}

fn snapshot(entries: Vec<Value>) -> GuestEvent {
    let header = SessionHeader { id: SID.into(), timestamp: "2026-10-29T10:00:00.000Z".into(), cwd: "/w".into(), title: None, extra: Default::default() };
    let welcome = Welcome { proto: crate::COLLAB_PROTO, header, state: SessionState::default(), agents: Vec::new(), entry_count: entries.len() as u64, read_only: false };
    GuestEvent::Snapshot(Snapshot { welcome, entries, resync: true })
}

fn entry(msg: &Value) -> Value {
    json!({ "type": "message", "id": format!("e{}", msg["timestamp"]), "parentId": null, "timestamp": msg["timestamp"], "message": msg })
}

fn user(t: Millis, text: &str) -> Value {
    json!({ "role": "user", "content": [{ "type": "text", "text": text }], "timestamp": t })
}

fn assistant(t: Millis, content: Value, stop: &str, extra: Value) -> Value {
    let mut msg = json!({ "role": "assistant", "content": content, "stopReason": stop, "model": "claude-opus-5", "timestamp": t,
        "usage": { "input": 120, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": { "total": 0.0004 } } });
    for (k, v) in extra.as_object().cloned().unwrap_or_default() {
        msg[k.as_str()] = v;
    }
    msg
}

fn failed(t: Millis, content: Value) -> Value {
    assistant(t, content, "error", json!({ "errorMessage": "529 Overloaded: the provider is overloaded", "errorStatus": 529 }))
}

fn rows_with_errors(rows: &[TranscriptItem]) -> Vec<String> {
    rows.iter()
        .filter_map(|i| match i {
            TranscriptItem::Assistant(a) if a.error.is_some() => Some(a.id.clone()),
            _ => None,
        })
        .collect()
}

/// A replica rebuilt from `entries` (a resync or a tf-hostd restart reading the session file), with
/// the notes and live rows tf-hostd kept of `from`.
fn rebuilt(entries: &[Value], from: Option<&Live>) -> Live {
    let mut fresh = Live::new();
    if let Some(live) = from {
        fresh.r.keep_notes(live.r.notes().clone());
        fresh.r.keep_rows(live.kept());
    }
    fresh.apply(snapshot(entries.iter().map(entry).collect()));
    fresh
}

/// Rows without tool calls (a call the run never finished stays pending in a rebuild).
fn no_tools(rows: Vec<TranscriptItem>) -> Vec<TranscriptItem> {
    rows.into_iter().filter(|i| !matches!(i, TranscriptItem::Tool(_))).collect()
}

#[test]
fn every_failure_shape_gets_one_error_row() {
    let thinking = json!({ "type": "thinking", "thinking": "Let me check the logs first." });
    let call = json!({ "type": "toolCall", "id": "c1", "name": "bash", "arguments": { "command": "ls" } });
    for (shape, content) in [
        ("blank text", json!([{ "type": "text", "text": "" }])),
        ("whitespace text", json!([{ "type": "text", "text": "\n " }])),
        ("no content", json!([])),
        ("thinking only", json!([thinking.clone()])),
        ("thinking and a tool call", json!([thinking.clone(), call.clone()])),
    ] {
        let (prompt, reply) = (user(T0 + 1, "deploy it"), failed(T0 + 2, content));
        let mut live = Live::new();
        live.apply(snapshot(Vec::new()));
        live.turn(&prompt, &reply);
        let rows = live.rows();
        assert_eq!(rows_with_errors(&rows), [format!("a{}.e", T0 + 2)], "{shape}: one error row");
        let a = live.assistant(&format!("a{}.e", T0 + 2));
        assert_eq!((a.text.as_str(), a.stop_reason.as_deref(), a.error_status), ("", Some("error"), Some(529)), "{shape}");
        assert_eq!(a.error.as_deref(), Some("529 Overloaded: the provider is overloaded"));
        assert_eq!(a.model.as_deref(), Some("claude-opus-5"));
        // Its thinking and tool rows keep their own ids.
        if shape.starts_with("thinking") {
            assert!(matches!(live.items.get(&format!("a{}.0", T0 + 2)), Some(TranscriptItem::Thinking(_))), "{shape}");
        }
        assert_eq!(rows.iter().any(|i| i.id() == "t:c1"), shape.ends_with("tool call"), "{shape}");
        assert_eq!(
            live.turn_ended(),
            [&Signal::TurnEnded { aborted: false, error: Some("529 Overloaded: the provider is overloaded".into()), refusal: None }],
            "{shape}"
        );
        // omp persists a terminal error turn: the rebuild shows the same rows.
        let fresh = rebuilt(&[prompt, reply], Some(&live));
        assert_eq!(fresh.ids(), live.ids(), "{shape}");
        assert_eq!(no_tools(fresh.rows()), no_tools(rows), "{shape}: rebuilt equals live");
    }
}

#[test]
fn partial_text_shows_the_error_once() {
    let reply = failed(
        T0 + 2,
        json!([{ "type": "text", "text": "First I'll check the config." }, { "type": "thinking", "thinking": "hm" }, { "type": "text", "text": "Now the" }]),
    );
    let mut live = Live::new();
    live.apply(snapshot(Vec::new()));
    live.turn(&user(T0 + 1, "go"), &reply);
    let rows = live.rows();
    assert_eq!(rows_with_errors(&rows), [format!("a{}.2", T0 + 2)], "only the last text row carries the error");
    let first = live.assistant(&format!("a{}.0", T0 + 2));
    assert_eq!((first.stop_reason, first.error), (None, None));
    let last = live.assistant(&format!("a{}.2", T0 + 2));
    assert_eq!((last.text.as_str(), last.stop_reason.as_deref()), ("Now the", Some("error")));
    assert!(!live.items.contains_key(&format!("a{}.e", T0 + 2)), "no extra error row");
    // omp keeps a failed message with text: nothing to keep for it.
    assert!(live.kept().is_empty());
}

#[test]
fn refusals_carry_category_and_explanation() {
    let refusal = |t: Millis, content: Value| {
        assistant(t, content, "error", json!({
            "errorMessage": "Refusal (cyber): The request asks for working exploit code.",
            "stopDetails": { "type": "refusal", "category": "cyber", "explanation": "The request asks for working exploit code.", "fallback_credit_token": "fct_secret" },
            "fallbackCreditHandle": { "token": "fct_secret", "params": { "messages": ["the whole request"] } },
        }))
    };
    let want = Refusal { kind: "refusal".into(), category: Some("cyber".into()), explanation: Some("The request asks for working exploit code.".into()) };
    // Before any output, and after some (the classifier can stop a reply midway).
    for (content, row) in [(json!([{ "type": "text", "text": "" }]), "e"), (json!([{ "type": "text", "text": "Sure, step one is" }]), "0")] {
        let mut live = Live::new();
        live.apply(snapshot(Vec::new()));
        live.turn(&user(T0 + 1, "write an exploit"), &refusal(T0 + 2, content));
        let a = live.assistant(&format!("a{}.{row}", T0 + 2));
        assert_eq!(a.refusal.as_ref(), Some(&want));
        assert_eq!(a.error.as_deref(), Some("Refusal (cyber): The request asks for working exploit code."));
        assert_eq!(live.turn_ended(), [&Signal::TurnEnded { aborted: false, error: a.error.clone(), refusal: Some(want.clone()) }]);
        // omp never persists a refusal: it is kept, without the refused text or omp's credit.
        let kept = live.kept();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].after.as_deref(), Some(format!("u{}", T0 + 1).as_str()));
        let stored = serde_json::to_string(&kept[0]).unwrap();
        assert!(!stored.contains("fct_secret") && !stored.contains("the whole request") && !stored.contains("step one"), "{stored}");
        match &kept[0].item {
            TranscriptItem::Assistant(k) => assert_eq!((k.id.as_str(), k.text.as_str(), k.refusal.as_ref()), (a.id.as_str(), "", Some(&want))),
            other => panic!("{other:?}"),
        }
    }
}

#[test]
fn aborts_show_their_reason_but_never_a_user_interrupt() {
    let interrupt = json!({ "errorMessage": "Interrupted by user", "errorId": 0x0400_1000 });
    let cases = [
        // (content, extra, error row?, text row's error, TurnEnded error)
        (json!([]), interrupt.clone(), false, None, None),
        (json!([{ "type": "text", "text": "Counting: one, two" }]), interrupt.clone(), false, None, None),
        (json!([]), json!({ "errorMessage": "Stream stalled: no data for 120s" }), true, None, Some("Stream stalled: no data for 120s")),
        (json!([{ "type": "text", "text": "Reading" }]), json!({ "errorMessage": "Stream stalled: no data for 120s" }), false, Some("Stream stalled: no data for 120s"), Some("Stream stalled: no data for 120s")),
    ];
    for (i, (content, extra, error_row, text_error, ended)) in cases.into_iter().enumerate() {
        let has_text = !content.as_array().unwrap().is_empty();
        let mut live = Live::new();
        live.apply(snapshot(Vec::new()));
        live.turn(&user(T0 + 1, "count"), &assistant(T0 + 2, content, "aborted", extra));
        assert_eq!(live.items.contains_key(&format!("a{}.e", T0 + 2)), error_row, "case {i}");
        if has_text {
            let a = live.assistant(&format!("a{}.0", T0 + 2));
            assert_eq!((a.stop_reason.as_deref(), a.error.as_deref()), (Some("aborted"), text_error), "case {i}");
        }
        assert_eq!(live.turn_ended(), [&Signal::TurnEnded { aborted: true, error: ended.map(str::to_owned), refusal: None }], "case {i}");
    }
}

#[test]
fn retried_attempts_stay_hidden_live_and_rebuilt() {
    let prompt = user(T0 + 1, "summarize");
    let blank = failed(T0 + 2, json!([{ "type": "text", "text": "" }]));
    let thought = failed(T0 + 3, json!([{ "type": "thinking", "thinking": "Reading the diff." }]));
    let answer = assistant(T0 + 4, json!([{ "type": "text", "text": "Done: three files changed." }]), "stop", json!({}));
    let mut live = Live::new();
    live.apply(snapshot(Vec::new()));
    live.event(json!({ "type": "agent_start" }));
    live.event(json!({ "type": "message_start", "message": prompt }));
    live.reply(&blank);
    assert_eq!(rows_with_errors(&live.rows()), [format!("a{}.e", T0 + 2)], "shown until omp retries");
    // omp persists the attempt before it retries; the file's tail lands first.
    live.entry(&blank);
    live.event(json!({ "type": "auto_retry_start", "attempt": 1, "maxAttempts": 3, "delayMs": 500, "errorMessage": "529 Overloaded" }));
    assert!(rows_with_errors(&live.rows()).is_empty(), "the retry supersedes the attempt");
    // A late copy of the entry does not bring it back.
    live.entry(&blank);
    live.reply(&thought);
    live.event(json!({ "type": "auto_retry_start", "attempt": 2, "maxAttempts": 3, "delayMs": 900, "errorMessage": "529 Overloaded" }));
    live.reply(&answer);
    live.event(json!({ "type": "agent_end" }));
    live.event(json!({ "type": "auto_retry_end", "success": true, "attempt": 2 }));
    let rows = live.rows();
    assert!(rows_with_errors(&rows).is_empty(), "{rows:?}");
    assert!(matches!(live.items.get(&format!("a{}.0", T0 + 3)), Some(TranscriptItem::Thinking(_))), "the attempt's thinking stays");
    assert_eq!(live.turn_ended(), [&Signal::TurnEnded { aborted: false, error: None, refusal: None }]);
    assert!(live.kept().is_empty());
    // The file has every attempt (omp ≥ 18.13 stamps `retryRecovery` on them later); a rebuild shows
    // what the live replica did, minus the live-only retry notice.
    let live_ids: Vec<String> = live.ids().into_iter().filter(|id| !id.starts_with('r')).collect();
    for stamp in [json!(null), json!({ "kind": "auto-retry", "status": "recovered" })] {
        let mark = |m: &Value| {
            let mut m = m.clone();
            if !stamp.is_null() {
                m["retryRecovery"] = stamp.clone();
            }
            m
        };
        let fresh = rebuilt(&[prompt.clone(), mark(&blank), mark(&thought), answer.clone()], None);
        assert_eq!(fresh.ids(), live_ids, "stamp {stamp}");
    }
    // A retry still running when the session is rebuilt: the resync's in-flight `auto_retry_start`
    // supersedes the attempt the file already has.
    let mut fresh = rebuilt(&[prompt.clone(), blank.clone()], None);
    assert_eq!(rows_with_errors(&fresh.rows()), [format!("a{}.e", T0 + 2)]);
    fresh.event(json!({ "type": "auto_retry_start", "attempt": 1, "maxAttempts": 3, "delayMs": 500, "errorMessage": "529 Overloaded" }));
    assert!(rows_with_errors(&fresh.rows()).is_empty());
}

#[test]
fn xdev_mount_notices_stay_out_of_the_chat() {
    let mut live = Live::new();
    live.apply(snapshot(Vec::new()));
    live.event(json!({ "type": "notice", "level": "info", "message": "xd://: mounted mcp__openship_get_projects, mcp__openship_get_deployments", "source": "xdev" }));
    assert!(live.rows().is_empty());
    assert!(!live.signals.iter().any(|s| matches!(s, Signal::Notice { .. })), "no activity either");
    // Only the mount notices: anything else stays.
    live.event(json!({ "type": "notice", "level": "warning", "message": "xd://: could not mount mcp__broken", "source": "xdev" }));
    live.event(json!({ "type": "notice", "level": "info", "message": "Prewalk: injected deep-plan nudge.", "source": "prewalk" }));
    assert_eq!(live.rows().len(), 2);
}

#[test]
fn warnings_are_notice_rows_kept_across_resyncs() {
    let first = [user(T0 + 1, "hi"), assistant(T0 + 2, json!([{ "type": "text", "text": "Hello." }]), "stop", json!({}))];
    let mut live = Live::new();
    live.apply(snapshot(first.iter().map(entry).collect()));
    live.event(json!({ "type": "notice", "level": "warning", "message": "Fallback: anthropic/claude-opus-5 → openai/gpt-6-luna", "source": "fallback" }));
    live.event(json!({ "type": "notice", "level": "info", "message": "Fallback succeeded on openai/gpt-6-luna", "source": "fallback" }));
    live.event(json!({ "type": "notice", "level": "error", "message": "Deploy failed: exit 1", "source": "extension" }));
    // A config warning comes with every resync: one row.
    let config = json!({ "type": "notice", "level": "warning", "message": "retry.fallbackChains: unknown model foo/bar", "source": "config", "key": "config:4f2a" });
    live.event(config.clone());
    live.event(config.clone());
    let rows = live.rows();
    let notices: Vec<(NoticeLevel, String, Option<String>)> = rows
        .iter()
        .filter_map(|i| match i {
            TranscriptItem::Notice(n) => Some((n.level, n.text.clone(), n.source.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(notices.len(), 4, "{notices:?}");
    assert_eq!(notices[0], (NoticeLevel::Warn, "Fallback: anthropic/claude-opus-5 → openai/gpt-6-luna".into(), Some("fallback".into())));
    assert!(live.items.contains_key("n:config:4f2a"));
    // Warnings and errors are kept; info is not.
    assert_eq!(live.kept().iter().map(|r| r.item.id().to_owned()).filter(|id| id == "n:config:4f2a").count(), 1);
    assert_eq!(live.kept().len(), 3);
    // A resync rebuilds the transcript from the file: the kept notices come back where they were.
    let before = live.ids();
    live.apply(snapshot(first.iter().map(entry).collect()));
    live.event(config);
    let after = live.ids();
    let info = before.iter().find(|id| matches!(live.r.item(id), None)).cloned();
    assert_eq!(after, before.iter().filter(|id| Some(*id) != info.as_ref()).cloned().collect::<Vec<_>>(), "only the info notice is gone");
}

#[test]
fn refusal_and_warning_survive_a_restart() {
    let (u1, a1) = (user(T0 + 1, "hi"), assistant(T0 + 2, json!([{ "type": "text", "text": "Hello." }]), "stop", json!({})));
    let u2 = user(T0 + 5, "now write the exploit");
    let refused = assistant(T0 + 6, json!([{ "type": "text", "text": "" }]), "error", json!({
        "errorMessage": "Refusal (cyber): Exploit development.",
        "stopDetails": { "type": "refusal", "category": "cyber", "explanation": "Exploit development." },
    }));
    let mut live = Live::new();
    live.apply(snapshot([&u1, &a1].into_iter().map(entry).collect()));
    live.event(json!({ "type": "notice", "level": "warning", "message": "MCP server github failed to start", "source": "extension" }));
    live.turn(&u2, &refused);
    let want = live.rows();
    assert_eq!(live.ids(), [format!("u{}", T0 + 1), format!("a{}.0", T0 + 2), live.ids()[2].clone(), format!("u{}", T0 + 5), format!("a{}.e", T0 + 6)]);
    // tf-hostd persisted the kept rows (JSON lines) and restarts: a new replica of the session reads
    // a file that has the prompt but not the refusal (omp never writes one).
    let stored: Vec<String> = live.kept().iter().map(|r| serde_json::to_string(r).unwrap()).collect();
    assert_eq!(stored.len(), 2);
    let kept: Vec<LiveRow> = stored.iter().map(|l| serde_json::from_str(l).unwrap()).collect();
    let mut fresh = Live::new();
    fresh.r.keep_notes(live.r.notes().clone());
    fresh.r.keep_rows(kept);
    fresh.apply(snapshot([&u1, &a1, &u2].into_iter().map(entry).collect()));
    assert_eq!(fresh.rows(), want, "the restart shows what the live session did");
    // Kept rows are no new events: nothing to notify about again.
    assert!(!fresh.signals.iter().any(|s| matches!(s, Signal::Notice { .. } | Signal::TurnEnded { .. } | Signal::RowKept { .. })));
}
