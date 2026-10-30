//! Saved agent sessions that point to files that are gone. herdr keeps each pane's agent session
//! (`agent_session`, kind `path` for omp) with its layout and, when it restores the pane, types
//! `omp --resume=<file>` into it; for a file that is gone that starts an omp that fails or opens
//! an unrelated new session. Such entries are cleared through herdr's API (`pane.release_agent`),
//! only on panes no agent runs in, only when the file is gone for certain, and only when it has
//! been gone for [`GRACE_MS`]: an agent that just started has no session file until omp's first
//! reply, and herdr's pane list may show no agent for a moment.

use std::collections::HashMap;
use std::path::Path;

use tf_proto::Millis;

/// How long a saved session must have been seen without its file before it is cleared.
pub const GRACE_MS: Millis = 120_000;

/// The file is gone for certain: it is missing, and the nearest folder above it that exists is a
/// readable folder that holds something (an unmounted mount point is an empty folder). Any other
/// error (permissions, I/O, a stale mount) is not certain.
pub fn missing(path: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        _ => return false,
    }
    for dir in path.ancestors().skip(1) {
        match std::fs::metadata(dir) {
            Ok(m) if m.is_dir() => return std::fs::read_dir(dir).is_ok_and(|mut it| it.next().is_some()),
            Ok(_) => return false,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return false,
        }
    }
    false
}

/// One pane's saved session that should go.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stale {
    pub pane: String,
    pub source: String,
    pub agent: String,
    pub file: String,
}

pub fn stale(panes: &[tf_herdr::PaneInfo], gone: impl Fn(&Path) -> bool) -> Vec<Stale> {
    panes
        .iter()
        .filter(|p| p.agent.is_none())
        .filter_map(|p| {
            let s = p.agent_session.as_ref()?;
            let file = s.path()?;
            gone(Path::new(file)).then(|| Stale { pane: p.pane_id.clone(), source: s.source.clone(), agent: s.agent.clone(), file: file.to_string() })
        })
        .collect()
}

/// What the cleanup has seen without a file, and since when.
#[derive(Debug, Default)]
pub struct Pending(HashMap<(String, String), Millis>);

impl Pending {
    /// Takes one look's candidates. Returns those seen without their file for `grace` already, and
    /// whether others are still waiting. A candidate that is not found again is forgotten (its
    /// file is back, or an agent runs in the pane).
    pub fn due(&mut self, found: Vec<Stale>, now: Millis, grace: Millis) -> (Vec<Stale>, bool) {
        let mut next = HashMap::new();
        let mut due = Vec::new();
        let mut waiting = false;
        for s in found {
            let key = (s.pane.clone(), s.file.clone());
            let since = self.0.get(&key).copied().unwrap_or(now);
            if now - since >= grace {
                due.push(s);
            } else {
                next.insert(key, since);
                waiting = true;
            }
        }
        self.0 = next;
        (due, waiting)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_certain_absence_counts() {
        let dir = tempfile::tempdir().unwrap();
        let present = dir.path().join("s.jsonl");
        std::fs::write(&present, "{}").unwrap();
        assert!(!missing(&present));
        assert!(missing(&dir.path().join("gone.jsonl")));
        // Its folders are gone too (a lab directory removed): the nearest folder holds something.
        assert!(missing(&dir.path().join("lab/sessions/x.jsonl")));
        // An empty folder above it may be an unmounted mount point.
        let empty = dir.path().join("mnt");
        std::fs::create_dir(&empty).unwrap();
        assert!(!missing(&empty.join("data/sessions/x.jsonl")));
        assert!(!missing(Path::new("relative.jsonl")));
        // A file where a folder should be.
        assert!(!missing(&present.join("x.jsonl")));
    }

    #[test]
    fn only_panes_without_an_agent() {
        let pane = |id: &str, agent: Option<&str>, file: Option<&str>| -> tf_herdr::PaneInfo {
            serde_json::from_value(serde_json::json!({
                "pane_id": id, "agent": agent,
                "agent_session": file.map(|f| serde_json::json!({"source": "herdr:omp", "agent": "omp", "kind": "path", "value": f})),
            }))
            .unwrap()
        };
        let panes = [
            pane("w1:p1", None, Some("/gone/a.jsonl")),
            pane("w1:p2", Some("omp"), Some("/gone/b.jsonl")),
            pane("w1:p3", None, Some("/here/c.jsonl")),
            pane("w1:p4", None, None),
        ];
        let out = stale(&panes, |p| p.starts_with("/gone"));
        let want = Stale { pane: "w1:p1".into(), source: "herdr:omp".into(), agent: "omp".into(), file: "/gone/a.jsonl".into() };
        assert_eq!(out, vec![want]);
    }

    #[test]
    fn a_missing_file_is_only_cleared_after_the_grace_period() {
        let s = |pane: &str, file: &str| Stale { pane: pane.into(), source: "herdr:omp".into(), agent: "omp".into(), file: file.into() };
        let mut p = Pending::default();
        // A brand-new agent: no file yet.
        let (due, waiting) = p.due(vec![s("w1:p1", "/n/a.jsonl")], 1_000, GRACE_MS);
        assert!(due.is_empty() && waiting);
        // Still missing a bit later: not yet.
        let (due, waiting) = p.due(vec![s("w1:p1", "/n/a.jsonl")], 1_000 + GRACE_MS - 1, GRACE_MS);
        assert!(due.is_empty() && waiting);
        // The file shows up (or the pane got its agent): forgotten, the clock starts over.
        let (due, waiting) = p.due(vec![], 1_000 + GRACE_MS, GRACE_MS);
        assert!(due.is_empty() && !waiting);
        let (due, _) = p.due(vec![s("w1:p1", "/n/a.jsonl")], 1_000 + GRACE_MS + 1, GRACE_MS);
        assert!(due.is_empty());
        // Gone for the whole grace period: cleared once.
        let (due, waiting) = p.due(vec![s("w1:p1", "/n/a.jsonl"), s("w1:p2", "/n/b.jsonl")], 1_001 + 2 * GRACE_MS, GRACE_MS);
        assert_eq!(due, vec![s("w1:p1", "/n/a.jsonl")]);
        assert!(waiting, "the second one was first seen now");
        let (due, waiting) = p.due(vec![s("w1:p2", "/n/b.jsonl")], 1_001 + 3 * GRACE_MS, GRACE_MS);
        assert_eq!(due, vec![s("w1:p2", "/n/b.jsonl")]);
        assert!(!waiting);
    }
}
