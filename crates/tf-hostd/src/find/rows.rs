//! What `session.find` searches in a transcript row: the text its card shows. The app's matcher
//! for loaded rows (`src/features/session/find/rowText.ts`) lists the same fields, so a row counts
//! the same before and after the client loads it.

use serde_json::Value;
use tf_proto::{SessionFindResult, FindHit, ToolItem, ToolView, TranscriptItem};

use super::text::{strip_ansi, Needle};

/// Calls `f` with every searchable text of `item`, in the order its card shows them. Matches
/// never span two texts.
pub fn visit(item: &TranscriptItem, f: &mut dyn FnMut(&str)) {
    match item {
        TranscriptItem::User(u) => f(&u.text),
        TranscriptItem::Assistant(a) => {
            f(&a.text);
            if let Some(e) = &a.error {
                f(e);
            }
            if let Some(r) = &a.refusal {
                for t in [&r.category, &r.explanation].into_iter().flatten() {
                    f(t);
                }
            }
        }
        TranscriptItem::Thinking(t) => {
            if !t.redacted {
                f(&t.text);
            }
        }
        TranscriptItem::Tool(t) => tool(t, f),
        TranscriptItem::Notice(n) => {
            f(&n.text);
            if let Some(s) = &n.source {
                f(s);
            }
        }
        TranscriptItem::Compaction(c) => f(&c.summary),
        TranscriptItem::Mode(m) => f(&m.text),
        TranscriptItem::Irc(i) => {
            f(&i.message.peer);
            f(&i.message.text);
        }
    }
}

fn tool(t: &ToolItem, f: &mut dyn FnMut(&str)) {
    // The header shows the title, except bash (the command's first line) and task (a count) cards.
    if !matches!(t.view, Some(ToolView::Bash(_) | ToolView::Task(_))) {
        f(&t.title);
    }
    if let Some(i) = &t.intent {
        f(i);
    }
    let cells = eval_cells(t);
    match &t.view {
        // The eval card: each cell's code (under its title when there are several), the output, a
        // screenshot's caption.
        None | Some(ToolView::Image(_)) if !cells.is_empty() => {
            for (title, code) in &cells {
                if cells.len() > 1
                    && let Some(title) = title
                {
                    f(title);
                }
                f(code);
            }
            if let Some(o) = &t.output {
                f(&strip_ansi(o));
            }
            if let Some(ToolView::Image(i)) = &t.view {
                for s in [&i.alt, &i.url].into_iter().flatten() {
                    f(s);
                }
            }
        }
        None => {
            match &t.args {
                serde_json::Value::Null => {}
                serde_json::Value::String(s) => f(s),
                v => {
                    let pretty = serde_json::to_string_pretty(v).unwrap_or_default();
                    if pretty != "{}" {
                        f(&pretty);
                    }
                }
            }
            if let Some(o) = &t.output {
                f(&strip_ansi(o));
            }
        }
        Some(ToolView::Diff(d)) => {
            for file in &d.files {
                f(&file.path);
                f(&file.patch);
            }
        }
        Some(ToolView::Bash(b)) => {
            f(b.command.split('\n').next().unwrap_or_default());
            if let Some(cwd) = &b.cwd {
                f(cwd);
            }
            // A multi-line command is shown whole under the header too. (A one-line command the
            // header cuts off shows whole there instead: the header's copy is left out, so it still
            // counts once.)
            if b.command.contains('\n') {
                f(&b.command);
            }
            // Streaming output arrives on the item; the view carries the final text.
            let out = match &t.output {
                Some(o) if o.len() > b.output.len() => o,
                _ => &b.output,
            };
            f(&strip_ansi(out));
        }
        Some(ToolView::Read(r)) => {
            f(&r.path);
            for s in [&r.range, &r.preview].into_iter().flatten() {
                f(s);
            }
        }
        Some(ToolView::Search(s)) => {
            f(&s.query);
            for h in &s.hits {
                f(&h.path);
                if let Some(t) = &h.text {
                    f(t);
                }
            }
        }
        Some(ToolView::Todo(td)) => {
            for p in &td.phases {
                f(&p.name);
                for task in &p.tasks {
                    f(&task.content);
                    if let Some(b) = &task.blocker {
                        f(b);
                    }
                }
            }
        }
        Some(ToolView::Task(task)) => {
            for a in &task.agents {
                f(&a.name);
                for s in [&a.description, &a.line].into_iter().flatten() {
                    f(s);
                }
            }
        }
        Some(ToolView::Web(w)) => {
            for s in [&w.query, &w.answer].into_iter().flatten() {
                f(s);
            }
            for src in &w.sources {
                f(&src.title);
                f(&src.url);
                if let Some(s) = &src.snippet {
                    f(s);
                }
            }
        }
        Some(ToolView::Image(i)) => {
            for s in [&i.alt, &i.url].into_iter().flatten() {
                f(s);
            }
        }
        Some(ToolView::Ask(a)) => {
            for q in &a.questions {
                f(&q.question);
                for o in &q.options {
                    f(o);
                }
                if let Some(ans) = &q.answer {
                    f(ans);
                }
            }
        }
        Some(ToolView::Markdown(m)) => f(&m.text),
        Some(ToolView::Irc(m)) => {
            f(&m.peer);
            f(&m.text);
        }
    }
    if let Some(e) = &t.error {
        f(e);
    }
}

/// The cells of an omp `eval` call, as its card shows them (`src/features/session/tools/evalArgs.ts`):
/// `(title, code)` from `{code, title}`, or older omp's `{cells: [{code, title}, …]}`. A cell
/// needs code that isn't blank; other tools have none.
fn eval_cells(t: &ToolItem) -> Vec<(Option<&str>, &str)> {
    if t.tool != "eval" {
        return Vec::new();
    }
    let cells: Vec<&Value> = match t.args.get("cells").and_then(Value::as_array) {
        Some(cells) => cells.iter().collect(),
        None if t.args.get("code").is_some_and(Value::is_string) => vec![&t.args],
        None => Vec::new(),
    };
    cells
        .into_iter()
        .filter_map(|cell| {
            let code = cell.get("code")?.as_str().filter(|c| !c.trim().is_empty())?;
            let title = cell.get("title").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty());
            Some((title, code))
        })
        .collect()
}

/// Occurrences of `needle` in `item`'s searchable text.
pub fn count(item: &TranscriptItem, needle: &Needle) -> u32 {
    let mut n = 0usize;
    visit(item, &mut |text| n += needle.count(text));
    n.min(u32::MAX as usize) as u32
}

/// Most rows a `session.find` answer lists.
pub const FIND_MAX: usize = 10_000;
pub const FIND_DEFAULT: usize = 2000;

/// Collects the matching rows of `rows` (`(index, row)`, oldest first) into a find result for a
/// session of `total` rows, keeping the newest `limit`.
pub fn collect<'a>(rows: impl Iterator<Item = (usize, &'a TranscriptItem)>, total: usize, needle: &Needle, limit: usize) -> SessionFindResult {
    let mut hits: Vec<FindHit> = Vec::new();
    for (index, item) in rows {
        let count = count(item, needle);
        if count > 0 {
            hits.push(FindHit { id: item.id().to_owned(), index: index as u32, count });
        }
    }
    let truncated = hits.len() > limit;
    if truncated {
        hits.drain(..hits.len() - limit);
    }
    SessionFindResult { hits, rows: total as u32, truncated }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tf_proto::{AssistantItem, BashView, NoticeItem, NoticeLevel, Refusal, ThinkingItem, ToolStatus, UserItem};

    fn tool_item(view: Option<ToolView>, output: Option<&str>, args: serde_json::Value) -> TranscriptItem {
        TranscriptItem::Tool(ToolItem {
            id: "t:1".into(),
            at: 1,
            call_id: "1".into(),
            tool: "bash".into(),
            title: "cargo test".into(),
            intent: Some("Running the tests".into()),
            args,
            status: ToolStatus::Ok,
            duration_ms: None,
            output: output.map(str::to_owned),
            truncated: false,
            view,
            error: None,
            artifact: None,
            user_run: None,
        })
    }

    #[test]
    fn rows_count_what_their_cards_show() {
        let n = Needle::new("panic", false).unwrap();
        let bash = tool_item(
            Some(ToolView::Bash(BashView {
                command: "cargo test".into(),
                cwd: None,
                output: "thread 'x' \x1b[31mpanicked\x1b[0m at src/a.rs\nPANIC again".into(),
                exit_code: Some(101),
                background: false,
                timed_out: false,
            })),
            Some("panic"),
            json!({ "command": "cargo test" }),
        );
        assert_eq!(count(&bash, &n), 2, "bash output (the longer of view and item output), escapes stripped");
        // The generic card shows arguments and output; the tool's name is not searched.
        let generic = tool_item(None, Some("no PANIC here?"), json!({ "pattern": "panic!", "path": "src" }));
        assert_eq!(count(&generic, &n), 2);
        assert_eq!(count(&generic, &Needle::new("bash", false).unwrap()), 0);
        assert_eq!(count(&generic, &Needle::new("\"path\": \"src\"", false).unwrap()), 1, "arguments as the card prints them");
        let think = TranscriptItem::Thinking(ThinkingItem { id: "a1.0".into(), at: 1, text: "maybe a panic".into(), streaming: false, duration_ms: None, redacted: false });
        assert_eq!(count(&think, &n), 1);
        let redacted = TranscriptItem::Thinking(ThinkingItem { id: "a1.1".into(), at: 1, text: "panic".into(), streaming: false, duration_ms: None, redacted: true });
        assert_eq!(count(&redacted, &n), 0);
        let refused = TranscriptItem::Assistant(AssistantItem {
            id: "a2.e".into(),
            at: 2,
            text: String::new(),
            streaming: false,
            model: None,
            usage: None,
            stop_reason: Some("refusal".into()),
            error: Some("Refusal (cyber)".into()),
            error_status: None,
            refusal: Some(Refusal { kind: "refusal".into(), category: Some("cyber".into()), explanation: Some("A Cyber thing".into()) }),
        });
        assert_eq!(count(&refused, &Needle::new("cyber", false).unwrap()), 3);
        assert_eq!(count(&refused, &Needle::new("cyber", true).unwrap()), 2);
        let notice = TranscriptItem::Notice(NoticeItem { id: "n1.1".into(), at: 3, level: NoticeLevel::Warn, text: "Retrying".into(), source: Some("retry".into()) });
        assert_eq!(count(&notice, &Needle::new("retry", false).unwrap()), 2);
    }

    #[test]
    fn eval_calls_count_their_code_as_written() {
        let eval = |title: &str, args: serde_json::Value, view: Option<ToolView>, output: Option<&str>| {
            let TranscriptItem::Tool(mut t) = tool_item(view, output, args) else { unreachable!() };
            t.tool = "eval".into();
            t.title = title.into();
            t.intent = None;
            TranscriptItem::Tool(t)
        };
        let texts = |item: &TranscriptItem| {
            let mut out = Vec::new();
            visit(item, &mut |s| out.push(s.to_owned()));
            out
        };
        // the same rows as src/features/session/find/find.test.ts
        let code = "name = \"panic\"\nprint(f\"{name}!\")";
        let single = eval("Say it", json!({ "language": "py", "code": code, "title": "Say it" }), None, Some("\x1b[1mpanic!\x1b[0m"));
        assert_eq!(texts(&single), ["Say it", code, "panic!"]);
        assert_eq!(count(&single, &Needle::new("\"panic\"", false).unwrap()), 1, "the JSON escaped the quotes");
        assert_eq!(count(&single, &Needle::new("panic", false).unwrap()), 2);
        let cells = eval("eval", json!({ "cells": [{ "language": "py", "code": "a = 1", "title": "Load" }, { "language": "js", "code": "b()" }] }), None, None);
        assert_eq!(texts(&cells), ["eval", "Load", "a = 1", "b()"]);
        let image = serde_json::from_value(json!({ "type": "image", "image": { "mime": "image/png" }, "alt": "Shot", "url": "https://x.dev" })).unwrap();
        let shot = eval("Shot", json!({ "language": "js", "code": "await tab.goto(url)" }), Some(image), Some("saved"));
        assert_eq!(texts(&shot), ["Shot", "await tab.goto(url)", "saved", "Shot", "https://x.dev"]);
        // no code yet (the model is still writing the call): its arguments, as any call's
        assert_eq!(texts(&eval("eval", json!({ "language": "py" }), None, None)), ["eval", "{\n  \"language\": \"py\"\n}"]);
    }

    #[test]
    fn collect_keeps_the_newest_matches() {
        let rows: Vec<TranscriptItem> = (0..10)
            .map(|i| {
                TranscriptItem::User(UserItem {
                    id: format!("u{i}"),
                    at: i,
                    text: if i % 3 == 0 { "needle needle".into() } else { "hay".into() },
                    images: vec![],
                    author: None,
                    steering: false,
                    synthetic: false,
                })
            })
            .collect();
        let n = Needle::new("NEEDLE", false).unwrap();
        let all = collect(rows.iter().enumerate(), rows.len(), &n, 100);
        assert_eq!(all.hits.iter().map(|h| (h.id.as_str(), h.index, h.count)).collect::<Vec<_>>(), [("u0", 0, 2), ("u3", 3, 2), ("u6", 6, 2), ("u9", 9, 2)]);
        assert!(!all.truncated && all.rows == 10);
        let few = collect(rows.iter().enumerate(), rows.len(), &n, 2);
        assert_eq!(few.hits.iter().map(|h| h.id.as_str()).collect::<Vec<_>>(), ["u6", "u9"]);
        assert!(few.truncated);
    }
}
