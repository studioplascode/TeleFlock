//! Reads an omp session's artifacts dir (`…/<ts>_<id>.jsonl` → `…/<ts>_<id>/`) for the spend
//! collab never mirrors: subagent transcripts (the whole tree) and the advisor's
//! `__advisor*.jsonl`, and for the documents subagents present (they notify like the main agent's,
//! `notify/`). Parsing and totals live in [`tf_collab::ArtifactLedger`]; this module only finds
//! the dir and feeds it the bytes appended since the last scan. Blocking I/O: call from
//! `spawn_blocking`.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use tf_collab::{ArtifactCall, ArtifactKind, ArtifactLedger};
use tf_proto::PresentedArtifact;

/// Nested subagents live a few levels down (`<Id>/<Id>.<Child>.jsonl`, …).
const MAX_DEPTH: usize = 6;

/// `<sessions root>/<bucket>/<ts>_<session_id>.jsonl`, the omp session file of `session_id`.
pub fn find_session_file(sessions_root: &Path, session_id: &str) -> Option<PathBuf> {
    let suffix = format!("_{session_id}.jsonl");
    for bucket in std::fs::read_dir(sessions_root).ok()?.flatten() {
        let Ok(files) = std::fs::read_dir(bucket.path()) else { continue };
        for f in files.flatten() {
            if f.file_name().to_str().is_some_and(|n| n.ends_with(&suffix)) {
                return Some(f.path());
            }
        }
    }
    None
}

/// The artifacts dir of a session file (`x.jsonl` → `x/`).
pub fn artifacts_dir(session_file: &Path) -> PathBuf {
    session_file.with_extension("")
}

/// Feeds every transcript's new bytes under `dir` to `ledger`; returns the calls they completed.
/// A transcript that shrank (rewritten) restarts the ledger from scratch.
pub fn scan(dir: &Path, ledger: &mut ArtifactLedger) -> Vec<ArtifactCall> {
    let mut files = Vec::new();
    walk(dir, "", 0, &mut files);
    if files.iter().any(|(rel, _, len)| *len < ledger.offset(rel)) {
        *ledger = ArtifactLedger::default();
    }
    let mut calls = Vec::new();
    for (rel, path, len) in files {
        let from = ledger.offset(&rel);
        if len <= from {
            continue;
        }
        let Ok(mut f) = File::open(&path) else { continue };
        if f.seek(SeekFrom::Start(from)).is_err() {
            continue;
        }
        let mut buf = Vec::with_capacity((len - from) as usize);
        if f.take(len - from).read_to_end(&mut buf).is_ok() {
            calls.extend(ledger.ingest(&rel, &buf));
        }
    }
    calls
}

/// [`scan`], plus the documents the transcripts' `present` calls showed since the previous scan.
/// The first scan of a ledger (a fresh tf-hostd, a rewritten transcript read again) reads history:
/// the documents in it were shown before and are not reported.
pub fn scan_live(dir: &Path, ledger: &mut ArtifactLedger) -> (Vec<ArtifactCall>, Vec<PresentedArtifact>) {
    let calls = scan(dir, ledger);
    let presented = ledger.take_presented();
    ledger.go_live();
    (calls, presented)
}

fn walk(dir: &Path, prefix: &str, depth: usize, out: &mut Vec<(String, PathBuf, u64)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let Some(name) = e.file_name().to_str().map(str::to_owned) else { continue };
        let rel = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            if depth < MAX_DEPTH {
                walk(&e.path(), &rel, depth + 1, out);
            }
        } else if ft.is_file() && ArtifactKind::of(&rel).is_some() {
            if let Ok(md) = e.metadata() {
                out.push((rel, e.path(), md.len()));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const HEADER: &str = "{\"type\":\"session\",\"id\":\"s\"}\n";

    fn assistant(usd: f64) -> String {
        format!("{{\"type\":\"message\",\"message\":{{\"role\":\"assistant\",\"usage\":{{\"input\":1,\"output\":2,\"cost\":{{\"total\":{usd}}}}}}}}}\n")
    }

    #[test]
    fn finds_and_tails_transcripts() {
        let root = tempfile::tempdir().unwrap();
        let bucket = root.path().join("-tmp-w");
        std::fs::create_dir_all(&bucket).unwrap();
        let file = bucket.join("2026-10-21T10-00-00-000Z_01abc.jsonl");
        std::fs::write(&file, HEADER).unwrap();
        assert_eq!(find_session_file(root.path(), "01abc"), Some(file.clone()));
        assert_eq!(find_session_file(root.path(), "nope"), None);

        let dir = artifacts_dir(&file);
        std::fs::create_dir_all(dir.join("Scout")).unwrap();
        std::fs::write(dir.join("__advisor.default.jsonl"), format!("{HEADER}{}", assistant(0.5))).unwrap();
        std::fs::write(dir.join("Scout.jsonl"), format!("{HEADER}{}", assistant(0.25))).unwrap();
        std::fs::write(dir.join("Scout/__advisor.jsonl"), format!("{HEADER}{}", assistant(0.125))).unwrap();
        std::fs::write(dir.join("12.bash.log"), assistant(9.0)).unwrap();

        let mut ledger = ArtifactLedger::default();
        assert_eq!(scan(&dir, &mut ledger).len(), 3);
        assert!((ledger.advisor().usd - 0.5).abs() < 1e-9);
        assert!((ledger.subagents().usd - 0.375).abs() < 1e-9);
        assert!(scan(&dir, &mut ledger).is_empty(), "nothing new");

        // Appends (a partial line first) are read incrementally.
        let mut f = std::fs::OpenOptions::new().append(true).open(dir.join("Scout.jsonl")).unwrap();
        let line = assistant(1.0);
        let (a, b) = line.split_at(20);
        f.write_all(a.as_bytes()).unwrap();
        assert!(scan(&dir, &mut ledger).is_empty());
        f.write_all(b.as_bytes()).unwrap();
        assert_eq!(scan(&dir, &mut ledger).len(), 1);
        assert!((ledger.subagents().usd - 1.375).abs() < 1e-9);

        // A rewritten (shorter) transcript restarts the totals.
        std::fs::write(dir.join("Scout.jsonl"), HEADER).unwrap();
        scan(&dir, &mut ledger);
        assert!((ledger.subagents().usd - 0.125).abs() < 1e-9);
        assert!((ledger.advisor().usd - 0.5).abs() < 1e-9);
    }

    /// A subagent's `present` result is reported once, by the scan that reads it; what a fresh
    /// tf-hostd (or a rewritten transcript) reads first is history and reports nothing.
    #[test]
    fn reports_what_subagents_present_from_the_second_scan_on() {
        let present = |call: &str, version: u32| {
            format!(
                "{}\n",
                serde_json::json!({"type": "message", "id": call, "message": {"role": "toolResult", "toolCallId": call, "toolName": "present", "isError": false,
                    "content": [{"type": "text", "text": "Presented"}],
                    "details": {"title": "Q3 report", "kind": "html", "name": format!("presented/q3-report-v{version}.html"), "slug": "q3-report", "version": version, "size": 10, "assets": 0}}})
            )
        };
        let names = |p: Vec<PresentedArtifact>| p.into_iter().map(|a| a.name).collect::<Vec<_>>();
        let dir = tempfile::tempdir().unwrap();
        let scout = dir.path().join("Scout.jsonl");
        std::fs::write(&scout, format!("{HEADER}{}", present("c1", 1))).unwrap();
        let mut ledger = ArtifactLedger::default();
        assert!(scan_live(dir.path(), &mut ledger).1.is_empty(), "presented before tf-hostd started");
        std::fs::OpenOptions::new().append(true).open(&scout).unwrap().write_all(present("c2", 2).as_bytes()).unwrap();
        assert_eq!(names(scan_live(dir.path(), &mut ledger).1), ["presented/q3-report-v2.html"]);
        assert!(scan_live(dir.path(), &mut ledger).1.is_empty(), "reported once");
        // A subagent started later: its transcript is new from its first line.
        std::fs::create_dir_all(dir.path().join("Scout")).unwrap();
        std::fs::write(dir.path().join("Scout/Scout.Probe.jsonl"), format!("{HEADER}{}", present("c3", 3))).unwrap();
        assert_eq!(names(scan_live(dir.path(), &mut ledger).1), ["presented/q3-report-v3.html"]);
        // A rewritten transcript is read again from the start: history again.
        std::fs::write(&scout, format!("{HEADER}{}", present("c4", 4))).unwrap();
        assert!(scan_live(dir.path(), &mut ledger).1.is_empty());
        // A restarted tf-hostd reads every transcript whole: nothing is new.
        assert!(scan_live(dir.path(), &mut ArtifactLedger::default()).1.is_empty());
    }
}
