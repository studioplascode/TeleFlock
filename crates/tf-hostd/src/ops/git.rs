//! `git.*` methods plus the process runner and git helpers shared by the other HostdOps
//! families (`fs` badges, `worktree` dirty counts, `gh`).
//!
//! Every git invocation runs with `GIT_OPTIONAL_LOCKS=0` (status never takes the index lock
//! that a running agent may need), `GIT_TERMINAL_PROMPT=0` (never hang on credentials),
//! `LC_ALL=C` (stable parseable messages) and a hard timeout (the child is killed on expiry).

use std::collections::HashMap;
use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tf_proto::{
    ApiError, BranchInfo, BranchList, ChangedFile, CommandOutput, FileStatus, GitBadge,
    GitCommitParams, GitCommitResult, GitDiffParams, GitDiffResult, GitStatusResult, HostMethod,
    RepoInfo,
};
use tokio::io::AsyncWriteExt;

use crate::clients::ClientHandle;
use crate::ops::{to_value, Ctx};

/// Patch bytes returned by `git.diff` before truncating.
pub const DIFF_CAP_BYTES: usize = 2 * 1024 * 1024;
/// Untracked files rendered into a `git.diff` patch.
const UNTRACKED_PATCH_FILES: usize = 200;
/// Untracked files larger than this are listed but not rendered / line-counted.
const UNTRACKED_TEXT_MAX: u64 = 1024 * 1024;
const QUICK: Duration = Duration::from_secs(10);
const SLOW: Duration = Duration::from_secs(60);
const NETWORK: Duration = Duration::from_secs(180);

pub async fn handle(ctx: &Ctx, req: HostMethod, _client: &ClientHandle) -> Result<Value, ApiError> {
    match req {
        HostMethod::GitStatus(p) => to_value(status(&crate::ops::fs::resolve_path(&p.cwd)?).await?),
        HostMethod::GitBranches(p) => to_value(branches(&crate::ops::fs::resolve_path(&p.cwd)?).await?),
        HostMethod::GitDiff(p) => to_value(diff(&p).await?),
        HostMethod::GitCommit(p) => {
            let res = commit(&p).await?;
            let cwd = crate::ops::fs::resolve_path(&p.cwd)?;
            if let Ok(root) = toplevel(&cwd).await {
                record_commit(ctx, &root, &res);
                refresh_repo_badges(ctx, &cwd, &root);
            }
            to_value(res)
        }
        HostMethod::GitPush(p) => {
            let cwd = crate::ops::fs::resolve_path(&p.cwd)?;
            let out = push(&cwd).await?;
            if let Ok(root) = toplevel(&cwd).await {
                refresh_repo_badges(ctx, &cwd, &root);
            }
            to_value(out)
        }
        other => Err(ApiError::new("unknown_method", format!("{} is not a git method", other.name()))),
    }
}

/// Workspace repo badges (dirty / ahead) are cached by the state store per folder.
fn refresh_repo_badges(ctx: &Ctx, cwd: &Path, root: &Path) {
    ctx.state.refresh_repo(&cwd.display().to_string());
    if root != cwd {
        ctx.state.refresh_repo(&root.display().to_string());
    }
}

/// Records a `committed` activity on the agents working in that checkout (cwd inside
/// `root`, the work-tree top level).
fn record_commit(ctx: &Ctx, root: &Path, res: &GitCommitResult) {
    let short: String = res.sha.chars().take(7).collect();
    for agent in ctx.state.snapshot().agents {
        if agent.cwd.as_deref().is_some_and(|c| Path::new(c).starts_with(root)) {
            ctx.state.record_activity(&agent.id, tf_proto::ActivityKind::Committed, format!("Committed {short}"), Some(res.summary.clone()));
        }
    }
}

// ───────────────────────────── process runner ─────────────────────────────

/// Output of a finished child process.
#[derive(Debug, Clone)]
pub(crate) struct CmdOut {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl CmdOut {
    pub fn ok(&self) -> bool {
        self.code == 0
    }
    pub fn stdout_str(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
    /// stdout trimmed of the trailing newline.
    pub fn line(&self) -> String {
        self.stdout_str().trim_end_matches(['\n', '\r']).to_string()
    }
    /// Best human message: stderr, else stdout, trimmed.
    pub fn message(&self) -> String {
        let s = self.stderr.trim();
        if s.is_empty() { self.stdout_str().trim().to_string() } else { s.to_string() }
    }
}

/// Runs `program args…` without a shell. `io::ErrorKind::NotFound` = binary missing,
/// `io::ErrorKind::TimedOut` = killed after `timeout`.
pub(crate) async fn run_cmd<S: AsRef<OsStr>>(
    program: &Path,
    args: &[S],
    cwd: Option<&Path>,
    env: &[(&str, &str)],
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> io::Result<CmdOut> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: never flash a console window from the background daemon.
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn()?;
    if let Some(input) = stdin
        && let Some(mut pipe) = child.stdin.take() {
            let input = input.to_vec();
            tokio::spawn(async move {
                let _ = pipe.write_all(&input).await;
                let _ = pipe.shutdown().await;
            });
        }
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(out) => {
            let out = out?;
            Ok(CmdOut {
                code: out.status.code().unwrap_or(-1),
                stdout: out.stdout,
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            })
        }
        Err(_) => Err(io::Error::new(io::ErrorKind::TimedOut, format!("timed out after {}s", timeout.as_secs()))),
    }
}

/// Locates an executable: `PATH` first, then the well-known install dirs
/// ([`crate::userenv::well_known_dirs`]: `~/.local/bin`, `~/.bun/bin`, …) that a daemon started
/// without the user's interactive PATH may lack.
pub(crate) fn resolve_bin(name: &str) -> Option<PathBuf> {
    bin_candidates(name).next()
}

/// Every match of [`resolve_bin`]'s search, in its order, each once.
pub(crate) fn resolve_bin_all(name: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for cand in bin_candidates(name) {
        if !out.contains(&cand) {
            out.push(cand);
        }
    }
    out
}

fn bin_candidates(name: &str) -> impl Iterator<Item = PathBuf> + '_ {
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat", ""] } else { &[""] };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    let home = crate::ops::fs::home_dir();
    if cfg!(windows) {
        for rel in [".local/bin", ".bun/bin", ".cargo/bin", ".npm-global/bin", "bin"] {
            dirs.push(home.join(rel));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let local = PathBuf::from(local);
            dirs.push(local.join("Programs").join("Herdr").join("bin"));
            dirs.push(local.join("Programs").join("Git").join("cmd"));
        }
        for pf in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(p) = std::env::var_os(pf) {
                dirs.push(PathBuf::from(&p).join("Git").join("cmd"));
                dirs.push(PathBuf::from(&p).join("GitHub CLI"));
            }
        }
    } else {
        dirs.extend(crate::userenv::well_known_dirs(&home));
    }
    dirs.into_iter()
        .flat_map(move |dir| exts.iter().map(move |ext| dir.join(format!("{name}{ext}"))))
        .filter(|cand| is_executable(cand))
}

pub(crate) fn is_executable(p: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(p) else { return false };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// git, found once (a missing git is looked up again on every call: Host setup can install it).
fn git_bin() -> Result<PathBuf, ApiError> {
    static GIT: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);
    let mut git = GIT.lock().unwrap_or_else(|p| p.into_inner());
    if git.is_none() {
        *git = resolve_bin("git");
    }
    git.clone().ok_or_else(|| {
        ApiError::new("git_error", "git is not installed on this host").with_hint("Install git and make sure it is on PATH.")
    })
}

const GIT_ENV: &[(&str, &str)] = &[
    ("GIT_OPTIONAL_LOCKS", "0"),
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GIT_PAGER", "cat"),
    ("LC_ALL", "C"),
    ("GCM_INTERACTIVE", "never"),
];

/// `core.hooksPath` for calls that must not run hooks: a path that can never hold one.
const NO_HOOKS: &str = if cfg!(windows) { "core.hooksPath=NUL" } else { "core.hooksPath=/dev/null" };

/// Subcommands the user explicitly asked to mutate the repository with; they keep the
/// repository's hooks (pre-commit, pre-push, post-checkout, …). Everything else runs hookless.
const HOOKED: &[&str] = &["add", "commit", "push", "pull", "merge", "rebase", "checkout", "switch", "cherry-pick", "revert", "am"];

/// Full argument list for one git call. Repository config can name programs (`core.fsmonitor`,
/// hooks, textconv / external diff drivers) and `fs.list` runs git in folders the user only
/// browses, so: fsmonitor is always off, read-only calls get no hooks, and diff-producing
/// subcommands never run textconv or external diff drivers.
fn hardened_args<S: AsRef<OsStr>>(args: &[S]) -> Vec<&OsStr> {
    let sub = args.first().map(|a| a.as_ref());
    let is = |name: &str| sub == Some(OsStr::new(name));
    let hooked = HOOKED.iter().any(|h| is(h)) || (is("worktree") && args.get(1).is_some_and(|a| a.as_ref() == OsStr::new("add")));
    let mut full: Vec<&OsStr> =
        ["-c", "core.quotepath=off", "-c", "color.ui=never", "-c", "core.fsmonitor=false"].into_iter().map(OsStr::new).collect();
    if !hooked {
        full.extend([OsStr::new("-c"), OsStr::new(NO_HOOKS)]);
    }
    let mut rest = args.iter().map(|a| a.as_ref());
    full.extend(rest.next());
    if is("diff") || is("show") || is("log") {
        full.extend([OsStr::new("--no-textconv"), OsStr::new("--no-ext-diff")]);
    }
    full.extend(rest);
    full
}

/// Runs git in `cwd` (arguments hardened by [`hardened_args`]). Non-zero exits are returned
/// (callers decide); spawn failures and timeouts become `git_error`.
pub(crate) async fn git<S: AsRef<OsStr>>(cwd: &Path, args: &[S], timeout: Duration) -> Result<CmdOut, ApiError> {
    git_with_input(cwd, args, None, timeout).await
}

pub(crate) async fn git_with_input<S: AsRef<OsStr>>(
    cwd: &Path,
    args: &[S],
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<CmdOut, ApiError> {
    git_run(cwd, args, stdin, &[], timeout).await
}

/// [`git_with_input`] with extra environment on top of [`GIT_ENV`].
async fn git_run<S: AsRef<OsStr>>(
    cwd: &Path,
    args: &[S],
    stdin: Option<&[u8]>,
    extra_env: &[(&str, &str)],
    timeout: Duration,
) -> Result<CmdOut, ApiError> {
    let bin = git_bin()?;
    let full = hardened_args(args);
    let env: std::borrow::Cow<[(&str, &str)]> =
        if extra_env.is_empty() { GIT_ENV.into() } else { GIT_ENV.iter().chain(extra_env).copied().collect::<Vec<_>>().into() };
    run_cmd(&bin, &full, Some(cwd), &env, stdin, timeout).await.map_err(|e| match e.kind() {
        io::ErrorKind::TimedOut => ApiError::new("timeout", format!("git {} timed out", first_arg(args))).retryable(),
        io::ErrorKind::NotFound if !cwd.exists() => {
            ApiError::new("not_found", format!("{} does not exist", cwd.display()))
        }
        _ => ApiError::new("git_error", format!("failed to run git: {e}")),
    })
}

fn first_arg<S: AsRef<OsStr>>(args: &[S]) -> String {
    args.first().map(|a| a.as_ref().to_string_lossy().into_owned()).unwrap_or_default()
}

/// Like [`git`] but a non-zero exit becomes a `git_error` carrying git's message.
pub(crate) async fn git_ok<S: AsRef<OsStr>>(cwd: &Path, args: &[S], timeout: Duration) -> Result<CmdOut, ApiError> {
    let out = git(cwd, args, timeout).await?;
    if out.ok() { Ok(out) } else { Err(git_failure(&out, &first_arg(args))) }
}

/// Maps a failed git run to an `ApiError` with a hint for the common causes.
pub(crate) fn git_failure(out: &CmdOut, what: &str) -> ApiError {
    let msg = out.message();
    let lower = msg.to_lowercase();
    let err = ApiError::new("git_error", if msg.is_empty() { format!("git {what} failed (exit {})", out.code) } else { msg.clone() });
    if lower.contains("not a git repository") {
        ApiError::new("not_found", msg).with_hint("This folder is not inside a git repository.")
    } else if lower.contains("dubious ownership") {
        ApiError::new("permission_denied", msg)
            .with_hint("The repository is owned by another user. Trust it (herdr --trust-repository) or fix ownership.")
    } else if lower.contains("please tell me who you are") || lower.contains("author identity unknown") {
        err.with_hint("Set an identity on the host: git config --global user.name … and user.email ….")
    } else if lower.contains("nothing to commit") || lower.contains("no changes added to commit") {
        err.with_hint("There are no changes to commit (enable \"stage all\" to include unstaged files).")
    } else if lower.contains("could not read username")
        || lower.contains("authentication failed")
        || lower.contains("permission denied (publickey)")
        || lower.contains("terminal prompts disabled")
    {
        ApiError::new("auth_required", msg).with_hint("git needs credentials for this remote. Configure an SSH key or credential helper on the host.")
    } else if lower.contains("rejected") && (lower.contains("fetch first") || lower.contains("non-fast-forward")) {
        err.with_hint("The remote has new commits. Pull or rebase first.")
    } else if lower.contains("no configured push destination") || lower.contains("does not appear to be a git repository") {
        err.with_hint("Add a remote first: git remote add origin <url>.")
    } else if lower.contains("index.lock") {
        err.retryable().with_hint("Another git process is running in this repository. Try again in a moment.")
    } else {
        err
    }
}

// ───────────────────────────── parsers ─────────────────────────────

/// `git status --porcelain=v2 --branch -z`.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct StatusV2 {
    pub oid: Option<String>,
    /// `None` when detached.
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub entries: Vec<StatusEntry>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct StatusEntry {
    pub path: String,
    pub status: FileStatus,
    pub old_path: Option<String>,
}

fn status_from_xy(xy: &str) -> FileStatus {
    let mut chars = xy.chars();
    let x = chars.next().unwrap_or('.');
    let y = chars.next().unwrap_or('.');
    let pick = |c: char| match c {
        'A' => Some(FileStatus::Added),
        'D' => Some(FileStatus::Deleted),
        'R' | 'C' => Some(FileStatus::Renamed),
        'M' | 'T' | 'U' => Some(FileStatus::Modified),
        _ => None,
    };
    pick(x).or_else(|| pick(y)).unwrap_or(FileStatus::Modified)
}

pub(crate) fn parse_status_v2(raw: &[u8]) -> StatusV2 {
    let mut st = StatusV2::default();
    let text = String::from_utf8_lossy(raw);
    let mut records = text.split('\0').filter(|r| !r.is_empty());
    while let Some(rec) = records.next() {
        if let Some(h) = rec.strip_prefix("# ") {
            let (key, val) = h.split_once(' ').unwrap_or((h, ""));
            match key {
                "branch.oid" if val != "(initial)" => st.oid = Some(val.to_string()),
                "branch.head" if val != "(detached)" => st.head = Some(val.to_string()),
                "branch.upstream" => st.upstream = Some(val.to_string()),
                "branch.ab" => {
                    for part in val.split_whitespace() {
                        if let Some(a) = part.strip_prefix('+') {
                            st.ahead = a.parse().unwrap_or(0);
                        } else if let Some(b) = part.strip_prefix('-') {
                            st.behind = b.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let kind = rec.as_bytes()[0];
        match kind {
            b'1' => {
                // 1 XY sub mH mI mW hH hI path
                let f: Vec<&str> = rec.splitn(9, ' ').collect();
                if f.len() == 9 {
                    st.entries.push(StatusEntry { path: f[8].to_string(), status: status_from_xy(f[1]), old_path: None });
                }
            }
            b'2' => {
                // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
                let f: Vec<&str> = rec.splitn(10, ' ').collect();
                let orig = records.next().map(str::to_string);
                if f.len() == 10 {
                    let status = if f[1].contains('C') && !f[1].contains('R') { FileStatus::Added } else { FileStatus::Renamed };
                    st.entries.push(StatusEntry { path: f[9].to_string(), status, old_path: orig });
                }
            }
            b'u' => {
                // u XY sub m1 m2 m3 mW h1 h2 h3 path
                let f: Vec<&str> = rec.splitn(11, ' ').collect();
                if f.len() == 11 {
                    st.entries.push(StatusEntry { path: f[10].to_string(), status: FileStatus::Modified, old_path: None });
                }
            }
            b'?' => {
                if let Some(p) = rec.strip_prefix("? ") {
                    st.entries.push(StatusEntry { path: p.to_string(), status: FileStatus::Untracked, old_path: None });
                }
            }
            _ => {}
        }
    }
    st
}

/// One record of `git diff --numstat -z`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct NumStat {
    pub path: String,
    pub old_path: Option<String>,
    /// `None` for binary files.
    pub added: Option<u32>,
    pub removed: Option<u32>,
}

pub(crate) fn parse_numstat_z(raw: &[u8]) -> Vec<NumStat> {
    let text = String::from_utf8_lossy(raw);
    let mut out = Vec::new();
    let mut fields = text.split('\0');
    while let Some(rec) = fields.next() {
        let rec = rec.trim_start_matches('\n');
        if rec.is_empty() {
            continue;
        }
        let mut parts = rec.splitn(3, '\t');
        let (Some(a), Some(r), Some(path)) = (parts.next(), parts.next(), parts.next()) else { continue };
        let added = a.parse().ok();
        let removed = r.parse().ok();
        if path.is_empty() {
            // rename: "A\tR\t\0old\0new\0"
            let old = fields.next().unwrap_or_default().to_string();
            let new = fields.next().unwrap_or_default().to_string();
            out.push(NumStat { path: new, old_path: Some(old), added, removed });
        } else {
            out.push(NumStat { path: path.to_string(), old_path: None, added, removed });
        }
    }
    out
}

/// `git diff --name-status -z`: `(status, path, old_path)`.
pub(crate) fn parse_name_status_z(raw: &[u8]) -> Vec<(FileStatus, String, Option<String>)> {
    let text = String::from_utf8_lossy(raw);
    let mut out = Vec::new();
    let mut fields = text.split('\0').filter(|f| !f.is_empty());
    while let Some(code) = fields.next() {
        let c = code.chars().next().unwrap_or('M');
        match c {
            'R' | 'C' => {
                let old = fields.next().unwrap_or_default().to_string();
                let new = fields.next().unwrap_or_default().to_string();
                let st = if c == 'R' { FileStatus::Renamed } else { FileStatus::Added };
                out.push((st, new, Some(old)));
            }
            _ => {
                let path = fields.next().unwrap_or_default().to_string();
                let st = match c {
                    'A' => FileStatus::Added,
                    'D' => FileStatus::Deleted,
                    _ => FileStatus::Modified,
                };
                out.push((st, path, None));
            }
        }
    }
    out
}

/// One record of `git worktree list --porcelain`.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct WorktreeRecord {
    pub path: String,
    pub head: Option<String>,
    /// Short branch name (`refs/heads/` stripped).
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
}

pub(crate) fn parse_worktree_porcelain(text: &str) -> Vec<WorktreeRecord> {
    let mut out = Vec::new();
    let mut cur: Option<WorktreeRecord> = None;
    for line in text.lines() {
        if line.is_empty() {
            if let Some(w) = cur.take() {
                out.push(w);
            }
            continue;
        }
        let (key, val) = line.split_once(' ').unwrap_or((line, ""));
        match key {
            "worktree" => {
                if let Some(w) = cur.take() {
                    out.push(w);
                }
                cur = Some(WorktreeRecord { path: val.to_string(), ..Default::default() });
            }
            "HEAD" => {
                if let Some(w) = cur.as_mut() {
                    w.head = Some(val.to_string());
                }
            }
            "branch" => {
                if let Some(w) = cur.as_mut() {
                    w.branch = Some(val.strip_prefix("refs/heads/").unwrap_or(val).to_string());
                }
            }
            "bare" => {
                if let Some(w) = cur.as_mut() {
                    w.bare = true;
                }
            }
            "detached" => {
                if let Some(w) = cur.as_mut() {
                    w.detached = true;
                }
            }
            _ => {}
        }
    }
    if let Some(w) = cur.take() {
        out.push(w);
    }
    out
}

/// One record of the `for-each-ref` format used by [`branches`].
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RefRecord {
    pub refname: String,
    pub short: String,
    pub upstream: Option<String>,
    pub committed_at: Option<i64>,
    pub is_head: bool,
}

pub(crate) const REF_FORMAT: &str = "%(refname)%00%(refname:short)%00%(upstream:short)%00%(committerdate:unix)%00%(HEAD)";

pub(crate) fn parse_refs(text: &str) -> Vec<RefRecord> {
    text.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\0').collect();
            if f.len() < 5 {
                return None;
            }
            Some(RefRecord {
                refname: f[0].to_string(),
                short: f[1].to_string(),
                upstream: Some(f[2]).filter(|s| !s.is_empty()).map(str::to_string),
                committed_at: f[3].trim().parse::<i64>().ok().map(|s| s * 1000),
                is_head: f[4].trim() == "*",
            })
        })
        .collect()
}

/// Counts entries of `git status --porcelain=v1 -z` (renames carry an extra field).
pub(crate) fn count_porcelain_v1_z(raw: &[u8]) -> u32 {
    let mut n = 0;
    let mut fields = raw.split(|b| *b == 0).filter(|f| !f.is_empty());
    while let Some(f) = fields.next() {
        n += 1;
        if f.len() > 2 && (f[0] == b'R' || f[0] == b'C') {
            fields.next();
        }
    }
    n
}

// ───────────────────────────── repo helpers ─────────────────────────────

/// Top-level of the work tree containing `cwd`.
pub(crate) async fn toplevel(cwd: &Path) -> Result<PathBuf, ApiError> {
    let out = git_ok(cwd, &["rev-parse", "--show-toplevel"], QUICK).await?;
    Ok(PathBuf::from(out.line()))
}

/// The repository's default branch (`origin/HEAD` → `init.defaultBranch` → main/master/trunk/develop,
/// as a local branch or as `origin/<name>`).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DefaultBranch {
    /// Branch name (`main`).
    pub name: String,
    /// Refs carrying its history: the local branch and/or its remote-tracking branch. Merge-bases
    /// are taken against all of them at once, so a branch forked from a fresher `origin/main`
    /// does not count the commits a stale local `main` has not caught up with yet (and a branch
    /// forked from local `main` with unpushed commits does not count those either).
    pub refs: Vec<String>,
    /// What new worktrees fork from (`BranchList.default_base`): `origin/<name>` when that
    /// remote-tracking branch exists, else the local branch's remote-tracking upstream (repos
    /// without an `origin`), else the local branch.
    pub base: String,
}

pub(crate) async fn default_branch(cwd: &Path) -> Option<DefaultBranch> {
    let refs = git(cwd, &["for-each-ref", "--format=%(refname)%00%(upstream)", "refs/heads", "refs/remotes"], QUICK).await.ok()?;
    let refs = refs.stdout_str();
    let mut upstream: HashMap<&str, &str> = HashMap::new();
    for line in refs.lines() {
        let (name, up) = line.split_once('\0').unwrap_or((line, ""));
        upstream.insert(name, up);
    }
    let pick = |name: &str| -> Option<DefaultBranch> {
        let local = format!("refs/heads/{name}");
        let has_local = upstream.contains_key(local.as_str());
        let remote = if upstream.contains_key(format!("refs/remotes/origin/{name}").as_str()) {
            Some(format!("origin/{name}"))
        } else {
            upstream
                .get(local.as_str())
                .and_then(|up| up.strip_prefix("refs/remotes/").filter(|_| upstream.contains_key(up)))
                .map(str::to_string)
        };
        if !has_local && remote.is_none() {
            return None;
        }
        let refs: Vec<String> = has_local.then(|| name.to_string()).into_iter().chain(remote.clone()).collect();
        Some(DefaultBranch { name: name.to_string(), base: remote.unwrap_or_else(|| name.to_string()), refs })
    };
    if let Ok(o) = git(cwd, &["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], QUICK).await
        && o.ok() {
            let full = o.line();
            if let Some(name) = full.strip_prefix("origin/")
                && let Some(p) = pick(name) {
                    return Some(p);
                }
        }
    if let Ok(o) = git(cwd, &["config", "--get", "init.defaultBranch"], QUICK).await {
        let name = o.line();
        if o.ok() && !name.is_empty()
            && let Some(p) = pick(&name) {
                return Some(p);
            }
    }
    ["main", "master", "trunk", "develop"].into_iter().find_map(pick)
}

async fn has_head(cwd: &Path) -> bool {
    git(cwd, &["rev-parse", "-q", "--verify", "HEAD"], QUICK).await.map(|o| o.ok()).unwrap_or(false)
}

async fn empty_tree(cwd: &Path) -> Result<String, ApiError> {
    Ok(git_ok(cwd, &["hash-object", "-t", "tree", "--stdin"], QUICK).await?.line())
}

/// Best common ancestor of `a` and the history of all `others` together (`git merge-base a b c`
/// merges `b` and `c` hypothetically): the latest point where `a` forked from any of them.
pub(crate) async fn merge_base<S: AsRef<str>>(cwd: &Path, a: &str, others: &[S]) -> Option<String> {
    if others.is_empty() {
        return None;
    }
    let mut args = vec!["merge-base", a];
    args.extend(others.iter().map(AsRef::as_ref));
    let o = git(cwd, &args, QUICK).await.ok()?;
    o.ok().then(|| o.line()).filter(|s| !s.is_empty())
}

/// A base fetched (or failed to fetch) this recently is not fetched again: fan-outs create several
/// worktrees from the same base within seconds; they should fork from the same commit, and an
/// unreachable remote should cost one timeout, not one per worktree.
const FETCH_FRESH: Duration = Duration::from_secs(20);

/// `(remote, branch)` when `r` names a branch of a configured remote (`origin/main`,
/// `upstream/feat/x`), fetched before or not. A local branch spelled the same wins, as in git's
/// own ref resolution.
pub(crate) async fn remote_tracking(root: &Path, r: &str) -> Option<(String, String)> {
    let local = git(root, &["show-ref", "--verify", "-q", &format!("refs/heads/{r}")], QUICK).await.ok()?;
    if local.ok() {
        return None;
    }
    let remotes = git(root, &["remote"], QUICK).await.ok()?.stdout_str();
    remotes
        .lines()
        .filter_map(|remote| {
            let branch = r.strip_prefix(remote)?.strip_prefix('/')?;
            (!remote.is_empty() && !branch.is_empty()).then(|| (remote.to_string(), branch.to_string()))
        })
        .max_by_key(|(remote, _)| remote.len())
}

/// Fetches one branch of a remote: `git fetch <remote> refs/heads/<branch>` updates
/// `refs/remotes/<remote>/<branch>` through the remote's configured refspec. Never prompts
/// (`GIT_TERMINAL_PROMPT=0`, an empty `GIT_ASKPASS` so neither `core.askPass` nor
/// `SSH_ASKPASS` dialogs open, `SSH_ASKPASS_REQUIRE=never`, ssh `BatchMode` and
/// `ConnectTimeout`), runs without hooks, gives up after `timeout`. Single-flight per
/// repository and branch; an attempt within [`FETCH_FRESH`] answers for itself. `Err` carries
/// git's message (offline, auth, unknown branch, timeout).
pub(crate) async fn fetch_branch(root: &Path, remote: &str, branch: &str, timeout: Duration) -> Result<(), String> {
    type Slot = std::sync::Arc<tokio::sync::Mutex<Option<(std::time::Instant, Result<(), String>)>>>;
    static SLOTS: std::sync::LazyLock<std::sync::Mutex<HashMap<String, Slot>>> = std::sync::LazyLock::new(Default::default);
    let key = format!("{}\0{remote}\0{branch}", root.display());
    let slot = SLOTS.lock().unwrap_or_else(|e| e.into_inner()).entry(key).or_default().clone();
    let mut last = slot.lock().await;
    if let Some((at, res)) = last.as_ref()
        && at.elapsed() < FETCH_FRESH {
            return res.clone();
        }
    let ssh = batch_ssh_command(root).await;
    let mut env: Vec<(&str, &str)> = vec![("GIT_ASKPASS", ""), ("SSH_ASKPASS_REQUIRE", "never")];
    env.extend(ssh.as_deref().map(|s| ("GIT_SSH_COMMAND", s)));
    let refspec = format!("refs/heads/{branch}");
    let res = match git_run(root, &["fetch", "--quiet", remote, &refspec], None, &env, timeout).await {
        Ok(out) if out.ok() => Ok(()),
        Ok(out) => Err(out.message()),
        Err(e) => Err(e.message),
    };
    *last = Some((std::time::Instant::now(), res.clone()));
    res
}

/// `GIT_SSH_COMMAND` that can never prompt (passwords, passphrases, unknown host keys) nor hang
/// on an unreachable host: the ssh command git would run (`GIT_SSH_COMMAND`, else
/// `core.sshCommand`, else the `GIT_SSH` program, else `ssh`) plus `-o BatchMode=yes -o
/// ConnectTimeout=5`. `None` (leave git's choice alone) when that program is not OpenSSH's
/// `ssh` (plink, wrapper scripts): other programs may not take `-o`.
async fn batch_ssh_command(root: &Path) -> Option<String> {
    let env_command = std::env::var("GIT_SSH_COMMAND").ok();
    let config = match env_command.as_deref().filter(|c| !c.trim().is_empty()) {
        Some(_) => None,
        None => Some(git(root, &["config", "--get", "core.sshCommand"], QUICK).await.map(|o| o.line()).unwrap_or_default()),
    };
    ssh_batch_command(env_command.as_deref(), config.as_deref(), std::env::var_os("GIT_SSH").as_deref().and_then(|s| s.to_str()))
}

/// [`batch_ssh_command`] from its inputs: `GIT_SSH_COMMAND`, `core.sshCommand`, `GIT_SSH`.
fn ssh_batch_command(env_command: Option<&str>, config: Option<&str>, git_ssh: Option<&str>) -> Option<String> {
    const BATCH: &str = "-o BatchMode=yes -o ConnectTimeout=5";
    let is_ssh = |program: &str| Path::new(program).file_name().and_then(|n| n.to_str()).is_some_and(|n| matches!(n, "ssh" | "ssh.exe"));
    let shell_command = env_command.filter(|c| !c.trim().is_empty()).or(config.filter(|c| !c.trim().is_empty()));
    if let Some(c) = shell_command {
        // A shell command line: its first word is the program.
        return is_ssh(c.split_whitespace().next()?).then(|| format!("{c} {BATCH}"));
    }
    match git_ssh.filter(|p| !p.is_empty()) {
        // `GIT_SSH` is a program path run without a shell; `GIT_SSH_COMMAND` (which wins over
        // it) is a shell command, so the path is single-quoted.
        Some(p) => is_ssh(p).then(|| format!("'{}' {BATCH}", p.replace('\'', r"'\''"))),
        None => Some(format!("ssh {BATCH}")),
    }
}

/// Reads the branch of a checkout straight from `HEAD` (no process): `ref: refs/heads/<b>`
/// gives `<b>`, a detached HEAD gives the short sha. `dot_git` is the `.git` entry of the work
/// tree (directory, or a `gitdir:` file for linked worktrees). `None` if it is not a git dir.
pub(crate) fn read_head_branch(dot_git: &Path) -> Option<String> {
    let gitdir = if dot_git.is_dir() {
        dot_git.to_path_buf()
    } else {
        let content = read_capped(dot_git)?;
        let rel = content.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim().to_string();
        let p = PathBuf::from(&rel);
        if p.is_absolute() { p } else { dot_git.parent()?.join(p) }
    };
    let head = read_capped(&gitdir.join("HEAD"))?;
    let head = head.trim();
    match head.strip_prefix("ref:") {
        Some(r) => {
            let r = r.trim();
            Some(r.strip_prefix("refs/heads/").unwrap_or(r).to_string()).filter(|b| !b.is_empty())
        }
        None if head.len() >= 7 && head.bytes().all(|b| b.is_ascii_hexdigit()) => Some(head[..7].to_string()),
        None => None,
    }
}

/// First 4 KiB of a small metadata file (`HEAD`, `gitdir:` files) as UTF-8.
fn read_capped(p: &Path) -> Option<String> {
    use std::io::Read;
    let mut buf = Vec::new();
    std::fs::File::open(p).ok()?.take(4096).read_to_end(&mut buf).ok()?;
    String::from_utf8(buf).ok()
}

/// Number of changed files (staged + unstaged + untracked) or `None` on error/timeout.
/// Runs `git status`: only for registered workspaces and explicit user actions, never for
/// folders the user is merely browsing.
pub(crate) async fn dirty_count(cwd: &Path, timeout: Duration) -> Option<u32> {
    let o = git(cwd, &["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=dirty"], timeout).await.ok()?;
    o.ok().then(|| count_porcelain_v1_z(&o.stdout))
}

/// Badge for a directory that has a `.git` entry, computed from the filesystem only (never
/// spawns git: browsed repositories are untrusted and their config can name programs).
/// `dirty` is always `None`.
pub(crate) fn badge_for_dir(dir: &Path) -> Option<GitBadge> {
    let dot_git = dir.join(".git");
    let meta = std::fs::symlink_metadata(&dot_git).ok()?;
    let branch = read_head_branch(&dot_git)?;
    Some(GitBadge { repo_root: true, worktree: meta.is_file(), branch: Some(branch), dirty: None })
}

/// Where a folder's repository lives: its worktree top and the main worktree root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoTop {
    pub top: PathBuf,
    pub root: PathBuf,
}

/// The repository a folder is in (`Ok(None)`: none; `Err`: git could not tell, e.g. a timeout).
pub async fn repo_top(cwd: &Path) -> Result<Option<RepoTop>, ApiError> {
    let o = git(cwd, &["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], QUICK).await?;
    if !o.ok() {
        return Ok(None);
    }
    let s = o.stdout_str();
    let mut lines = s.lines();
    let (Some(top), Some(common)) = (lines.next().map(PathBuf::from), lines.next().map(PathBuf::from)) else { return Ok(None) };
    // Main worktree root: parent of the common `.git` dir (bare repos: the dir itself).
    let root = if common.file_name().map(|n| n == ".git").unwrap_or(false) {
        common.parent().map(Path::to_path_buf).unwrap_or(top.clone())
    } else {
        top.clone()
    };
    Ok(Some(RepoTop { top, root }))
}

/// Repository facts of a worktree (the state store's agent and workspace badges).
pub async fn repo_info_at(t: &RepoTop) -> RepoInfo {
    let RepoTop { top, root } = t;
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| root.display().to_string());
    let st = git(top, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal", "--ignore-submodules=dirty"], QUICK)
        .await
        .ok()
        .filter(|o| o.ok())
        .map(|o| parse_status_v2(&o.stdout));
    let remote_url = git(top, &["config", "--get", "remote.origin.url"], QUICK).await.ok().filter(|o| o.ok()).map(|o| o.line());
    RepoInfo {
        root: root.display().to_string(),
        name,
        branch: st.as_ref().and_then(|s| s.head.clone()),
        head: st.as_ref().and_then(|s| s.oid.as_ref().map(|o| o.chars().take(7).collect())),
        dirty: st.as_ref().map(|s| s.entries.len() as u32),
        ahead: st.as_ref().filter(|s| s.upstream.is_some()).map(|s| s.ahead),
        behind: st.as_ref().filter(|s| s.upstream.is_some()).map(|s| s.behind),
        remote_url,
    }
}

// ───────────────────────────── methods ─────────────────────────────

pub async fn status(cwd: &Path) -> Result<GitStatusResult, ApiError> {
    let root = toplevel(cwd).await?;
    let st_out = git_ok(&root, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--ignore-submodules=dirty"], SLOW).await?;
    let st = parse_status_v2(&st_out.stdout);
    let head_exists = st.oid.is_some();
    let against = if head_exists { "HEAD".to_string() } else { empty_tree(&root).await? };
    let numstat = git(&root, &["diff", "--numstat", "-z", "-M", &against], SLOW).await?;
    let counts: HashMap<String, NumStat> = parse_numstat_z(&numstat.stdout).into_iter().map(|n| (n.path.clone(), n)).collect();

    let untracked: Vec<String> = st.entries.iter().filter(|e| e.status == FileStatus::Untracked).map(|e| e.path.clone()).collect();
    let untracked_lines = count_lines_blocking(root.clone(), untracked).await;

    let files = st
        .entries
        .iter()
        .map(|e| {
            let (added, removed) = match e.status {
                FileStatus::Untracked => (untracked_lines.get(&e.path).copied().unwrap_or(0), 0),
                _ => counts.get(&e.path).map(|n| (n.added.unwrap_or(0), n.removed.unwrap_or(0))).unwrap_or((0, 0)),
            };
            ChangedFile { path: e.path.clone(), added, removed, status: e.status, old_path: e.old_path.clone() }
        })
        .collect();

    let def = default_branch(&root).await;
    let base = match (&def, head_exists) {
        (Some(d), true) => merge_base(&root, "HEAD", &d.refs).await,
        _ => None,
    };
    Ok(GitStatusResult {
        root: root.display().to_string(),
        branch: st.head.clone(),
        upstream: st.upstream.clone(),
        ahead: st.ahead,
        behind: st.behind,
        default_branch: def.map(|d| d.name),
        base,
        files,
    })
}

/// Line counts for untracked text files (≤ [`UNTRACKED_TEXT_MAX`], at most 500 files).
async fn count_lines_blocking(root: PathBuf, files: Vec<String>) -> HashMap<String, u32> {
    tokio::task::spawn_blocking(move || {
        let mut out = HashMap::new();
        for f in files.into_iter().take(500) {
            if let Some(text) = read_small_text(&root.join(&f)) {
                out.insert(f, line_count(&text));
            }
        }
        out
    })
    .await
    .unwrap_or_default()
}

fn line_count(text: &str) -> u32 {
    if text.is_empty() {
        return 0;
    }
    let n = text.bytes().filter(|b| *b == b'\n').count() as u32;
    if text.ends_with('\n') { n } else { n + 1 }
}

/// Reads a small UTF-8 text file (no NUL bytes); `None` for large/binary/unreadable files.
fn read_small_text(p: &Path) -> Option<String> {
    let meta = std::fs::metadata(p).ok()?;
    if !meta.is_file() || meta.len() > UNTRACKED_TEXT_MAX {
        return None;
    }
    let bytes = std::fs::read(p).ok()?;
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

pub async fn branches(cwd: &Path) -> Result<BranchList, ApiError> {
    let root = toplevel(cwd).await?;
    let refs = git_ok(&root, &["for-each-ref", &format!("--format={REF_FORMAT}"), "--sort=-committerdate", "refs/heads", "refs/remotes"], QUICK).await?;
    let wts = git(&root, &["worktree", "list", "--porcelain"], QUICK).await?;
    let mut checked_out: HashMap<String, String> = HashMap::new();
    for w in parse_worktree_porcelain(&wts.stdout_str()) {
        if let Some(b) = w.branch {
            checked_out.insert(b, w.path);
        }
    }
    let branches = parse_refs(&refs.stdout_str())
        .into_iter()
        .filter(|r| !(r.refname.starts_with("refs/remotes/") && r.refname.ends_with("/HEAD")))
        .map(|r| {
            let remote = r.refname.starts_with("refs/remotes/");
            BranchInfo {
                worktree_path: if remote { None } else { checked_out.get(&r.short).cloned() },
                current: r.is_head,
                remote,
                upstream: r.upstream,
                last_commit_at: r.committed_at,
                name: r.short,
            }
        })
        .collect();
    let def = default_branch(&root).await;
    Ok(BranchList { branches, default_base: def.as_ref().map(|d| d.base.clone()), default_branch: def.map(|d| d.name) })
}

pub async fn diff(p: &GitDiffParams) -> Result<GitDiffResult, ApiError> {
    let cwd = crate::ops::fs::resolve_path(&p.cwd)?;
    let root = toplevel(&cwd).await?;
    let head_exists = has_head(&root).await;
    let base = match &p.base {
        Some(b) if !b.trim().is_empty() => {
            let b = b.trim();
            let v = git(&root, &["rev-parse", "-q", "--verify", &format!("{b}^{{commit}}")], QUICK).await?;
            if !v.ok() {
                return Err(ApiError::new("invalid_params", format!("unknown base ref `{b}`")));
            }
            // A branch name means "what this branch changed since it forked from it".
            if head_exists { merge_base(&root, "HEAD", &[b]).await.unwrap_or_else(|| v.line()) } else { v.line() }
        }
        _ => {
            let def = default_branch(&root).await;
            match (def, head_exists) {
                (Some(d), true) => match merge_base(&root, "HEAD", &d.refs).await {
                    Some(mb) => mb,
                    None => git_ok(&root, &["rev-parse", "HEAD"], QUICK).await?.line(),
                },
                (None, true) => git_ok(&root, &["rev-parse", "HEAD"], QUICK).await?.line(),
                (_, false) => empty_tree(&root).await?,
            }
        }
    };
    let ctx_arg = format!("-U{}", p.context.unwrap_or(3).min(1000));
    let mut common: Vec<String> = vec!["diff".into(), "-M".into(), "--no-color".into()];
    let mut patch_args = common.clone();
    patch_args.extend([ctx_arg, base.clone()]);
    let mut ns_args = common.clone();
    ns_args.extend(["--numstat".into(), "-z".into(), base.clone()]);
    common.extend(["--name-status".into(), "-z".into(), base.clone()]);
    let mut name_args = common;
    for a in [&mut patch_args, &mut ns_args, &mut name_args] {
        a.push("--".into());
        if let Some(path) = &p.path {
            a.push(path.clone());
        }
    }
    let (patch_out, ns_out, name_out) =
        tokio::try_join!(git(&root, &patch_args, SLOW), git(&root, &ns_args, SLOW), git(&root, &name_args, SLOW))?;
    for o in [&patch_out, &ns_out, &name_out] {
        if !o.ok() {
            return Err(git_failure(o, "diff"));
        }
    }
    let counts: HashMap<String, NumStat> = parse_numstat_z(&ns_out.stdout).into_iter().map(|n| (n.path.clone(), n)).collect();
    let mut files: Vec<ChangedFile> = parse_name_status_z(&name_out.stdout)
        .into_iter()
        .map(|(status, path, old_path)| {
            let n = counts.get(&path);
            ChangedFile {
                added: n.and_then(|n| n.added).unwrap_or(0),
                removed: n.and_then(|n| n.removed).unwrap_or(0),
                status,
                old_path,
                path,
            }
        })
        .collect();

    let mut patch = patch_out.stdout;
    let mut truncated = false;

    // Untracked files are part of "uncommitted changes": synthesize new-file patches.
    let mut ut_args: Vec<String> = vec!["ls-files".into(), "--others".into(), "--exclude-standard".into(), "-z".into(), "--".into()];
    if let Some(path) = &p.path {
        ut_args.push(path.clone());
    }
    let untracked_out = git(&root, &ut_args, SLOW).await?;
    let untracked: Vec<String> = String::from_utf8_lossy(&untracked_out.stdout).split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect();
    let rendered = render_untracked(root.clone(), untracked.clone()).await;
    for (i, path) in untracked.iter().enumerate() {
        let (lines, text) = rendered.get(path).cloned().unwrap_or((0, None));
        files.push(ChangedFile { path: path.clone(), added: lines, removed: 0, status: FileStatus::Untracked, old_path: None });
        if i < UNTRACKED_PATCH_FILES {
            patch.extend_from_slice(new_file_patch(path, text.as_deref()).as_bytes());
        } else {
            truncated = true;
        }
    }

    if patch.len() > DIFF_CAP_BYTES {
        truncated = true;
        patch.truncate(DIFF_CAP_BYTES);
        // Cut at the last complete line, then repair a split UTF-8 sequence.
        if let Some(nl) = patch.iter().rposition(|b| *b == b'\n') {
            patch.truncate(nl + 1);
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(GitDiffResult { base, patch: String::from_utf8_lossy(&patch).into_owned(), files, truncated })
}

/// `(line count, text)` for untracked files (text only when small and UTF-8).
async fn render_untracked(root: PathBuf, files: Vec<String>) -> HashMap<String, (u32, Option<String>)> {
    tokio::task::spawn_blocking(move || {
        files
            .into_iter()
            .take(UNTRACKED_PATCH_FILES)
            .map(|f| {
                let text = read_small_text(&root.join(&f));
                (f, (text.as_deref().map(line_count).unwrap_or(0), text))
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Unified-diff text for a new (untracked) file.
pub(crate) fn new_file_patch(path: &str, text: Option<&str>) -> String {
    let mut s = format!("diff --git a/{path} b/{path}\nnew file mode 100644\n");
    match text {
        None => s.push_str(&format!("Binary files /dev/null and b/{path} differ\n")),
        Some("") => {}
        Some(t) => {
            let n = line_count(t);
            s.push_str(&format!("--- /dev/null\n+++ b/{path}\n@@ -0,0 +1{} @@\n", if n == 1 { String::new() } else { format!(",{n}") }));
            for line in t.split_inclusive('\n') {
                s.push('+');
                s.push_str(line);
            }
            if !t.ends_with('\n') {
                s.push_str("\n\\ No newline at end of file\n");
            }
        }
    }
    s
}

pub async fn commit(p: &GitCommitParams) -> Result<GitCommitResult, ApiError> {
    if p.message.trim().is_empty() {
        return Err(ApiError::new("invalid_params", "commit message is empty"));
    }
    let cwd = crate::ops::fs::resolve_path(&p.cwd)?;
    let root = toplevel(&cwd).await?;
    if p.all {
        git_ok(&root, &["add", "-A"], SLOW).await?;
    }
    let out = git_with_input(&root, &["commit", "-F", "-"], Some(p.message.as_bytes()), SLOW).await?;
    if !out.ok() {
        return Err(git_failure(&out, "commit"));
    }
    let log = git_ok(&root, &["log", "-1", "--format=%H%x00%s"], QUICK).await?;
    let line = log.line();
    let (sha, summary) = line.split_once('\0').unwrap_or((line.as_str(), ""));
    Ok(GitCommitResult { sha: sha.to_string(), summary: summary.to_string() })
}

pub async fn push(cwd: &Path) -> Result<CommandOutput, ApiError> {
    let root = toplevel(cwd).await?;
    let local = git(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"], QUICK).await?;
    let local = local.ok().then(|| local.line()).filter(|l| !l.is_empty());
    let upstream = match &local {
        Some(b) => {
            let out = git(&root, &["for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)", &format!("refs/heads/{b}")], QUICK).await?;
            out.ok().then(|| out.line()).and_then(|l| l.split_once('\0').map(|(r, m)| (r.to_string(), m.to_string()))).filter(|(r, m)| !r.is_empty() && !m.is_empty())
        }
        None => None,
    };
    let remotes = git_ok(&root, &["remote"], QUICK).await?.stdout_str();
    let remotes: Vec<&str> = remotes.lines().filter(|l| !l.is_empty()).collect();
    let args = push_args(local.as_deref(), upstream.as_ref().map(|(r, m)| (r.as_str(), m.as_str())), &remotes).ok_or_else(|| {
        ApiError::new("git_error", "this repository has no remote").with_hint("Add a remote first: git remote add origin <url>.")
    })?;
    let out = git(&root, &args, NETWORK).await?;
    if !out.ok() {
        return Err(git_failure(&out, "push"));
    }
    Ok(CommandOutput { code: out.code, stdout: out.stdout_str(), stderr: out.stderr })
}

/// `git push` arguments. A branch whose upstream is its namesake on a remote pushes plainly.
/// Otherwise (no upstream, a local upstream, or one with another name: a branch forked from
/// `origin/main` that still tracks it) it publishes under its own name and tracks that, on the
/// upstream's remote or else `origin` / the first remote, so it never pushes into the base.
/// `None`: no remote at all.
fn push_args(local: Option<&str>, upstream: Option<(&str, &str)>, remotes: &[&str]) -> Option<Vec<String>> {
    let upstream = upstream.filter(|(remote, _)| *remote != ".");
    if let (Some(b), Some((_, merge))) = (local, upstream)
        && merge.strip_prefix("refs/heads/") == Some(b)
    {
        return Some(vec!["push".into()]);
    }
    let remote = match upstream {
        Some((r, _)) => r,
        None if remotes.contains(&"origin") => "origin",
        None => remotes.first().copied()?,
    };
    Some(vec!["push".into(), "--set-upstream".into(), remote.into(), "HEAD".into()])
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn status_v2_parses_all_record_kinds() {
        let raw = b"# branch.oid 1234567890abcdef\0# branch.head feat/x\0# branch.upstream origin/feat/x\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 aaa bbb src/a.rs\0\
1 A. N... 000000 100644 100644 000 ccc new file.txt\0\
1 D. N... 100644 000000 000000 ddd 000 gone.rs\0\
2 R. N... 100644 100644 100644 eee eee R100 renamed.rs\0orig.rs\0\
u UU N... 100644 100644 100644 100644 a b c conflict.rs\0\
? untracked/x.md\0";
        let st = parse_status_v2(raw);
        assert_eq!(st.head.as_deref(), Some("feat/x"));
        assert_eq!(st.upstream.as_deref(), Some("origin/feat/x"));
        assert_eq!((st.ahead, st.behind), (2, 1));
        let kinds: Vec<_> = st.entries.iter().map(|e| (e.path.as_str(), e.status)).collect();
        assert_eq!(
            kinds,
            vec![
                ("src/a.rs", FileStatus::Modified),
                ("new file.txt", FileStatus::Added),
                ("gone.rs", FileStatus::Deleted),
                ("renamed.rs", FileStatus::Renamed),
                ("conflict.rs", FileStatus::Modified),
                ("untracked/x.md", FileStatus::Untracked),
            ]
        );
        assert_eq!(st.entries[3].old_path.as_deref(), Some("orig.rs"));
    }

    #[test]
    fn status_v2_detached_and_initial() {
        let st = parse_status_v2(b"# branch.oid (initial)\0# branch.head (detached)\0");
        assert_eq!(st.oid, None);
        assert_eq!(st.head, None);
        assert!(st.entries.is_empty());
    }

    #[test]
    fn numstat_z_handles_renames_and_binary() {
        let raw = b"3\t1\tsrc/a.rs\0-\t-\timg.png\0\x30\t0\t\0old name.rs\0new name.rs\0";
        let n = parse_numstat_z(raw);
        assert_eq!(n.len(), 3);
        assert_eq!(n[0], NumStat { path: "src/a.rs".into(), old_path: None, added: Some(3), removed: Some(1) });
        assert_eq!(n[1].added, None);
        assert_eq!(n[2].path, "new name.rs");
        assert_eq!(n[2].old_path.as_deref(), Some("old name.rs"));
    }

    #[test]
    fn name_status_z() {
        let n = parse_name_status_z(b"M\0a.rs\0A\0b.rs\0D\0c.rs\0R087\0old.rs\0new.rs\0");
        assert_eq!(n[0], (FileStatus::Modified, "a.rs".into(), None));
        assert_eq!(n[1].0, FileStatus::Added);
        assert_eq!(n[2].0, FileStatus::Deleted);
        assert_eq!(n[3], (FileStatus::Renamed, "new.rs".into(), Some("old.rs".into())));
    }

    #[test]
    fn worktree_porcelain() {
        let text = "worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /w/feat\nHEAD def\nbranch refs/heads/feat/y\n\nworktree /w/det\nHEAD 123\ndetached\n\n";
        let w = parse_worktree_porcelain(text);
        assert_eq!(w.len(), 3);
        assert_eq!(w[0].branch.as_deref(), Some("main"));
        assert_eq!(w[1].branch.as_deref(), Some("feat/y"));
        assert!(w[2].detached && w[2].branch.is_none());
    }

    #[test]
    fn refs_and_porcelain_count() {
        let r = parse_refs("refs/heads/main\0main\0origin/main\x001700000000\0*\nrefs/remotes/origin/x\0origin/x\0\x001700000001\0 \n");
        assert_eq!(r.len(), 2);
        assert!(r[0].is_head);
        assert_eq!(r[0].committed_at, Some(1_700_000_000_000));
        assert_eq!(r[1].upstream, None);
        assert_eq!(count_porcelain_v1_z(b" M a\0R  new\0old\0?? b\0"), 3);
    }

    #[test]
    fn new_file_patch_shapes() {
        assert_eq!(new_file_patch("a", Some("x\ny\n")), "diff --git a/a b/a\nnew file mode 100644\n--- /dev/null\n+++ b/a\n@@ -0,0 +1,2 @@\n+x\n+y\n");
        assert!(new_file_patch("a", Some("x")).ends_with("+x\n\\ No newline at end of file\n"));
        assert!(new_file_patch("b.png", None).contains("Binary files"));
    }

    // ── fixture repo ──

    pub(crate) fn sh(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// main with one commit, branch `feat` with a committed change, plus uncommitted
    /// modification, a staged new file and an untracked file.
    pub(crate) fn fixture() -> tempfile::TempDir {
        let td = tempfile::tempdir().unwrap();
        let d = td.path();
        sh(d, &["init", "-q", "-b", "main"]);
        sh(d, &["config", "user.name", "t"]);
        sh(d, &["config", "user.email", "t@t"]);
        std::fs::write(d.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(d.join("old.txt"), "keep me\n").unwrap();
        sh(d, &["add", "."]);
        sh(d, &["commit", "-q", "-m", "init"]);
        sh(d, &["checkout", "-q", "-b", "feat"]);
        std::fs::write(d.join("a.txt"), "one\n2\nthree\nfour\n").unwrap();
        sh(d, &["commit", "-q", "-am", "feat work"]);
        std::fs::write(d.join("a.txt"), "one\n2\nthree\nfour\nfive\n").unwrap();
        std::fs::write(d.join("staged.txt"), "s\n").unwrap();
        sh(d, &["add", "staged.txt"]);
        sh(d, &["mv", "old.txt", "moved.txt"]);
        std::fs::write(d.join("untracked.md"), "u1\nu2\n").unwrap();
        td
    }

    #[tokio::test]
    async fn status_on_fixture() {
        let td = fixture();
        let st = status(td.path()).await.unwrap();
        assert_eq!(st.branch.as_deref(), Some("feat"));
        assert_eq!(st.default_branch.as_deref(), Some("main"));
        assert!(st.base.is_some());
        let get = |p: &str| st.files.iter().find(|f| f.path == p).cloned().unwrap();
        assert_eq!(get("a.txt").status, FileStatus::Modified);
        assert_eq!((get("a.txt").added, get("a.txt").removed), (1, 0));
        assert_eq!(get("staged.txt").status, FileStatus::Added);
        assert_eq!(get("moved.txt").status, FileStatus::Renamed);
        assert_eq!(get("moved.txt").old_path.as_deref(), Some("old.txt"));
        assert_eq!(get("untracked.md").status, FileStatus::Untracked);
        assert_eq!(get("untracked.md").added, 2);
    }

    #[tokio::test]
    async fn diff_against_merge_base_includes_uncommitted_and_untracked() {
        let td = fixture();
        let d = diff(&GitDiffParams { cwd: td.path().display().to_string(), base: None, path: None, context: None }).await.unwrap();
        let st = status(td.path()).await.unwrap();
        assert_eq!(Some(d.base.clone()), st.base);
        let a = d.files.iter().find(|f| f.path == "a.txt").unwrap();
        // committed (two→2, +four) + uncommitted (+five) vs main
        assert_eq!((a.added, a.removed), (3, 1));
        assert!(d.files.iter().any(|f| f.path == "untracked.md" && f.status == FileStatus::Untracked));
        assert!(d.files.iter().any(|f| f.path == "moved.txt" && f.status == FileStatus::Renamed));
        assert!(d.patch.contains("+five"));
        assert!(d.patch.contains("+++ b/untracked.md"));
        assert!(!d.truncated);
        // path filter
        let only = diff(&GitDiffParams { cwd: td.path().display().to_string(), base: Some("main".into()), path: Some("a.txt".into()), context: Some(0) })
            .await
            .unwrap();
        assert_eq!(only.files.len(), 1);
        assert!(only.patch.contains("+five") && !only.patch.contains("untracked"));
    }

    #[tokio::test]
    async fn branches_commit_and_errors() {
        let td = fixture();
        let wt = td.path().join("wt-main");
        sh(td.path(), &["worktree", "add", "-q", "-b", "side", wt.to_str().unwrap(), "main"]);
        let b = branches(td.path()).await.unwrap();
        assert_eq!(b.default_branch.as_deref(), Some("main"));
        assert_eq!(b.default_base.as_deref(), Some("main"), "no remote: new worktrees fork from the local default");
        let feat = b.branches.iter().find(|x| x.name == "feat").unwrap();
        assert!(feat.current && feat.last_commit_at.is_some());
        let side = b.branches.iter().find(|x| x.name == "side").unwrap();
        assert_eq!(side.worktree_path.as_deref().map(|p| p.ends_with("wt-main")), Some(true));

        let res = commit(&GitCommitParams { cwd: td.path().display().to_string(), message: "ship it\n\nbody".into(), all: true }).await.unwrap();
        assert_eq!(res.summary, "ship it");
        assert_eq!(res.sha.len(), 40);
        let st = status(td.path()).await.unwrap();
        assert!(st.files.iter().all(|f| f.path.starts_with("wt-main")), "{:?}", st.files);

        let err = push(td.path()).await.unwrap_err();
        assert_eq!(err.code, "git_error");
        assert!(err.hint.is_some());
        let nr = tempfile::tempdir().unwrap();
        assert_eq!(status(nr.path()).await.unwrap_err().code, "not_found");
    }

    #[tokio::test]
    async fn default_base_prefers_the_remote_tracking_branch() {
        let td = fixture();
        let d = td.path();
        let def = |refs: &[&str], base: &str| DefaultBranch { name: "main".into(), refs: refs.iter().map(|r| r.to_string()).collect(), base: base.into() };
        assert_eq!(default_branch(d).await, Some(def(&["main"], "main")));
        // no origin: the local default's remote-tracking upstream
        sh(d, &["remote", "add", "upstream", "https://example.invalid/up.git"]);
        sh(d, &["update-ref", "refs/remotes/upstream/main", "main"]);
        sh(d, &["config", "branch.main.remote", "upstream"]);
        sh(d, &["config", "branch.main.merge", "refs/heads/main"]);
        assert_eq!(default_branch(d).await, Some(def(&["main", "upstream/main"], "upstream/main")));
        sh(d, &["remote", "add", "origin", "https://example.invalid/x.git"]);
        sh(d, &["update-ref", "refs/remotes/origin/main", "main"]);
        assert_eq!(default_branch(d).await, Some(def(&["main", "origin/main"], "origin/main")));
        // only the remote-tracking branch
        sh(d, &["branch", "-q", "-D", "main"]);
        assert_eq!(default_branch(d).await, Some(def(&["origin/main"], "origin/main")));

        let rt = |remote: &str, branch: &str| Some((remote.to_string(), branch.to_string()));
        assert_eq!(remote_tracking(d, "origin/main").await, rt("origin", "main"));
        assert_eq!(remote_tracking(d, "upstream/feat/x").await, rt("upstream", "feat/x"));
        assert_eq!(remote_tracking(d, "feat").await, None);
        assert_eq!(remote_tracking(d, "HEAD").await, None);
        sh(d, &["branch", "-q", "origin/local-lookalike", "feat"]);
        assert_eq!(remote_tracking(d, "origin/local-lookalike").await, None, "a local branch spelled like a remote one is local");
    }

    #[tokio::test]
    async fn fetch_never_prompts_over_ssh() {
        if std::env::var_os("GIT_SSH_COMMAND").is_some() || std::env::var_os("GIT_SSH").is_some() {
            return;
        }
        let td = fixture();
        let d = td.path();
        assert_eq!(batch_ssh_command(d).await.as_deref(), Some("ssh -o BatchMode=yes -o ConnectTimeout=5"));
        sh(d, &["config", "core.sshCommand", "/usr/bin/ssh -i /k"]);
        assert_eq!(batch_ssh_command(d).await.as_deref(), Some("/usr/bin/ssh -i /k -o BatchMode=yes -o ConnectTimeout=5"));
        sh(d, &["config", "core.sshCommand", "plink -batch"]);
        assert_eq!(batch_ssh_command(d).await, None, "non-OpenSSH programs are left alone");
    }

    #[test]
    fn ssh_command_follows_gits_precedence() {
        let b = "-o BatchMode=yes -o ConnectTimeout=5";
        // GIT_SSH_COMMAND beats core.sshCommand beats GIT_SSH.
        assert_eq!(ssh_batch_command(Some("ssh -p 2"), Some("plink"), Some("/x/plink")), Some(format!("ssh -p 2 {b}")));
        assert_eq!(ssh_batch_command(Some(" "), Some("/usr/bin/ssh"), Some("/x/plink")), Some(format!("/usr/bin/ssh {b}")));
        // GIT_SSH alone: an OpenSSH program path gets BatchMode too (quoted: it may hold spaces).
        assert_eq!(ssh_batch_command(None, Some(""), Some("/opt/my tools/ssh")), Some(format!("'/opt/my tools/ssh' {b}")));
        assert_eq!(ssh_batch_command(None, None, Some("/o'k/ssh")), Some(format!(r"'/o'\''k/ssh' {b}")));
        assert_eq!(ssh_batch_command(None, None, Some(r"C:\Program Files\PuTTY\plink.exe")), None);
        assert_eq!(ssh_batch_command(None, None, None), Some(format!("ssh {b}")));
    }

    #[test]
    fn push_publishes_under_the_branch_name() {
        let args = |l, u, r: &[&str]| push_args(l, u, r).map(|a| a.join(" "));
        let remotes = ["upstream", "origin"];
        assert_eq!(args(Some("feat/x"), Some(("origin", "refs/heads/feat/x")), &remotes).as_deref(), Some("push"));
        // Forked from origin/main and still tracking it: never a plain push into main.
        assert_eq!(args(Some("feat/x"), Some(("origin", "refs/heads/main")), &remotes).as_deref(), Some("push --set-upstream origin HEAD"));
        assert_eq!(args(Some("feat/x"), Some(("upstream", "refs/heads/main")), &remotes).as_deref(), Some("push --set-upstream upstream HEAD"));
        // Tracking a local branch, or nothing: origin (else the first remote).
        assert_eq!(args(Some("feat/x"), Some((".", "refs/heads/main")), &remotes).as_deref(), Some("push --set-upstream origin HEAD"));
        assert_eq!(args(Some("feat/x"), None, &["fork"]).as_deref(), Some("push --set-upstream fork HEAD"));
        assert_eq!(args(Some("feat/x"), None, &[]), None);
    }

    #[tokio::test]
    async fn repo_info_and_badges() {
        let td = fixture();
        let wt = td.path().join("wt2");
        sh(td.path(), &["worktree", "add", "-q", "-b", "other", wt.to_str().unwrap(), "main"]);
        // A linked worktree: its own top, the main worktree's root, its own branch.
        let sub = wt.join("nested");
        std::fs::create_dir(&sub).unwrap();
        let t = repo_top(&sub).await.unwrap().unwrap();
        assert_eq!((t.top.canonicalize().unwrap(), t.root.canonicalize().unwrap()), (wt.canonicalize().unwrap(), td.path().canonicalize().unwrap()));
        let info = repo_info_at(&t).await;
        assert_eq!(Path::new(&info.root), td.path().canonicalize().unwrap());
        assert_eq!(info.branch.as_deref(), Some("other"));
        assert_eq!(repo_top(tempfile::tempdir().unwrap().path()).await.unwrap(), None, "not a repository");
        let badge = badge_for_dir(&wt).unwrap();
        assert!(badge.worktree && badge.repo_root);
        assert_eq!(badge.branch.as_deref(), Some("other"));
        assert_eq!(badge.dirty, None);
        let main_badge = badge_for_dir(td.path()).unwrap();
        assert_eq!(main_badge.branch.as_deref(), Some("feat"));
        assert_eq!(main_badge.dirty, None);
        // detached HEAD → short sha; a `.git` without HEAD is not a repo
        sh(&wt, &["checkout", "-q", "--detach"]);
        assert_eq!(badge_for_dir(&wt).unwrap().branch.map(|b| b.len()), Some(7));
        let fake = tempfile::tempdir().unwrap();
        std::fs::create_dir(fake.path().join(".git")).unwrap();
        assert!(badge_for_dir(fake.path()).is_none());
        // dirty counts stay available for explicit actions / registered workspaces
        assert!(dirty_count(td.path(), Duration::from_secs(5)).await.unwrap() >= 4);
    }

    #[test]
    fn hardened_args_by_subcommand() {
        let s = |args: &[&str]| hardened_args(args).iter().map(|a| a.to_str().unwrap()).collect::<Vec<_>>().join(" ");
        let status = s(&["status", "-z"]);
        assert!(status.starts_with("-c core.quotepath=off -c color.ui=never -c core.fsmonitor=false -c core.hooksPath="), "{status}");
        assert!(status.ends_with(" status -z"), "{status}");
        let commit = s(&["commit", "-F", "-"]);
        assert!(commit.contains("-c core.fsmonitor=false") && !commit.contains("hooksPath"), "{commit}");
        assert!(!s(&["push"]).contains("hooksPath"));
        assert!(!s(&["worktree", "add", "x"]).contains("hooksPath"));
        assert!(s(&["worktree", "list", "--porcelain"]).contains("hooksPath"));
        assert!(s(&["diff", "--numstat", "HEAD"]).ends_with(" diff --no-textconv --no-ext-diff --numstat HEAD"));
        assert!(s(&["show", "HEAD"]).ends_with(" show --no-textconv --no-ext-diff HEAD"));
        assert!(s(&["log", "-1"]).ends_with(" log --no-textconv --no-ext-diff -1"));
        assert!(!s(&["ls-files", "-z"]).contains("--no-textconv"));
    }

    /// Repository config that names programs (fsmonitor, textconv and external diff drivers)
    /// must not run on read paths: `fs.list` badges of browsed folders, status, diff, show,
    /// log. Commits keep the repository's hooks.
    #[cfg(unix)]
    #[tokio::test]
    async fn repo_config_programs_never_run_on_reads() {
        use std::os::unix::fs::PermissionsExt;
        let parent = tempfile::tempdir().unwrap();
        let td = fixture();
        let repo = parent.path().join("repo");
        std::fs::rename(td.path(), &repo).unwrap();
        let marks = tempfile::tempdir().unwrap();
        let script = |dir: &Path, name: &str, code: u8| {
            let p = dir.join(name);
            let mark = marks.path().join(format!("{name}.ran"));
            std::fs::write(&p, format!("#!/bin/sh\ntouch '{}'\nexit {code}\n", mark.display())).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            p.display().to_string()
        };
        let ran = |name: &str| marks.path().join(format!("{name}.ran")).exists();
        sh(&repo, &["config", "core.fsmonitor", &script(marks.path(), "fsmonitor", 1)]);
        sh(&repo, &["config", "diff.evil.textconv", &script(marks.path(), "textconv", 1)]);
        sh(&repo, &["config", "diff.evil.command", &script(marks.path(), "extdiff", 1)]);
        std::fs::write(repo.join(".gitattributes"), "*.txt diff=evil\n").unwrap();

        // Positive controls: plain git runs every one of them.
        let plain = |args: &[&str]| {
            let _ = std::process::Command::new("git").args(args).current_dir(&repo).output().unwrap();
        };
        plain(&["status", "--porcelain"]);
        plain(&["diff", "HEAD"]);
        plain(&["diff", "--no-ext-diff", "HEAD"]);
        for name in ["fsmonitor", "textconv", "extdiff"] {
            assert!(ran(name), "control: plain git did not run {name}");
            std::fs::remove_file(marks.path().join(format!("{name}.ran"))).unwrap();
        }

        let listing = crate::ops::fs::list(&tf_proto::FsListParams { path: parent.path().display().to_string(), hidden: false })
            .await
            .unwrap();
        let badge = listing.entries.iter().find(|e| e.name == "repo").and_then(|e| e.git.clone()).unwrap();
        assert_eq!(badge.branch.as_deref(), Some("feat"));
        assert_eq!(badge.dirty, None);
        assert!(dirty_count(&repo, Duration::from_secs(5)).await.is_some());
        let st = status(&repo).await.unwrap();
        assert!(st.files.iter().any(|f| f.path == "a.txt"));
        let d = diff(&GitDiffParams { cwd: repo.display().to_string(), base: None, path: None, context: None }).await.unwrap();
        assert!(d.patch.contains("+five"));
        for args in [&["show", "HEAD"][..], &["log", "-p", "-1"], &["diff", "--stat", "HEAD"]] {
            assert!(git(&repo, args, QUICK).await.unwrap().ok(), "{args:?}");
        }
        for name in ["fsmonitor", "textconv", "extdiff"] {
            assert!(!ran(name), "{name} ran on a read path");
        }

        std::fs::create_dir_all(repo.join(".git").join("hooks")).unwrap();
        script(&repo.join(".git").join("hooks"), "pre-commit", 0);
        commit(&GitCommitParams { cwd: repo.display().to_string(), message: "hooked".into(), all: true }).await.unwrap();
        assert!(ran("pre-commit"), "commit must keep the repository's hooks");
        assert!(!ran("fsmonitor"));
    }
}
