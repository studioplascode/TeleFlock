//! `cleanup.worktrees`: every linked worktree of the repositories TeleFlock knows on this host,
//! with what deciding whether to delete it takes.
//!
//! **Repositories** are those of the herdr session's workspaces, of its parked agents (their
//! worktree's repository, else their folder's), and of its automations (worktree mode, and the
//! worktrees their runs made). Their linked worktrees come from `git worktree list --porcelain`
//! (main checkouts and bare entries are never listed).
//!
//! **Scans** run one at a time per herdr session, all of them through its worker
//! (`schedule.rs`): the host's own in the background (below the agents' work), and the page's. A
//! request is answered at once from the latest report while it is younger than the background
//! interval (`latest`; apps before 0.9.6: a minute, [`FRESH`]); an older one, or `refresh`, asks
//! for a scan, takes over a background scan that runs (it goes on at normal priority; a Rescan
//! cancels it and runs right after) and waits up to `waitMs` for it ([`decide`]). First the git
//! facts, the board and the owners are published, then sizes and pull requests fill in as they
//! arrive; earlier values stay shown until replaced.
//!
//! **Incremental.** A scan works out again only what may have changed (`signals.rs`): a
//! repository is listed again when its admin dirs changed, a worktree's `git status` is taken again
//! when its HEAD, index or admin files moved, an agent worked in it since, or it is
//! [`STATUS_MAX_AGE`] old; a folder probed for its repository holds [`PROBE_FOR`]; omp's session
//! files are read from where the last scan stopped (`sessions.rs`). A size holds for [`SIZE_TTL`];
//! then its tree's folders are checked against their stamps (`tree.rs`: one `stat` per folder,
//! listings only for folders that changed), and the tree is walked whole again only after
//! [`SIZE_WALKED_FOR`] (a file grown in place moves no folder). A scan nobody asked to see checks
//! sizes within [`SIZE_BUDGET`], the trees checked longest ago first, so every tree gets its turn.
//! Pull requests hold by state (`prs::ttl`) and are asked again when the branch's HEAD moved.
//! Rescan runs every check now (every status, every tree's folders, every pull request) and still
//! reuses what did not change. All of it outlives the daemon (`cache.rs`), the last report too. gh
//! missing or signed out stops pull request lookups host-wide for [`GH_DOWN_FOR`]; a repository
//! without a GitHub remote is not asked again for [`NOT_GITHUB_FOR`]. Each scan's counters are the
//! report's `stats` and its log line.
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
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use tf_proto::{
    Agent, AutomationList, CleanupAgent, CleanupBackground, CleanupOwner, CleanupOwnerRef, CleanupOwnerState, CleanupPr, CleanupRepo,
    CleanupReport, CleanupScanKind, CleanupScanParams, CleanupScanStats, CleanupWorktree, Column, HerdrState, Millis, Workspace, WorktreeUse,
};
use tokio::sync::{Notify, Semaphore, watch};
use tokio_util::sync::CancellationToken;

use super::cache::{self, PrMemo, SizeMemo};
use super::prs::{self, Lookup};
use super::schedule::{EVERY, paced};
use super::sessions::{self, MainFacts, WorkedIn};
use super::signals::{self, FileStamp, RepoMemo, RepoStamp, STATUS_MAX_AGE, Signals, StatusDue, StatusMemo, age, file_stamp};
use super::size::{self, Budget, DirSize, Fingerprint, Touched};
use super::tree::{self, Blob, DirTree, MAX_DIRS};
use crate::ops::host::{id_from_file_name, omp_agent_dir, read_head, session_titles};
use crate::ops::worktree::same_path;
use crate::ops::{Ctx, git};
use crate::priority::low;
use crate::state::persist::ParkedRecord;
use crate::util::now_ms;

/// Apps before 0.9.6 (no `latest`): a report this old starts a scan, as it always did.
const FRESH: Duration = Duration::from_secs(60);
/// Longest `waitMs` (the app's request timeout is 30 s).
pub(crate) const WAIT_MAX_MS: u32 = 20_000;
/// A size this young is shown as it is.
const SIZE_TTL: Duration = Duration::from_secs(10 * 60);
/// A size whose tree was walked whole longer ago is walked again even when its folders' stamps
/// held: files grown in place (logs, databases) don't move them.
const SIZE_WALKED_FOR: Duration = Duration::from_secs(6 * 3600);
/// One worktree's size walk: a `node_modules` tree of a few hundred thousand files fits.
const SIZE_ENTRIES: u64 = 3_000_000;
const SIZE_TIME: Duration = Duration::from_secs(20);
/// What a scan nobody asked to see spends on sizes at most: folders looked at plus entries listed
/// (the stamps of 400 000 folders, or a few big trees walked whole), and time; the trees left wait
/// for the next scan, first in line. A Rescan checks them all.
const SIZE_BUDGET: u64 = 400_000;
const SIZE_BUDGET_TIME: Duration = Duration::from_secs(60);
/// What a size job is guessed to cost before its first walk.
const SIZE_GUESS: u64 = 20_000;
const GH_DOWN_FOR: Duration = Duration::from_secs(10 * 60);
const NOT_GITHUB_FOR: Duration = Duration::from_secs(30 * 60);
/// A folder probed for its repository (a parked agent's, an automation's) holds this long.
const PROBE_FOR: Duration = Duration::from_secs(3600);
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

/// A scan running now: who started it (a page's request can take a background scan over), its
/// priority flag (`priority::low`) and its cancellation (a Rescan stops a background scan).
#[derive(Debug, Clone)]
pub(crate) struct Run {
    pub kind: CleanupScanKind,
    pub low: Arc<AtomicBool>,
    pub cancel: CancellationToken,
}

#[derive(Default)]
struct Inner {
    report: Option<CleanupReport>,
    running: Option<Run>,
    /// A scan the page asked for, not started yet.
    want: Option<CleanupScanKind>,
    /// When the next background scan is due (wall clock, for the report).
    next_at: Option<Millis>,
    /// The last finished scan's counters.
    stats: Option<CleanupScanStats>,
    /// What the cache file kept was taken (the first scan or request of this daemon takes it).
    restored: bool,
    /// Worktree path → its size.
    sizes: HashMap<String, SizeMemo>,
    /// `path \0 branch \0 head` → its pull request.
    prs: HashMap<String, PrMemo>,
    /// Worktree path → its last status.
    statuses: HashMap<String, StatusMemo>,
    /// Repository root → its linked worktrees.
    repos: HashMap<String, RepoMemo>,
    /// Folder → its repository root, as probed then.
    probes: HashMap<PathBuf, (Instant, Option<PathBuf>)>,
    /// Repository root → why its pull requests are unknown.
    not_github: HashMap<String, (Instant, String)>,
    gh_down: Option<(Instant, String)>,
}

#[derive(Default)]
pub(crate) struct Scanner {
    inner: Mutex<Inner>,
    /// Bumped on every publish and every start and end of a scan.
    tick: watch::Sender<u64>,
    /// Wakes the worker: a scan was asked for.
    pub(crate) poke: Notify,
}

static SCANNERS: LazyLock<Mutex<HashMap<String, Arc<Scanner>>>> = LazyLock::new(Default::default);

pub(crate) fn scanner(session: &str) -> Arc<Scanner> {
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
        background: None,
        stats: None,
    }
}

/// What `cleanup.worktrees` does ([`decide`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Ask {
    /// Answer with the latest report as it is: it is fresh enough. Nothing starts.
    Answer,
    /// Ask the worker for a scan of this kind.
    Start(CleanupScanKind),
    /// The scan running (or asked for) serves: take it over (normal priority) and wait for it.
    Join,
    /// A Rescan while another scan runs: stop that one, the Rescan runs right after.
    Preempt,
}

/// What a request does with the latest report (finished at `report_at`), given the scan running
/// and the one asked for already. `every`: the background interval.
pub(crate) fn decide(report_at: Option<Millis>, running: Option<CleanupScanKind>, want: Option<CleanupScanKind>, p: &CleanupScanParams, now: Millis, every: Duration) -> Ask {
    let fresh_for = if p.latest { every } else { FRESH };
    let due = p.refresh || report_at.is_none_or(|at| age(at, now) >= fresh_for);
    if !due {
        return Ask::Answer;
    }
    let rescan = p.refresh;
    match (running, want) {
        (Some(k), _) if rescan && k != CleanupScanKind::Refresh && want != Some(CleanupScanKind::Refresh) => Ask::Preempt,
        (Some(_), _) => Ask::Join,
        (None, Some(w)) if rescan && w != CleanupScanKind::Refresh => Ask::Start(CleanupScanKind::Refresh),
        (None, Some(_)) => Ask::Join,
        (None, None) => Ask::Start(if rescan { CleanupScanKind::Refresh } else { CleanupScanKind::Page }),
    }
}

impl Scanner {
    /// A request's [`decide`], carried out: a scan asked for, a running one taken over (or stopped
    /// for a Rescan). The worker is woken when it has something to start.
    pub(crate) fn ask(&self, p: &CleanupScanParams, now: Millis) -> Ask {
        let ask = {
            let mut g = self.inner.lock().unwrap();
            let report_at = g.report.as_ref().and_then(|r| r.scanned_at);
            let ask = decide(report_at, g.running.as_ref().map(|r| r.kind), g.want, p, now, paced(EVERY));
            match ask {
                Ask::Answer => {}
                Ask::Start(kind) => g.want = Some(kind),
                Ask::Join | Ask::Preempt => {
                    if let Some(r) = g.running.as_mut() {
                        // Someone looks: the rest of it runs at normal priority.
                        r.low.store(false, Ordering::Relaxed);
                        if r.kind == CleanupScanKind::Background {
                            r.kind = CleanupScanKind::Page;
                        }
                        if ask == Ask::Preempt {
                            r.cancel.cancel();
                            g.want = Some(CleanupScanKind::Refresh);
                        }
                    }
                }
            }
            ask
        };
        if matches!(ask, Ask::Start(_) | Ask::Preempt) {
            self.poke.notify_one();
            self.tick.send_modify(|t| *t += 1);
        }
        ask
    }

    /// A scan runs or was asked for.
    fn busy(&self) -> bool {
        let g = self.inner.lock().unwrap();
        g.running.is_some() || g.want.is_some()
    }

    /// A scan the page follows runs or was asked for (not a background scan nobody looks at).
    fn followed(&self) -> bool {
        let g = self.inner.lock().unwrap();
        g.want.is_some() || g.running.as_ref().is_some_and(|r| r.kind != CleanupScanKind::Background)
    }

    /// The latest report, with the scan state, the background schedule and the last counters.
    fn answer(&self) -> CleanupReport {
        let g = self.inner.lock().unwrap();
        let mut r = g.report.clone().unwrap_or_else(empty_report);
        r.scanning = g.running.is_some() || g.want.is_some();
        let background = g.want.is_none() && g.running.as_ref().is_some_and(|run| run.kind == CleanupScanKind::Background);
        r.background = Some(CleanupBackground { every_ms: paced(EVERY).as_millis() as u64, running: background, next_at: g.next_at.filter(|_| !r.scanning) });
        r.stats = g.stats.clone();
        r
    }

    /// The scan the page asked for, if any (the worker starts it next).
    pub(crate) fn wanted(&self) -> Option<CleanupScanKind> {
        self.inner.lock().unwrap().want
    }

    /// The worker starts a scan: the one the page asked for when there is one by now (a background
    /// scan asked for at the same moment is that one, at normal priority), else `kind`.
    pub(crate) fn begin(&self, kind: CleanupScanKind) -> Run {
        let run = {
            let mut g = self.inner.lock().unwrap();
            let kind = g.want.take().unwrap_or(kind);
            let run = Run { kind, low: Arc::new(AtomicBool::new(kind == CleanupScanKind::Background)), cancel: CancellationToken::new() };
            g.running = Some(run.clone());
            run
        };
        self.tick.send_modify(|t| *t += 1);
        run
    }

    /// The worker's scan ended (also when it failed).
    pub(crate) fn end(&self) {
        self.inner.lock().unwrap().running = None;
        self.tick.send_modify(|t| *t += 1);
    }

    /// When the latest report's scan finished.
    pub(crate) fn report_at(&self) -> Option<Millis> {
        self.inner.lock().unwrap().report.as_ref().and_then(|r| r.scanned_at)
    }

    /// When the next background scan is due (wall clock), as the report says.
    pub(crate) fn set_next(&self, at: Option<Millis>) {
        self.inner.lock().unwrap().next_at = at;
    }

    /// The kind of the scan running now (a page's request may have taken it over).
    fn running_kind(&self) -> Option<CleanupScanKind> {
        self.inner.lock().unwrap().running.as_ref().map(|r| r.kind)
    }
}

/// `cleanup.worktrees`.
pub async fn report(ctx: &Ctx, p: &CleanupScanParams) -> CleanupReport {
    let sc = scanner(&ctx.herdr_session);
    restore(&ctx.paths.home, &ctx.herdr_session, &sc).await;
    let mut rx = sc.tick.subscribe();
    let ask = sc.ask(p, now_ms());
    // A fresh report is answered at once, unless a scan the page follows runs (its follow-up asks
    // wait for it, as they always did); apps before 0.9.6 wait for any scan that runs.
    let follow = ask != Ask::Answer || !p.latest || sc.followed();
    let wait = Duration::from_millis(u64::from(p.wait_ms.unwrap_or(0).min(WAIT_MAX_MS)));
    if follow && !wait.is_zero() {
        let _ = tokio::time::timeout(wait, async {
            loop {
                if !sc.busy() || rx.changed().await.is_err() {
                    break;
                }
            }
        })
        .await;
    }
    sc.answer()
}

/// What the cache file kept for herdr session `session`, taken once (the first scan or request of
/// this daemon): memos, and the last report until a scan replaces it.
pub(crate) async fn restore(home: &Path, session: &str, sc: &Scanner) {
    cache::open(home).await;
    let mut g = sc.inner.lock().unwrap();
    if g.restored {
        return;
    }
    g.restored = true;
    if let Some(kept) = cache::claim(session) {
        (g.sizes, g.prs, g.statuses, g.repos) = (kept.sizes, kept.prs, kept.statuses, kept.repos);
        if g.report.is_none() {
            g.report = kept.report.map(|r| CleanupReport { scanning: false, background: None, stats: None, ..r });
        }
    }
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

/// Puts a worktree's fresh row (`recheck`) into the last report: what git and the board say now,
/// with what only a scan learns (size, pull request, owner, an agent's last use) kept from the row
/// it replaces.
fn refresh_row(sc: &Scanner, root: &Path, mut w: CleanupWorktree) {
    {
        let mut g = sc.inner.lock().unwrap();
        let Some(repo) = g.report.as_mut().and_then(|r| r.repos.iter_mut().find(|r| same_path(Path::new(&r.root), root))) else {
            return;
        };
        match repo.worktrees.iter_mut().find(|x| same_path(Path::new(&x.path), Path::new(&w.path))) {
            Some(old) => {
                if !w.missing {
                    (w.size, w.size_partial) = (old.size, old.size_partial);
                }
                if (old.branch.as_deref(), old.head.as_deref()) == (w.branch.as_deref(), w.head.as_deref()) {
                    (w.pr, w.pr_checked_at, w.pr_error) = (old.pr.clone(), old.pr_checked_at, old.pr_error.clone());
                }
                (w.owner, w.automation) = (old.owner.clone(), old.automation.clone());
                w.last_agent = w.last_agent.take().or_else(|| old.last_agent.clone());
                if old.active_at > w.active_at {
                    (w.active_at, w.active_by) = (old.active_at, old.active_by);
                }
                *old = w;
            }
            None => {
                repo.worktrees.push(w);
                repo.worktrees.sort_by(|a, b| a.path.cmp(&b.path));
            }
        }
    }
    sc.tick.send_modify(|t| *t += 1);
}

/// One linked worktree as it is now, right before acting on it (`remove.rs`): git asked again
/// (status, reachability: never a memo), the board, and what the report knew beside. Its row in
/// the last report and its status memo are refreshed with it.
pub(crate) async fn recheck(ctx: &Ctx, root: &Path, rec: &git::WorktreeRecord) -> CleanupWorktree {
    let sc = scanner(&ctx.herdr_session);
    let common = common_dir(root).await;
    let admin = common.as_deref().and_then(|c| admin_dir(Path::new(&rec.path), c));
    let signals = Signals::of(rec, admin.as_deref());
    let (mut w, clues, memo) = git_facts_with(root, admin.as_deref(), rec.clone(), None, signals, &Counters::default()).await;
    let board = ctx.state.snapshot();
    let autos = crate::automations::get().map(|a| a.list(&ctx.herdr_session));
    add_board(&mut w, &board.workspaces, &board.agents, autos.as_ref());
    settle(&mut w, &clues, None);
    if let Some(m) = memo {
        sc.inner.lock().unwrap().statuses.insert(rec.path.clone(), m);
    }
    refresh_row(&sc, root, w.clone());
    w
}

// ───────────────────────────── the scan ─────────────────────────────

/// What a scan did, counted as it goes (the report's `stats`).
#[derive(Debug, Default)]
struct Counters {
    repos_listed: AtomicU32,
    statuses: AtomicU32,
    statuses_kept: AtomicU32,
    git_calls: AtomicU32,
    size_walks: AtomicU32,
    size_checks: AtomicU32,
    sizes_kept: AtomicU32,
    sizes_deferred: AtomicU32,
    dir_stats: AtomicU64,
    dir_reads: AtomicU64,
    dir_entries: AtomicU64,
    pr_lookups: AtomicU32,
    prs_kept: AtomicU32,
    session_files: AtomicU32,
    session_bytes: AtomicU64,
}

fn add(a: &AtomicU32, n: u32) {
    a.fetch_add(n, Ordering::Relaxed);
}

fn add64(a: &AtomicU64, n: u64) {
    a.fetch_add(n, Ordering::Relaxed);
}

fn get(a: &AtomicU32) -> u32 {
    a.load(Ordering::Relaxed)
}

fn get64(a: &AtomicU64) -> u64 {
    a.load(Ordering::Relaxed)
}

impl Counters {
    fn touched(&self, t: &Touched) {
        add64(&self.dir_stats, t.stats);
        add64(&self.dir_reads, t.reads);
        add64(&self.dir_entries, t.entries);
    }
}

/// One scan (the worker runs it): background ones run below the agents' work while `run.low` is
/// set (`priority::low`); `run.cancel` stops one early (a Rescan took over).
pub(crate) async fn pass(ctx: Arc<Ctx>, sc: Arc<Scanner>, run: Run) {
    low::scope(run.low.clone(), scan(ctx, sc, run)).await;
}

/// One repository's linked worktrees for a scan.
struct Listed {
    root: PathBuf,
    common: Option<PathBuf>,
    records: Result<Vec<git::WorktreeRecord>, String>,
}

async fn scan(ctx: Arc<Ctx>, sc: Arc<Scanner>, run: Run) {
    let started = Instant::now();
    let n = Arc::new(Counters::default());
    let refresh = run.kind == CleanupScanKind::Refresh;
    restore(&ctx.paths.home, &ctx.herdr_session, &sc).await;
    let board = ctx.state.snapshot();
    // Chats (§3.31) are never repositories: git is not asked about their folders.
    let parked: Vec<ParkedRecord> = ctx.state.parked_all().into_iter().filter(|r| r.cwd.as_deref().is_none_or(|c| !ctx.chats.holds(Path::new(c)))).collect();
    let autos = crate::automations::get().map(|a| a.list(&ctx.herdr_session));
    let roots = discover(&sc, &n, &board.workspaces, &parked, autos.as_ref(), refresh).await;
    let mut listed = Vec::new();
    for root in roots {
        if run.cancel.is_cancelled() {
            return finish(&ctx, &sc, &run, &n, started, true);
        }
        listed.push(list_repo(&sc, &n, root, refresh).await);
    }

    // omp's sessions: who worked where since the last scan (only what was appended is read).
    let paths: Vec<PathBuf> = listed.iter().filter_map(|l| l.records.as_ref().ok()).flatten().map(|w| PathBuf::from(&w.path)).collect();
    let first: HashSet<PathBuf> = board.agents.iter().filter_map(|a| a.omp.as_ref()?.session_file.as_deref()).map(PathBuf::from).collect();
    let t = Instant::now();
    let (sessions, read) = low::blocking_if_low(move || read_sessions(paths, first)).await.unwrap_or_default();
    let sessions_ms = t.elapsed().as_millis() as u64;
    add(&n.session_files, read.files);
    add64(&n.session_bytes, read.bytes);
    if run.cancel.is_cancelled() {
        return finish(&ctx, &sc, &run, &n, started, true);
    }

    // Git facts: a worktree's status is asked again only when something that changes it moved.
    let mut repos: Vec<CleanupRepo> = Vec::new();
    let mut clues: HashMap<String, Clues> = HashMap::new();
    let git_slots = Arc::new(Semaphore::new(GIT_PARALLEL));
    let now = now_ms();
    for Listed { root, common, records } in listed {
        let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| root.display().to_string());
        let records = match records {
            Ok(r) => r,
            Err(e) => {
                repos.push(CleanupRepo { root: root.display().to_string(), name, error: Some(e), pr_error: None, worktrees: Vec::new() });
                continue;
            }
        };
        if records.is_empty() {
            continue;
        }
        let mut set = tokio::task::JoinSet::new();
        for rec in records {
            let path = PathBuf::from(&rec.path);
            let admin = common.as_deref().and_then(|c| admin_dir(&path, c));
            let signals = Signals::of(&rec, admin.as_deref());
            let worked = sessions.worked.get(&rec.path).into_iter().flatten().map(|u| u.seen.last);
            let live = agents_in(&board.workspaces, &board.agents, &path).1.into_iter().filter(|a| a.parked.is_none()).filter_map(|a| a.live.last_event_at);
            let agent_at = worked.chain(live).max();
            let memo = sc.inner.lock().unwrap().statuses.get(&rec.path).cloned();
            let missing = rec.prunable || !path.is_dir();
            // A folder gone has no status; what its detached HEAD reaches holds while HEAD does.
            let kept = if missing {
                memo.filter(|m| !refresh && m.signals.head == signals.head && age(m.at, now) < paced(STATUS_MAX_AGE))
            } else {
                memo.filter(|m| signals::status_due(Some(m), &signals, agent_at, refresh, now, paced(STATUS_MAX_AGE)) == StatusDue::Keep)
            };
            let (root, slots, n, flag) = (root.clone(), git_slots.clone(), n.clone(), run.low.clone());
            set.spawn(low::scope(flag, async move {
                let _slot = slots.acquire_owned().await;
                git_facts_with(&root, admin.as_deref(), rec, kept, signals, &n).await
            }));
        }
        let mut worktrees: Vec<CleanupWorktree> = Vec::new();
        while let Some(r) = set.join_next().await {
            if let Ok((w, c, memo)) = r {
                if let Some(m) = memo {
                    sc.inner.lock().unwrap().statuses.insert(w.path.clone(), m);
                }
                clues.insert(w.path.clone(), c);
                worktrees.push(w);
            }
        }
        for w in &mut worktrees {
            let board_ids = add_board(w, &board.workspaces, &board.agents, autos.as_ref());
            clues.entry(w.path.clone()).or_default().board = board_ids;
        }
        worktrees.sort_by(|a, b| a.path.cmp(&b.path));
        repos.push(CleanupRepo { root: root.display().to_string(), name, error: None, pr_error: None, worktrees });
    }
    repos.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.root.cmp(&b.root)));
    let git_ms = started.elapsed().as_millis() as u64 - sessions_ms;
    let extra = Extra { owners: attribute(&mut repos, &clues, &sessions, &board.agents), pending: sessions.pending };

    // Cached sizes and pull requests now; the due ones are worked out below.
    let (size_jobs, pr_jobs) = {
        let g = sc.inner.lock().unwrap();
        plan(&g, &mut repos, refresh, now_ms(), &n)
    };
    publish(&sc, &repos, &extra, false);
    let first_ms = started.elapsed().as_millis() as u64;
    let budget = (!refresh).then_some((SIZE_BUDGET, SIZE_BUDGET_TIME));
    fill_within(&sc, &mut repos, &extra, size_jobs, pr_jobs, &n, &run, budget).await;
    let cancelled = run.cancel.is_cancelled();
    publish(&sc, &repos, &extra, !cancelled);
    tracing::info!(session = %ctx.herdr_session, repos = repos.len(), owners = extra.owners.len(), sessions_pending = extra.pending, git_ms, sessions_ms, first_ms, "cleanup scan facts");
    finish(&ctx, &sc, &run, &n, started, cancelled);
}

/// A scan's end: its counters into the report and the log, and the cache saved (at most every few
/// minutes).
fn finish(ctx: &Ctx, sc: &Scanner, run: &Run, n: &Counters, started: Instant, cancelled: bool) {
    let kind = sc.running_kind().unwrap_or(run.kind);
    let worktrees = sc.inner.lock().unwrap().report.as_ref().map_or(0, |r| r.repos.iter().map(|r| r.worktrees.len()).sum::<usize>()) as u32;
    let repos = sc.inner.lock().unwrap().report.as_ref().map_or(0, |r| r.repos.len()) as u32;
    let stats = CleanupScanStats {
        kind,
        at: now_ms(),
        ms: started.elapsed().as_millis() as u64,
        low: run.low.load(Ordering::Relaxed),
        cancelled,
        repos,
        repos_listed: get(&n.repos_listed),
        worktrees,
        statuses: get(&n.statuses),
        statuses_kept: get(&n.statuses_kept),
        git_calls: get(&n.git_calls),
        size_walks: get(&n.size_walks),
        size_checks: get(&n.size_checks),
        sizes_kept: get(&n.sizes_kept),
        sizes_deferred: get(&n.sizes_deferred),
        dir_stats: get64(&n.dir_stats),
        dir_reads: get64(&n.dir_reads),
        dir_entries: get64(&n.dir_entries),
        pr_lookups: get(&n.pr_lookups),
        prs_kept: get(&n.prs_kept),
        session_files: get(&n.session_files),
        session_bytes: get64(&n.session_bytes),
    };
    tracing::info!(
        session = %ctx.herdr_session, kind = ?stats.kind, low = stats.low, cancelled, repos, repos_listed = stats.repos_listed, worktrees,
        statuses = stats.statuses, statuses_kept = stats.statuses_kept, git_calls = stats.git_calls,
        size_walks = stats.size_walks, size_checks = stats.size_checks, sizes_kept = stats.sizes_kept, sizes_deferred = stats.sizes_deferred,
        dir_stats = stats.dir_stats, dir_reads = stats.dir_reads, dir_entries = stats.dir_entries,
        pr_lookups = stats.pr_lookups, prs_kept = stats.prs_kept, session_files = stats.session_files, session_bytes = stats.session_bytes,
        ms = stats.ms, "cleanup scan"
    );
    sc.inner.lock().unwrap().stats = Some(stats);
    cache::scanned();
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
            background: None,
            stats: None,
        });
    }
    sc.tick.send_modify(|t| *t += 1);
}

/// `(repo index, worktree index)`.
type At = (usize, usize);

/// What a worktree's size needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SizeDue {
    /// Nothing: shown as it is.
    No,
    /// A check of its folders (their stamps, `tree.rs`; a tree too big to keep: its fingerprint).
    Check,
    /// A walk of the whole tree.
    Walk,
}

/// What a size needs ([`SIZE_TTL`], [`SIZE_WALKED_FOR`]); `refresh` checks every tree now (a walk
/// stays on its own clock).
fn size_due(m: Option<&SizeMemo>, refresh: bool, now: Millis) -> SizeDue {
    match m {
        None => SizeDue::Walk,
        Some(m) if m.partial => SizeDue::Walk,
        Some(m) if !refresh && age(m.at, now) < paced(SIZE_TTL) => SizeDue::No,
        Some(m) if age(m.measured_at, now) >= paced(SIZE_WALKED_FOR) => SizeDue::Walk,
        Some(m) if m.tree.is_some() || m.fingerprint.dirs > MAX_DIRS as u64 => SizeDue::Check,
        // Measured by a daemon before 0.9.6: walked once to learn its folders.
        Some(_) => SizeDue::Walk,
    }
}

/// How a size job goes.
#[derive(Debug, Clone, PartialEq, Eq)]
enum SizeWork {
    Walk,
    /// Its folders' stamps against the tree kept (`tree::check`).
    Check(Blob),
    /// A tree too big to keep: a walk when its folders' fingerprint is not this one any more.
    Fingerprint(Fingerprint),
}

/// A worktree whose size is due.
struct SizeJob {
    at: At,
    path: PathBuf,
    work: SizeWork,
    /// What it is guessed to cost (folders and entries), for the scan's budget.
    cost: u64,
    /// When its size was last measured or checked: the oldest go first.
    since: Millis,
}

struct PrJob {
    at: At,
    key: String,
    root: String,
    dir: PathBuf,
    branch: Option<String>,
    /// The worktree's HEAD (abbreviated): a settled pull request has to end there.
    head: Option<String>,
}

/// Fills cached sizes and pull requests in, and lists what is due (sizes oldest first).
fn plan(g: &Inner, repos: &mut [CleanupRepo], refresh: bool, now: Millis, n: &Counters) -> (Vec<SizeJob>, Vec<PrJob>) {
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
                if let Some(m) = cached {
                    (w.size, w.size_partial) = (Some(m.bytes), m.partial);
                }
                let work = match (size_due(cached, refresh, now), cached) {
                    (SizeDue::No, _) => None,
                    (SizeDue::Check, Some(m)) => Some(match &m.tree {
                        Some(t) => SizeWork::Check(t.clone()),
                        None => SizeWork::Fingerprint(m.fingerprint),
                    }),
                    _ => Some(SizeWork::Walk),
                };
                match work {
                    None => add(&n.sizes_kept, 1),
                    Some(work) => {
                        let cost = match (&work, cached) {
                            (SizeWork::Check(_), Some(m)) => m.fingerprint.dirs,
                            (_, Some(m)) => m.fingerprint.dirs + m.files,
                            _ => SIZE_GUESS,
                        };
                        sizes.push(SizeJob { at: (ri, wi), path: PathBuf::from(&w.path), work, cost, since: cached.map_or(0, |m| m.at) });
                    }
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
                || memo.is_some_and(|m| !refresh && age(m.checked_at, now) < prs::ttl(&m.found))
            {
                if memo.is_some() {
                    add(&n.prs_kept, 1);
                }
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
    sizes.sort_by_key(|j| j.since);
    (sizes, prs)
}

fn show_pr(w: &mut CleanupWorktree, m: &PrMemo) {
    w.pr_checked_at = Some(m.checked_at);
    match &m.found {
        Ok(pr) => (w.pr, w.pr_error) = (pr.clone(), None),
        Err(e) => w.pr_error = Some(e.clone()),
    }
}

/// What a size job found.
#[derive(Debug)]
enum Sized {
    /// Walked whole: the size, and the tree when it can be kept.
    Walked(DirSize, Option<DirTree>),
    /// Its folders as they were: the size holds.
    Same,
    /// Its folders changed: the tree (and size) now.
    Changed(DirTree),
    /// No folder there any more.
    Gone,
}

/// A size job (blocking): the check its work asks for, a walk where a check can't tell.
fn size_job(path: &Path, work: SizeWork, touched: &mut Touched, walked: &mut bool) -> Sized {
    let budget = || Budget::new(SIZE_ENTRIES, SIZE_TIME);
    let mut walk = |touched: &mut Touched| {
        *walked = true;
        let (size, tree) = tree::walk(path, budget(), touched);
        Sized::Walked(size, tree)
    };
    match work {
        SizeWork::Walk => walk(touched),
        SizeWork::Check(blob) => match DirTree::decode(&blob.0).map(|old| tree::check(path, &old, budget(), touched)) {
            Some(tree::Outcome::Same) => Sized::Same,
            Some(tree::Outcome::Changed(t)) => Sized::Changed(t),
            Some(tree::Outcome::Gone) => Sized::Gone,
            Some(tree::Outcome::Unsure) | None => walk(touched),
        },
        SizeWork::Fingerprint(fp) => match size::fingerprint(path, budget(), touched) {
            Some(now) if now == fp => Sized::Same,
            _ => walk(touched),
        },
    }
}

enum Filled {
    Size(At, String, Sized),
    Pr(PrJob, Lookup),
}

/// Measures and looks up what is due, publishing as results arrive. Sizes take turns within
/// `budget` (folders looked at plus entries listed, and time: [`SIZE_BUDGET`] for a scan nobody
/// asked for, none for a Rescan); the jobs left are counted as deferred.
#[allow(clippy::too_many_arguments)]
async fn fill_within(
    sc: &Arc<Scanner>,
    repos: &mut [CleanupRepo],
    extra: &Extra,
    sizes: Vec<SizeJob>,
    pr_jobs: Vec<PrJob>,
    n: &Arc<Counters>,
    run: &Run,
    budget: Option<(u64, Duration)>,
) {
    let size_slots = Arc::new(Semaphore::new(SIZE_PARALLEL));
    let pr_slots = Arc::new(Semaphore::new(PR_PARALLEL));
    let spent = Arc::new(AtomicU64::new(0));
    let started = Instant::now();
    let mut set: tokio::task::JoinSet<Option<Filled>> = tokio::task::JoinSet::new();
    for job in sizes {
        let (slots, n, spent, cancel, flag) = (size_slots.clone(), n.clone(), spent.clone(), run.cancel.clone(), run.low.clone());
        set.spawn(low::scope(flag, async move {
            let _slot = slots.acquire_owned().await;
            let spent_all = budget.is_some_and(|(units, time)| spent.load(Ordering::Relaxed) >= units || started.elapsed() >= time);
            if cancel.is_cancelled() || spent_all {
                add(&n.sizes_deferred, 1);
                return None;
            }
            spent.fetch_add(job.cost, Ordering::Relaxed);
            let key = job.path.display().to_string();
            let checked = matches!(job.work, SizeWork::Check(_) | SizeWork::Fingerprint(_));
            let (sized, touched, walked) = low::blocking_if_low(move || {
                let (mut touched, mut walked) = (Touched::default(), false);
                let sized = size_job(&job.path, job.work, &mut touched, &mut walked);
                (sized, touched, walked)
            })
            .await?;
            n.touched(&touched);
            // What it cost in, the guess counted at its start out.
            spent.fetch_add(touched.stats + touched.entries, Ordering::Relaxed);
            spent.fetch_sub(job.cost, Ordering::Relaxed);
            add(&n.size_checks, u32::from(checked));
            add(&n.size_walks, u32::from(walked));
            Some(Filled::Size(job.at, key, sized))
        }));
    }
    for job in pr_jobs {
        let (slots, sc, n, cancel, flag) = (pr_slots.clone(), sc.clone(), n.clone(), run.cancel.clone(), run.low.clone());
        set.spawn(low::scope(flag, async move {
            let _slot = slots.acquire_owned().await;
            if cancel.is_cancelled() {
                return None;
            }
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
            add(&n.pr_lookups, 1);
            let found = prs::lookup(&job.dir, job.branch.as_deref(), job.head.as_deref()).await;
            Some(Filled::Pr(job, found))
        }));
    }
    while let Some(r) = set.join_next().await {
        let Ok(Some(filled)) = r else { continue };
        {
            let mut g = sc.inner.lock().unwrap();
            let now = now_ms();
            match filled {
                Filled::Size((ri, wi), key, Sized::Walked(s, tree)) => {
                    let w = &mut repos[ri].worktrees[wi];
                    (w.size, w.size_partial) = (Some(s.bytes), s.partial);
                    let tree = tree.map(|t| Blob(t.encode()));
                    g.sizes.insert(key, SizeMemo { bytes: s.bytes, files: s.files, partial: s.partial, fingerprint: s.fingerprint, measured_at: now, at: now, tree });
                }
                Filled::Size((ri, wi), key, Sized::Changed(tree)) => {
                    let s = tree.size();
                    let w = &mut repos[ri].worktrees[wi];
                    (w.size, w.size_partial) = (Some(s.bytes), false);
                    let measured_at = g.sizes.get(&key).map_or(now, |m| m.measured_at);
                    g.sizes.insert(key, SizeMemo { bytes: s.bytes, files: s.files, partial: false, fingerprint: s.fingerprint, measured_at, at: now, tree: Some(Blob(tree.encode())) });
                }
                Filled::Size(_, key, Sized::Same) => {
                    // Shown already: nothing to publish.
                    if let Some(m) = g.sizes.get_mut(&key) {
                        m.at = now;
                    }
                    continue;
                }
                Filled::Size(_, _, Sized::Gone) => continue,
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
    let memo = PrMemo { checked_at: now_ms(), found };
    let (ri, wi) = job.at;
    show_pr(&mut repos[ri].worktrees[wi], &memo);
    g.prs.insert(job.key, memo);
}

/// Every herdr session's memos and last report, for the cache file: of the scanners that took
/// theirs from it (one that has not started since the daemon started leaves the file's as they are).
pub(crate) fn facts() -> Vec<(String, cache::Facts)> {
    let scanners: Vec<(String, Arc<Scanner>)> = SCANNERS.lock().unwrap().iter().map(|(s, sc)| (s.clone(), sc.clone())).collect();
    scanners
        .into_iter()
        .filter_map(|(s, sc)| {
            let g = sc.inner.lock().unwrap();
            g.restored.then(|| {
                let facts = cache::Facts {
                    sizes: g.sizes.clone(),
                    prs: g.prs.clone(),
                    statuses: g.statuses.clone(),
                    repos: g.repos.clone(),
                    report: g.report.clone().map(|r| CleanupReport { scanning: false, ..r }),
                };
                (s, facts)
            })
        })
        .collect()
}

/// Test seam (`cache.rs`): herdr session `session`'s scanner holding `facts`, as after its first scan.
#[cfg(test)]
pub(crate) fn hold(session: &str, facts: cache::Facts) {
    let sc = scanner(session);
    let mut g = sc.inner.lock().unwrap();
    (g.restored, g.sizes, g.prs, g.statuses, g.repos, g.report) = (true, facts.sizes, facts.prs, facts.statuses, facts.repos, facts.report);
}

/// Test seam (`schedule.rs`): a scan that ended at `at` (wall clock) with an empty report.
#[cfg(test)]
pub(crate) fn finish_for_test(sc: &Scanner, at: Millis) {
    sc.inner.lock().unwrap().report = Some(CleanupReport { scanned_at: Some(at), ..empty_report() });
    sc.tick.send_modify(|t| *t += 1);
}

#[cfg(test)]
impl Scanner {
    /// Test seam (`schedule.rs`): what a request is answered.
    pub(crate) fn answer_for_test(&self) -> CleanupReport {
        self.answer()
    }
}

/// Test seam (`remove.rs`): one worktree's row as git says it now.
#[cfg(test)]
pub(crate) async fn git_facts_now(root: &Path, common: &Path, rec: git::WorktreeRecord) -> CleanupWorktree {
    git_facts(root, Some(common), rec).await.0
}

// ───────────────────────────── discovery ─────────────────────────────

/// Main worktree roots of the repositories the board, parked agents and automations name. A folder
/// probed for its repository holds [`PROBE_FOR`] (`refresh` probes again).
async fn discover(
    sc: &Scanner,
    n: &Counters,
    workspaces: &[Workspace],
    parked: &[ParkedRecord],
    autos: Option<&AutomationList>,
    refresh: bool,
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
        let known = sc.inner.lock().unwrap().probes.get(&dir).filter(|(at, _)| !refresh && at.elapsed() < PROBE_FOR).map(|(_, r)| r.clone());
        let root = match known {
            Some(root) => root,
            None => {
                add(&n.git_calls, 1);
                match git::repo_top(&dir).await {
                    Ok(top) => {
                        let root = top.map(|t| t.root);
                        sc.inner.lock().unwrap().probes.insert(dir, (Instant::now(), root.clone()));
                        root
                    }
                    Err(_) => None,
                }
            }
        };
        roots.extend(root);
    }
    let mut seen: HashSet<PathBuf> = HashSet::new();
    roots.retain(|r| {
        r.is_dir() && seen.insert(std::fs::canonicalize(r).unwrap_or_else(|_| r.clone()))
    });
    roots
}

/// A repository's linked worktrees: as listed last time while its admin dirs did not change
/// (`signals::repo_due`), else `git worktree list` again.
async fn list_repo(sc: &Scanner, n: &Counters, root: PathBuf, refresh: bool) -> Listed {
    let key = root.display().to_string();
    let memo = sc.inner.lock().unwrap().repos.get(&key).cloned();
    let common = match memo.as_ref().and_then(|m| m.common.clone()).filter(|c| c.is_dir()) {
        Some(c) => Some(c),
        None => {
            if !root.join(".git").is_dir() {
                add(&n.git_calls, 1);
            }
            common_dir(&root).await
        }
    };
    if let (Some(m), Some(c)) = (&memo, &common) {
        let holds = m.stamp.holds(c, &m.records);
        if !signals::repo_due(Some(m), holds, refresh, now_ms(), paced(STATUS_MAX_AGE)) {
            return Listed { root, common, records: Ok(m.records.clone()) };
        }
    }
    add(&n.git_calls, 1);
    add(&n.repos_listed, 1);
    let at = now_ms();
    let records = list_linked(&root).await;
    {
        let mut g = sc.inner.lock().unwrap();
        match (&records, &common) {
            (Ok(r), Some(c)) => {
                let stamp = RepoStamp::take(c, r);
                g.repos.insert(key, RepoMemo { stamp, records: r.clone(), at, common: Some(c.clone()) });
            }
            _ => {
                g.repos.remove(&key);
            }
        }
    }
    Listed { root, common, records }
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

/// The repository's git dir (`.git`, or what `git rev-parse` says for other layouts).
pub(crate) async fn common_dir(root: &Path) -> Option<PathBuf> {
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

/// What git says about one linked worktree, asked now.
#[cfg(test)]
async fn git_facts(root: &Path, common: Option<&Path>, rec: git::WorktreeRecord) -> (CleanupWorktree, Clues) {
    let admin = common.and_then(|c| admin_dir(Path::new(&rec.path), c));
    let signals = Signals::of(&rec, admin.as_deref());
    let (w, clues, _) = git_facts_with(root, admin.as_deref(), rec, None, signals, &Counters::default()).await;
    (w, clues)
}

/// What git says about one linked worktree: its status and reachability from `kept` (its last
/// status, when nothing that changes it moved: `signals::status_due`), else asked now, with the
/// memo to keep (`None` when `kept` served). `admin`: its admin dir.
async fn git_facts_with(
    root: &Path,
    admin: Option<&Path>,
    rec: git::WorktreeRecord,
    kept: Option<StatusMemo>,
    signals: Signals,
    n: &Counters,
) -> (CleanupWorktree, Clues, Option<StatusMemo>) {
    let path = PathBuf::from(&rec.path);
    let missing = rec.prunable || !path.is_dir();
    let (dirty, unpushed, files, orphan_commits, moved, memo) = match kept {
        Some(m) => {
            add(&n.statuses_kept, u32::from(!missing));
            (m.dirty, m.unpushed, m.files_at, m.orphan, m.moved_at, None)
        }
        None => {
            let (dirty, unpushed, files) = if missing {
                (None, None, None)
            } else {
                add(&n.statuses, 1);
                add(&n.git_calls, 1);
                status(&path).await
            };
            let orphan = match (&rec.head, rec.detached) {
                (Some(head), true) => {
                    add(&n.git_calls, 1);
                    reachable(root, head).await != Some(true)
                }
                _ => false,
            };
            let moved = admin.and_then(head_moved_at);
            let memo = Some(StatusMemo { signals, at: now_ms(), dirty, unpushed, files_at: files, orphan, moved_at: moved });
            (dirty, unpushed, files, orphan, moved, memo)
        }
    };
    let w = CleanupWorktree {
        head: rec.head.as_ref().map(|h| h.chars().take(7).collect()),
        branch: rec.branch,
        missing,
        locked: rec.locked,
        dirty: dirty.filter(|_| !missing),
        unpushed: unpushed.filter(|_| !missing),
        orphan_commits,
        workspace_id: None,
        agents: 0,
        busy: false,
        created_at: admin.and_then(created_at),
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
    // A folder gone: its admin dir still tells when its HEAD last moved.
    let git = moved.or_else(|| if missing { admin.and_then(head_moved_at) } else { None });
    let clues = Clues { git, files: files.filter(|_| !missing), board: Vec::new() };
    (w, clues, memo)
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

/// Reads omp's sessions (blocking): who worked in each of `paths`, and when, and what the refresh
/// read. `first` (the board's session files) are read before the others.
fn read_sessions(paths: Vec<PathBuf>, first: HashSet<PathBuf>) -> (SessionFacts, sessions::Refreshed) {
    let dir = omp_agent_dir().join("sessions");
    let home = crate::paths::home_dir();
    let ((worked, mains, pending), read) = sessions::with_index(&dir, Some(&home), &first, SESSIONS_BUDGET, |ix| {
        (ix.worked_in(&paths), ix.main_facts(), ix.pending)
    });
    let facts = SessionFacts {
        worked: paths.iter().map(|p| p.display().to_string()).zip(worked).collect(),
        mains,
        titles: titles(),
        pending,
    };
    (facts, read)
}

/// omp's session titles (`history.db`), read again only when the database or its write-ahead log
/// changed.
fn titles() -> HashMap<String, String> {
    type Stamps = [Option<FileStamp>; 2];
    static KEPT: Mutex<Option<(Stamps, HashMap<String, String>)>> = Mutex::new(None);
    let db = omp_agent_dir().join("history.db");
    let stamps: Stamps = [file_stamp(&db), file_stamp(&db.with_extension("db-wal"))];
    let mut kept = KEPT.lock().unwrap_or_else(|p| p.into_inner());
    match kept.as_ref() {
        Some((s, titles)) if *s == stamps => titles.clone(),
        _ => {
            let titles = session_titles();
            *kept = Some((stamps, titles.clone()));
            titles
        }
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

    fn size_memo(bytes: u64, at: Millis, measured_at: Millis) -> SizeMemo {
        SizeMemo { bytes, files: 1, partial: false, fingerprint: Fingerprint { dirs: 1, hash: 42 }, measured_at, at, tree: Some(Blob(vec![1])) }
    }

    #[test]
    fn sizes_hold_then_are_checked_then_walked_again() {
        let now = 1_800_000_000_000;
        let min = 60_000;
        assert_eq!(size_due(None, false, now), SizeDue::Walk, "never measured");
        assert_eq!(size_due(Some(&size_memo(1, now - 5 * min, now - 5 * min)), false, now), SizeDue::No, "within SIZE_TTL: as it is");
        assert_eq!(size_due(Some(&size_memo(1, now - 5 * min, now - 5 * min)), true, now), SizeDue::Check, "Rescan checks every tree's folders now");
        assert_eq!(size_due(Some(&size_memo(1, now - 11 * min, now - 3 * 60 * min)), false, now), SizeDue::Check, "then its folders' stamps first");
        assert_eq!(size_due(Some(&size_memo(1, now - 11 * min, now - 7 * 60 * min)), false, now), SizeDue::Walk, "walked whole over SIZE_WALKED_FOR ago");
        assert_eq!(size_due(Some(&size_memo(1, now - 5 * min, now - 7 * 60 * min)), true, now), SizeDue::Walk, "a Rescan walks only what is due anyway");
        let older = SizeMemo { tree: None, ..size_memo(1, now - 11 * min, now - 3 * 60 * min) };
        assert_eq!(size_due(Some(&older), false, now), SizeDue::Walk, "measured before 0.9.6: walked once to learn its folders");
        let huge = SizeMemo { tree: None, fingerprint: Fingerprint { dirs: MAX_DIRS as u64 + 1, hash: 7 }, ..older.clone() };
        assert_eq!(size_due(Some(&huge), false, now), SizeDue::Check, "too big to keep: its fingerprint");
        let partial = SizeMemo { partial: true, ..size_memo(1, now - 11 * min, now - 11 * min) };
        assert_eq!(size_due(Some(&partial), false, now), SizeDue::Walk, "a partial walk has no complete tree");
        assert_eq!(size_due(Some(&size_memo(1, now + 9 * 60 * min, now + 9 * 60 * min)), false, now), SizeDue::Walk, "stamped ahead of the clock (set back)");
    }

    /// After a daemon restart the scanner starts from the cache file: sizes and pull requests are
    /// shown at once and nothing is measured or asked again while they hold.
    #[test]
    fn a_restart_keeps_sizes_and_pull_requests() {
        let now = now_ms();
        let pr = CleanupPr { number: 9, url: "https://github.com/o/r/pull/9".into(), title: "Ship it".into(), state: "MERGED".into(), draft: false, closed_at: Some(now - 86_400_000) };
        let kept = cache::Facts {
            sizes: [("/wt/a".to_string(), size_memo(5 << 30, now - 120_000, now - 120_000))].into(),
            prs: [("/wt/a\0b\0".to_string(), PrMemo { checked_at: now - 120_000, found: Ok(Some(pr.clone())) })].into(),
            ..Default::default()
        };
        let saved = serde_json::to_vec(&kept).unwrap();
        let back: cache::Facts = serde_json::from_slice(&saved).unwrap();
        let g = Inner { restored: true, sizes: back.sizes, prs: back.prs, ..Default::default() };
        let mut repos = vec![CleanupRepo { root: "/r".into(), name: "r".into(), error: None, pr_error: None, worktrees: vec![blank("/wt/a")] }];
        let n = Counters::default();
        let (sizes, prs) = plan(&g, &mut repos, false, now, &n);
        assert!(sizes.is_empty() && prs.is_empty(), "nothing due");
        assert_eq!((get(&n.sizes_kept), get(&n.prs_kept)), (1, 1));
        let w = &repos[0].worktrees[0];
        assert_eq!((w.size, w.pr.as_ref(), w.pr_checked_at), (Some(5 << 30), Some(&pr), Some(now - 120_000)));
    }

    fn run(kind: CleanupScanKind) -> Run {
        // Low off: the tests' size jobs run on the blocking pool.
        Run { kind, low: Arc::new(AtomicBool::new(false)), cancel: CancellationToken::new() }
    }

    /// Sizes of the given trees, one scan's worth: what was due, and what it cost.
    async fn size_scan(sc: &Arc<Scanner>, paths: &[PathBuf], kind: CleanupScanKind, budget: Option<(u64, Duration)>) -> (Vec<(PathBuf, SizeWork)>, Counters) {
        let mut repos = vec![CleanupRepo { root: "/r".into(), name: "r".into(), error: None, pr_error: None, worktrees: paths.iter().map(|p| blank(&p.display().to_string())).collect() }];
        let n = Arc::new(Counters::default());
        let refresh = kind == CleanupScanKind::Refresh;
        let (sizes, _) = plan(&sc.inner.lock().unwrap(), &mut repos, refresh, now_ms(), &n);
        let due = sizes.iter().map(|j| (j.path.clone(), match &j.work { SizeWork::Check(_) => SizeWork::Check(Blob::default()), w => w.clone() })).collect();
        fill_within(sc, &mut repos, &Extra::default(), sizes, Vec::new(), &n, &run(kind), budget).await;
        (due, Arc::into_inner(n).unwrap())
    }

    /// Every size memo `by` older, as if that long had passed.
    fn age_memos(sc: &Scanner, by: Millis) {
        for m in sc.inner.lock().unwrap().sizes.values_mut() {
            (m.at, m.measured_at) = (m.at - by, m.measured_at - by);
        }
    }

    fn aged_tree(wt: &Path, dirs: usize) {
        let old = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        for d in 0..dirs {
            std::fs::create_dir_all(wt.join(format!("node_modules/p{d}"))).unwrap();
            std::fs::write(wt.join(format!("node_modules/p{d}/index.js")), "x").unwrap();
        }
        std::fs::create_dir_all(wt.join("src")).unwrap();
        std::fs::write(wt.join("src/lib.rs"), "x").unwrap();
        let mut all = vec![wt.to_path_buf(), wt.join("src"), wt.join("node_modules")];
        all.extend((0..dirs).map(|d| wt.join(format!("node_modules/p{d}"))));
        for d in all {
            std::fs::File::open(&d).unwrap().set_modified(old).unwrap();
        }
    }

    /// Past SIZE_TTL a quiet tree costs one `stat` per folder and no listing; a tree where a file
    /// came lists that file's folder only; a file grown in place is counted once the tree's whole
    /// walk is older than SIZE_WALKED_FOR.
    #[cfg(unix)]
    #[tokio::test]
    async fn sizes_past_the_ttl_cost_stats_until_a_folder_changes() {
        let td = tempfile::tempdir().unwrap();
        let (a, b) = (td.path().join("wt-a"), td.path().join("wt-b"));
        aged_tree(&a, 30);
        aged_tree(&b, 30);
        let dirs = 33u64; // the root, src, node_modules and its 30 packages
        let sc = Arc::new(Scanner::default());
        sc.inner.lock().unwrap().restored = true;
        let memo = |p: &Path| sc.inner.lock().unwrap().sizes[&p.display().to_string()].clone();
        let both = [a.clone(), b.clone()];

        let (due, n) = size_scan(&sc, &both, CleanupScanKind::Background, None).await;
        assert_eq!(due, [(a.clone(), SizeWork::Walk), (b.clone(), SizeWork::Walk)], "never measured: walked");
        assert_eq!((get(&n.size_walks), get64(&n.dir_reads)), (2, 2 * dirs));
        let (first_a, first_b) = (memo(&a), memo(&b));
        assert!(first_a.tree.is_some() && first_b.tree.is_some(), "their folders are kept");

        let (due, n) = size_scan(&sc, &both, CleanupScanKind::Background, None).await;
        assert!(due.is_empty() && get(&n.sizes_kept) == 2, "within SIZE_TTL: held, nothing touched");

        // A scheduled scan 20 minutes later, nothing changed: stats only.
        age_memos(&sc, 20 * 60_000);
        let (due, n) = size_scan(&sc, &both, CleanupScanKind::Background, None).await;
        assert_eq!(due.len(), 2);
        assert_eq!((get(&n.size_checks), get(&n.size_walks), get64(&n.dir_reads), get64(&n.dir_entries), get64(&n.dir_stats)), (2, 0, 0, 0, 2 * dirs));
        assert_eq!(memo(&a).bytes, first_a.bytes);

        // 20 minutes later again: a file grew in place in wt-a, a file came to wt-b's src.
        age_memos(&sc, 20 * 60_000);
        let mut log = std::fs::OpenOptions::new().append(true).open(a.join("src/lib.rs")).unwrap();
        std::io::Write::write_all(&mut log, &[b'x'; 200_000]).unwrap();
        std::fs::write(b.join("src/new.rs"), vec![b'y'; 300_000]).unwrap();
        let (_, n) = size_scan(&sc, &both, CleanupScanKind::Background, None).await;
        assert_eq!((get(&n.size_walks), get64(&n.dir_reads), get64(&n.dir_entries)), (0, 1, 2), "only wt-b's src is listed (lib.rs and new.rs)");
        let (now_a, now_b) = (memo(&a), memo(&b));
        assert_eq!(now_a.bytes, first_a.bytes, "wt-a: no folder moved, its size holds");
        assert!(now_b.bytes >= first_b.bytes + 300_000, "wt-b: the new file counted");
        assert_eq!(now_b.measured_at, first_b.measured_at - 40 * 60_000, "a check is no whole walk");

        // wt-a's whole walk is now 7 hours old: walked again, the file grown in place counted.
        let m = sc.inner.lock().unwrap().sizes.get_mut(&a.display().to_string()).map(|m| (m.at, m.measured_at) = (now_ms() - 20 * 60_000, now_ms() - 7 * 3_600_000));
        assert!(m.is_some());
        let (due, n) = size_scan(&sc, &[a.clone()], CleanupScanKind::Background, None).await;
        assert_eq!((due, get(&n.size_walks)), (vec![(a.clone(), SizeWork::Walk)], 1));
        let walked = size::measure(&a, Budget::new(u64::MAX, Duration::from_secs(60))).bytes;
        assert!(walked > first_a.bytes + 150_000 && memo(&a).bytes == walked);
    }

    /// A scan's size budget leaves the trees it did not get to for the next scans, first in line:
    /// no tree waits forever. A Rescan checks them all.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_size_budget_takes_turns_oldest_first() {
        let td = tempfile::tempdir().unwrap();
        let trees: Vec<PathBuf> = (0..6).map(|i| td.path().join(format!("wt-{i}"))).collect();
        for t in &trees {
            aged_tree(t, 7);
        }
        let sc = Arc::new(Scanner::default());
        sc.inner.lock().unwrap().restored = true;
        size_scan(&sc, &trees, CleanupScanKind::Refresh, None).await;
        let at = |sc: &Scanner| -> HashMap<String, Millis> { sc.inner.lock().unwrap().sizes.iter().map(|(k, m)| (k.clone(), m.at)).collect() };
        // Each check costs 10 stats: a budget of 25 starts three a scan (the third while 20 are spent).
        let budget = Some((25, Duration::from_secs(60)));
        let mut checked: HashSet<String> = HashSet::new();
        for scan in 0..2 {
            age_memos(&sc, 20 * 60_000);
            let before = at(&sc);
            let (_, n) = size_scan(&sc, &trees, CleanupScanKind::Background, budget).await;
            let now = at(&sc);
            let this: Vec<&String> = now.iter().filter(|(k, t)| before[*k] != **t).map(|(k, _)| k).collect();
            assert_eq!((this.len(), get(&n.sizes_deferred)), (3, 3), "scan {scan}: three checked, three left");
            assert!(this.iter().all(|k| !checked.contains(*k)), "scan {scan}: the ones left last time go first");
            checked.extend(this.into_iter().cloned());
        }
        assert_eq!(checked.len(), trees.len(), "every tree had its turn");
        age_memos(&sc, 20 * 60_000);
        let (_, n) = size_scan(&sc, &trees, CleanupScanKind::Refresh, None).await;
        assert_eq!((get(&n.size_checks), get(&n.sizes_deferred)), (6, 0), "a Rescan checks them all");
    }

    #[tokio::test]
    async fn discovery_dedupes_and_probes_parked_folders_once() {
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
        let (sc, n) = (Scanner::default(), Counters::default());
        let roots = discover(&sc, &n, std::slice::from_ref(&ws), &parked, None, false).await;
        assert_eq!(roots.len(), 1);
        assert!(same_path(&roots[0], &root));
        discover(&sc, &n, std::slice::from_ref(&ws), &parked, None, false).await;
        assert_eq!(get(&n.git_calls), 1, "the parked folder is probed once (PROBE_FOR)");
        discover(&sc, &n, &[ws], &parked, None, true).await;
        assert_eq!(get(&n.git_calls), 2, "Rescan probes again");
    }

    /// One scan's git facts of the repository at `root`, the way `scan` works them out.
    async fn repo_facts(sc: &Scanner, n: &Counters, root: &Path, common: &Path) -> Vec<CleanupWorktree> {
        let listed = list_repo(sc, n, root.to_path_buf(), false).await;
        let mut out = Vec::new();
        for rec in listed.records.unwrap() {
            let admin = admin_dir(Path::new(&rec.path), common);
            let signals = Signals::of(&rec, admin.as_deref());
            let memo = sc.inner.lock().unwrap().statuses.get(&rec.path).cloned();
            let kept = memo.filter(|m| signals::status_due(Some(m), &signals, None, false, now_ms(), STATUS_MAX_AGE) == StatusDue::Keep);
            let (w, _, memo) = git_facts_with(root, admin.as_deref(), rec, kept, signals, n).await;
            if let Some(m) = memo {
                sc.inner.lock().unwrap().statuses.insert(w.path.clone(), m);
            }
            out.push(w);
        }
        out
    }

    /// A repository whose admin dirs did not change is not listed again; worktrees whose status
    /// signals held keep their status; a commit in one asks git about that one only.
    #[tokio::test]
    async fn quiet_repositories_and_worktrees_ask_git_nothing() {
        let td = fixture();
        let root = td.path().to_path_buf();
        sh(&root, &["checkout", "-q", "-f", "main"]);
        let parent = root.parent().unwrap().to_path_buf();
        let wts: Vec<PathBuf> = (0..3).map(|i| parent.join(format!("{}-q{i}", root.file_name().unwrap().to_string_lossy()))).collect();
        for (i, wt) in wts.iter().enumerate() {
            sh(&root, &["worktree", "add", "-q", "-b", &format!("q{i}"), wt.to_str().unwrap(), "main"]);
        }
        // Everything git wrote, dated long ago (racy stamps are asked again).
        let old = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let common = root.join(".git");
        for wt in &wts {
            let admin = admin_dir(wt, &common).unwrap();
            // (`git worktree add` writes ORIG_HEAD too)
            for f in [admin.clone(), admin.join("index"), admin.join("HEAD"), admin.join("ORIG_HEAD"), admin.join("logs/HEAD")].into_iter().filter(|f| f.exists()) {
                std::fs::File::open(&f).unwrap().set_modified(old).unwrap();
            }
        }
        std::fs::File::open(common.join("worktrees")).unwrap().set_modified(old).unwrap();
        let sc = Scanner::default();
        let n = Counters::default();
        let first = repo_facts(&sc, &n, &root, &common).await;
        assert_eq!(first.len(), 3);
        assert_eq!((get(&n.repos_listed), get(&n.statuses)), (1, 3), "the first scan asks git about everything");
        // The statuses were just taken: back-date them past RACY, as a scan 20 minutes later sees them.
        for m in sc.inner.lock().unwrap().statuses.values_mut() {
            m.at -= 20 * 60_000;
        }
        sc.inner.lock().unwrap().repos.values_mut().for_each(|m| m.at -= 20 * 60_000);
        let n = Counters::default();
        let again = repo_facts(&sc, &n, &root, &common).await;
        assert_eq!(again, first, "the same facts");
        assert_eq!((get(&n.repos_listed), get(&n.statuses), get(&n.statuses_kept), get(&n.git_calls)), (0, 0, 3, 0), "nothing changed: no git at all");

        std::fs::write(wts[1].join("work.txt"), "w").unwrap();
        sh(&wts[1], &["add", "work.txt"]);
        sh(&wts[1], &["commit", "-q", "-m", "work"]);
        let n = Counters::default();
        let after = repo_facts(&sc, &n, &root, &common).await;
        assert_eq!((get(&n.repos_listed), get(&n.statuses), get(&n.statuses_kept)), (1, 1, 2), "a commit in one: listed again, its status only");
        assert_ne!(after[1].head, first[1].head);
    }

    fn report_with(rows: Vec<CleanupWorktree>, scanned_at: Millis) -> CleanupReport {
        CleanupReport { scanned_at: Some(scanned_at), repos: vec![CleanupRepo { root: "/r".into(), name: "r".into(), error: None, pr_error: None, worktrees: rows }], ..empty_report() }
    }

    fn ask(latest: bool, refresh: bool) -> CleanupScanParams {
        CleanupScanParams { refresh, wait_ms: Some(1500), latest }
    }

    /// The page's request against the latest report: answered from a fresh one with nothing
    /// started, a scan asked for when it is older (apps before 0.9.6: after a minute), a running
    /// scan joined, a Rescan stopping a background scan.
    #[test]
    fn requests_are_answered_from_a_fresh_report() {
        use CleanupScanKind::{Background, Page, Refresh};
        let now = 1_800_000_000_000;
        let min = 60_000;
        let every = Duration::from_secs(30 * 60);
        let d = |at: Option<Millis>, running, want, p: CleanupScanParams| decide(at, running, want, &p, now, every);
        assert_eq!(d(Some(now - 12 * min), None, None, ask(true, false)), Ask::Answer, "12 min old: answered as it is");
        assert_eq!(d(Some(now - 12 * min), Some(Background), None, ask(true, false)), Ask::Answer, "a background scan running changes nothing");
        assert_eq!(d(Some(now - 31 * min), None, None, ask(true, false)), Ask::Start(Page), "older than the interval");
        assert_eq!(d(None, None, None, ask(true, false)), Ask::Start(Page), "no report yet");
        assert_eq!(d(Some(now - 2 * min), None, None, ask(false, false)), Ask::Start(Page), "an older app: after a minute, as before");
        assert_eq!(d(Some(now - 30_000), None, None, ask(false, false)), Ask::Answer);
        assert_eq!(d(Some(now - min), None, None, ask(true, true)), Ask::Start(Refresh), "Rescan");
        assert_eq!(d(Some(now - 31 * min), Some(Background), None, ask(true, false)), Ask::Join, "a stale report joins the background scan running");
        assert_eq!(d(Some(now - min), Some(Background), None, ask(true, true)), Ask::Preempt, "a Rescan stops a background scan");
        assert_eq!(d(Some(now - min), Some(Refresh), None, ask(true, true)), Ask::Join, "a Rescan joins a Rescan");
        assert_eq!(d(None, None, Some(Page), ask(true, true)), Ask::Start(Refresh), "a Rescan upgrades a scan asked for");
        assert_eq!(d(None, None, Some(Refresh), ask(true, false)), Ask::Join);
    }

    /// Carried out on a scanner: a fresh report starts nothing and says how the host keeps it
    /// fresh; a stale one takes the background scan over (normal priority from its next step); a
    /// Rescan stops it and is next.
    #[test]
    fn the_scanner_answers_takes_over_and_preempts() {
        let sc = Scanner::default();
        sc.inner.lock().unwrap().report = Some(report_with(vec![blank("/wt/a")], now_ms() - 12 * 60_000));
        sc.set_next(Some(now_ms() + 18 * 60_000));
        assert_eq!(sc.ask(&ask(true, false), now_ms()), Ask::Answer);
        assert!(sc.wanted().is_none() && !sc.busy(), "no scan asked for");
        let r = sc.answer();
        let bg = r.background.unwrap();
        assert!(!r.scanning && !bg.running && bg.next_at.is_some() && bg.every_ms == 30 * 60_000);

        let run = sc.begin(CleanupScanKind::Background);
        assert!(run.low.load(Ordering::Relaxed));
        let r = sc.answer();
        assert!(r.scanning && r.background.unwrap().running, "a background scan: nobody needs to follow it");
        sc.inner.lock().unwrap().report.as_mut().unwrap().scanned_at = Some(now_ms() - 40 * 60_000);
        assert_eq!(sc.ask(&ask(true, false), now_ms()), Ask::Join);
        assert!(!run.low.load(Ordering::Relaxed), "taken over: normal priority from its next step");
        assert!(!sc.answer().background.unwrap().running, "the page follows it now");
        assert_eq!(sc.ask(&ask(true, true), now_ms()), Ask::Preempt);
        assert!(run.cancel.is_cancelled() && sc.wanted() == Some(CleanupScanKind::Refresh));
        sc.end();
        let next = sc.begin(CleanupScanKind::Background);
        assert_eq!(next.kind, CleanupScanKind::Refresh, "the Rescan asked for starts, not another background scan");
        assert!(!next.low.load(Ordering::Relaxed));
    }

    /// A worktree checked again before removal replaces its row: git's and the board's facts
    /// new, size, pull request and owner kept.
    #[test]
    fn a_fresh_row_keeps_what_only_a_scan_learns() {
        let sc = Scanner::default();
        let mut old = blank("/wt/a");
        (old.size, old.head, old.pr_checked_at, old.active_at) = (Some(9 << 20), Some("abc1234".into()), Some(5), Some(7_000));
        old.owner = Some(CleanupOwnerRef { key: "k".into(), subagents: Vec::new() });
        sc.inner.lock().unwrap().report = Some(report_with(vec![old], 1));
        let mut fresh = blank("/wt/a");
        (fresh.head, fresh.dirty, fresh.agents, fresh.active_at) = (Some("abc1234".into()), Some(3), 1, Some(6_000));
        refresh_row(&sc, Path::new("/r"), fresh);
        let row = sc.answer().repos[0].worktrees[0].clone();
        assert_eq!((row.dirty, row.agents, row.size, row.pr_checked_at, row.active_at), (Some(3), 1, Some(9 << 20), Some(5), Some(7_000)));
        assert!(row.owner.is_some());
    }

    /// Bench: the git facts a scan asks for every worktree (`git worktree list`, `git status`, the
    /// admin dir), on a synthetic repository of 3 000 files with 40 linked worktrees, a quarter of
    /// them with changes. `TF_BENCH_TMP` puts it on another disk than the temp dir. Release build:
    /// `cargo test --release -p tf-hostd --lib git_facts_cost -- --ignored --nocapture`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "bench"]
    async fn git_facts_cost() {
        let base = std::env::var_os("TF_BENCH_TMP").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        let td = tempfile::tempdir_in(base).unwrap();
        let root = td.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        sh(&root, &["init", "-q", "-b", "main"]);
        for d in 0..100 {
            let dir = root.join(format!("src/mod{d}"));
            std::fs::create_dir_all(&dir).unwrap();
            for f in 0..30 {
                std::fs::write(dir.join(format!("file{f}.rs")), format!("// {d}/{f}\nfn f() {{}}\n")).unwrap();
            }
        }
        sh(&root, &["add", "."]);
        sh(&root, &["commit", "-q", "-m", "init"]);
        for i in 0..40 {
            let wt = td.path().join(format!("wt{i}"));
            sh(&root, &["worktree", "add", "-q", "-b", &format!("wt-{i}"), wt.to_str().unwrap(), "main"]);
            if i % 4 == 0 {
                std::fs::write(wt.join("src/mod1/file1.rs"), "changed").unwrap();
                std::fs::write(wt.join("notes.md"), "new").unwrap();
            }
        }
        let t = Instant::now();
        let records = list_linked(&root).await.unwrap();
        let listed = t.elapsed();
        let common = common_dir(&root).await;
        let slots = Arc::new(Semaphore::new(GIT_PARALLEL));
        let t = Instant::now();
        let mut set = tokio::task::JoinSet::new();
        for rec in records {
            let (root, common, slots) = (root.clone(), common.clone(), slots.clone());
            set.spawn(async move {
                let _slot = slots.acquire_owned().await;
                git_facts(&root, common.as_deref(), rec).await
            });
        }
        let mut n = 0;
        while let Some(r) = set.join_next().await {
            n += usize::from(r.is_ok());
        }
        println!(
            "git worktree list: {:.0} ms; git facts of {n} worktrees ({GIT_PARALLEL} at a time): {:.0} ms",
            listed.as_secs_f64() * 1e3,
            t.elapsed().as_secs_f64() * 1e3
        );
    }
}
