//! `cleanup.worktrees`: every linked worktree of the repositories TeleFlock knows on this host,
//! with what deciding whether to delete it takes.
//!
//! **Repositories** are those of the herdr session's workspaces, of its parked agents (their
//! worktree's repository, else their folder's), and of its automations (worktree mode, and the
//! worktrees their runs made). Their linked worktrees come from `git worktree list --porcelain`
//! (main checkouts and bare entries are never listed).
//!
//! **One scan at a time per herdr session**, in the background: a request starts one when the last
//! report is older than [`FRESH`] (or with `refresh`) and waits up to `waitMs` for it. First the
//! git facts and the board are published (a status per worktree, the admin dir's times, a
//! detached HEAD's reachability), then sizes and pull requests fill in as they arrive; earlier
//! values stay shown until replaced. Sizes are kept [`SIZE_TTL`], pull requests by state
//! (`prs::ttl`); `refresh` asks again for all of them. gh missing or signed out stops pull
//! request lookups host-wide for [`GH_DOWN_FOR`]; a repository without a GitHub remote is not
//! asked again for [`NOT_GITHUB_FOR`].
//!
//! **Activity** (`activeAt`) is the newest of the worktree's reflog, index and HEAD file (its admin
//! dir under `<common dir>/worktrees/<id>`: commits, checkouts, `git add`; hostd's own git calls
//! take no optional locks, so its status runs never touch the index), and the last activity of the
//! agents in it: on the board (live or parked), else omp's newest session whose folder is in it.
//! **Created** is when `git worktree add` wrote the admin dir's `commondir`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use tf_proto::{
    Agent, AutomationList, CleanupAgent, CleanupPr, CleanupRepo, CleanupReport, CleanupScanParams,
    CleanupWorktree, Column, HerdrState, Millis, Workspace,
};
use tokio::sync::{Semaphore, watch};

use super::prs::{self, Lookup};
use super::size::{self, Budget, DirSize};
use crate::ops::host::{id_from_file_name, omp_agent_dir, read_head, session_titles};
use crate::ops::worktree::same_path;
use crate::ops::{Ctx, git};
use crate::state::persist::ParkedRecord;
use crate::util::now_ms;

/// A finished report younger than this is answered as is.
const FRESH: Duration = Duration::from_secs(60);
/// Longest `waitMs` (the app's request timeout is 30 s).
pub(crate) const WAIT_MAX_MS: u32 = 20_000;
const SIZE_TTL: Duration = Duration::from_secs(10 * 60);
/// One worktree's size walk: a `node_modules` tree of a few hundred thousand files fits.
const SIZE_ENTRIES: u64 = 3_000_000;
const SIZE_TIME: Duration = Duration::from_secs(20);
const GH_DOWN_FOR: Duration = Duration::from_secs(10 * 60);
const NOT_GITHUB_FOR: Duration = Duration::from_secs(30 * 60);
const QUICK: Duration = Duration::from_secs(10);
const STATUS_BUDGET: Duration = Duration::from_secs(5);
const GIT_PARALLEL: usize = 6;
const SIZE_PARALLEL: usize = 2;
const PR_PARALLEL: usize = 3;

struct PrMemo {
    at: Instant,
    checked_at: Millis,
    found: Result<Option<CleanupPr>, String>,
}

#[derive(Default)]
struct Inner {
    report: Option<CleanupReport>,
    running: bool,
    finished: Option<Instant>,
    /// Worktree path → when measured and what.
    sizes: HashMap<String, (Instant, DirSize)>,
    /// `path \0 branch \0 head` → its pull request.
    prs: HashMap<String, PrMemo>,
    /// Repository root → why its pull requests are unknown.
    not_github: HashMap<String, (Instant, String)>,
    gh_down: Option<(Instant, String)>,
}

#[derive(Default)]
struct Scanner {
    inner: Mutex<Inner>,
    /// Bumped on every publish.
    tick: watch::Sender<u64>,
}

static SCANNERS: LazyLock<Mutex<HashMap<String, Arc<Scanner>>>> = LazyLock::new(Default::default);

fn scanner(session: &str) -> Arc<Scanner> {
    SCANNERS
        .lock()
        .unwrap()
        .entry(session.to_string())
        .or_default()
        .clone()
}

fn empty_report() -> CleanupReport {
    CleanupReport {
        scanned_at: None,
        scanning: false,
        repos: Vec::new(),
        gh_error: None,
    }
}

/// `cleanup.worktrees`.
pub async fn report(ctx: &Ctx, p: &CleanupScanParams) -> CleanupReport {
    let sc = scanner(&ctx.herdr_session);
    let mut rx = sc.tick.subscribe();
    let start = {
        let mut g = sc.inner.lock().unwrap();
        let due = p.refresh || g.finished.is_none_or(|t| t.elapsed() >= FRESH);
        let start = !g.running && due;
        if start {
            g.running = true;
        }
        start
    };
    if start {
        let (ctx, sc, refresh) = (ctx.arc(), sc.clone(), p.refresh);
        tokio::spawn(async move {
            // A scan that panics must not leave `running` set for good.
            if tokio::spawn(run(ctx, sc.clone(), refresh)).await.is_err() {
                {
                    let mut g = sc.inner.lock().unwrap_or_else(|e| e.into_inner());
                    g.running = false;
                    g.finished = None;
                }
                sc.tick.send_modify(|t| *t += 1);
            }
        });
    }
    let wait = Duration::from_millis(u64::from(p.wait_ms.unwrap_or(0).min(WAIT_MAX_MS)));
    if !wait.is_zero() {
        let _ = tokio::time::timeout(wait, async {
            loop {
                let running = sc.inner.lock().unwrap().running;
                if !running || rx.changed().await.is_err() {
                    break;
                }
            }
        })
        .await;
    }
    let g = sc.inner.lock().unwrap();
    let mut r = g.report.clone().unwrap_or_else(empty_report);
    r.scanning = g.running;
    r
}

/// The repository of a worktree the last report listed (a folder already gone has no `.git`).
pub(crate) fn root_of(session: &str, path: &Path) -> Option<PathBuf> {
    let sc = scanner(session);
    let g = sc.inner.lock().unwrap();
    let report = g.report.as_ref()?;
    report
        .repos
        .iter()
        .find(|r| {
            r.worktrees
                .iter()
                .any(|w| same_path(Path::new(&w.path), path))
        })
        .map(|r| PathBuf::from(&r.root))
}

/// Drops a removed worktree from the last report, so the page doesn't show it until the next scan.
pub(crate) fn forget(session: &str, path: &Path) {
    let sc = scanner(session);
    {
        let mut g = sc.inner.lock().unwrap();
        let Some(report) = g.report.as_mut() else {
            return;
        };
        for repo in &mut report.repos {
            repo.worktrees
                .retain(|w| !same_path(Path::new(&w.path), path));
        }
        report
            .repos
            .retain(|r| !r.worktrees.is_empty() || r.error.is_some());
    }
    sc.tick.send_modify(|t| *t += 1);
}

// ───────────────────────────── the scan ─────────────────────────────

async fn run(ctx: Arc<Ctx>, sc: Arc<Scanner>, refresh: bool) {
    let started = Instant::now();
    let board = ctx.state.snapshot();
    let parked = ctx.state.parked_all();
    let autos = crate::automations::get().map(|a| a.list(&ctx.herdr_session));
    let roots = discover(&board.workspaces, &parked, autos.as_ref()).await;
    let sessions_dir = omp_agent_dir().join("sessions");
    let sessions =
        tokio::task::spawn_blocking(move || newest_sessions(&sessions_dir, &session_titles()))
            .await
            .unwrap_or_default();

    let mut repos: Vec<CleanupRepo> = Vec::new();
    let git_slots = Arc::new(Semaphore::new(GIT_PARALLEL));
    for root in roots {
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.display().to_string());
        let records = match list_linked(&root).await {
            Ok(r) => r,
            Err(e) => {
                repos.push(CleanupRepo {
                    root: root.display().to_string(),
                    name,
                    error: Some(e),
                    pr_error: None,
                    worktrees: Vec::new(),
                });
                continue;
            }
        };
        if records.is_empty() {
            continue;
        }
        let common = common_dir(&root).await;
        let mut set = tokio::task::JoinSet::new();
        for (i, rec) in records.into_iter().enumerate() {
            let (root, common, slots) = (root.clone(), common.clone(), git_slots.clone());
            set.spawn(async move {
                let _slot = slots.acquire_owned().await;
                (i, git_facts(&root, common.as_deref(), rec).await)
            });
        }
        let mut worktrees: Vec<(usize, CleanupWorktree)> = Vec::new();
        while let Some(r) = set.join_next().await {
            if let Ok(w) = r {
                worktrees.push(w);
            }
        }
        let mut worktrees: Vec<CleanupWorktree> = worktrees.into_iter().map(|(_, w)| w).collect();
        for w in &mut worktrees {
            add_board(w, &board.workspaces, &board.agents, autos.as_ref());
            add_session(w, &sessions);
        }
        worktrees.sort_by(|a, b| a.path.cmp(&b.path));
        repos.push(CleanupRepo {
            root: root.display().to_string(),
            name,
            error: None,
            pr_error: None,
            worktrees,
        });
    }
    repos.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.root.cmp(&b.root))
    });

    // Cached sizes and pull requests now; the due ones are asked below.
    let (size_jobs, pr_jobs) = {
        let g = sc.inner.lock().unwrap();
        plan(&g, &mut repos, refresh)
    };
    publish(&sc, &repos, false);
    fill(&sc, &mut repos, size_jobs, pr_jobs).await;
    publish(&sc, &repos, true);
    let count: usize = repos.iter().map(|r| r.worktrees.len()).sum();
    tracing::info!(session = %ctx.herdr_session, repos = repos.len(), worktrees = count, ms = started.elapsed().as_millis() as u64, "cleanup scan");
}

fn publish(sc: &Scanner, repos: &[CleanupRepo], done: bool) {
    {
        let mut g = sc.inner.lock().unwrap();
        let gh_error = g
            .gh_down
            .as_ref()
            .filter(|(at, _)| at.elapsed() < GH_DOWN_FOR)
            .map(|(_, e)| e.clone());
        let scanned_at = if done {
            Some(now_ms())
        } else {
            g.report.as_ref().and_then(|r| r.scanned_at)
        };
        g.report = Some(CleanupReport {
            scanned_at,
            scanning: !done,
            repos: repos.to_vec(),
            gh_error,
        });
        if done {
            g.running = false;
            g.finished = Some(Instant::now());
        }
    }
    sc.tick.send_modify(|t| *t += 1);
}

/// `(repo index, worktree index)`.
type At = (usize, usize);

struct PrJob {
    at: At,
    key: String,
    root: String,
    dir: PathBuf,
    branch: Option<String>,
    /// The worktree's HEAD (abbreviated): a settled pull request has to end there.
    head: Option<String>,
}

/// Fills cached sizes and pull requests in, and lists what is due.
fn plan(g: &Inner, repos: &mut [CleanupRepo], refresh: bool) -> (Vec<(At, PathBuf)>, Vec<PrJob>) {
    let gh_down = g
        .gh_down
        .as_ref()
        .is_some_and(|(at, _)| at.elapsed() < GH_DOWN_FOR)
        && !refresh;
    let mut sizes = Vec::new();
    let mut prs = Vec::new();
    for (ri, repo) in repos.iter_mut().enumerate() {
        let not_github = g
            .not_github
            .get(&repo.root)
            .filter(|(at, _)| at.elapsed() < NOT_GITHUB_FOR && !refresh)
            .map(|(_, e)| e.clone());
        repo.pr_error = not_github.clone();
        for (wi, w) in repo.worktrees.iter_mut().enumerate() {
            if !w.missing {
                let cached = g.sizes.get(&w.path);
                if let Some((_, s)) = cached {
                    (w.size, w.size_partial) = (Some(s.bytes), s.partial);
                }
                if refresh || cached.is_none_or(|(at, _)| at.elapsed() >= SIZE_TTL) {
                    sizes.push(((ri, wi), PathBuf::from(&w.path)));
                }
            }
            let Some(branch) = w.branch.clone() else {
                continue;
            };
            let key = format!("{}\0{branch}\0{}", w.path, w.head.as_deref().unwrap_or_default());
            let memo = g.prs.get(&key);
            if let Some(m) = memo {
                show_pr(w, m);
            }
            if gh_down
                || not_github.is_some()
                || memo.is_some_and(|m| !refresh && m.at.elapsed() < prs::ttl(&m.found))
            {
                continue;
            }
            // A folder already gone: by branch name, from the main worktree.
            let (dir, branch) = if w.missing {
                (PathBuf::from(&repo.root), Some(branch))
            } else {
                (PathBuf::from(&w.path), None)
            };
            prs.push(PrJob {
                at: (ri, wi),
                key,
                root: repo.root.clone(),
                dir,
                branch,
                head: w.head.clone(),
            });
        }
    }
    (sizes, prs)
}

fn show_pr(w: &mut CleanupWorktree, m: &PrMemo) {
    w.pr_checked_at = Some(m.checked_at);
    match &m.found {
        Ok(pr) => (w.pr, w.pr_error) = (pr.clone(), None),
        Err(e) => w.pr_error = Some(e.clone()),
    }
}

enum Filled {
    Size(At, String, DirSize),
    Pr(PrJob, Lookup),
}

/// Measures and looks up what is due, publishing as results arrive.
async fn fill(
    sc: &Arc<Scanner>,
    repos: &mut [CleanupRepo],
    sizes: Vec<(At, PathBuf)>,
    pr_jobs: Vec<PrJob>,
) {
    let size_slots = Arc::new(Semaphore::new(SIZE_PARALLEL));
    let pr_slots = Arc::new(Semaphore::new(PR_PARALLEL));
    let mut set: tokio::task::JoinSet<Option<Filled>> = tokio::task::JoinSet::new();
    for (at, path) in sizes {
        let slots = size_slots.clone();
        set.spawn(async move {
            let _slot = slots.acquire_owned().await;
            let key = path.display().to_string();
            let s = tokio::task::spawn_blocking(move || {
                size::measure(&path, Budget::new(SIZE_ENTRIES, SIZE_TIME))
            })
            .await
            .ok()?;
            Some(Filled::Size(at, key, s))
        });
    }
    for job in pr_jobs {
        let (slots, sc) = (pr_slots.clone(), sc.clone());
        set.spawn(async move {
            let _slot = slots.acquire_owned().await;
            // Learned while this one waited for its turn.
            {
                let g = sc.inner.lock().unwrap();
                let down = g
                    .gh_down
                    .as_ref()
                    .is_some_and(|(at, _)| at.elapsed() < GH_DOWN_FOR);
                if down
                    || g.not_github
                        .get(&job.root)
                        .is_some_and(|(at, _)| at.elapsed() < NOT_GITHUB_FOR)
                {
                    return None;
                }
            }
            let found = prs::lookup(&job.dir, job.branch.as_deref(), job.head.as_deref()).await;
            Some(Filled::Pr(job, found))
        });
    }
    while let Some(r) = set.join_next().await {
        let Ok(Some(filled)) = r else { continue };
        {
            let mut g = sc.inner.lock().unwrap();
            match filled {
                Filled::Size((ri, wi), key, s) => {
                    let w = &mut repos[ri].worktrees[wi];
                    (w.size, w.size_partial) = (Some(s.bytes), s.partial);
                    g.sizes.insert(key, (Instant::now(), s));
                }
                Filled::Pr(_, Lookup::GhDown(e)) => {
                    tracing::info!("cleanup: no pull requests from gh on this host: {e}");
                    g.gh_down = Some((Instant::now(), e));
                }
                Filled::Pr(job, Lookup::NotGithub(e)) => {
                    for repo in repos.iter_mut().filter(|r| r.root == job.root) {
                        repo.pr_error = Some(e.clone());
                    }
                    g.not_github.insert(job.root, (Instant::now(), e));
                }
                Filled::Pr(job, Lookup::Found(pr)) => remember(&mut g, repos, job, Ok(pr)),
                Filled::Pr(job, Lookup::Failed(e)) => remember(&mut g, repos, job, Err(e)),
            }
        }
        publish(sc, repos, false);
    }
}

fn remember(
    g: &mut Inner,
    repos: &mut [CleanupRepo],
    job: PrJob,
    found: Result<Option<CleanupPr>, String>,
) {
    let memo = PrMemo {
        at: Instant::now(),
        checked_at: now_ms(),
        found,
    };
    let (ri, wi) = job.at;
    show_pr(&mut repos[ri].worktrees[wi], &memo);
    g.prs.insert(job.key, memo);
}

// ───────────────────────────── discovery ─────────────────────────────

/// Main worktree roots of the repositories the board, parked agents and automations name.
async fn discover(
    workspaces: &[Workspace],
    parked: &[ParkedRecord],
    autos: Option<&AutomationList>,
) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut probe: Vec<PathBuf> = Vec::new();
    for w in workspaces {
        if let Some(r) = &w.repo {
            roots.push(PathBuf::from(&r.root));
        }
    }
    for r in parked {
        match (&r.worktree, &r.cwd) {
            (Some(wt), _) => roots.push(PathBuf::from(&wt.repo_root)),
            (None, Some(cwd)) => probe.push(PathBuf::from(cwd)),
            _ => {}
        }
    }
    if let Some(list) = autos {
        probe.extend(
            list.automations
                .iter()
                .filter(|a| a.worktree)
                .map(|a| PathBuf::from(&a.cwd)),
        );
        probe.extend(
            list.runs
                .iter()
                .filter_map(|r| r.path.as_deref())
                .map(PathBuf::from),
        );
    }
    let mut asked: HashSet<PathBuf> = HashSet::new();
    for dir in probe {
        if !asked.insert(dir.clone()) || !dir.is_dir() {
            continue;
        }
        if let Ok(Some(top)) = git::repo_top(&dir).await {
            roots.push(top.root);
        }
    }
    let mut seen: HashSet<PathBuf> = HashSet::new();
    roots.retain(|r| {
        r.is_dir() && seen.insert(std::fs::canonicalize(r).unwrap_or_else(|_| r.clone()))
    });
    roots
}

/// Linked worktrees of the repository at `root` (never its main checkout or a bare entry).
async fn list_linked(root: &Path) -> Result<Vec<git::WorktreeRecord>, String> {
    let out = git::git(root, &["worktree", "list", "--porcelain"], QUICK)
        .await
        .map_err(|e| e.message)?;
    if !out.ok() {
        return Err(out.message().trim_start_matches("fatal: ").to_string());
    }
    Ok(git::parse_worktree_porcelain(&out.stdout_str())
        .into_iter()
        .skip(1)
        .filter(|w| !w.bare)
        .collect())
}

async fn common_dir(root: &Path) -> Option<PathBuf> {
    let dot = root.join(".git");
    if dot.is_dir() {
        return Some(dot);
    }
    let out = git::git(
        root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        QUICK,
    )
    .await
    .ok()?;
    out.ok().then(|| PathBuf::from(out.line()))
}

// ───────────────────────────── facts ─────────────────────────────

/// What git says about one linked worktree.
async fn git_facts(
    root: &Path,
    common: Option<&Path>,
    rec: git::WorktreeRecord,
) -> CleanupWorktree {
    let path = PathBuf::from(&rec.path);
    let missing = rec.prunable || !path.is_dir();
    let (dirty, unpushed) = if missing {
        (None, None)
    } else {
        status(&path).await
    };
    let orphan_commits = match (&rec.head, rec.detached) {
        (Some(head), true) => reachable(root, head).await != Some(true),
        _ => false,
    };
    let admin = common.and_then(|c| admin_dir(&path, c));
    let (created_at, git_active) = admin.as_deref().map(admin_times).unwrap_or_default();
    CleanupWorktree {
        head: rec.head.as_ref().map(|h| h.chars().take(7).collect()),
        branch: rec.branch,
        missing,
        locked: rec.locked,
        dirty,
        unpushed,
        orphan_commits,
        workspace_id: None,
        agents: 0,
        busy: false,
        created_at,
        active_at: git_active,
        size: None,
        size_partial: false,
        pr: None,
        pr_checked_at: None,
        pr_error: None,
        last_agent: None,
        automation: None,
        path: rec.path,
    }
}

/// Changed files, and commits ahead of the upstream (when it has one).
async fn status(path: &Path) -> (Option<u32>, Option<u32>) {
    let args = [
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=normal",
        "--ignore-submodules=dirty",
    ];
    match git::git(path, &args, STATUS_BUDGET).await {
        Ok(o) if o.ok() => {
            let st = git::parse_status_v2(&o.stdout);
            (
                Some(st.entries.len() as u32),
                st.upstream.is_some().then_some(st.ahead),
            )
        }
        _ => (None, None),
    }
}

/// Whether a branch, tag or remote branch contains `commit` (`None`: git couldn't tell).
pub(crate) async fn reachable(root: &Path, commit: &str) -> Option<bool> {
    let args = [
        "for-each-ref",
        "--count=1",
        "--format=%(refname)",
        "--contains",
        commit,
        "refs/heads",
        "refs/remotes",
        "refs/tags",
    ];
    let out = git::git(root, &args, QUICK).await.ok()?;
    out.ok().then(|| !out.stdout_str().trim().is_empty())
}

/// The worktree's admin dir (`<common>/worktrees/<id>`): from its `.git` file, else (the folder is
/// gone) the one whose `gitdir` file names `<path>/.git`.
pub(crate) fn admin_dir(path: &Path, common: &Path) -> Option<PathBuf> {
    if let Ok(text) = std::fs::read_to_string(path.join(".git"))
        && let Some(dir) = text.trim().strip_prefix("gitdir:")
    {
        let dir = PathBuf::from(dir.trim());
        return Some(if dir.is_absolute() {
            dir
        } else {
            path.join(dir)
        });
    }
    for e in std::fs::read_dir(common.join("worktrees")).ok()?.flatten() {
        let Ok(gitdir) = std::fs::read_to_string(e.path().join("gitdir")) else {
            continue;
        };
        if Path::new(gitdir.trim())
            .parent()
            .is_some_and(|p| same_path(p, path))
        {
            return Some(e.path());
        }
    }
    None
}

fn mtime_ms(p: &Path) -> Option<Millis> {
    let t = std::fs::metadata(p).ok()?.modified().ok()?;
    Some(t.duration_since(UNIX_EPOCH).ok()?.as_millis() as Millis)
}

/// `(created, last git activity)` from the admin dir's files.
pub(crate) fn admin_times(admin: &Path) -> (Option<Millis>, Option<Millis>) {
    let created = mtime_ms(&admin.join("commondir")).or_else(|| mtime_ms(admin));
    let active = ["logs/HEAD", "index", "HEAD"]
        .iter()
        .filter_map(|f| mtime_ms(&admin.join(f)))
        .max();
    (created, active)
}

/// `child` is `parent` or inside it (lexically, by components).
pub(crate) fn inside(child: &Path, parent: &Path) -> bool {
    child.starts_with(parent)
}

/// A working agent is found through symlinks too (a symlinked `/home`, macOS `/tmp`): removal matches
/// the herdr workspace by canonical path, so the busy check has to as well. Lexical first (cheap), then
/// canonical, with the worktree's own canonical path taken once.
struct Canon<'p> {
    path: &'p Path,
    canon: Option<PathBuf>,
}

impl<'p> Canon<'p> {
    fn new(path: &'p Path) -> Self {
        Self {
            path,
            canon: std::fs::canonicalize(path).ok(),
        }
    }

    fn same(&self, other: &Path) -> bool {
        other == self.path
            || self
                .canon
                .as_deref()
                .is_some_and(|c| std::fs::canonicalize(other).is_ok_and(|o| o == c))
    }

    fn contains(&self, other: &Path) -> bool {
        inside(other, self.path)
            || self
                .canon
                .as_deref()
                .is_some_and(|c| std::fs::canonicalize(other).is_ok_and(|o| o.starts_with(c)))
    }
}

/// An agent working or waiting for the user: its worktree is never removed under it.
pub(crate) fn is_busy(a: &Agent) -> bool {
    matches!(a.column, Column::Running | Column::Needs)
        || matches!(a.state, HerdrState::Working | HerdrState::Blocked)
}

/// The board's agents in a worktree: live ones by their workspace or folder, parked ones by the
/// worktree they remember or their folder. Also the workspace showing it. Paths match lexically or
/// canonically (through symlinks).
pub(crate) fn agents_in<'a>(
    workspaces: &[Workspace],
    agents: &'a [Agent],
    path: &Path,
) -> (Option<String>, Vec<&'a Agent>) {
    let at = Canon::new(path);
    let ws_id = workspaces
        .iter()
        .find(|w| w.worktree.as_ref().is_some_and(|t| at.same(Path::new(&t.path))))
        .map(|w| w.id.clone());
    let found = agents
        .iter()
        .filter(|a| {
            let by_cwd = a.cwd.as_deref().is_some_and(|c| at.contains(Path::new(c)));
            match &a.parked {
                None => by_cwd || ws_id.as_deref().is_some_and(|id| a.workspace_id == id),
                Some(p) => {
                    by_cwd
                        || p.worktree
                            .as_ref()
                            .is_some_and(|w| at.same(Path::new(&w.path)))
                }
            }
        })
        .collect();
    (ws_id, found)
}

fn agent_at(a: &Agent) -> Millis {
    let live = a
        .live
        .last_event_at
        .or(a.started_at)
        .unwrap_or(a.state_since)
        .max(a.state_since);
    match &a.parked {
        Some(p) => p.at.max(live),
        None => live,
    }
}

fn add_board(
    w: &mut CleanupWorktree,
    workspaces: &[Workspace],
    agents: &[Agent],
    autos: Option<&AutomationList>,
) {
    let path = PathBuf::from(&w.path);
    let (ws, found) = agents_in(workspaces, agents, &path);
    w.workspace_id = ws;
    w.agents = found.iter().filter(|a| a.parked.is_none()).count() as u32;
    w.busy = found.iter().any(|a| a.parked.is_none() && is_busy(a));
    if let Some(a) = found.iter().max_by_key(|a| agent_at(a)) {
        let at = agent_at(a);
        w.active_at = Some(w.active_at.map_or(at, |t| t.max(at)));
        w.last_agent = Some(CleanupAgent {
            agent_id: Some(a.id.clone()),
            name: Some(a.name.clone()),
            title: Some(a.title.clone()).filter(|t| !t.is_empty()),
            state: a.parked.is_none().then_some(a.state),
            parked: a.parked.is_some(),
            at,
        });
    }
    if let Some(list) = autos {
        let run = list
            .runs
            .iter()
            .filter(|r| {
                r.path
                    .as_deref()
                    .is_some_and(|p| same_path(Path::new(p), &path))
            })
            .max_by_key(|r| r.at);
        w.automation = run
            .and_then(|r| list.automations.iter().find(|a| a.id == r.automation_id))
            .map(|a| a.name.clone());
    }
}

/// omp's newest session in one session folder.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SeenSession {
    pub cwd: PathBuf,
    pub at: Millis,
    pub title: Option<String>,
}

/// The newest session of each of omp's session folders (`<sessions>/<encoded cwd>/*.jsonl`; one
/// folder per working directory, so its newest file names the folder's cwd), titled from omp's
/// `history.db` (`titles`: session id → title), else the file's own title. Blocking.
pub(crate) fn newest_sessions(dir: &Path, titles: &HashMap<String, String>) -> Vec<SeenSession> {
    let Ok(buckets) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut newest: Vec<(Millis, PathBuf)> = Vec::new();
    for bucket in buckets.flatten() {
        if !bucket.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let Ok(files) = std::fs::read_dir(bucket.path()) else {
            continue;
        };
        let best = files
            .flatten()
            .filter(|f| f.path().extension().is_some_and(|e| e == "jsonl"))
            .filter_map(|f| {
                let m = f.metadata().ok().filter(|m| m.is_file())?;
                let at = m
                    .modified()
                    .ok()?
                    .duration_since(UNIX_EPOCH)
                    .ok()?
                    .as_millis() as Millis;
                Some((at, f.path()))
            })
            .max_by_key(|(at, _)| *at);
        newest.extend(best);
    }
    newest
        .into_iter()
        .filter_map(|(at, file)| {
            let head = read_head(&file);
            let cwd = PathBuf::from(head.cwd?);
            let id = head.id.clone().or_else(|| id_from_file_name(&file));
            let title = id.and_then(|id| titles.get(&id).cloned()).or(head.title);
            Some(SeenSession { cwd, at, title })
        })
        .collect()
}

/// omp's newest session in the worktree, when no agent on the board was there since.
fn add_session(w: &mut CleanupWorktree, sessions: &[SeenSession]) {
    let path = Path::new(&w.path);
    let Some(s) = sessions
        .iter()
        .filter(|s| inside(&s.cwd, path))
        .max_by_key(|s| s.at)
    else {
        return;
    };
    w.active_at = Some(w.active_at.map_or(s.at, |t| t.max(s.at)));
    if w.last_agent.as_ref().is_some_and(|a| a.at >= s.at) {
        return;
    }
    w.last_agent = Some(CleanupAgent {
        agent_id: None,
        name: None,
        title: s.title.clone(),
        state: None,
        parked: false,
        at: s.at,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::git::tests::{fixture, sh};
    use serde_json::json;

    fn agent(
        id: &str,
        ws: &str,
        cwd: &str,
        state: &str,
        column: &str,
        parked: Option<serde_json::Value>,
    ) -> Agent {
        let mut v = json!({
            "id": id, "name": id, "kind": "omp", "paneId": "", "tabId": "", "workspaceId": ws,
            "state": state, "stateSince": 100, "column": column, "archived": false,
            "turns": 1, "title": format!("{id} task"), "cwd": cwd,
            "live": { "streaming": false, "thinking": false, "lastEventAt": 500 },
        });
        if let Some(p) = parked {
            v["parked"] = p;
        }
        serde_json::from_value(v).unwrap()
    }

    fn workspace(id: &str, path: &str) -> Workspace {
        serde_json::from_value(json!({
            "id": id, "label": id, "cwd": path, "tabs": [], "rollup": "idle", "order": 0,
            "worktree": { "path": path }
        }))
        .unwrap()
    }

    fn blank(path: &str) -> CleanupWorktree {
        CleanupWorktree {
            path: path.into(),
            branch: Some("b".into()),
            head: None,
            missing: false,
            locked: None,
            dirty: Some(0),
            unpushed: None,
            orphan_commits: false,
            workspace_id: None,
            agents: 0,
            busy: false,
            created_at: None,
            active_at: Some(10),
            size: None,
            size_partial: false,
            pr: None,
            pr_checked_at: None,
            pr_error: None,
            last_agent: None,
            automation: None,
        }
    }

    #[test]
    fn board_agents_make_a_worktree_busy_and_name_its_last_agent() {
        let wss = [workspace("w4", "/wt/feat"), workspace("w5", "/wt/feat-2")];
        let agents = [
            agent("idle", "w4", "/wt/feat", "idle", "review", None),
            agent(
                "sub",
                "w9",
                "/wt/feat/packages/ui",
                "working",
                "running",
                None,
            ),
            agent("other", "w5", "/wt/feat-2", "working", "running", None),
            agent(
                "old",
                "",
                "/elsewhere",
                "idle",
                "done",
                Some(
                    json!({ "at": 900, "sessionFile": "/s.jsonl", "worktree": { "path": "/wt/feat", "repoRoot": "/r" } }),
                ),
            ),
        ];
        let mut w = blank("/wt/feat");
        add_board(&mut w, &wss, &agents, None);
        assert_eq!(w.workspace_id.as_deref(), Some("w4"));
        assert_eq!(
            (w.agents, w.busy),
            (2, true),
            "a working agent in a subfolder makes it busy; `feat-2` is another worktree"
        );
        let last = w.last_agent.unwrap();
        assert_eq!(
            (last.name.as_deref(), last.parked, last.at),
            (Some("old"), true, 900),
            "the parked agent closed last"
        );
        assert_eq!(w.active_at, Some(900));

        let mut idle = blank("/wt/feat-2");
        add_board(&mut idle, &wss, &agents[..1], None);
        assert_eq!(
            (
                idle.workspace_id.as_deref(),
                idle.agents,
                idle.busy,
                idle.last_agent
            ),
            (Some("w5"), 0, false, None)
        );
    }

    #[test]
    fn needs_you_is_busy_too() {
        assert!(is_busy(&agent("a", "w", "/x", "blocked", "needs", None)));
        assert!(is_busy(&agent("a", "w", "/x", "idle", "needs", None)));
        assert!(!is_busy(&agent("a", "w", "/x", "idle", "review", None)));
        assert!(!is_busy(&agent("a", "w", "/x", "done", "done", None)));
    }

    #[cfg(unix)]
    #[test]
    fn a_working_agent_is_found_through_a_symlinked_path() {
        let td = tempfile::tempdir().unwrap();
        let real = td.path().join("real");
        std::fs::create_dir_all(real.join("wt/feat/pkg")).unwrap();
        let link = td.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let (via_link, via_real) = (link.join("wt/feat"), real.join("wt/feat"));
        let by = |p: &Path| p.display().to_string();
        // The agent's cwd and the workspace come through the symlink; the report's path is the real one.
        let wss = [workspace("w1", &by(&via_link))];
        let agents = [
            agent("sub", "w9", &by(&via_link.join("pkg")), "working", "running", None),
            agent("parked", "", "/elsewhere", "idle", "done", Some(json!({ "at": 5, "sessionFile": "/s.jsonl", "worktree": { "path": by(&via_link), "repoRoot": "/r" } }))),
        ];
        let mut w = blank(&by(&via_real));
        add_board(&mut w, &wss, &agents, None);
        assert_eq!(w.workspace_id.as_deref(), Some("w1"));
        assert_eq!((w.agents, w.busy), (2 - 1, true), "the working agent counts; the parked one is no live agent");
        assert!(agents_in(&wss, &agents, &via_real).1.len() == 2);
        let sibling = td.path().join("real/wt/other");
        std::fs::create_dir_all(&sibling).unwrap();
        assert!(agents_in(&wss, &agents, &sibling).1.is_empty(), "a sibling folder is not it");
    }

    #[test]
    fn newest_session_per_folder_names_the_last_agent() {
        let td = tempfile::tempdir().unwrap();
        let write = |bucket: &str, file: &str, cwd: &str, title: &str, age_s: u64| {
            let dir = td.path().join(bucket);
            std::fs::create_dir_all(&dir).unwrap();
            let p = dir.join(file);
            std::fs::write(
                &p,
                format!(
                    "{}\n",
                    json!({ "type": "session", "id": file, "cwd": cwd, "title": title })
                ),
            )
            .unwrap();
            let t = std::time::SystemTime::now() - Duration::from_secs(age_s);
            std::fs::File::options()
                .write(true)
                .open(&p)
                .unwrap()
                .set_modified(t)
                .unwrap();
        };
        write("-wt-feat", "a.jsonl", "/wt/feat", "older", 300);
        write("-wt-feat", "b.jsonl", "/wt/feat", "newest", 100);
        write(
            "-wt-feat-sub",
            "c.jsonl",
            "/wt/feat/sub",
            "in a subfolder",
            200,
        );
        write("-other", "d.jsonl", "/other", "elsewhere", 10);
        std::fs::write(td.path().join("stray.jsonl"), "{}").unwrap();
        let titles: HashMap<String, String> =
            [("c.jsonl".to_string(), "titled by history.db".to_string())].into();
        let seen = newest_sessions(td.path(), &titles);
        assert_eq!(seen.len(), 3);
        assert!(
            seen.iter()
                .any(|s| s.title.as_deref() == Some("titled by history.db"))
        );

        let mut w = blank("/wt/feat");
        add_session(&mut w, &seen);
        let last = w.last_agent.clone().unwrap();
        assert_eq!(
            (last.title.as_deref(), last.agent_id),
            (Some("newest"), None)
        );
        assert_eq!(w.active_at, Some(last.at));

        // An agent on the board seen since wins.
        let mut w = blank("/wt/feat");
        w.last_agent = Some(CleanupAgent {
            agent_id: Some("x".into()),
            name: Some("x".into()),
            title: None,
            state: None,
            parked: true,
            at: now_ms(),
        });
        add_session(&mut w, &seen);
        assert_eq!(w.last_agent.unwrap().agent_id.as_deref(), Some("x"));
    }

    /// Created and last-active times come from the admin dir, also once the folder is gone;
    /// a detached HEAD on a commit only it knows is flagged.
    #[tokio::test]
    async fn git_facts_of_linked_worktrees() {
        let td = fixture();
        let root = td.path();
        let parent = root.parent().unwrap();
        let name = |n: &str| {
            parent.join(format!(
                "{}-{n}",
                root.file_name().unwrap().to_string_lossy()
            ))
        };
        let (feat, det, gone) = (name("feat"), name("det"), name("gone"));
        sh(
            root,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "wt-feat",
                feat.to_str().unwrap(),
                "main",
            ],
        );
        sh(
            root,
            &[
                "worktree",
                "add",
                "-q",
                "--detach",
                det.to_str().unwrap(),
                "main",
            ],
        );
        sh(
            root,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "gone",
                gone.to_str().unwrap(),
                "main",
            ],
        );
        std::fs::write(feat.join("new.txt"), "x\n").unwrap();
        std::fs::remove_dir_all(&gone).unwrap();
        sh(
            root,
            &[
                "worktree",
                "lock",
                "--reason",
                "usb disk",
                feat.to_str().unwrap(),
            ],
        );

        let records = list_linked(root).await.unwrap();
        assert_eq!(records.len(), 3, "never the main checkout");
        let common = common_dir(root).await.unwrap();
        let mut facts = Vec::new();
        for r in records {
            facts.push(git_facts(root, Some(&common), r).await);
        }
        let by = |p: &Path| {
            facts
                .iter()
                .find(|f| same_path(Path::new(&f.path), p))
                .unwrap()
                .clone()
        };
        let f = by(&feat);
        assert_eq!(
            (
                f.branch.as_deref(),
                f.dirty,
                f.missing,
                f.locked.as_deref(),
                f.orphan_commits
            ),
            (Some("wt-feat"), Some(1), false, Some("usb disk"), false)
        );
        assert!(f.created_at.is_some() && f.active_at.is_some());
        let g = by(&gone);
        assert!(g.missing && g.dirty.is_none());
        assert!(g.created_at.is_some(), "the admin dir outlives the folder");
        let d = by(&det);
        assert!(
            d.branch.is_none() && !d.orphan_commits,
            "detached on main: main contains it"
        );

        // A commit only the detached HEAD knows.
        std::fs::write(det.join("lone.txt"), "y\n").unwrap();
        sh(&det, &["add", "."]);
        sh(&det, &["commit", "-q", "-m", "lone"]);
        let rec = list_linked(root)
            .await
            .unwrap()
            .into_iter()
            .find(|r| same_path(Path::new(&r.path), &det))
            .unwrap();
        assert!(git_facts(root, Some(&common), rec).await.orphan_commits);
    }

    #[tokio::test]
    async fn discovery_dedupes_and_probes_parked_folders() {
        let td = fixture();
        let root = td.path().to_path_buf();
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let ws: Workspace = serde_json::from_value(json!({
            "id": "w1", "label": "r", "cwd": root.display().to_string(), "tabs": [], "rollup": "idle", "order": 0,
            "repo": { "root": root.display().to_string(), "name": "r" }
        }))
        .unwrap();
        let parked = [ParkedRecord {
            cwd: Some(sub.display().to_string()),
            ..Default::default()
        }];
        let roots = discover(&[ws], &parked, None).await;
        assert_eq!(roots.len(), 1);
        assert!(same_path(&roots[0], &root));
    }
}
