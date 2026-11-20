//! What tells a Cleanup scan that a worktree's `git status`, or a repository's list of linked
//! worktrees, may have changed, without asking git (architecture §3.17 "Incremental scans").
//!
//! **A worktree's status** (changed files, unpushed commits, when its changes were last touched,
//! whether a detached HEAD is on no branch) is asked again only when one of these moved since it
//! was taken ([`status_due`]): its HEAD commit or branch (as `git worktree list` gave them), its
//! index, its admin dir's `HEAD`, `ORIG_HEAD` or HEAD reflog (`logs/HEAD`: a commit, checkout,
//! merge, rebase or reset made in it; length and time each), an omp session or a live agent that
//! worked in it since, or [`STATUS_MAX_AGE`] passed (an edit by hand outside any agent changes no
//! git file: a file's content moves no folder's time either). A stamp written within `tree::RACY`
//! of the status, or a status git did not give in time, is asked again next scan. Rescan asks
//! again for every worktree. Removal never relies on any of this: it asks git right before
//! (`remove.rs`).
//!
//! git's own helpers don't apply: hostd runs git with `core.fsmonitor=false` (repository config
//! can name a program, and the built-in monitor is a daemon of its own), and its untracked cache
//! lives in the index, which hostd's git never writes (`GIT_OPTIONAL_LOCKS=0`; a write would also
//! move the stamps above).
//!
//! **A repository's linked worktrees** (`git worktree list`) are asked again only when its
//! `<git dir>/worktrees` folder changed (`git worktree add`, `remove`, `prune` add or delete admin
//! dirs there), an admin dir changed (`HEAD` replaced by a checkout, `locked` added or removed,
//! `gitdir` rewritten by a move) or its HEAD reflog grew (a commit), `packed-refs` changed, a
//! worktree's folder (or its `.git` file) came or went, or after [`STATUS_MAX_AGE`] ([`repo_due`]).

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tf_proto::Millis;

use super::tree::RACY;
use crate::ops::git::WorktreeRecord;

/// A status or listing this old is asked again whatever its stamps say.
pub(crate) const STATUS_MAX_AGE: Duration = Duration::from_secs(3 * 3600);
/// Agent work this close before a status (or after it) may not be in it yet.
const AGENT_SLACK_MS: Millis = 2_000;

/// How long ago `at` was. A time ahead of the clock (the clock was set back) counts as long ago:
/// what it stamped is asked again.
pub(crate) fn age(at: Millis, now: Millis) -> Duration {
    if at > now + 60_000 {
        return Duration::MAX;
    }
    Duration::from_millis(now.saturating_sub(at).max(0) as u64)
}

/// A file's length and modification time (nanoseconds).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct FileStamp {
    pub len: u64,
    pub time: u64,
}

/// `p`'s [`FileStamp`]; `None` when it is missing.
pub(crate) fn file_stamp(p: &Path) -> Option<FileStamp> {
    let m = std::fs::metadata(p).ok()?;
    let time = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos() as u64;
    Some(FileStamp { len: m.len(), time })
}

/// A folder's modification time (nanoseconds); `None` when it is missing.
fn dir_time(p: &Path) -> Option<u64> {
    file_stamp(p).map(|s| s.time)
}

/// `stamp` was written within `tree::RACY` of `at_ms` (or after it): something written right
/// after in the same clock tick would not show.
fn racy(stamp_ns: u64, at_ms: Millis) -> bool {
    (stamp_ns / 1_000_000).saturating_add(RACY.as_millis() as u64) >= at_ms.max(0) as u64
}

/// What a worktree's status was taken on.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Signals {
    /// HEAD commit and branch, as `git worktree list` gave them.
    pub head: Option<String>,
    pub branch: Option<String>,
    pub index: Option<FileStamp>,
    pub head_file: Option<FileStamp>,
    pub orig_head: Option<FileStamp>,
    /// Its HEAD reflog (`logs/HEAD`).
    pub reflog: Option<FileStamp>,
}

impl Signals {
    /// The signals of the linked worktree `rec` now; `admin`: its admin dir (`<git dir>/worktrees/<id>`).
    pub(crate) fn of(rec: &WorktreeRecord, admin: Option<&Path>) -> Signals {
        let at = |name: &str| admin.and_then(|a| file_stamp(&a.join(name)));
        Signals {
            head: rec.head.clone(),
            branch: rec.branch.clone(),
            index: at("index"),
            head_file: at("HEAD"),
            orig_head: at("ORIG_HEAD"),
            reflog: admin.and_then(|a| file_stamp(&a.join("logs").join("HEAD"))),
        }
    }

    fn newest(&self) -> Option<u64> {
        [self.index, self.head_file, self.orig_head, self.reflog].into_iter().flatten().map(|s| s.time).max()
    }
}

/// A worktree's last `git status` (and, for a detached HEAD, reachability), and what it was taken on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StatusMemo {
    pub signals: Signals,
    /// When git answered (wall clock).
    pub at: Millis,
    /// Changed and untracked files; `None`: git did not answer in time.
    #[serde(default)]
    pub dirty: Option<u32>,
    #[serde(default)]
    pub unpushed: Option<u32>,
    /// When its uncommitted changes were last touched.
    #[serde(default)]
    pub files_at: Option<Millis>,
    /// A detached HEAD on a commit no branch, tag or remote branch contains.
    #[serde(default)]
    pub orphan: bool,
    /// When its HEAD last moved (its reflog's newest entry), as it was then.
    #[serde(default)]
    pub moved_at: Option<Millis>,
}

/// Why a worktree's status is asked again, or not ([`status_due`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StatusDue {
    /// Kept: nothing that changes it moved.
    Keep,
    /// Never taken.
    New,
    Refresh,
    /// HEAD, branch, the index or an admin file moved.
    Moved,
    /// A stamp was written as the status was taken.
    Racy,
    /// git did not answer last time.
    Unknown,
    /// An agent worked in it since.
    Agent,
    /// Older than [`STATUS_MAX_AGE`].
    Old,
}

/// Whether a worktree's status is taken again (see the module doc). `agent_at`: the newest work of
/// an omp session or a live agent in it.
pub(crate) fn status_due(memo: Option<&StatusMemo>, now: &Signals, agent_at: Option<Millis>, refresh: bool, now_ms: Millis, max_age: Duration) -> StatusDue {
    let Some(m) = memo else { return StatusDue::New };
    if refresh {
        StatusDue::Refresh
    } else if m.signals != *now {
        StatusDue::Moved
    } else if m.dirty.is_none() {
        StatusDue::Unknown
    } else if m.signals.newest().is_some_and(|t| racy(t, m.at)) {
        StatusDue::Racy
    } else if agent_at.is_some_and(|a| a >= m.at - AGENT_SLACK_MS) {
        StatusDue::Agent
    } else if age(m.at, now_ms) >= max_age {
        StatusDue::Old
    } else {
        StatusDue::Keep
    }
}

/// A repository's linked worktrees as `git worktree list` gave them, and what they were listed on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoMemo {
    pub stamp: RepoStamp,
    /// Linked worktrees (never the main checkout or a bare entry).
    pub records: Vec<WorktreeRecord>,
    /// When git listed them (wall clock).
    pub at: Millis,
    /// Its git dir.
    #[serde(default)]
    pub common: Option<PathBuf>,
}

/// What a repository's listing was taken on ([`RepoStamp::holds`]).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct RepoStamp {
    /// `<git dir>/worktrees`: its time.
    pub worktrees: Option<u64>,
    /// Each admin dir in it: its name, its time, its HEAD reflog.
    pub admins: Vec<(String, Option<u64>, Option<FileStamp>)>,
    pub packed_refs: Option<FileStamp>,
    /// Whether each listed worktree's `.git` file was there.
    pub present: Vec<bool>,
}

fn present(rec: &WorktreeRecord) -> bool {
    std::fs::symlink_metadata(Path::new(&rec.path).join(".git")).is_ok()
}

impl RepoStamp {
    /// The stamp of a listing just taken (lists `<common>/worktrees` once).
    pub(crate) fn take(common: &Path, records: &[WorktreeRecord]) -> RepoStamp {
        let dir = common.join("worktrees");
        let mut admins: Vec<(String, Option<u64>, Option<FileStamp>)> = std::fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().into_string().ok()?;
                let p = e.path();
                Some((name, dir_time(&p), file_stamp(&p.join("logs").join("HEAD"))))
            })
            .collect();
        admins.sort_by(|a, b| a.0.cmp(&b.0));
        RepoStamp {
            worktrees: dir_time(&dir),
            admins,
            packed_refs: file_stamp(&common.join("packed-refs")),
            present: records.iter().map(present).collect(),
        }
    }

    /// Whether it still holds now: `stat`s only, the worktrees folder is not listed (an admin dir
    /// that came or went moved its time).
    pub(crate) fn holds(&self, common: &Path, records: &[WorktreeRecord]) -> bool {
        let dir = common.join("worktrees");
        dir_time(&dir) == self.worktrees
            && file_stamp(&common.join("packed-refs")) == self.packed_refs
            && self.admins.iter().all(|(name, time, reflog)| {
                let p = dir.join(name);
                dir_time(&p) == *time && file_stamp(&p.join("logs").join("HEAD")) == *reflog
            })
            && records.len() == self.present.len()
            && records.iter().zip(&self.present).all(|(r, &was)| present(r) == was)
    }

    fn newest(&self) -> Option<u64> {
        let admins = self.admins.iter().flat_map(|(_, t, r)| [*t, r.map(|r| r.time)]).flatten();
        self.worktrees.into_iter().chain(self.packed_refs.map(|p| p.time)).chain(admins).max()
    }
}

/// Whether a repository is listed again: no listing yet, Rescan, its stamp no longer `holds`, one
/// of its stamps was written as it was listed, or the listing is [`STATUS_MAX_AGE`] old.
pub(crate) fn repo_due(memo: Option<&RepoMemo>, holds: bool, refresh: bool, now: Millis, max_age: Duration) -> bool {
    let Some(m) = memo else { return true };
    refresh || !holds || m.stamp.newest().is_some_and(|t| racy(t, m.at)) || age(m.at, now) >= max_age
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::git::tests::{fixture, sh};
    use crate::util::now_ms;

    const H: Duration = Duration::from_secs(3600);

    fn stamp(len: u64, time_ms: Millis) -> Option<FileStamp> {
        Some(FileStamp { len, time: time_ms as u64 * 1_000_000 })
    }

    fn memo(signals: Signals, at: Millis) -> StatusMemo {
        StatusMemo { signals, at, dirty: Some(0), unpushed: None, files_at: None, orphan: false, moved_at: None }
    }

    /// Kept while nothing that changes a status moved; asked again for each thing that does.
    #[test]
    fn a_status_is_kept_until_something_that_changes_it_moves() {
        let now = 1_800_000_000_000;
        let taken = now - 20 * 60_000;
        let base = Signals {
            head: Some("a".repeat(40)),
            branch: Some("feat".into()),
            index: stamp(900, taken - 3_600_000),
            head_file: stamp(21, taken - 7_200_000),
            orig_head: None,
            reflog: stamp(4000, taken - 3_600_000),
        };
        let m = memo(base.clone(), taken);
        let due = |s: &Signals, agent: Option<Millis>| status_due(Some(&m), s, agent, false, now, 3 * H);
        assert_eq!(due(&base, None), StatusDue::Keep, "nothing moved, 20 min old");
        assert_eq!(due(&base, Some(taken - 60_000)), StatusDue::Keep, "an agent's work before the status is in it");
        assert_eq!(due(&base, Some(taken + 5 * 60_000)), StatusDue::Agent, "an agent worked in it since");
        assert_eq!(status_due(None, &base, None, false, now, 3 * H), StatusDue::New);
        assert_eq!(status_due(Some(&m), &base, None, true, now, 3 * H), StatusDue::Refresh, "Rescan asks again");
        for (what, s) in [
            ("a commit", Signals { head: Some("b".repeat(40)), reflog: stamp(4100, now - 60_000), ..base.clone() }),
            ("another branch", Signals { branch: Some("main".into()), ..base.clone() }),
            ("git add", Signals { index: stamp(950, now - 60_000), ..base.clone() }),
            ("a rebase", Signals { orig_head: stamp(41, now - 60_000), ..base.clone() }),
            ("a reset (reflog only)", Signals { reflog: stamp(4200, now - 60_000), ..base.clone() }),
        ] {
            assert_eq!(due(&s, None), StatusDue::Moved, "{what}");
        }
        assert_eq!(status_due(Some(&m), &base, None, false, taken + 3 * 3_600_000, 3 * H), StatusDue::Old, "the safety net for edits by hand");
        let unknown = StatusMemo { dirty: None, ..m.clone() };
        assert_eq!(status_due(Some(&unknown), &base, None, false, now, 3 * H), StatusDue::Unknown, "git timed out last time");
        let racy = memo(Signals { index: stamp(900, taken - 500), ..base.clone() }, taken);
        assert_eq!(status_due(Some(&racy), &racy.signals, None, false, now, 3 * H), StatusDue::Racy, "the index was written as the status was taken");
        let ahead = memo(base.clone(), now + 3_600_000);
        assert_eq!(status_due(Some(&ahead), &base, None, false, now, 3 * H), StatusDue::Old, "stamped ahead of the clock (set back)");
    }

    /// The signals of real worktrees: a commit, `git add`, a checkout and a reset move them; a
    /// `git status` with optional locks off (hostd's) and an edit by hand don't.
    #[tokio::test]
    async fn real_git_moves_the_signals_and_hostds_status_does_not() {
        let td = fixture();
        let root = td.path();
        sh(root, &["checkout", "-q", "-f", "main"]);
        let wt = root.parent().unwrap().join(format!("{}-sig", root.file_name().unwrap().to_string_lossy()));
        sh(root, &["worktree", "add", "-q", "-b", "sig", wt.to_str().unwrap(), "main"]);
        let rec = || {
            let out = std::process::Command::new("git").args(["worktree", "list", "--porcelain"]).current_dir(root).output().unwrap();
            crate::ops::git::parse_worktree_porcelain(&String::from_utf8_lossy(&out.stdout)).into_iter().find(|r| r.branch.as_deref() == Some("sig") || Path::new(&r.path).ends_with(wt.file_name().unwrap())).unwrap()
        };
        let common = root.join(".git");
        let admin = super::super::scan::admin_dir(&wt, &common).unwrap();
        let signals = || Signals::of(&rec(), Some(&admin));
        let before = signals();
        assert!(before.index.is_some() && before.reflog.is_some() && before.head.is_some());
        let out = crate::ops::git::git(&wt, &["status", "--porcelain=v2"], Duration::from_secs(10)).await.unwrap();
        assert!(out.ok());
        assert_eq!(signals(), before, "hostd's own status writes nothing");
        std::fs::write(wt.join("a.txt"), "edited by hand\n").unwrap();
        assert_eq!(signals(), before, "an edit by hand moves no git file (the agent and age rules catch it)");
        sh(&wt, &["add", "a.txt"]);
        let added = signals();
        assert_ne!(added.index, before.index, "git add writes the index");
        sh(&wt, &["commit", "-q", "-m", "work"]);
        let committed = signals();
        assert!(committed.head != added.head && committed.reflog != added.reflog, "a commit moves HEAD and the reflog");
        sh(&wt, &["reset", "-q", "--hard", "HEAD~1"]);
        assert_ne!(signals().reflog, committed.reflog, "a reset grows the reflog");
    }

    /// A repository's listing holds until a worktree is added or removed, one is locked, a commit
    /// is made in one, or a folder goes; stats only.
    #[test]
    fn a_listing_holds_until_its_admin_dirs_change() {
        let td = fixture();
        let root = td.path();
        sh(root, &["checkout", "-q", "-f", "main"]);
        let common = root.join(".git");
        let name = |n: &str| root.parent().unwrap().join(format!("{}-{n}", root.file_name().unwrap().to_string_lossy()));
        let (a, b) = (name("ra"), name("rb"));
        sh(root, &["worktree", "add", "-q", "-b", "ra", a.to_str().unwrap(), "main"]);
        let list = || {
            let out = std::process::Command::new("git").args(["worktree", "list", "--porcelain"]).current_dir(root).output().unwrap();
            crate::ops::git::parse_worktree_porcelain(&String::from_utf8_lossy(&out.stdout)).into_iter().skip(1).collect::<Vec<_>>()
        };
        // Admin dirs and reflogs from long ago: a change moves their times for sure (not racy).
        let settle = || {
            let old = std::time::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
            let admins: Vec<PathBuf> = std::fs::read_dir(common.join("worktrees")).unwrap().flatten().map(|e| e.path()).collect();
            let reflogs: Vec<PathBuf> = admins.iter().map(|a| a.join("logs").join("HEAD")).filter(|p| p.exists()).collect();
            for d in [common.join("worktrees")].into_iter().chain(admins).chain(reflogs) {
                std::fs::File::open(&d).unwrap().set_modified(old).unwrap();
            }
        };
        settle();
        let records = list();
        let taken = RepoStamp::take(&common, &records);
        assert!(taken.holds(&common, &records));
        let m = RepoMemo { stamp: taken.clone(), records: records.clone(), at: now_ms(), common: Some(common.clone()) };
        assert!(!repo_due(Some(&m), true, false, now_ms(), 3 * H), "nothing changed: kept");
        assert!(repo_due(Some(&m), true, true, now_ms(), 3 * H), "Rescan lists again");
        assert!(repo_due(Some(&m), true, false, now_ms() + 3 * 3_600_000, 3 * H), "after the max age");
        assert!(repo_due(None, true, false, now_ms(), 3 * H));

        sh(root, &["worktree", "add", "-q", "-b", "rb", b.to_str().unwrap(), "main"]);
        assert!(!taken.holds(&common, &records), "a worktree added");
        settle();
        let records = list();
        let taken = RepoStamp::take(&common, &records);
        sh(root, &["worktree", "lock", a.to_str().unwrap()]);
        assert!(!taken.holds(&common, &records), "a worktree locked");
        settle();
        let records = list();
        let taken = RepoStamp::take(&common, &records);
        std::fs::write(a.join("n.txt"), "n").unwrap();
        sh(&a, &["add", "n.txt"]);
        sh(&a, &["commit", "-q", "-m", "n"]);
        assert!(!taken.holds(&common, &records), "a commit in a worktree");
        settle();
        let records = list();
        let taken = RepoStamp::take(&common, &records);
        std::fs::remove_dir_all(&b).unwrap();
        assert!(!taken.holds(&common, &records), "a folder deleted by hand");
    }
}
