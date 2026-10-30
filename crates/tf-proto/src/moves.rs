//! Moving an agent to another host (`move.*`, architecture §3.28).
//!
//! Hosts never talk to each other: the app relays. The source host checks the agent
//! (`move.check`) and the target checks what it would do with it (`move.probe`). Then:
//!
//! 1. `move.start` on the source pushes the branch, writes the uncommitted changes as a binary
//!    patch, closes the agent's pane (the agent parks, its card marked `moving`) and packs its omp
//!    session with every artifact (subagent transcripts, `local://` files) and blob
//!    (`omp session pack`). The app polls `move.status` until `ready`.
//! 2. The app copies each [`MoveStatus::parts`] file: `move.read` on the source, `upload.*` on the
//!    target (checked against its sha-256).
//! 3. `move.receive` on the target fetches the branch, checks it out (a new linked worktree, or the
//!    checkout that already holds the branch, fast-forwarded), applies the patch, unpacks the
//!    session into that folder (`omp session unpack --cwd`) and resumes the agent. The app polls
//!    `move.status` there until `done`; a `failed` target has rolled itself back.
//! 4. `move.finish` on the source marks the copy left behind (`omp session moved --to`): its
//!    parked card shows `moved`, and resuming it there forks it. Before that, `move.abort` rolls the
//!    source back: the agent resumes where it was (when the move closed it), staging is deleted. A
//!    pushed branch stays pushed.

use std::collections::BTreeMap;

use crate::model::ThinkingLevel;
use crate::{ApiError, Millis};

wire_enum! {
    /// `blocker`: the move cannot start; `warning`: it can, with a consequence worth reading.
    pub enum MoveIssueLevel { Blocker, Warning }
}

wire_struct! {
    pub struct MoveIssue {
        pub level: MoveIssueLevel,
        /// Stable id (`notIdle`, `pushRejected`, `noRepo`, …; architecture §3.28 lists them).
        pub code: String,
        pub message: String,
        pub hint: Option<String>,
    }
}

wire_struct! {
    /// The agent's code on the source: what the target needs to recreate its checkout.
    pub struct MoveGit {
        /// Main worktree root of the repository, and its folder name.
        pub repo_root: String,
        pub repo_name: String,
        /// Top of the agent's checkout (its linked worktree, else `repoRoot`).
        pub top: String,
        /// The agent's folder below `top`, `/`-separated (`""` at the top).
        pub subdir: String,
        pub branch: String,
        /// Full sha the target checks out.
        pub head: String,
        /// The remote the branch is pushed to and fetched from, and its URL.
        pub remote: String,
        pub remote_url: String,
        /// Commits `<remote>/<branch>` lacks (`move.start` pushes them); absent: the remote has no
        /// such branch yet (the whole branch is pushed).
        pub ahead: Option<u32>,
        /// Files with uncommitted changes (staged, unstaged, untracked): carried as a patch.
        pub dirty: u32,
        /// The repository's default branch (`main`).
        pub default_branch: Option<String>,
        /// The agent ran in a linked worktree.
        pub linked: bool,
    }
}

wire_struct! { pub struct MoveCheckParams { pub agent_id: String } }

wire_struct! {
    /// `move.check`: the source's preflight. Also the description of the agent `move.probe` and
    /// `move.receive` work from (`MoveStatus.source` carries the final one).
    pub struct MoveCheck {
        pub agent_id: String,
        /// herdr name (the target reuses it unless taken) and task title.
        pub name: String,
        pub title: String,
        /// The agent's folder on the source.
        pub cwd: String,
        /// Absent: not in a git repository; only the conversation moves (the target names a folder).
        pub git: Option<MoveGit>,
        pub session_id: Option<String>,
        pub session_file: String,
        /// Bytes of the session file and its artifacts folder.
        pub session_bytes: u64,
        /// Files in the artifacts folder (subagent transcripts, `local://` files, …), and how many
        /// of them are subagent transcripts.
        pub artifact_files: u32,
        pub subagent_transcripts: u32,
        /// Upper bound of the uncommitted-changes patch: bytes of the changed files.
        pub changes_bytes: u64,
        /// `provider/id` and thinking level the agent resumes with.
        pub model: Option<String>,
        pub thinking: Option<ThinkingLevel>,
        /// The agent's own omp model roles and fallback chains (as in `AgentSpec`).
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        #[ts(as = "Option<BTreeMap<String, String>>", optional)]
        pub role_models: BTreeMap<String, String>,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        #[ts(as = "Option<BTreeMap<String, Vec<String>>>", optional)]
        pub fallback_chains: BTreeMap<String, Vec<String>>,
        /// The agent's own decide-for-me policy (as in `AgentSpec`).
        pub auto_answer: Option<crate::autoanswer::AutoAnswer>,
        /// The agent is parked (its pane is closed); otherwise `move.start` closes it.
        pub parked: bool,
        pub omp_version: Option<String>,
        pub issues: Vec<MoveIssue>,
    }
}

wire_struct! {
    pub struct MoveProbeParams {
        /// The source's `move.check`.
        pub source: MoveCheck,
        /// Check this folder as the repository (picked by the user) instead of searching for one.
        pub repo_path: Option<String>,
    }
}

wire_enum! {
    /// How the target gets the branch: a new linked worktree, or the checkout that already holds
    /// the branch (fast-forwarded to the source's head).
    pub enum MoveCheckout { NewWorktree, Existing }
}

wire_struct! {
    /// A clone of the agent's repository on the target.
    pub struct MoveRepo {
        /// Main worktree root.
        pub path: String,
        /// The remote whose URL matches the source's remote, and that URL.
        pub remote: String,
        pub remote_url: String,
        pub checkout: MoveCheckout,
        /// `existing`: the checkout holding the branch.
        pub checkout_path: Option<String>,
        /// A local branch of that name exists here (it is fast-forwarded to the source's head).
        pub branch_exists: bool,
        /// Blockers mean this clone cannot take the agent (another may).
        pub issues: Vec<MoveIssue>,
    }
}

wire_struct! {
    pub struct MoveProbe {
        pub hostname: String,
        pub omp_version: Option<String>,
        /// Clones of the repository, best first. None: clone it (`clonePath`) or pick a folder.
        pub repos: Vec<MoveRepo>,
        /// Where `move.receive {cloneTo}` would clone the repository (absent: no git, or no clone
        /// is needed).
        pub clone_path: Option<String>,
        /// Free bytes where the parts land.
        pub free_bytes: Option<u64>,
        pub issues: Vec<MoveIssue>,
    }
}

wire_struct! {
    /// Where the agent goes, as the moving app names it.
    pub struct MoveTo {
        /// The target host's name: `omp session moved --to`, activity, the parked card.
        pub label: String,
        /// The app's id of the target host (only meaningful to the app that moved it).
        pub host_id: Option<String>,
    }
}

wire_struct! {
    pub struct MoveStartParams {
        pub agent_id: String,
        pub to: MoveTo,
    }
}

wire_struct! { pub struct MoveRef { pub move_id: String } }

wire_struct! {
    pub struct MoveReadParams {
        pub move_id: String,
        /// `MovePart.name`.
        pub part: String,
        pub offset: u64,
        /// Bytes wanted, at most 1 MiB.
        pub length: u32,
    }
}

wire_struct! {
    pub struct MoveChunk {
        /// Base64 of the bytes from `offset` (fewer than asked at the end of the part).
        pub data: String,
        /// The part's size.
        pub size: u64,
    }
}

wire_struct! {
    /// One file the app copies from the source to the target.
    pub struct MovePart {
        /// `session` (omp's session archive) or `changes` (the uncommitted-changes patch).
        pub name: String,
        pub size: u64,
        /// Hex sha-256 (`upload.finish` checks it).
        pub sha256: String,
    }
}

wire_struct! {
    pub struct MoveReceiveParams {
        /// The source's move id (the target's job uses it too).
        pub move_id: String,
        /// The source's final description (`MoveStatus.source` once `ready`).
        pub source: MoveCheck,
        /// The source host's name.
        pub from: String,
        /// The parts, uploaded and finished on this host (`upload.*` ids).
        pub session_upload: String,
        pub changes_upload: Option<String>,
        /// Repository to check the branch out in (a `MoveProbe.repos[].path`).
        pub repo_path: Option<String>,
        /// Clone the repository to this new folder first (`MoveProbe.clonePath`).
        pub clone_to: Option<String>,
        /// Without git: the existing folder the agent continues in.
        pub cwd: Option<String>,
    }
}

wire_struct! {
    pub struct MoveFinishParams {
        pub move_id: String,
        /// The agent's id on the target (`MoveStatus.agentId` there).
        pub agent_id: Option<String>,
    }
}

wire_enum! { pub enum MoveRole { Source, Target } }

wire_enum! {
    /// Source: `running` → `ready` (parts packed; waiting for `move.finish` / `move.abort`) →
    /// `done`. Target: `running` → `done`. A failure or `move.abort` rolls back first
    /// (`rollingBack`), then ends `failed` (`error` says why; `aborted` when asked to).
    /// Target `confirming`: the agent's launch was sent but not seen yet (a lost answer, a restart,
    /// herdr unreadable): the agent may run there. Nothing is removed and the move is neither done
    /// nor failed; it ends `done` (the agent runs) or `failed` (surely absent, rolled back).
    /// Clients keep the source parked and never abort it meanwhile.
    pub enum MovePhase { Running, Ready, Done, RollingBack, Failed, Confirming }
}

wire_enum! { pub enum MoveStepState { Pending, Running, Done, Skipped, Failed, Undone } }

wire_struct! {
    pub struct MoveStep {
        /// Source: `push`, `changes`, `close`, `pack`, `finish`. Target: `clone`, `fetch`,
        /// `checkout`, `changes`, `unpack`, `start`.
        pub id: String,
        pub label: String,
        pub state: MoveStepState,
        pub detail: Option<String>,
    }
}

wire_struct! {
    pub struct MoveStatus {
        pub move_id: String,
        pub role: MoveRole,
        pub phase: MovePhase,
        pub steps: Vec<MoveStep>,
        /// Source, `ready`: the files to copy, and the description `move.receive` takes.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        #[ts(as = "Option<Vec<MovePart>>", optional)]
        pub parts: Vec<MovePart>,
        pub source: Option<MoveCheck>,
        /// Target, `done`: the resumed agent, its session file and folder. Source, `failed` after a
        /// rollback: the agent running there again (a resumed agent has a new id).
        pub agent_id: Option<String>,
        pub session_file: Option<String>,
        pub cwd: Option<String>,
        /// `failed`: why.
        pub error: Option<ApiError>,
        /// What a rollback could not undo, and other notes worth showing.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        #[ts(as = "Option<Vec<String>>", optional)]
        pub notes: Vec<String>,
        pub started_at: Millis,
        pub updated_at: Millis,
    }
}

wire_enum! {
    /// `moving`: a move to another host runs. `interrupted`: it stopped before the target confirmed
    /// (the app went away, or tf-hostd restarted); the target may or may not run the agent now.
    /// `moved`: it continues on the target; resuming this copy forks it.
    pub enum ParkedMoveState { Moving, Interrupted, Moved }
}

wire_struct! {
    /// `Parked.moved`: a parked agent that is moving, or moved, to another host.
    pub struct ParkedMove {
        pub state: ParkedMoveState,
        pub move_id: String,
        /// The target host's name.
        pub to: String,
        /// The app's id of that host (as the moving app knew it).
        pub host_id: Option<String>,
        /// The agent's id on the target (`moved`).
        pub agent_id: Option<String>,
        /// When the move started (`moving`, `interrupted`) or finished (`moved`).
        pub at: Millis,
    }
}

#[cfg(test)]
mod tests {
    use crate::HostMethod;

    #[test]
    fn move_methods_parse_camel_case() {
        let req = HostMethod::parse("move.read", serde_json::json!({ "moveId": "mv_1", "part": "session", "offset": 0, "length": 65536 })).unwrap();
        let HostMethod::MoveRead(p) = req else { panic!("wrong variant") };
        assert_eq!((p.move_id.as_str(), p.part.as_str(), p.length), ("mv_1", "session", 65536));
        let start = HostMethod::parse("move.start", serde_json::json!({ "agentId": "t1", "to": { "label": "build server" } })).unwrap();
        let HostMethod::MoveStart(p) = start else { panic!("wrong variant") };
        assert_eq!((p.to.label.as_str(), p.to.host_id), ("build server", None));
        assert_eq!(HostMethod::parse("move.finish", serde_json::json!({})).unwrap_err().code, "invalid_params");
    }
}
