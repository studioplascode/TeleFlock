//! Live rows (architecture §3.4): transcript rows hostd showed of an omp session that omp's session
//! file never gets ([`LiveRow`]: warning and error notices, a turn's terminal error omp does not
//! persist, such as a provider refusal), each with the row it followed. Handed back to the replica
//! before its next snapshot, so a transcript rebuilt from the file (a resync, a tf-hostd restart)
//! shows them where they were.
//!
//! One append-only JSON-lines file per omp session, `<home>/rows/<session id>.jsonl`, a line per
//! kept row as the replica signals it ([`tf_collab::Signal::RowKept`]). A row kept again (same id)
//! replaces the earlier line's when loading; the newest [`MAX_LIVE_ROWS`] stay. Rows carry what
//! TeleFlock showed: never a refused reply's text, nor the fallback credit omp keeps for itself.
//! Bounded like row notes ([`prune`], at daemon start): files untouched for [`MAX_AGE`] go, then the
//! oldest past [`MAX_BYTES`].
//!
//! Blocking I/O throughout: call from the blocking pool.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use tf_collab::replica::{LiveRow, MAX_LIVE_ROWS};

/// `<home>/rows`.
pub fn dir(home: &Path) -> PathBuf {
    home.join("rows")
}

/// Rows of sessions not seen live for this long are dropped.
pub const MAX_AGE: Duration = Duration::from_secs(90 * 24 * 60 * 60);
/// Total size the store is kept under (the newest file always stays).
pub const MAX_BYTES: u64 = 16 << 20;

/// The rows file of `session_id`; `None` for an id that is not a plain file name.
fn file(dir: &Path, session_id: &str) -> Option<PathBuf> {
    let plain = !session_id.is_empty()
        && session_id.len() <= 128
        && !session_id.starts_with('.')
        && session_id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
    plain.then(|| dir.join(format!("{session_id}.jsonl")))
}

/// The rows kept of `session_id`, oldest first (a row kept again takes its latest place). Unreadable
/// lines (a torn last write) are skipped; no file means no rows.
pub fn load(dir: &Path, session_id: &str) -> Vec<LiveRow> {
    let Some(text) = file(dir, session_id).and_then(|path| std::fs::read_to_string(path).ok()) else { return Vec::new() };
    kept(&text)
}

fn kept(text: &str) -> Vec<LiveRow> {
    let mut rows: Vec<LiveRow> = Vec::new();
    for row in text.lines().filter_map(|l| serde_json::from_str::<LiveRow>(l).ok()) {
        rows.retain(|r| r.item.id() != row.item.id());
        rows.push(row);
    }
    let over = rows.len().saturating_sub(MAX_LIVE_ROWS);
    rows.drain(..over);
    rows
}

/// A file is rewritten down to the rows [`load`] keeps once it holds more than this many lines.
const COMPACT_ABOVE_LINES: usize = 4 * MAX_LIVE_ROWS;
/// A line is never shorter than this, so a smaller file cannot hold [`COMPACT_ABOVE_LINES`].
const MIN_LINE_BYTES: u64 = 32;

/// Appends `rows` to `session_id`'s file, owner-only, in one write. A file whose last write was
/// torn (no final newline) gets a newline first, so the torn line costs only itself, not the first
/// new row. A file that grew past [`COMPACT_ABOVE_LINES`] lines is rewritten to the rows [`load`]
/// keeps (a failure to do so leaves the file as it is).
pub fn append(dir: &Path, session_id: &str, rows: &[LiveRow]) -> std::io::Result<()> {
    let Some(path) = file(dir, session_id) else {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, format!("not a session id: {session_id:?}")));
    };
    let mut buf = Vec::new();
    for row in rows {
        serde_json::to_writer(&mut buf, row)?;
        buf.push(b'\n');
    }
    if buf.is_empty() {
        return Ok(());
    }
    crate::paths::create_private_dir(dir)?;
    let mut out = crate::paths::open_private_append(&path)?;
    if !ends_in_newline(&path) {
        buf.insert(0, b'\n');
    }
    out.write_all(&buf)?;
    drop(out);
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > COMPACT_ABOVE_LINES as u64 * MIN_LINE_BYTES)
        && let Ok(text) = std::fs::read_to_string(&path)
        && text.lines().count() > COMPACT_ABOVE_LINES
    {
        let mut compact = Vec::new();
        for row in kept(&text) {
            serde_json::to_writer(&mut compact, &row)?;
            compact.push(b'\n');
        }
        if let Err(e) = crate::paths::write_atomic(&path, &compact) {
            tracing::warn!(path = %path.display(), "compact live rows: {e}");
        }
    }
    Ok(())
}

/// The file is empty or ends in `\n` (an unreadable file counts as ending well: nothing to guard).
fn ends_in_newline(path: &Path) -> bool {
    use std::io::{Read as _, Seek as _, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else { return true };
    let Ok(len) = f.seek(SeekFrom::End(0)) else { return true };
    if len == 0 {
        return true;
    }
    let mut last = [0u8; 1];
    let read = f.seek(SeekFrom::End(-1)).and_then(|_| f.read_exact(&mut last));
    read.is_err() || last[0] == b'\n'
}

/// Drops the files [`crate::originals::prune_plan`] picks for [`MAX_AGE`] and [`MAX_BYTES`].
/// Errors are logged and skipped.
pub fn prune(dir: &Path) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    let entries = read
        .flatten()
        .filter_map(|e| {
            let meta = e.metadata().ok().filter(std::fs::Metadata::is_file)?;
            Some((e.path(), meta.modified().ok()?, meta.len()))
        })
        .collect();
    for path in crate::originals::prune_plan(entries, SystemTime::now(), MAX_AGE, MAX_BYTES) {
        if let Err(e) = std::fs::remove_file(&path) {
            tracing::warn!(path = %path.display(), "prune live rows: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use tf_proto::{AssistantItem, NoticeItem, NoticeLevel, Refusal, TranscriptItem};

    use super::*;

    fn notice(id: &str, text: &str) -> LiveRow {
        let item = TranscriptItem::Notice(NoticeItem { id: id.into(), at: 5, level: NoticeLevel::Warn, text: text.into(), source: Some("extension".into()) });
        LiveRow { after: Some("u1".into()), item }
    }

    fn refusal(id: &str) -> LiveRow {
        let item = TranscriptItem::Assistant(AssistantItem {
            id: id.into(),
            at: 9,
            text: String::new(),
            streaming: false,
            model: Some("claude-opus-5".into()),
            usage: None,
            stop_reason: Some("error".into()),
            error: Some("Refusal (cyber): exploit code".into()),
            error_status: None,
            refusal: Some(Refusal { kind: "refusal".into(), category: Some("cyber".into()), explanation: Some("exploit code".into()) }),
        });
        LiveRow { after: Some("u8".into()), item }
    }

    #[test]
    fn rows_come_back_in_order_across_appends() {
        let dir = tempfile::tempdir().unwrap();
        let rows = dir.path().join("rows");
        let sid = "01a18769-c0ed-73ef-b9e0-c7c8190764dd";
        assert!(load(&rows, sid).is_empty(), "no file, no rows");
        append(&rows, sid, &[notice("n1", "MCP server failed"), refusal("a9.e")]).unwrap();
        // The same row kept again (a standing notice after a restart) takes its latest place.
        append(&rows, sid, &[notice("n2", "Fallback: a → b"), notice("n1", "MCP server failed")]).unwrap();
        // A write torn by a crash.
        std::fs::OpenOptions::new().append(true).open(rows.join(format!("{sid}.jsonl"))).unwrap().write_all(b"{\"after\":\"u1\",\"ite").unwrap();
        let got = load(&rows, sid);
        assert_eq!(got.iter().map(|r| r.item.id()).collect::<Vec<_>>(), ["a9.e", "n2", "n1"]);
        assert_eq!(got[0], refusal("a9.e"));
        assert!(load(&rows, "other").is_empty(), "other sessions are separate");
    }

    #[test]
    fn the_newest_rows_stay() {
        let dir = tempfile::tempdir().unwrap();
        let many: Vec<LiveRow> = (0..MAX_LIVE_ROWS + 20).map(|i| notice(&format!("n{i}"), "w")).collect();
        append(dir.path(), "s1", &many).unwrap();
        let got = load(dir.path(), "s1");
        assert_eq!(got.len(), MAX_LIVE_ROWS);
        assert_eq!(got[0].item.id(), "n20");
    }

    #[test]
    fn a_torn_last_write_costs_only_itself() {
        let dir = tempfile::tempdir().unwrap();
        append(dir.path(), "s1", &[notice("n1", "w")]).unwrap();
        let path = dir.path().join("s1.jsonl");
        std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(b"{\"after\":\"u1\",\"ite").unwrap();
        append(dir.path(), "s1", &[notice("n2", "w")]).unwrap();
        assert_eq!(load(dir.path(), "s1").iter().map(|r| r.item.id()).collect::<Vec<_>>(), ["n1", "n2"], "the row after the torn line is kept");
    }

    #[test]
    fn a_file_far_past_the_cap_is_compacted_to_what_load_keeps() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s1.jsonl");
        // The same standing notice kept again and again, then one more row to pass the limit.
        for _ in 0..COMPACT_ABOVE_LINES {
            append(dir.path(), "s1", &[notice("standing", "MCP server failed")]).unwrap();
        }
        let lines = |p: &Path| std::fs::read_to_string(p).unwrap().lines().count();
        assert_eq!(lines(&path), COMPACT_ABOVE_LINES, "at the limit: not yet rewritten");
        append(dir.path(), "s1", &[notice("n1", "w")]).unwrap();
        assert_eq!(lines(&path), 2, "past it: only the rows load keeps remain");
        assert_eq!(load(dir.path(), "s1").iter().map(|r| r.item.id()).collect::<Vec<_>>(), ["standing", "n1"]);
        append(dir.path(), "s1", &[notice("n2", "w")]).unwrap();
        assert_eq!(load(dir.path(), "s1").len(), 3);
    }

    #[cfg(unix)]
    #[test]
    fn files_are_owner_only_and_named_by_plain_ids() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let rows = dir.path().join("rows");
        append(&rows, "s1", &[notice("n1", "w")]).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&rows), 0o700);
        assert_eq!(mode(&rows.join("s1.jsonl")), 0o600);
        for bad in ["", "../s1", "a/b", ".hidden", "x\0y"] {
            assert!(append(&rows, bad, &[notice("n1", "w")]).is_err(), "{bad:?}");
            assert!(load(&rows, bad).is_empty());
        }
        append(&rows, "s2", &[]).unwrap();
        assert!(!rows.join("s2.jsonl").exists(), "nothing to write creates nothing");
    }

    #[test]
    fn prune_drops_old_files() {
        let dir = tempfile::tempdir().unwrap();
        append(dir.path(), "old", &[notice("n1", "w")]).unwrap();
        append(dir.path(), "new", &[notice("n1", "w")]).unwrap();
        let old = dir.path().join("old.jsonl");
        std::fs::File::options().append(true).open(&old).unwrap().set_modified(SystemTime::now() - MAX_AGE - Duration::from_secs(60)).unwrap();
        prune(dir.path());
        assert!(!old.exists() && dir.path().join("new.jsonl").exists());
    }
}
