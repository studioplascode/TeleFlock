//! `fs.*` methods: home, directory listing with git badges (remote folder picker), fuzzy
//! file search (@-mentions) and capped file reads.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use base64::Engine as _;
use serde_json::Value;
use tf_proto::{
    ApiError, FsEntry, FsKind, FsListParams, FsListing, FsReadParams, FsReadResult, FsSearchParams, FsSearchResult,
    GitBadge, HostMethod, PathResult,
};

use crate::clients::ClientHandle;
use crate::ops::git;
use crate::ops::{to_value, Ctx};

/// Entries returned by one `fs.list` (huge directories are cut, dirs first).
const LIST_CAP: usize = 5000;
/// Total wall-clock budget for the dirty counts of all repos in one listing.
const BADGE_BUDGET: Duration = Duration::from_millis(1500);
/// Concurrent `git status` runs for badges.
const BADGE_CONCURRENCY: usize = 8;
const READ_DEFAULT: u64 = 512 * 1024;
const READ_MAX: u64 = 8 * 1024 * 1024;
const SEARCH_DEFAULT: usize = 50;
const SEARCH_MAX: usize = 500;
/// Candidate files collected by the non-git walk.
const WALK_CAP: usize = 100_000;
const WALK_BUDGET: Duration = Duration::from_secs(3);
/// How long a root's candidate list is reused across keystrokes.
const SEARCH_CACHE_TTL: Duration = Duration::from_secs(15);

pub async fn handle(_ctx: &Ctx, req: HostMethod, _client: &ClientHandle) -> Result<Value, ApiError> {
    match req {
        HostMethod::FsHome(_) => to_value(PathResult { path: home_dir().display().to_string() }),
        HostMethod::FsList(p) => to_value(list(&p).await?),
        HostMethod::FsSearch(p) => to_value(search(&p).await?),
        HostMethod::FsRead(p) => to_value(read(&p).await?),
        other => Err(ApiError::new("unknown_method", format!("{} is not an fs method", other.name()))),
    }
}

/// The daemon user's home directory.
pub(crate) fn home_dir() -> PathBuf {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "C:\\" } else { "/" }))
}

/// Expands `~`/`~/…`, makes relative paths home-relative and normalizes `.`/`..`
/// lexically (no symlink resolution, so the user sees the path they navigated).
pub(crate) fn resolve_path(input: &str) -> Result<PathBuf, ApiError> {
    let input = input.trim();
    if input.is_empty() {
        return Err(ApiError::new("invalid_params", "path is empty"));
    }
    let home = home_dir();
    let raw = if input == "~" {
        home.clone()
    } else if let Some(rest) = input.strip_prefix("~/").or_else(|| input.strip_prefix("~\\")) {
        home.join(rest)
    } else {
        let p = PathBuf::from(input);
        if p.is_absolute() { p } else { home.join(p) }
    };
    Ok(normalize(&raw))
}

fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push(c);
                }
            }
            other => out.push(other),
        }
    }
    out
}

fn io_error(e: std::io::Error, path: &Path) -> ApiError {
    match e.kind() {
        std::io::ErrorKind::NotFound => ApiError::new("not_found", format!("{} does not exist", path.display())),
        std::io::ErrorKind::PermissionDenied => ApiError::new("permission_denied", format!("permission denied: {}", path.display())),
        _ => ApiError::new("io_error", format!("{}: {e}", path.display())),
    }
}

fn millis(t: std::io::Result<std::time::SystemTime>) -> Option<i64> {
    t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64)
}

fn is_hidden(name: &str, _meta: Option<&std::fs::Metadata>) -> bool {
    if name.starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if let Some(m) = _meta {
            return m.file_attributes() & 0x2 != 0; // FILE_ATTRIBUTE_HIDDEN
        }
    }
    false
}

// ───────────────────────────── fs.list ─────────────────────────────

pub async fn list(p: &FsListParams) -> Result<FsListing, ApiError> {
    let dir = resolve_path(&p.path)?;
    let show_hidden = p.hidden;
    let dir2 = dir.clone();
    let mut entries = tokio::task::spawn_blocking(move || read_dir_sorted(&dir2, show_hidden))
        .await
        .map_err(|e| ApiError::new("internal", e.to_string()))??;

    // Badges: every directory entry that has a `.git` (no process for branch; dirty
    // counts run concurrently under one deadline).
    let deadline = Instant::now() + BADGE_BUDGET;
    let sem = Arc::new(tokio::sync::Semaphore::new(BADGE_CONCURRENCY));
    let mut jobs = tokio::task::JoinSet::new();
    for (idx, e) in entries.iter().enumerate() {
        if e.kind == FsKind::Dir && Path::new(&e.path).join(".git").exists() {
            let path = PathBuf::from(&e.path);
            let sem = sem.clone();
            jobs.spawn(async move {
                let _permit = sem.acquire_owned().await;
                let left = deadline.saturating_duration_since(Instant::now());
                (idx, badge_with_budget(&path, left).await)
            });
        }
    }
    let self_badge = async {
        if dir.join(".git").exists() {
            badge_with_budget(&dir, BADGE_BUDGET).await
        } else {
            enclosing_badge(&dir).await
        }
    };
    let (self_badge, results) = tokio::join!(self_badge, async {
        let mut v = Vec::new();
        while let Some(r) = jobs.join_next().await {
            if let Ok(r) = r {
                v.push(r);
            }
        }
        v
    });
    for (idx, badge) in results {
        entries[idx].git = badge;
    }
    Ok(FsListing {
        parent: dir.parent().map(|p| p.display().to_string()),
        path: dir.display().to_string(),
        entries,
        git: self_badge,
    })
}

async fn badge_with_budget(dir: &Path, left: Duration) -> Option<GitBadge> {
    let dot_git = dir.join(".git");
    let worktree = std::fs::symlink_metadata(&dot_git).map(|m| m.is_file()).unwrap_or(false);
    let branch = git::read_head_branch(&dot_git);
    let dirty = if left.is_zero() { None } else { git::dirty_count(dir, left).await };
    Some(GitBadge { repo_root: true, worktree, branch, dirty })
}

/// Badge for a directory *inside* a repository (not its root).
async fn enclosing_badge(dir: &Path) -> Option<GitBadge> {
    let o = git::git(dir, &["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"], Duration::from_secs(3)).await.ok()?;
    if !o.ok() {
        return None;
    }
    let s = o.stdout_str();
    let mut lines = s.lines();
    let top = PathBuf::from(lines.next()?);
    let branch = lines.next().map(str::to_string).filter(|b| b != "HEAD");
    let worktree = std::fs::symlink_metadata(top.join(".git")).map(|m| m.is_file()).unwrap_or(false);
    Some(GitBadge { repo_root: false, worktree, branch, dirty: None })
}

fn read_dir_sorted(dir: &Path, show_hidden: bool) -> Result<Vec<FsEntry>, ApiError> {
    let meta = std::fs::metadata(dir).map_err(|e| io_error(e, dir))?;
    if !meta.is_dir() {
        return Err(ApiError::new("invalid_params", format!("{} is not a directory", dir.display())));
    }
    let rd = std::fs::read_dir(dir).map_err(|e| io_error(e, dir))?;
    let mut out = Vec::new();
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().into_owned();
        let lmeta = ent.metadata().ok();
        if !show_hidden && is_hidden(&name, lmeta.as_ref()) {
            continue;
        }
        let path = ent.path();
        let is_link = ent.file_type().map(|t| t.is_symlink()).unwrap_or(false);
        // Follow symlinks so linked folders stay navigable; dangling links stay `symlink`.
        let meta = if is_link { std::fs::metadata(&path).ok() } else { lmeta.clone() };
        let kind = match &meta {
            Some(m) if m.is_dir() => FsKind::Dir,
            Some(m) if m.is_file() => FsKind::File,
            None if is_link => FsKind::Symlink,
            _ => FsKind::Other,
        };
        out.push(FsEntry {
            hidden: is_hidden(&name, lmeta.as_ref()),
            size: meta.as_ref().filter(|m| m.is_file()).map(|m| m.len()),
            modified: meta.as_ref().and_then(|m| millis(m.modified())),
            name,
            path: path.display().to_string(),
            kind,
            git: None,
        });
    }
    out.sort_by(|a, b| {
        let rank = |k: FsKind| if k == FsKind::Dir { 0 } else { 1 };
        rank(a.kind).cmp(&rank(b.kind)).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())).then_with(|| a.name.cmp(&b.name))
    });
    out.truncate(LIST_CAP);
    Ok(out)
}

// ───────────────────────────── fs.search ─────────────────────────────

type Candidates = Arc<Vec<String>>;
static SEARCH_CACHE: LazyLock<Mutex<HashMap<PathBuf, (Instant, Candidates)>>> = LazyLock::new(Default::default);

pub async fn search(p: &FsSearchParams) -> Result<FsSearchResult, ApiError> {
    let root = resolve_path(&p.root)?;
    if !root.is_dir() {
        return Err(ApiError::new("not_found", format!("{} is not a directory", root.display())));
    }
    let limit = p.limit.map(|l| l as usize).unwrap_or(SEARCH_DEFAULT).clamp(1, SEARCH_MAX);
    let candidates = candidates(&root).await?;
    let query = p.query.clone();
    let (files, truncated) = tokio::task::spawn_blocking(move || rank(&candidates, &query, limit))
        .await
        .map_err(|e| ApiError::new("internal", e.to_string()))?;
    Ok(FsSearchResult { files, truncated })
}

async fn candidates(root: &Path) -> Result<Candidates, ApiError> {
    {
        let mut cache = SEARCH_CACHE.lock().unwrap();
        cache.retain(|_, (at, _)| at.elapsed() < SEARCH_CACHE_TTL);
        if let Some((_, c)) = cache.get(root) {
            return Ok(c.clone());
        }
    }
    let files = match git::git(root, &["ls-files", "--cached", "--others", "--exclude-standard", "-z"], Duration::from_secs(10)).await {
        Ok(o) if o.ok() => {
            let mut v: Vec<String> = String::from_utf8_lossy(&o.stdout).split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect();
            v.sort();
            v.dedup();
            v
        }
        _ => {
            let r = root.to_path_buf();
            tokio::task::spawn_blocking(move || walk(&r)).await.map_err(|e| ApiError::new("internal", e.to_string()))?
        }
    };
    let files = Arc::new(files);
    let mut cache = SEARCH_CACHE.lock().unwrap();
    if cache.len() > 32 {
        cache.clear();
    }
    cache.insert(root.to_path_buf(), (Instant::now(), files.clone()));
    Ok(files)
}

const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "__pycache__", ".venv", "venv", ".next", ".cache", "vendor"];

/// Breadth-first walk (hidden and heavy build dirs skipped), capped by count and time.
fn walk(root: &Path) -> Vec<String> {
    let start = Instant::now();
    let mut out = Vec::new();
    let mut queue = std::collections::VecDeque::from([root.to_path_buf()]);
    while let Some(dir) = queue.pop_front() {
        if out.len() >= WALK_CAP || start.elapsed() > WALK_BUDGET {
            break;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for ent in rd.flatten() {
            let name = ent.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(ft) = ent.file_type() else { continue };
            let path = ent.path();
            if ft.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    queue.push_back(path);
                }
            } else if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    out.sort();
    out
}

/// Best `limit` matches, best first; `truncated` when more candidates matched.
pub(crate) fn rank(candidates: &[String], query: &str, limit: usize) -> (Vec<String>, bool) {
    let q: Vec<char> = query.trim().to_lowercase().chars().filter(|c| !c.is_whitespace()).collect();
    if q.is_empty() {
        let mut v: Vec<&String> = candidates.iter().collect();
        v.sort_by_key(|s| (s.matches('/').count(), s.len()));
        return (v.iter().take(limit).map(|s| s.to_string()).collect(), candidates.len() > limit);
    }
    let mut scored: Vec<(i32, &String)> = candidates.iter().filter_map(|c| fuzzy_score(c, &q).map(|s| (s, c))).collect();
    let truncated = scored.len() > limit;
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.len().cmp(&b.1.len())).then_with(|| a.1.cmp(b.1)));
    (scored.into_iter().take(limit).map(|(_, c)| c.clone()).collect(), truncated)
}

/// fzf-style score of `query` (lowercase chars) against `cand`: subsequence required;
/// rewards segment/word starts, consecutive runs and matches inside the basename.
pub(crate) fn fuzzy_score(cand: &str, q: &[char]) -> Option<i32> {
    let chars: Vec<char> = cand.chars().collect();
    let lower: Vec<char> = cand.to_lowercase().chars().collect();
    if lower.len() != chars.len() {
        // Rare case-folding length change: fall back to plain subsequence on lowercase.
        return subsequence(&lower, q).then_some(1);
    }
    let n = chars.len();
    let m = q.len();
    if m > n || !subsequence(&lower, q) {
        return None;
    }
    let base_start = cand.rfind('/').map(|i| cand[..i + 1].chars().count()).unwrap_or(0);
    let bonus = |j: usize| -> i32 {
        let mut b = 0;
        let prev = if j == 0 { '/' } else { chars[j - 1] };
        if matches!(prev, '/' | '\\') {
            b += 10;
        } else if matches!(prev, '_' | '-' | '.' | ' ') || (prev.is_lowercase() && chars[j].is_uppercase()) {
            b += 7;
        }
        if j >= base_start {
            b += 4;
        }
        b
    };
    const NEG: i32 = i32::MIN / 4;
    // dp[j] = best score with query[..=i] matched and query[i] at position j.
    let mut prev = vec![NEG; n];
    let mut cur = vec![NEG; n];
    for (i, &qc) in q.iter().enumerate() {
        let mut best_before = NEG; // max over prev[k] for k < j-1 (gap) with gap penalty applied
        for j in 0..n {
            cur[j] = NEG;
            if j > 0 && i > 0 && prev[j - 1] > NEG {
                best_before = best_before.max(prev[j - 1] - 3);
            }
            if lower[j] != qc {
                if i > 0 && best_before > NEG {
                    best_before -= 1;
                }
                continue;
            }
            let here = 16 + bonus(j);
            if i == 0 {
                cur[j] = here - (j as i32).min(20) / 4;
            } else {
                let consec = if j > 0 && prev[j - 1] > NEG { prev[j - 1] + here + 8 } else { NEG };
                let gapped = if best_before > NEG { best_before + here } else { NEG };
                cur[j] = consec.max(gapped);
            }
            if i > 0 && best_before > NEG {
                best_before -= 1;
            }
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    let mut best = prev.into_iter().max().filter(|s| *s > NEG)?;
    // Whole query is a prefix of the basename / equals it.
    let base: String = lower[base_start..].iter().collect();
    let qs: String = q.iter().collect();
    if base.starts_with(&qs) {
        best += 30;
    }
    if base == qs || base.split('.').next() == Some(qs.as_str()) {
        best += 20;
    }
    Some(best - (n as i32) / 8)
}

fn subsequence(hay: &[char], q: &[char]) -> bool {
    let mut it = hay.iter();
    q.iter().all(|c| it.any(|h| h == c))
}

// ───────────────────────────── fs.read ─────────────────────────────

pub async fn read(p: &FsReadParams) -> Result<FsReadResult, ApiError> {
    let path = resolve_path(&p.path)?;
    let cap = p.max_bytes.unwrap_or(READ_DEFAULT).clamp(1, READ_MAX);
    tokio::task::spawn_blocking(move || read_blocking(&path, cap)).await.map_err(|e| ApiError::new("internal", e.to_string()))?
}

fn read_blocking(path: &Path, cap: u64) -> Result<FsReadResult, ApiError> {
    use std::io::Read;
    let meta = std::fs::metadata(path).map_err(|e| io_error(e, path))?;
    if meta.is_dir() {
        return Err(ApiError::new("invalid_params", format!("{} is a directory", path.display())));
    }
    let size = meta.len();
    let f = std::fs::File::open(path).map_err(|e| io_error(e, path))?;
    let mut buf = Vec::with_capacity(size.min(cap) as usize);
    f.take(cap).read_to_end(&mut buf).map_err(|e| io_error(e, path))?;
    let truncated = size > buf.len() as u64;
    let mime = guess_mime(path);
    let binary_mime = mime.map(|m| !(m.starts_with("text/") || m.ends_with("json") || m.ends_with("xml") || m.ends_with("javascript") || m.ends_with("svg+xml") || m.ends_with("toml") || m.ends_with("yaml"))).unwrap_or(false);
    let (text, base64) = if !binary_mime && !buf.iter().take(8192).any(|b| *b == 0) {
        match decode_utf8_prefix(&buf, truncated) {
            Some(s) => (Some(s), None),
            None => (None, Some(base64::engine::general_purpose::STANDARD.encode(&buf))),
        }
    } else {
        (None, Some(base64::engine::general_purpose::STANDARD.encode(&buf)))
    };
    let mime = mime.map(str::to_string).or_else(|| Some(if text.is_some() { "text/plain".into() } else { "application/octet-stream".into() }));
    Ok(FsReadResult { path: path.display().to_string(), size, text, base64, mime, truncated })
}

/// UTF-8 decode; when the buffer was cut, drop a split trailing sequence (≤ 3 bytes).
fn decode_utf8_prefix(buf: &[u8], truncated: bool) -> Option<String> {
    match std::str::from_utf8(buf) {
        Ok(s) => Some(s.to_string()),
        Err(e) if truncated && e.error_len().is_none() && buf.len() - e.valid_up_to() <= 3 => {
            Some(String::from_utf8_lossy(&buf[..e.valid_up_to()]).into_owned())
        }
        Err(_) => None,
    }
}

pub(crate) fn guess_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "gz" | "tgz" => "application/gzip",
        "wasm" => "application/wasm",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "json" | "jsonl" => "application/json",
        "xml" => "application/xml",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" | "cjs" => "text/javascript",
        "ts" | "tsx" | "mts" | "cts" => "text/typescript",
        "jsx" => "text/javascript",
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        "yaml" | "yml" => "application/yaml",
        "toml" => "application/toml",
        "rs" => "text/x-rust",
        "py" => "text/x-python",
        "go" => "text/x-go",
        "sh" | "bash" | "zsh" => "text/x-shellscript",
        "txt" | "log" => "text/plain",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_paths() {
        let home = home_dir();
        assert_eq!(resolve_path("~").unwrap(), home);
        assert_eq!(resolve_path("~/a/../b").unwrap(), home.join("b"));
        assert_eq!(resolve_path("x/./y").unwrap(), home.join("x").join("y"));
        if cfg!(unix) {
            assert_eq!(resolve_path("/tmp/../etc").unwrap(), PathBuf::from("/etc"));
        }
        assert_eq!(resolve_path("  ").unwrap_err().code, "invalid_params");
    }

    #[test]
    fn fuzzy_ranking_prefers_basename_and_boundaries() {
        let c: Vec<String> = ["src/features/board/BoardView.tsx", "docs/build.md", "src/core/store.ts", "crates/tf-hostd/src/ops/fs.rs", "src/b/o/a/r/d.ts"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let (r, _) = rank(&c, "board", 10);
        assert_eq!(r[0], "src/features/board/BoardView.tsx");
        let (r, _) = rank(&c, "fs.rs", 10);
        assert_eq!(r[0], "crates/tf-hostd/src/ops/fs.rs");
        let (r, _) = rank(&c, "bv", 10);
        assert_eq!(r[0], "src/features/board/BoardView.tsx");
        let (r, t) = rank(&c, "zzz", 10);
        assert!(r.is_empty() && !t);
        let (r, t) = rank(&c, "", 2);
        assert_eq!(r.len(), 2);
        assert!(t);
        assert_eq!(r[0], "docs/build.md");
    }

    #[test]
    fn utf8_prefix_decoding() {
        let s = "héllo".as_bytes();
        assert_eq!(decode_utf8_prefix(&s[..2], true).as_deref(), Some("h"));
        assert_eq!(decode_utf8_prefix(&s[..2], false), None);
        assert_eq!(decode_utf8_prefix(&[0xff, 0xfe], true), None);
    }

    #[tokio::test]
    async fn list_dirs_first_hidden_filter_and_badges() {
        let td = crate::ops::git::tests::fixture();
        let parent = td.path();
        std::fs::create_dir(parent.join("Zdir")).unwrap();
        std::fs::create_dir(parent.join(".hiddendir")).unwrap();
        let l = list(&FsListParams { path: parent.display().to_string(), hidden: false }).await.unwrap();
        assert!(l.entries.iter().all(|e| !e.name.starts_with('.')));
        assert_eq!(l.entries[0].name, "Zdir");
        assert_eq!(l.entries[0].kind, FsKind::Dir);
        assert!(l.entries.iter().any(|e| e.name == "a.txt" && e.kind == FsKind::File && e.size == Some(22)));
        let badge = l.git.unwrap();
        assert!(badge.repo_root);
        assert_eq!(badge.branch.as_deref(), Some("feat"));
        assert!(badge.dirty.unwrap() >= 4);
        let l2 = list(&FsListParams { path: parent.display().to_string(), hidden: true }).await.unwrap();
        assert!(l2.entries.iter().any(|e| e.name == ".hiddendir" && e.hidden));
        // Entry badge from the parent dir's view.
        let up = list(&FsListParams { path: parent.parent().unwrap().display().to_string(), hidden: true }).await.unwrap();
        let me = up.entries.iter().find(|e| Path::new(&e.path) == parent).unwrap();
        assert_eq!(me.git.as_ref().and_then(|g| g.branch.as_deref()), Some("feat"));
        // Sub dir inside the repo.
        let sub = list(&FsListParams { path: parent.join("Zdir").display().to_string(), hidden: false }).await.unwrap();
        assert_eq!(sub.git.map(|g| (g.repo_root, g.branch)), Some((false, Some("feat".into()))));
        assert_eq!(list(&FsListParams { path: "/definitely/not/here".into(), hidden: false }).await.unwrap_err().code, "not_found");
    }

    #[tokio::test]
    async fn search_and_read() {
        let td = crate::ops::git::tests::fixture();
        let r = search(&FsSearchParams { root: td.path().display().to_string(), query: "untr".into(), limit: None }).await.unwrap();
        assert_eq!(r.files.first().map(String::as_str), Some("untracked.md"));
        // non-git walk
        let plain = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(plain.path().join("deep/er")).unwrap();
        std::fs::create_dir_all(plain.path().join("node_modules/x")).unwrap();
        std::fs::write(plain.path().join("deep/er/needle.txt"), "x").unwrap();
        std::fs::write(plain.path().join("node_modules/x/needle.txt"), "x").unwrap();
        let r = search(&FsSearchParams { root: plain.path().display().to_string(), query: "needle".into(), limit: Some(5) }).await.unwrap();
        assert_eq!(r.files, vec!["deep/er/needle.txt".to_string()]);

        let f = td.path().join("a.txt");
        let t = read(&FsReadParams { path: f.display().to_string(), max_bytes: None }).await.unwrap();
        assert_eq!(t.text.as_deref(), Some("one\n2\nthree\nfour\nfive\n"));
        assert!(!t.truncated);
        let cut = read(&FsReadParams { path: f.display().to_string(), max_bytes: Some(4) }).await.unwrap();
        assert_eq!((cut.text.as_deref(), cut.truncated, cut.size), (Some("one\n"), true, 22));
        let bin = td.path().join("x.bin");
        std::fs::write(&bin, [0u8, 1, 2, 255]).unwrap();
        let b = read(&FsReadParams { path: bin.display().to_string(), max_bytes: None }).await.unwrap();
        assert_eq!(b.base64.as_deref(), Some("AAEC/w=="));
        assert_eq!(b.mime.as_deref(), Some("application/octet-stream"));
    }
}
