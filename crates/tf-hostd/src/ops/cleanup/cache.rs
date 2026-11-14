//! What the Cleanup page's scans learned that is costly to learn again, kept across daemon
//! restarts (every TeleFlock update restarts the daemon) in `<home>/cache/cleanup.json`:
//!
//! * omp's session index (`sessions.rs`): which folders each session file worked in, and how far
//!   each file was read. Reading a big sessions folder from the start takes several scans.
//! * worktree sizes, with when they were measured and the fingerprint of their folders that tells
//!   whether they still hold (`scan.rs` `size_due`): one walk of the whole tree per worktree.
//! * pull requests as gh gave them, with when (`prs::ttl` holds them by state): one `gh pr view`
//!   per worktree.
//!
//! The report itself is not kept: the first scan after a start builds it again from git and the
//! board in seconds, with these filled in, and removal never relies on a report from before the
//! start. Neither are "gh is signed out" and "no GitHub remote": one lookup finds them again, and
//! the user may have just fixed them.
//!
//! **Loaded** once, by the first scan after the daemon starts. A file of another version, or one
//! that can't be read or parsed, is ignored: it is a cache, the scans learn it again. **Saved** in
//! one atomic step (owner-only, `paths::write_atomic`) when a scan ended, at most every
//! [`SAVE_EVERY`]: the first time at once, later by a timer. Sizes and pull requests nothing
//! confirmed or looked up for [`KEEP_FOR_MS`] are left out (their worktree is likely gone).

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tf_proto::{CleanupPr, Millis};
use tokio::sync::OnceCell;

use super::sessions;
use super::size::Fingerprint;
use crate::util::now_ms;

/// The file's format; a file of another one is ignored.
const VERSION: u32 = 1;
/// Saves are at least this far apart (the session index takes megabytes).
const SAVE_EVERY: Duration = Duration::from_secs(5 * 60);
/// Two weeks.
const KEEP_FOR_MS: Millis = 14 * 24 * 3_600_000;

/// `<home>/cache/cleanup.json`.
pub(crate) fn file(home: &Path) -> PathBuf {
    home.join("cache").join("cleanup.json")
}

/// A worktree's size.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SizeMemo {
    pub bytes: u64,
    pub files: u64,
    /// The walk stopped at its budget: at least `bytes`.
    #[serde(default)]
    pub partial: bool,
    pub fingerprint: Fingerprint,
    /// When the walk ran. Wall clock, as every time here: the memo outlives the daemon.
    pub measured_at: Millis,
    /// When it was measured or last found unchanged.
    pub at: Millis,
}

/// A worktree branch's pull request, as gh gave it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrMemo {
    /// When gh answered.
    pub checked_at: Millis,
    pub found: Result<Option<CleanupPr>, String>,
}

/// What a herdr session's scans keep beside their report.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct Facts {
    /// Worktree path → its size.
    pub sizes: HashMap<String, SizeMemo>,
    /// `path \0 branch \0 head` → its pull request.
    pub prs: HashMap<String, PrMemo>,
}

impl Facts {
    /// Without what nothing confirmed or looked up since `now - KEEP_FOR_MS`.
    fn pruned(mut self, now: Millis) -> Facts {
        self.sizes.retain(|_, m| now - m.at < KEEP_FOR_MS);
        self.prs.retain(|_, m| now - m.checked_at < KEEP_FOR_MS);
        self
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct Disk {
    v: u32,
    sessions: Option<sessions::Saved>,
    /// herdr session → what its scans keep.
    scans: BTreeMap<String, Facts>,
}

/// Reads the cache file: `None` when there is none, or it is of another version or unreadable.
fn load(path: &Path) -> Option<Disk> {
    #[derive(Deserialize)]
    struct Version {
        #[serde(default)]
        v: u32,
    }
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            tracing::warn!(file = %path.display(), "the cleanup cache can't be read ({e}); the scans start over");
            return None;
        }
    };
    let parsed = serde_json::from_slice::<Version>(&bytes).and_then(|found| {
        if found.v == VERSION {
            serde_json::from_slice::<Disk>(&bytes).map(Some)
        } else {
            tracing::info!(file = %path.display(), "the cleanup cache is of version {}, not {VERSION}; the scans start over", found.v);
            Ok(None)
        }
    });
    parsed.unwrap_or_else(|e| {
        tracing::warn!(file = %path.display(), "the cleanup cache is damaged ({e}); the scans start over");
        None
    })
}

/// Writes `disk` to `path`; returns its size.
fn write(path: &Path, disk: &Disk) -> std::io::Result<usize> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let bytes = serde_json::to_vec(disk).map_err(std::io::Error::other)?;
    crate::paths::write_atomic(path, &bytes)?;
    Ok(bytes.len())
}

/// The daemon's cache file, once the first scan opened it.
struct Keeper {
    file: PathBuf,
    /// herdr sessions' facts from the file that no scanner took yet: saved again as they were.
    unclaimed: BTreeMap<String, Facts>,
    saved_at: Option<Instant>,
    /// A save is on its way.
    due: bool,
}

static KEEPER: Mutex<Option<Keeper>> = Mutex::new(None);
static OPENED: LazyLock<OnceCell<()>> = LazyLock::new(OnceCell::new);

fn keeper() -> std::sync::MutexGuard<'static, Option<Keeper>> {
    KEEPER.lock().unwrap_or_else(|e| e.into_inner())
}

/// Loads the cache file of the daemon at `home`, once (later calls wait for the first): the
/// session index goes to `sessions`, each herdr session's facts wait for its [`claim`].
pub(crate) async fn open(home: &Path) {
    let file = file(home);
    OPENED
        .get_or_init(|| async move {
            let read = file.clone();
            let scans = tokio::task::spawn_blocking(move || {
                let t = Instant::now();
                let disk = load(&read).unwrap_or_default();
                let files = disk.sessions.as_ref().map_or(0, sessions::Saved::files);
                if let Some(s) = disk.sessions {
                    sessions::restore(s);
                }
                tracing::info!(session_files = files, scans = disk.scans.len(), ms = t.elapsed().as_millis() as u64, "cleanup cache loaded");
                disk.scans
            })
            .await
            .unwrap_or_default();
            *keeper() = Some(Keeper { file, unclaimed: scans, saved_at: None, due: false });
        })
        .await;
}

/// What the cache file kept of herdr session `session`'s scans (taken once).
pub(crate) fn claim(session: &str) -> Option<Facts> {
    keeper().as_mut()?.unclaimed.remove(session)
}

/// A scan ended: saves what the scans know now, or, when the last save was less than
/// [`SAVE_EVERY`] ago, once that long has passed.
pub(crate) fn scanned() {
    let wait = {
        let mut g = keeper();
        let Some(k) = g.as_mut() else { return };
        if k.due {
            return;
        }
        k.due = true;
        k.saved_at.map_or(Duration::ZERO, |t| SAVE_EVERY.saturating_sub(t.elapsed()))
    };
    tokio::spawn(async move {
        tokio::time::sleep(wait).await;
        let _ = tokio::task::spawn_blocking(save).await;
    });
}

/// Writes the cache file: the host's session index and every herdr session's sizes and pull
/// requests (blocking).
fn save() {
    let (file, mut scans) = {
        let mut g = keeper();
        let Some(k) = g.as_mut() else { return };
        k.due = false;
        k.saved_at = Some(Instant::now());
        (k.file.clone(), k.unclaimed.clone())
    };
    scans.extend(super::scan::facts());
    let now = now_ms();
    let disk = Disk {
        v: VERSION,
        sessions: sessions::saved(),
        scans: scans.into_iter().map(|(s, f)| (s, f.pruned(now))).collect(),
    };
    let t = Instant::now();
    match write(&file, &disk) {
        Ok(bytes) => tracing::debug!(file = %file.display(), bytes, ms = t.elapsed().as_millis() as u64, "cleanup cache saved"),
        Err(e) => tracing::warn!(file = %file.display(), "saving the cleanup cache: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn pr(state: &str) -> CleanupPr {
        CleanupPr {
            number: 7,
            url: "https://github.com/o/r/pull/7".into(),
            title: "Fix".into(),
            state: state.into(),
            draft: false,
            closed_at: Some(5),
        }
    }

    fn session_file(path: &Path, cwd: &str, worked_in: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let lines = [
            format!(r#"{{"type":"session","version":3,"id":"s1","timestamp":"2026-11-01T10:00:00.000Z","cwd":"{cwd}"}}"#),
            format!(
                r#"{{"type":"message","id":"e1","parentId":null,"timestamp":"2026-11-01T10:05:00.000Z","message":{{"role":"assistant","content":[{{"type":"toolCall","id":"t1","name":"bash","arguments":{{"command":"ls","cwd":"{worked_in}"}}}}]}}}}"#
            ),
        ];
        std::fs::write(path, lines.join("\n") + "\n").unwrap();
    }

    /// A daemon restart keeps the session index, the sizes and the pull requests: what was saved
    /// is what comes back, and the index needs no file read again.
    #[test]
    fn the_cache_file_round_trips() {
        let td = tempfile::tempdir().unwrap();
        let dir = td.path().join("sessions");
        session_file(&dir.join("-wt-a/2026-11-01T10-00-00-000Z_s1.jsonl"), "/wt/a", "/wt/b/src");
        let mut index = sessions::Index::default();
        index.refresh(&dir, None, &HashSet::new(), Duration::from_secs(10));
        let roots = [PathBuf::from("/wt/a"), PathBuf::from("/wt/b")];
        let worked = index.worked_in(&roots);
        assert!(worked.iter().all(|w| w.len() == 1), "{worked:?}");

        let fp = Fingerprint { dirs: 3, hash: u64::MAX - 1 };
        let size = SizeMemo { bytes: 1 << 40, files: 9, partial: false, fingerprint: fp, measured_at: 1_000, at: 2_000 };
        let facts = Facts {
            sizes: [("/wt/b".to_string(), size)].into(),
            prs: [
                ("/wt/b\0feat\0abc1234".to_string(), PrMemo { checked_at: 3_000, found: Ok(Some(pr("MERGED"))) }),
                ("/wt/a\0main\0def5678".to_string(), PrMemo { checked_at: 3_000, found: Ok(None) }),
                ("/wt/c\0x\0".to_string(), PrMemo { checked_at: 3_000, found: Err("gh timed out".into()) }),
            ]
            .into(),
        };
        let file = file(&td.path().join("home"));
        let disk = Disk { v: VERSION, sessions: Some(index.to_saved()), scans: [("default".to_string(), facts.clone())].into() };
        write(&file, &disk).unwrap();

        let back = load(&file).expect("loads");
        assert_eq!(back.scans["default"], facts);
        let mut restored = sessions::Index::from_saved(back.sessions.unwrap());
        assert_eq!(restored.worked_in(&roots), worked);
        assert_eq!(restored.main_facts(), index.main_facts());
        restored.refresh(&dir, None, &HashSet::new(), Duration::ZERO);
        assert_eq!(restored.pending, 0, "every file is known as it was read: nothing to read again");
        assert_eq!(restored.worked_in(&roots), worked);
    }

    /// The daemon's way through it: the first scan opens the file (the session index becomes the
    /// host's), each scanner takes its herdr session's facts once, and a scan's end saves at once
    /// the first time (later ones wait for SAVE_EVERY): a scanner's facts as they are now, and
    /// those of a session that did not scan as the file had them. The only test that opens it
    /// (once per process).
    #[tokio::test]
    async fn a_daemon_opens_takes_and_saves_its_cache_file() {
        let td = tempfile::tempdir().unwrap();
        let home = td.path().join("home");
        let path = file(&home);
        let dir = td.path().join("sessions");
        session_file(&dir.join("-wt-a/2026-11-01T10-00-00-000Z_s1.jsonl"), "/wt/a", "/wt/b/src");
        let mut index = sessions::Index::default();
        index.refresh(&dir, None, &HashSet::new(), Duration::from_secs(10));
        let now = now_ms();
        let facts = |p: &str, bytes: u64| Facts {
            sizes: [(p.to_string(), SizeMemo { bytes, files: 1, partial: false, fingerprint: Fingerprint::default(), measured_at: now, at: now })].into(),
            prs: HashMap::new(),
        };
        let scans = [("default".to_string(), facts("/wt/a", 1)), ("other".to_string(), facts("/wt/o", 2))].into();
        write(&path, &Disk { v: VERSION, sessions: Some(index.to_saved()), scans }).unwrap();

        open(&home).await;
        assert_eq!(sessions::saved().map(|s| s.files()), Some(1), "the session index is the host's");
        assert_eq!(claim("default"), Some(facts("/wt/a", 1)));
        assert_eq!(claim("default"), None, "taken once");

        super::super::scan::hold("default", facts("/wt/a", 5));
        scanned();
        let deadline = Instant::now() + Duration::from_secs(10);
        let back = loop {
            let back = load(&path).unwrap();
            if back.scans.get("default").is_some_and(|f| f.sizes["/wt/a"].bytes == 5) || Instant::now() > deadline {
                break back;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert_eq!(back.scans["default"], facts("/wt/a", 5), "the scanner's facts, saved at once");
        assert_eq!(back.scans["other"], facts("/wt/o", 2), "a session that did not scan keeps the file's");
        assert_eq!(back.sessions.map(|s| s.files()), Some(1));
        scanned();
        let k = keeper();
        let k = k.as_ref().unwrap();
        assert!(k.due && k.saved_at.is_some_and(|t| t.elapsed() < SAVE_EVERY), "the next save waits for SAVE_EVERY");
    }

    #[test]
    fn other_versions_and_damaged_files_are_ignored() {
        let td = tempfile::tempdir().unwrap();
        let file = file(td.path());
        assert!(load(&file).is_none(), "no file yet");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        for bad in [r#"{"v":2,"sessions":{"dir":"/s","folders":[],"files":[]},"scans":{}}"#, r#"{"scans":{}}"#, r#"{"v":1,"scans":{"default":{"sizes":{"/wt":{"bytes":"#, "\0\0"] {
            std::fs::write(&file, bad).unwrap();
            assert!(load(&file).is_none(), "{bad}");
        }
        write(&file, &Disk { v: VERSION, ..Default::default() }).unwrap();
        assert!(load(&file).is_some());
    }

    #[test]
    fn what_nothing_used_for_two_weeks_is_dropped() {
        let fp = Fingerprint::default();
        let memo = |at: Millis| SizeMemo { bytes: 1, files: 1, partial: false, fingerprint: fp, measured_at: at, at };
        let now = 100 * 86_400_000;
        let facts = Facts {
            sizes: [("/wt/gone".to_string(), memo(now - 15 * 86_400_000)), ("/wt/here".to_string(), memo(now - 86_400_000))].into(),
            prs: [("/wt/gone\0b\0h".to_string(), PrMemo { checked_at: now - 20 * 86_400_000, found: Ok(None) })].into(),
        }
        .pruned(now);
        assert_eq!(facts.sizes.keys().collect::<Vec<_>>(), ["/wt/here"]);
        assert!(facts.prs.is_empty());
    }

    /// Bench: what keeping a real session index across a restart costs (its saved form, the JSON
    /// file, loading it, the first refresh after), reading `TF_BENCH_SESSIONS` only; the file goes
    /// to a temp dir. Release build:
    /// `TF_BENCH_SESSIONS=$HOME/.omp/agent/sessions cargo test --release -p tf-hostd --lib cache_cost -- --ignored --nocapture`
    #[test]
    #[ignore = "bench"]
    fn cache_cost() {
        let Some(dir) = std::env::var_os("TF_BENCH_SESSIONS").map(PathBuf::from) else {
            eprintln!("TF_BENCH_SESSIONS is not set");
            return;
        };
        let home = crate::paths::home_dir();
        let ms = |t: Instant| t.elapsed().as_secs_f64() * 1e3;
        let mut index = sessions::Index::default();
        let t = Instant::now();
        index.refresh(&dir, Some(&home), &HashSet::new(), Duration::from_secs(3600));
        println!("cold refresh (no budget): {:.0} ms", ms(t));
        let td = tempfile::tempdir().unwrap();
        let path = file(td.path());
        let t = Instant::now();
        let disk = Disk { v: VERSION, sessions: Some(index.to_saved()), scans: BTreeMap::new() };
        let saved = ms(t);
        let t = Instant::now();
        let bytes = write(&path, &disk).unwrap();
        let wrote = ms(t);
        let t = Instant::now();
        let back = load(&path).unwrap();
        let loaded = ms(t);
        let t = Instant::now();
        let mut restored = sessions::Index::from_saved(back.sessions.unwrap());
        let rebuilt = ms(t);
        let t = Instant::now();
        restored.refresh(&dir, Some(&home), &HashSet::new(), Duration::from_secs(3600));
        println!(
            "saved form {saved:.0} ms, file {:.1} MB written in {wrote:.0} ms, loaded in {loaded:.0} ms, index rebuilt in {rebuilt:.0} ms; first refresh after: {:.0} ms ({} files left to read)",
            bytes as f64 / 1e6,
            ms(t),
            restored.pending
        );
    }
}
