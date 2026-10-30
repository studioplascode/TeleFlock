//! `cleanup.remove`: one linked worktree from the Cleanup page, checked again right before it goes
//! (the page's report may be minutes old):
//!
//! * no agent on the board works or waits for the user in it (`busy`, retryable);
//! * it is not locked (`worktree_locked`, even with `force`: unlock it first);
//! * a detached HEAD holds no commit only it knows (`orphan_commits`, unless `force`);
//!
//! then it goes exactly like `worktree.remove {path}`: through herdr when a workspace shows it
//! (which closes that workspace), else `git worktree remove [--force]` from the main worktree;
//! uncommitted changes need `force` (`dirty_worktree`), a repository owned by another user `trust`
//! (`untrusted_repo`). The branch is always kept. A folder already gone drops only its own
//! registration.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tf_proto::{Agent, ApiError, CleanupRemoveParams, Empty, Workspace};

use super::scan;
use crate::ops::fs::resolve_path;
use crate::ops::worktree::{remove_failure, remove_path, same_path};
use crate::ops::{Ctx, git};

const QUICK: Duration = Duration::from_secs(10);

pub async fn remove(ctx: &Ctx, p: &CleanupRemoveParams) -> Result<Empty, ApiError> {
    let path = resolve_path(&p.path)?;
    let board = ctx.state.snapshot();
    if let Some(name) = busy_agent(&board.workspaces, &board.agents, &path) {
        return Err(ApiError::new(
            "busy",
            format!("agent {name} is working in {}", path.display()),
        )
        .with_hint("Wait until it is done, or stop it, before removing its worktree.")
        .retryable());
    }
    let root = repo_root(ctx, &path).await?;
    let Some(reg) = registration(&root, &path, p.trust).await? else {
        if path.exists() {
            return Err(ApiError::new(
                "not_git_repo",
                format!("{} is not a linked git worktree", path.display()),
            ));
        }
        // A folder already gone that git no longer lists: nothing left to remove.
        scan::forget(&ctx.herdr_session, &path);
        return Ok(Empty {});
    };
    precheck(&reg, p.force)?;
    remove_path(
        ctx,
        &path.display().to_string(),
        p.force,
        p.trust,
        Some(&root),
    )
    .await?;
    scan::forget(&ctx.herdr_session, &path);
    ctx.state.refresh();
    Ok(Empty {})
}

/// The agent that keeps a worktree from going: live (not parked), in it (its workspace or a folder
/// inside), working or waiting for the user.
pub(crate) fn busy_agent(
    workspaces: &[Workspace],
    agents: &[Agent],
    path: &Path,
) -> Option<String> {
    let (_, found) = scan::agents_in(workspaces, agents, path);
    found
        .into_iter()
        .find(|a| a.parked.is_none() && scan::is_busy(a))
        .map(|a| a.name.clone())
}

/// The main worktree of the repository `path` belongs to: from the checkout, else (the folder is
/// gone) from the last report or a parked agent's record.
async fn repo_root(ctx: &Ctx, path: &Path) -> Result<PathBuf, ApiError> {
    if path.is_dir() {
        return match git::repo_top(path).await? {
            Some(top) => Ok(top.root),
            None => Err(ApiError::new(
                "not_git_repo",
                format!("{} is not a git worktree", path.display()),
            )),
        };
    }
    let parked = || {
        ctx.state.parked_all().into_iter().find_map(|r| {
            r.worktree
                .filter(|w| same_path(Path::new(&w.path), path))
                .map(|w| PathBuf::from(w.repo_root))
        })
    };
    scan::root_of(&ctx.herdr_session, path)
        .or_else(parked)
        .ok_or_else(|| {
            ApiError::new(
                "not_found",
                format!(
                    "{} is gone and no repository TeleFlock knows lists it",
                    path.display()
                ),
            )
        })
}

/// git's record of a linked worktree.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Registration {
    pub record: git::WorktreeRecord,
    /// Detached on a commit no branch, tag or remote branch contains (or git couldn't tell).
    pub orphan: bool,
}

/// git's record of the linked worktree at `path` in the repository at `root`; `None` when git
/// doesn't list it (any more). The main checkout is never one: `not_git_repo`.
pub(crate) async fn registration(
    root: &Path,
    path: &Path,
    trust: bool,
) -> Result<Option<Registration>, ApiError> {
    let mut args = Vec::new();
    if trust {
        args.extend(["-c", "safe.directory=*"]);
    }
    args.extend(["worktree", "list", "--porcelain"]);
    let out = git::git(root, &args, QUICK).await?;
    if !out.ok() {
        return Err(remove_failure(&out.message()));
    }
    let entries = git::parse_worktree_porcelain(&out.stdout_str());
    if entries
        .first()
        .is_some_and(|main| same_path(Path::new(&main.path), path))
    {
        return Err(ApiError::new(
            "not_git_repo",
            format!("{} is the repository's main checkout", path.display()),
        )
        .with_hint("Only linked worktrees are removed here, never a repository's main checkout."));
    }
    let Some(record) = entries
        .into_iter()
        .skip(1)
        .find(|w| same_path(Path::new(&w.path), path))
    else {
        return Ok(None);
    };
    let orphan = match (&record.head, record.detached) {
        (Some(head), true) => scan::reachable(root, head).await != Some(true),
        _ => false,
    };
    Ok(Some(Registration { record, orphan }))
}

/// What refuses a removal before git is asked.
pub(crate) fn precheck(reg: &Registration, force: bool) -> Result<(), ApiError> {
    if let Some(reason) = &reg.record.locked {
        let why = if reason.is_empty() {
            String::new()
        } else {
            format!(" ({reason})")
        };
        return Err(ApiError::new("worktree_locked", format!("{} is locked{why}", reg.record.path))
            .with_hint(format!("TeleFlock never removes a locked worktree. Unlock it first if it should go: git worktree unlock {}", reg.record.path)));
    }
    if reg.orphan && !force {
        let head: String = reg
            .record
            .head
            .as_deref()
            .unwrap_or_default()
            .chars()
            .take(7)
            .collect();
        return Err(ApiError::new("orphan_commits", format!("its detached HEAD {head} is on no branch: removing the worktree loses that commit"))
            .with_hint("Create a branch there to keep it (git switch -c <name>), or remove it with force to discard it."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::git::tests::{fixture, sh};
    use crate::ops::worktree::remove_checkout;

    fn listed(root: &Path) -> String {
        String::from_utf8_lossy(
            &std::process::Command::new("git")
                .args(["worktree", "list"])
                .current_dir(root)
                .output()
                .unwrap()
                .stdout,
        )
        .into_owned()
    }

    /// The safety checks on real worktrees: locked refused even with force, a detached HEAD's
    /// unsaved commit needs force, dirty needs force, the branch stays, the main checkout never goes.
    #[tokio::test]
    async fn safety_checks() {
        let td = fixture();
        let root = td.path();
        let parent = root.parent().unwrap();
        let name = |n: &str| {
            parent.join(format!(
                "{}-{n}",
                root.file_name().unwrap().to_string_lossy()
            ))
        };
        let add = |n: &str| {
            let wt = name(n);
            sh(
                root,
                &[
                    "worktree",
                    "add",
                    "-q",
                    "-b",
                    n,
                    wt.to_str().unwrap(),
                    "main",
                ],
            );
            wt
        };

        // Locked: refused even with force, the folder and its registration stay.
        let locked = add("jan-locked");
        sh(
            root,
            &[
                "worktree",
                "lock",
                "--reason",
                "external disk",
                locked.to_str().unwrap(),
            ],
        );
        let reg = registration(root, &locked, false).await.unwrap().unwrap();
        let err = precheck(&reg, true).unwrap_err();
        assert_eq!(err.code, "worktree_locked");
        assert!(err.message.contains("external disk"), "{}", err.message);
        assert!(locked.is_dir() && listed(root).contains("jan-locked"));

        // Detached on a commit only it has: needs force; on main's commit it doesn't.
        let det = name("jan-det");
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
        assert!(
            !registration(root, &det, false)
                .await
                .unwrap()
                .unwrap()
                .orphan
        );
        std::fs::write(det.join("lone.txt"), "y\n").unwrap();
        sh(&det, &["add", "."]);
        sh(&det, &["commit", "-q", "-m", "lone"]);
        let reg = registration(root, &det, false).await.unwrap().unwrap();
        assert_eq!(precheck(&reg, false).unwrap_err().code, "orphan_commits");
        precheck(&reg, true).unwrap();

        // Clean, on a branch: passes; git removes it and keeps the branch.
        let clean = add("jan-clean");
        let reg = registration(root, &clean, false).await.unwrap().unwrap();
        precheck(&reg, false).unwrap();
        remove_checkout(&clean, Some(root), false, false)
            .await
            .unwrap();
        assert!(!clean.exists());
        sh(
            root,
            &["rev-parse", "--verify", "-q", "refs/heads/jan-clean"],
        );

        // Dirty: the prechecks pass, git refuses without force.
        let dirty = add("jan-dirty");
        std::fs::write(dirty.join("wip.txt"), "x\n").unwrap();
        precheck(
            &registration(root, &dirty, false).await.unwrap().unwrap(),
            false,
        )
        .unwrap();
        assert_eq!(
            remove_checkout(&dirty, Some(root), false, false)
                .await
                .unwrap_err()
                .code,
            "dirty_worktree"
        );
        assert!(dirty.join("wip.txt").exists());

        // Gone by hand: still registered (prunable) until removed, then not listed any more.
        let gone = add("jan-gone");
        std::fs::remove_dir_all(&gone).unwrap();
        let reg = registration(root, &gone, false).await.unwrap().unwrap();
        assert!(reg.record.prunable);
        remove_checkout(&gone, Some(root), false, false)
            .await
            .unwrap();
        assert_eq!(registration(root, &gone, false).await.unwrap(), None);

        // Never the main checkout.
        assert_eq!(
            registration(root, root, false).await.unwrap_err().code,
            "not_git_repo"
        );
    }

    #[test]
    fn a_working_agent_blocks_removal() {
        let ws: Vec<Workspace> = vec![serde_json::from_value(serde_json::json!({
            "id": "w4", "label": "feat", "cwd": "/wt/feat", "tabs": [], "rollup": "working", "order": 0, "worktree": { "path": "/wt/feat" }
        }))
        .unwrap()];
        let agent = |state: &str, column: &str| -> Agent {
            serde_json::from_value(serde_json::json!({
                "id": "a", "name": "kanban", "kind": "omp", "paneId": "w4:p1", "tabId": "w4:t1", "workspaceId": "w4",
                "state": state, "stateSince": 0, "column": column, "archived": false, "turns": 1, "title": "t",
                "live": { "streaming": false, "thinking": false },
            }))
            .unwrap()
        };
        assert_eq!(
            busy_agent(&ws, &[agent("working", "running")], Path::new("/wt/feat")).as_deref(),
            Some("kanban")
        );
        assert_eq!(
            busy_agent(&ws, &[agent("blocked", "needs")], Path::new("/wt/feat")).as_deref(),
            Some("kanban")
        );
        assert_eq!(
            busy_agent(&ws, &[agent("idle", "review")], Path::new("/wt/feat")),
            None
        );
        assert_eq!(
            busy_agent(&ws, &[agent("working", "running")], Path::new("/wt/other")),
            None
        );
    }
}
