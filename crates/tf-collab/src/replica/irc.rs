//! omp IRC (agent ↔ agent messaging) → [`IrcMessage`].
//!
//! omp has no IRC frame of its own on collab: the `irc_message` session event is not mirrored,
//! and `irc:relay` / `irc:workpool` observations are display-only (never persisted). What does
//! reach a guest, and the session file:
//! - **inbound** `custom_message` `irc:incoming` (`details: {id, from, message, replyTo?,
//!   wakeRelay?, broadcast?, fromParent?}`), as an entry and as `message_start/end` with role
//!   `custom` (omp `session/irc-bridge.ts` `deliver`);
//! - **inbound from the parent mid-turn**: a steering `user` message rendered from
//!   `prompts/steering/parent-irc.md` (`[Wait interrupted by message]\n<irc from="parent"
//!   agent="…">\n{body}\n</irc>`);
//! - **inbound via `wait`**: the tool result `details: {op: "wait", from, waited: IrcMessage}`;
//! - **outbound**: a `write` call to `agent://<id>` (or `agent://all`), result
//!   `details.message: {op: "send", from, to, receipts}` (`internal-urls/agent-protocol.ts`).
//!
//! [`IrcFileScan`] also reads what the user sent a subagent (TeleFlock's message board, omp's
//! agent hub chat): omp writes it into the subagent's transcript as a prompt attributed to the
//! user (`role: "user"`, `attribution: "user"`), stamped with when it was sent. In the main
//! session's file such prompts are the session's own, not messages to an agent.

use std::collections::HashMap;

use serde_json::Value;
use tf_proto::{IrcDirection, IrcMessage, IrcReceipt, Millis, ToolView};

use super::util::{arr, b, content_text, non_empty, s, ts};

const AGENT_SCHEME: &str = "agent://";
const PARENT_OPEN: &str = "<irc from=\"parent\" agent=\"";

/// The sender of what the user sent a subagent ([`IrcFileScan`]).
pub const IRC_USER: &str = "user";

/// Recipient of a `write` to `agent://<id>` (`all` for a broadcast); `None` for other paths and
/// `agent://<id>/<json-path>` (a read target, never a message).
pub(crate) fn send_target(args: &Value) -> Option<&str> {
    let path = non_empty(args, "path").or_else(|| non_empty(args, "file_path"))?.trim();
    let rest = path.get(..AGENT_SCHEME.len()).filter(|p| p.eq_ignore_ascii_case(AGENT_SCHEME)).map(|_| &path[AGENT_SCHEME.len()..])?;
    let to = rest.split(['?', '#']).next().unwrap_or("");
    (!to.is_empty() && !to.contains('/')).then_some(to)
}

/// Inbound message carried by a user/custom message (`irc:incoming`, or a parent's steer).
pub(crate) fn incoming(role: &str, custom_type: Option<&str>, msg: &Value) -> Option<IrcMessage> {
    match custom_type {
        Some("irc:incoming") => {
            let d = msg.get("details")?;
            let peer = non_empty(d, "from")?.to_owned();
            let text = s(d, "message").map(str::to_owned).unwrap_or_else(|| content_text(msg.get("content")));
            Some(IrcMessage {
                direction: IrcDirection::In,
                peer,
                text,
                message_id: non_empty(d, "id").map(str::to_owned),
                reply_to: non_empty(d, "replyTo").map(str::to_owned),
                broadcast: b(d, "broadcast"),
                wake_relay: b(d, "wakeRelay"),
                from_parent: b(d, "fromParent"),
                receipts: Vec::new(),
                sent_at: ts(msg),
            })
        }
        None if role == "user" => parent_steer(&content_text(msg.get("content"))).map(|m| IrcMessage { sent_at: ts(msg), ..m }),
        _ => None,
    }
}

/// `[Wait interrupted by message]\n<irc from="parent" agent="Main">\nbody\n</irc>`.
fn parent_steer(text: &str) -> Option<IrcMessage> {
    let text = text.trim();
    let text = text.strip_prefix("[Wait interrupted by message]").map(str::trim_start).unwrap_or(text);
    let rest = text.strip_prefix(PARENT_OPEN)?;
    let (peer, rest) = rest.split_once("\">")?;
    let body = rest.trim_end().strip_suffix("</irc>")?;
    Some(IrcMessage {
        direction: IrcDirection::In,
        peer: peer.to_owned(),
        text: unescape_harness_tags(body.trim_matches('\n')),
        message_id: None,
        reply_to: None,
        broadcast: false,
        wake_relay: false,
        from_parent: true,
        receipts: Vec::new(),
        sent_at: None,
    })
}

/// Undo omp's `escapeHarnessTags` (`<irc`, `</system-…` → `&lt;…`) for display.
fn unescape_harness_tags(text: &str) -> String {
    if !text.contains("&lt;") {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("&lt;") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 4..];
        let tag = after.trim_start().trim_start_matches('/').trim_start();
        let harness = tag.get(..3).is_some_and(|t| t.eq_ignore_ascii_case("irc")) || tag.get(..7).is_some_and(|t| t.eq_ignore_ascii_case("system-"));
        out.push_str(if harness { "<" } else { "&lt;" });
        rest = after;
    }
    out.push_str(rest);
    out
}

/// Tool view for IRC traffic carried by a tool call: `write agent://<id>` sends and `wait`
/// results that consumed a message. `None` for every other call.
pub(crate) fn tool_view(name: &str, args: &Value, details: Option<&Value>) -> Option<ToolView> {
    match name {
        "write" => {
            let to = send_target(args)?;
            let send = details.and_then(|d| d.get("message"));
            let receipts = send.map(|m| arr(m, "receipts")).unwrap_or(&[]).iter().filter_map(receipt).collect();
            Some(ToolView::Irc(IrcMessage {
                direction: IrcDirection::Out,
                peer: to.to_owned(),
                text: s(args, "content").unwrap_or("").to_owned(),
                message_id: None,
                reply_to: None,
                broadcast: to == "all",
                wake_relay: false,
                from_parent: false,
                receipts,
                sent_at: None,
            }))
        }
        "wait" => {
            let w = details?.get("waited")?;
            Some(ToolView::Irc(IrcMessage {
                direction: IrcDirection::In,
                peer: non_empty(w, "from")?.to_owned(),
                text: s(w, "body").unwrap_or("").to_owned(),
                message_id: non_empty(w, "id").map(str::to_owned),
                reply_to: non_empty(w, "replyTo").map(str::to_owned),
                broadcast: b(w, "broadcast"),
                wake_relay: b(w, "wakeRelay"),
                from_parent: false,
                receipts: Vec::new(),
                sent_at: w.get("ts").and_then(Value::as_i64),
            }))
        }
        _ => None,
    }
}

/// One IRC message as one agent's session file shows it ([`IrcFileScan`]).
#[derive(Debug, Clone, PartialEq)]
pub struct IrcRecord {
    /// `Out`: the file's agent sent it (a `write agent://…` call with its result); `In`: it
    /// reached the file's agent (`irc:incoming`, a parent's steer, a `wait` that consumed it).
    pub direction: IrcDirection,
    pub from: String,
    /// `Out`: the addressed agent (`all` for a broadcast); `In`: the file's agent.
    pub to: String,
    pub text: String,
    /// Inbound: when omp sent it (omp ≥ 18.14 stamps the row with the message's own time; older
    /// ones with when the row was written, a little later). Outbound: when the `write` call was
    /// made (the assistant message that carries it).
    pub at: Option<Millis>,
    /// Outbound: when the call's result was written; the message was sent by then.
    pub until: Option<Millis>,
    /// Identity of the record within its file: the session entry's id (inbound) or the tool
    /// call's (outbound).
    pub key: String,
    /// omp's message id (inbound records, except a parent's steer).
    pub omp_id: Option<String>,
    pub reply_to: Option<String>,
    pub broadcast: bool,
    pub wake_relay: bool,
    pub progress: bool,
    /// `Out`: omp's per-recipient delivery outcomes.
    pub receipts: Vec<IrcReceipt>,
}

/// Whether a session-file line can hold an IRC message at all (cheap, before parsing it).
pub fn may_hold_irc(line: &str) -> bool {
    line.contains("irc:incoming")
        || line.contains(AGENT_SCHEME)
        || line.contains("\"waited\"")
        || line.contains("irc from=")
        || line.contains("\"op\":\"send\"")
        || line.contains("\"attribution\":\"user\"")
}

/// Reads the IRC messages out of one agent's omp session file, entry by entry in file order
/// (`write agent://…` calls are paired with their results, which come in later entries).
#[derive(Debug)]
pub struct IrcFileScan {
    agent: String,
    /// The main session's file: its user prompts are the session's own, not messages to an agent.
    main: bool,
    /// `write agent://…` calls waiting for their result.
    sends: HashMap<String, PendingSend>,
}

#[derive(Debug)]
struct PendingSend {
    to: String,
    text: String,
    at: Option<Millis>,
    progress: bool,
}

impl IrcFileScan {
    /// A scan of the file of agent `agent` (its omp registry id: `Main`, `Orchestrator.Worker`, …);
    /// `main`: the session's own file rather than a subagent's transcript.
    pub fn new(agent: &str, main: bool) -> IrcFileScan {
        IrcFileScan { agent: agent.to_owned(), main, sends: HashMap::new() }
    }

    pub fn agent(&self) -> &str {
        &self.agent
    }

    /// Starts the file over (omp rewrote it): calls still waiting for their result are dropped.
    pub fn reset(&mut self) {
        self.sends.clear();
    }

    /// One entry of the file: the message it completes, if any.
    pub fn entry(&mut self, entry: &Value) -> Option<IrcRecord> {
        let key = non_empty(entry, "id").unwrap_or_default().to_owned();
        match s(entry, "type")? {
            "custom_message" if s(entry, "customType") == Some("irc:incoming") => {
                let d = entry.get("details")?;
                Some(IrcRecord {
                    direction: IrcDirection::In,
                    key: if key.is_empty() { non_empty(d, "id").unwrap_or_default().to_owned() } else { key },
                    from: non_empty(d, "from")?.to_owned(),
                    to: self.agent.clone(),
                    text: s(d, "message").map(str::to_owned).unwrap_or_else(|| content_text(entry.get("content"))),
                    at: ts(entry),
                    until: None,
                    omp_id: non_empty(d, "id").map(str::to_owned),
                    reply_to: non_empty(d, "replyTo").map(str::to_owned),
                    broadcast: b(d, "broadcast"),
                    wake_relay: b(d, "wakeRelay"),
                    progress: b(d, "progress"),
                    receipts: Vec::new(),
                })
            }
            "message" => self.message(entry.get("message")?, entry, key),
            _ => None,
        }
    }

    fn message(&mut self, msg: &Value, entry: &Value, key: String) -> Option<IrcRecord> {
        let at = ts(msg).or_else(|| ts(entry));
        match s(msg, "role")? {
            "user" => {
                let text = content_text(msg.get("content"));
                // omp stamps the steer with the message's own time.
                if let Some(m) = parent_steer(&text) {
                    return Some(IrcRecord {
                        direction: IrcDirection::In,
                        key,
                        from: m.peer,
                        to: self.agent.clone(),
                        text: m.text,
                        at,
                        until: None,
                        omp_id: None,
                        reply_to: None,
                        broadcast: false,
                        wake_relay: false,
                        progress: false,
                        receipts: Vec::new(),
                    });
                }
                // What the user sent this subagent, stamped with when it was sent.
                if self.main || s(msg, "attribution") != Some("user") {
                    return None;
                }
                Some(IrcRecord {
                    direction: IrcDirection::In,
                    key,
                    from: IRC_USER.to_owned(),
                    to: self.agent.clone(),
                    text,
                    at,
                    until: None,
                    omp_id: None,
                    reply_to: None,
                    broadcast: false,
                    wake_relay: false,
                    progress: false,
                    receipts: Vec::new(),
                })
            }
            "assistant" => {
                for block in arr(msg, "content") {
                    if s(block, "type") != Some("toolCall") || s(block, "name") != Some("write") {
                        continue;
                    }
                    let (Some(id), Some(args)) = (non_empty(block, "id"), block.get("arguments")) else { continue };
                    if let Some(to) = send_target(args) {
                        let progress = send_progress(args);
                        self.sends.insert(id.to_owned(), PendingSend { to: to.to_owned(), text: s(args, "content").unwrap_or("").to_owned(), at, progress });
                    }
                }
                None
            }
            "toolResult" => {
                let d = msg.get("details");
                match s(msg, "toolName")? {
                    "write" => {
                        let call = non_empty(msg, "toolCallId")?;
                        let PendingSend { to, text, at: called, progress } = self.sends.remove(call)?;
                        let send = d.and_then(|d| d.get("message")).filter(|m| s(m, "op") == Some("send"));
                        let mut receipts: Vec<IrcReceipt> = send.map(|m| arr(m, "receipts")).unwrap_or(&[]).iter().filter_map(receipt).collect();
                        // Refused before any delivery (no such agent, itself, an empty message): no receipt.
                        if receipts.is_empty() && b(msg, "isError") && to != "all" {
                            let why = content_text(msg.get("content"));
                            receipts.push(IrcReceipt { to: to.clone(), outcome: "failed".into(), error: (!why.trim().is_empty()).then(|| why.trim().to_owned()) });
                        }
                        Some(IrcRecord {
                            direction: IrcDirection::Out,
                            key: call.to_owned(),
                            from: send.and_then(|m| non_empty(m, "from")).unwrap_or(&self.agent).to_owned(),
                            broadcast: to == "all",
                            to,
                            text,
                            at: called.or(at),
                            until: at,
                            omp_id: None,
                            reply_to: None,
                            wake_relay: false,
                            progress,
                            receipts,
                        })
                    }
                    "wait" => {
                        let w = d?.get("waited")?;
                        Some(IrcRecord {
                            direction: IrcDirection::In,
                            key,
                            from: non_empty(w, "from")?.to_owned(),
                            to: self.agent.clone(),
                            text: s(w, "body").unwrap_or("").to_owned(),
                            at: w.get("ts").and_then(Value::as_i64).or(at),
                            until: None,
                            omp_id: non_empty(w, "id").map(str::to_owned),
                            reply_to: non_empty(w, "replyTo").map(str::to_owned),
                            broadcast: b(w, "broadcast"),
                            wake_relay: b(w, "wakeRelay"),
                            progress: b(w, "progress"),
                            receipts: Vec::new(),
                        })
                    }
                    _ => None,
                }
            }
            _ => None,
        }
    }
}

/// `write agent://<id>?progress`: a progress note (omp promises the reply later).
fn send_progress(args: &Value) -> bool {
    let path = non_empty(args, "path").or_else(|| non_empty(args, "file_path")).unwrap_or("");
    path.split_once('?').is_some_and(|(_, q)| q.split(['&', '#']).any(|p| p == "progress" || p.starts_with("progress=")))
}

fn receipt(r: &Value) -> Option<IrcReceipt> {
    Some(IrcReceipt { to: non_empty(r, "to")?.to_owned(), outcome: s(r, "outcome").unwrap_or("").to_owned(), error: non_empty(r, "error").map(str::to_owned) })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn send_targets() {
        assert_eq!(send_target(&json!({"path": "agent://Main"})), Some("Main"));
        assert_eq!(send_target(&json!({"path": "agent://all"})), Some("all"));
        assert_eq!(send_target(&json!({"path": "agent://Main/reports/0"})), None);
        assert_eq!(send_target(&json!({"path": "src/agent.ts"})), None);
        assert_eq!(send_target(&json!({"path": "agent://"})), None);
    }

    #[test]
    fn parent_steer_body() {
        let m = parent_steer("[Wait interrupted by message]\n<irc from=\"parent\" agent=\"Main\">\nUse &lt;irc> tags? No. Keep a&lt;b.\n</irc>").unwrap();
        assert_eq!(m.peer, "Main");
        assert!(m.from_parent);
        assert_eq!(m.text, "Use <irc> tags? No. Keep a&lt;b.");
        assert!(parent_steer("plain prompt").is_none());
    }

    /// The entries omp 18.14 writes for IRC traffic (shapes taken from real session files).
    #[test]
    fn file_scan_reads_sends_receipts_and_inbound() {
        let mut scan = IrcFileScan::new("Orchestrator.WorkerA", false);
        let lines = [
            json!({"type": "message", "id": "e1", "timestamp": "2026-11-01T21:22:04.829Z", "message": {"role": "assistant", "timestamp": 1793568124829u64, "content": [
                {"type": "toolCall", "id": "c1", "name": "write", "arguments": {"path": "agent://Orchestrator.WorkerB", "content": "Which port do you use?"}},
                {"type": "toolCall", "id": "c2", "name": "write", "arguments": {"path": "src/x.ts", "content": "not a message"}},
                {"type": "toolCall", "id": "c4", "name": "write", "arguments": {"path": "agent://Orchestrator?progress", "content": "halfway"}},
                {"type": "toolCall", "id": "c5", "name": "write", "arguments": {"path": "agent://Nobody", "content": "hello?"}}
            ]}}),
            json!({"type": "message", "id": "e2", "message": {"role": "toolResult", "toolCallId": "c2", "toolName": "write", "details": {}, "timestamp": 1793568124830u64}}),
            json!({"type": "message", "id": "e3", "message": {"role": "toolResult", "toolCallId": "c1", "toolName": "write", "timestamp": 1793568124831u64,
                "details": {"message": {"op": "send", "from": "Orchestrator.WorkerA", "to": "Orchestrator.WorkerB", "receipts": [{"to": "Orchestrator.WorkerB", "outcome": "injected"}]}}}}),
            json!({"type": "message", "id": "e4", "message": {"role": "toolResult", "toolCallId": "c4", "toolName": "write", "timestamp": 1793568124832u64,
                "details": {"message": {"op": "send", "from": "Orchestrator.WorkerA", "to": "Orchestrator", "receipts": [{"to": "Orchestrator", "outcome": "injected"}]}}}}),
            json!({"type": "message", "id": "e5", "message": {"role": "toolResult", "toolCallId": "c5", "toolName": "write", "timestamp": 1793568124833u64, "isError": true,
                "content": [{"type": "text", "text": "Failed: Nobody is not running."}], "details": {"message": {"op": "send", "from": "Orchestrator.WorkerA", "to": "Nobody"}}}}),
            json!({"type": "custom_message", "id": "e6", "customType": "irc:incoming", "timestamp": "2026-11-01T21:22:09.000Z",
                "details": {"id": "15bd1", "from": "Orchestrator.WorkerB", "message": "7420", "replyTo": "15bd0", "wakeRelay": true}}),
            json!({"type": "message", "id": "e7", "message": {"role": "user", "timestamp": 1793568130000u64, "content": "[Wait interrupted by message]\n<irc from=\"parent\" agent=\"Orchestrator\">\nStop and report.\n</irc>"}}),
            json!({"type": "message", "id": "e8", "message": {"role": "toolResult", "toolCallId": "c3", "toolName": "wait", "timestamp": 1793568140000u64,
                "details": {"op": "wait", "from": "Orchestrator.WorkerA", "waited": {"id": "15bd2", "from": "Main", "to": "Orchestrator.WorkerA", "body": "ping", "ts": 1793568139000u64, "progress": true}}}}),
        ];
        let got: Vec<IrcRecord> = lines.iter().filter_map(|l| scan.entry(l)).collect();
        assert_eq!(got.len(), 6, "{got:#?}");
        let send = &got[0];
        assert_eq!((send.direction, send.from.as_str(), send.to.as_str(), send.text.as_str(), send.key.as_str()), (IrcDirection::Out, "Orchestrator.WorkerA", "Orchestrator.WorkerB", "Which port do you use?", "c1"));
        assert_eq!((send.at, send.until), (Some(1793568124829), Some(1793568124831)), "made with its call, sent by its result");
        assert_eq!(send.receipts, vec![IrcReceipt { to: "Orchestrator.WorkerB".into(), outcome: "injected".into(), error: None }]);
        assert!(!send.progress && got[1].progress, "`?progress` marks a progress note");
        assert_eq!(got[1].to, "Orchestrator");
        let refused = &got[2];
        assert_eq!(refused.receipts, vec![IrcReceipt { to: "Nobody".into(), outcome: "failed".into(), error: Some("Failed: Nobody is not running.".into()) }]);
        let inbound = &got[3];
        assert_eq!((inbound.from.as_str(), inbound.to.as_str(), inbound.omp_id.as_deref(), inbound.reply_to.as_deref(), inbound.key.as_str()), ("Orchestrator.WorkerB", "Orchestrator.WorkerA", Some("15bd1"), Some("15bd0"), "e6"));
        assert!(inbound.wake_relay && inbound.until.is_none());
        let steer = &got[4];
        assert_eq!((steer.from.as_str(), steer.text.as_str(), steer.at), ("Orchestrator", "Stop and report.", Some(1793568130000)));
        let waited = &got[5];
        assert_eq!((waited.from.as_str(), waited.at, waited.progress), ("Main", Some(1793568139000), true), "a wait's message carries omp's send time");
        // The cheap pre-filter keeps every line that holds a message and drops the plain write's result.
        let held: Vec<bool> = lines.iter().map(|l| may_hold_irc(&l.to_string())).collect();
        assert_eq!(held, vec![true, false, true, true, true, true, true, true]);
    }

    /// What the user sent a subagent (TeleFlock's message board, omp's agent hub chat): omp writes
    /// it into the subagent's transcript as a prompt attributed to the user, stamped with when it
    /// was sent (omp 18.15 `AgentSession.prompt`; shapes taken from a lab run).
    #[test]
    fn file_scan_reads_what_the_user_sent_a_subagent() {
        let assignment = json!({"type": "message", "id": "u0", "message": {"role": "user", "attribution": "agent", "timestamp": 1793570983577u64, "content": [{"type": "text", "text": "Complete assignment thoroughly:\n\nBuild the API."}]}});
        let chat = json!({"type": "message", "id": "u1", "timestamp": "2026-11-01T22:09:54.103Z", "message": {"role": "user", "attribution": "user", "timestamp": 1793570994097u64, "content": [{"type": "text", "text": "Thanks, all done here."}]}});
        let mut scan = IrcFileScan::new("Orchestrator.WorkerA", false);
        assert!(scan.entry(&assignment).is_none(), "the parent's assignment is the task, not a message");
        let got = scan.entry(&chat).expect("the user's message");
        assert_eq!((got.direction, got.from.as_str(), got.to.as_str(), got.text.as_str()), (IrcDirection::In, IRC_USER, "Orchestrator.WorkerA", "Thanks, all done here."));
        assert_eq!((got.at, got.key.as_str(), got.omp_id.as_deref()), (Some(1793570994097), "u1", None), "omp's stamp: when it was sent");
        assert!(may_hold_irc(&chat.to_string()));
        // In the main session's file the same line is one of the session's own prompts.
        assert!(IrcFileScan::new("Main", true).entry(&chat).is_none());
    }
}
