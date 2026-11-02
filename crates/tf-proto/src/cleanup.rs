//! The Cleanup page (worktree and storage janitor), `cleanup.*` host methods.
//!
//! * `cleanup.worktrees`: every linked git worktree of the repositories TeleFlock knows on the host
//!   (its herdr workspaces, agents on the board, parked agents, automations), with what deciding
//!   whether to delete it takes: pull request, age, uncommitted changes, size, last real use, and
//!   the main agent it belongs to (a subagent's worktree belongs to its top-level session).
//! * `cleanup.remove`: removes one of them, after checking again that no agent works in it, it is
//!   not locked and a detached HEAD holds no commit only it knows (`force` for those and for
//!   uncommitted changes). The branch is always kept.
//! * `cleanup.storage` / `cleanup.storageRun`: omp's own storage maintenance (`omp gc`), limited to
//!   what is not a session: unreferenced blobs, database WAL files, filesystem compression of idle
//!   session files. Sessions are never archived or deleted here.
//! * Idle shells (`HostInfo.idleShells`, `cleanup.idleShellsSet`, `cleanup.idleShellsClose`):
//!   herdr panes whose shell waits at its prompt with nothing running, in a workspace without an
//!   agent, shown nowhere, with no input or output for a while. tf-hostd lists them and, unless
//!   switched off, closes them by itself.

use crate::Millis;
use crate::model::HerdrState;
use crate::ApiError;

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
        /// The main agents its worktrees belong to (`CleanupWorktree.owner`), each once. Hosts
        /// ≥ 0.9.0; absent from older ones.
        pub owners: Option<Vec<CleanupOwner>>,
        /// omp session files not read yet (a big sessions folder is read over several scans):
        /// some worktrees may still lack their agent.
        pub sessions_pending: Option<u32>,
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
        /// Latest real use (hosts ≥ 0.9.0): an omp session or subagent working in it (its
        /// transcript's entries), a commit or checkout made in it (its HEAD reflog's entries), a
        /// change to its files (the newest of those git status lists), a live agent's activity.
        /// Never what only reads it (scans) or rewrites git's files (`git gc` rewrites every
        /// worktree's reflog). Older hosts: the newest of its admin dir's reflog, index and HEAD files.
        pub active_at: Option<Millis>,
        /// What `active_at` is (hosts ≥ 0.9.0).
        pub active_by: Option<WorktreeUse>,
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
        /// The main agent it belongs to (hosts ≥ 0.9.0): one on the board in it, else the one whose
        /// session ran there, else the first whose subagents worked there.
        pub owner: Option<CleanupOwnerRef>,
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

wire_enum! {
    /// What a worktree's last use (`CleanupWorktree.activeAt`) was.
    pub enum WorktreeUse {
        /// An omp session or one of its subagents worked in it (its transcript), or a live agent did.
        Agent,
        /// A commit, checkout, merge or reset made in it (its HEAD reflog).
        Git,
        /// Its uncommitted changes (the newest of the files git status lists).
        Files,
    }
}

wire_enum! {
    /// Where a worktree's main agent is now.
    pub enum CleanupOwnerState {
        /// On the board with its pane.
        Live,
        /// Marked done: its pane closed, its card in Done (resumable).
        Parked,
        /// Its omp ended without anyone closing it: its card waits in Review to come back.
        Ended,
        /// No card on the board: only its omp session file is left (Past sessions).
        Gone,
    }
}

wire_struct! {
    /// A main (top-level) agent worktrees belong to: an omp session started by hand, by TeleFlock
    /// or by an automation, never a subagent (a subagent's work counts for its session).
    pub struct CleanupOwner {
        /// Its top-level omp session file; `agent:<id>` for an agent on the board without one.
        pub key: String,
        pub state: CleanupOwnerState,
        /// Its card on the board (live, parked or ended).
        pub agent_id: Option<String>,
        /// The card's name.
        pub name: Option<String>,
        /// The card's title, else omp's session title.
        pub title: Option<String>,
        /// herdr state of a live agent.
        pub herdr: Option<HerdrState>,
        /// omp session id.
        pub session_id: Option<String>,
        /// Its session's folder.
        pub cwd: Option<String>,
        /// Its last activity, its session's or any subagent's (anywhere).
        pub at: Option<Millis>,
    }
}

wire_struct! {
    /// Which main agent a worktree belongs to.
    pub struct CleanupOwnerRef {
        /// `CleanupOwner.key`.
        pub key: String,
        /// Its subagents that worked in the worktree (transcript names, the latest first, at most
        /// 6); empty when the agent itself works there.
        #[serde(default)]
        pub subagents: Vec<String>,
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

wire_struct! {
    /// The host's idle shells (`HostInfo.idleShells`; absent from daemons before 0.9.0, so apps
    /// hide the controls for them). An idle shell is a herdr pane whose own process is a shell
    /// that holds the terminal's foreground (nothing runs in front of it) and has no background
    /// jobs, in a workspace where no agent runs and no parked or ended card belongs, shown in no
    /// TeleFlock terminal and no herdr window, with no input or output for `minutes`. tf-hostd
    /// checks every minute (the first check 2 minutes after it started, once apps re-attached
    /// their terminals) and, while `auto` is on, closes them by itself, whether or not an app is
    /// connected; closing a workspace's last pane closes that workspace (herdr's own rule).
    pub struct IdleShells {
        /// Close idle shells automatically (default on).
        pub auto: bool,
        /// Minutes without input or output after which a shell counts as idle (default 1440).
        pub minutes: u32,
        /// The shells idle now, longest idle first.
        pub shells: Vec<IdleShell>,
        /// The newest automatic close since the daemon started.
        pub last_closed: Option<IdleShellsClosed>,
        /// Why `auto` is off although it may have been on: the settings file could not be read, so
        /// the host fails closed (closes nothing by itself) until the settings are saved again.
        pub notice: Option<String>,
    }
}

wire_struct! {
    /// One idle shell.
    pub struct IdleShell {
        /// herdr pane id (`w3:p1`).
        pub pane_id: String,
        /// The terminal the pane shows; `cleanup.idleShellsClose` closes the pane only while it
        /// still shows this one.
        pub terminal_id: String,
        pub workspace_id: String,
        /// The workspace's label.
        pub workspace: String,
        /// The shell's folder.
        pub cwd: Option<String>,
        /// The shell program (`bash`, `zsh`).
        pub shell: String,
        /// Its last input or output, moved past the time the host slept since (no idle time).
        pub idle_since: Millis,
        /// The last command tf-hostd saw running in it (since the daemon started), when known.
        pub last_command: Option<String>,
        /// It is its workspace's only pane: closing it closes the workspace.
        pub closes_workspace: bool,
    }
}

wire_struct! {
    /// Shells tf-hostd closed by itself in one check.
    pub struct IdleShellsClosed {
        pub at: Millis,
        pub count: u32,
        /// The labels of their workspaces, each once.
        pub workspaces: Vec<String>,
    }
}

wire_struct! {
    /// `cleanup.idleShellsSet`: the host's idle-shell settings (persisted by tf-hostd); an absent
    /// field keeps its value.
    pub struct IdleShellsSetParams {
        pub auto: Option<bool>,
        /// 1 to 43 200 (30 days).
        pub minutes: Option<u32>,
    }
}

wire_struct! {
    /// `cleanup.idleShellsClose`: closes these shells, each checked again right before. One that
    /// was used since, runs something, got an agent or a viewer, or whose pane shows another
    /// terminal by now stays open (`kept`, with why).
    pub struct IdleShellsCloseParams {
        pub shells: Vec<IdleShellRef>,
    }
}

wire_struct! {
    pub struct IdleShellRef {
        pub pane_id: String,
        /// `IdleShell.terminalId`.
        pub terminal_id: String,
    }
}

wire_struct! {
    pub struct IdleShellsCloseResult {
        /// Pane ids closed.
        pub closed: Vec<String>,
        /// Shells left open, with why.
        pub kept: Vec<IdleShellKept>,
        /// The host's idle shells after the closes.
        pub idle: IdleShells,
    }
}

wire_struct! {
    pub struct IdleShellKept {
        pub pane_id: String,
        pub error: ApiError,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_older_hosts_report_parses_without_owners() {
        let old = serde_json::json!({ "scanning": false, "repos": [{ "root": "/r", "name": "r", "worktrees": [{
            "path": "/w", "missing": false, "orphanCommits": false, "agents": 0, "busy": false, "sizePartial": false, "activeAt": 5
        }] }] });
        let r: CleanupReport = serde_json::from_value(old).unwrap();
        let w = &r.repos[0].worktrees[0];
        assert!(r.owners.is_none() && r.sessions_pending.is_none());
        assert!(w.owner.is_none() && w.active_by.is_none());
        assert_eq!(w.active_at, Some(5));
    }

    #[test]
    fn owners_go_out_camel_case() {
        let owner = CleanupOwner {
            key: "/s/-wt-a/x.jsonl".into(),
            state: CleanupOwnerState::Gone,
            agent_id: None,
            name: None,
            title: Some("Fix CI".into()),
            herdr: None,
            session_id: Some("x".into()),
            cwd: Some("/wt/a".into()),
            at: Some(9),
        };
        let v = serde_json::to_value(&owner).unwrap();
        assert_eq!((v["state"].as_str(), v["sessionId"].as_str()), (Some("gone"), Some("x")));
        assert!(v.get("agentId").is_none(), "None fields are omitted");
        let r: CleanupOwnerRef = serde_json::from_value(serde_json::json!({ "key": "k" })).unwrap();
        assert!(r.subagents.is_empty(), "subagents default to none");
        assert_eq!(serde_json::to_value(WorktreeUse::Files).unwrap(), "files");
    }
}
