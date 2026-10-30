//! The Cleanup page (worktree and storage janitor), `cleanup.*` host methods.
//!
//! * `cleanup.worktrees`: every linked git worktree of the repositories TeleFlock knows on the host
//!   (its herdr workspaces, agents on the board, parked agents, automations), with what deciding
//!   whether to delete it takes: pull request, age, uncommitted changes, size, last agent.
//! * `cleanup.remove`: removes one of them, after checking again that no agent works in it, it is
//!   not locked and a detached HEAD holds no commit only it knows (`force` for those and for
//!   uncommitted changes). The branch is always kept.
//! * `cleanup.storage` / `cleanup.storageRun`: omp's own storage maintenance (`omp gc`), limited to
//!   what is not a session: unreferenced blobs, database WAL files, filesystem compression of idle
//!   session files. Sessions are never archived or deleted here.

use crate::Millis;
use crate::model::HerdrState;

wire_struct! {
    /// `cleanup.worktrees`.
    pub struct CleanupScanParams {
        /// Read sizes and pull requests again (otherwise they are cached for a while).
        #[serde(default)]
        pub refresh: bool,
        /// Wait up to this long (ms, ≤ 20 000) for a running scan to finish before answering.
        pub wait_ms: Option<u32>,
    }
}

wire_struct! {
    pub struct CleanupReport {
        /// When the last scan finished (absent before the first one ended).
        pub scanned_at: Option<Millis>,
        /// A scan runs now: sizes and pull requests may still be filling in.
        pub scanning: bool,
        /// Repositories with at least one linked worktree (or an error), by name.
        pub repos: Vec<CleanupRepo>,
        /// Why no pull request can be looked up on this host (gh missing or signed out).
        pub gh_error: Option<String>,
    }
}

wire_struct! {
    pub struct CleanupRepo {
        /// Main worktree root.
        pub root: String,
        pub name: String,
        /// Why its worktrees could not be listed.
        pub error: Option<String>,
        /// Why its pull requests are unknown (no GitHub remote, gh failed).
        pub pr_error: Option<String>,
        /// Linked worktrees (never the main checkout), oldest activity first.
        pub worktrees: Vec<CleanupWorktree>,
    }
}

wire_struct! {
    /// One linked worktree.
    pub struct CleanupWorktree {
        pub path: String,
        pub branch: Option<String>,
        /// Short HEAD commit.
        pub head: Option<String>,
        /// The checkout folder is gone (git lists it as prunable): removing drops git's record of it.
        pub missing: bool,
        /// `git worktree lock`ed, with its reason (possibly empty): never removed here.
        pub locked: Option<String>,
        /// Changed and untracked files; absent when git didn't answer in time.
        pub dirty: Option<u32>,
        /// Commits ahead of its upstream branch (absent without an upstream).
        pub unpushed: Option<u32>,
        /// Detached HEAD on a commit no branch, tag or remote branch contains: removing the
        /// worktree loses it (needs `force`).
        pub orphan_commits: bool,
        /// herdr workspace showing it.
        pub workspace_id: Option<String>,
        /// Agents on the board with a pane in it.
        pub agents: u32,
        /// One of them is working or waiting for you: it is never removed then.
        pub busy: bool,
        /// When `git worktree add` created it.
        pub created_at: Option<Millis>,
        /// Latest sign of use: a commit, checkout or index write, an agent's activity in it.
        pub active_at: Option<Millis>,
        /// Bytes it takes on disk (allocated blocks, hard links once, one file system).
        pub size: Option<u64>,
        /// The size walk stopped at its budget: at least `size`.
        pub size_partial: bool,
        /// Its branch's pull request, when `pr_checked_at` says it was looked up.
        pub pr: Option<CleanupPr>,
        /// When the pull request was looked up (absent: not yet, or it could not be).
        pub pr_checked_at: Option<Millis>,
        /// Why the lookup failed.
        pub pr_error: Option<String>,
        /// The newest agent that ran in it: on the board, else omp's newest session there.
        pub last_agent: Option<CleanupAgent>,
        /// The automation whose run created it.
        pub automation: Option<String>,
    }
}

wire_struct! {
    pub struct CleanupPr {
        pub number: u32,
        pub url: String,
        pub title: String,
        /// `OPEN` | `MERGED` | `CLOSED`.
        pub state: String,
        pub draft: bool,
        /// When it was merged or closed.
        pub closed_at: Option<Millis>,
    }
}

wire_struct! {
    pub struct CleanupAgent {
        /// The agent on the board (live or parked); absent for a past omp session.
        pub agent_id: Option<String>,
        pub name: Option<String>,
        /// omp session title, else the first prompt.
        pub title: Option<String>,
        /// herdr state of a live agent.
        pub state: Option<HerdrState>,
        /// Marked done and its pane closed.
        pub parked: bool,
        /// Its last activity.
        pub at: Millis,
    }
}

wire_struct! {
    /// `cleanup.remove`: one linked worktree, by path. Refused with `busy` while an agent works in
    /// it, `worktree_locked` when locked, `orphan_commits` (detached HEAD, unless `force`),
    /// `dirty_worktree` (unless `force`), `untrusted_repo` (unless `trust`).
    pub struct CleanupRemoveParams {
        pub path: String,
        /// Also discard uncommitted changes and a detached HEAD's unsaved commits.
        #[serde(default)]
        pub force: bool,
        /// `-c safe.directory=*` for a repository owned by another user.
        #[serde(default)]
        pub trust: bool,
    }
}

wire_enum! {
    /// What `omp gc` maintains, limited to what is not a session.
    pub enum GcCategory {
        /// Unreferenced blobs (images and attachments no session points at).
        Blobs,
        /// Checkpoint the history and model databases' write-ahead logs.
        Wal,
        /// Store idle sessions compressed by the file system (APFS, NTFS), in place.
        Compress,
    }
}

wire_struct! {
    /// `cleanup.storage`: the storage check's state.
    pub struct CleanupStorageParams {
        /// Wait up to this long (ms, ≤ 20 000) for a running check or apply to finish.
        pub wait_ms: Option<u32>,
    }
}

wire_struct! {
    /// `cleanup.storageRun`: a dry run of every category, or applying some.
    pub struct CleanupStorageRunParams {
        pub apply: bool,
        /// With `apply`: what to apply (at least one). A dry run checks every category.
        #[serde(default)]
        pub categories: Vec<GcCategory>,
    }
}

wire_struct! {
    pub struct CleanupStorage {
        /// omp's agent dir (`PI_CODING_AGENT_DIR`, else `~/.omp/agent`).
        pub agent_dir: String,
        /// The run in progress.
        pub running: Option<GcRun>,
        /// The last finished dry run.
        pub check: Option<GcRun>,
        /// The last finished apply.
        pub applied: Option<GcRun>,
        /// Sessions omp keeps (never touched here).
        pub sessions: Option<GcUsage>,
        /// Why omp's storage can't be maintained from here (omp missing, no `omp gc`).
        pub unavailable: Option<String>,
    }
}

wire_struct! {
    pub struct GcUsage {
        pub bytes: u64,
        pub files: u32,
    }
}

wire_struct! {
    pub struct GcRun {
        pub apply: bool,
        pub categories: Vec<GcCategory>,
        pub started_at: Millis,
        pub finished_at: Option<Millis>,
        pub blobs: Option<GcBlobs>,
        pub wal: Option<GcWal>,
        pub compress: Option<GcCompress>,
        /// What failed, one line each (`blobs: …`).
        #[serde(default)]
        pub errors: Vec<String>,
    }
}

wire_struct! {
    pub struct GcBlobs {
        /// Blobs some session refers to.
        pub referenced: u32,
        pub would_delete: u32,
        pub deleted: u32,
        pub bytes: u64,
    }
}

wire_struct! {
    pub struct GcWal {
        pub databases: Vec<GcWalDb>,
        /// WAL bytes now (before a dry run's checkpoint, after an applied one).
        pub wal_bytes: u64,
        pub checkpointed: bool,
    }
}

wire_struct! {
    pub struct GcWalDb {
        pub path: String,
        pub wal_bytes: u64,
        pub checkpointed: bool,
    }
}

wire_struct! {
    pub struct GcCompress {
        /// The sessions' file system compresses in place (APFS, NTFS); nothing else is scanned.
        pub supported: bool,
        pub method: Option<String>,
        /// Sessions with files to compress.
        pub sessions: u32,
        pub would_compress: u32,
        pub compressed: u32,
        /// Logical bytes of those files.
        pub bytes: u64,
        pub allocated_before: u64,
        pub allocated_after: u64,
        /// Idle sessions a running omp still holds.
        pub skipped_live: u32,
        /// With apply: why the file system turned out not to compress.
        pub probe_failure: Option<String>,
    }
}
