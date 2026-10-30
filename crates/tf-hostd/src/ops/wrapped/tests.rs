use std::path::{Path, PathBuf};

use serde_json::json;
use tf_proto::{AutomationRun, AutomationRunStatus, AutomationTrigger, UsageKeyStat, UsageModelStat, UsageStat, WrappedPr};

use super::code::{is_lock_file, merge_prs, parse_log, parse_prs, pr_failure, PrOutcome};
use super::{count_runs, crew_from, models_from, window_end, work_dirs};

const H: i64 = 3_600_000;

fn stat(requests: u64, output: u64, tps: f64, tps_n: u64) -> UsageStat {
    UsageStat {
        requests,
        errors: 0,
        cost_usd: requests as f64 * 0.01,
        unpriced: 0,
        tokens: output * 4,
        input: output * 3,
        output,
        cache_read: 0,
        cache_write: 0,
        premium: 0.0,
        uncached_usd: 0.0,
        cached_usd: 0.0,
        duration_ms: 0.0,
        duration_n: 0,
        ttft_ms: 0.0,
        ttft_n: 0,
        tps,
        tps_n,
        first_at: None,
        last_at: None,
    }
}

/// One `git log --format=%x1e%H%x1f%ae%x1f%ce%x1f%ct --numstat` record.
fn rec(sha: &str, author: &str, committer: &str, secs: i64, numstat: &[&str]) -> String {
    let mut s = format!("\x1e{sha}\x1f{author}\x1f{committer}\x1f{secs}\n\n");
    for l in numstat {
        s.push_str(l);
        s.push('\n');
    }
    s
}

#[test]
fn log_counts_your_commits_in_the_window_without_lock_files_or_binaries() {
    let since = 1_000 * 1000;
    let until = 2_000 * 1000;
    let text = [
        rec("aaaaaaaaaaaaaaaaaaaaaaaa", "Me@Example.com", "me@example.com", 1_500, &["10\t2\tsrc/a.rs", "-\t-\tlogo.png", "400\t380\tCargo.lock", "3\t1\tweb/{old.lock => bun.lock}"]),
        // A teammate's commit fetched into a remote-tracking branch.
        rec("bbbbbbbbbbbbbbbbbbbbbbbb", "them@example.com", "them@example.com", 1_600, &["50\t0\tsrc/b.rs"]),
        // GitHub's squash of a pull request: its lines are already in the branch's commits.
        rec("cccccccccccccccccccccccc", "me@example.com", "noreply@github.com", 1_700, &["10\t2\tsrc/a.rs"]),
        // Window edges: `since` is in, `until` is out.
        rec("dddddddddddddddddddddddd", "me@example.com", "me@example.com", 1_000, &["1\t0\tREADME.md"]),
        rec("eeeeeeeeeeeeeeeeeeeeeeee", "me@example.com", "me@example.com", 2_000, &["1\t0\tREADME.md"]),
        // A rename keeps its counts.
        rec("ffffffffffffffffffffffff", "me@example.com", "me@example.com", 1_900, &["4\t4\tsrc/{x.rs => y.rs}"]),
    ]
    .concat();
    let commits = parse_log(&text, "me@example.com", "app", since, until);
    let got: Vec<(&str, u32, u32)> = commits.iter().map(|c| (c.sha.as_str(), c.added, c.removed)).collect();
    assert_eq!(got, vec![("aaaaaaaaaaaa", 10, 2), ("dddddddddddd", 1, 0), ("ffffffffffff", 4, 4)]);
    assert!(commits.iter().all(|c| c.repo == "app"));
    assert_eq!(commits[0].at, 1_500_000);
}

#[test]
fn lock_files_by_name_and_rename_target() {
    for p in ["Cargo.lock", "web/bun.lock", "a/package-lock.json", "web/{old.lock => bun.lock}", "x.json => pnpm-lock.yaml", "go.sum"] {
        assert!(is_lock_file(p), "{p}");
    }
    for p in ["src/lock.rs", "Cargo.toml", "docs/{bun.lock => notes.md}", "locks/README.md"] {
        assert!(!is_lock_file(p), "{p}");
    }
}

#[test]
fn prs_merged_in_the_window_with_their_repository() {
    let v = json!([
        {"number": 12, "title": "Add the wrapped card", "url": "https://github.com/acme/app/pull/12", "mergedAt": "2026-10-27T10:00:00Z"},
        {"number": 9, "title": "Before the window", "url": "https://github.com/acme/app/pull/9", "mergedAt": "2026-10-25T23:59:59Z"},
        {"number": 30, "url": "https://ghe.example.com/team/svc/pull/30", "mergedAt": "2026-10-28T08:00:00Z"},
        {"number": 31, "title": "Unmerged", "url": "https://github.com/acme/app/pull/31", "mergedAt": null}
    ]);
    let since = "2026-10-26T00:00:00Z".parse::<jiff::Timestamp>().unwrap().as_millisecond();
    let until = since + 7 * 24 * H;
    let prs = parse_prs(&v, since, until);
    let got: Vec<(u64, &str, &str)> = prs.iter().map(|p| (p.number, p.repo.as_str(), p.title.as_str())).collect();
    assert_eq!(got, vec![(12, "acme/app", "Add the wrapped card"), (30, "team/svc", "")]);
}

#[test]
fn gh_failures_are_told_apart() {
    assert_eq!(pr_failure("none of the git remotes configured for this repository point to a known GitHub host"), PrOutcome::NotGitHub);
    assert_eq!(pr_failure("To get started with GitHub CLI, please run:  gh auth login"), PrOutcome::SignedOut);
    assert_eq!(pr_failure("HTTP 502: bad gateway"), PrOutcome::Failed("HTTP 502: bad gateway".into()));
}

fn pr(url: &str, merged_at: i64) -> WrappedPr {
    WrappedPr { url: url.into(), number: 1, title: String::new(), repo: String::new(), merged_at }
}

#[test]
fn pull_requests_merge_across_repositories_and_say_what_is_missing() {
    // Two worktree folders of one repository found separately answer the same pull requests.
    let (prs, note) = merge_prs(vec![
        ("app".into(), PrOutcome::Merged(vec![pr("u/1", 10), pr("u/2", 30)])),
        ("app2".into(), PrOutcome::Merged(vec![pr("u/2", 30), pr("u/3", 20)])),
        ("notes".into(), PrOutcome::NotGitHub),
    ]);
    let urls: Vec<String> = prs.unwrap().into_iter().map(|p| p.url).collect();
    assert_eq!(urls, vec!["u/2", "u/3", "u/1"], "newest first, once each");
    assert_eq!(note, None);

    let (prs, note) = merge_prs(vec![("app".into(), PrOutcome::Merged(vec![pr("u/1", 10)])), ("svc".into(), PrOutcome::Failed("HTTP 502".into()))]);
    assert_eq!(prs.map(|p| p.len()), Some(1), "what GitHub answered still counts");
    assert_eq!(note.as_deref(), Some("GitHub did not answer for svc."));

    let (prs, note) = merge_prs(vec![("app".into(), PrOutcome::NoGh)]);
    assert_eq!(prs, None);
    assert!(note.unwrap().contains("not installed"));
    let (prs, note) = merge_prs(vec![("app".into(), PrOutcome::SignedOut)]);
    assert_eq!(prs, None);
    assert!(note.unwrap().contains("gh auth login"));
    let (prs, note) = merge_prs(vec![("notes".into(), PrOutcome::NotGitHub)]);
    assert_eq!(prs, None);
    assert!(note.unwrap().contains("on GitHub"));
    assert_eq!(merge_prs(vec![]), (Some(vec![]), None), "no repository: none merged");
}

fn run(at: i64, status: AutomationRunStatus) -> AutomationRun {
    AutomationRun {
        id: format!("r{at}"),
        automation_id: "nightly".into(),
        at,
        trigger: AutomationTrigger::Schedule,
        status,
        agent_id: None,
        workspace_id: None,
        branch: None,
        path: None,
        error: None,
    }
}

#[test]
fn automation_runs_that_started_an_agent_in_the_window() {
    let runs = [run(5, AutomationRunStatus::Started), run(10, AutomationRunStatus::Started), run(12, AutomationRunStatus::Failed), run(15, AutomationRunStatus::Skipped), run(20, AutomationRunStatus::Started)];
    assert_eq!(count_runs(&runs, 10, 20), 1);
    assert_eq!(count_runs(&runs, 0, 21), 3);
}

#[test]
fn window_end_is_never_in_the_future() {
    assert_eq!(window_end(100, None, 500), 500);
    assert_eq!(window_end(100, Some(300), 500), 300);
    assert_eq!(window_end(100, Some(900), 500), 500, "this week, asked with next Monday as its end");
    assert_eq!(window_end(100, Some(50), 500), 500, "an end before the start is ignored");
}

#[test]
fn work_dirs_are_absolute_and_unique() {
    let dirs = work_dirs(vec![Some("/w/app".into()), None, Some("relative".into()), Some("/w/app".into()), Some(" /w/svc ".into())]);
    assert_eq!(dirs, vec![PathBuf::from("/w/app"), PathBuf::from("/w/svc")]);
}

#[test]
fn models_with_an_output_rate_and_the_crew_by_steps() {
    let models = models_from(&[
        UsageModelStat { provider: "anthropic".into(), model: "fast".into(), stat: stat(40, 9_000, 4_000.0, 40) },
        UsageModelStat { provider: "openai".into(), model: "no-durations".into(), stat: stat(10, 1_000, 0.0, 0) },
    ]);
    assert_eq!(models.len(), 1);
    assert_eq!((models[0].model.as_str(), models[0].tps, models[0].tps_n, models[0].requests), ("fast", 4_000.0, 40, 40));

    let crew = crew_from(&[
        UsageKeyStat { key: "Explore".into(), stat: stat(30, 5_000, 0.0, 0) },
        UsageKeyStat { key: String::new(), stat: stat(500, 50_000, 0.0, 0) },
        UsageKeyStat { key: "Worker".into(), stat: stat(90, 2_000, 0.0, 0) },
        UsageKeyStat { key: "Scout".into(), stat: stat(30, 9_000, 0.0, 0) },
    ]);
    let names: Vec<&str> = crew.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, vec!["Worker", "Scout", "Explore"], "most steps first, then output; the folded rest is no subagent");
}

fn git(dir: &Path, args: &[&str], date: &str) {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_DATE", date)
        .env("GIT_COMMITTER_DATE", date)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env_remove("GIT_AUTHOR_NAME")
        .env_remove("GIT_AUTHOR_EMAIL")
        .env_remove("GIT_COMMITTER_NAME")
        .env_remove("GIT_COMMITTER_EMAIL")
        .output()
        .expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

/// End to end on a real repository: a worktree's branch counts, the lock file and the teammate's
/// commit do not, and the window bounds by commit time.
#[tokio::test]
async fn gathers_commits_from_every_worktree_of_a_repository() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("app");
    std::fs::create_dir(&repo).unwrap();
    let old = "2026-10-20T12:00:00Z";
    let inside = "2026-10-27T12:00:00Z";
    git(&repo, &["init", "-q", "-b", "main"], old);
    git(&repo, &["config", "user.email", "me@example.com"], old);
    git(&repo, &["config", "user.name", "Me"], old);
    std::fs::write(repo.join("a.txt"), "1\n2\n").unwrap();
    git(&repo, &["add", "."], old);
    git(&repo, &["commit", "-q", "-m", "before the week"], old);
    let wt = tmp.path().join("app-feature");
    git(&repo, &["worktree", "add", "-q", "-b", "feature", wt.to_str().unwrap()], old);
    std::fs::write(wt.join("b.txt"), "x\ny\nz\n").unwrap();
    std::fs::write(wt.join("Cargo.lock"), "pinned\n".repeat(50)).unwrap();
    git(&wt, &["add", "."], inside);
    git(&wt, &["commit", "-q", "-m", "agent work"], inside);
    std::fs::write(repo.join("c.txt"), "t\n").unwrap();
    git(&repo, &["add", "."], inside);
    git(&repo, &["-c", "user.email=them@example.com", "commit", "-q", "-m", "teammate"], inside);

    let since = "2026-10-26T00:00:00Z".parse::<jiff::Timestamp>().unwrap().as_millisecond();
    let until = since + 7 * 24 * H;
    let key = super::code::Key { session: format!("test-{}", tmp.path().display()), since, until: Some(until) };
    let facts = super::code::facts(key, vec![repo.clone(), wt.clone(), tmp.path().join("gone")], false, Default::default()).await.expect("gathered within the wait");
    assert_eq!(facts.code.repos.len(), 1, "both folders are one repository");
    assert_eq!(facts.code.repos[0].name, "app");
    let got: Vec<(u32, u32)> = facts.code.commits.iter().map(|c| (c.added, c.removed)).collect();
    assert_eq!(got, vec![(3, 0)], "the worktree's commit, without Cargo.lock; not the teammate's, not last week's");
}
