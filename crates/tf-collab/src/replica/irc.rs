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

use serde_json::Value;
use tf_proto::{IrcDirection, IrcMessage, IrcReceipt, ToolView};

use super::util::{arr, b, content_text, non_empty, s, ts};

const AGENT_SCHEME: &str = "agent://";
const PARENT_OPEN: &str = "<irc from=\"parent\" agent=\"";

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
            let receipts = send
                .map(|m| arr(m, "receipts"))
                .unwrap_or(&[])
                .iter()
                .filter_map(|r| {
                    Some(IrcReceipt {
                        to: non_empty(r, "to")?.to_owned(),
                        outcome: s(r, "outcome").unwrap_or("").to_owned(),
                        error: non_empty(r, "error").map(str::to_owned),
                    })
                })
                .collect();
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
}
