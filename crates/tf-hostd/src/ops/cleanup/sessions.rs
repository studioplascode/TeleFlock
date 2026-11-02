//! Which omp sessions worked in which folders, and when: an incremental index of omp's session
//! files, for the Cleanup page's owners and last-used times (architecture §3.17).
//!
//! **Files.** A top-level session is `<sessions>/<bucket>/<stamp>_<id>.jsonl`; its subagents keep
//! their transcripts in its artifacts dir, `<stamp>_<id>/<Name>.jsonl`, theirs in
//! `<stamp>_<id>/<Name>/<Name>.<Sub>.jsonl` (each header's `parentSession` names the parent file).
//! Every transcript under a top-level session's artifacts dir belongs to that session: its main
//! agent.
//!
//! **Evidence of work in a folder**, each with its entry's time: the transcript's own folder (its
//! header's `cwd`, for every entry), and what its tools worked on: a tool call's `cwd` and `path`
//! arguments, the folder a shell command changes into (`cd <dir> && …`, `git -C <dir>`), and the
//! `cwd` and `path` a tool result reports. A file stands for its folder. Text never counts (prompts,
//! replies, tool output): a session that lists every worktree has not worked in them.
//!
//! **Incremental.** Session files only grow (omp rewrites the title slot on line 1 in place, at the
//! same length): a file is read once up to the end of its last complete line, then from there on
//! when it grows. One that shrank, was replaced (another inode) or whose bytes before that point
//! changed is read again from the start. A refresh reads within a time budget, the sessions of
//! agents on the board first, then the newest; what is left waits for the next refresh.

use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::fs::{File, Metadata};
use std::io::{Read, Seek, SeekFrom};
use std::marker::PhantomData;
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use memchr::memmem::Finder;
use serde::Deserialize;
use serde::de::{self, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use tf_proto::Millis;

/// Folders kept per transcript (more are dropped).
const DIRS_MAX: usize = 4096;
/// Read buffer; lines up to [`LINE_MAX`] grow it.
const CHUNK: usize = 4 << 20;
/// A longer line only counts for its time: tool calls are short, the long lines are tool output.
const LINE_MAX: usize = 32 << 20;
/// Bytes before a file's read point compared on the next refresh (a rewrite reads it again).
const MARK: u64 = 64;
/// How far into a line its entry's `timestamp` is looked for.
const HEAD: usize = 512;
/// Nesting of subagent dirs followed below a session's artifacts dir.
const DEPTH_MAX: usize = 8;

static TIMESTAMP: LazyLock<Finder<'static>> = LazyLock::new(|| Finder::new(br#""timestamp":""#));
static CWD: LazyLock<Finder<'static>> = LazyLock::new(|| Finder::new(br#""cwd":""#));
static PATH: LazyLock<Finder<'static>> = LazyLock::new(|| Finder::new(br#""path":""#));
static COMMAND: LazyLock<Finder<'static>> = LazyLock::new(|| Finder::new(br#""command":""#));

/// When a transcript worked in a folder: first and last time, and in how many entries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Seen {
    pub first: Millis,
    pub last: Millis,
    pub n: u32,
}

impl Seen {
    fn at(t: Millis) -> Self {
        Self { first: t, last: t, n: 1 }
    }

    fn add(&mut self, o: Seen) {
        self.first = self.first.min(o.first);
        self.last = self.last.max(o.last);
        self.n = self.n.saturating_add(o.n);
    }
}

/// What one session file says.
#[derive(Debug, Default)]
pub(crate) struct Transcript {
    len: u64,
    ino: u64,
    /// Read up to here: the end of the last complete line.
    offset: u64,
    /// The [`MARK`] bytes before `offset`.
    mark: Vec<u8>,
    pub id: Option<String>,
    pub cwd: Option<PathBuf>,
    /// Its first and last entry's `timestamp`, as written (parsed once per read).
    first_raw: Option<String>,
    last_raw: Option<String>,
    pub first_at: Option<Millis>,
    pub last_at: Option<Millis>,
    /// Folders its tools worked in.
    pub dirs: HashMap<PathBuf, Seen>,
}

#[cfg(unix)]
fn ino(m: &Metadata) -> u64 {
    std::os::unix::fs::MetadataExt::ino(m)
}

#[cfg(not(unix))]
fn ino(_: &Metadata) -> u64 {
    0
}

impl Transcript {
    /// The file has bytes this transcript has not seen (or lost some).
    fn changed(&self, m: &Metadata) -> bool {
        m.len() != self.len || ino(m) != self.ino
    }

    /// The file is the one read so far, grown: reading on from `offset` is enough.
    fn continues(&self, path: &Path, m: &Metadata) -> bool {
        if self.offset == 0 {
            return true;
        }
        if ino(m) != self.ino || m.len() < self.offset {
            return false;
        }
        read_mark(path, self.offset).is_some_and(|mark| mark == self.mark)
    }

    /// Reads the file from `offset` to its end, each complete line in place in the buffer.
    fn read(&mut self, path: &Path, m: &Metadata, home: Option<&Path>) -> std::io::Result<()> {
        let mut file = File::open(path)?;
        file.seek(SeekFrom::Start(self.offset))?;
        let mut buf = vec![0u8; CHUNK];
        // Bytes in `buf`, and the file offset of `buf[0]`.
        let (mut filled, mut pos) = (0usize, self.offset);
        // In a line longer than LINE_MAX whose head was read: the rest is skipped.
        let mut skipping = false;
        loop {
            if filled == buf.len() {
                if buf.len() < LINE_MAX {
                    buf.resize(buf.len() * 2, 0);
                } else {
                    if !skipping {
                        self.line(&buf[..filled], true, home);
                        skipping = true;
                    }
                    pos += filled as u64;
                    filled = 0;
                }
            }
            let n = file.read(&mut buf[filled..])?;
            if n == 0 {
                break;
            }
            let scan = filled;
            filled += n;
            let mut start = 0;
            for nl in memchr::memchr_iter(b'\n', &buf[scan..filled]) {
                let end = scan + nl;
                if skipping {
                    skipping = false;
                } else {
                    self.line(&buf[start..end], false, home);
                }
                start = end + 1;
                self.offset = pos + start as u64;
            }
            buf.copy_within(start..filled, 0);
            pos += start as u64;
            filled -= start;
        }
        self.len = pos + filled as u64;
        self.ino = ino(m);
        self.mark = read_mark(path, self.offset).unwrap_or_default();
        self.first_at = self.first_raw.as_deref().and_then(parse_time);
        self.last_at = self.last_raw.as_deref().and_then(parse_time);
        Ok(())
    }

    fn line(&mut self, line: &[u8], long: bool, home: Option<&Path>) {
        let head = &line[..line.len().min(HEAD)];
        if !long && head.starts_with(br#"{"type":"session""#) {
            if let Ok(h) = serde_json::from_slice::<Header>(line) {
                self.id = h.id.0;
                self.cwd = h.cwd.0.as_deref().and_then(|c| folder(c, false, home));
            }
        }
        let Some(raw) = entry_time(head) else { return };
        if self.first_raw.as_deref().is_none_or(|t| earlier(raw, t)) {
            self.first_raw = Some(raw.to_string());
        }
        if self.last_raw.as_deref().is_none_or(|t| earlier(t, raw)) {
            self.last_raw = Some(raw.to_string());
        }
        if long || (CWD.find(line).is_none() && PATH.find(line).is_none() && COMMAND.find(line).is_none()) {
            return;
        }
        let Some(at) = parse_time(raw) else { return };
        let Ok(entry) = serde_json::from_slice::<Entry>(line) else { return };
        for (raw, is_file) in entry.places() {
            if let Some(dir) = folder(&raw, is_file, home) {
                if let Some(s) = self.dirs.get_mut(&dir) {
                    s.add(Seen::at(at));
                } else if self.dirs.len() < DIRS_MAX {
                    self.dirs.insert(dir, Seen::at(at));
                }
            }
        }
    }
}

/// The `MARK` bytes before `offset`.
fn read_mark(path: &Path, offset: u64) -> Option<Vec<u8>> {
    let start = offset.saturating_sub(MARK);
    let mut f = File::open(path).ok()?;
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = vec![0; (offset - start) as usize];
    f.read_exact(&mut buf).ok()?;
    Some(buf)
}

/// An entry's `timestamp` as written, near the start of its line.
fn entry_time(head: &[u8]) -> Option<&str> {
    let at = TIMESTAMP.find(head)? + br#""timestamp":""#.len();
    let rest = &head[at..];
    let end = memchr::memchr(b'"', rest)?;
    std::str::from_utf8(&rest[..end]).ok()
}

fn parse_time(raw: &str) -> Option<Millis> {
    raw.parse::<jiff::Timestamp>().ok().map(|t| t.as_millisecond())
}

/// `a` is before `b`. omp writes `toISOString()` (`2026-10-31T16:35:40.502Z`), which sorts as text;
/// anything else is parsed.
fn earlier(a: &str, b: &str) -> bool {
    if a.len() == 24 && b.len() == 24 && a.ends_with('Z') && b.ends_with('Z') {
        return a < b;
    }
    match (parse_time(a), parse_time(b)) {
        (Some(x), Some(y)) => x < y,
        (x, _) => x.is_some(),
    }
}

/// A folder a session worked in, from a path it named: absolute (or `~/…`), lexically normalized;
/// a file stands for its folder.
fn folder(raw: &str, is_file: bool, home: Option<&Path>) -> Option<PathBuf> {
    let raw = raw.trim();
    if raw.is_empty() || raw.contains("://") || raw.contains('$') || raw.contains('`') {
        return None;
    }
    let path = match raw.strip_prefix('~') {
        Some("") => home?.to_path_buf(),
        Some(rest) if rest.starts_with('/') || rest.starts_with('\\') => home?.join(&rest[1..]),
        Some(_) => return None,
        None => PathBuf::from(raw),
    };
    if !path.is_absolute() {
        return None;
    }
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            c => out.push(c),
        }
    }
    if is_file { out.parent().map(Path::to_path_buf) } else { Some(out) }
}

/// Folders a shell command changes into: `cd <dir>` / `pushd <dir>` starting a command, and
/// `git -C <dir>`. Words with variables or substitutions are skipped by [`folder`].
fn cd_targets(cmd: &str) -> Vec<String> {
    let mut out = Vec::new();
    for seg in cmd.split(['\n', ';', '&', '|', '(', ')', '{', '}']) {
        let seg = seg.trim_start();
        if let Some(rest) = seg.strip_prefix("cd ").or_else(|| seg.strip_prefix("pushd ")) {
            out.extend(word(rest));
        }
        let mut rest = seg;
        while let Some(i) = rest.find("git -C ") {
            rest = &rest[i + "git -C ".len()..];
            out.extend(word(rest));
        }
    }
    out
}

/// The first shell word of `s` (quoted or bare).
fn word(s: &str) -> Option<String> {
    let s = s.trim_start();
    let w = match s.chars().next()? {
        q @ ('"' | '\'') => s[1..].split(q).next()?,
        _ => s.split(char::is_whitespace).next()?,
    };
    (!w.is_empty()).then(|| w.to_string())
}

// ───────────────────────────── entry shapes ─────────────────────────────

/// A string field, or nothing when it holds anything else.
#[derive(Debug, Default)]
struct Text(Option<String>);

impl<'de> Deserialize<'de> for Text {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Text;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("any value")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Text, E> {
                Ok(Text(Some(v.to_string())))
            }
            fn visit_string<E: de::Error>(self, v: String) -> Result<Text, E> {
                Ok(Text(Some(v)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Text, A::Error> {
                while m.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(Text(None))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut s: A) -> Result<Text, A::Error> {
                while s.next_element::<IgnoredAny>()?.is_some() {}
                Ok(Text(None))
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Text, E> {
                Ok(Text(None))
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Text, E> {
                Ok(Text(None))
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Text, E> {
                Ok(Text(None))
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Text, E> {
                Ok(Text(None))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Text, E> {
                Ok(Text(None))
            }
        }
        d.deserialize_any(V)
    }
}

impl Text {
    fn is(&self, s: &str) -> bool {
        self.0.as_deref() == Some(s)
    }
}

/// An object field, or nothing when it holds anything else.
#[derive(Debug)]
struct Lenient<T>(Option<T>);

impl<T> Default for Lenient<T> {
    fn default() -> Self {
        Self(None)
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Lenient<T> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V<T>(PhantomData<T>);
        impl<'de, T: Deserialize<'de>> Visitor<'de> for V<T> {
            type Value = Lenient<T>;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("any value")
            }
            fn visit_map<A: MapAccess<'de>>(self, m: A) -> Result<Lenient<T>, A::Error> {
                T::deserialize(de::value::MapAccessDeserializer::new(m)).map(|t| Lenient(Some(t)))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut s: A) -> Result<Lenient<T>, A::Error> {
                while s.next_element::<IgnoredAny>()?.is_some() {}
                Ok(Lenient(None))
            }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<Lenient<T>, E> {
                Ok(Lenient(None))
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Lenient<T>, E> {
                Ok(Lenient(None))
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Lenient<T>, E> {
                Ok(Lenient(None))
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Lenient<T>, E> {
                Ok(Lenient(None))
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Lenient<T>, E> {
                Ok(Lenient(None))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Lenient<T>, E> {
                Ok(Lenient(None))
            }
        }
        d.deserialize_any(V(PhantomData))
    }
}

/// A message's content parts (a plain string content has none).
#[derive(Debug, Default)]
struct Parts(Vec<Part>);

impl<'de> Deserialize<'de> for Parts {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Parts;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("any value")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut s: A) -> Result<Parts, A::Error> {
                let mut parts = Vec::new();
                while let Some(p) = s.next_element::<Lenient<Part>>()? {
                    parts.extend(p.0);
                }
                Ok(Parts(parts))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Parts, A::Error> {
                while m.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(Parts::default())
            }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<Parts, E> {
                Ok(Parts::default())
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Parts, E> {
                Ok(Parts::default())
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Parts, E> {
                Ok(Parts::default())
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Parts, E> {
                Ok(Parts::default())
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Parts, E> {
                Ok(Parts::default())
            }
            fn visit_unit<E: de::Error>(self) -> Result<Parts, E> {
                Ok(Parts::default())
            }
        }
        d.deserialize_any(V)
    }
}

#[derive(Deserialize)]
struct Header {
    #[serde(default)]
    id: Text,
    #[serde(default)]
    cwd: Text,
}

#[derive(Deserialize)]
struct Entry {
    #[serde(default)]
    message: Lenient<Message>,
}

#[derive(Deserialize)]
struct Message {
    #[serde(default)]
    role: Text,
    #[serde(default)]
    content: Parts,
    #[serde(default)]
    details: Lenient<Places>,
}

#[derive(Debug, Deserialize)]
struct Part {
    #[serde(rename = "type", default)]
    kind: Text,
    #[serde(default)]
    arguments: Lenient<Args>,
}

#[derive(Debug, Deserialize)]
struct Args {
    #[serde(default)]
    cwd: Text,
    #[serde(default)]
    path: Text,
    #[serde(default)]
    command: Text,
}

#[derive(Deserialize)]
struct Places {
    #[serde(default)]
    cwd: Text,
    #[serde(default)]
    path: Text,
}

impl Entry {
    /// Paths its tools worked on (`true`: a file or a folder named like one).
    fn places(self) -> Vec<(String, bool)> {
        let mut out = Vec::new();
        let Some(m) = self.message.0 else { return out };
        if m.role.is("assistant") {
            for p in m.content.0 {
                let Some(a) = p.arguments.0.filter(|_| p.kind.is("toolCall")) else { continue };
                out.extend(a.cwd.0.map(|c| (c, false)));
                out.extend(a.path.0.map(|p| (p, true)));
                if let Some(c) = a.command.0 {
                    out.extend(cd_targets(&c).into_iter().map(|d| (d, false)));
                }
            }
        } else if m.role.is("toolResult")
            && let Some(d) = m.details.0
        {
            out.extend(d.cwd.0.map(|c| (c, false)));
            out.extend(d.path.0.map(|p| (p, true)));
        }
        out
    }
}

// ───────────────────────────── the index ─────────────────────────────

/// omp's session files and what they say, kept up to date by [`Index::refresh`].
#[derive(Debug, Default)]
pub(crate) struct Index {
    /// omp's sessions folder.
    dir: PathBuf,
    files: HashMap<PathBuf, Transcript>,
    /// Files not read to their end (the last refresh ran out of time).
    pub pending: usize,
}

/// The host's index (one omp agent dir per daemon).
static INDEX: LazyLock<Mutex<Index>> = LazyLock::new(Default::default);

/// Refreshes the host's index and answers from it. Blocking: run it on the blocking pool.
pub(crate) fn with_index<R>(dir: &Path, home: Option<&Path>, first: &HashSet<PathBuf>, budget: Duration, f: impl FnOnce(&Index) -> R) -> R {
    let mut index = INDEX.lock().unwrap_or_else(|e| e.into_inner());
    index.refresh(dir, home, first, budget);
    f(&index)
}

/// Session files: top-level ones in each bucket, and the subagent transcripts in their artifacts
/// dirs (a subfolder is followed when a transcript of its name sits beside it).
fn list(dir: &Path) -> Vec<(PathBuf, Metadata)> {
    fn transcripts(dir: &Path, depth: usize, out: &mut Vec<(PathBuf, Metadata)>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        let mut subdirs = Vec::new();
        for e in rd.flatten() {
            let p = e.path();
            let Ok(m) = e.metadata() else { continue };
            if m.is_file() && p.extension().is_some_and(|x| x == "jsonl") {
                out.push((p, m));
            } else if m.is_dir() && depth < DEPTH_MAX {
                subdirs.push(p);
            }
        }
        for d in subdirs {
            let beside = d.file_name().map(|n| d.with_file_name(format!("{}.jsonl", n.to_string_lossy())));
            if beside.is_some_and(|f| f.is_file()) {
                transcripts(&d, depth + 1, out);
            }
        }
    }
    let mut out = Vec::new();
    let Ok(buckets) = std::fs::read_dir(dir) else { return out };
    for b in buckets.flatten() {
        if b.file_type().is_ok_and(|t| t.is_dir()) {
            transcripts(&b.path(), 0, &mut out);
        }
    }
    out
}

/// The top-level session a transcript belongs to: itself, or the session whose artifacts dir holds it.
pub(crate) fn main_of(dir: &Path, file: &Path) -> PathBuf {
    let Ok(rel) = file.strip_prefix(dir) else { return file.to_path_buf() };
    let mut parts = rel.components();
    match (parts.next(), parts.next(), parts.next()) {
        (Some(bucket), Some(first), Some(_)) => {
            let mut main = dir.join(bucket);
            main.push(format!("{}.jsonl", first.as_os_str().to_string_lossy()));
            main
        }
        _ => file.to_path_buf(),
    }
}

/// The order a refresh reads files in: sessions in `first` (top-level files) with their subagents,
/// then the most recently written.
fn read_order<'a>(dir: &Path, first: &HashSet<PathBuf>, mut due: Vec<&'a (PathBuf, Metadata)>) -> Vec<&'a (PathBuf, Metadata)> {
    due.sort_by_cached_key(|(p, m)| (!first.contains(&main_of(dir, p)), Reverse(m.modified().ok()), p.clone()));
    due
}

/// A subagent's name, from its transcript (`PR1494.jsonl`, `Review.Proto.jsonl`); none for advisors.
fn subagent_name(file: &Path) -> Option<String> {
    let stem = file.file_stem()?.to_string_lossy();
    (!stem.starts_with("__")).then(|| stem.into_owned())
}

/// Which main agents worked in a folder, from their own session or a subagent's.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WorkedIn {
    /// Its top-level session file.
    pub main: PathBuf,
    /// The main session's own folder is in it.
    pub home: bool,
    pub seen: Seen,
    /// Its subagents that worked there (transcript names), with when they last did.
    pub subagents: Vec<(String, Millis)>,
}

/// One main agent's session, across its transcripts.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct MainFacts {
    pub id: Option<String>,
    pub cwd: Option<PathBuf>,
    /// Last entry of its session or any subagent's.
    pub last_at: Option<Millis>,
}

impl Index {
    /// Reads what changed in `dir` since the last refresh: new and grown files, `first` (top-level
    /// session files) and their subagents first, then the newest, until `budget` is spent.
    pub(crate) fn refresh(&mut self, dir: &Path, home: Option<&Path>, first: &HashSet<PathBuf>, budget: Duration) {
        if self.dir != dir {
            *self = Index { dir: dir.to_path_buf(), ..Default::default() };
        }
        let listed = list(dir);
        let present: HashSet<&Path> = listed.iter().map(|(p, _)| p.as_path()).collect();
        self.files.retain(|p, _| present.contains(p.as_path()));
        let due = read_order(dir, first, listed.iter().filter(|(p, m)| self.files.get(p).is_none_or(|t| t.changed(m))).collect());
        let deadline = Instant::now() + budget;
        self.pending = 0;
        for (path, m) in due {
            if Instant::now() >= deadline {
                self.pending += 1;
                continue;
            }
            let t = self.files.entry(path.clone()).or_default();
            if !t.continues(path, m) {
                *t = Transcript::default();
            }
            if let Err(e) = t.read(path, m, home) {
                tracing::debug!("cleanup: session {}: {e}", path.display());
            }
        }
    }

    /// For each of `roots` (worktree checkouts), the main agents that worked in it, the busiest first.
    /// A folder belongs to the innermost root it is in; roots match lexically or canonically.
    pub(crate) fn worked_in(&self, roots: &[PathBuf]) -> Vec<Vec<WorkedIn>> {
        let mut lookup: HashMap<PathBuf, usize> = HashMap::new();
        for (i, r) in roots.iter().enumerate() {
            if let Some(n) = folder(&r.to_string_lossy(), false, None) {
                lookup.entry(n).or_insert(i);
            }
            if let Ok(c) = std::fs::canonicalize(r) {
                lookup.entry(c).or_insert(i);
            }
        }
        let root_of = |p: &Path| p.ancestors().find_map(|a| lookup.get(a).copied());
        let mut found: Vec<HashMap<PathBuf, WorkedIn>> = vec![HashMap::new(); roots.len()];
        for (file, t) in &self.files {
            let main = main_of(&self.dir, file);
            let is_main = main == *file;
            let sub = if is_main { None } else { subagent_name(file) };
            let mut note = |i: usize, seen: Seen, home: bool| {
                let w = match found[i].entry(main.clone()) {
                    std::collections::hash_map::Entry::Occupied(e) => {
                        let w = e.into_mut();
                        w.seen.add(seen);
                        w
                    }
                    std::collections::hash_map::Entry::Vacant(e) => e.insert(WorkedIn { main: main.clone(), home: false, seen, subagents: Vec::new() }),
                };
                w.home |= home;
                if let Some(name) = &sub {
                    match w.subagents.iter_mut().find(|(n, _)| n == name) {
                        Some((_, at)) => *at = (*at).max(seen.last),
                        None => w.subagents.push((name.clone(), seen.last)),
                    }
                }
            };
            if let (Some(cwd), Some(first), Some(last)) = (&t.cwd, t.first_at, t.last_at)
                && let Some(i) = root_of(cwd)
            {
                note(i, Seen { first, last, n: 1 }, is_main);
            }
            for (d, s) in &t.dirs {
                if let Some(i) = root_of(d) {
                    note(i, *s, false);
                }
            }
        }
        found
            .into_iter()
            .map(|m| {
                let mut v: Vec<WorkedIn> = m.into_values().collect();
                for w in &mut v {
                    if w.home {
                        // The main agent works there itself: its subagents are part of that.
                        w.subagents.clear();
                    }
                    w.subagents.sort_by_key(|(n, at)| (Reverse(*at), n.clone()));
                }
                v.sort_by_key(|w| (Reverse(w.seen.n), w.seen.first, w.main.clone()));
                v
            })
            .collect()
    }

    /// What the index knows of a main agent's session: its header, and the last entry of it or any
    /// of its subagents.
    pub(crate) fn main_facts(&self) -> HashMap<PathBuf, MainFacts> {
        let mut out: HashMap<PathBuf, MainFacts> = HashMap::new();
        for (file, t) in &self.files {
            let main = main_of(&self.dir, file);
            let f = out.entry(main.clone()).or_default();
            if main == *file {
                f.id.clone_from(&t.id);
                f.cwd.clone_from(&t.cwd);
            }
            if let Some(at) = t.last_at {
                f.last_at = Some(f.last_at.map_or(at, |x| x.max(at)));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    fn ts(ms: Millis) -> String {
        jiff::Timestamp::from_millisecond(ms).unwrap().to_string()
    }

    /// The title slot and header omp 18.14 writes, keys in omp's order.
    fn header(id: &str, cwd: &str, at: Millis, parent: Option<&str>) -> String {
        let parent = parent.map(|p| format!(r#","parentSession":{}"#, json!(p))).unwrap_or_default();
        format!(
            "{{\"type\":\"title\",\"v\":1,\"title\":\"\",\"updatedAt\":\"{t}\",\"pad\":\"    \"}}\n{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"timestamp\":\"{t}\",\"cwd\":{}{parent}}}\n",
            json!(cwd),
            t = ts(at),
        )
    }

    /// A message entry, keys in omp's order (`type`, `id`, `parentId`, `timestamp`, `message`).
    fn entry(at: Millis, message: serde_json::Value) -> String {
        format!("{{\"type\":\"message\",\"id\":\"e1\",\"parentId\":null,\"timestamp\":\"{}\",\"message\":{message}}}\n", ts(at))
    }

    fn tool_call(at: Millis, name: &str, args: serde_json::Value) -> String {
        entry(at, json!({ "role": "assistant", "content": [{ "type": "thinking", "thinking": "x" }, { "type": "toolCall", "id": "t1", "name": name, "arguments": args }] }))
    }

    fn tool_result(at: Millis, details: serde_json::Value) -> String {
        entry(at, json!({ "role": "toolResult", "toolCallId": "t1", "toolName": "bash", "content": [{ "type": "text", "text": "ok" }], "details": details }))
    }

    fn text(at: Millis, role: &str, body: &str) -> String {
        entry(at, json!({ "role": role, "content": body }))
    }

    fn append(p: &Path, s: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::OpenOptions::new().create(true).append(true).open(p).unwrap().write_all(s.as_bytes()).unwrap();
    }

    #[test]
    fn shell_commands_name_the_folders_they_enter() {
        assert_eq!(cd_targets("cd /w/a && make test"), ["/w/a"]);
        assert_eq!(cd_targets("set -e; cd \"/w/with space\" ; ls"), ["/w/with space"]);
        assert_eq!(cd_targets("git -C /w/b status && (cd /w/c; ls) | head"), ["/w/b", "/w/c"]);
        assert_eq!(cd_targets("pushd ~/w/d\nrg 'cd /not/this' ."), ["~/w/d"]);
        assert!(cd_targets("rg -n 'cd /w/x' src && echo cd /w/y").is_empty(), "only a command's own cd counts");
    }

    #[test]
    fn folders_are_absolute_and_normalized() {
        let home = Path::new("/home/u");
        assert_eq!(folder("~/p2/A1c", false, Some(home)), Some(PathBuf::from("/home/u/p2/A1c")));
        assert_eq!(folder("/w/a/src/x.ts:1-40", true, None), Some(PathBuf::from("/w/a/src")));
        assert_eq!(folder("/w/a/./b/../c/", false, None), Some(PathBuf::from("/w/a/c")));
        for no in ["src/x.ts", "local://plan.md", "$HOME/w", "~other/w", ""] {
            assert_eq!(folder(no, false, Some(home)), None, "{no}");
        }
    }

    /// The layout omp 18.14 writes: a top-level session in its worktree, a subagent that works in
    /// another worktree through tool `cwd`s, paths and `cd`, a nested subagent, an advisor, and a
    /// session that only mentions a worktree in text.
    #[test]
    fn transcripts_attribute_subagent_work_to_their_main_agent() {
        let td = tempfile::tempdir().unwrap();
        let dir = td.path().join("sessions");
        let (w1, w2, w3, w4) = ("/wt/main-task", "/wt/p2/A1c", "/wt/p2/A2", "/wt/p2/A3");
        let main = dir.join("-wt-main-task/2026-10-28T12-00-00-000Z_aaa.jsonl");
        let arts = dir.join("-wt-main-task/2026-10-28T12-00-00-000Z_aaa");
        append(&main, &header("aaa", w1, 1_000, None));
        append(&main, &text(2_000, "user", &format!("make worktrees {w2} {w3} {w4}")));
        let sub = arts.join("A1C.jsonl");
        append(&sub, &header("bbb", w1, 3_000, Some(&main.display().to_string())));
        append(&sub, &tool_call(4_000, "bash", json!({ "command": "git log -1", "cwd": w2 })));
        append(&sub, &tool_result(4_100, json!({ "cwd": w2, "exitCode": 0 })));
        append(&sub, &tool_call(5_000, "read", json!({ "path": format!("{w2}/app/x.php:10-20") })));
        let nested = arts.join("A1C/A1C.Check.jsonl");
        append(&nested, &header("ccc", w1, 6_000, Some(&sub.display().to_string())));
        append(&nested, &tool_call(7_000, "bash", json!({ "command": format!("cd {w3} && phpunit") })));
        append(&arts.join("__advisor.default.jsonl"), &format!("{}{}", header("ddd", w1, 3_500, None), tool_call(3_600, "read", json!({ "path": format!("{w3}/README.md") }))));
        // Artifacts that are no transcripts are never read.
        append(&arts.join("local/notes.jsonl"), &tool_call(9_000, "bash", json!({ "cwd": w4 })));
        let other = dir.join("-elsewhere/2026-10-29T08-00-00-000Z_eee.jsonl");
        append(&other, &header("eee", "/elsewhere", 8_000, None));
        append(&other, &tool_call(8_500, "bash", json!({ "command": format!("rg -n 'x' {w4} && git worktree list") })));
        append(&other, &tool_result(8_600, json!({ "cwd": "/elsewhere" })));

        let mut index = Index::default();
        index.refresh(&dir, None, &HashSet::new(), Duration::from_secs(10));
        assert_eq!(index.pending, 0);
        assert_eq!(index.files.len(), 5, "main, two subagents, the advisor, the other session");
        let roots: Vec<PathBuf> = [w1, w2, w3, w4].iter().map(PathBuf::from).collect();
        let found = index.worked_in(&roots);

        let home = &found[0];
        assert_eq!(home.len(), 1);
        assert!(home[0].home && home[0].main == main);
        assert_eq!(home[0].seen.last, 7_000, "its subagents' activity in their own folder counts too");

        let a1c = &found[1];
        assert_eq!(a1c.len(), 1, "only the subagent's tools worked there");
        assert!(!a1c[0].home && a1c[0].main == main);
        assert_eq!((a1c[0].seen.first, a1c[0].seen.last, a1c[0].seen.n), (4_000, 5_000, 3));
        assert_eq!(a1c[0].subagents, [("A1C".to_string(), 5_000)]);

        let a2 = &found[2];
        assert_eq!(a2.len(), 1);
        assert_eq!(a2[0].main, main, "a nested subagent belongs to the same main agent");
        assert_eq!(a2[0].subagents, [("A1C.Check".to_string(), 7_000)], "advisors are not named");
        assert!(found[3].is_empty(), "text mentions and non-transcript files never count");

        let facts = index.main_facts();
        assert_eq!(facts[&main], MainFacts { id: Some("aaa".into()), cwd: Some(PathBuf::from(w1)), last_at: Some(7_000) });
        assert_eq!(facts[&other].last_at, Some(8_600));
    }

    #[test]
    fn refresh_reads_only_what_was_appended_and_rereads_rewrites() {
        let td = tempfile::tempdir().unwrap();
        let dir = td.path().join("sessions");
        let f = dir.join("-wt/2026-10-28T12-00-00-000Z_aaa.jsonl");
        append(&f, &header("aaa", "/wt/a", 1_000, None));
        append(&f, &tool_call(2_000, "bash", json!({ "cwd": "/wt/b" })));
        // omp is still writing the last line.
        append(&f, &tool_call(3_000, "bash", json!({ "cwd": "/wt/c" })).trim_end().to_string().as_str());
        let mut index = Index::default();
        let refresh = |index: &mut Index| index.refresh(&dir, None, &HashSet::new(), Duration::from_secs(10));
        refresh(&mut index);
        let t = &index.files[&f];
        assert_eq!((t.last_at, t.dirs.len()), (Some(2_000), 1), "a partial line waits");
        let read_to = t.offset;
        append(&f, "\n");
        append(&f, &text(4_000, "user", "go on"));
        refresh(&mut index);
        let t = &index.files[&f];
        assert!(t.offset > read_to);
        assert_eq!((t.last_at, t.dirs.len()), (Some(4_000), 2));
        assert!(t.dirs.contains_key(Path::new("/wt/c")));

        // Rewritten (same name, other content): read again from the start.
        let before = t.offset;
        std::fs::remove_file(&f).unwrap();
        append(&f, &header("aaa", "/wt/a", 1_000, None));
        append(&f, &tool_call(5_000, "bash", json!({ "cwd": "/wt/d" })));
        append(&f, &text(6_000, "user", &"x".repeat(before as usize)));
        refresh(&mut index);
        let t = &index.files[&f];
        assert_eq!(t.dirs.keys().collect::<HashSet<_>>(), HashSet::from([&PathBuf::from("/wt/d")]));
        assert_eq!(t.last_at, Some(6_000));

        // Deleted: forgotten.
        std::fs::remove_file(&f).unwrap();
        refresh(&mut index);
        assert!(index.files.is_empty());
    }

    #[test]
    fn a_refresh_reads_board_sessions_first_and_stops_at_its_budget() {
        let td = tempfile::tempdir().unwrap();
        let dir = td.path().join("sessions");
        let a = dir.join("-a/2026-10-28T12-00-00-000Z_aaa.jsonl");
        let b = dir.join("-b/2026-10-28T12-00-00-000Z_bbb.jsonl");
        let b_sub = dir.join("-b/2026-10-28T12-00-00-000Z_bbb/Scout.jsonl");
        append(&a, &header("aaa", "/wt/a", 1_000, None));
        append(&b, &header("bbb", "/wt/b", 1_000, None));
        append(&b_sub, &header("bbc", "/wt/b", 1_000, Some(&b.display().to_string())));
        let ago = |s: u64| std::time::SystemTime::now() - Duration::from_secs(s);
        for (f, t) in [(&b, ago(3600)), (&b_sub, ago(7200))] {
            std::fs::File::options().write(true).open(f).unwrap().set_modified(t).unwrap();
        }
        let listed = list(&dir);
        let order = |first: &HashSet<PathBuf>| read_order(&dir, first, listed.iter().collect()).into_iter().map(|(p, _)| p.clone()).collect::<Vec<_>>();
        assert_eq!(order(&HashSet::new())[0], a, "newest first");
        assert_eq!(order(&HashSet::from([b.clone()])), [b.clone(), b_sub.clone(), a.clone()], "a board agent's session and its subagents first");

        let mut index = Index::default();
        index.refresh(&dir, None, &HashSet::new(), Duration::ZERO);
        assert_eq!(index.pending, 3, "no time: nothing read");
        index.refresh(&dir, None, &HashSet::new(), Duration::from_secs(10));
        assert_eq!((index.pending, index.files.len()), (0, 3));
    }
}
