//! omp tool calls → `ToolItem` titles, labels, statuses and rich [`ToolView`]s.
//!
//! Shapes follow omp 18.12 (`tools/*.ts`): bash, edit (hashline/patch/replace modes), write,
//! read (selector in `path`), grep, glob, find, todo, task, ask, web_search, eval (browser
//! screenshots arrive as image blocks); the TeleFlock bridge's `present` (≥ 2.3.0).

use serde_json::Value;
use tf_proto::{
    AskQuestion, AskView, BashView, ContextUsage, DiffView, FileDiff, FileStatus, ImageView, PresentKind, PresentedArtifact, ReadView,
    SearchHit, SearchView, Subagent, SubagentStatus, TaskView, TodoPhase, TodoStatus, TodoTask, TodoView, ToolStatus, ToolView,
    WebSource, WebView,
};

use super::util::{arr, b, clip, content_images, content_text, f, first_line, lang_of, non_empty, s, u};

const PREVIEW_CAP: usize = 4096;
const MAX_HITS: usize = 50;
const MAX_WRITE_LINES: usize = 2000;

/// Tools whose output streams through `append {field: output}` (no view refresh per update).
pub(crate) fn streams_output(name: &str) -> bool {
    matches!(name, "bash" | "eval")
}

/// Path argument with a `read` selector (`:N-M`, `:raw`, …) split off.
fn split_selector(path: &str) -> (&str, Option<&str>) {
    if path.contains("://") {
        return (path, None);
    }
    if let Some((p, sel)) = path.rsplit_once(':') {
        let looks_selector = !sel.is_empty()
            && (sel.chars().all(|c| c.is_ascii_digit() || matches!(c, '-' | '+' | ',' | ':'))
                || matches!(sel, "raw" | "img" | "conflicts"));
        // Keep Windows drive letters (`C:\…`).
        if looks_selector && p.len() > 1 {
            return (p, Some(sel));
        }
    }
    (path, None)
}

/// File path an edit targets (args.path, or the first `[path#TAG]` / `*** … File:` header).
fn edit_path(args: &Value) -> Option<String> {
    if let Some(p) = non_empty(args, "path") {
        return Some(p.to_owned());
    }
    let input = s(args, "input")?;
    for line in input.lines() {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix('[') {
            if let Some((p, _)) = rest.split_once('#') {
                return Some(p.to_owned());
            }
        }
        for marker in ["*** Update File: ", "*** Add File: ", "*** Delete File: "] {
            if let Some(p) = l.strip_prefix(marker) {
                return Some(p.trim().to_owned());
            }
        }
    }
    None
}

fn first_string_arg(args: &Value) -> Option<String> {
    args.as_object()?.values().find_map(|v| v.as_str().filter(|x| !x.trim().is_empty())).map(|x| clip(first_line(x), 120))
}

/// One-line human title.
pub(crate) fn title(name: &str, args: &Value) -> String {
    let t = match name {
        "bash" => non_empty(args, "command").map(|c| clip(first_line(c), 160)),
        "read" | "write" => non_empty(args, "path").map(str::to_owned),
        "edit" | "ast_edit" => edit_path(args),
        "grep" | "ast_grep" => non_empty(args, "pattern").map(|p| match non_empty(args, "path") {
            Some(path) => format!("{} in {path}", clip(p, 80)),
            None => clip(p, 120),
        }),
        "glob" => non_empty(args, "path").or_else(|| non_empty(args, "pattern")).map(str::to_owned),
        "find" | "web_search" => non_empty(args, "query").map(|q| clip(q, 120)),
        "todo" => non_empty(args, "op").map(|op| match non_empty(args, "task") {
            Some(task) => format!("{op} {}", clip(task, 100)),
            None => op.to_owned(),
        }),
        "task" => {
            let tasks = arr(args, "tasks");
            if tasks.is_empty() {
                non_empty(args, "name").or_else(|| non_empty(args, "task")).map(|t| clip(first_line(t), 120))
            } else {
                let names: Vec<&str> = tasks.iter().filter_map(|t| non_empty(t, "name").or_else(|| non_empty(t, "agent"))).collect();
                Some(format!("{} agent{}: {}", tasks.len(), if tasks.len() == 1 { "" } else { "s" }, clip(&names.join(", "), 100)))
            }
        }
        "ask" => arr(args, "questions").first().and_then(|q| non_empty(q, "question")).map(|q| clip(q, 120)),
        "present" => non_empty(args, "title").map(|t| clip(first_line(t), 120)),
        "eval" => non_empty(args, "title").map(str::to_owned).or_else(|| non_empty(args, "code").map(|c| clip(first_line(c), 120))),
        _ => None,
    };
    t.or_else(|| first_string_arg(args)).unwrap_or_else(|| name.to_owned())
}

/// Liveness label, e.g. `bun test src/board` or `edit src/App.tsx`.
pub(crate) fn label(name: &str, _args: &Value, title: &str) -> String {
    match name {
        "bash" => clip(title, 80),
        _ if title == name => name.to_owned(),
        _ => clip(&format!("{name} {title}"), 80),
    }
}

pub(crate) fn status(_name: &str, text: &str, _details: Option<&Value>, is_error: bool) -> ToolStatus {
    if !is_error {
        return ToolStatus::Ok;
    }
    let lower = text.to_ascii_lowercase();
    if lower.contains("cancelled by the user") || lower.contains("aborted") || lower.contains("was interrupted") {
        ToolStatus::Aborted
    } else if lower.contains("denied") || lower.contains("not approved") || lower.contains("rejected by the user") {
        ToolStatus::Denied
    } else {
        ToolStatus::Error
    }
}

pub(crate) fn todo_phases(name: &str, details: Option<&Value>) -> Option<Vec<TodoPhase>> {
    if name != "todo" {
        return None;
    }
    let phases = details?.get("phases")?.as_array()?;
    Some(
        phases
            .iter()
            .map(|p| TodoPhase {
                name: s(p, "name").unwrap_or("").to_owned(),
                tasks: arr(p, "tasks")
                    .iter()
                    .map(|t| TodoTask {
                        content: s(t, "content").unwrap_or("").to_owned(),
                        status: match s(t, "status") {
                            Some("in_progress") => TodoStatus::InProgress,
                            Some("completed") => TodoStatus::Completed,
                            Some("abandoned") => TodoStatus::Abandoned,
                            Some("blocked") => TodoStatus::Blocked,
                            _ => TodoStatus::Pending,
                        },
                        blocker: non_empty(t, "blocker").map(str::to_owned),
                    })
                    .collect(),
            })
            .collect(),
    )
}

/// The document a finished `present` call showed (the bridge's result `details`, bridge ≥ 2.3.0).
/// Only a snapshot named the way the bridge names them (`presented/<slug>-v<version>.<ext>`, the
/// slug and version matching the details) counts; anything else stays a generic tool row.
pub(crate) fn presented(name: &str, details: Option<&Value>) -> Option<PresentedArtifact> {
    if name != "present" {
        return None;
    }
    let d = details.filter(|d| d.is_object())?;
    let file = s(d, "name")?;
    let (slug, version, _ext) = presented_name(file)?;
    if Some(slug) != s(d, "slug") || Some(u64::from(version)) != u(d, "version") {
        return None;
    }
    let kind = match s(d, "kind")? {
        "html" => PresentKind::Html,
        "markdown" => PresentKind::Markdown,
        "svg" => PresentKind::Svg,
        "image" => PresentKind::Image,
        "code" => PresentKind::Code,
        "csv" => PresentKind::Csv,
        "json" => PresentKind::Json,
        "text" => PresentKind::Text,
        _ => return None,
    };
    Some(PresentedArtifact {
        title: non_empty(d, "title").map(|t| clip(first_line(t), 200)).unwrap_or_else(|| slug.to_owned()),
        kind,
        url: format!("local://{file}"),
        name: file.to_owned(),
        slug: slug.to_owned(),
        version,
        size: u(d, "size").unwrap_or(0),
        language: non_empty(d, "language").map(|l| clip(l, 40)),
        source: non_empty(d, "source").map(|p| clip(p, 1024)),
        assets: u(d, "assets").and_then(|n| u32::try_from(n).ok()).unwrap_or(0),
    })
}

/// `presented/<slug>-v<version>.<ext>` → `(slug, version, ext)`: the slug lowercase ASCII letters,
/// digits and dashes, the version 1 or more, the extension 1–10 lowercase letters or digits.
fn presented_name(name: &str) -> Option<(&str, u32, &str)> {
    let file = name.strip_prefix("presented/").filter(|f| !f.contains('/'))?;
    let (stem, ext) = file.rsplit_once('.')?;
    let (slug, n) = stem.rsplit_once("-v")?;
    let slug_ok = !slug.is_empty() && slug.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-');
    let ext_ok = (1..=10).contains(&ext.len()) && ext.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let version: u32 = n.parse().ok().filter(|v| *v >= 1 && n.bytes().all(|c| c.is_ascii_digit()))?;
    (slug_ok && ext_ok).then_some((slug, version, ext))
}

/// Rich view for a tool. `result` is `{content, details}` (final or partial); `is_error` is
/// `Some` for final results.
pub(crate) fn view(name: &str, args: &Value, result: Option<&Value>, is_error: Option<bool>) -> Option<ToolView> {
    let details = result.and_then(|r| r.get("details")).filter(|d| !d.is_null());
    if let Some(v) = super::irc::tool_view(name, args, details) {
        return Some(v);
    }
    let text = result.map(|r| content_text(r.get("content"))).unwrap_or_default();
    let finished = is_error.is_some();
    match name {
        "bash" => Some(ToolView::Bash(BashView {
            command: s(args, "command").unwrap_or("").to_owned(),
            cwd: non_empty(args, "cwd").map(str::to_owned),
            // Live output streams into ToolItem.output; the final view carries it too.
            output: if finished { text } else { String::new() },
            exit_code: details.and_then(|d| d.get("exitCode")).and_then(Value::as_i64).map(|c| c as i32),
            background: b(args, "async") || details.is_some_and(|d| d.get("async").is_some()),
            timed_out: details.is_some_and(|d| b(d, "timedOut")),
        })),
        "edit" | "ast_edit" => {
            let d = details?;
            let files: Vec<FileDiff> = match d.get("perFileResults").and_then(Value::as_array).filter(|a| !a.is_empty()) {
                Some(per) => per.iter().filter_map(|r| file_diff(r, None)).collect(),
                None => file_diff(d, edit_path(args).as_deref()).into_iter().collect(),
            };
            (!files.is_empty()).then_some(ToolView::Diff(DiffView { files }))
        }
        "write" => {
            let path = non_empty(args, "path")?.to_owned();
            let content = s(args, "content").unwrap_or("");
            let mut patch = format!("--- /dev/null\n+++ b/{path}\n");
            let lines: Vec<&str> = content.lines().collect();
            patch.push_str(&format!("@@ -0,0 +1,{} @@\n", lines.len()));
            for l in lines.iter().take(MAX_WRITE_LINES) {
                patch.push('+');
                patch.push_str(l);
                patch.push('\n');
            }
            Some(ToolView::Diff(DiffView {
                files: vec![FileDiff {
                    lang: lang_of(&path),
                    path,
                    patch,
                    added: lines.len() as u32,
                    removed: 0,
                    status: FileStatus::Modified,
                }],
            }))
        }
        "read" => {
            let raw = s(args, "path").unwrap_or("");
            let (path, sel) = split_selector(raw);
            let preview = details
                .and_then(|d| d.get("displayContent"))
                .and_then(|dc| s(dc, "text"))
                .map(str::to_owned)
                .or_else(|| finished.then(|| text.clone()).filter(|t| !t.is_empty()))
                .map(|p| {
                    if p.len() > PREVIEW_CAP {
                        let cut = super::util::floor_boundary(&p, PREVIEW_CAP);
                        format!("{}…", &p[..cut])
                    } else {
                        p
                    }
                });
            Some(ToolView::Read(ReadView {
                path: path.to_owned(),
                range: sel.map(str::to_owned),
                lines: details.and_then(|d| u(d, "totalLines")).map(|n| n as u32),
                lang: lang_of(path),
                preview,
            }))
        }
        "grep" | "ast_grep" => {
            let d = details;
            let hits: Vec<SearchHit> = match d.map(|d| arr(d, "fileMatches")).filter(|a| !a.is_empty()) {
                Some(fm) => fm
                    .iter()
                    .take(MAX_HITS)
                    .map(|m| SearchHit { path: s(m, "path").unwrap_or("").to_owned(), line: None, text: u(m, "count").map(|c| format!("{c} matches")) })
                    .collect(),
                None => d
                    .map(|d| arr(d, "files"))
                    .unwrap_or(&[])
                    .iter()
                    .filter_map(Value::as_str)
                    .take(MAX_HITS)
                    .map(|p| SearchHit { path: p.to_owned(), line: None, text: None })
                    .collect(),
            };
            Some(ToolView::Search(SearchView {
                query: s(args, "pattern").unwrap_or("").to_owned(),
                matches: d.and_then(|d| u(d, "matchCount")).unwrap_or(hits.len() as u64) as u32,
                files: d.and_then(|d| u(d, "fileCount")).unwrap_or(hits.len() as u64) as u32,
                hits,
            }))
        }
        "glob" => {
            let files: Vec<&str> = details.map(|d| arr(d, "files")).unwrap_or(&[]).iter().filter_map(Value::as_str).collect();
            Some(ToolView::Search(SearchView {
                query: non_empty(args, "path").or_else(|| non_empty(args, "pattern")).unwrap_or("*").to_owned(),
                matches: details.and_then(|d| u(d, "fileCount")).unwrap_or(files.len() as u64) as u32,
                files: details.and_then(|d| u(d, "fileCount")).unwrap_or(files.len() as u64) as u32,
                hits: files.iter().take(MAX_HITS).map(|p| SearchHit { path: (*p).to_owned(), line: None, text: None }).collect(),
            }))
        }
        "find" => {
            let hits = details.map(|d| arr(d, "hits")).unwrap_or(&[]);
            Some(ToolView::Search(SearchView {
                query: s(args, "query").unwrap_or("").to_owned(),
                matches: hits.len() as u32,
                files: hits.len() as u32,
                hits: hits
                    .iter()
                    .take(MAX_HITS)
                    .map(|h| {
                        let r = arr(h, "ranges").first();
                        SearchHit {
                            path: s(h, "rel").unwrap_or("").to_owned(),
                            line: r.and_then(|r| u(r, "start")).map(|n| n as u32),
                            text: r.and_then(|r| non_empty(r, "snippet")).map(|t| clip(t, 200)),
                        }
                    })
                    .collect(),
            }))
        }
        "todo" => todo_phases(name, details).map(|phases| ToolView::Todo(TodoView { phases })),
        "task" => {
            let progress = details.map(|d| arr(d, "progress")).unwrap_or(&[]);
            if progress.is_empty() {
                return None;
            }
            Some(ToolView::Task(TaskView { agents: progress.iter().map(progress_agent).collect() }))
        }
        "ask" => {
            let qs = arr(args, "questions");
            if qs.is_empty() {
                return None;
            }
            let results = details.map(|d| arr(d, "results")).unwrap_or(&[]);
            let questions = qs
                .iter()
                .enumerate()
                .map(|(i, q)| {
                    let question = s(q, "question").unwrap_or("").to_owned();
                    let res = results
                        .iter()
                        .find(|r| s(r, "id") == s(q, "id") || s(r, "question") == Some(question.as_str()))
                        .or(if i == 0 && results.is_empty() { details } else { None });
                    AskQuestion {
                        options: arr(q, "options").iter().filter_map(|o| s(o, "label").or_else(|| o.as_str())).map(str::to_owned).collect(),
                        answer: res.and_then(ask_answer),
                        question,
                    }
                })
                .collect();
            Some(ToolView::Ask(AskView { questions }))
        }
        "web_search" => {
            let resp = details.and_then(|d| d.get("response"));
            Some(ToolView::Web(WebView {
                query: non_empty(args, "query").map(str::to_owned),
                sources: resp
                    .map(|r| arr(r, "sources"))
                    .unwrap_or(&[])
                    .iter()
                    .map(|src| WebSource {
                        title: s(src, "title").unwrap_or("").to_owned(),
                        url: s(src, "url").unwrap_or("").to_owned(),
                        snippet: non_empty(src, "snippet").map(|x| clip(x, 300)),
                    })
                    .collect(),
                answer: resp.and_then(|r| non_empty(r, "answer")).map(str::to_owned),
            }))
        }
        _ => {
            // eval (browser screenshots), generic image results.
            let images = result.map(|r| content_images(r.get("content"))).unwrap_or_default();
            let image = images.into_iter().next()?;
            Some(ToolView::Image(ImageView {
                image,
                alt: non_empty(args, "title").map(str::to_owned).or_else(|| Some(title(name, args))),
                url: details.and_then(|d| non_empty(d, "url")).map(str::to_owned),
            }))
        }
    }
}

fn ask_answer(r: &Value) -> Option<String> {
    let selected: Vec<&str> = arr(r, "selectedOptions").iter().filter_map(Value::as_str).collect();
    let custom = non_empty(r, "customInput");
    match (selected.is_empty(), custom) {
        (false, Some(c)) => Some(format!("{}; {c}", selected.join(", "))),
        (false, None) => Some(selected.join(", ")),
        (true, Some(c)) => Some(c.to_owned()),
        (true, None) => None,
    }
}

fn progress_agent(p: &Value) -> Subagent {
    let status = match s(p, "status") {
        Some("completed") => SubagentStatus::Done,
        Some("failed") => SubagentStatus::Failed,
        Some("aborted") => SubagentStatus::Aborted,
        _ => SubagentStatus::Running,
    };
    Subagent {
        id: s(p, "id").unwrap_or("").to_owned(),
        name: s(p, "id").or_else(|| s(p, "agent")).unwrap_or("").to_owned(),
        description: non_empty(p, "assignment").or_else(|| non_empty(p, "description")).map(|d| clip(d, 300)),
        status,
        started_at: None,
        ended_at: None,
        cost_usd: f(p, "cost"),
        tokens: u(p, "tokens"),
        model: non_empty(p, "resolvedModel").map(str::to_owned),
        line: non_empty(p, "currentToolIntent")
            .or_else(|| non_empty(p, "lastIntent"))
            .map(str::to_owned)
            .or_else(|| arr(p, "recentOutput").last().and_then(Value::as_str).map(|o| clip(o, 120))),
        completion_pct: completion_pct(p, status),
        context: subagent_context(p),
        tool_count: u(p, "toolCount").map(|n| n as u32),
        parent_id: None,
    }
}

/// omp `AgentProgress.completionPercent`: the subagent's own completion estimate from the
/// completion probe (omp `task/completion-probe.ts`). The TUI shows it only while the row is live
/// (`pi-tui/tools/agent-tree.ts` `renderAgentTreeRow`), so it is dropped once the subagent stops.
pub(super) fn completion_pct(p: &Value, status: SubagentStatus) -> Option<f32> {
    if status != SubagentStatus::Running {
        return None;
    }
    f(p, "completionPercent").filter(|v| v.is_finite()).map(|v| v.clamp(0.0, 100.0) as f32)
}

/// omp `AgentProgress.contextTokens` / `contextWindow`: the subagent's context-window usage,
/// computed the way the TUI's `formatAgentStatRun` does (`tokens / window * 100`). Absent until the
/// subagent reports tokens; `window` 0 means omp knows no window (TUI: `<tokens>/?`).
pub(super) fn subagent_context(p: &Value) -> Option<ContextUsage> {
    let tokens = u(p, "contextTokens").filter(|t| *t > 0)?;
    let window = u(p, "contextWindow").unwrap_or(0);
    let pct = if window > 0 { (tokens as f64 / window as f64 * 100.0) as f32 } else { 0.0 };
    Some(ContextUsage { tokens, window, pct })
}

/// omp's numbered diff (` 1|ctx`, `-2|old`, `+2|new`) → unified patch.
fn file_diff(d: &Value, fallback_path: Option<&str>) -> Option<FileDiff> {
    let diff = s(d, "diff")?;
    let path = non_empty(d, "move")
        .or_else(|| non_empty(d, "path"))
        .map(str::to_owned)
        .or_else(|| fallback_path.map(str::to_owned))?;
    let status = match s(d, "op") {
        Some("create") => FileStatus::Added,
        Some("delete") => FileStatus::Deleted,
        _ if non_empty(d, "move").is_some() => FileStatus::Renamed,
        _ => FileStatus::Modified,
    };
    let (patch, added, removed) = to_unified(diff, &path, status);
    Some(FileDiff { lang: lang_of(&path), path, patch, added, removed, status })
}

struct Hunk {
    old_start: u32,
    new_start: u32,
    old_n: u32,
    new_n: u32,
    body: String,
}

pub(crate) fn to_unified(diff: &str, path: &str, status: FileStatus) -> (String, u32, u32) {
    let mut hunks: Vec<Hunk> = Vec::new();
    let mut cur: Option<Hunk> = None;
    let (mut added, mut removed) = (0u32, 0u32);
    let mut last_old: Option<u32> = None;
    for line in diff.lines() {
        let mut chars = line.chars();
        let kind = chars.next();
        let rest = chars.as_str();
        let parsed = match (kind, rest.split_once('|')) {
            (Some(k @ (' ' | '-' | '+')), Some((n, text))) => n.trim().parse::<u32>().ok().map(|n| (k, n, text)),
            _ => None,
        };
        let Some((k, n, text)) = parsed else {
            // Elision marker or foreign line: close the hunk.
            if let Some(h) = cur.take() {
                hunks.push(h);
            }
            last_old = None;
            continue;
        };
        // A jump in context/removed numbering also starts a new hunk.
        if k != '+' {
            if let (Some(prev), Some(_)) = (last_old, cur.as_ref()) {
                if n > prev + 1 {
                    hunks.push(cur.take().unwrap());
                }
            }
            last_old = Some(n);
        }
        let h = cur.get_or_insert_with(|| Hunk { old_start: n, new_start: n, old_n: 0, new_n: 0, body: String::new() });
        match k {
            ' ' => {
                h.old_n += 1;
                h.new_n += 1;
            }
            '-' => {
                h.old_n += 1;
                removed += 1;
            }
            _ => {
                h.new_n += 1;
                added += 1;
            }
        }
        h.body.push(k);
        h.body.push_str(text);
        h.body.push('\n');
    }
    if let Some(h) = cur.take() {
        hunks.push(h);
    }
    let (a, bb) = match status {
        FileStatus::Added => ("/dev/null".to_owned(), format!("b/{path}")),
        FileStatus::Deleted => (format!("a/{path}"), "/dev/null".to_owned()),
        _ => (format!("a/{path}"), format!("b/{path}")),
    };
    let mut out = format!("--- {a}\n+++ {bb}\n");
    for h in hunks {
        out.push_str(&format!("@@ -{},{} +{},{} @@\n", h.old_start, h.old_n, h.new_start, h.new_n));
        out.push_str(&h.body);
    }
    (out, added, removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unified_from_omp_diff() {
        let (p, a, r) = to_unified(" 1|alpha\n-2|beta\n+2|BETA-EDITED\n 3|gamma", "notes.txt", FileStatus::Modified);
        assert_eq!(p, "--- a/notes.txt\n+++ b/notes.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA-EDITED\n gamma\n");
        assert_eq!((a, r), (1, 1));
        let (p, ..) = to_unified(" 1|a\n-2|b\n ...\n 40|x\n+41|y", "f", FileStatus::Modified);
        assert!(p.contains("@@ -1,2 +1,1 @@") && p.contains("@@ -40,1 +40,2 @@"), "{p}");
    }

    #[test]
    fn titles() {
        assert_eq!(title("bash", &json!({"command":"echo hi\nmore"})), "echo hi");
        assert_eq!(title("edit", &json!({"input":"*** Begin Patch\n[notes.txt#B6C1]\nPUT 2.=2:\n"})), "notes.txt");
        assert_eq!(title("read", &json!({"path":"src/a.rs:10-20"})), "src/a.rs:10-20");
        assert_eq!(title("task", &json!({"tasks":[{"name":"A"},{"name":"B"}]})), "2 agents: A, B");
        assert_eq!(title("mystery", &json!({})), "mystery");
        assert_eq!(label("edit", &json!({}), "notes.txt"), "edit notes.txt");
        assert_eq!(split_selector("src/a.rs:10-20"), ("src/a.rs", Some("10-20")));
        assert_eq!(split_selector("C:\\x.rs"), ("C:\\x.rs", None));
        assert_eq!(split_selector("https://x.y/z"), ("https://x.y/z", None));
    }

    #[test]
    fn statuses() {
        assert_eq!(status("ask", "Ask tool was cancelled by the user", None, true), ToolStatus::Aborted);
        assert_eq!(status("bash", "Tool call denied by user", None, true), ToolStatus::Denied);
        assert_eq!(status("bash", "exit 1", None, true), ToolStatus::Error);
        assert_eq!(status("bash", "ok", None, false), ToolStatus::Ok);
    }

    #[test]
    fn presented_artifacts() {
        let d = json!({ "title": "Q3 report\nsecond line", "kind": "html", "name": "presented/q3-report-v2.html", "url": "ignored",
            "slug": "q3-report", "version": 2, "size": 4812, "source": "reports/q3.html", "assets": 3 });
        let a = presented("present", Some(&d)).unwrap();
        assert_eq!((a.title.as_str(), a.kind, a.slug.as_str(), a.version, a.size, a.assets), ("Q3 report", PresentKind::Html, "q3-report", 2, 4812, 3));
        assert_eq!((a.name.as_str(), a.url.as_str()), ("presented/q3-report-v2.html", "local://presented/q3-report-v2.html"), "the url follows the name");
        assert_eq!((a.source.as_deref(), a.language), (Some("reports/q3.html"), None));
        // inline code: no source, a language; assets default to none
        let code = json!({ "title": "fix", "kind": "code", "name": "presented/fix-v1.rs", "slug": "fix", "version": 1, "size": 9, "language": "rust" });
        let c = presented("present", Some(&code)).unwrap();
        assert_eq!((c.kind, c.language.as_deref(), c.source, c.assets), (PresentKind::Code, Some("rust"), None, 0));
        // anything else stays a generic row
        assert_eq!(presented("write", Some(&d)), None, "another tool");
        assert_eq!(presented("present", None), None);
        let with = |k: &str, v: serde_json::Value| {
            let mut x = d.clone();
            x[k] = v;
            presented("present", Some(&x))
        };
        assert_eq!(with("kind", json!("pdf")), None, "unknown kind");
        assert_eq!(with("version", json!(3)), None, "version differs from the name");
        assert_eq!(with("slug", json!("other")), None, "slug differs from the name");
        for name in ["q3-report-v2.html", "presented/../q3-report-v2.html", "presented/x/q3-report-v2.html", "presented/Q3-report-v2.html", "presented/q3-report-v0.html", "presented/q3-report-v2", "presented/q3-report-v2x.html"] {
            assert_eq!(with("name", json!(name)), None, "{name}");
        }
        assert_eq!(title("present", &json!({ "title": "Q3 report", "path": "r.html" })), "Q3 report");
    }
}
