//! `session.artifacts` / `session.artifact` / `session.writeLocal` (architecture §3.20): the files an
//! omp session and its subagents wrote into the session's artifacts dir (`<session>.jsonl` →
//! `<session>/`), and nothing outside it; `session.writeLocal` adds one: a pasted text saved as
//! `local://paste-<n>.md`.
//!
//! * `local`: every regular file under the session's `local://` root (omp `resolveLocalRoot`:
//!   `<artifacts>/local`; on Windows a root of 180+ UTF-16 units is `%TEMP%/omp-local/<session id>`).
//! * `agent`: subagent outputs, `<id>.md` next to the subagent's `<id>.jsonl` transcript; nested
//!   subagents live in their parent's dir (`<A>/<A>.<B>.md`), at most 6 levels down.
//! * `handoff`: `handoff-<time>.md` at the top of the artifacts dir (omp's saved auto handoffs).
//!
//! Symlinks are never followed while listing (omp's own listing skips them too); a read resolves the
//! requested name inside its kind's root and refuses anything whose real path leaves that root.
//! Parked agents (pane closed) keep their artifacts: both methods work for them. Blocking I/O runs
//! on the blocking pool.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use tf_proto::{ApiError, ArtifactContent, ArtifactFile, ArtifactKind, ArtifactParams, LocalWriteParams, LocalWritten, Millis, SessionArtifacts};

use crate::ops::fs::io_error;
use crate::ops::Ctx;

/// Files listed at most (newest first).
const MAX_FILES: usize = 500;
/// Directory entries one listing looks at, at most (a runaway `local://` tree stays cheap).
const MAX_VISITS: usize = 20_000;
/// `local://` directory depth.
const LOCAL_DEPTH: usize = 16;
/// Nested subagents (`crate::artifacts` walks transcripts as deep).
const AGENT_DEPTH: usize = 6;
/// Bytes read for a `.md` file's title.
const TITLE_BYTES: u64 = 4096;
/// Bytes that decide whether a file is text (omp's `LOCAL_TEXT_SNIFF_BYTES`).
const SNIFF_BYTES: usize = 8 * 1024;
const DEFAULT_READ: u64 = 1 << 20;
const MIN_READ: u64 = 4 << 10;
const MAX_READ: u64 = 4 << 20;
const MAX_NAME: usize = 1024;
/// omp `WINDOWS_LOCAL_ROOT_MAX_CHARS`.
const WINDOWS_LOCAL_ROOT_MAX_CHARS: usize = 180;
/// omp's `BINARY_FILE_EXTENSIONS` (local-protocol.ts): never decoded as text.
const BINARY_EXTENSIONS: &[&str] = &[
    "7z", "avi", "bmp", "bz2", "db", "doc", "docx", "gif", "gz", "ico", "jpeg", "jpg", "m4v", "mkv", "mov", "mp4", "pdf", "png", "ppt", "pptx",
    "rar", "sqlite", "tgz", "webm", "webp", "wmv", "xls", "xlsx", "xz", "zip",
];

/// Where a session's artifacts live on the host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionPaths {
    /// `<session>.jsonl` without `.jsonl`.
    pub dir: PathBuf,
    /// Its `local://` root.
    pub local_root: PathBuf,
}

impl SessionPaths {
    /// omp's layout for the session file `file` (`…/<ts>_<id>.jsonl`); `None` for anything else.
    pub fn of(file: &Path, session_id: Option<&str>, windows: bool) -> Option<Self> {
        let name = file.file_name()?.to_str()?;
        let stem = name.strip_suffix(".jsonl").filter(|s| !s.is_empty())?;
        let dir = file.with_file_name(stem);
        let local = dir.join("local");
        let long = local.to_string_lossy().encode_utf16().count() >= WINDOWS_LOCAL_ROOT_MAX_CHARS;
        let local_root = if windows && long {
            let sid = session_id.map(str::to_owned).or_else(|| stem.rsplit_once('_').map(|(_, id)| id.to_owned()));
            std::env::temp_dir().join("omp-local").join(safe_session_id(sid.as_deref()))
        } else {
            local
        };
        Some(Self { dir, local_root })
    }

    fn root(&self, kind: ArtifactKind) -> &Path {
        match kind {
            ArtifactKind::Local => &self.local_root,
            ArtifactKind::Agent | ArtifactKind::Handoff => &self.dir,
        }
    }
}

/// omp `safeSessionId`.
fn safe_session_id(sid: Option<&str>) -> String {
    let safe: String = sid.unwrap_or("session").chars().map(|c| if c.is_ascii_alphanumeric() || "_.-".contains(c) { c } else { '_' }).collect();
    if safe.is_empty() || safe == "." || safe == ".." { "session".into() } else { safe }
}

// ───────────────────────────── methods ─────────────────────────────

pub async fn list(ctx: &Ctx, agent_id: &str) -> Result<SessionArtifacts, ApiError> {
    let Some(paths) = session_paths(ctx, agent_id)? else {
        return Ok(SessionArtifacts { dir: None, local_root: None, files: Vec::new(), truncated: false });
    };
    tokio::task::spawn_blocking(move || list_paths(&paths)).await.map_err(|e| ApiError::new("internal", format!("listing artifacts: {e}")))
}

pub async fn read(ctx: &Ctx, p: ArtifactParams) -> Result<ArtifactContent, ApiError> {
    let paths = session_paths(ctx, &p.agent_id)?.ok_or_else(|| ApiError::new("not_found", "this session has no artifacts yet"))?;
    let max = p.max_bytes.unwrap_or(DEFAULT_READ).clamp(MIN_READ, MAX_READ);
    tokio::task::spawn_blocking(move || read_artifact(&paths, p.kind, &p.name, max))
        .await
        .map_err(|e| ApiError::new("internal", format!("reading an artifact: {e}")))?
}

/// The artifacts of an omp agent's session, live or parked (`None`: omp names no session file yet).
fn session_paths(ctx: &Ctx, agent_id: &str) -> Result<Option<SessionPaths>, ApiError> {
    let a = ctx.state.agent(agent_id).ok_or_else(|| ApiError::new("not_found", format!("no agent `{agent_id}`")))?;
    if a.kind != "omp" {
        return Err(ApiError::new("unsupported", format!("`{}` is a {} agent; only omp sessions have artifacts", a.name, a.kind)));
    }
    let file = a.parked.as_ref().map(|p| p.session_file.clone()).or_else(|| a.omp.as_ref().and_then(|o| o.session_file.clone()));
    let sid = a.omp.as_ref().and_then(|o| o.session_id.clone());
    Ok(file.and_then(|f| SessionPaths::of(Path::new(&f), sid.as_deref(), cfg!(windows))))
}

// ───────────────────────────── writing ─────────────────────────────

/// `session.writeLocal` (omp's `#attachPasteAsFile`, which picks the first free `paste-<n>.md` in
/// the session's `local://` root): the text, 1 B to 4 MiB.
const MAX_LOCAL_WRITE: usize = 4 << 20;
/// `paste-<n>.md` names tried before giving up (a writer racing this one takes the next free one).
const WRITE_TRIES: u32 = 1000;

pub async fn write_local(ctx: &Ctx, p: LocalWriteParams) -> Result<LocalWritten, ApiError> {
    check_paste(&p.text)?;
    let paths = session_paths(ctx, &p.agent_id)?
        .ok_or_else(|| ApiError::new("not_found", "this session has no session file yet").with_hint("Send it a message first, or attach the paste as a block"))?;
    let text = p.text;
    let (name, path, size) = tokio::task::spawn_blocking(move || write_paste(&paths.local_root, &text))
        .await
        .map_err(|e| ApiError::new("internal", format!("saving a paste: {e}")))??;
    tracing::info!(agent = %p.agent_id, name, bytes = size, "pasted text saved");
    Ok(LocalWritten { url: format!("local://{name}"), path: path.display().to_string(), name, size })
}

/// Refuses an empty or oversized text before anything touches the disk.
fn check_paste(text: &str) -> Result<(), ApiError> {
    if text.is_empty() {
        return Err(ApiError::new("invalid_params", "nothing to save"));
    }
    if text.len() > MAX_LOCAL_WRITE {
        return Err(ApiError::new(
            "invalid_params",
            format!("the text is {:.1} MiB; a paste can be at most {} MiB", text.len() as f64 / f64::from(1u32 << 20), MAX_LOCAL_WRITE >> 20),
        ));
    }
    Ok(())
}

/// Saves `text` as the next `paste-<n>.md` in `root` (blocking): `n` is one past the largest
/// `paste-<n>.md` among the top-level entries (gaps are not refilled). A missing root is created
/// (0700); an existing one is left as it is (omp owns it). The file is created 0600 with `O_EXCL`,
/// so it never overwrites or follows anything already there; a name taken in the meantime moves
/// on to the next. Returns the name, its absolute path and the bytes written.
fn write_paste(root: &Path, text: &str) -> Result<(String, PathBuf, u64), ApiError> {
    match fs::metadata(root) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return Err(ApiError::new("invalid_params", format!("{} is not a directory", root.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => crate::paths::create_private_dir(root).map_err(|e| io_error(e, root))?,
        Err(e) => return Err(io_error(e, root)),
    }
    let taken = fs::read_dir(root)
        .map_err(|e| io_error(e, root))?
        .filter_map(|e| e.ok()?.file_name().to_str().and_then(paste_number))
        .max()
        .unwrap_or(0);
    create_from(root, taken.saturating_add(1), text)
}

/// Creates `paste-<n>.md` for the first free `n` ≥ `first` (blocking; `root` exists).
fn create_from(root: &Path, first: u64, text: &str) -> Result<(String, PathBuf, u64), ApiError> {
    let mut n = first;
    for _ in 0..WRITE_TRIES {
        let name = format!("paste-{n}.md");
        let path = root.join(&name);
        match crate::paths::create_private_new(&path) {
            Ok(mut f) => {
                if let Err(e) = f.write_all(text.as_bytes()).and_then(|()| f.flush()) {
                    drop(f);
                    let _ = fs::remove_file(&path);
                    return Err(io_error(e, &path));
                }
                return Ok((name, path, text.len() as u64));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => n = n.saturating_add(1),
            Err(e) => return Err(io_error(e, &path)),
        }
    }
    Err(ApiError::new("io_error", format!("{}: no free paste-<n>.md name after {WRITE_TRIES} tries", root.display())))
}

/// `<n>` of `paste-<n>.md` (ASCII digits only).
fn paste_number(name: &str) -> Option<u64> {
    let digits = name.strip_prefix("paste-")?.strip_suffix(".md")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

// ───────────────────────────── listing ─────────────────────────────

/// Lists `paths` (blocking).
pub(crate) fn list_paths(paths: &SessionPaths) -> SessionArtifacts {
    let mut files = Vec::new();
    let mut visits = MAX_VISITS;
    walk_local(&paths.local_root, "", 0, &mut files, &mut visits);
    walk_outputs(&paths.dir, "", 0, &mut files, &mut visits);
    files.sort_by(|a, b| b.mtime.cmp(&a.mtime).then_with(|| a.name.cmp(&b.name)));
    let truncated = files.len() > MAX_FILES || visits == 0;
    files.truncate(MAX_FILES);
    for f in &mut files {
        if f.name.ends_with(".md") {
            f.title = md_title(&paths.root(f.kind).join(&f.name));
        }
    }
    SessionArtifacts {
        dir: Some(paths.dir.display().to_string()),
        local_root: Some(paths.local_root.display().to_string()),
        files,
        truncated,
    }
}

/// `(name, file type, metadata)` of a dir's entries with UTF-8 names; symlinks are not followed.
fn entries(dir: &Path, visits: &mut usize) -> Vec<(String, fs::FileType, Option<fs::Metadata>)> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for e in rd.flatten() {
        if *visits == 0 {
            break;
        }
        *visits -= 1;
        let (Ok(name), Ok(ft)) = (e.file_name().into_string(), e.file_type()) else { continue };
        let meta = if ft.is_file() { e.metadata().ok() } else { None };
        out.push((name, ft, meta));
    }
    out
}

fn join(rel: &str, name: &str) -> String {
    if rel.is_empty() { name.to_owned() } else { format!("{rel}/{name}") }
}

fn file(kind: ArtifactKind, name: String, url: Option<String>, meta: &fs::Metadata) -> ArtifactFile {
    ArtifactFile { kind, name, url, size: meta.len(), mtime: mtime(meta), title: None }
}

fn mtime(meta: &fs::Metadata) -> Millis {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as Millis)
}

fn walk_local(root: &Path, rel: &str, depth: usize, out: &mut Vec<ArtifactFile>, visits: &mut usize) {
    for (name, ft, meta) in entries(&root.join(rel), visits) {
        let path = join(rel, &name);
        if ft.is_dir() && depth < LOCAL_DEPTH {
            walk_local(root, &path, depth + 1, out, visits);
        } else if let Some(meta) = meta.filter(|_| ft.is_file()) {
            out.push(file(ArtifactKind::Local, path.clone(), Some(format!("local://{path}")), &meta));
        }
    }
}

/// Subagent outputs (`<id>.md` beside `<id>.jsonl`) under `dir/rel`, their subagents' dirs (`<id>/`
/// beside `<id>.jsonl`), and at the top the saved handoffs.
fn walk_outputs(dir: &Path, rel: &str, depth: usize, out: &mut Vec<ArtifactFile>, visits: &mut usize) {
    let list = entries(&dir.join(rel), visits);
    let transcripts: HashSet<&str> = list.iter().filter(|(_, ft, _)| ft.is_file()).filter_map(|(n, _, _)| n.strip_suffix(".jsonl")).collect();
    let mut subdirs = Vec::new();
    for (name, ft, meta) in &list {
        if ft.is_dir() {
            if transcripts.contains(name.as_str()) && depth < AGENT_DEPTH {
                subdirs.push(join(rel, name));
            }
            continue;
        }
        let Some(meta) = meta.as_ref().filter(|_| ft.is_file()) else { continue };
        let Some(id) = name.strip_suffix(".md") else { continue };
        if transcripts.contains(id) {
            out.push(file(ArtifactKind::Agent, join(rel, name), Some(format!("agent://{id}")), meta));
        } else if depth == 0 && name.starts_with("handoff-") {
            out.push(file(ArtifactKind::Handoff, name.clone(), None, meta));
        }
    }
    for sub in subdirs {
        walk_outputs(dir, &sub, depth + 1, out, visits);
    }
}

/// The first Markdown heading (`#`–`###`) in the first 4 KiB, outside code fences.
fn md_title(path: &Path) -> Option<String> {
    let mut buf = Vec::new();
    File::open(path).ok()?.take(TITLE_BYTES).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let mut fenced = false;
    for line in text.lines() {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        let hashes = t.chars().take_while(|&c| c == '#').count();
        if (1..=3).contains(&hashes) && t[hashes..].starts_with(' ') {
            let title = t[hashes..].trim().trim_end_matches('#').trim();
            if !title.is_empty() {
                return Some(crate::util::clip(title, 120));
            }
        }
    }
    None
}

// ───────────────────────────── reading ─────────────────────────────

/// Checks a requested name: relative, `/`-separated, no `.`/`..`, and of the shape its kind lists.
fn check_name(kind: ArtifactKind, name: &str) -> Result<PathBuf, ApiError> {
    let bad = |why: &str| ApiError::new("invalid_params", format!("artifact name `{}`: {why}", crate::util::clip(name, 80)));
    if name.is_empty() || name.len() > MAX_NAME {
        return Err(bad("empty or too long"));
    }
    if name.contains(['\0', '\\']) || name.starts_with('/') {
        return Err(bad("must be a relative `/`-separated name"));
    }
    let segments: Vec<&str> = name.split('/').collect();
    if segments.iter().any(|s| s.is_empty() || *s == "." || *s == "..") {
        return Err(bad("`.`, `..` and empty segments are not allowed"));
    }
    let rel = PathBuf::from(name);
    if !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(bad("must stay inside the session's artifacts"));
    }
    match kind {
        ArtifactKind::Local => {}
        ArtifactKind::Agent => {
            if !name.ends_with(".md") || segments[0] == "local" {
                return Err(bad("not a subagent output"));
            }
        }
        ArtifactKind::Handoff => {
            if segments.len() != 1 || !name.starts_with("handoff-") || !name.ends_with(".md") {
                return Err(bad("not a handoff document"));
            }
        }
    }
    Ok(rel)
}

/// Reads one artifact (blocking): `name` resolved in its kind's root, refused when its real path
/// (symlinks resolved) leaves that root.
pub(crate) fn read_artifact(paths: &SessionPaths, kind: ArtifactKind, name: &str, max: u64) -> Result<ArtifactContent, ApiError> {
    let rel = check_name(kind, name)?;
    let root = paths.root(kind);
    let target = root.join(&rel);
    if kind == ArtifactKind::Agent {
        let transcript = target.with_extension("jsonl");
        if !fs::symlink_metadata(&transcript).is_ok_and(|m| m.is_file()) {
            return Err(ApiError::new("not_found", format!("`{name}` is not a subagent output of this session")));
        }
    }
    let real_root = fs::canonicalize(root).map_err(|e| crate::ops::fs::io_error(e, root))?;
    let real = fs::canonicalize(&target).map_err(|e| crate::ops::fs::io_error(e, &target))?;
    if !real.starts_with(&real_root) {
        return Err(ApiError::new("invalid_params", format!("`{}` leads outside the session's artifacts", crate::util::clip(name, 80))));
    }
    let meta = fs::metadata(&real).map_err(|e| crate::ops::fs::io_error(e, &real))?;
    if !meta.is_file() {
        return Err(ApiError::new("invalid_params", format!("`{}` is not a file", crate::util::clip(name, 80))));
    }
    let size = meta.len();
    let mut bytes = Vec::with_capacity(size.min(max) as usize);
    File::open(&real).and_then(|f| f.take(max).read_to_end(&mut bytes)).map_err(|e| crate::ops::fs::io_error(e, &real))?;
    let truncated = (bytes.len() as u64) < size;
    let ext = real.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    let binary = ext.as_deref().is_some_and(|e| BINARY_EXTENSIONS.contains(&e)) || !looks_like_text(&bytes[..bytes.len().min(SNIFF_BYTES)]);
    let text = (!binary).then(|| decode(bytes, truncated));
    let url = match kind {
        ArtifactKind::Local => Some(format!("local://{name}")),
        ArtifactKind::Agent => rel.file_stem().and_then(|s| s.to_str()).map(|id| format!("agent://{id}")),
        ArtifactKind::Handoff => None,
    };
    Ok(ArtifactContent { kind, name: name.to_owned(), url, path: real.display().to_string(), size, mtime: mtime(&meta), text, truncated, binary })
}

/// No NUL bytes and valid UTF-8, allowing a character cut off at the end of the sample.
fn looks_like_text(sample: &[u8]) -> bool {
    if sample.contains(&0) {
        return false;
    }
    match std::str::from_utf8(sample) {
        Ok(_) => true,
        Err(e) => e.error_len().is_none(),
    }
}

/// UTF-8 text of what was read: a character the read cut in half is dropped; invalid bytes further
/// in (past the sniffed start) become U+FFFD.
fn decode(mut bytes: Vec<u8>, truncated: bool) -> String {
    if truncated && let Err(e) = std::str::from_utf8(&bytes) && e.error_len().is_none() {
        bytes.truncate(e.valid_up_to());
    }
    match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn write(path: &Path, text: &str, age_s: u64) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
        let t = SystemTime::now() - Duration::from_secs(age_s);
        File::options().write(true).open(path).unwrap().set_modified(t).unwrap();
    }

    /// `<tmp>/sessions/-w/2026_S1.jsonl` and its artifacts dir, as omp lays them out.
    fn session(tmp: &Path) -> SessionPaths {
        let file = tmp.join("sessions/-w/2026-10-29T10-00-00-000Z_S1.jsonl");
        write(&file, "{}\n", 0);
        let paths = SessionPaths::of(&file, Some("S1"), false).unwrap();
        let d = &paths.dir;
        write(&d.join("local/auth-plan.md"), "---\nx: 1\n---\n\n```md\n# not this\n```\n## Auth plan ##\nsteps\n", 50);
        write(&d.join("local/reports/scan.md"), "# Scan report\n", 40);
        write(&d.join("local/data.json"), "{\"a\":1}", 30);
        // subagent outputs: top level and nested, each beside its transcript
        write(&d.join("Explore.jsonl"), "{}\n", 20);
        write(&d.join("Explore.md"), "# Findings\n", 20);
        write(&d.join("Brainstorm.jsonl"), "{}\n", 25);
        write(&d.join("Brainstorm/Brainstorm.Scout.jsonl"), "{}\n", 10);
        write(&d.join("Brainstorm/Brainstorm.Scout.md"), "Scout output", 10);
        write(&d.join("handoff-2026-10-29T10-00-00-000Z.md"), "# Handoff\n", 5);
        // noise: tool output artifacts, fetched pages, a .md without transcript, btw history
        write(&d.join("12.bash.log"), "log", 1);
        write(&d.join("url-search/page.md"), "# page", 1);
        write(&d.join("notes.md"), "# loose", 1);
        write(&d.join("btw-history/entry-1.json"), "{}", 1);
        paths
    }

    #[test]
    fn layout_of_a_session_file() {
        let p = SessionPaths::of(Path::new("/s/-w/2026_S1.jsonl"), Some("S1"), false).unwrap();
        assert_eq!(p.dir, Path::new("/s/-w/2026_S1"));
        assert_eq!(p.local_root, Path::new("/s/-w/2026_S1/local"));
        assert_eq!(SessionPaths::of(Path::new("/s/-w/x.json"), None, false), None);
        assert_eq!(SessionPaths::of(Path::new("/s/-w/.jsonl"), None, false), None);
        // Windows: a long local root moves to %TEMP%/omp-local/<safe session id> (omp shortLocalRoot)
        let long = format!("/{}/2026_01a1:b.jsonl", "d".repeat(200));
        let w = SessionPaths::of(Path::new(&long), None, true).unwrap();
        assert_eq!(w.local_root, std::env::temp_dir().join("omp-local").join("01a1_b"));
        let short = SessionPaths::of(Path::new("/s/2026_S1.jsonl"), Some("S1"), true).unwrap();
        assert_eq!(short.local_root, Path::new("/s/2026_S1/local"));
    }

    #[test]
    fn lists_local_files_outputs_and_handoffs_newest_first() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = session(tmp.path());
        let list = list_paths(&paths);
        let got: Vec<(ArtifactKind, &str, Option<&str>, Option<&str>)> =
            list.files.iter().map(|f| (f.kind, f.name.as_str(), f.url.as_deref(), f.title.as_deref())).collect();
        assert_eq!(
            got,
            vec![
                (ArtifactKind::Handoff, "handoff-2026-10-29T10-00-00-000Z.md", None, Some("Handoff")),
                (ArtifactKind::Agent, "Brainstorm/Brainstorm.Scout.md", Some("agent://Brainstorm.Scout"), None),
                (ArtifactKind::Agent, "Explore.md", Some("agent://Explore"), Some("Findings")),
                (ArtifactKind::Local, "data.json", Some("local://data.json"), None),
                (ArtifactKind::Local, "reports/scan.md", Some("local://reports/scan.md"), Some("Scan report")),
                (ArtifactKind::Local, "auth-plan.md", Some("local://auth-plan.md"), Some("Auth plan")),
            ]
        );
        assert!(!list.truncated);
        assert_eq!(list.files[3].size, 7);
        assert_eq!(list.local_root.as_deref(), Some(paths.local_root.to_str().unwrap()));
    }

    #[test]
    fn missing_dirs_list_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = SessionPaths::of(&tmp.path().join("a/2026_S2.jsonl"), None, false).unwrap();
        let list = list_paths(&paths);
        assert!(list.files.is_empty() && !list.truncated);
    }

    #[cfg(unix)]
    #[test]
    fn listing_skips_symlinks() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = session(tmp.path());
        write(&tmp.path().join("secret.txt"), "secret", 0);
        std::os::unix::fs::symlink(tmp.path().join("secret.txt"), paths.local_root.join("link.txt")).unwrap();
        std::os::unix::fs::symlink(tmp.path(), paths.local_root.join("up")).unwrap();
        let names: Vec<String> = list_paths(&paths).files.into_iter().map(|f| f.name).collect();
        assert!(!names.iter().any(|n| n.contains("link") || n.starts_with("up/")), "{names:?}");
    }

    #[test]
    fn reads_inside_its_root_only() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = session(tmp.path());
        write(&paths.dir.join("outside.md"), "# not local", 0);
        let ok = read_artifact(&paths, ArtifactKind::Local, "reports/scan.md", DEFAULT_READ).unwrap();
        assert_eq!(ok.text.as_deref(), Some("# Scan report\n"));
        assert_eq!(ok.url.as_deref(), Some("local://reports/scan.md"));
        assert!(!ok.truncated && !ok.binary);
        for name in ["../outside.md", "reports/../../outside.md", "/etc/passwd", "./auth-plan.md", "reports//scan.md", "a\\b.md", "", "x\0.md"] {
            let err = read_artifact(&paths, ArtifactKind::Local, name, DEFAULT_READ).unwrap_err();
            assert_eq!(err.code, "invalid_params", "{name:?}: {err:?}");
        }
        // a directory is no file; a missing one is not found
        assert_eq!(read_artifact(&paths, ArtifactKind::Local, "reports", DEFAULT_READ).unwrap_err().code, "invalid_params");
        assert_eq!(read_artifact(&paths, ArtifactKind::Local, "nope.md", DEFAULT_READ).unwrap_err().code, "not_found");
    }

    #[test]
    fn outputs_and_handoffs_keep_their_shape() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = session(tmp.path());
        let out = read_artifact(&paths, ArtifactKind::Agent, "Brainstorm/Brainstorm.Scout.md", DEFAULT_READ).unwrap();
        assert_eq!((out.text.as_deref(), out.url.as_deref()), (Some("Scout output"), Some("agent://Brainstorm.Scout")));
        // only outputs beside a transcript; never other files of the artifacts dir
        assert_eq!(read_artifact(&paths, ArtifactKind::Agent, "notes.md", DEFAULT_READ).unwrap_err().code, "not_found");
        assert_eq!(read_artifact(&paths, ArtifactKind::Agent, "Explore.jsonl", DEFAULT_READ).unwrap_err().code, "invalid_params");
        assert_eq!(read_artifact(&paths, ArtifactKind::Agent, "local/auth-plan.md", DEFAULT_READ).unwrap_err().code, "invalid_params");
        assert_eq!(read_artifact(&paths, ArtifactKind::Handoff, "12.bash.log", DEFAULT_READ).unwrap_err().code, "invalid_params");
        assert_eq!(read_artifact(&paths, ArtifactKind::Handoff, "url-search/handoff-x.md", DEFAULT_READ).unwrap_err().code, "invalid_params");
        let h = read_artifact(&paths, ArtifactKind::Handoff, "handoff-2026-10-29T10-00-00-000Z.md", DEFAULT_READ).unwrap();
        assert_eq!((h.text.as_deref(), h.url), (Some("# Handoff\n"), None));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_that_leave_the_root_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = session(tmp.path());
        write(&tmp.path().join("secret.txt"), "secret", 0);
        std::os::unix::fs::symlink(tmp.path().join("secret.txt"), paths.local_root.join("link.txt")).unwrap();
        std::os::unix::fs::symlink(tmp.path(), paths.local_root.join("up")).unwrap();
        std::os::unix::fs::symlink(paths.local_root.join("auth-plan.md"), paths.local_root.join("alias.md")).unwrap();
        for name in ["link.txt", "up/secret.txt"] {
            assert_eq!(read_artifact(&paths, ArtifactKind::Local, name, DEFAULT_READ).unwrap_err().code, "invalid_params", "{name}");
        }
        // a link that stays inside the root reads like its target
        assert!(read_artifact(&paths, ArtifactKind::Local, "alias.md", DEFAULT_READ).unwrap().text.unwrap().contains("Auth plan"));
        // a local root that is itself a link elsewhere: its files are inside that (real) root
        let elsewhere = tmp.path().join("elsewhere");
        write(&elsewhere.join("x.md"), "x", 0);
        let file = tmp.path().join("s2/2026_S3.jsonl");
        write(&file, "{}", 0);
        let p2 = SessionPaths::of(&file, None, false).unwrap();
        fs::create_dir_all(&p2.dir).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &p2.local_root).unwrap();
        assert_eq!(read_artifact(&p2, ArtifactKind::Local, "x.md", DEFAULT_READ).unwrap().text.as_deref(), Some("x"));
    }

    #[test]
    fn binary_and_truncated_files() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = session(tmp.path());
        write(&paths.local_root.join("shot.png"), "not really a png", 0);
        fs::write(paths.local_root.join("blob.bin"), b"ab\0cd").unwrap();
        fs::write(paths.local_root.join("latin1.txt"), b"caf\xe9 au lait").unwrap();
        for name in ["shot.png", "blob.bin", "latin1.txt"] {
            let r = read_artifact(&paths, ArtifactKind::Local, name, DEFAULT_READ).unwrap();
            assert!(r.binary && r.text.is_none(), "{name}");
        }
        // cut inside a multi-byte character: the half character is dropped
        let text = format!("{}é tail", "a".repeat(MIN_READ as usize - 1));
        write(&paths.local_root.join("long.md"), &text, 0);
        let r = read_artifact(&paths, ArtifactKind::Local, "long.md", MIN_READ).unwrap();
        assert!(r.truncated && !r.binary);
        assert_eq!(r.text.unwrap(), "a".repeat(MIN_READ as usize - 1));
        assert_eq!(r.size, text.len() as u64);
    }

    #[test]
    fn titles_and_session_ids() {
        assert_eq!(safe_session_id(Some("01a1-x_y.z")), "01a1-x_y.z");
        assert_eq!(safe_session_id(Some("a/b c")), "a_b_c");
        assert_eq!(safe_session_id(Some("..")), "session");
        assert_eq!(safe_session_id(None), "session");
    }

    #[test]
    fn first_paste_creates_a_private_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("s/2026_S1/local");
        let (name, path, size) = write_paste(&root, "héllo\nworld\n").unwrap();
        assert_eq!((name.as_str(), size), ("paste-1.md", 13));
        assert_eq!(path, root.join("paste-1.md"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "héllo\nworld\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&root).unwrap().permissions().mode() & 0o777, 0o700);
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // Consecutive writes get consecutive names, and the listing shows them as local files.
        assert_eq!(write_paste(&root, "two").unwrap().0, "paste-2.md");
        assert_eq!(write_paste(&root, "three").unwrap().0, "paste-3.md");
        let paths = SessionPaths { dir: root.parent().unwrap().to_owned(), local_root: root.clone() };
        let listed = list_paths(&paths);
        let mut names: Vec<&str> = listed.files.iter().map(|f| f.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, ["paste-1.md", "paste-2.md", "paste-3.md"]);
    }

    #[test]
    fn numbering_continues_past_the_highest_existing_name() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("local");
        fs::create_dir_all(root.join("paste-9.md")).unwrap(); // any entry with the name counts as taken
        for decoy in ["paste-1.md", "paste-3.md", "paste-x.md", "paste-.md", "paste-2.txt", "paste-+7.md", "paste-٤٤.md", "Paste-50.md", "notes.md", "paste-99999999999999999999999.md"] {
            fs::write(root.join(decoy), "x").unwrap();
        }
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/paste-500.md"), "x").unwrap(); // subdirectories are not walked
        // Gaps are not refilled: 9 is the highest valid name.
        assert_eq!(write_paste(&root, "a").unwrap().0, "paste-10.md");
        assert_eq!(write_paste(&root, "b").unwrap().0, "paste-11.md");
    }

    #[test]
    fn an_existing_root_keeps_its_mode_and_other_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("local");
        fs::create_dir(&root).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::write(root.join("plan.md"), "keep").unwrap();
        let (_, path, _) = write_paste(&root, "x").unwrap();
        assert_eq!(path, root.join("paste-1.md"));
        assert_eq!(fs::read_to_string(root.join("plan.md")).unwrap(), "keep");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&root).unwrap().permissions().mode() & 0o777, 0o755);
        }
    }

    #[test]
    fn a_root_that_is_a_file_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("local");
        fs::write(&root, "not a dir").unwrap();
        let err = write_paste(&root, "x").unwrap_err();
        assert!(err.code == "invalid_params" && err.message.contains("local"), "{err:?}");
        assert_eq!(fs::read_to_string(&root).unwrap(), "not a dir");
    }

    #[cfg(unix)]
    #[test]
    fn a_planted_symlink_is_never_followed_or_overwritten() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("local");
        fs::create_dir(&root).unwrap();
        let secret = tmp.path().join("secret.txt");
        fs::write(&secret, "precious").unwrap();
        // Planted under the name the scan hands out next (dangling, then live) and one ahead.
        std::os::unix::fs::symlink(&secret, root.join("paste-1.md")).unwrap();
        std::os::unix::fs::symlink(tmp.path().join("nowhere"), root.join("paste-2.md")).unwrap();
        let (name, path, _) = write_paste(&root, "pasted").unwrap();
        assert_eq!(name, "paste-3.md");
        assert_eq!(fs::read_to_string(&secret).unwrap(), "precious");
        assert!(!tmp.path().join("nowhere").exists());
        assert_eq!(fs::read_to_string(path).unwrap(), "pasted");

        // A name taken between the scan and the create (a racing writer, omp's own TUI) moves on to
        // the next one, whatever took it.
        let racing = tmp.path().join("race");
        fs::create_dir(&racing).unwrap();
        std::os::unix::fs::symlink(&secret, racing.join("paste-1.md")).unwrap();
        fs::write(racing.join("paste-2.md"), "theirs").unwrap();
        assert_eq!(create_from(&racing, 1, "x").unwrap().0, "paste-3.md");
        assert_eq!(fs::read_to_string(&secret).unwrap(), "precious");
        assert_eq!(fs::read_to_string(racing.join("paste-2.md")).unwrap(), "theirs");
    }

    #[test]
    fn the_file_is_always_inside_the_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("local");
        for _ in 0..3 {
            let (name, path, _) = write_paste(&root, "x").unwrap();
            assert!(!name.contains('/') && !name.contains(".."), "{name}");
            assert_eq!(path.parent(), Some(root.as_path()));
            assert_eq!(path.file_name().and_then(|n| n.to_str()), Some(name.as_str()));
        }
    }

    #[test]
    fn empty_and_oversized_text_is_refused_before_the_disk() {
        assert_eq!(check_paste("").unwrap_err().message, "nothing to save");
        assert!(check_paste(&"a".repeat(MAX_LOCAL_WRITE)).is_ok());
        let err = check_paste(&"a".repeat(MAX_LOCAL_WRITE + 1)).unwrap_err();
        assert!(err.code == "invalid_params" && err.message.contains("4.0 MiB") && err.message.contains("at most 4 MiB"), "{err:?}");
        // Bytes count, not characters: 4 MiB of 2-byte characters is over the cap.
        assert!(check_paste(&"é".repeat(MAX_LOCAL_WRITE / 2 + 1)).is_err());
    }

    #[test]
    fn paste_names() {
        assert_eq!(paste_number("paste-1.md"), Some(1));
        assert_eq!(paste_number("paste-007.md"), Some(7));
        for no in ["paste-.md", "paste-x.md", "paste-1.txt", "paste-1.md.bak", "paste1.md", "paste--1.md", "paste-+1.md", "paste-1 .md", "xpaste-1.md"] {
            assert_eq!(paste_number(no), None, "{no}");
        }
    }
}
