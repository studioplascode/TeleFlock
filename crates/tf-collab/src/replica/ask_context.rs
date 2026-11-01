//! The agent's explanation for a pending ask ([`tf_proto::UiRequest::context`]): what it wrote
//! before asking, so every ask surface shows it without the transcript.

use std::collections::HashMap;

use tf_proto::{Millis, TranscriptItem};

/// At most this many bytes of explanation reach clients: the end of a longer one.
pub(crate) const CONTEXT_MAX: usize = 4 * 1024;
/// How far back from the ask call the turn is searched, in rows.
const SCAN_ROWS: usize = 400;
/// Leads an explanation cut to its end.
const CUT_MARK: &str = "…\n\n";

/// What the agent wrote before the ask call whose row is `tool_row`: the text rows of the assistant
/// message that carries the call, before it; else the text of the agent's latest assistant message
/// since the last prompt (a user row that is not synthetic, or a compaction). Never thinking.
/// Bounded by [`bound`]; empty when there is none.
pub(crate) fn ask_context(order: &[String], items: &HashMap<String, TranscriptItem>, tool_row: &str) -> String {
    let Some(pos) = order.iter().rposition(|id| id == tool_row) else { return String::new() };
    let Some(TranscriptItem::Tool(tool)) = items.get(tool_row) else { return String::new() };
    // The turn's rows before the call, newest first.
    let turn: Vec<&TranscriptItem> = order[..pos]
        .iter()
        .rev()
        .take(SCAN_ROWS)
        .filter_map(|id| items.get(id))
        .take_while(|item| match item {
            TranscriptItem::User(u) => u.synthetic,
            TranscriptItem::Compaction(_) => false,
            _ => true,
        })
        .collect();
    // A message's text rows share its timestamp (`a<ts>.<block>`), as do its tool calls' rows.
    let message_text = |at: Millis| -> String {
        let mut parts: Vec<&str> = turn
            .iter()
            .filter_map(|item| match item {
                TranscriptItem::Assistant(a) if a.at == at && !a.text.trim().is_empty() => Some(a.text.trim()),
                _ => None,
            })
            .collect();
        parts.reverse();
        parts.join("\n\n")
    };
    let mut text = message_text(tool.at);
    if text.is_empty() {
        let latest = turn.iter().find_map(|item| match item {
            TranscriptItem::Assistant(a) if !a.text.trim().is_empty() => Some(a.at),
            _ => None,
        });
        if let Some(at) = latest {
            text = message_text(at);
        }
    }
    bound(&text)
}

/// `text` within [`CONTEXT_MAX`]. A longer one keeps its end, led by a `…` paragraph, from the first
/// paragraph start that fits (outside code blocks), unless that drops more than half the room a
/// line cut keeps: then from the first line start that fits, where one inside a code block reopens
/// its fence; a single overlong line is cut at a character.
pub(crate) fn bound(text: &str) -> String {
    let text = text.trim();
    if text.len() <= CONTEXT_MAX {
        return text.to_owned();
    }
    let room = CONTEXT_MAX - CUT_MARK.len();
    let min = text.len() - room;
    // The first paragraph start, line start outside a code block, and line start inside one (with
    // the line that opened it) at or after `min`.
    let (mut paragraph, mut line, mut fenced) = (None, None, None);
    let mut fence: Option<&str> = None;
    let mut blank_before = false;
    let mut at = 0;
    for l in text.split_inclusive('\n') {
        if at >= min {
            match fence {
                None if blank_before => {
                    paragraph = Some(at);
                    line.get_or_insert(at);
                    break;
                }
                None => {
                    line.get_or_insert(at);
                }
                Some(open) => {
                    fenced.get_or_insert((at, open));
                }
            }
        }
        let t = l.trim();
        if t.starts_with("```") || t.starts_with("~~~") {
            fence = match fence {
                Some(_) => None,
                None => Some(l.trim_end()),
            };
        }
        blank_before = t.is_empty();
        at += l.len();
    }
    let (start, reopen) = match (paragraph, line, fenced) {
        (Some(p), _, _) if p - min <= room / 2 => (p, None),
        (_, Some(l), Some((f, open))) if f < l => (f, Some(open)),
        (_, Some(l), _) => (l, None),
        (_, None, Some((f, open))) => (f, Some(open)),
        _ => ((min..text.len()).find(|&i| text.is_char_boundary(i)).unwrap_or(text.len()), None),
    };
    let mut out = String::with_capacity(CUT_MARK.len() + text.len() - start + reopen.map_or(0, |o| o.len() + 1));
    out.push_str(CUT_MARK);
    if let Some(open) = reopen {
        out.push_str(open);
        out.push('\n');
    }
    out.push_str(text[start..].trim_start_matches('\n'));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tf_proto::{AssistantItem, CompactionItem, ThinkingItem, ToolItem, ToolStatus, UserItem};

    fn say(id: &str, at: Millis, text: &str) -> TranscriptItem {
        TranscriptItem::Assistant(AssistantItem {
            id: id.into(),
            at,
            text: text.into(),
            streaming: false,
            model: None,
            usage: None,
            stop_reason: None,
            error: None,
            error_status: None,
            refusal: None,
        })
    }

    fn think(id: &str, at: Millis, text: &str) -> TranscriptItem {
        TranscriptItem::Thinking(ThinkingItem { id: id.into(), at, text: text.into(), streaming: false, duration_ms: None, redacted: false })
    }

    fn user(id: &str, at: Millis, text: &str, synthetic: bool) -> TranscriptItem {
        TranscriptItem::User(UserItem { id: id.into(), at, text: text.into(), images: vec![], author: None, steering: false, synthetic })
    }

    fn tool(id: &str, at: Millis, name: &str) -> TranscriptItem {
        TranscriptItem::Tool(ToolItem {
            id: id.into(),
            at,
            call_id: id.trim_start_matches("t:").into(),
            tool: name.into(),
            title: name.into(),
            intent: None,
            args: serde_json::Value::Null,
            status: ToolStatus::Running,
            duration_ms: None,
            output: None,
            truncated: false,
            view: None,
            error: None,
        })
    }

    fn transcript(rows: Vec<TranscriptItem>) -> (Vec<String>, HashMap<String, TranscriptItem>) {
        let order = rows.iter().map(|r| r.id().to_owned()).collect();
        (order, rows.into_iter().map(|r| (r.id().to_owned(), r)).collect())
    }

    #[test]
    fn the_asks_own_message_before_the_call() {
        let (order, items) = transcript(vec![
            user("u1", 100, "pick a store", false),
            say("a200.0", 200, "Looked at both."),
            tool("t:bash1", 200, "bash"),
            think("a300.0", 300, "SQLite is simpler"),
            say("a300.1", 300, "**SQLite** keeps it in one file."),
            say("a300.2", 300, "Postgres scales further."),
            tool("t:ask1", 300, "ask"),
            say("a300.4", 300, "after the call"),
        ]);
        assert_eq!(ask_context(&order, &items, "t:ask1"), "**SQLite** keeps it in one file.\n\nPostgres scales further.");
    }

    #[test]
    fn else_the_latest_text_of_the_turn_never_thinking_nor_before_the_prompt() {
        let (order, items) = transcript(vec![
            say("a50.0", 50, "an earlier turn"),
            user("u1", 100, "go on", false),
            say("a200.0", 200, "I checked the schema."),
            say("a200.1", 200, "Two options remain."),
            tool("t:read1", 200, "read"),
            user("u2", 250, "<system-reminder>todo</system-reminder>", true),
            think("a300.0", 300, "which one"),
            tool("t:ask1", 300, "ask"),
        ]);
        assert_eq!(ask_context(&order, &items, "t:ask1"), "I checked the schema.\n\nTwo options remain.");
        // Nothing since the prompt: empty, not the earlier turn.
        let (order, items) = transcript(vec![say("a50.0", 50, "an earlier turn"), user("u1", 100, "go on", false), tool("t:ask1", 300, "ask")]);
        assert_eq!(ask_context(&order, &items, "t:ask1"), "");
        let (order, items) = transcript(vec![say("a50.0", 50, "before the compaction"), TranscriptItem::Compaction(CompactionItem { id: "c1".into(), at: 60, summary: "s".into(), tokens_before: None }), tool("t:ask1", 300, "ask")]);
        assert_eq!(ask_context(&order, &items, "t:ask1"), "");
        assert_eq!(ask_context(&order, &items, "t:gone"), "");
    }

    #[test]
    fn a_long_explanation_keeps_its_end_from_a_paragraph() {
        let para = |n: usize| format!("Paragraph {n}: {}", "word ".repeat(60).trim_end());
        let text = (0..30).map(para).collect::<Vec<_>>().join("\n\n");
        let out = bound(&text);
        assert!(out.len() <= CONTEXT_MAX, "{} bytes", out.len());
        assert!(out.starts_with("…\n\nParagraph "), "{}", &out[..40]);
        assert!(out.ends_with(&para(29)));
        // The kept part is whole paragraphs: it starts right after a paragraph break of the input.
        let kept = out.trim_start_matches(CUT_MARK);
        assert!(text.contains(&format!("\n\n{kept}")));
        // Short text stays as it is (trimmed).
        assert_eq!(bound("  short\n"), "short");
    }

    #[test]
    fn a_cut_never_breaks_a_code_fence() {
        // A long code block at the end: no paragraph break outside it fits, so the cut lands on a
        // line inside it and reopens its fence.
        let code = (0..400).map(|i| format!("let x{i} = {i};")).collect::<Vec<_>>().join("\n");
        let text = format!("Here is the patch:\n\n```rust\n{code}\n```\n\nApply it?");
        let out = bound(&text);
        assert!(out.starts_with("…\n\n```rust\nlet x"), "{}", &out[..40]);
        assert_eq!(out.matches("```").count(), 2, "the fence is balanced");
        assert!(out.ends_with("```\n\nApply it?"));
        // Blank lines inside a code block are no paragraph breaks.
        let gapped = (0..300).map(|i| format!("fn f{i}() {{}}\n")).collect::<Vec<_>>().join("\n");
        let out = bound(&format!("Intro.\n\n```rust\n{gapped}```\n\nOk?"));
        assert!(out.starts_with("…\n\n```rust\n"), "{}", &out[..30]);
        assert_eq!(out.matches("```").count(), 2);
        // One huge line: a character cut on a UTF-8 boundary.
        let out = bound(&"é".repeat(5000));
        assert!(out.starts_with("…\n\né") && out.len() <= CONTEXT_MAX);
    }
}
