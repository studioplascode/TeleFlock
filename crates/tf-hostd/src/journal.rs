//! omp's session file for bridge-backed sessions (architecture §3.4): one full read per bridge
//! `resync`, then a tail of the bytes omp appends.
//!
//! omp hands every completed entry to the OS synchronously, one `\n`-terminated JSON line each,
//! after a fixed 256-byte title-slot line (`{"type":"title",…}`, rewritten in place) and the
//! `session` header (`session/session-manager.ts`). Full rewrites (migrations, recovery, `/move`)
//! are written to a temp file that is renamed over the path; a relocation leaves the old path
//! behind. The tail tells those apart from appends: a shorter file, another file (unix inode), or
//! other bytes right before the read position mean a rewrite; a missing file means it moved.
//! Either way the caller reads the file again from the start.
//!
//! Blocking I/O: [`read_full`] and [`JournalTail::poll`] (one `stat`, plus the appended bytes)
//! run on the blocking pool, never on the async runtime nor under a session lock
//! ([`crate::feed`] reads, then applies what it read under the lock).

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
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

/// Reads `path` from the start. With `last_entry_id`, stops after that entry (what omp had
/// written when the bridge took its `resync`); the tail then reads the rest as appends. A file
/// that does not exist yet (omp writes it lazily, at the first assistant message) reads as empty.
pub fn read_full(path: &Path, last_entry_id: Option<&str>) -> std::io::Result<FullRead> {
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FullRead { header: None, title: None, entries: Vec::new(), found: false, tail: JournalTail::new(path) });
        }
        Err(e) => return Err(e),
    };
    let id = file_id(&file.metadata()?);
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let complete = bytes.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    let (mut header, mut title, mut entries, mut found) = (None, None, Vec::new(), false);
    let mut end = 0;
    for line in bytes[..complete].split_inclusive(|&b| b == b'\n') {
        end += line.len();
        let Some(v) = parse_line(line) else { continue };
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
    let tail = JournalTail { path: path.to_path_buf(), id, offset: end as u64, anchor: anchor_before(&bytes, end) };
    Ok(FullRead { header, title, entries, found, tail })
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
    /// The file is gone (relocated or deleted).
    Missing,
}

/// Reads what omp appends to a session file, complete lines only.
#[derive(Debug, Clone)]
pub struct JournalTail {
    path: PathBuf,
    /// The file the offset belongs to (`None` until a file was seen, or without inodes).
    id: Option<FileId>,
    /// Bytes consumed, always at a line boundary.
    offset: u64,
    /// The last bytes before `offset` (≤ [`ANCHOR`]), as read.
    anchor: Vec<u8>,
}

impl JournalTail {
    /// A tail of a file omp has not written yet: everything it will contain is new.
    pub fn new(path: &Path) -> JournalTail {
        JournalTail { path: path.to_path_buf(), id: None, offset: 0, anchor: Vec::new() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn offset(&self) -> u64 {
        self.offset
    }

    /// One `stat`; when the file grew, the appended complete lines.
    pub fn poll(&mut self) -> Poll {
        let meta = match std::fs::metadata(&self.path) {
            Ok(m) => m,
            // Not written yet: still nothing to read.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && self.offset == 0 && self.id.is_none() => return Poll::Idle,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Poll::Missing,
            // Transient (permissions, I/O): the next poll tries again.
            Err(_) => return Poll::Idle,
        };
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
        assert!(r.entries.is_empty() && r.header.is_none());
        let mut tail = r.tail;
        assert_eq!(tail.poll(), Poll::Idle);
        append(&path, &format!("{TITLE}\n{HEADER}\n{}\n", entry("e1")));
        assert_eq!(appended(tail.poll()), ["e1"]);
        std::fs::rename(&path, dir.path().join("moved.jsonl")).unwrap();
        assert_eq!(tail.poll(), Poll::Missing);
    }

    #[test]
    fn malformed_lines_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        append(&path, &format!("{TITLE}\n{HEADER}\nnot json\n\n{}\n", entry("e1")));
        let r = read_full(&path, None).unwrap();
        assert_eq!(ids(&r.entries), ["e1"]);
    }
}
