//! Preflights: what the source knows about the agent (`move.check`) and what the target would do
//! with it (`move.probe`). Facts come from the board, the file system and git; the verdicts over
//! them are pure functions (unit-tested in `tests.rs`).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tf_proto::model::{Agent, HerdrState};
use tf_proto::{
    ApiError, AutoResumeStatus, MoveCheck, MoveCheckout, MoveGit, MoveIssue, MoveIssueLevel, MoveProbe, MoveProbeParams, MoveRepo, ParkedMoveState,
    ThinkingLevel,
};

use super::{ompcli, url};
use crate::agentcfg::Store;
use crate::ops::git::{self, git, git_remote};
use crate::ops::Ctx;
use crate::state::persist::ParkedRecord;

const QUICK: Duration = Duration::from_secs(10);
/// Fetching the agent's branch during the preflight (the remote's state decides what to push).
const FETCH: Duration = Duration::from_secs(8);
/// `git push --dry-run`.
const DRY_RUN: Duration = Duration::from_secs(12);
/// `git ls-remote` of a repository the target would clone.
const LS_REMOTE: Duration = Duration::from_secs(8);
/// omp packs at most this much (its archive limit).
pub const MAX_SESSION: u64 = 2 << 30;
/// Uncommitted changes are carried up to this many bytes of changed files.
pub const MAX_CHANGES: u64 = 256 << 20;
/// Clones a target looks at, at most.
const MAX_CANDIDATES: usize = 64;

// ───────────────────────────── the agent ─────────────────────────────

/// The agent to move: a live one, or a parked card (pane closed).
#[derive(Debug, Clone, Default)]
pub struct Subject {
    pub agent_id: String,
    pub name: String,
    pub title: String,
    pub kind: String,
    pub cwd: Option<String>,
    pub session_id: Option<String>,
    pub session_file: Option<String>,
    /// `provider/id`.
    pub model: Option<String>,
    pub thinking: Option<ThinkingLevel>,
    /// The parked record, when its pane is closed.
    pub parked: Option<ParkedRecord>,
    pub state: Option<HerdrState>,
    pub needs: bool,
    pub subagents_live: u32,
    /// Background jobs (bash, task, eval) still running, or omp waiting for one's result.
    pub jobs_running: u32,
    /// omp waits to retry a provider error, or host auto-resume has a ticket for the agent.
    pub retry_pending: bool,
    pub queued: usize,
    pub pid: Option<u32>,
    pub archived: bool,
}

impl Subject {
    pub fn from_agent(a: &Agent) -> Subject {
        let omp = a.omp.as_ref();
        Subject {
            agent_id: a.id.clone(),
            name: a.name.clone(),
            title: a.title.clone(),
            kind: a.kind.clone(),
            cwd: a.cwd.clone(),
            session_id: omp.and_then(|o| o.session_id.clone()),
            session_file: omp.and_then(|o| o.session_file.clone()).filter(|f| !f.is_empty()),
            model: omp.and_then(|o| o.model.as_ref()).map(|m| format!("{}/{}", m.provider, m.id)),
            thinking: omp.and_then(|o| o.thinking),
            parked: None,
            state: Some(a.state),
            needs: a.needs.is_some(),
            subagents_live: omp.and_then(|o| o.subagents.as_ref()).map(|s| s.live).unwrap_or(0),
            jobs_running: omp.and_then(|o| o.jobs.as_ref()).map(|j| if j.waiting { j.running.max(1) } else { j.running }).unwrap_or(0),
            retry_pending: omp.is_some_and(|o| o.retry.is_some()) || a.auto_resume.as_ref().is_some_and(|r| r.status != AutoResumeStatus::Manual),
            queued: omp.map(|o| o.queue.steering.len() + o.queue.follow_up.len()).unwrap_or(0),
            pid: omp.and_then(|o| o.pid),
            archived: a.archived,
        }
    }

    pub fn from_record(r: &ParkedRecord) -> Subject {
        Subject {
            agent_id: r.agent_id.clone(),
            name: r.name.clone(),
            title: r.title.clone(),
            kind: r.kind.clone(),
            cwd: r.cwd.clone().or_else(|| r.workspace_cwd.clone()),
            session_id: r.session_id.clone(),
            session_file: Some(r.session_file.clone()).filter(|f| !f.is_empty()),
            model: r.model.as_ref().map(|m| format!("{}/{}", m.provider, m.id)),
            thinking: r.thinking,
            parked: Some(r.clone()),
            state: None,
            needs: false,
            subagents_live: 0,
            jobs_running: 0,
            retry_pending: false,
            queued: 0,
            pid: None,
            archived: true,
        }
    }
}

/// The agent `agent_id` on this host's board (live or parked).
pub fn subject(ctx: &Ctx, agent_id: &str) -> Result<Subject, ApiError> {
    if let Some(r) = ctx.state.parked(agent_id) {
        return Ok(Subject::from_record(&r));
    }
    match ctx.state.agent(agent_id) {
        Some(a) => Ok(Subject::from_agent(&a)),
        None => Err(ApiError::new("not_found", format!("no agent `{agent_id}`"))),
    }
}

pub fn blocker(code: &str, message: impl Into<String>, hint: Option<String>) -> MoveIssue {
    MoveIssue { level: MoveIssueLevel::Blocker, code: code.into(), message: message.into(), hint }
}

pub fn warning(code: &str, message: impl Into<String>, hint: Option<String>) -> MoveIssue {
    MoveIssue { level: MoveIssueLevel::Warning, code: code.into(), message: message.into(), hint }
}

pub fn has_blocker(issues: &[MoveIssue]) -> bool {
    issues.iter().any(|i| i.level == MoveIssueLevel::Blocker)
}

/// The first blocker as an error (`move.start` refuses with it).
pub fn blocked(issues: &[MoveIssue]) -> Option<ApiError> {
    let b = issues.iter().find(|i| i.level == MoveIssueLevel::Blocker)?;
    let mut err = ApiError::new("move_blocked", b.message.clone());
    err.hint = b.hint.clone();
    Some(err)
}

/// What stops the agent itself from moving (or is worth knowing): its kind, session, activity,
/// a move already under way, and whether this omp can pack.
pub fn agent_issues(s: &Subject, omp_version: Option<&str>) -> Vec<MoveIssue> {
    let mut out = Vec::new();
    let name = &s.name;
    if s.kind != "omp" {
        out.push(blocker("notOmp", format!("{name} runs {}; only omp agents can move", s.kind), None));
    }
    if s.session_file.is_none() {
        out.push(blocker("noSession", format!("omp has not saved {name}'s session yet"), Some("Send it a prompt first, then move it.".into())));
    }
    match &s.parked {
        None => {
            if !matches!(s.state, Some(HerdrState::Idle | HerdrState::Done)) {
                out.push(blocker("notIdle", format!("{name} is working"), Some("Wait for its turn to end, or stop it.".into())));
            }
            if s.needs {
                out.push(blocker("needsYou", format!("{name} is waiting for you"), Some("Answer it first.".into())));
            }
            if s.subagents_live > 0 {
                let n = s.subagents_live;
                out.push(blocker(
                    "subagentsRunning",
                    format!("{n} subagent{} of {name} still run{}", if n == 1 { "" } else { "s" }, if n == 1 { "s" } else { "" }),
                    Some("Wait for them to finish, or stop them.".into()),
                ));
            }
            if s.jobs_running > 0 {
                let n = s.jobs_running;
                out.push(blocker(
                    "jobsRunning",
                    format!("{name} has {n} background job{} running (closing its pane ends {})", if n == 1 { "" } else { "s" }, if n == 1 { "it" } else { "them" }),
                    Some("Wait for them to finish, or stop them (Jobs).".into()),
                ));
            }
            if s.retry_pending {
                out.push(warning(
                    "retryPending",
                    format!("{name} is waiting to retry or resume a cut-off reply"),
                    Some("The moved agent starts idle: press Continue there, or let it finish retrying first.".into()),
                ));
            }
            if s.queued > 0 {
                out.push(blocker("queued", format!("{} queued message(s) were not sent to {name} yet", s.queued), Some("Let it take them, or clear the queue.".into())));
            }
        }
        Some(r) => match &r.moved {
            Some(m) if m.state == ParkedMoveState::Moving => {
                out.push(blocker("moving", format!("{name} is being moved to {}", m.to), None));
            }
            Some(m) if m.state == ParkedMoveState::Moved => out.push(blocker(
                "alreadyMoved",
                format!("{name} moved to {}; this is the copy it left behind", m.to),
                Some(format!("Move it from {} instead.", m.to)),
            )),
            Some(m) => out.push(warning(
                "interrupted",
                format!("A move of {name} to {} was interrupted", m.to),
                Some(format!("If {} runs it now, moving this copy too makes two.", m.to)),
            )),
            None => {}
        },
    }
    if let Some(v) = omp_version.filter(|v| !ompcli::supports_transfer(v)) {
        out.push(blocker("ompTooOld", format!("omp {v} here cannot pack sessions (needs 18.10)"), Some("Update omp on this host (Host setup).".into())));
    }
    out
}

// ───────────────────────────── the session ─────────────────────────────

/// Size of a session and its artifacts folder (`<file without .jsonl>/`: subagent transcripts,
/// `local://` files, tool output), as `omp session pack` reads them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SessionStats {
    pub bytes: u64,
    pub artifact_files: u32,
    pub subagent_transcripts: u32,
}

pub fn session_stats(file: &Path) -> std::io::Result<SessionStats> {
    let meta = std::fs::metadata(file)?;
    let mut stats = SessionStats { bytes: meta.len(), ..Default::default() };
    // omp keeps the artifacts beside the journal's real name.
    let real = std::fs::canonicalize(file).unwrap_or_else(|_| file.to_path_buf());
    let Some(dir) = real.to_str().and_then(|s| s.strip_suffix(".jsonl")).map(PathBuf::from) else { return Ok(stats) };
    let mut stack = vec![(dir, true)];
    while let Some((d, top)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let Ok(t) = e.file_type() else { continue };
            if t.is_dir() {
                stack.push((e.path(), false));
            } else if t.is_file() {
                stats.artifact_files += 1;
                stats.bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
                let name = e.file_name().to_string_lossy().into_owned();
                if name.ends_with(".jsonl") && !(top && name.starts_with("__advisor")) {
                    stats.subagent_transcripts += 1;
                }
            }
        }
    }
    Ok(stats)
}

pub fn session_issues(name: &str, file: Option<&str>, stats: &std::io::Result<SessionStats>) -> Vec<MoveIssue> {
    let Some(file) = file else { return Vec::new() };
    match stats {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            vec![blocker("noSession", format!("{name}'s session file {file} is gone"), None)]
        }
        Err(e) => vec![blocker("noSession", format!("cannot read {name}'s session file {file}: {e}"), None)],
        Ok(s) if s.bytes > MAX_SESSION => vec![blocker(
            "tooLarge",
            format!("{name}'s session is {} with its artifacts; omp moves at most {}", bytes(s.bytes), bytes(MAX_SESSION)),
            Some("Compact it or start a handoff session, then move that one.".into()),
        )],
        Ok(_) => Vec::new(),
    }
}

/// `12.3 MB`.
pub fn bytes(n: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    if n < 1024 {
        return format!("{n} B");
    }
    let mut v = n as f64 / 1024.0;
    let mut u = 0;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if v >= 100.0 { format!("{v:.0} {}", UNITS[u]) } else { format!("{v:.1} {}", UNITS[u]) }
}

// ───────────────────────────── the code ─────────────────────────────

/// What the source's remote holds of the agent's branch.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum RemoteBranch {
    /// Not asked (no network check) and no remote-tracking ref.
    #[default]
    Unknown,
    /// The remote has no such branch: all of it is pushed.
    Missing,
    /// Commits the remote lacks / has beyond the local branch.
    Tracking { ahead: u32, behind: u32 },
    /// The remote could not be asked (offline, credentials): git's message.
    Unreachable(String),
}

/// The agent's checkout on the source.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GitFacts {
    pub top: PathBuf,
    pub root: PathBuf,
    /// The agent's folder below `top`, `/`-separated.
    pub subdir: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub remote: Option<String>,
    pub remote_url: Option<String>,
    pub remote_branch: RemoteBranch,
    /// Changed files (staged, unstaged, untracked) and their bytes on disk.
    pub dirty: u32,
    pub changes_bytes: u64,
    pub default_branch: Option<String>,
    pub linked: bool,
    /// `git push --dry-run`: run when something is to be pushed and the remote answered.
    pub push: Option<Result<(), String>>,
}

impl GitFacts {
    /// Commits `move.start` pushes (`None`: the whole branch, the remote lacks it).
    pub fn ahead(&self) -> Option<u32> {
        match self.remote_branch {
            RemoteBranch::Tracking { ahead, .. } => Some(ahead),
            _ => None,
        }
    }

    pub fn needs_push(&self) -> bool {
        !matches!(self.remote_branch, RemoteBranch::Tracking { ahead: 0, .. })
    }

    pub fn to_wire(&self) -> MoveGit {
        let name_of = |p: &Path| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.display().to_string());
        MoveGit {
            repo_root: self.root.display().to_string(),
            repo_name: name_of(&self.root),
            top: self.top.display().to_string(),
            subdir: self.subdir.clone(),
            branch: self.branch.clone().unwrap_or_default(),
            head: self.head.clone().unwrap_or_default(),
            remote: self.remote.clone().unwrap_or_default(),
            remote_url: self.remote_url.clone().unwrap_or_default(),
            ahead: self.ahead(),
            dirty: self.dirty,
            default_branch: self.default_branch.clone(),
            linked: self.linked,
        }
    }
}

async fn line(cwd: &Path, args: &[&str]) -> Option<String> {
    let o = git(cwd, args, QUICK).await.ok().filter(|o| o.ok())?;
    Some(o.line()).filter(|l| !l.is_empty())
}

/// Facts of the checkout holding `cwd` (`None`: not in a git repository). With `network`, the
/// remote is asked (fetch of the branch, push dry-run); otherwise only local refs are read.
pub async fn git_facts(cwd: &Path, network: bool) -> Result<Option<GitFacts>, ApiError> {
    let Some(top) = git::repo_top(cwd).await? else { return Ok(None) };
    let mut g = GitFacts { top: top.top.clone(), root: top.root.clone(), ..Default::default() };
    let t = &g.top.clone();
    let real_cwd = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let real_top = std::fs::canonicalize(t).unwrap_or_else(|_| t.clone());
    g.subdir = real_cwd
        .strip_prefix(&real_top)
        .map(|p| p.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"))
        .unwrap_or_default();
    if let Some(dirs) = line(t, &["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]).await {
        let mut it = dirs.lines();
        g.linked = matches!((it.next(), it.next()), (Some(a), Some(b)) if a != b);
    }
    g.branch = line(t, &["symbolic-ref", "-q", "--short", "HEAD"]).await;
    g.head = line(t, &["rev-parse", "-q", "--verify", "HEAD^{commit}"]).await;
    let remotes: Vec<String> = git(t, &["remote"], QUICK).await.map(|o| o.stdout_str()).unwrap_or_default().lines().filter(|l| !l.is_empty()).map(str::to_string).collect();
    let configured = match &g.branch {
        Some(b) => line(t, &["config", "--get", &format!("branch.{b}.remote")]).await.filter(|r| r != "." && remotes.contains(r)),
        None => None,
    };
    g.remote = configured.or_else(|| remotes.iter().find(|r| *r == "origin").cloned()).or_else(|| remotes.first().cloned());
    if let Some(r) = &g.remote {
        g.remote_url = line(t, &["remote", "get-url", r]).await;
    }
    g.default_branch = git::default_branch(t).await.map(|d| d.name);
    if let (Some(branch), Some(remote)) = (g.branch.clone(), g.remote.clone()) {
        let tracking = format!("refs/remotes/{remote}/{branch}");
        // Always asked anew (not `fetch_branch`'s 20 s fan-out cache): the job re-checks right
        // before pushing, and a remote that changed since the preflight must be seen.
        let fetched = if network {
            let refspec = format!("refs/heads/{branch}");
            Some(match git_remote(t, &["fetch", "--quiet", remote.as_str(), refspec.as_str()], FETCH).await {
                Ok(o) if o.ok() => Ok(()),
                Ok(o) => Err(o.message()),
                Err(e) => Err(e.message),
            })
        } else {
            None
        };
        g.remote_branch = match fetched {
            Some(Err(msg)) if msg.contains("couldn't find remote ref") => RemoteBranch::Missing,
            Some(Err(msg)) => RemoteBranch::Unreachable(first_line(&msg)),
            _ => match line(t, &["rev-parse", "-q", "--verify", &format!("{tracking}^{{commit}}")]).await {
                Some(_) => {
                    let counts = line(t, &["rev-list", "--left-right", "--count", &format!("HEAD...{tracking}")]).await.unwrap_or_default();
                    let mut it = counts.split_whitespace().map(|n| n.parse::<u32>().unwrap_or(0));
                    RemoteBranch::Tracking { ahead: it.next().unwrap_or(0), behind: it.next().unwrap_or(0) }
                }
                None if network => RemoteBranch::Missing,
                None => RemoteBranch::Unknown,
            },
        };
        let pushable = matches!(g.remote_branch, RemoteBranch::Missing | RemoteBranch::Tracking { behind: 0, .. });
        if network && g.head.is_some() && g.needs_push() && pushable {
            let dst = format!("HEAD:refs/heads/{branch}");
            g.push = Some(match git_remote(t, &["push", "--dry-run", "--porcelain", "--no-verify", &remote, &dst], DRY_RUN).await {
                Ok(o) if o.ok() => Ok(()),
                Ok(o) => Err(first_line(&push_message(&o.message()))),
                Err(e) => Err(e.message),
            });
        }
    }
    let status = git(t, &["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=dirty"], Duration::from_secs(30)).await?;
    if status.ok() {
        let paths = changed_paths(&status.stdout);
        g.dirty = paths.len() as u32;
        let top = g.top.clone();
        g.changes_bytes = tokio::task::spawn_blocking(move || {
            paths.iter().filter_map(|p| std::fs::symlink_metadata(top.join(p)).ok()).filter(|m| m.is_file()).map(|m| m.len()).sum()
        })
        .await
        .unwrap_or(0);
    }
    Ok(Some(g))
}

/// git's push report without its `To <url>` and `Done` lines.
fn push_message(msg: &str) -> String {
    let kept: Vec<&str> = msg.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with("To ") && *l != "Done").collect();
    if kept.is_empty() { msg.trim().to_string() } else { kept.join("; ") }
}

fn first_line(s: &str) -> String {
    let l = s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    l.trim_start_matches("fatal: ").trim_start_matches("error: ").chars().take(300).collect()
}

/// Paths of `git status --porcelain=v1 -z` (renames: the new path).
pub fn changed_paths(raw: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    let mut fields = raw.split(|b| *b == 0).filter(|f| !f.is_empty());
    while let Some(f) = fields.next() {
        if f.len() < 4 {
            continue;
        }
        out.push(String::from_utf8_lossy(&f[3..]).into_owned());
        if f[0] == b'R' || f[0] == b'C' {
            fields.next();
        }
    }
    out
}

/// What stops the code from moving (or is worth knowing).
pub fn git_issues(g: &GitFacts) -> Vec<MoveIssue> {
    let mut out = Vec::new();
    let top = g.top.display();
    let Some(branch) = &g.branch else {
        out.push(blocker("detached", format!("HEAD is detached in {top}"), Some("Check out a branch first: the target checks out the same branch.".into())));
        return out;
    };
    if g.head.is_none() {
        out.push(blocker("noCommits", format!("{branch} has no commits yet"), Some("Commit once first.".into())));
        return out;
    }
    let Some(remote) = &g.remote else {
        out.push(blocker(
            "noRemote",
            format!("{} has no remote to push {branch} to", g.root.display()),
            Some("Add one (git remote add origin <url>): the target fetches the branch from it.".into()),
        ));
        return out;
    };
    match &g.remote_branch {
        RemoteBranch::Unreachable(msg) => out.push(blocker(
            "remoteUnreachable",
            format!("Cannot reach {remote}: {msg}"),
            Some(format!("Check the network and this host's git credentials for {remote}.")),
        )),
        RemoteBranch::Tracking { ahead, behind } if *ahead > 0 && *behind > 0 => out.push(blocker(
            "diverged",
            format!("{remote}/{branch} and {branch} have both moved on ({ahead} ahead, {behind} behind)"),
            Some("Pull or rebase the agent's branch first (or ask the agent to).".into()),
        )),
        _ => {}
    }
    if let Some(Err(msg)) = &g.push {
        out.push(blocker(
            "pushRejected",
            format!("Pushing {branch} to {remote} fails: {msg}"),
            Some("Fix that first (credentials, branch protection, a newer remote branch).".into()),
        ));
    }
    if g.needs_push() && g.default_branch.as_deref() == Some(branch.as_str()) && !matches!(g.remote_branch, RemoteBranch::Unreachable(_)) {
        let what = match g.ahead() {
            Some(n) => format!("{n} commit{} of {branch}", if n == 1 { "" } else { "s" }),
            None => branch.clone(),
        };
        out.push(warning("pushDefault", format!("Moving pushes {what} straight to {remote}/{branch}"), None));
    }
    if g.dirty > 0 && g.changes_bytes > MAX_CHANGES {
        out.push(blocker(
            "changesTooLarge",
            format!("{} uncommitted files ({}) are too large to carry (at most {})", g.dirty, bytes(g.changes_bytes), bytes(MAX_CHANGES)),
            Some("Commit them, or .gitignore build output and logs, then move.".into()),
        ));
    }
    out
}

/// `move.check`, and the facts behind it. `network`: ask the remote (the preflight and the job);
/// without it, only what the local refs say.
pub async fn check(ctx: &Ctx, agent_id: &str, network: bool) -> Result<(MoveCheck, Subject, Option<GitFacts>), ApiError> {
    let s = subject(ctx, agent_id)?;
    let omp_version = ctx.state.snapshot().info.omp.map(|v| v.version);
    let mut issues = agent_issues(&s, omp_version.as_deref());
    let stats = match s.session_file.clone() {
        Some(f) => tokio::task::spawn_blocking(move || session_stats(Path::new(&f))).await.map_err(|e| ApiError::new("internal", e.to_string()))?,
        None => Ok(SessionStats::default()),
    };
    issues.extend(session_issues(&s.name, s.session_file.as_deref(), &stats));
    let stats = stats.unwrap_or_default();
    let cwd = s.cwd.clone().unwrap_or_default();
    let git = if cwd.is_empty() {
        issues.push(blocker("noFolder", format!("no folder is known for {}", s.name), None));
        None
    } else if !Path::new(&cwd).is_dir() {
        issues.push(blocker("noFolder", format!("{cwd} no longer exists"), Some("Its folder or worktree was removed.".into())));
        None
    } else {
        let g = git_facts(Path::new(&cwd), network).await?;
        match &g {
            Some(g) => issues.extend(git_issues(g)),
            None => issues.push(warning(
                "noGit",
                format!("{cwd} is not in a git repository: only the conversation moves"),
                Some("Pick the folder it continues in on the target.".into()),
            )),
        }
        g
    };
    let own = Store::new(&ctx.paths).get(&ctx.herdr_session, agent_id).map(|r| r.omp).unwrap_or_default();
    let check = MoveCheck {
        agent_id: s.agent_id.clone(),
        name: s.name.clone(),
        title: s.title.clone(),
        cwd,
        git: git.as_ref().map(GitFacts::to_wire),
        session_id: s.session_id.clone(),
        session_file: s.session_file.clone().unwrap_or_default(),
        session_bytes: stats.bytes,
        artifact_files: stats.artifact_files,
        subagent_transcripts: stats.subagent_transcripts,
        changes_bytes: git.as_ref().map(|g| g.changes_bytes).unwrap_or(0),
        model: s.model.clone(),
        thinking: s.thinking,
        role_models: own.role_models,
        fallback_chains: own.fallback_chains,
        auto_answer: crate::autoanswer::own(ctx, agent_id),
        parked: s.parked.is_some(),
        omp_version,
        issues,
    };
    Ok((check, s, git))
}

// ───────────────────────────── the target ─────────────────────────────

/// Free bytes of the file system holding `path`.
pub fn free_bytes(path: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        // SAFETY: `c` is a valid NUL-terminated path and `st` a properly sized out-param.
        if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
            return None;
        }
        Some(st.f_bavail as u64 * st.f_frsize as u64)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

/// Bytes a move needs on the target: the uploaded parts, the session they unpack to, and a margin.
pub fn space_needed(c: &MoveCheck) -> u64 {
    (c.session_bytes + c.changes_bytes) * 2 + (64 << 20)
}

/// Checkouts on this host that agents moved away from (parked `moved` cards): their leftover
/// uncommitted changes are stale and may be stashed when the branch comes back.
pub fn stale_checkouts(records: &[ParkedRecord]) -> Vec<PathBuf> {
    records
        .iter()
        .filter(|r| r.moved.as_ref().is_some_and(|m| m.state == ParkedMoveState::Moved))
        .flat_map(|r| r.worktree.as_ref().map(|w| PathBuf::from(&w.path)).into_iter().chain(r.cwd.as_ref().map(PathBuf::from)))
        .collect()
}

/// `checkout` (a worktree top) is exactly one of `stale`: a parked card's worktree or folder that
/// agents moved away from. A parked folder inside the checkout does not make the checkout stale
/// (the changes may be the user's own).
pub fn is_stale(checkout: &Path, stale: &[PathBuf]) -> bool {
    let top = std::fs::canonicalize(checkout).unwrap_or_else(|_| checkout.to_path_buf());
    stale.iter().any(|s| std::fs::canonicalize(s).unwrap_or_else(|_| s.clone()) == top)
}

/// `(name, folder)` of the agents running on this board (not parked, not `except`).
pub fn live_cwds(agents: &[Agent], except: &str) -> Vec<(String, PathBuf)> {
    agents.iter().filter(|a| a.parked.is_none() && a.id != except).filter_map(|a| a.cwd.as_ref().map(|c| (a.name.clone(), PathBuf::from(c)))).collect()
}

/// The names of the live agents working in `checkout` or below it (also through symlinks).
pub fn occupants<'a>(live: &'a [(String, PathBuf)], checkout: &Path) -> Vec<&'a str> {
    let top = std::fs::canonicalize(checkout).unwrap_or_else(|_| checkout.to_path_buf());
    live.iter()
        .filter(|(_, cwd)| cwd.starts_with(checkout) || std::fs::canonicalize(cwd).is_ok_and(|c| c.starts_with(&top)))
        .map(|(name, _)| name.as_str())
        .collect()
}

/// A remote address git would read as an option (`-…`): never passed on.
pub fn remote_is_option(url: &str) -> bool {
    url.trim_start().starts_with('-')
}

/// Folders worth checking for a clone of the repository: what this host's board knows, the
/// source's own path, and `<home>/[src|code|projects|…]/<name>`.
fn candidates(ctx: &Ctx, g: &MoveGit) -> Vec<PathBuf> {
    let snap = ctx.state.snapshot();
    let mut dirs: Vec<PathBuf> = Vec::new();
    for w in &snap.workspaces {
        dirs.extend(w.repo.as_ref().map(|r| PathBuf::from(&r.root)));
        dirs.push(PathBuf::from(&w.cwd));
    }
    dirs.extend(snap.agents.iter().filter_map(|a| a.cwd.as_ref().map(PathBuf::from)));
    for r in ctx.state.parked_all() {
        dirs.extend(r.worktree.map(|w| PathBuf::from(w.repo_root)));
        dirs.extend(r.cwd.map(PathBuf::from));
    }
    dirs.push(PathBuf::from(&g.repo_root));
    let home = crate::paths::home_dir();
    let mut names = vec![g.repo_name.clone()];
    names.extend(url::repo_name(&g.remote_url));
    for name in names.iter().filter(|n| !n.is_empty()) {
        for parent in ["", "src", "code", "Code", "projects", "Projects", "dev", "Developer", "git", "work", "repos", "workspace", "workspaces"] {
            dirs.push(if parent.is_empty() { home.join(name) } else { home.join(parent).join(name) });
        }
    }
    let mut seen = HashSet::new();
    dirs.into_iter().filter(|d| d.is_dir() && seen.insert(d.clone())).take(MAX_CANDIDATES).collect()
}

/// The remote of the repository at `root` whose URL names the same repository as `url`.
async fn matching_remote(root: &Path, want: &str) -> Option<(String, String)> {
    let out = git(root, &["remote", "-v"], QUICK).await.ok().filter(|o| o.ok())?;
    out.stdout_str().lines().find_map(|l| {
        let mut it = l.split_whitespace();
        let (name, u) = (it.next()?, it.next()?);
        url::same_repo(u, want).then(|| (name.to_string(), u.to_string()))
    })
}

pub async fn commit_exists(root: &Path, sha: &str) -> bool {
    !sha.is_empty() && git(root, &["cat-file", "-e", &format!("{sha}^{{commit}}")], QUICK).await.is_ok_and(|o| o.ok())
}

pub async fn is_ancestor(root: &Path, a: &str, b: &str) -> bool {
    git(root, &["merge-base", "--is-ancestor", a, b], QUICK).await.is_ok_and(|o| o.ok())
}

pub async fn rev(root: &Path, r: &str) -> Option<String> {
    line(root, &["rev-parse", "-q", "--verify", &format!("{r}^{{commit}}")]).await
}

pub async fn worktrees(root: &Path) -> Vec<git::WorktreeRecord> {
    match git(root, &["worktree", "list", "--porcelain"], QUICK).await {
        Ok(o) if o.ok() => git::parse_worktree_porcelain(&o.stdout_str()).into_iter().filter(|w| !w.bare && !w.prunable).collect(),
        _ => Vec::new(),
    }
}

/// How a clone takes the branch: the checkout already holding it (it must be clean, or stale,
/// and fast-forward to the source's head), else a new linked worktree (a local branch of that
/// name must fast-forward too). Ancestry is only judged when the source's head is here already
/// (fetched before); otherwise `move.receive` judges it after fetching.
pub async fn plan_repo(root: &Path, remote: String, remote_url: String, g: &MoveGit, stale: &[PathBuf], live: &[(String, PathBuf)]) -> MoveRepo {
    let mut issues = Vec::new();
    let has_head = commit_exists(root, &g.head).await;
    let local = rev(root, &format!("refs/heads/{}", g.branch)).await;
    let holder = worktrees(root).await.into_iter().find(|w| w.branch.as_deref() == Some(g.branch.as_str()));
    let (checkout, checkout_path) = match holder {
        Some(w) => {
            let path = PathBuf::from(&w.path);
            let dirty = git::dirty_count(&path, QUICK).await.unwrap_or(0);
            if dirty > 0 {
                issues.push(if is_stale(&path, stale) {
                    warning(
                        "staleChanges",
                        format!("{} has {dirty} changed file(s) left from when an agent moved away from it", path.display()),
                        Some("They are stashed (git stash) before the branch moves on.".into()),
                    )
                } else {
                    blocker(
                        "dirtyCheckout",
                        format!("{} is checked out at {} with {dirty} uncommitted file(s)", g.branch, path.display()),
                        Some("Commit, stash or discard them there first, or pick another clone.".into()),
                    )
                });
            }
            let here = occupants(live, &path);
            if !here.is_empty() {
                let who = here.join(", ");
                // Files would change under it when the branch moves on (or changes are stashed).
                let moves_files = dirty > 0 || w.head.as_deref() != Some(g.head.as_str());
                issues.push(if moves_files {
                    blocker(
                        "agentInCheckout",
                        format!("{who} works in {}, where {} is checked out: the branch would move under it", path.display(), g.branch),
                        Some("Close or move that agent first, or pick another clone.".into()),
                    )
                } else {
                    warning("agentInCheckout", format!("{who} works in {} too: the two agents share that checkout", path.display()), None)
                });
            }
            if let Some(cur) = w.head.as_deref().filter(|c| has_head && *c != g.head)
                && !is_ancestor(root, cur, &g.head).await
            {
                issues.push(blocker(
                    "branchDiverged",
                    format!("{} at {} has commits the moving branch does not have", g.branch, path.display()),
                    Some("Merge or push them into the agent's branch first, or pick another clone.".into()),
                ));
            }
            (MoveCheckout::Existing, Some(w.path))
        }
        None => {
            if let Some(l) = local.as_deref().filter(|l| has_head && *l != g.head)
                && !is_ancestor(root, l, &g.head).await
            {
                issues.push(blocker(
                    "branchDiverged",
                    format!("The local branch {} here has commits the moving branch does not have", g.branch),
                    Some("Merge or push them first, rename that branch, or pick another clone.".into()),
                ));
            }
            (MoveCheckout::NewWorktree, None)
        }
    };
    MoveRepo { path: root.display().to_string(), remote, remote_url, checkout, checkout_path, branch_exists: local.is_some(), issues }
}

/// Best clone first: no blockers, then the checkout already holding the branch, then the
/// source's own path.
pub fn rank(repos: &mut [MoveRepo], source_root: &str) {
    repos.sort_by_key(|r| (has_blocker(&r.issues), r.checkout != MoveCheckout::Existing, r.path != source_root));
}

/// Where a missing repository is cloned: the source's path when its parent exists here, else
/// `<home>/src/<name>` when `~/src` exists, else `<home>/<name>`; never an existing folder.
pub fn clone_path(home: &Path, g: &MoveGit) -> PathBuf {
    let name = if g.repo_name.is_empty() { url::repo_name(&g.remote_url).unwrap_or_else(|| "repo".into()) } else { g.repo_name.clone() };
    let same = PathBuf::from(&g.repo_root);
    let mut tries = Vec::new();
    if same.is_absolute() && same.parent().is_some_and(Path::is_dir) {
        tries.push(same);
    }
    if home.join("src").is_dir() {
        tries.push(home.join("src").join(&name));
    }
    tries.push(home.join(&name));
    if let Some(free) = tries.iter().find(|p| !p.exists()) {
        return free.clone();
    }
    (2..).map(|n| home.join(format!("{name}-{n}"))).find(|p| !p.exists()).unwrap_or_else(|| home.join(name))
}

/// `move.probe`.
pub async fn probe(ctx: &Ctx, p: MoveProbeParams) -> Result<MoveProbe, ApiError> {
    let info = ctx.state.snapshot().info;
    let host = if info.hostname.is_empty() { "this host".to_string() } else { info.hostname.clone() };
    let mut issues = Vec::new();
    match info.omp.as_ref() {
        None => issues.push(blocker("ompMissing", format!("omp is not installed on {host}"), Some("Install it from Host setup.".into()))),
        Some(v) if !ompcli::supports_transfer(&v.version) => issues.push(blocker(
            "ompTooOld",
            format!("omp {} on {host} cannot unpack sessions (needs 18.10)", v.version),
            Some("Update omp there (Host setup).".into()),
        )),
        Some(_) => {}
    }
    let free = free_bytes(&ctx.paths.home);
    let need = space_needed(&p.source);
    if let Some(f) = free.filter(|f| *f < need) {
        issues.push(blocker("diskSpace", format!("{host} has {} free; the move needs about {}", bytes(f), bytes(need)), Some("Free some space there first.".into())));
    }
    if let Some(m) = &p.source.model
        && let Ok(cat) = crate::ops::host::models().await
        && !cat.models.iter().any(|x| format!("{}/{}", x.provider, x.id) == *m)
    {
        issues.push(warning(
            "modelMissing",
            format!("{host} has no {m}: the agent resumes with its default model there"),
            Some("Link that provider's account there (Accounts), or switch models after the move.".into()),
        ));
    }
    let mut repos = Vec::new();
    let mut clone = None;
    match &p.source.git {
        None => issues.push(warning(
            "noGit",
            "Only the conversation moves: the agent was not in a git repository",
            Some(format!("Pick the folder it continues in on {host}.")),
        )),
        Some(g) => {
            let stale = stale_checkouts(&ctx.state.parked_all());
            let live = live_cwds(&ctx.state.snapshot().agents, &p.source.agent_id);
            let picked = p.repo_path.as_deref().map(str::trim).filter(|s| !s.is_empty());
            let dirs = match picked {
                Some(d) => vec![crate::ops::fs::resolve_path(d)?],
                None => candidates(ctx, g),
            };
            let mut roots = HashSet::new();
            for dir in dirs {
                let Ok(Some(top)) = git::repo_top(&dir).await else {
                    if picked.is_some() {
                        issues.push(blocker("otherRepo", format!("{} is not a git repository", dir.display()), None));
                    }
                    continue;
                };
                let root = std::fs::canonicalize(&top.root).unwrap_or(top.root.clone());
                if !roots.insert(root.clone()) {
                    continue;
                }
                match matching_remote(&top.root, &g.remote_url).await {
                    Some((remote, remote_url)) => repos.push(plan_repo(&top.root, remote, remote_url, g, &stale, &live).await),
                    None if picked.is_some() => issues.push(blocker(
                        "otherRepo",
                        format!("{} has no remote for {}", top.root.display(), g.remote_url),
                        Some(format!("Add it there (git remote add origin {}), or pick another folder.", g.remote_url)),
                    )),
                    None => {}
                }
            }
            rank(&mut repos, &g.repo_root);
            if picked.is_none() && repos.iter().all(|r| has_blocker(&r.issues)) {
                let path = clone_path(&crate::paths::home_dir(), g);
                let home = crate::paths::home_dir();
                let listed = if remote_is_option(&g.remote_url) {
                    Err(ApiError::new("invalid_params", format!("`{}` is not a repository address", g.remote_url)))
                } else {
                    git_remote(&home, &["ls-remote", "--heads", "--", g.remote_url.as_str()], LS_REMOTE).await
                };
                match listed {
                    Ok(o) if o.ok() => {
                        issues.push(warning(
                            "noRepo",
                            format!("{} has no usable clone of {}: it is cloned into {}", host, g.remote_url, path.display()),
                            Some("Or pick a folder that holds a clone.".into()),
                        ));
                        clone = Some(path.display().to_string());
                    }
                    res => {
                        let why = match res {
                            Ok(o) => first_line(&o.message()),
                            Err(e) => e.message,
                        };
                        issues.push(blocker(
                            "noRepo",
                            format!("{host} has no usable clone of {}, and cannot clone it: {why}", g.remote_url),
                            Some(format!("Clone it there, or set up {host}'s git credentials, then check again.")),
                        ));
                    }
                }
            }
        }
    }
    Ok(MoveProbe { hostname: host, omp_version: info.omp.map(|v| v.version), repos, clone_path: clone, free_bytes: free, issues })
}
