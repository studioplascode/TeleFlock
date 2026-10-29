//! omp's session file for bridge-backed sessions (architecture §3.4): one full read per bridge
//! `resync`, then a tail of the bytes omp appends.
//!
//! omp hands every completed entry to the OS synchronously, one `\n`-terminated JSON line each,
//! after a fixed 256-byte title-slot line (`{"type":"title",…}`, rewritten in place) and the
//! `session` header (`session/session-manager.ts`). Full rewrites (migrations, recovery, `/move`)
//! are written to a temp file that is renamed over the path; a relocation leaves the old path
//! behind. The tail tells those apart from appends: a shorter file, another file (unix inode), or
//! other bytes right before the read position mean a rewrite; a file the tail has seen that is
//! gone means it moved, where one omp has not written yet just waits. Either way the caller reads
//! the file again from the start.
//!
//! Blocking I/O: [`read_full`] and [`JournalTail::poll`] (one `stat`, plus the appended bytes)
//! run on the blocking pool, never on the async runtime nor under a session lock
//! ([`crate::feed`] reads, then applies what it read under the lock).

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde_json::Value;

/// Bytes right before the read position that must still be there when the file grows: a file
/// rewritten in place (same inode) or replaced on a platform without inodes fails this check.
const ANCHOR: usize = 64;

/// A file's identity: (device, inode) on unix. `None` elsewhere; the anchor check still applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileId(u64, u64);

#[cfg(unix)]
fn file_id(meta: &std::fs::Metadata) -> Option<FileId> {
    use std::os::unix::fs::MetadataExt;
    Some(FileId(meta.dev(), meta.ino()))
}

#[cfg(not(unix))]
fn file_id(_meta: &std::fs::Metadata) -> Option<FileId> {
    None
}

/// The session file read from its start ([`read_full`]).
#[derive(Debug)]
pub struct FullRead {
    /// The `session` header line (`{"type":"session","id",…}`).
    pub header: Option<Value>,
    /// The title slot's title, when one is set.
    pub title: Option<String>,
    /// Entries in file order, title slot and header excluded: through `last_entry_id` when it was
    /// found, else every complete line.
    pub entries: Vec<Value>,
    /// `last_entry_id` was asked for and found.
    pub found: bool,
    /// Continues right after the last entry taken.
    pub tail: JournalTail,
}

impl FullRead {
    /// The file was there (`false`: omp has not written it yet, or it is gone).
    pub fn exists(&self) -> bool {
        self.tail.seen
    }
}

/// Reads `path` from the start. With `last_entry_id`, stops after that entry (what omp had
/// written when the bridge took its `resync`); the tail then reads the rest as appends. A file
/// that is not there reads as empty ([`FullRead::exists`] says so): omp writes it lazily, at the
/// first assistant message. Line by line: a session file of hundreds of MB is never in memory
/// whole next to the entries parsed from it.
pub fn read_full(path: &Path, last_entry_id: Option<&str>) -> std::io::Result<FullRead> {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FullRead { header: None, title: None, entries: Vec::new(), found: false, tail: JournalTail::new(path) });
        }
        Err(e) => return Err(e),
    };
    let id = file_id(&file.metadata()?);
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let (mut header, mut title, mut entries, mut found) = (None, None, Vec::new(), false);
    // Bytes consumed (complete lines only), and the last ≤ ANCHOR of them.
    let (mut end, mut anchor, mut line) = (0usize, Vec::with_capacity(ANCHOR), Vec::new());
    loop {
        line.clear();
        let n = reader.read_until(b'\n', &mut line)?;
        // The end, or a partial last line (omp is writing it): not consumed.
        if n == 0 || line.last() != Some(&b'\n') {
            break;
        }
        end += n;
        keep_last(&mut anchor, &line);
        let Some(v) = parse_line(&line) else { continue };
        match v.get("type").and_then(Value::as_str) {
            Some("title") => title = v.get("title").and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_owned),
            Some("session") => header = Some(v),
            _ => {
                let last = last_entry_id.is_some_and(|id| v.get("id").and_then(Value::as_str) == Some(id));
                entries.push(v);
                if last {
                    found = true;
                    break;
                }
            }
        }
    }
    let tail = JournalTail { path: path.to_path_buf(), id, seen: true, offset: end as u64, anchor };
    Ok(FullRead { header, title, entries, found, tail })
}

/// Appends `bytes` to `anchor`, keeping its last ≤ [`ANCHOR`] bytes.
fn keep_last(anchor: &mut Vec<u8>, bytes: &[u8]) {
    if bytes.len() >= ANCHOR {
        anchor.clear();
        anchor.extend_from_slice(&bytes[bytes.len() - ANCHOR..]);
    } else {
        anchor.extend_from_slice(bytes);
        let excess = anchor.len().saturating_sub(ANCHOR);
        anchor.drain(..excess);
    }
}

/// What [`JournalTail::poll`] saw.
#[derive(Debug, PartialEq)]
pub enum Poll {
    /// Nothing new (a partial trailing line waits for its newline).
    Idle,
    /// Entries in the complete lines appended since the last poll (title slot and header lines
    /// skipped), and the offset after them.
    Appended { entries: Vec<Value>, offset: u64 },
    /// The file shrank, was replaced or was rewritten in place: read it again from the start.
    Rewritten,
    /// The file the tail has seen is gone (relocated or deleted).
    Missing,
}

/// Reads what omp appends to a session file, complete lines only.
#[derive(Debug, Clone)]
pub struct JournalTail {
    path: PathBuf,
    /// The file the offset belongs to (`None` until a file was seen, or without inodes).
    id: Option<FileId>,
    /// The file was there (read in full, or seen by a poll): once it is gone it moved, where a
    /// file omp has not written yet just waits.
    seen: bool,
    /// Bytes consumed, always at a line boundary.
    offset: u64,
    /// The last bytes before `offset` (≤ [`ANCHOR`]), as read.
    anchor: Vec<u8>,
}

impl JournalTail {
    /// A tail of a file omp has not written yet: everything it will contain is new.
    pub fn new(path: &Path) -> JournalTail {
        JournalTail { path: path.to_path_buf(), id: None, seen: false, offset: 0, anchor: Vec::new() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn offset(&self) -> u64 {
        self.offset
    }

    /// The tail saw its file (it moved if it is gone now).
    pub fn seen(&self) -> bool {
        self.seen
    }

    /// One `stat`; when the file grew, the appended complete lines.
    pub fn poll(&mut self) -> Poll {
        let meta = match std::fs::metadata(&self.path) {
            Ok(m) => m,
            // Not written yet: still nothing to read.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && !self.seen => return Poll::Idle,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Poll::Missing,
            // Transient (permissions, I/O): the next poll tries again.
            Err(_) => return Poll::Idle,
        };
        self.seen = true;
        if self.id.is_some_and(|id| file_id(&meta).is_some_and(|now| now != id)) || meta.len() < self.offset {
            return Poll::Rewritten;
        }
        if meta.len() == self.offset {
            return Poll::Idle;
        }
        match self.read_appended() {
            Ok(poll) => poll,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Poll::Missing,
            Err(_) => Poll::Idle,
        }
    }

    fn read_appended(&mut self) -> std::io::Result<Poll> {
        let mut file = File::open(&self.path)?;
        let id = file_id(&file.metadata()?);
        if self.id.is_some() && id != self.id {
            return Ok(Poll::Rewritten);
        }
        let start = self.offset - self.anchor.len() as u64;
        file.seek(SeekFrom::Start(start))?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf)?;
        if !buf.starts_with(&self.anchor) {
            return Ok(Poll::Rewritten);
        }
        let new = &buf[self.anchor.len()..];
        let Some(last_nl) = new.iter().rposition(|&b| b == b'\n') else { return Ok(Poll::Idle) };
        let complete = &new[..=last_nl];
        let entries = complete
            .split_inclusive(|&b| b == b'\n')
            .filter_map(parse_line)
            .filter(|v| !matches!(v.get("type").and_then(Value::as_str), Some("title" | "session")))
            .collect();
        self.id = self.id.or(id);
        self.offset += complete.len() as u64;
        let consumed = self.anchor.len() + complete.len();
        self.anchor = anchor_before(&buf, consumed);
        Ok(Poll::Appended { entries, offset: self.offset })
    }
}

/// The last ≤ [`ANCHOR`] bytes before `end`.
fn anchor_before(bytes: &[u8], end: usize) -> Vec<u8> {
    bytes[end.saturating_sub(ANCHOR)..end].to_vec()
}

/// One JSON line (`\n` / `\r\n` stripped); `None` for blank or malformed lines, which omp's own
/// loader skips too.
fn parse_line(line: &[u8]) -> Option<Value> {
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    if line.iter().all(u8::is_ascii_whitespace) {
        return None;
    }
    serde_json::from_slice(line).ok()
}

/// The `timestamp` of the session header omp writes to `path`, before omp wrote it: omp names a
/// session file after its header, `<timestamp>_<session id>.jsonl` with the timestamp's `:` and
/// `.` written as `-` (`session-manager.ts` `fileSafeTimestamp`: `2026-10-28T16-38-52-114Z` for
/// `2026-10-28T16:38:52.114Z`). `None` for a file named otherwise (`--session <file>`).
pub fn header_timestamp(path: &Path, session_id: &str) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let safe = name.strip_suffix(".jsonl")?.strip_suffix(session_id)?.strip_suffix('_')?;
    let b = safe.as_bytes();
    let shaped = b.len() == 24
        && b[23] == b'Z'
        && b[10] == b'T'
        && [4, 7, 13, 16, 19].iter().all(|&i| b[i] == b'-')
        && b.iter().enumerate().all(|(i, c)| matches!(i, 4 | 7 | 10 | 13 | 16 | 19 | 23) || c.is_ascii_digit());
    shaped.then(|| format!("{}:{}:{}.{}Z", &safe[..13], &safe[14..16], &safe[17..19], &safe[20..23]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const TITLE: &str = r#"{"type":"title","v":1,"title":"Kites","source":"auto","pad":"    "}"#;
    const HEADER: &str = r#"{"type":"session","version":3,"id":"s1","timestamp":"2026-10-28T10:00:00.000Z","cwd":"/w"}"#;

    fn entry(id: &str) -> String {
        format!(r#"{{"type":"message","id":"{id}","parentId":null,"timestamp":"2026-10-28T10:00:01.000Z","message":{{"role":"user","content":"hi {id}","timestamp":1}}}}"#)
    }

    fn append(path: &Path, text: &str) {
        std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap().write_all(text.as_bytes()).unwrap();
    }

    fn ids(entries: &[Value]) -> Vec<&str> {
        entries.iter().map(|e| e["id"].as_str().unwrap()).collect()
    }

    fn appended(poll: Poll) -> Vec<String> {
        match poll {
            Poll::Appended { entries, .. } => entries.iter().map(|e| e["id"].as_str().unwrap().to_owned()).collect(),
            other => panic!("expected Appended, got {other:?}"),
        }
    }

    #[test]
    fn full_read_stops_at_the_resync_entry_and_the_tail_reads_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        append(&path, &format!("{TITLE}\n{HEADER}\n{}\n{}\n{}\n", entry("e1"), entry("e2"), entry("e3")));
        let r = read_full(&path, Some("e2")).unwrap();
        assert!(r.found);
        assert_eq!(r.title.as_deref(), Some("Kites"));
        assert_eq!(r.header.as_ref().unwrap()["id"], "s1");
        assert_eq!(ids(&r.entries), ["e1", "e2"]);
        let mut tail = r.tail;
        // What omp wrote after the resync arrives as an append, then new appends follow.
        assert_eq!(appended(tail.poll()), ["e3"]);
        assert_eq!(tail.poll(), Poll::Idle);
        append(&path, &format!("{}\n", entry("e4")));
        assert_eq!(appended(tail.poll()), ["e4"]);
        assert_eq!(tail.offset(), std::fs::metadata(&path).unwrap().len());
    }

    #[test]
    fn an_unknown_resync_entry_takes_every_complete_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        append(&path, &format!("{TITLE}\n{HEADER}\n{}\n{}\n{{\"type\":\"mess", entry("e1"), entry("e2")));
        let r = read_full(&path, Some("gone")).unwrap();
        assert!(!r.found);
        assert_eq!(ids(&r.entries), ["e1", "e2"]);
        // The partial last line is not consumed.
        let len = std::fs::metadata(&path).unwrap().len();
        assert!(r.tail.offset() < len);
    }

    #[test]
    fn a_partial_trailing_line_waits_for_its_newline() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        append(&path, &format!("{TITLE}\n{HEADER}\n{}\n", entry("e1")));
        let mut tail = read_full(&path, None).unwrap().tail;
        let line = entry("e2");
        let (head, rest) = line.split_at(line.len() / 2);
        append(&path, head);
        assert_eq!(tail.poll(), Poll::Idle);
        append(&path, &format!("{rest}\n{}", &entry("e3")[..10]));
        assert_eq!(appended(tail.poll()), ["e2"]);
        append(&path, &format!("{}\n", &entry("e3")[10..]));
        assert_eq!(appended(tail.poll()), ["e3"]);
    }

    #[test]
    fn shrink_replace_and_in_place_rewrites_are_rewrites() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let body = format!("{TITLE}\n{HEADER}\n{}\n{}\n", entry("e1"), entry("e2"));
        append(&path, &body);

        // Shrunk (truncated and rewritten shorter).
        let mut tail = read_full(&path, None).unwrap().tail;
        std::fs::write(&path, format!("{TITLE}\n{HEADER}\n{}\n", entry("e1"))).unwrap();
        assert_eq!(tail.poll(), Poll::Rewritten);

        // Replaced by a rename (omp's atomic rewrite): another inode, even when longer.
        std::fs::write(&path, &body).unwrap();
        let mut tail = read_full(&path, None).unwrap().tail;
        let tmp = dir.path().join("s.jsonl.tmp");
        std::fs::write(&tmp, format!("{body}{}\n", entry("e3"))).unwrap();
        std::fs::rename(&tmp, &path).unwrap();
        assert_eq!(tail.poll(), Poll::Rewritten);

        // Rewritten in place with other bytes before the read position, then grown.
        let mut tail = read_full(&path, None).unwrap().tail;
        let mut f = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        let len = f.metadata().unwrap().len();
        f.seek(SeekFrom::Start(len - 4)).unwrap();
        f.write_all(b"XXX\n").unwrap();
        drop(f);
        append(&path, &format!("{}\n", entry("e4")));
        assert_eq!(tail.poll(), Poll::Rewritten);
    }

    #[test]
    fn the_title_slot_rewritten_in_place_is_not_a_rewrite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        append(&path, &format!("{TITLE}\n{HEADER}\n{}\n", entry("e1")));
        let mut tail = read_full(&path, None).unwrap().tail;
        let mut f = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        f.write_all(br#"{"type":"title","v":1,"title":"Birds"#).unwrap();
        drop(f);
        append(&path, &format!("{}\n", entry("e2")));
        assert_eq!(appended(tail.poll()), ["e2"]);
    }

    #[test]
    fn a_moved_file_is_missing_and_a_file_not_written_yet_waits() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        // omp writes the file lazily: an empty read, then everything it writes is new.
        let r = read_full(&path, None).unwrap();
        assert!(r.entries.is_empty() && r.header.is_none() && !r.exists());
        let mut tail = r.tail;
        assert_eq!(tail.poll(), Poll::Idle);
        append(&path, &format!("{TITLE}\n{HEADER}\n{}\n", entry("e1")));
        assert_eq!(appended(tail.poll()), ["e1"]);
        std::fs::rename(&path, dir.path().join("moved.jsonl")).unwrap();
        assert_eq!(tail.poll(), Poll::Missing);
    }

    #[test]
    fn a_file_the_tail_saw_is_missing_once_gone_even_before_its_first_complete_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let mut tail = read_full(&path, None).unwrap().tail;
        assert!(!tail.seen());
        // omp started writing the file: no complete line yet, nothing to read.
        append(&path, &TITLE[..20]);
        assert_eq!(tail.poll(), Poll::Idle);
        assert!(tail.seen());
        // Gone now: it moved (a tail that never saw its file would still wait).
        std::fs::rename(&path, dir.path().join("moved.jsonl")).unwrap();
        assert_eq!(tail.poll(), Poll::Missing);
        // A full read of an existing file says it is there, also its tail.
        let r = read_full(&dir.path().join("moved.jsonl"), None).unwrap();
        assert!(r.exists() && r.tail.seen());
    }

    #[test]
    fn malformed_lines_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        append(&path, &format!("{TITLE}\n{HEADER}\nnot json\n\n{}\n", entry("e1")));
        let r = read_full(&path, None).unwrap();
        assert_eq!(ids(&r.entries), ["e1"]);
    }

    /// The full read (line by line) keeps the anchor a whole-file read would: the ≤ 64 bytes
    /// before its offset, across short lines too, so a change in them is a rewrite.
    #[test]
    fn the_full_reads_anchor_spans_short_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let short = r#"{"id":"s1"}"#;
        let body = format!("{TITLE}\n{HEADER}\n{}\n{short}\n{short}\n{short}\n{short}\n", entry("e1"));
        append(&path, &body);
        let r = read_full(&path, None).unwrap();
        assert_eq!(r.tail.offset(), body.len() as u64);
        assert_eq!(r.tail.anchor, body.as_bytes()[body.len() - ANCHOR..]);
        let mut tail = r.tail;
        let mut f = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        f.seek(SeekFrom::Start((body.len() - short.len() - 1) as u64)).unwrap();
        f.write_all(br#"{"id":"s2"}"#).unwrap();
        drop(f);
        append(&path, &format!("{}\n", entry("e2")));
        assert_eq!(tail.poll(), Poll::Rewritten);
    }

    #[test]
    fn the_header_timestamp_is_in_omps_file_name() {
        let sid = "01a18360-f5d2-776a-a9fb-ebcd5d31fb30";
        let dir = Path::new("/home/u/.omp/agent/sessions/-w");
        let stamp = |name: &str| header_timestamp(&dir.join(name), sid);
        assert_eq!(stamp(&format!("2026-10-28T16-38-52-114Z_{sid}.jsonl")).as_deref(), Some("2026-10-28T16:38:52.114Z"));
        let at = stamp(&format!("2026-10-28T16-38-52-114Z_{sid}.jsonl")).and_then(|t| chrono::DateTime::parse_from_rfc3339(&t).ok());
        assert_eq!(at.map(|t| t.timestamp_millis()), Some(1_793_205_532_114));
        // Another session's file, a forced name, a mangled stamp.
        assert_eq!(stamp("2026-10-28T16-38-52-114Z_other.jsonl"), None);
        assert_eq!(stamp("mine.jsonl"), None);
        assert_eq!(stamp(&format!("2026-10-28T16:38:52.114Z_{sid}.jsonl")), None);
        assert_eq!(stamp(&format!("2026-10-28T16-38-52-11xZ_{sid}.jsonl")), None);
    }
}
