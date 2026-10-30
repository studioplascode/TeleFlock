//! `host.wrapped`: one host's share of the app's weekly Flock Wrapped card (architecture §3.19).
//!
//! The app asks every host about the same window (its own local week) and adds the answers up:
//! counts sum, lists merge by key (commits by hash, pull requests by URL, models and subagents by
//! name). The awards (fastest model, busiest subagent, longest overnight streak) are picked from
//! the merged figures, in the app's own time zone.
//!
//! Agents, work, models and subagents come from omp's stats index through `host.usage`'s report
//! (the same definitions as the Usage page); commits from git and merged pull requests from the
//! GitHub CLI, in the repositories the agents worked in.

use crate::usage::{UsageIndex, UsageSpan};
use crate::Millis;

wire_struct! {
    pub struct WrappedParams {
        /// Window start (epoch ms): the app's local Monday 00:00.
        pub since: Millis,
        /// Window end (exclusive); absent = now (the week so far).
        pub until: Option<Millis>,
        /// Minutes past each UTC hour at which the app's local hours start (as `host.usage`).
        pub hour_offset: Option<u32>,
        /// Ask git and GitHub again, unless that happened within the last 30 s.
        pub refresh: Option<bool>,
    }
}

wire_struct! {
    /// What one host contributes to a week's card.
    pub struct WrappedReport {
        /// The window answered (`until`: when this answer was built, for the week so far).
        pub since: Millis,
        pub until: Millis,
        /// omp's stats index (agents, work, models and subagents come from it). `ready: false`:
        /// nothing is indexed yet; `syncing`: figures may still grow (ask again).
        pub index: Option<UsageIndex>,
        /// omp sessions with requests in the window (each with its subagents and advisor).
        pub agents: u64,
        /// Subagent runs (task transcripts) with requests in the window.
        pub subagents: u64,
        /// Automation runs that started an agent in the window (the host keeps its last 100).
        pub automation_runs: u32,
        /// Time agents worked on their own, summed over agents (ms): their requests and the tool
        /// runs between them; a pause over 10 min or a prompt of yours ends a stretch.
        pub work_ms: u64,
        /// When any agent of this host worked (pauses ≤ 10 min bridged), ascending.
        pub busy: Vec<UsageSpan>,
        /// Output speed per model, for the fastest model.
        pub models: Vec<WrappedModel>,
        /// Subagents by task name, most requests first (≤ 12).
        pub crew: Vec<WrappedSubagent>,
        /// Your commits in the window, in the repositories the agents worked in. Absent while git
        /// is still being asked (`pending`).
        pub code: Option<WrappedCode>,
        /// Your pull requests merged in the window, in those repositories. Absent while GitHub is
        /// still being asked (`pending`) or when it cannot be asked (`prs_note` says why).
        pub prs: Option<Vec<WrappedPr>>,
        /// Why pull requests are missing or incomplete (gh not installed or not signed in, a
        /// repository GitHub did not answer for).
        pub prs_note: Option<String>,
        /// git and GitHub are still being asked: ask again shortly (the answer is cached).
        pub pending: Option<bool>,
    }
}

wire_struct! {
    pub struct WrappedModel {
        pub provider: String,
        pub model: String,
        pub requests: u64,
        /// Sum and count of per-request output rates (tokens/s, omp's `output × 1000 ÷ duration`):
        /// the average is `tps / tps_n`.
        pub tps: f64,
        pub tps_n: u64,
    }
}

wire_struct! {
    pub struct WrappedSubagent {
        /// Task name (`Explore` for a `3-Explore.jsonl` transcript).
        pub name: String,
        /// Model requests: its steps.
        pub requests: u64,
        pub tokens: u64,
        /// Output tokens.
        pub output: u64,
        pub cost_usd: f64,
    }
}

wire_struct! {
    pub struct WrappedCode {
        /// The repositories looked at (one per git repository, linked worktrees folded).
        pub repos: Vec<WrappedRepo>,
        /// Non-merge commits authored with the repository's `user.email` whose commit time falls in
        /// the window, on any ref; commits GitHub made (web merges and squashes) are left out, as
        /// are lock files' lines. Newest first (≤ 2000).
        pub commits: Vec<WrappedCommit>,
    }
}

wire_struct! {
    pub struct WrappedRepo {
        /// Folder name of the main worktree.
        pub name: String,
        pub path: String,
        /// Why its commits could not be read.
        pub error: Option<String>,
    }
}

wire_struct! {
    pub struct WrappedCommit {
        /// Abbreviated hash (12 hex digits): the same commit in two hosts' clones counts once.
        pub sha: String,
        /// `WrappedRepo.name`.
        pub repo: String,
        pub at: Millis,
        pub added: u32,
        pub removed: u32,
    }
}

wire_struct! {
    pub struct WrappedPr {
        pub url: String,
        pub number: u64,
        pub title: String,
        /// `owner/name`.
        pub repo: String,
        pub merged_at: Millis,
    }
}
