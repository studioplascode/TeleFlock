//! Row notes (architecture §3.4): what tf-hostd saw of an omp session's transcript rows live that
//! omp's session file does not keep ([`RowNote`]: the TeleFlock device that sent a prompt, a
//! steer, how long the model thought). Rows rebuilt from the file (a resync, a tf-hostd restart)
//! take them back, so they come out exactly as they were built live and clients that cache rows
//! by hash keep theirs.
//!
//! One append-only JSON-lines file per omp session, `<home>/notes/<session id>.jsonl`, a line per
//! note as the replica signals it (`{"id": "<row id>", …}`, [`tf_collab::Signal::Noted`]). Notes
//! only ever gain fields ([`RowNote::merge`]), so lines fold in any order and concurrent appends
//! need no coordination. A thinking row gets one, so the files are not part of `state.json`
//! (rewritten whole every second while anything changes). Bounded like image originals
//! ([`prune`], at daemon start): files untouched for [`MAX_AGE`] go, then the oldest past
//! [`MAX_BYTES`].
//!
//! Blocking I/O throughout: call from the blocking pool.

use std::collections::HashMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tf_collab::replica::RowNote;

/// `<home>/notes`.
pub fn dir(home: &Path) -> PathBuf {
    home.join("notes")
}

/// Notes of sessions not seen live for this long are dropped.
pub const MAX_AGE: Duration = Duration::from_secs(90 * 24 * 60 * 60);
/// Total size the store is kept under (the newest file always stays).
pub const MAX_BYTES: u64 = 64 << 20;

#[derive(Serialize, Deserialize)]
struct Line {
    id: String,
    #[serde(flatten)]
    note: RowNote,
}

/// The notes file of `session_id`; `None` for an id that is not a plain file name.
fn file(dir: &Path, session_id: &str) -> Option<PathBuf> {
    let plain = !session_id.is_empty()
        && session_id.len() <= 128
        && !session_id.starts_with('.')
        && session_id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
    plain.then(|| dir.join(format!("{session_id}.jsonl")))
}

/// Every note taken of `session_id`'s rows, folded per row. Unreadable lines (a torn last write)
/// are skipped; no file means no notes.
pub fn load(dir: &Path, session_id: &str) -> HashMap<String, RowNote> {
    let mut notes: HashMap<String, RowNote> = HashMap::new();
    let Some(text) = file(dir, session_id).and_then(|path| std::fs::read_to_string(path).ok()) else { return notes };
    for line in text.lines().filter_map(|l| serde_json::from_str::<Line>(l).ok()) {
        notes.entry(line.id).or_default().merge(&line.note);
    }
    notes
}

/// Appends `notes` (row id, the row's notes so far) to `session_id`'s file, owner-only, in one
/// write.
pub fn append(dir: &Path, session_id: &str, notes: &[(String, RowNote)]) -> std::io::Result<()> {
    let Some(path) = file(dir, session_id) else {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, format!("not a session id: {session_id:?}")));
    };
    let mut buf = Vec::new();
    for (id, note) in notes {
        serde_json::to_writer(&mut buf, &Line { id: id.clone(), note: note.clone() })?;
        buf.push(b'\n');
    }
    if buf.is_empty() {
        return Ok(());
    }
    crate::paths::create_private_dir(dir)?;
    crate::paths::open_private_append(&path)?.write_all(&buf)
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
            tracing::warn!(path = %path.display(), "prune row notes: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(author: Option<&str>, steering: bool, thought_ms: Option<u64>) -> RowNote {
        RowNote { author: author.map(str::to_owned), steering, thought_ms }
    }

    #[test]
    fn notes_fold_per_row_across_appends() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        let sid = "01a18360-f5d2-776a-a9fb-ebcd5d31fb30";
        assert!(load(&notes, sid).is_empty(), "no file, no notes");
        append(&notes, sid, &[("u1".into(), note(None, true, None)), ("a2.0".into(), note(None, false, Some(600)))]).unwrap();
        // The row's notes so far, signaled again with a new field; a later sender never wins.
        append(&notes, sid, &[("u1".into(), note(Some("pixel"), true, None))]).unwrap();
        append(&notes, sid, &[("u1".into(), note(Some("laptop"), false, None))]).unwrap();
        // A write torn by a crash.
        std::fs::OpenOptions::new().append(true).open(notes.join(format!("{sid}.jsonl"))).unwrap().write_all(b"{\"id\":\"u9\",\"aut").unwrap();
        let got = load(&notes, sid);
        assert_eq!(got.len(), 2, "{got:?}");
        assert_eq!(got["u1"], note(Some("pixel"), true, None));
        assert_eq!(got["a2.0"], note(None, false, Some(600)));
        // Compact lines: unset fields are left out.
        let raw = std::fs::read_to_string(notes.join(format!("{sid}.jsonl"))).unwrap();
        assert!(raw.starts_with("{\"id\":\"u1\",\"steering\":true}\n{\"id\":\"a2.0\",\"thoughtMs\":600}\n"), "{raw}");
        // Other sessions are separate.
        assert!(load(&notes, "other").is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn files_are_owner_only_and_named_by_plain_ids() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        append(&notes, "s1", &[("u1".into(), note(Some("pixel"), false, None))]).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&notes), 0o700);
        assert_eq!(mode(&notes.join("s1.jsonl")), 0o600);
        for bad in ["", "../s1", "a/b", ".hidden", "x\0y"] {
            assert!(append(&notes, bad, &[("u1".into(), RowNote::default())]).is_err(), "{bad:?}");
            assert!(load(&notes, bad).is_empty());
        }
        // Nothing to write creates nothing.
        append(&notes, "s2", &[]).unwrap();
        assert!(!notes.join("s2.jsonl").exists());
    }

    #[test]
    fn prune_drops_old_files() {
        let dir = tempfile::tempdir().unwrap();
        append(dir.path(), "old", &[("u1".into(), note(Some("pixel"), false, None))]).unwrap();
        append(dir.path(), "new", &[("u1".into(), note(Some("pixel"), false, None))]).unwrap();
        let old = dir.path().join("old.jsonl");
        std::fs::File::options().append(true).open(&old).unwrap().set_modified(SystemTime::now() - MAX_AGE - Duration::from_secs(60)).unwrap();
        prune(dir.path());
        assert!(!old.exists() && dir.path().join("new.jsonl").exists());
    }
}
