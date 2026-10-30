//! Preflight verdicts, the source's patch and the target's plan with its rollback, against real
//! git repositories (a bare remote, the source's clone, the target's clone).

use std::path::{Path, PathBuf};

use tf_proto::model::{HerdrState, ThinkingLevel};
use tf_proto::{MoveCheckout, MoveGit, MoveIssue, MoveIssueLevel, MoveRepo, ParkedMove, ParkedMoveState};

use super::facts::{self, GitFacts, RemoteBranch, SessionStats, Subject};
use super::source::write_changes;
use super::target::{self, apply_patch, prepare_branch, prepare_holder, undo_all, Undo};
use crate::ops::git::tests::sh;
use crate::state::persist::{ParkedRecord, ParkedWorktree};

fn codes(issues: &[MoveIssue]) -> Vec<(&str, MoveIssueLevel)> {
    issues.iter().map(|i| (i.code.as_str(), i.level)).collect()
}

fn idle() -> Subject {
    Subject {
        agent_id: "t1".into(),
        name: "fixer".into(),
        kind: "omp".into(),
        session_file: Some("/s/a.jsonl".into()),
        state: Some(HerdrState::Idle),
        thinking: Some(ThinkingLevel::High),
        ..Default::default()
    }
}

fn mark(state: ParkedMoveState) -> ParkedMove {
    ParkedMove { state, move_id: "mv_1".into(), to: "build".into(), host_id: None, agent_id: None, at: 1 }
}

#[test]
fn agent_preflight() {
    use MoveIssueLevel::{Blocker, Warning};
    assert!(facts::agent_issues(&idle(), Some("18.13.3")).is_empty());
    let busy = Subject { state: Some(HerdrState::Working), needs: true, subagents_live: 2, queued: 1, ..idle() };
    assert_eq!(
        codes(&facts::agent_issues(&busy, Some("18.13.3"))),
        [("notIdle", Blocker), ("needsYou", Blocker), ("subagentsRunning", Blocker), ("queued", Blocker)]
    );
    // Idle between turns, but a background job runs (closing the pane would end it) or a retry waits.
    let jobs = Subject { jobs_running: 1, ..idle() };
    assert_eq!(codes(&facts::agent_issues(&jobs, None)), [("jobsRunning", Blocker)]);
    let retry = Subject { retry_pending: true, ..idle() };
    assert_eq!(codes(&facts::agent_issues(&retry, None)), [("retryPending", Warning)]);
    let other = Subject { kind: "claude".into(), session_file: None, ..idle() };
    assert_eq!(codes(&facts::agent_issues(&other, Some("18.9.0"))), [("notOmp", Blocker), ("noSession", Blocker), ("ompTooOld", Blocker)]);
    // Parked agents are idle by definition; their move mark decides.
    let parked = |m: Option<ParkedMove>| Subject {
        parked: Some(ParkedRecord { agent_id: "t1".into(), moved: m, ..Default::default() }),
        state: None,
        ..idle()
    };
    assert!(facts::agent_issues(&parked(None), None).is_empty());
    assert_eq!(codes(&facts::agent_issues(&parked(Some(mark(ParkedMoveState::Moving))), None)), [("moving", Blocker)]);
    assert_eq!(codes(&facts::agent_issues(&parked(Some(mark(ParkedMoveState::Moved))), None)), [("alreadyMoved", Blocker)]);
    assert_eq!(codes(&facts::agent_issues(&parked(Some(mark(ParkedMoveState::Interrupted))), None)), [("interrupted", Warning)]);
    let err = facts::blocked(&facts::agent_issues(&busy, None)).unwrap();
    assert_eq!((err.code.as_str(), err.message.as_str()), ("move_blocked", "fixer is working"));
}

fn facts_ok() -> GitFacts {
    GitFacts {
        top: "/w/app".into(),
        root: "/w/app".into(),
        branch: Some("feat".into()),
        head: Some("abc".into()),
        remote: Some("origin".into()),
        remote_url: Some("git@host:org/app.git".into()),
        remote_branch: RemoteBranch::Tracking { ahead: 2, behind: 0 },
        default_branch: Some("main".into()),
        push: Some(Ok(())),
        ..Default::default()
    }
}

#[test]
fn code_preflight() {
    use MoveIssueLevel::{Blocker, Warning};
    let ok = facts_ok();
    assert!(facts::git_issues(&ok).is_empty());
    assert!(ok.needs_push());
    assert_eq!(ok.to_wire().ahead, Some(2));
    assert!(!GitFacts { remote_branch: RemoteBranch::Tracking { ahead: 0, behind: 3 }, push: None, ..facts_ok() }.needs_push());
    let case = |g: GitFacts| codes(&facts::git_issues(&g)).into_iter().map(|(c, l)| (c.to_string(), l)).collect::<Vec<_>>();
    let one = |c: &str, l| vec![(c.to_string(), l)];
    assert_eq!(case(GitFacts { branch: None, ..facts_ok() }), one("detached", Blocker));
    assert_eq!(case(GitFacts { head: None, ..facts_ok() }), one("noCommits", Blocker));
    assert_eq!(case(GitFacts { remote: None, ..facts_ok() }), one("noRemote", Blocker));
    assert_eq!(case(GitFacts { remote_branch: RemoteBranch::Unreachable("offline".into()), push: None, ..facts_ok() }), one("remoteUnreachable", Blocker));
    assert_eq!(case(GitFacts { remote_branch: RemoteBranch::Tracking { ahead: 1, behind: 1 }, push: None, ..facts_ok() }), one("diverged", Blocker));
    assert_eq!(case(GitFacts { push: Some(Err("protected branch".into())), ..facts_ok() }), one("pushRejected", Blocker));
    assert_eq!(case(GitFacts { branch: Some("main".into()), ..facts_ok() }), one("pushDefault", Warning));
    // in sync with the remote: nothing is pushed, main or not
    assert!(case(GitFacts { branch: Some("main".into()), remote_branch: RemoteBranch::Tracking { ahead: 0, behind: 0 }, push: None, ..facts_ok() }).is_empty());
    assert_eq!(case(GitFacts { dirty: 3, changes_bytes: facts::MAX_CHANGES + 1, ..facts_ok() }), one("changesTooLarge", Blocker));
    assert!(case(GitFacts { dirty: 3, changes_bytes: 1024, ..facts_ok() }).is_empty());
}

#[test]
fn session_sizes() {
    let td = tempfile::tempdir().unwrap();
    let file = td.path().join("2026_x.jsonl");
    std::fs::write(&file, "{\"type\":\"session\"}\n").unwrap();
    let art = td.path().join("2026_x");
    std::fs::create_dir_all(art.join("local")).unwrap();
    std::fs::create_dir_all(art.join("1-Explore")).unwrap();
    std::fs::write(art.join("0-Explore.jsonl"), "x".repeat(100)).unwrap();
    std::fs::write(art.join("1-Explore").join("0-Nested.jsonl"), "y").unwrap();
    std::fs::write(art.join("__advisor-1.jsonl"), "a").unwrap();
    std::fs::write(art.join("local").join("notes.md"), "notes").unwrap();
    let s = facts::session_stats(&file).unwrap();
    assert_eq!(s, SessionStats { bytes: 19 + 100 + 1 + 1 + 5, artifact_files: 4, subagent_transcripts: 2 });
    assert!(facts::session_issues("x", Some("f"), &Ok(s)).is_empty());
    let huge = SessionStats { bytes: facts::MAX_SESSION + 1, ..s };
    assert_eq!(codes(&facts::session_issues("x", Some("f"), &Ok(huge))), [("tooLarge", MoveIssueLevel::Blocker)]);
    let gone = facts::session_stats(&td.path().join("nope.jsonl"));
    assert_eq!(codes(&facts::session_issues("x", Some("f"), &gone)), [("noSession", MoveIssueLevel::Blocker)]);
    assert_eq!(facts::bytes(1536), "1.5 KB");
    assert_eq!(facts::bytes(300 << 20), "300 MB");
}

#[test]
fn status_paths() {
    let raw = b" M a.txt\0R  moved.txt\0old.txt\0?? untracked.md\0A  staged.txt\0";
    assert_eq!(facts::changed_paths(raw), ["a.txt", "moved.txt", "untracked.md", "staged.txt"]);
}

fn repo_of(path: &str, checkout: MoveCheckout, blocked: bool) -> MoveRepo {
    let issues = if blocked {
        vec![MoveIssue { level: MoveIssueLevel::Blocker, code: "dirtyCheckout".into(), message: String::new(), hint: None }]
    } else {
        Vec::new()
    };
    MoveRepo { path: path.into(), remote: "origin".into(), remote_url: "u".into(), checkout, checkout_path: None, branch_exists: false, issues }
}

#[test]
fn clone_ranking_and_paths() {
    let mut repos = vec![
        repo_of("/other", MoveCheckout::NewWorktree, false),
        repo_of("/blocked", MoveCheckout::Existing, true),
        repo_of("/src/app", MoveCheckout::NewWorktree, false),
        repo_of("/holder", MoveCheckout::Existing, false),
    ];
    facts::rank(&mut repos, "/src/app");
    let order: Vec<&str> = repos.iter().map(|r| r.path.as_str()).collect();
    assert_eq!(order, ["/holder", "/src/app", "/other", "/blocked"]);

    let home = tempfile::tempdir().unwrap();
    let g = MoveGit {
        repo_root: "/nowhere/at/all/app".into(),
        repo_name: "app".into(),
        top: String::new(),
        subdir: String::new(),
        branch: "feat".into(),
        head: "abc".into(),
        remote: "origin".into(),
        remote_url: "git@h:o/app.git".into(),
        ahead: None,
        dirty: 0,
        default_branch: None,
        linked: false,
    };
    assert_eq!(facts::clone_path(home.path(), &g), home.path().join("app"));
    std::fs::create_dir(home.path().join("src")).unwrap();
    assert_eq!(facts::clone_path(home.path(), &g), home.path().join("src").join("app"));
    std::fs::create_dir(home.path().join("src").join("app")).unwrap();
    assert_eq!(facts::clone_path(home.path(), &g), home.path().join("app"));
    std::fs::create_dir(home.path().join("app")).unwrap();
    assert_eq!(facts::clone_path(home.path(), &g), home.path().join("app-2"));
    // the source's own layout wins when its parent exists here
    let same = home.path().join("work");
    std::fs::create_dir(&same).unwrap();
    let g2 = MoveGit { repo_root: same.join("app").display().to_string(), ..g };
    assert_eq!(facts::clone_path(home.path(), &g2), same.join("app"));
}

#[test]
fn stale_checkouts_are_those_agents_moved_away_from() {
    let td = tempfile::tempdir().unwrap();
    let wt = td.path().join("wt");
    std::fs::create_dir_all(wt.join("sub")).unwrap();
    let rec = |m: Option<ParkedMove>, cwd: &Path| ParkedRecord {
        agent_id: "a".into(),
        cwd: Some(cwd.display().to_string()),
        worktree: None,
        moved: m,
        ..Default::default()
    };
    let moved = [rec(Some(mark(ParkedMoveState::Moved)), &wt)];
    let stale = facts::stale_checkouts(&moved);
    assert!(facts::is_stale(&wt, &stale));
    assert!(!facts::is_stale(&td.path().join("other"), &stale));
    // a parked folder inside a checkout does not make the whole checkout stale (its changes may be yours)
    assert!(!facts::is_stale(&wt, &facts::stale_checkouts(&[rec(Some(mark(ParkedMoveState::Moved)), &wt.join("sub"))])));
    // only a finished move makes them stale
    assert!(facts::stale_checkouts(&[rec(Some(mark(ParkedMoveState::Interrupted)), &wt)]).is_empty());
    assert!(facts::stale_checkouts(&[rec(None, &wt)]).is_empty());
    let with_wt = ParkedRecord { worktree: Some(ParkedWorktree { path: wt.display().to_string(), repo_root: String::new() }), cwd: None, ..moved[0].clone() };
    assert!(facts::is_stale(&wt, &facts::stale_checkouts(&[with_wt])));
}

#[test]
fn live_agents_in_a_checkout_are_found_by_folder() {
    let td = tempfile::tempdir().unwrap();
    let wt = td.path().join("wt");
    std::fs::create_dir_all(wt.join("sub")).unwrap();
    let live = [("in".to_string(), wt.join("sub")), ("out".to_string(), td.path().join("wt-2"))];
    assert_eq!(facts::occupants(&live, &wt), ["in"]);
    assert!(facts::occupants(&live, &td.path().join("other")).is_empty());
}

#[tokio::test]
async fn a_clone_only_removes_what_it_made() {
    let td = tempfile::tempdir().unwrap();
    // A folder that appeared meanwhile is never touched.
    let theirs = td.path().join("theirs");
    std::fs::create_dir(&theirs).unwrap();
    std::fs::write(theirs.join("keep.txt"), "mine\n").unwrap();
    assert_eq!(target::claim_dir(&theirs).unwrap_err().code, "already_exists");
    assert!(theirs.join("keep.txt").exists());
    // A failed clone takes its own folder away again.
    let ours = td.path().join("ours");
    target::claim_dir(&ours).unwrap();
    assert!(target::clone(&ours, &td.path().join("no-such-repo").display().to_string()).await.is_err());
    assert!(!ours.exists());
    // An address git would read as an option is refused before git runs.
    let other = td.path().join("other");
    target::claim_dir(&other).unwrap();
    assert_eq!(target::clone(&other, "--upload-pack=touch /tmp/x").await.unwrap_err().code, "invalid_params");
    assert!(facts::remote_is_option("-oProxyCommand=x") && !facts::remote_is_option("git@github.com:o/r.git"));
}

// ───────────────────────────── real repositories ─────────────────────────────

/// A bare remote with `main`, the source's clone (`a`) and the target's clone (`b`).
struct Lab {
    _td: tempfile::TempDir,
    remote: PathBuf,
    a: PathBuf,
    b: PathBuf,
}

fn git_out(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git").args(args).current_dir(dir).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn lab() -> Lab {
    let td = tempfile::tempdir().unwrap();
    let remote = td.path().join("remote.git");
    let (a, b) = (td.path().join("a"), td.path().join("b"));
    sh(td.path(), &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
    std::fs::create_dir(&a).unwrap();
    sh(&a, &["init", "-q", "-b", "main"]);
    sh(&a, &["config", "user.name", "t"]);
    sh(&a, &["config", "user.email", "t@t"]);
    std::fs::write(a.join("a.txt"), "one\ntwo\n").unwrap();
    std::fs::write(a.join("old.txt"), "keep me\n").unwrap();
    std::fs::write(a.join("gone.txt"), "delete me\n").unwrap();
    std::fs::write(a.join(".gitignore"), "target/\n").unwrap();
    sh(&a, &["add", "."]);
    sh(&a, &["commit", "-q", "-m", "init"]);
    sh(&a, &["remote", "add", "origin", remote.to_str().unwrap()]);
    sh(&a, &["push", "-q", "-u", "origin", "main"]);
    sh(td.path(), &["clone", "-q", remote.to_str().unwrap(), b.to_str().unwrap()]);
    sh(&b, &["config", "user.name", "t"]);
    sh(&b, &["config", "user.email", "t@t"]);
    Lab { _td: td, remote, a, b }
}

/// The source's agent worked on `feat`: one commit, then uncommitted changes of every kind.
fn work_on_feat(a: &Path) {
    sh(a, &["checkout", "-q", "-b", "feat"]);
    std::fs::write(a.join("a.txt"), "one\n2\n").unwrap();
    sh(a, &["commit", "-q", "-am", "feat work"]);
    std::fs::write(a.join("a.txt"), "one\n2\nthree\n").unwrap();
    std::fs::write(a.join("staged.txt"), "s\n").unwrap();
    sh(a, &["add", "staged.txt"]);
    sh(a, &["mv", "old.txt", "moved.txt"]);
    std::fs::remove_file(a.join("gone.txt")).unwrap();
    std::fs::write(a.join("untracked.md"), "u1\nu2\n").unwrap();
    std::fs::write(a.join("blob.bin"), [0u8, 159, 146, 150, 255, 0, 1]).unwrap();
    std::fs::create_dir(a.join("target")).unwrap();
    std::fs::write(a.join("target").join("ignored.o"), "build output").unwrap();
}

fn wire(g: &GitFacts) -> MoveGit {
    g.to_wire()
}

/// Files of a checkout, `.git` and ignored output aside: path → bytes.
fn tree(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).unwrap().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name == ".git" || name == "target" {
                continue;
            }
            if e.file_type().unwrap().is_dir() {
                stack.push(e.path());
            } else {
                out.push((e.path().strip_prefix(dir).unwrap().display().to_string(), std::fs::read(e.path()).unwrap()));
            }
        }
    }
    out.sort();
    out
}

#[tokio::test]
async fn source_facts_from_a_real_checkout() {
    let lab = lab();
    work_on_feat(&lab.a);
    std::fs::create_dir(lab.a.join("sub")).unwrap();
    let g = facts::git_facts(&lab.a.join("sub"), true).await.unwrap().unwrap();
    assert_eq!((g.branch.as_deref(), g.remote.as_deref(), g.subdir.as_str(), g.linked), (Some("feat"), Some("origin"), "sub", false));
    assert_eq!(g.remote_url.as_deref(), Some(lab.remote.to_str().unwrap()));
    assert_eq!(g.head.as_deref(), Some(git_out(&lab.a, &["rev-parse", "HEAD"]).as_str()));
    // the remote has no feat yet: all of it is pushed, and a dry run says it would work
    assert_eq!(g.remote_branch, RemoteBranch::Missing);
    assert_eq!(g.push, Some(Ok(())));
    // a.txt, staged.txt, the rename, gone.txt, untracked.md, blob.bin (target/ is ignored)
    assert_eq!(g.dirty, 6);
    assert!(g.changes_bytes > 0);
    assert_eq!(g.default_branch.as_deref(), Some("main"));
    assert!(facts::git_issues(&g).is_empty(), "{:?}", facts::git_issues(&g));
    assert_eq!(g.ahead(), None);

    // pushed: in sync, nothing to push
    sh(&lab.a, &["push", "-q", "-u", "origin", "feat"]);
    let g = facts::git_facts(&lab.a, true).await.unwrap().unwrap();
    assert_eq!(g.remote_branch, RemoteBranch::Tracking { ahead: 0, behind: 0 });
    assert!(!g.needs_push());
    assert_eq!(g.push, None);

    // someone else pushed to feat meanwhile, and the agent committed too: diverged
    sh(&lab.b, &["fetch", "-q", "origin"]);
    sh(&lab.b, &["checkout", "-q", "-b", "feat", "origin/feat"]);
    std::fs::write(lab.b.join("b.txt"), "theirs\n").unwrap();
    sh(&lab.b, &["add", "b.txt"]);
    sh(&lab.b, &["commit", "-q", "-m", "theirs"]);
    sh(&lab.b, &["push", "-q", "origin", "feat"]);
    sh(&lab.a, &["commit", "-q", "-am", "mine"]);
    let g = facts::git_facts(&lab.a, true).await.unwrap().unwrap();
    assert_eq!(g.remote_branch, RemoteBranch::Tracking { ahead: 1, behind: 1 });
    assert_eq!(codes(&facts::git_issues(&g)), [("diverged", MoveIssueLevel::Blocker)]);

    // a folder outside any repository: only the conversation moves
    let plain = tempfile::tempdir().unwrap();
    assert!(facts::git_facts(plain.path(), false).await.unwrap().is_none());
}

#[tokio::test]
async fn the_changes_patch_recreates_the_working_tree_and_rolls_back() {
    let lab = lab();
    work_on_feat(&lab.a);
    sh(&lab.a, &["push", "-q", "-u", "origin", "feat"]);
    let index_before = std::fs::read(lab.a.join(".git").join("index")).unwrap();
    let g = facts::git_facts(&lab.a, true).await.unwrap().unwrap();
    let staging = tempfile::tempdir().unwrap();
    let (part, patch) = write_changes(&g.top, g.head.as_deref().unwrap(), staging.path()).await.unwrap().unwrap();
    assert_eq!((part.name.as_str(), part.size), ("changes", std::fs::metadata(&patch).unwrap().len()));
    assert_eq!(part.sha256.len(), 64);
    // the source's checkout and index are untouched; the temporary index is gone
    assert_eq!(std::fs::read(lab.a.join(".git").join("index")).unwrap(), index_before);
    assert!(!staging.path().join("changes.index").exists());

    // the target: fetch, a new branch at the source's head, a worktree, the patch
    let mg = wire(&g);
    target::fetch(&lab.b, "origin", &mg).await.unwrap();
    let mut undo = Vec::new();
    prepare_branch(&lab.b, "origin", &mg, &mut undo).await.unwrap();
    assert_eq!(undo, [Undo::DeleteBranch { repo: lab.b.display().to_string(), branch: "feat".into(), sha: mg.head.clone() }]);
    assert_eq!(git_out(&lab.b, &["rev-parse", "--abbrev-ref", "feat@{upstream}"]), "origin/feat");
    let wt = lab.b.parent().unwrap().join("b-feat");
    sh(&lab.b, &["worktree", "add", "-q", wt.to_str().unwrap(), "feat"]);
    undo.push(Undo::RemoveWorktree { repo: lab.b.display().to_string(), path: wt.display().to_string(), workspace_id: None });
    apply_patch(&wt, &patch).await.unwrap();
    undo.push(Undo::RevertPatch { path: wt.display().to_string(), patch: patch.display().to_string() });
    assert_eq!(tree(&wt), tree(&lab.a), "the target's checkout equals the source's working tree");

    // rollback, newest first: nothing of the move is left on the target
    assert!(undo_all(None, &undo).await.is_empty());
    assert!(!wt.exists());
    assert!(git_out(&lab.b, &["branch", "--list", "feat"]).is_empty());
    assert_eq!(git_out(&lab.b, &["worktree", "list", "--porcelain"]).matches("worktree ").count(), 1);
}

#[tokio::test]
async fn an_existing_checkout_fast_forwards_and_rolls_back() {
    let lab = lab();
    let old = git_out(&lab.b, &["rev-parse", "HEAD"]);
    std::fs::write(lab.a.join("a.txt"), "one\ntwo\nthree\n").unwrap();
    sh(&lab.a, &["commit", "-q", "-am", "more on main"]);
    let head = git_out(&lab.a, &["rev-parse", "HEAD"]);
    sh(&lab.a, &["push", "-q", "origin", "main"]);
    let g = MoveGit { branch: "main".into(), head: head.clone(), ..wire(&facts::git_facts(&lab.a, false).await.unwrap().unwrap()) };
    target::fetch(&lab.b, "origin", &g).await.unwrap();

    // b holds main in its main checkout, clean: fast-forwarded in place
    let mut undo = Vec::new();
    let busy = [("idler".to_string(), lab.b.join("sub"))];
    // An agent working in that checkout is not moved under: nothing changes.
    let err = prepare_holder(&lab.b, &lab.b, &g, "fixer", &[], &busy, &mut Vec::new()).await.unwrap_err();
    assert_eq!(err.code, "agent_in_checkout");
    assert_eq!(git_out(&lab.b, &["rev-parse", "HEAD"]), old);
    prepare_holder(&lab.b, &lab.b, &g, "fixer", &[], &[], &mut undo).await.unwrap();
    assert_eq!(git_out(&lab.b, &["rev-parse", "HEAD"]), head);
    assert_eq!(undo, [Undo::ResetCheckout { path: lab.b.display().to_string(), old: old.clone(), new: head.clone() }]);
    assert!(undo_all(None, &undo).await.is_empty());
    assert_eq!(git_out(&lab.b, &["rev-parse", "HEAD"]), old);
    assert_eq!(std::fs::read_to_string(lab.b.join("a.txt")).unwrap(), "one\ntwo\n");

    // uncommitted work there stops it, untouched…
    std::fs::write(lab.b.join("mine.txt"), "wip\n").unwrap();
    let mut undo = Vec::new();
    let err = prepare_holder(&lab.b, &lab.b, &g, "fixer", &[], &[], &mut undo).await.unwrap_err();
    assert_eq!(err.code, "dirty_checkout");
    assert!(undo.is_empty());
    assert_eq!(git_out(&lab.b, &["rev-parse", "HEAD"]), old);
    // …unless an agent moved away from that checkout: then its leftovers are stale, stashed,
    // and come back on rollback
    prepare_holder(&lab.b, &lab.b, &g, "fixer", &[lab.b.clone()], &[], &mut undo).await.unwrap();
    assert!(!lab.b.join("mine.txt").exists());
    assert_eq!(git_out(&lab.b, &["rev-parse", "HEAD"]), head);
    assert!(matches!(undo.as_slice(), [Undo::StashPop { .. }, Undo::ResetCheckout { .. }]));
    assert!(undo_all(None, &undo).await.is_empty());
    assert_eq!(std::fs::read_to_string(lab.b.join("mine.txt")).unwrap(), "wip\n");
    assert_eq!(git_out(&lab.b, &["rev-parse", "HEAD"]), old);

    // a checkout with commits of its own cannot take the move
    std::fs::remove_file(lab.b.join("mine.txt")).unwrap();
    std::fs::write(lab.b.join("b.txt"), "local\n").unwrap();
    sh(&lab.b, &["add", "b.txt"]);
    sh(&lab.b, &["commit", "-q", "-m", "local"]);
    let mut undo = Vec::new();
    assert_eq!(prepare_holder(&lab.b, &lab.b, &g, "fixer", &[], &[], &mut undo).await.unwrap_err().code, "branch_diverged");
    assert!(undo.is_empty());
}

#[tokio::test]
async fn a_local_branch_fast_forwards_or_refuses() {
    let lab = lab();
    sh(&lab.a, &["checkout", "-q", "-b", "feat"]);
    sh(&lab.a, &["push", "-q", "-u", "origin", "feat"]);
    // b has feat at the old commit (not checked out)
    sh(&lab.b, &["fetch", "-q", "origin"]);
    sh(&lab.b, &["branch", "feat", "origin/feat"]);
    let old = git_out(&lab.b, &["rev-parse", "feat"]);
    std::fs::write(lab.a.join("a.txt"), "new\n").unwrap();
    sh(&lab.a, &["commit", "-q", "-am", "new"]);
    sh(&lab.a, &["push", "-q", "origin", "feat"]);
    let g = wire(&facts::git_facts(&lab.a, false).await.unwrap().unwrap());
    target::fetch(&lab.b, "origin", &g).await.unwrap();
    let mut undo = Vec::new();
    prepare_branch(&lab.b, "origin", &g, &mut undo).await.unwrap();
    assert_eq!(git_out(&lab.b, &["rev-parse", "feat"]), g.head);
    assert!(undo_all(None, &undo).await.is_empty());
    assert_eq!(git_out(&lab.b, &["rev-parse", "feat"]), old);

    // b's feat has a commit of its own: refused, nothing changed
    sh(&lab.b, &["checkout", "-q", "feat"]);
    std::fs::write(lab.b.join("b.txt"), "local\n").unwrap();
    sh(&lab.b, &["add", "b.txt"]);
    sh(&lab.b, &["commit", "-q", "-m", "local"]);
    sh(&lab.b, &["checkout", "-q", "main"]);
    let mine = git_out(&lab.b, &["rev-parse", "feat"]);
    let mut undo = Vec::new();
    assert_eq!(prepare_branch(&lab.b, "origin", &g, &mut undo).await.unwrap_err().code, "branch_diverged");
    assert!(undo.is_empty());
    assert_eq!(git_out(&lab.b, &["rev-parse", "feat"]), mine);

    // a head the remote never got: the fetch says so
    let missing = MoveGit { head: "0123456789abcdef0123456789abcdef01234567".into(), ..g };
    assert_eq!(target::fetch(&lab.b, "origin", &missing).await.unwrap_err().code, "head_missing");
}

#[tokio::test]
async fn rollback_removes_an_unpacked_session_and_a_clone() {
    let td = tempfile::tempdir().unwrap();
    let file = td.path().join("2026_x.jsonl");
    std::fs::write(&file, "{}\n").unwrap();
    std::fs::create_dir_all(td.path().join("2026_x").join("local")).unwrap();
    let clone = td.path().join("clone");
    std::fs::create_dir_all(clone.join(".git")).unwrap();
    let undo = [Undo::RemoveClone { path: clone.display().to_string() }, Undo::RemoveSession { file: file.display().to_string() }];
    assert!(undo_all(None, &undo).await.is_empty());
    assert!(!file.exists() && !td.path().join("2026_x").exists() && !clone.exists());
    // undoing twice (a restart mid-rollback) is fine
    assert!(undo_all(None, &undo).await.is_empty());
    // a patch that is gone is reported, not fatal
    let notes = undo_all(None, &[Undo::RevertPatch { path: td.path().display().to_string(), patch: "/nope.patch".into() }]).await;
    assert_eq!(notes.len(), 1);
    // the journal format is stable JSON
    let json = serde_json::to_value(Undo::RemoveWorktree { repo: "/r".into(), path: "/w".into(), workspace_id: Some("w1".into()) }).unwrap();
    assert_eq!(json, serde_json::json!({ "op": "removeWorktree", "repo": "/r", "path": "/w", "workspaceId": "w1" }));
}

// ───────────────────── the launch boundary of a receive (target.json) ─────────────────────

mod launch_boundary {
    use std::time::Duration;

    use tf_proto::model::Agent;
    use tf_proto::{ApiError, MovePhase, MoveRole, MoveStatus, MoveStep, MoveStepState};

    use super::super::target::{
        expired, finish_recovered, judge, load, reconcile, refused, retry_commit, seen, settle_once, write_journal, write_status, Journal, Launching, Observed, Undo, Upload, Verdict,
    };
    use crate::util::now_ms;

    const LONG_AGO: i64 = 1_000;

    fn launching(dir: &std::path::Path, at: i64) -> Launching {
        Launching {
            at,
            name: "scout".into(),
            session_file: dir.join("sess.jsonl").display().to_string(),
            session_len: 3,
            cwd: dir.join("wt").display().to_string(),
            from: "laptop".into(),
        }
    }

    fn status() -> MoveStatus {
        MoveStatus {
            move_id: "m1".into(),
            role: MoveRole::Target,
            phase: MovePhase::Running,
            steps: vec![MoveStep { id: "start".into(), label: "Resume scout".into(), state: MoveStepState::Running, detail: None }],
            parts: Vec::new(),
            source: None,
            agent_id: None,
            session_file: None,
            cwd: None,
            error: None,
            notes: Vec::new(),
            started_at: 1,
            updated_at: 1,
        }
    }

    fn agent(id: &str, name: &str, file: Option<&str>, cwd: Option<&str>, parked: bool) -> Agent {
        let mut v = serde_json::json!({
            "id": id, "name": name, "kind": "omp", "paneId": "", "tabId": "", "workspaceId": "",
            "state": "idle", "stateSince": 0, "column": "review", "archived": false, "turns": 0, "title": "t",
            "omp": { "link": "live", "bridge": true, "fast": false, "mode": "normal", "queue": { "steering": [], "followUp": [] } },
            "live": { "streaming": false, "thinking": false, "line": "" },
        });
        if let Some(f) = file {
            v["omp"]["sessionFile"] = f.into();
        }
        if let Some(c) = cwd {
            v["cwd"] = c.into();
        }
        if parked {
            v["parked"] = serde_json::json!({ "at": 0, "sessionFile": file.unwrap_or("") });
        }
        serde_json::from_value(v).unwrap()
    }

    /// What a crashed receive leaves: a clone, an unpacked session (with the size it had when the
    /// launch began), an upload, and the journal naming them.
    struct Crashed {
        _dir: tempfile::TempDir,
        journal: std::path::PathBuf,
        clone: std::path::PathBuf,
        session: std::path::PathBuf,
        upload: std::path::PathBuf,
    }

    fn crashed(launch: bool, at: i64) -> Crashed {
        let dir = tempfile::tempdir().unwrap();
        let clone = dir.path().join("wt");
        std::fs::create_dir_all(clone.join(".git")).unwrap();
        let session = dir.path().join("sess.jsonl");
        std::fs::write(&session, "{}\n").unwrap();
        let upload = dir.path().join("session.tar.zst");
        std::fs::write(&upload, "x").unwrap();
        let journal = dir.path().join("moves").join("m1").join("target.json");
        let j = Journal {
            herdr_session: "default".into(),
            status: status(),
            undo: vec![Undo::RemoveClone { path: clone.display().to_string() }, Undo::RemoveSession { file: session.display().to_string() }],
            uploads: vec![Upload { id: "u1".into(), path: upload.display().to_string() }],
            launching: launch.then(|| launching(dir.path(), at)),
            at: 1,
        };
        write_journal(&journal, &j).unwrap();
        Crashed { _dir: dir, journal, clone, session, upload }
    }

    /// One look of startup recovery at the journal (what `resolve` does, minus the daemon), against a
    /// fixed board; a journal that never reached the launch boundary is the plain rollback's.
    async fn recover(c: &Crashed, agents: Vec<Agent>, board: bool) -> Journal {
        let j = load(&c.journal).unwrap();
        if j.launching.is_none() {
            finish_recovered(None, &c.journal, j, Verdict::Absent).await.unwrap();
        } else {
            let len = |l: &Launching| std::fs::metadata(&l.session_file).ok().map(|m| m.len());
            settle_once(None, &c.journal, |l| seen(l, &agents, board, len(l)), Duration::from_millis(5)).await.unwrap().unwrap();
        }
        load(&c.journal).unwrap()
    }

    #[test]
    fn judge_prefers_any_sign_of_the_agent_over_absence() {
        let l = launching(std::path::Path::new("/x"), 100_000);
        let board = |o: Observed| Observed { board: true, ..o };
        // the agent is on the board (also right after the launch)
        assert_eq!(judge(&l, &board(Observed { agent: Some("a1".into()), ..Default::default() }), 100_001, false), Some(Verdict::Started { agent_id: Some("a1".into()) }));
        // a launch that is not there yet is waited for until the settle time is over…
        assert_eq!(judge(&l, &board(Observed::default()), 100_001, false), None);
        assert_eq!(judge(&l, &board(Observed::default()), 100_000 + 59_999, false), None);
        // …then it is absent, and only then
        assert_eq!(judge(&l, &board(Observed::default()), 100_000 + 60_000, false), Some(Verdict::Absent));
        // omp wrote to the session: it ran
        assert_eq!(judge(&l, &board(Observed { touched: true, ..Default::default() }), 900_000, false), Some(Verdict::Started { agent_id: None }));
        // another agent works in the folder: undecided, however old
        assert!(matches!(judge(&l, &board(Observed { neighbour: Some("n".into()), ..Default::default() }), 900_000, false), Some(Verdict::Pending(_))));
        // no usable board says nothing: waited for, then undecided — never "absent"
        assert_eq!(judge(&l, &Observed::default(), 900_000, false), None);
        assert!(matches!(judge(&l, &Observed::default(), 900_000, true), Some(Verdict::Pending(_))));
    }

    #[test]
    fn the_board_is_read_by_session_name_and_folder() {
        let l = launching(std::path::Path::new("/x"), 1);
        let f = l.session_file.as_str();
        let seen_of = |agents: &[Agent]| seen(&l, agents, true, Some(l.session_len));
        // its session file
        assert_eq!(seen_of(&[agent("a1", "other", Some(f), None, false)]).agent.as_deref(), Some("a1"));
        // its name while its session is not known yet, or the same
        assert_eq!(seen_of(&[agent("a2", "scout", None, None, false)]).agent.as_deref(), Some("a2"));
        // the same name on another session is somebody else's agent
        assert_eq!(seen_of(&[agent("a3", "scout", Some("/other.jsonl"), None, false)]).agent, None);
        // a parked card of that session counts: the agent ran
        assert_eq!(seen_of(&[agent("a4", "x", Some(f), None, true)]).agent.as_deref(), Some("a4"));
        // a stranger working in its folder cannot be told apart: a neighbour, not the agent
        let o = seen_of(&[agent("a5", "x", None, Some(l.cwd.as_str()), false)]);
        assert_eq!((o.agent, o.neighbour.as_deref()), (None, Some("a5")));
        // the session file's size: unchanged / grown / gone
        assert!(!seen(&l, &[], true, Some(3)).touched);
        assert!(seen(&l, &[], true, Some(4)).touched);
        assert!(!seen(&l, &[], true, None).touched);
    }

    #[tokio::test]
    async fn reconcile_waits_for_a_launch_that_is_not_on_the_board_yet() {
        let l = launching(std::path::Path::new("/x"), now_ms());
        let mut looks = 0;
        let v = reconcile(
            &l,
            || {
                looks += 1;
                Observed { board: true, agent: (looks >= 3).then(|| "late".to_string()), ..Default::default() }
            },
            Duration::from_millis(5),
        )
        .await;
        assert_eq!((v, looks), (Verdict::Started { agent_id: Some("late".into()) }, 3));
    }

    #[tokio::test]
    async fn crash_before_the_launch_boundary_rolls_back() {
        let c = crashed(false, 0);
        let j = recover(&c, vec![], true).await;
        assert_eq!(j.status.phase, MovePhase::Failed);
        assert_eq!(j.status.error.as_ref().unwrap().code, "interrupted");
        assert!(!c.clone.exists() && !c.session.exists() && !c.upload.exists());
        assert!(j.undo.is_empty() && j.uploads.is_empty());
    }

    #[tokio::test]
    async fn crash_after_the_agent_started_finishes_the_move_and_keeps_everything() {
        // hostd died after herdr started the agent and before the result was saved
        let c = crashed(true, now_ms());
        let file = c.session.display().to_string();
        let j = recover(&c, vec![agent("a1", "scout", Some(&file), None, false)], true).await;
        assert_eq!(j.status.phase, MovePhase::Done);
        assert_eq!((j.status.agent_id.as_deref(), j.status.session_file.as_deref()), (Some("a1"), Some(file.as_str())));
        assert_eq!(j.status.cwd.as_deref(), Some(c.clone.to_str().unwrap()));
        assert_eq!(j.status.steps[0].state, MoveStepState::Done);
        assert!(c.clone.exists() && c.session.exists(), "the live agent's folder and session stay");
        assert!(j.undo.is_empty() && j.launching.is_none() && !c.upload.exists());
        // asking again (the journal is Done now) never rolls anything back
        assert_eq!(load(&c.journal).unwrap().status.phase, MovePhase::Done);
    }

    #[tokio::test]
    async fn crash_with_the_agent_found_only_by_name_also_finishes() {
        let c = crashed(true, now_ms());
        let j = recover(&c, vec![agent("a9", "scout", None, None, false)], true).await;
        assert_eq!((j.status.phase, j.status.agent_id.as_deref()), (MovePhase::Done, Some("a9")));
        assert!(c.clone.exists() && c.session.exists());
    }

    #[tokio::test]
    async fn crash_at_the_boundary_with_no_agent_rolls_back_only_after_the_settle_time() {
        // recorded long ago, board built, nothing there, the session untouched: the launch never happened
        let c = crashed(true, LONG_AGO);
        let j = recover(&c, vec![], true).await;
        assert_eq!(j.status.phase, MovePhase::Failed);
        assert_eq!(j.status.error.as_ref().unwrap().code, "interrupted");
        assert!(!c.clone.exists() && !c.session.exists());
        assert!(j.launching.is_none() && j.undo.is_empty());
    }

    #[tokio::test]
    async fn a_session_written_to_without_a_visible_agent_means_it_ran() {
        // omp wrote to the session after the launch began: the move is done (the agent may have ended
        // since); nothing is removed
        let c = crashed(true, LONG_AGO);
        std::fs::write(&c.session, "{}\n{\"turn\":1}\n").unwrap();
        let j = recover(&c, vec![], true).await;
        assert_eq!((j.status.phase, j.status.agent_id), (MovePhase::Done, None));
        assert!(c.clone.exists() && c.session.exists());
    }

    #[tokio::test(start_paused = true)]
    async fn an_unreadable_board_keeps_the_move_confirming_with_the_evidence_and_never_rolls_back() {
        let c = crashed(true, LONG_AGO);
        let j = recover(&c, vec![], false).await;
        // neither done nor failed: clients keep the source parked
        assert_eq!(j.status.phase, MovePhase::Confirming);
        assert!(j.status.error.is_none());
        assert!(j.status.notes.iter().any(|n| n.starts_with("Confirming whether the agent started here:")));
        assert!(j.launching.is_some() && j.undo.len() == 2 && j.uploads.len() == 1, "launch record, undo list and uploads stay");
        assert!(c.clone.exists() && c.session.exists() && c.upload.exists());
        // looked at again: still unreadable → still confirming, the note is not repeated
        let j = recover(&c, vec![], false).await;
        assert_eq!(j.status.phase, MovePhase::Confirming);
        assert_eq!(j.status.notes.iter().filter(|n| n.starts_with("Confirming whether")).count(), 1);
        // a stranger agent in the folder cannot be told from it: still confirming
        let j = recover(&c, vec![agent("n1", "x", None, Some(c.clone.to_str().unwrap()), false)], true).await;
        assert_eq!(j.status.phase, MovePhase::Confirming);
        // the board answers: the agent runs → done, files kept, the confirming note gone
        let file = c.session.display().to_string();
        let j = recover(&c, vec![agent("a1", "scout", Some(&file), None, false)], true).await;
        assert_eq!((j.status.phase, j.status.agent_id.as_deref()), (MovePhase::Done, Some("a1")));
        assert!(j.status.notes.iter().all(|n| !n.starts_with("Confirming whether")));
        assert!(c.clone.exists() && c.session.exists() && !c.upload.exists());
    }

    #[tokio::test(start_paused = true)]
    async fn a_confirming_move_rolls_back_only_when_the_board_shows_no_agent() {
        let c = crashed(true, LONG_AGO);
        assert_eq!(recover(&c, vec![], false).await.status.phase, MovePhase::Confirming);
        // the board is built again and nothing runs there: now it is surely absent
        let j = recover(&c, vec![], true).await;
        assert_eq!(j.status.phase, MovePhase::Failed);
        assert_eq!(j.status.error.as_ref().unwrap().code, "interrupted");
        assert!(!c.clone.exists() && !c.session.exists() && !c.upload.exists());
        assert!(j.launching.is_none() && j.undo.is_empty());
        assert!(j.status.notes.iter().all(|n| !n.starts_with("Confirming whether")));
    }

    #[tokio::test]
    async fn a_finished_or_recordless_journal_has_nothing_to_settle() {
        let c = crashed(true, now_ms());
        let file = c.session.display().to_string();
        recover(&c, vec![agent("a1", "scout", Some(&file), None, false)], true).await;
        // Done now: another pass changes nothing
        assert_eq!(settle_once(None, &c.journal, |_| Observed::default(), Duration::from_millis(1)).await.unwrap(), None);
        // a journal that never reached the boundary is the plain rollback's, not the board's
        let c = crashed(false, 0);
        assert_eq!(settle_once(None, &c.journal, |_| Observed::default(), Duration::from_millis(1)).await.unwrap(), None);
        assert!(c.clone.exists());
    }

    #[test]
    fn an_unresolved_journal_is_never_deleted() {
        let c = crashed(true, LONG_AGO);
        let mut j = load(&c.journal).unwrap();
        let week = 7 * 24 * 3600 * 1000;
        j.at = now_ms() - week;
        for p in [MovePhase::Running, MovePhase::RollingBack, MovePhase::Confirming] {
            j.status.phase = p;
            assert!(!expired(&j, now_ms()), "{p:?}");
        }
        for p in [MovePhase::Done, MovePhase::Failed] {
            j.status.phase = p;
            assert!(expired(&j, now_ms()), "{p:?}");
        }
        j.at = now_ms();
        assert!(!expired(&j, now_ms()));
    }

    #[tokio::test]
    async fn a_verdict_without_a_launch_record_does_not_finish_or_roll_back() {
        // `Started` without a launch record cannot be told apart from a bug: confirming, all kept
        let c = crashed(false, 0);
        let j0 = load(&c.journal).unwrap();
        finish_recovered(None, &c.journal, j0, Verdict::Started { agent_id: Some("a".into()) }).await.unwrap();
        assert_eq!(load(&c.journal).unwrap().status.phase, MovePhase::Confirming);
        assert!(c.clone.exists() && c.session.exists());
    }

    #[test]
    fn a_journal_that_cannot_be_written_is_an_error() {
        let td = tempfile::tempdir().unwrap();
        // the moves folder is a file: nothing can be written below it
        let moves = td.path().join("moves");
        std::fs::write(&moves, "x").unwrap();
        let err = write_status(&moves, "default", status(), &[], &[], None).unwrap_err();
        assert_eq!(err.code, "io_error");
        // and a writable one round-trips, launch record included; journals from before it have none
        let ok = td.path().join("ok");
        let l = launching(td.path(), 5);
        write_status(&ok, "default", status(), &[], &[], Some(&l)).unwrap();
        assert_eq!(load(&ok.join("m1").join("target.json")).unwrap().launching, Some(l));
        let mut v: serde_json::Value = serde_json::from_slice(&std::fs::read(ok.join("m1").join("target.json")).unwrap()).unwrap();
        v.as_object_mut().unwrap().remove("launching");
        std::fs::write(ok.join("m1").join("target.json"), v.to_string()).unwrap();
        assert_eq!(load(&ok.join("m1").join("target.json")).unwrap().launching, None);
    }

    #[tokio::test]
    async fn a_result_is_reported_only_once_it_is_saved() {
        // the write fails twice, then works: it is tried again, the failure is told once
        let (mut calls, mut told) = (0, 0);
        let ok = retry_commit(
            &tokio_util::sync::CancellationToken::new(),
            Duration::from_millis(2),
            || {
                calls += 1;
                if calls < 3 { Err(ApiError::new("io_error", "disk full")) } else { Ok(()) }
            },
            |_| told += 1,
        )
        .await;
        assert_eq!((ok, calls, told), (true, 3, 1));
        // the daemon closing first gives up without claiming anything
        let cancel = tokio_util::sync::CancellationToken::new();
        cancel.cancel();
        assert!(!retry_commit(&cancel, Duration::from_secs(60), || Err(ApiError::new("io_error", "x")), |_| {}).await);
    }

    #[test]
    fn only_a_refusal_proves_nothing_started() {
        let e = |code: &str, msg: &str| ApiError::new(code, msg);
        assert!(refused(&e("invalid_params", "x")) && refused(&e("busy", "x")) && refused(&e("herdr_error", "agent_name_taken: scout")));
        // a lost answer, a timeout, a dead connection, herdr down: it may have started
        assert!(!refused(&e("timeout", "x")) && !refused(&e("herdr_error", "transport: reset")) && !refused(&e("herdr_error", "agent_start_failed: x")) && !refused(&e("internal", "x")));
    }
}

#[test]
fn an_interrupted_source_job_can_still_be_finished() {
    use super::jobs::Job;
    use super::source::{aborted, was_interrupted};
    use tf_proto::{ApiError, MoveRole};
    let job = || Job::new("m1", MoveRole::Source, "default", "a1", &[]);
    // the idle sweep's end: the card says interrupted and the agent is parked, `move.finish` goes on
    let swept = job();
    swept.fail(ApiError::new("interrupted", "the app stopped copying the move"));
    assert!(was_interrupted(&swept));
    // a rolled-back (cancelled) or still running job is not
    let cancelled = job();
    cancelled.fail(aborted());
    assert!(!was_interrupted(&cancelled));
    assert!(!was_interrupted(&job()));
}
