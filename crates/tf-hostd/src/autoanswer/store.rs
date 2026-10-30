//! `<home>/auto-answer.json` (architecture §3.23): per herdr session the host default, the agents'
//! own policies and the running countdowns. 0600, written atomically by each session's worker
//! within a second of a change and when its context closes; read when a session's context starts
//! and at daemon start ([`sessions`]). An unreadable file is set aside (`.bad-<ms>`), never
//! overwritten blindly.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tracing::warn;

use super::core::SessionData;
use crate::paths::{write_atomic, Paths};

pub const FILE: &str = "auto-answer.json";

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct FileData {
    version: u32,
    /// herdr session → its data.
    sessions: BTreeMap<String, SessionData>,
}

/// Serializes every read-modify-write (one daemon per home; tests use several homes).
static LOCK: Mutex<()> = Mutex::new(());

pub fn path(paths: &Paths) -> PathBuf {
    paths.home.join(FILE)
}

/// One session's data; empty when there is none.
pub fn load(path: &Path, session: &str) -> SessionData {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read(path).sessions.remove(session).unwrap_or_default()
}

/// Every session that has data.
pub fn sessions(path: &Path) -> BTreeMap<String, SessionData> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read(path).sessions
}

/// Replaces one session's data (an empty one is dropped from the file).
pub fn save(path: &Path, session: &str, data: &SessionData) -> io::Result<()> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = read(path);
    if *data == SessionData::default() {
        if file.sessions.remove(session).is_none() {
            return Ok(());
        }
    } else {
        file.sessions.insert(session.to_string(), data.clone());
    }
    file.version = 1;
    let bytes = serde_json::to_vec(&file).map_err(io::Error::other)?;
    write_atomic(path, &bytes)
}

fn read(path: &Path) -> FileData {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            let bad = path.with_file_name(format!("{FILE}.bad-{}", crate::util::now_ms()));
            warn!(path = %path.display(), "decide-for-me store unreadable ({e}); moved to {}", bad.display());
            let _ = std::fs::rename(path, &bad);
            FileData::default()
        }),
        Err(_) => FileData::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::autoanswer::core::{Countdown, OwnPolicy};
    use tf_proto::autoanswer::AutoAnswer;

    #[test]
    fn sessions_round_trip_and_stay_private() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE);
        assert_eq!(load(&path, "default"), SessionData::default());
        let p = AutoAnswer { enabled: true, after_secs: 600, only_when_no_app: true };
        let mut a = SessionData { default: Some(p.clone()), ..Default::default() };
        a.agents.insert("t1".into(), OwnPolicy { policy: p.clone(), at: 5 });
        a.pending.insert("t1".into(), Countdown { request_id: "7".into(), running_since: Some(9), in_flight: true, ..Default::default() });
        save(&path, "default", &a).unwrap();
        let b = SessionData { default: Some(AutoAnswer { enabled: false, ..p }), ..Default::default() };
        save(&path, "work", &b).unwrap();
        let back = load(&path, "default");
        assert_eq!(back.pending["t1"].running_since, Some(9));
        assert!(!back.pending["t1"].in_flight, "an attempt in flight is never saved");
        assert_eq!(back.agents, a.agents);
        assert_eq!(sessions(&path).keys().collect::<Vec<_>>(), ["default", "work"]);
        // Emptied sessions leave the file.
        save(&path, "work", &SessionData::default()).unwrap();
        assert_eq!(sessions(&path).len(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn an_unreadable_file_is_set_aside() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE);
        std::fs::write(&path, b"{not json").unwrap();
        assert_eq!(load(&path, "default"), SessionData::default());
        assert!(!path.exists());
        assert!(std::fs::read_dir(dir.path()).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with("auto-answer.json.bad-")));
    }
}
