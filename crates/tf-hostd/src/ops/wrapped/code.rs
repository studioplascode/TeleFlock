//! Commits and merged pull requests for `host.wrapped`, in the repositories the agents worked in.
//!
//! One git repository per main worktree (linked worktrees fold into it; `--all` sees every
//! worktree's branches), at most [`MAX_REPOS`], [`PARALLEL`] at a time:
//! - commits: `git log --all --no-merges` over the window, authored with the repository's
//!   `user.email` (agents commit as you); commits GitHub made (web merges, squashes) and lock
//!   files' lines are left out, binary files count no lines;
//! - pull requests: `gh pr list --state merged --author @me` (the repository's GitHub remote),
//!   merged within the window.
//!
//! Gathering runs in the background, one at a time per (herdr session, window); its result is
//! kept [`FRESH`] and shared by every request meanwhile. A request waits [`WAIT`] at most.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use futures::StreamExt;
use serde_json::Value;
use tf_proto::{Millis, WrappedCode, WrappedCommit, WrappedPr, WrappedRepo};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::ops::git::{self, RepoTop};
use crate::util::now_ms;

const MAX_REPOS: usize = 16;
const PARALLEL: usize = 4;
const MAX_COMMITS: usize = 2000;
const QUICK: Duration = Duration::from_secs(5);
const GIT_TIMEOUT: Duration = Duration::from_secs(20);
const GH_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a gathered answer is reused …
const FRESH: Duration = Duration::from_secs(5 * 60);
/// … and how fresh it must be when the app asks to look again.
const REFRESH_MIN: Duration = Duration::from_secs(30);
/// How long a request waits for a gathering before answering `pending`.
const WAIT: Duration = Duration::from_secs(6);
/// Windows remembered (several devices, this week and earlier ones).
const CACHE_SIZE: usize = 12;
/// Who commits when a pull request is merged or squashed on github.com.
const GITHUB_COMMITTER: &str = "noreply@github.com";
const DAY_MS: Millis = 86_400_000;
/// Generated dependency pins: their lines are not work.
const LOCK_FILES: &[&str] = &[
    "Cargo.lock",
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "deno.lock",
    "go.sum",
    "poetry.lock",
    "uv.lock",
    "Pipfile.lock",
    "composer.lock",
    "Gemfile.lock",
    "flake.lock",
    "Package.resolved",
    "pubspec.lock",
    "mix.lock",
];

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(super) struct Key {
    pub session: String,
    pub since: Millis,
    /// As the app sent it (absent = the week so far).
    pub until: Option<Millis>,
}

#[derive(Debug, Clone)]
pub(super) struct Facts {
    pub code: WrappedCode,
    pub prs: Option<Vec<WrappedPr>>,
    pub prs_note: Option<String>,
}

enum Entry {
    Running(watch::Receiver<Option<Arc<Facts>>>),
    Done(Instant, Arc<Facts>),
}

static CACHE: LazyLock<Mutex<HashMap<Key, Entry>>> = LazyLock::new(Default::default);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// The facts for `key`: cached, or from a gathering that finishes within [`WAIT`] (started now
/// unless one runs). `None`: still gathering, ask again.
pub(super) async fn facts(key: Key, dirs: Vec<PathBuf>, refresh: bool, cancel: CancellationToken) -> Option<Arc<Facts>> {
    let mut rx = {
        let mut cache = lock(&CACHE);
        let fresh_for = if refresh { REFRESH_MIN } else { FRESH };
        match cache.get(&key) {
            Some(Entry::Done(at, f)) if at.elapsed() < fresh_for => return Some(f.clone()),
            Some(Entry::Running(rx)) => rx.clone(),
            _ => {
                let (tx, rx) = watch::channel(None);
                cache.insert(key.clone(), Entry::Running(rx.clone()));
                prune(&mut cache);
                tokio::spawn(run(key, dirs, tx, cancel));
                rx
            }
        }
    };
    match tokio::time::timeout(WAIT, rx.wait_for(Option::is_some)).await {
        Ok(Ok(v)) => v.clone(),
        _ => None,
    }
}

async fn run(key: Key, dirs: Vec<PathBuf>, tx: watch::Sender<Option<Arc<Facts>>>, cancel: CancellationToken) {
    let until = key.until.map_or_else(now_ms, |u| u.min(now_ms()));
    let facts = tokio::select! {
        f = gather(&dirs, key.since, until) => Arc::new(f),
        _ = cancel.cancelled() => {
            lock(&CACHE).remove(&key);
            return;
        }
    };
    lock(&CACHE).insert(key, Entry::Done(Instant::now(), facts.clone()));
    let _ = tx.send(Some(facts));
}

/// Keeps the newest [`CACHE_SIZE`] finished entries (and every running one).
fn prune(cache: &mut HashMap<Key, Entry>) {
    let mut done: Vec<(Key, Instant)> = cache
        .iter()
        .filter_map(|(k, e)| match e {
            Entry::Done(at, _) => Some((k.clone(), *at)),
            Entry::Running(_) => None,
        })
        .collect();
    if done.len() <= CACHE_SIZE {
        return;
    }
    done.sort_by_key(|(_, at)| std::cmp::Reverse(*at));
    for (k, _) in done.drain(CACHE_SIZE..) {
        cache.remove(&k);
    }
}

/// What one repository contributed.
struct RepoFacts {
    repo: WrappedRepo,
    commits: Vec<WrappedCommit>,
    prs: PrOutcome,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) enum PrOutcome {
    Merged(Vec<WrappedPr>),
    /// The repository has no GitHub remote.
    NotGitHub,
    NoGh,
    SignedOut,
    Failed(String),
}

async fn gather(dirs: &[PathBuf], since: Millis, until: Millis) -> Facts {
    let mut repos: Vec<RepoTop> = Vec::new();
    for d in dirs {
        if repos.len() >= MAX_REPOS {
            break;
        }
        if !d.is_dir() || repos.iter().any(|r| d.starts_with(&r.top)) {
            continue;
        }
        if let Ok(Some(t)) = git::repo_top(d).await
            && !repos.iter().any(|r| r.root == t.root)
        {
            repos.push(t);
        }
    }
    let gh = git::resolve_bin("gh").is_some();
    let found: Vec<RepoFacts> = futures::stream::iter(repos.into_iter().map(|t| repo_facts(t, since, until, gh))).buffer_unordered(PARALLEL).collect().await;
    merge(found)
}

async fn repo_facts(t: RepoTop, since: Millis, until: Millis, gh: bool) -> RepoFacts {
    let name = t.root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| t.root.display().to_string());
    let (commits, prs) = tokio::join!(commits(&t.top, &name, since, until), prs(&t.top, since, until, gh));
    let (commits, error) = match commits {
        Ok(c) => (c, None),
        Err(e) => (vec![], Some(e)),
    };
    RepoFacts { repo: WrappedRepo { name, path: t.root.display().to_string(), error }, commits, prs }
}

fn merge(found: Vec<RepoFacts>) -> Facts {
    let mut repos = Vec::new();
    let mut commits: Vec<WrappedCommit> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut outcomes = Vec::new();
    for f in found {
        for c in f.commits {
            if seen.insert(c.sha.clone()) {
                commits.push(c);
            }
        }
        outcomes.push((f.repo.name.clone(), f.prs));
        repos.push(f.repo);
    }
    commits.sort_by(|a, b| b.at.cmp(&a.at).then(a.sha.cmp(&b.sha)));
    commits.truncate(MAX_COMMITS);
    repos.sort_by(|a, b| a.name.cmp(&b.name));
    let (prs, prs_note) = merge_prs(outcomes);
    Facts { code: WrappedCode { repos, commits }, prs, prs_note }
}

/// The merged pull requests of every repository GitHub answered for, newest first, and why any
/// are missing.
pub(super) fn merge_prs(outcomes: Vec<(String, PrOutcome)>) -> (Option<Vec<WrappedPr>>, Option<String>) {
    if outcomes.is_empty() {
        return (Some(vec![]), None);
    }
    let mut merged: Vec<WrappedPr> = Vec::new();
    let mut answered = false;
    let (mut no_gh, mut signed_out) = (false, false);
    let mut failed: Vec<String> = Vec::new();
    for (name, o) in outcomes {
        match o {
            PrOutcome::Merged(prs) => {
                answered = true;
                for p in prs {
                    if !merged.iter().any(|m| m.url == p.url) {
                        merged.push(p);
                    }
                }
            }
            PrOutcome::NotGitHub => {}
            PrOutcome::NoGh => no_gh = true,
            PrOutcome::SignedOut => signed_out = true,
            PrOutcome::Failed(_) => failed.push(name),
        }
    }
    merged.sort_by(|a, b| b.merged_at.cmp(&a.merged_at).then(a.url.cmp(&b.url)));
    failed.sort();
    let note = if no_gh {
        Some("The GitHub CLI (gh) is not installed on this host: install it and run `gh auth login` to count merged pull requests.".to_string())
    } else if signed_out {
        Some("gh is not signed in on this host: run `gh auth login` there to count merged pull requests.".to_string())
    } else if !failed.is_empty() {
        Some(format!("GitHub did not answer for {}.", failed.join(", ")))
    } else if !answered {
        Some("None of the repositories the agents worked in is on GitHub.".to_string())
    } else {
        None
    };
    (answered.then_some(merged), note)
}

async fn commits(top: &Path, repo: &str, since: Millis, until: Millis) -> Result<Vec<WrappedCommit>, String> {
    let email = git::git(top, &["config", "user.email"], QUICK).await.map_err(|e| e.message)?;
    let email = email.line().trim().to_string();
    if email.is_empty() {
        return Ok(vec![]);
    }
    let since_arg = format!("--since=@{}", since.div_euclid(1000));
    let until_arg = format!("--until=@{}", (until + 999).div_euclid(1000));
    let args = ["log", "--all", "--no-merges", since_arg.as_str(), until_arg.as_str(), "--format=%x1e%H%x1f%ae%x1f%ce%x1f%ct", "--numstat"];
    let out = git::git(top, &args, GIT_TIMEOUT).await.map_err(|e| e.message)?;
    if !out.ok() {
        return Err(out.message());
    }
    Ok(parse_log(&out.stdout_str(), &email, repo, since, until))
}

/// Parses `git log --format=%x1e%H%x1f%ae%x1f%ce%x1f%ct --numstat`: commits authored by `email`
/// (case-insensitive), not committed by GitHub, with their commit time in `since..until`.
pub(super) fn parse_log(text: &str, email: &str, repo: &str, since: Millis, until: Millis) -> Vec<WrappedCommit> {
    let mut out = Vec::new();
    for rec in text.split('\x1e') {
        let mut lines = rec.lines();
        let Some(head) = lines.next() else { continue };
        let fields: Vec<&str> = head.split('\x1f').collect();
        let [sha, author, committer, time] = fields[..] else { continue };
        let Ok(secs) = time.trim().parse::<i64>() else { continue };
        let at = secs * 1000;
        if !author.trim().eq_ignore_ascii_case(email) || committer.trim().eq_ignore_ascii_case(GITHUB_COMMITTER) || at < since || at >= until {
            continue;
        }
        let (mut added, mut removed) = (0u32, 0u32);
        for line in lines {
            let mut parts = line.splitn(3, '\t');
            let (Some(a), Some(r), Some(path)) = (parts.next(), parts.next(), parts.next()) else { continue };
            // Binary files show `-` for both counts.
            let (Ok(a), Ok(r)) = (a.parse::<u32>(), r.parse::<u32>()) else { continue };
            if is_lock_file(path) {
                continue;
            }
            added = added.saturating_add(a);
            removed = removed.saturating_add(r);
        }
        out.push(WrappedCommit { sha: sha.trim().chars().take(12).collect(), repo: repo.to_string(), at, added, removed });
        if out.len() >= MAX_COMMITS {
            break;
        }
    }
    out
}

/// `path` (a numstat path, renames as `a => b` or `dir/{a => b}`) names a lock file.
pub(super) fn is_lock_file(path: &str) -> bool {
    let dest = path.rsplit_once("=> ").map_or(path, |(_, b)| b).replace(['{', '}'], "");
    let name = dest.rsplit(['/', '\\']).next().unwrap_or(&dest).trim();
    LOCK_FILES.contains(&name)
}

async fn prs(top: &Path, since: Millis, until: Millis, gh: bool) -> PrOutcome {
    if !gh {
        return PrOutcome::NoGh;
    }
    // GitHub's search takes days; a day of slack covers every time zone, the window is exact below.
    let Some(day) = jiff::Timestamp::from_millisecond(since - DAY_MS).ok().map(|t| t.strftime("%Y-%m-%d").to_string()) else {
        return PrOutcome::Failed("bad window".into());
    };
    let search = format!("merged:>={day}");
    let args = ["pr", "list", "--state", "merged", "--author", "@me", "--search", search.as_str(), "--json", "number,title,url,mergedAt", "--limit", "100"];
    let out = match crate::ops::gh::gh(top, &args, GH_TIMEOUT).await {
        Ok(o) => o,
        Err(e) => return PrOutcome::Failed(e.message),
    };
    if !out.ok() {
        return pr_failure(&out.message());
    }
    match serde_json::from_slice::<Value>(&out.stdout) {
        Ok(v) => PrOutcome::Merged(parse_prs(&v, since, until)),
        Err(e) => PrOutcome::Failed(format!("unreadable gh answer: {e}")),
    }
}

/// Why `gh pr list` failed, from its message.
pub(super) fn pr_failure(message: &str) -> PrOutcome {
    let m = message.to_lowercase();
    if m.contains("none of the git remotes") || m.contains("no git remotes") || m.contains("could not determine") || m.contains("not a git repository") {
        PrOutcome::NotGitHub
    } else if m.contains("gh auth login") || m.contains("not logged into") || m.contains("authentication") || m.contains("http 401") {
        PrOutcome::SignedOut
    } else {
        PrOutcome::Failed(message.trim().to_string())
    }
}

/// Parses `gh pr list --json number,title,url,mergedAt`, keeping those merged in `since..until`.
pub(super) fn parse_prs(v: &Value, since: Millis, until: Millis) -> Vec<WrappedPr> {
    let Some(list) = v.as_array() else { return vec![] };
    list.iter()
        .filter_map(|p| {
            let url = p.get("url")?.as_str()?.to_string();
            let merged_at = p.get("mergedAt")?.as_str()?.parse::<jiff::Timestamp>().ok()?.as_millisecond();
            if merged_at < since || merged_at >= until {
                return None;
            }
            Some(WrappedPr {
                repo: repo_of_url(&url),
                number: p.get("number")?.as_u64()?,
                title: p.get("title").and_then(Value::as_str).unwrap_or_default().to_string(),
                url,
                merged_at,
            })
        })
        .collect()
}

/// `https://github.com/owner/name/pull/12` → `owner/name`.
fn repo_of_url(url: &str) -> String {
    let path = url.split_once("://").map_or(url, |(_, rest)| rest);
    let parts: Vec<&str> = path.split('/').collect();
    match parts.iter().position(|p| *p == "pull") {
        Some(i) if i >= 3 => format!("{}/{}", parts[i - 2], parts[i - 1]),
        _ => String::new(),
    }
}
