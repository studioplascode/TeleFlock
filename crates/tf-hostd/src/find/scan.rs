//! One omp session file, searched line by line for `search.*`: a raw-byte prefilter first, and
//! only lines that can match are parsed, so a search costs about one read of the file.
//!
//! An entry's text is what its transcript row shows: prompts and other user-role messages,
//! assistant text and thinking, tool-call arguments (each string value), tool-result text (ANSI
//! escapes removed), compaction and branch summaries. Entries of other types (settings changes,
//! usage, custom data) are skipped before the prefilter. Every match names the row a replica of
//! the session builds for it (`TranscriptItem.id`: `u<ts>`, `a<ts>.<block>`, `t:<callId>`,
//! `c<entryId>`), so the app can open the session at it.

use std::borrow::Cow;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::time::Instant;

use serde_json::Value;
use tf_proto::{Millis, SearchSnippet, SearchStop, SnippetKind};

use super::text::{snippet, strip_ansi, Needle, Prefilter};

/// Occurrences counted per session at most.
pub const MATCHES_MAX: u32 = 1000;
/// Snippets kept per session.
pub const SNIPPETS_MAX: usize = 3;
/// Longest line read; longer ones (inline media) are skipped, their bytes still count.
pub const LINE_MAX: usize = 64 * 1024 * 1024;
/// Lines between two checks of the search's budget and cancellation.
const CHECK_EVERY: u32 = 256;

/// What a search may still spend, shared by its files.
pub struct Budget {
    pub deadline: Instant,
    pub bytes_left: u64,
    /// True once the search is cancelled (or its client gone).
    pub cancelled: Box<dyn Fn() -> bool + Send + Sync>,
}

impl Budget {
    pub(crate) fn check(&self) -> Result<(), SearchStop> {
        if (self.cancelled)() {
            return Err(SearchStop::Cancelled);
        }
        if Instant::now() >= self.deadline {
            return Err(SearchStop::Time);
        }
        if self.bytes_left == 0 {
            return Err(SearchStop::Bytes);
        }
        Ok(())
    }
}

/// What one file held.
#[derive(Debug, Default, PartialEq)]
pub struct FileMatches {
    pub matches: u32,
    pub snippets: Vec<SearchSnippet>,
    /// `message` entries, when the whole file was read.
    pub messages: Option<u32>,
}

/// Searches one session file. `Err` when the budget ran out or the search was cancelled (the
/// matches found so far come with it); I/O errors read as an empty file.
pub fn scan_file(path: &Path, needle: &Needle, pf: &mut Prefilter, budget: &mut Budget) -> Result<FileMatches, (SearchStop, FileMatches)> {
    let mut out = FileMatches::default();
    let Ok(f) = std::fs::File::open(path) else { return Ok(out) };
    let mut r = BufReader::with_capacity(1 << 20, f);
    let mut line = Vec::new();
    let mut messages = 0u32;
    let mut n = 0u32;
    let mut complete = true;
    loop {
        if n % CHECK_EVERY == 0 {
            if let Err(stop) = budget.check() {
                return Err((stop, out));
            }
        }
        n += 1;
        line.clear();
        let read = match (&mut r).take(LINE_MAX as u64 + 1).read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(k) => k,
        };
        budget.bytes_left = budget.bytes_left.saturating_sub(read as u64);
        if line.len() > LINE_MAX {
            // The rest of an oversized line (inline media): skipped, counted.
            let k = if line.ends_with(b"\n") { 0 } else { r.skip_until(b'\n').unwrap_or(0) };
            budget.bytes_left = budget.bytes_left.saturating_sub(k as u64);
            continue;
        }
        let kind = line_type(&line);
        if kind == Some("message") {
            messages += 1;
        }
        if !matches!(kind, None | Some("message" | "custom_message" | "compaction" | "branch_summary")) || !pf.may_match(&line) {
            continue;
        }
        let Ok(entry) = serde_json::from_slice::<Value>(&line) else { continue };
        entry_parts(&entry, &mut |part| {
            let count = needle.count_capped(&part.text, (MATCHES_MAX - out.matches) as usize) as u32;
            if count == 0 {
                return;
            }
            out.matches += count;
            if out.snippets.len() < SNIPPETS_MAX
                && let Some((before, hit, after)) = snippet(&part.text, needle)
            {
                out.snippets.push(SearchSnippet { kind: part.kind, before, hit, after, tool: part.tool.map(str::to_owned), row_id: part.row_id.clone(), at: part.at });
            }
        });
        if out.matches >= MATCHES_MAX && out.snippets.len() >= SNIPPETS_MAX {
            complete = false;
            break;
        }
    }
    out.messages = complete.then_some(messages);
    Ok(out)
}

/// The `type` of an omp JSONL entry from its first bytes (`{"type":"message",…`).
fn line_type(line: &[u8]) -> Option<&str> {
    let rest = line.strip_prefix(b"{\"type\":\"")?;
    let end = memchr::memchr(b'"', rest)?;
    std::str::from_utf8(&rest[..end]).ok()
}

/// One searchable text of an entry.
pub struct Part<'a> {
    pub kind: SnippetKind,
    pub text: Cow<'a, str>,
    pub tool: Option<&'a str>,
    pub row_id: Option<String>,
    pub at: Option<Millis>,
}

/// Calls `f` with every searchable text of a session entry.
pub fn entry_parts<'a>(entry: &'a Value, f: &mut dyn FnMut(Part<'a>)) {
    let at_entry = ts(entry);
    match entry.get("type").and_then(Value::as_str) {
        Some("message") => {
            let Some(msg) = entry.get("message") else { return };
            let t = ts(msg).or(at_entry);
            match msg.get("role").and_then(Value::as_str) {
                Some("assistant") => {
                    let blocks = msg.get("content").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
                    for (i, blk) in blocks.iter().enumerate() {
                        let row_id = t.map(|t| format!("a{t}.{i}"));
                        match blk.get("type").and_then(Value::as_str) {
                            Some("text") => text_part(f, SnippetKind::Assistant, blk.get("text"), None, row_id, t),
                            Some("thinking") => text_part(f, SnippetKind::Thinking, blk.get("thinking"), None, row_id, t),
                            Some("toolCall") => {
                                let tool = blk.get("name").and_then(Value::as_str);
                                let row_id = blk.get("id").and_then(Value::as_str).map(|id| format!("t:{id}"));
                                if let Some(args) = blk.get("arguments") {
                                    strings(args, &mut |s| f(Part { kind: SnippetKind::ToolCall, text: Cow::Borrowed(s), tool, row_id: row_id.clone(), at: t }));
                                }
                            }
                            _ => {}
                        }
                    }
                    let error_row = t.map(|t| format!("a{t}.e"));
                    text_part(f, SnippetKind::Assistant, msg.get("errorMessage"), None, error_row, t);
                }
                Some("toolResult") => {
                    let tool = msg.get("toolName").and_then(Value::as_str);
                    let row_id = msg.get("toolCallId").and_then(Value::as_str).map(|id| format!("t:{id}"));
                    let text = content_text(msg.get("content"));
                    if !text.is_empty() {
                        let text = match strip_ansi(&text) {
                            Cow::Borrowed(_) => text,
                            Cow::Owned(s) => s,
                        };
                        f(Part { kind: SnippetKind::ToolOutput, text: Cow::Owned(text), tool, row_id, at: t });
                    }
                }
                Some(role) => {
                    let kind = if role == "user" && !msg.get("synthetic").and_then(Value::as_bool).unwrap_or(false) { SnippetKind::User } else { SnippetKind::Other };
                    let text = content_text(msg.get("content"));
                    if !text.is_empty() {
                        f(Part { kind, text: Cow::Owned(text), tool: None, row_id: t.map(|t| format!("u{t}")), at: t });
                    }
                }
                None => {}
            }
        }
        Some("custom_message") => {
            let custom = entry.get("customType").and_then(Value::as_str);
            if custom == Some("image-attachment") {
                return;
            }
            let kind = if custom == Some("collab-prompt") { SnippetKind::User } else { SnippetKind::Other };
            let text = content_text(entry.get("content"));
            if !text.is_empty() {
                f(Part { kind, text: Cow::Owned(text), tool: None, row_id: at_entry.map(|t| format!("u{t}")), at: at_entry });
            }
        }
        Some("compaction" | "branch_summary") => {
            let id = entry.get("id").and_then(Value::as_str).map(|id| format!("c{id}"));
            let summary = entry.get("summary").filter(|s| s.as_str().is_some_and(|s| !s.is_empty())).or_else(|| entry.get("shortSummary"));
            text_part(f, SnippetKind::Summary, summary, None, id, at_entry);
        }
        _ => {}
    }
}

fn text_part<'a>(f: &mut dyn FnMut(Part<'a>), kind: SnippetKind, v: Option<&'a Value>, tool: Option<&'a str>, row_id: Option<String>, at: Option<Millis>) {
    if let Some(s) = v.and_then(Value::as_str).filter(|s| !s.is_empty()) {
        f(Part { kind, text: Cow::Borrowed(s), tool, row_id, at });
    }
}

/// Every string value inside `v` (tool-call arguments), depth first.
fn strings<'a>(v: &'a Value, f: &mut dyn FnMut(&'a str)) {
    match v {
        Value::String(s) if !s.is_empty() => f(s),
        Value::Array(a) => a.iter().for_each(|x| strings(x, f)),
        Value::Object(o) => o.values().for_each(|x| strings(x, f)),
        _ => {}
    }
}

/// A message's text blocks joined by newlines (a plain string content as is).
fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => {
            let mut out = String::new();
            for blk in blocks {
                if blk.get("type").and_then(Value::as_str) == Some("text")
                    && let Some(t) = blk.get("text").and_then(Value::as_str)
                {
                    if !out.is_empty() && !out.ends_with('\n') {
                        out.push('\n');
                    }
                    out.push_str(t);
                }
            }
            out
        }
        _ => String::new(),
    }
}

/// An entry's or message's `timestamp`: epoch ms, or RFC 3339.
fn ts(v: &Value) -> Option<Millis> {
    match v.get("timestamp")? {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(t) => chrono::DateTime::parse_from_rfc3339(t).ok().map(|d| d.timestamp_millis()),
        _ => None,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Duration;

    pub(crate) fn budget() -> Budget {
        Budget { deadline: Instant::now() + Duration::from_secs(60), bytes_left: u64::MAX, cancelled: Box::new(|| false) }
    }

    /// A session file in omp's shape: title slot, header, a prompt, a reply with thinking and a tool
    /// call, the tool's result, a compaction, settings noise.
    pub(crate) fn session_lines(id: &str, cwd: &str, word: &str) -> Vec<String> {
        let t0 = 1_760_000_000_000i64;
        [
            json!({ "type": "title", "v": 1, "title": format!("About {word}") }),
            json!({ "type": "session", "version": 3, "id": id, "timestamp": "2026-10-20T10:00:00.000Z", "cwd": cwd }),
            json!({ "type": "model_change", "id": "m1", "model": format!("{word}-model") }),
            json!({ "type": "message", "id": "e1", "timestamp": "2026-10-20T10:00:01.000Z", "message": { "role": "user", "timestamp": t0, "content": [{ "type": "text", "text": format!("Please fix the {word} bug") }] } }),
            json!({ "type": "message", "id": "e2", "message": { "role": "assistant", "timestamp": t0 + 1, "content": [
                { "type": "thinking", "thinking": format!("The {word} lives in src/lib.rs") },
                { "type": "text", "text": "Looking." },
                { "type": "toolCall", "id": "call_1", "name": "bash", "arguments": { "command": format!("grep -rn {word} src") } }
            ] } }),
            json!({ "type": "message", "id": "e3", "message": { "role": "toolResult", "timestamp": t0 + 2, "toolCallId": "call_1", "toolName": "bash", "content": [{ "type": "text", "text": format!("src/lib.rs:3: \u{1b}[31m{word}\u{1b}[0m here") }] } }),
            json!({ "type": "custom", "customType": "x", "data": { "note": word } }),
            json!({ "type": "compaction", "id": "k1", "timestamp": "2026-10-20T10:05:00.000Z", "summary": format!("Fixed the {word}.") }),
        ]
        .iter()
        // omp (`JSON.stringify`) writes `type` first; serde_json sorts keys.
        .map(|v| {
            let mut rest = v.as_object().cloned().unwrap_or_default();
            let ty = rest.remove("type").unwrap_or_default();
            let tail = Value::Object(rest).to_string();
            format!("{{\"type\":{ty},{}", &tail[1..])
        })
        .collect()
    }

    #[test]
    fn a_session_file_matches_by_kind_with_row_ids() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        std::fs::write(&path, session_lines("s1", "/w", "Gizmo").join("\n") + "\n").unwrap();
        let needle = Needle::new("gizmo", false).unwrap();
        let mut pf = needle.prefilter();
        let mut b = budget();
        let m = scan_file(&path, &needle, &mut pf, &mut b).unwrap();
        // prompt, thinking, tool call, tool output, summary; not the title, model change or custom data
        assert_eq!(m.matches, 5);
        assert_eq!(m.messages, Some(3));
        let kinds: Vec<_> = m.snippets.iter().map(|s| (s.kind, s.row_id.as_deref().unwrap_or(""))).collect();
        let t0 = 1_760_000_000_000i64;
        assert_eq!(kinds, [(SnippetKind::User, format!("u{t0}").as_str()), (SnippetKind::Thinking, format!("a{}.0", t0 + 1).as_str()), (SnippetKind::ToolCall, "t:call_1")]);
        assert_eq!((m.snippets[0].before.as_str(), m.snippets[0].hit.as_str(), m.snippets[0].after.as_str()), ("Please fix the ", "Gizmo", " bug"));
        assert_eq!(m.snippets[2].tool.as_deref(), Some("bash"));
        assert_eq!(m.snippets[0].at, Some(t0));
        assert!(b.bytes_left < u64::MAX, "bytes are counted");
    }

    #[test]
    fn tool_output_is_searched_without_escapes_and_summaries_name_their_row() {
        let lines = session_lines("s1", "/w", "Gizmo");
        let entry: Value = serde_json::from_str(&lines[5]).unwrap();
        let mut parts = Vec::new();
        entry_parts(&entry, &mut |p| parts.push((p.kind, p.text.into_owned(), p.row_id)));
        assert_eq!(parts, [(SnippetKind::ToolOutput, "src/lib.rs:3: Gizmo here".to_owned(), Some("t:call_1".to_owned()))]);
        let entry: Value = serde_json::from_str(&lines[7]).unwrap();
        let mut ids = Vec::new();
        entry_parts(&entry, &mut |p| ids.push(p.row_id));
        assert_eq!(ids, [Some("ck1".to_owned())]);
    }

    #[test]
    fn budget_and_cancellation_stop_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let mut lines = Vec::new();
        for _ in 0..2000 {
            lines.extend(session_lines("s1", "/w", "gizmo"));
        }
        std::fs::write(&path, lines.join("\n")).unwrap();
        let needle = Needle::new("nothing-like-this", false).unwrap();
        let mut pf = needle.prefilter();
        let mut b = Budget { bytes_left: 4096, ..budget() };
        let (stop, _) = scan_file(&path, &needle, &mut pf, &mut b).unwrap_err();
        assert_eq!(stop, SearchStop::Bytes);
        let mut b = Budget { deadline: Instant::now(), ..budget() };
        assert_eq!(scan_file(&path, &needle, &mut pf, &mut b).unwrap_err().0, SearchStop::Time);
        let mut b = Budget { cancelled: Box::new(|| true), ..budget() };
        assert_eq!(scan_file(&path, &needle, &mut pf, &mut b).unwrap_err().0, SearchStop::Cancelled);
        // Plenty of budget: the file is read to the end.
        let mut b = budget();
        let m = scan_file(&path, &Needle::new("gizmo", false).unwrap(), &mut Needle::new("gizmo", false).unwrap().prefilter(), &mut b).unwrap();
        assert_eq!(m.matches, MATCHES_MAX, "counting stops at the cap");
        assert_eq!(m.messages, None, "a file left early has no message count");
    }
}
