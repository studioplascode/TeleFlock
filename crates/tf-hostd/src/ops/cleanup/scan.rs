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
//! git facts, the board and the owners are published (a status per worktree, its last use, a
//! detached HEAD's reachability), then sizes and pull requests fill in as they arrive; earlier
//! values stay shown until replaced. Sizes are kept [`SIZE_TTL`], pull requests by state
//! (`prs::ttl`); `refresh` asks again for all of them. gh missing or signed out stops pull
//! request lookups host-wide for [`GH_DOWN_FOR`]; a repository without a GitHub remote is not
//! asked again for [`NOT_GITHUB_FOR`].
//!
//! **Last use** (`activeAt`, `activeBy`) is the newest real use, never a read: the last entry of an
//! omp session or subagent transcript that worked in it (`sessions.rs`), the newest entry of its
//! HEAD reflog (a commit, checkout, merge or reset made in it, at the time git wrote into the
//! entry), the newest of the files `git status` lists as changed, and a live agent's last event.
//! Never the admin dir's file times: `git gc` (also the automatic one after commits and fetches,
//! and `git maintenance`) rewrites every worktree's reflog at once (`git reflog expire --all`), and
//! any `git status` that takes optional locks rewrites the index; in a busy repository that made
//! every worktree "used 53 minutes ago". (hostd's own git calls take no optional locks; gh only
//! reads.) **Created** is when `git worktree add` wrote the admin dir's `commondir`.
//!
//! **Owner** (`owner`, the report's `owners`): the main agent a worktree belongs to. An agent on the
//! board in it (working or needing you first, then live, then the latest) or the latest top-level
//! session whose own folder is in it; else the main agent whose session or subagents worked in it
//! first since it was created. omp keeps subagent transcripts in their session's artifacts dir, so
//! a subagent's work counts for its top-level session; a main session on the board is named by its
//! card.

use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use tf_proto::{
    Agent, AutomationList, CleanupAgent, CleanupOwner, CleanupOwnerRef, CleanupOwnerState, CleanupPr, CleanupRepo,
    CleanupReport, CleanupScanParams, CleanupWorktree, Column, HerdrState, Millis, Workspace, WorktreeUse,
};
use tokio::sync::{Semaphore, watch};

use super::prs::{self, Lookup};
use super::sessions::{self, MainFacts, WorkedIn};
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
/// Reading omp's session files per scan stops after this (the rest waits for the next scan).
const SESSIONS_BUDGET: Duration = Duration::from_secs(15);
/// Changed files whose times are looked at per worktree.
const CHANGED_FILES: usize = 200;
/// The tail of a reflog read for its newest entry.
const REFLOG_TAIL: u64 = 8192;
/// Work in a folder that ended this long before its worktree was created was in an earlier
/// checkout at that path.
const BEFORE_CREATED_MS: Millis = 60_000;
/// Subagent names kept per worktree.
const SUBAGENTS_SHOWN: usize = 6;

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
        owners: None,
        sessions_pending: None,
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
    // Chats (§3.31) are never repositories: git is not asked about their folders.
    let parked: Vec<ParkedRecord> = ctx.state.parked_all().into_iter().filter(|r| r.cwd.as_deref().is_none_or(|c| !ctx.chats.holds(Path::new(c)))).collect();
    let autos = crate::automations::get().map(|a| a.list(&ctx.herdr_session));
    let roots = discover(&board.workspaces, &parked, autos.as_ref()).await;
    let mut listed = Vec::new();
    for root in roots {
        let records = list_linked(&root).await;
        listed.push((root, records));
    }
    // omp's sessions are read on the blocking pool while git answers; the board's first.
    let paths: Vec<PathBuf> = listed
        .iter()
        .filter_map(|(_, r)| r.as_ref().ok())
        .flatten()
        .map(|w| PathBuf::from(&w.path))
        .collect();
    let first: HashSet<PathBuf> = board
        .agents
        .iter()
        .filter_map(|a| a.omp.as_ref()?.session_file.as_deref())
        .map(PathBuf::from)
        .collect();
    let sessions = tokio::task::spawn_blocking(move || read_sessions(paths, first));

    let mut repos: Vec<CleanupRepo> = Vec::new();
    let mut clues: HashMap<String, Clues> = HashMap::new();
    let git_slots = Arc::new(Semaphore::new(GIT_PARALLEL));
    for (root, records) in listed {
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.display().to_string());
        let records = match records {
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
        for rec in records {
            let (root, common, slots) = (root.clone(), common.clone(), git_slots.clone());
            set.spawn(async move {
                let _slot = slots.acquire_owned().await;
                git_facts(&root, common.as_deref(), rec).await
            });
        }
        let mut worktrees: Vec<CleanupWorktree> = Vec::new();
        while let Some(r) = set.join_next().await {
            if let Ok((w, c)) = r {
                clues.insert(w.path.clone(), c);
                worktrees.push(w);
            }
        }
        for w in &mut worktrees {
            let board_ids = add_board(w, &board.workspaces, &board.agents, autos.as_ref());
            clues.entry(w.path.clone()).or_default().board = board_ids;
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
    let sessions = sessions.await.unwrap_or_default();
    let extra = Extra {
        owners: attribute(&mut repos, &clues, &sessions, &board.agents),
        pending: sessions.pending,
    };

    // Cached sizes and pull requests now; the due ones are asked below.
    let (size_jobs, pr_jobs) = {
        let g = sc.inner.lock().unwrap();
        plan(&g, &mut repos, refresh)
    };
    publish(&sc, &repos, &extra, false);
    fill(&sc, &mut repos, &extra, size_jobs, pr_jobs).await;
    publish(&sc, &repos, &extra, true);
    let count: usize = repos.iter().map(|r| r.worktrees.len()).sum();
    tracing::info!(session = %ctx.herdr_session, repos = repos.len(), worktrees = count, owners = extra.owners.len(), sessions_pending = extra.pending, ms = started.elapsed().as_millis() as u64, "cleanup scan");
}

/// What a report carries beside its repositories.
#[derive(Debug, Default)]
struct Extra {
    owners: Vec<CleanupOwner>,
    /// omp session files not read yet.
    pending: usize,
}

fn publish(sc: &Scanner, repos: &[CleanupRepo], extra: &Extra, done: bool) {
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
            owners: Some(extra.owners.clone()),
            sessions_pending: (extra.pending > 0).then(|| u32::try_from(extra.pending).unwrap_or(u32::MAX)),
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
    extra: &Extra,
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
        publish(sc, repos, extra, false);
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

/// What a scan learned about a worktree beyond its wire facts.
#[derive(Debug, Default)]
struct Clues {
    /// When its HEAD last moved ([`head_moved_at`]).
    git: Option<Millis>,
    /// When its uncommitted changes were last touched ([`changed_at`]).
    files: Option<Millis>,
    /// Agents on the board in it (ids).
    board: Vec<String>,
}

/// What git says about one linked worktree.
async fn git_facts(root: &Path, common: Option<&Path>, rec: git::WorktreeRecord) -> (CleanupWorktree, Clues) {
    let path = PathBuf::from(&rec.path);
    let missing = rec.prunable || !path.is_dir();
    let (dirty, unpushed, files) = if missing {
        (None, None, None)
    } else {
        status(&path).await
    };
    let orphan_commits = match (&rec.head, rec.detached) {
        (Some(head), true) => reachable(root, head).await != Some(true),
        _ => false,
    };
    let admin = common.and_then(|c| admin_dir(&path, c));
    let w = CleanupWorktree {
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
        created_at: admin.as_deref().and_then(created_at),
        active_at: None,
        active_by: None,
        size: None,
        size_partial: false,
        pr: None,
        pr_checked_at: None,
        pr_error: None,
        last_agent: None,
        owner: None,
        automation: None,
        path: rec.path,
    };
    let clues = Clues {
        git: admin.as_deref().and_then(head_moved_at),
        files,
        board: Vec::new(),
    };
    (w, clues)
}

/// Changed files, commits ahead of the upstream (when it has one), and when the changes were last
/// touched.
async fn status(path: &Path) -> (Option<u32>, Option<u32>, Option<Millis>) {
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
                changed_at(path, &st.entries),
            )
        }
        _ => (None, None, None),
    }
}

/// When a worktree's uncommitted changes were last touched: the newest time among the files git
/// lists (at most [`CHANGED_FILES`]; an untracked folder by its own time, a deleted file by its
/// folder's). Never a walk of the tree.
fn changed_at(root: &Path, entries: &[git::StatusEntry]) -> Option<Millis> {
    entries
        .iter()
        .take(CHANGED_FILES)
        .filter_map(|e| {
            let p = root.join(e.path.trim_end_matches('/'));
            lmtime_ms(&p).or_else(|| p.parent().and_then(lmtime_ms))
        })
        .max()
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

/// [`mtime_ms`] of the link itself, not what it points at.
fn lmtime_ms(p: &Path) -> Option<Millis> {
    let t = std::fs::symlink_metadata(p).ok()?.modified().ok()?;
    Some(t.duration_since(UNIX_EPOCH).ok()?.as_millis() as Millis)
}

/// When `git worktree add` made the worktree: its admin dir's `commondir`, written once.
pub(crate) fn created_at(admin: &Path) -> Option<Millis> {
    mtime_ms(&admin.join("commondir")).or_else(|| mtime_ms(admin))
}

/// When the worktree's HEAD last moved (a commit, checkout, merge, rebase or reset made in it):
/// the newest entry of its reflog, at the time git wrote into the entry; without one, when its
/// HEAD file was written (a checkout). Never the reflog's own file time: `git gc` rewrites every
/// worktree's reflog (`git reflog expire --all`), and with it every mtime.
pub(crate) fn head_moved_at(admin: &Path) -> Option<Millis> {
    reflog_at(&admin.join("logs").join("HEAD")).or_else(|| mtime_ms(&admin.join("HEAD")))
}

/// The newest entry time in the tail of a reflog.
fn reflog_at(log: &Path) -> Option<Millis> {
    let mut f = std::fs::File::open(log).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(REFLOG_TAIL))).ok()?;
    let mut tail = Vec::new();
    f.take(REFLOG_TAIL).read_to_end(&mut tail).ok()?;
    tail.split(|b| *b == b'\n').filter_map(reflog_time).max()
}

/// A reflog entry's time: `<old> <new> <name> <<email>> <seconds> <±hhmm>\t<message>`.
fn reflog_time(line: &[u8]) -> Option<Millis> {
    let who = line.split(|b| *b == b'\t').next()?;
    let who = std::str::from_utf8(who).ok()?;
    let mut words = who.rsplit(' ');
    let tz = words.next()?;
    if tz.len() != 5 || !(tz.starts_with('+') || tz.starts_with('-')) {
        return None;
    }
    words.next()?.parse::<Millis>().ok()?.checked_mul(1000)
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

/// The board's facts about a worktree: the workspace showing it, its live agents, whether one is
/// busy, the newest agent in it (`lastAgent`) and the automation that made it. Returns the ids of
/// the board's agents in it.
fn add_board(
    w: &mut CleanupWorktree,
    workspaces: &[Workspace],
    agents: &[Agent],
    autos: Option<&AutomationList>,
) -> Vec<String> {
    let path = PathBuf::from(&w.path);
    let (ws, found) = agents_in(workspaces, agents, &path);
    w.workspace_id = ws;
    w.agents = found.iter().filter(|a| a.parked.is_none()).count() as u32;
    w.busy = found.iter().any(|a| a.parked.is_none() && is_busy(a));
    if let Some(a) = found.iter().max_by_key(|a| agent_at(a)) {
        w.last_agent = Some(CleanupAgent {
            agent_id: Some(a.id.clone()),
            name: Some(a.name.clone()),
            title: Some(a.title.clone()).filter(|t| !t.is_empty()),
            state: a.parked.is_none().then_some(a.state),
            parked: a.parked.is_some(),
            at: agent_at(a),
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
    found.iter().map(|a| a.id.clone()).collect()
}

// ───────────────────────────── owners ─────────────────────────────

/// What omp's sessions say about the scanned worktrees.
#[derive(Debug, Default)]
struct SessionFacts {
    /// Worktree path → the main agents that worked in it.
    worked: HashMap<String, Vec<WorkedIn>>,
    /// Main session file → what its transcripts say.
    mains: HashMap<PathBuf, MainFacts>,
    /// omp session id → its title (`history.db`).
    titles: HashMap<String, String>,
    /// Session files not read yet.
    pending: usize,
}

/// Reads omp's sessions (blocking): who worked in each of `paths`, and when. `first` (the board's
/// session files) are read before the others.
fn read_sessions(paths: Vec<PathBuf>, first: HashSet<PathBuf>) -> SessionFacts {
    let dir = omp_agent_dir().join("sessions");
    let home = crate::paths::home_dir();
    let (worked, mains, pending) = sessions::with_index(&dir, Some(&home), &first, SESSIONS_BUDGET, |ix| {
        (ix.worked_in(&paths), ix.main_facts(), ix.pending)
    });
    SessionFacts {
        worked: paths.iter().map(|p| p.display().to_string()).zip(worked).collect(),
        mains,
        titles: session_titles(),
        pending,
    }
}

/// An owner key: the agent's omp session file, else its id.
fn key_of(a: &Agent) -> String {
    a.omp
        .as_ref()
        .and_then(|o| o.session_file.clone())
        .unwrap_or_else(|| format!("agent:{}", a.id))
}

fn owner_state(a: &Agent) -> CleanupOwnerState {
    match &a.parked {
        None => CleanupOwnerState::Live,
        Some(p) if p.ended.is_some() => CleanupOwnerState::Ended,
        Some(_) => CleanupOwnerState::Parked,
    }
}

/// The board's agents and omp's main sessions, by what owners are keyed with.
struct Who<'a> {
    by_id: HashMap<&'a str, &'a Agent>,
    by_file: HashMap<&'a str, &'a Agent>,
    by_session: HashMap<&'a str, &'a Agent>,
    mains_by_id: HashMap<&'a str, &'a Path>,
    s: &'a SessionFacts,
}

impl<'a> Who<'a> {
    fn new(agents: &'a [Agent], s: &'a SessionFacts) -> Self {
        let mut who = Who {
            by_id: HashMap::new(),
            by_file: HashMap::new(),
            by_session: HashMap::new(),
            mains_by_id: HashMap::new(),
            s,
        };
        for a in agents {
            who.by_id.insert(a.id.as_str(), a);
            if let Some(o) = &a.omp {
                if let Some(f) = &o.session_file {
                    who.by_file.insert(f.as_str(), a);
                }
                if let Some(id) = &o.session_id {
                    who.by_session.insert(id.as_str(), a);
                }
            }
        }
        for (main, f) in &s.mains {
            if let Some(id) = &f.id {
                who.mains_by_id.insert(id.as_str(), main.as_path());
            }
        }
        who
    }

    /// The board's card of a main session: by its file, else by its omp session id.
    fn card(&self, main: &Path) -> Option<&'a Agent> {
        if let Some(a) = self.by_file.get(main.to_string_lossy().as_ref()) {
            return Some(a);
        }
        let id = self
            .s
            .mains
            .get(main)
            .and_then(|f| f.id.clone())
            .or_else(|| id_from_file_name(main))?;
        self.by_session.get(id.as_str()).copied()
    }

    /// A main session's owner key: its card's, else the session file.
    fn key(&self, main: &Path) -> String {
        self.card(main)
            .map(key_of)
            .unwrap_or_else(|| main.display().to_string())
    }

    /// What omp's sessions say about a card's main session.
    fn facts_of(&self, a: &Agent) -> Option<&'a MainFacts> {
        let o = a.omp.as_ref()?;
        o.session_file
            .as_deref()
            .and_then(|f| self.s.mains.get(Path::new(f)))
            .or_else(|| self.s.mains.get(*self.mains_by_id.get(o.session_id.as_deref()?)?))
    }

    /// The report's entry for an owner key: its card, else what its session file says.
    fn owner(&self, key: &str) -> CleanupOwner {
        let card = self
            .by_file
            .get(key)
            .or_else(|| self.by_id.get(key.strip_prefix("agent:")?))
            .copied();
        if let Some(a) = card {
            return CleanupOwner {
                key: key.to_string(),
                state: owner_state(a),
                agent_id: Some(a.id.clone()),
                name: Some(a.name.clone()),
                title: Some(a.title.clone()).filter(|t| !t.is_empty()),
                herdr: a.parked.is_none().then_some(a.state),
                session_id: a.omp.as_ref().and_then(|o| o.session_id.clone()),
                cwd: a.cwd.clone(),
                at: self.facts_of(a).and_then(|f| f.last_at).into_iter().chain(a.live.last_event_at).max(),
            };
        }
        let main = Path::new(key);
        let facts = self.s.mains.get(main);
        let id = facts
            .and_then(|f| f.id.clone())
            .or_else(|| id_from_file_name(main));
        let title = id
            .as_ref()
            .and_then(|id| self.s.titles.get(id).cloned())
            .or_else(|| read_head(main).title);
        CleanupOwner {
            key: key.to_string(),
            state: CleanupOwnerState::Gone,
            agent_id: None,
            name: None,
            title,
            herdr: None,
            session_id: id,
            cwd: facts.and_then(|f| f.cwd.as_ref()).map(|c| c.display().to_string()),
            at: facts.and_then(|f| f.last_at),
        }
    }
}

/// Who a worktree belongs to, as `(owner key, its subagents that worked there)`: an agent on the
/// board in it or a top-level session started there (one working or needing you first, then a
/// live one, then the latest); else the main agent whose session or subagents worked there first.
fn pick_owner(board: &[&Agent], worked: &[&WorkedIn], who: &Who) -> Option<(String, Vec<String>)> {
    let rank = |a: &Agent| {
        let live = a.parked.is_none();
        u8::from(live) + u8::from(live && is_busy(a))
    };
    let mut best: Option<((u8, Millis), String)> = None;
    let mut consider = |r: (u8, Millis), key: String| {
        if best.as_ref().is_none_or(|(b, _)| r > *b) {
            best = Some((r, key));
        }
    };
    for a in board {
        let at = who.facts_of(a).and_then(|f| f.last_at).unwrap_or_else(|| agent_at(a));
        consider((rank(a), at), key_of(a));
    }
    for u in worked.iter().filter(|u| u.home) {
        match who.card(&u.main) {
            Some(a) => consider((rank(a), u.seen.last), key_of(a)),
            None => consider((0, u.seen.last), u.main.display().to_string()),
        }
    }
    if let Some((_, key)) = best {
        return Some((key, Vec::new()));
    }
    let u = worked
        .iter()
        .min_by_key(|u| (u.seen.first, Reverse(u.seen.n)))?;
    let subagents = u.subagents.iter().take(SUBAGENTS_SHOWN).map(|(n, _)| n.clone()).collect();
    Some((who.key(&u.main), subagents))
}

/// `activeAt` / `activeBy`: the newest real use, never in the future.
fn settle(w: &mut CleanupWorktree, c: &Clues, agent: Option<Millis>) {
    let now = now_ms();
    let newest = [
        (c.files, WorktreeUse::Files),
        (c.git, WorktreeUse::Git),
        (agent, WorktreeUse::Agent),
    ]
    .into_iter()
    .filter_map(|(t, by)| Some((t?.min(now), by)))
    .max_by_key(|(t, _)| *t);
    (w.active_at, w.active_by) = (newest.map(|n| n.0), newest.map(|n| n.1));
}

/// Picks each worktree's owner and settles its last use (sessions and subagents that worked in it
/// since it was created, live agents in it, its reflog and changed files); the owners, each once.
fn attribute(
    repos: &mut [CleanupRepo],
    clues: &HashMap<String, Clues>,
    s: &SessionFacts,
    agents: &[Agent],
) -> Vec<CleanupOwner> {
    let who = Who::new(agents, s);
    let none = Clues::default();
    let mut owners: HashMap<String, CleanupOwner> = HashMap::new();
    for w in repos.iter_mut().flat_map(|r| r.worktrees.iter_mut()) {
        let c = clues.get(&w.path).unwrap_or(&none);
        let since = w.created_at.map(|t| t - BEFORE_CREATED_MS);
        let worked: Vec<&WorkedIn> = s
            .worked
            .get(&w.path)
            .into_iter()
            .flatten()
            .filter(|u| since.is_none_or(|t| u.seen.last >= t))
            .collect();
        let board: Vec<&Agent> = c.board.iter().filter_map(|id| who.by_id.get(id.as_str()).copied()).collect();
        let agent = worked
            .iter()
            .map(|u| u.seen.last)
            .chain(board.iter().filter(|a| a.parked.is_none()).filter_map(|a| a.live.last_event_at))
            .max();
        settle(w, c, agent);
        let Some((key, subagents)) = pick_owner(&board, &worked, &who) else { continue };
        let owner = owners.entry(key.clone()).or_insert_with(|| who.owner(&key));
        // Older apps show `lastAgent`: the owner, at its last work here.
        if w.last_agent.is_none()
            && let Some(at) = agent.or(owner.at)
        {
            w.last_agent = Some(CleanupAgent {
                agent_id: owner.agent_id.clone(),
                name: owner.name.clone(),
                title: owner.title.clone(),
                state: owner.herdr,
                parked: matches!(owner.state, CleanupOwnerState::Parked | CleanupOwnerState::Ended),
                at,
            });
        }
        w.owner = Some(CleanupOwnerRef { key, subagents });
    }
    let mut out: Vec<CleanupOwner> = owners.into_values().collect();
    out.sort_by(|a, b| a.key.cmp(&b.key));
    out
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

    /// `agent` with an omp session (file and id), as the board shows omp agents.
    fn with_session(mut a: Agent, file: &str, id: &str) -> Agent {
        a.omp = Some(
            serde_json::from_value(json!({
                "sessionId": id, "sessionFile": file, "link": "notShared", "bridge": false, "fast": false,
                "mode": "normal", "queue": { "steering": [], "followUp": [] }
            }))
            .unwrap(),
        );
        a
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
            active_at: None,
            active_by: None,
            size: None,
            size_partial: false,
            pr: None,
            pr_checked_at: None,
            pr_error: None,
            last_agent: None,
            owner: None,
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
        let ids = add_board(&mut w, &wss, &agents, None);
        assert_eq!(w.workspace_id.as_deref(), Some("w4"));
        assert_eq!(
            (w.agents, w.busy),
            (2, true),
            "a working agent in a subfolder makes it busy; `feat-2` is another worktree"
        );
        assert_eq!(ids, ["idle", "sub", "old"]);
        let last = w.last_agent.unwrap();
        assert_eq!(
            (last.name.as_deref(), last.parked, last.at),
            (Some("old"), true, 900),
            "the parked agent closed last"
        );
        assert_eq!(w.active_at, None, "closing a card is no use of the worktree");

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

    fn seen(first: Millis, last: Millis, n: u32) -> sessions::Seen {
        sessions::Seen { first, last, n }
    }

    fn worked(main: &str, home: bool, s: sessions::Seen, subagents: &[(&str, Millis)]) -> WorkedIn {
        WorkedIn {
            main: PathBuf::from(main),
            home,
            seen: s,
            subagents: subagents.iter().map(|(n, t)| (n.to_string(), *t)).collect(),
        }
    }

    fn main_facts(id: &str, cwd: &str, last_at: Millis) -> MainFacts {
        MainFacts {
            id: Some(id.into()),
            cwd: Some(PathBuf::from(cwd)),
            last_at: Some(last_at),
        }
    }

    /// The board's agent in a worktree, else the session started there, else the main agent whose
    /// subagents worked there first; activity of any main agent since the worktree was created.
    #[test]
    fn owners_and_last_use_from_the_board_and_omp_sessions() {
        let a_file = "/s/-wt-dispatch-a/2026-10-28T12-00-00-000Z_aaa.jsonl";
        let c_file = "/s/-wt-c/2026-10-29T08-00-00-000Z_ccc.jsonl";
        let g_file = "/s/-wt-gone/2026-10-20T08-00-00-000Z_ggg.jsonl";
        let d_file = "/s/-wt-d/2026-09-01T08-00-00-000Z_ddd.jsonl";
        let parked = json!({ "at": 400, "sessionFile": a_file, "worktree": { "path": "/wt/dispatch-a", "repoRoot": "/r" } });
        // The board knows A's session by another path form (a symlinked home): its id still matches.
        let agents = [
            with_session(agent("A", "", "/wt/dispatch-a", "idle", "done", Some(parked)), "/home/u/.omp/s/A.jsonl", "aaa"),
            with_session(agent("L", "w1", "/wt/live", "working", "running", None), "/s/-wt-live/2026-11-01T09-00-00-000Z_lll.jsonl", "lll"),
        ];
        let mut repo = CleanupRepo {
            root: "/r".into(),
            name: "r".into(),
            error: None,
            pr_error: None,
            worktrees: ["/wt/dispatch-a", "/wt/p2/A1c", "/wt/p2/old", "/wt/live", "/wt/gone"].map(blank).to_vec(),
        };
        repo.worktrees[2].created_at = Some(500_000);
        let clues: HashMap<String, Clues> = [
            ("/wt/dispatch-a", Clues { git: Some(3_000), files: None, board: vec!["A".into()] }),
            ("/wt/p2/A1c", Clues { git: Some(4_500), files: Some(4_800), board: vec![] }),
            ("/wt/p2/old", Clues { git: Some(600_000), files: None, board: vec![] }),
            ("/wt/live", Clues { git: None, files: None, board: vec!["L".into()] }),
        ]
        .into_iter()
        .map(|(p, c)| (p.to_string(), c))
        .collect();
        let s = SessionFacts {
            worked: [
                ("/wt/dispatch-a", vec![worked(a_file, true, seen(1_000, 7_000, 1), &[]), worked(c_file, false, seen(8_000, 8_100, 2), &[("Fix", 8_100)])]),
                ("/wt/p2/A1c", vec![worked(c_file, false, seen(6_000, 9_000, 9), &[("Late", 9_000)]), worked(a_file, false, seen(4_000, 5_000, 3), &[("A1C", 5_000)])]),
                // Work that ended before the worktree was made was in an earlier checkout at that path.
                ("/wt/p2/old", vec![worked(d_file, false, seen(500, 1_000, 40), &[("Old", 1_000)])]),
                ("/wt/live", vec![worked(g_file, true, seen(90_000, 99_000, 1), &[])]),
                ("/wt/gone", vec![worked(g_file, true, seen(2_000, 2_500, 1), &[])]),
            ]
            .into_iter()
            .map(|(p, v)| (p.to_string(), v))
            .collect(),
            mains: [
                (a_file, main_facts("aaa", "/wt/dispatch-a", 7_000)),
                (c_file, main_facts("ccc", "/wt/c", 9_000)),
                (g_file, main_facts("ggg", "/wt/gone", 99_000)),
            ]
            .into_iter()
            .map(|(f, m)| (PathBuf::from(f), m))
            .collect(),
            titles: [("ggg".to_string(), "Spike: try Yjs".to_string())].into(),
            pending: 0,
        };
        let owners = attribute(std::slice::from_mut(&mut repo), &clues, &s, &agents);
        let by = |p: &str| repo.worktrees.iter().find(|w| w.path == p).unwrap().clone();
        let key = |p: &str| by(p).owner.map(|o| o.key);

        let home = by("/wt/dispatch-a");
        assert_eq!(key("/wt/dispatch-a").as_deref(), Some("/home/u/.omp/s/A.jsonl"), "the card's key, matched by session id");
        assert_eq!((home.active_at, home.active_by), (Some(8_100), Some(WorktreeUse::Agent)), "another agent's later work there counts as use");

        let sub = by("/wt/p2/A1c");
        assert_eq!(key("/wt/p2/A1c").as_deref(), Some("/home/u/.omp/s/A.jsonl"), "the main agent whose subagent worked there first");
        assert_eq!(sub.owner.unwrap().subagents, ["A1C"]);
        assert_eq!((sub.active_at, sub.active_by), (Some(9_000), Some(WorktreeUse::Agent)));
        let last = sub.last_agent.unwrap();
        assert_eq!((last.agent_id.as_deref(), last.parked), (Some("A"), true), "older apps see the owner");

        let old = by("/wt/p2/old");
        assert!(old.owner.is_none(), "an earlier checkout's agent does not own it");
        assert_eq!((old.active_at, old.active_by), (Some(600_000), Some(WorktreeUse::Git)));

        assert_eq!(key("/wt/live").as_deref(), Some("/s/-wt-live/2026-11-01T09-00-00-000Z_lll.jsonl"), "a live agent beats a later session started there");
        assert_eq!(by("/wt/live").active_at, Some(99_000));
        assert_eq!(key("/wt/gone").as_deref(), Some(g_file));

        assert_eq!(owners.len(), 3);
        let owner = |k: &str| owners.iter().find(|o| o.key == k).unwrap();
        let a = owner("/home/u/.omp/s/A.jsonl");
        assert_eq!((a.state, a.name.as_deref(), a.title.as_deref(), a.at), (CleanupOwnerState::Parked, Some("A"), Some("A task"), Some(7_000)));
        let l = owner("/s/-wt-live/2026-11-01T09-00-00-000Z_lll.jsonl");
        assert_eq!((l.state, l.herdr), (CleanupOwnerState::Live, Some(HerdrState::Working)));
        let g = owner(g_file);
        assert_eq!(
            (g.state, g.title.as_deref(), g.session_id.as_deref(), g.cwd.as_deref(), g.at),
            (CleanupOwnerState::Gone, Some("Spike: try Yjs"), Some("ggg"), Some("/wt/gone"), Some(99_000))
        );
    }

    /// `git` with author and committer dates, as an agent's commit made then.
    fn git_at(dir: &Path, args: &[&str], at: Millis) {
        let date = format!("@{} +0000", at / 1000);
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn set_mtime(p: &Path, at: Millis) {
        let t = UNIX_EPOCH + Duration::from_millis(at as u64);
        std::fs::File::options().write(true).open(p).unwrap().set_modified(t).unwrap();
    }

    /// Regression: every worktree of a busy repository said "used 53 minutes ago". `git gc` (git runs
    /// it by itself after commits and fetches) rewrites every worktree's reflog, and a `git status`
    /// that takes optional locks rewrites the index: the admin dir's file times moved for all of them
    /// at once. Last use comes from what the reflog's entries say instead, and neither git's
    /// maintenance nor TeleFlock's own scans change it.
    #[tokio::test]
    async fn last_use_survives_git_gc_and_scans() {
        let td = fixture();
        let root = td.path();
        let day = 86_400_000;
        let now = now_ms() / 1000 * 1000;
        let mut made = Vec::new();
        for (n, ago) in [("a", 20), ("b", 40)] {
            let path = root.parent().unwrap().join(format!("{}-{n}", root.file_name().unwrap().to_string_lossy()));
            let at = now - ago * day;
            git_at(root, &["worktree", "add", "-q", "-b", &format!("wt-{n}"), path.to_str().unwrap(), "main"], at - day);
            std::fs::write(path.join("work.txt"), n).unwrap();
            git_at(&path, &["add", "work.txt"], at);
            git_at(&path, &["commit", "-q", "-m", "work"], at);
            for f in ["a.txt", "work.txt"] {
                set_mtime(&path.join(f), at);
            }
            made.push((path, at));
        }
        let common = common_dir(root).await.unwrap();
        let last_use = |path: PathBuf| {
            let common = common.clone();
            async move {
                let rec = list_linked(root).await.unwrap().into_iter().find(|r| same_path(Path::new(&r.path), &path)).unwrap();
                let (mut w, clues) = git_facts(root, Some(&common), rec).await;
                settle(&mut w, &clues, None);
                (w.active_at, w.active_by)
            }
        };
        for (path, at) in &made {
            assert_eq!(last_use(path.clone()).await, (Some(*at), Some(WorktreeUse::Git)), "the commit made there");
        }

        // An agent commits anywhere in the repository and git's automatic maintenance runs; an
        // editor's `git status` (with optional locks) refreshes a touched file's index entry.
        sh(root, &["gc", "--quiet"]);
        for (path, _) in &made {
            set_mtime(&path.join("a.txt"), now);
            let st = std::process::Command::new("git").args(["status", "--porcelain"]).current_dir(path).output().unwrap();
            assert!(st.status.success() && st.stdout.is_empty(), "touched, not changed");
        }
        let (path, at) = &made[1];
        let admin = admin_dir(path, &common).unwrap();
        for f in ["logs/HEAD", "index"] {
            assert!(mtime_ms(&admin.join(f)).unwrap() >= now - 60_000, "{f} was rewritten just now: its file time says nothing");
        }
        let index_before_scan = mtime_ms(&admin.join("index"));
        assert_eq!(last_use(path.clone()).await, (Some(*at), Some(WorktreeUse::Git)), "still the commit's time after gc");
        assert_eq!(last_use(made[0].0.clone()).await.0, Some(made[0].1));
        assert_eq!(mtime_ms(&admin.join("index")), index_before_scan, "a scan writes nothing");

        // A real change to its files is use, at the time the file was written.
        std::fs::write(path.join("work.txt"), "changed").unwrap();
        set_mtime(&path.join("work.txt"), at + 3 * day);
        assert_eq!(last_use(path.clone()).await, (Some(at + 3 * day), Some(WorktreeUse::Files)));
    }

    /// Created and last-moved times come from the admin dir, also once the folder is gone; a
    /// detached HEAD on a commit only it knows is flagged.
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
                .find(|(f, _)| same_path(Path::new(&f.path), p))
                .map(|(f, c)| (f.clone(), c.git, c.files))
                .unwrap()
        };
        let (f, moved, changed) = by(&feat);
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
        assert!(f.created_at.is_some() && moved.is_some());
        assert!(changed.is_some(), "an untracked file");
        let (g, moved, _) = by(&gone);
        assert!(g.missing && g.dirty.is_none());
        assert!(g.created_at.is_some() && moved.is_some(), "the admin dir outlives the folder");
        let (d, _, _) = by(&det);
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
        assert!(git_facts(root, Some(&common), rec).await.0.orphan_commits);
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
