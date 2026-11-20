//! `cleanup.remove`: one linked worktree from the Cleanup page, checked on the worktree itself
//! right before it goes, never on the report (which a background scan may have made half an hour
//! ago):
//!
//! * no agent on the board works or waits for the user in it (`busy`, retryable);
//! * it is not locked (`worktree_locked`, even with `force`: unlock it first);
//! * a detached HEAD holds no commit only it knows (`orphan_commits`, unless `force`);
//! * (0.9.6, `expect`) it is still what the page showed: there (not missing, prunable or no
//!   folder: a disk unplugged since keeps git's registration, only Forget drops one), its HEAD
//!   and branch, no more unpushed commits, no live agent or herdr workspace in it that the page
//!   did not show (`worktree_changed`; its row in the report is refreshed, so the page asks again
//!   with the worktree as it is now);
//! * (`expect.pr`) chosen for its merged or closed pull request, gh still says so: one `gh pr
//!   view` right before, at the user's priority, never the report's answer alone. Reopened,
//!   another pull request on the branch, or none at its HEAD any more → `worktree_changed`; gh
//!   can't tell (not installed, signed out, rate limit, timeout) → `pr_unverified`. Either way
//!   the worktree stays, and the memo and row take gh's answer;
//! * (`expect.stale_before`) chosen as stale, untouched since before the cutoff the user confirmed:
//!   its last use asked again from all its sources (omp sessions, live agents, its reflog, changed
//!   files: a same-HEAD `git reset` or an agent's session counts) is not newer (`worktree_changed`,
//!   "used since the report");
//!
//! then it goes exactly like `worktree.remove {path}`: through herdr when a workspace shows it
//! (which closes that workspace), else `git worktree remove [--force]` from the main worktree;
//! uncommitted changes need `force` (`dirty_worktree`: git checks them itself, at that moment), a
//! repository owned by another user `trust` (`untrusted_repo`). The branch is always kept.
//! Without `expect` (older apps), a folder already gone drops only its own registration.
//!
//! **Order** (`expect`): the slow checks of why it was chosen come first (omp's session index for a
//! stale pick, gh for its pull request, up to its timeout), then the fast local facts are read last
//! (git's registration, `git status` for HEAD, branch, changes and commits ahead, then without any
//! await its folder and the board), then it goes at once, a last look that its checkout is still
//! there (`.git`) right before git or herdr runs. Whatever changes while gh is slow (another branch
//! checked out, an agent or a workspace in it, the folder unmounted) is seen, and nothing goes.
//! Forget too reads last what decides: the path is checked right before the admin dir goes.
//!
//! **Forget** (`forget`, 0.9.6) only drops git's record of a worktree whose folder is gone, and
//! never deletes a checkout: anything at the path (a disk mounted again, a restored folder, an
//! empty mount point), or a path whose absence can't be told (an unreadable folder on the way),
//! refuses with `not_missing` and refreshes the row. Otherwise only the worktree's admin dir goes
//! (`<git dir>/worktrees/<id>`, what `git worktree prune` deletes for it), the path checked once
//! more right before; never `git worktree remove`, which would delete a folder that came back in
//! between.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tf_proto::{Agent, ApiError, CleanupExpect, CleanupExpectPr, CleanupRemoveParams, CleanupWorktree, Empty, Millis, Workspace, WorktreeUse};

use super::prs::Lookup;
use super::scan;
use crate::ops::fs::resolve_path;
use crate::ops::workspace::map_herdr;
use crate::ops::worktree::{remove_failure, remove_path, remove_registered, same_path};
use crate::ops::{Ctx, git};
use scan::BoardNow;

const QUICK: Duration = Duration::from_secs(10);

pub async fn remove(ctx: &Ctx, p: &CleanupRemoveParams) -> Result<Empty, ApiError> {
    let path = resolve_path(&p.path)?;
    if p.forget {
        return forget(ctx, &path, p.trust).await;
    }
    let board = ctx.state.snapshot();
    if let Some(name) = busy_agent(&board.workspaces, &board.agents, &path) {
        return Err(busy(&name, &path));
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
    let Some(expect) = &p.expect else {
        // Older apps (no `expect`): as before.
        remove_path(ctx, &path.display().to_string(), p.force, p.trust, Some(&root)).await?;
        return Ok(removed(ctx, &path));
    };
    // (a) The slow checks of why it was chosen: omp's session index for a stale pick, gh for its
    // pull request (up to its timeout). Anything may change meanwhile: they decide nothing alone.
    let slow = async {
        if expect.stale_before.is_some() || expect.pr.is_some() {
            let first = scan::recheck(ctx, &root, &reg.record).await;
            verdict(&path, expect, &first)?;
            if let Some(cut) = expect.stale_before {
                stale_verdict(&path, cut, &first)?;
            }
            if let Some(pr) = &expect.pr {
                pr_verdict(&path, pr, &scan::recheck_pr(ctx, &root, &first).await)?;
            }
        }
        Ok(())
    };
    // (b) The fast local facts read last, (c) the removal at once: nothing awaited in between.
    match in_order(slow, &ctx.herdr_session, &root, &path, expect, p.force, p.trust, || BoardNow::of(ctx)).await? {
        Go::Gone => {}
        Go::Herdr(workspace) => {
            still_a_checkout(&path)?;
            ctx.herdr.worktree_remove(&workspace, p.force, p.trust).await.map_err(map_herdr)?;
        }
        Go::Git => remove_registered(&path, &root, p.force, p.trust, || still_a_checkout(&path)).await?,
    }
    Ok(removed(ctx, &path))
}

/// After a removal: the cards that ran in it leave the board, the row the report.
fn removed(ctx: &Ctx, path: &Path) -> Empty {
    ctx.state.drop_parked_where(|r| crate::state::parked::ran_in(r, path, |other| same_path(Path::new(other), path)));
    tracing::info!(path = %path.display(), "cleanup removed a worktree (or found it gone)");
    scan::forget(&ctx.herdr_session, path);
    ctx.state.refresh();
    Empty {}
}

fn busy(name: &str, path: &Path) -> ApiError {
    ApiError::new("busy", format!("agent {name} is working in {}", path.display()))
        .with_hint("Wait until it is done, or stop it, before removing its worktree.")
        .retryable()
}

/// What a removal checked by [`in_order`] does, at once.
#[derive(Debug, PartialEq)]
pub(crate) enum Go {
    /// git no longer lists it and its folder is gone (removed meanwhile): nothing left to do.
    Gone,
    /// Through herdr: this workspace shows it (it closes with it, as the page said).
    Herdr(String),
    /// `git worktree remove` from the main worktree.
    Git,
}

/// A removal with `expect`, in its order: (a) `slow`, the slow checks of why it was chosen, awaited
/// first; (b) the worktree's fast local facts read last: git's registration of it, `git status` in
/// it (HEAD, branch, changes, commits ahead: the last await before the removal), then, without
/// awaiting anything, its folder and the board (`board`). `Ok` only while all of it is what the page
/// confirmed (and, for a stale pick, still untouched since its cutoff); the caller acts on the
/// [`Go`] at once (c), [`still_a_checkout`] the last look right before git or herdr runs.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn in_order(
    slow: impl Future<Output = Result<(), ApiError>>,
    session: &str,
    root: &Path,
    path: &Path,
    expect: &CleanupExpect,
    force: bool,
    trust: bool,
    board: impl FnOnce() -> BoardNow,
) -> Result<Go, ApiError> {
    slow.await?;
    let Some(reg) = registration(root, path, trust).await? else {
        return match still_there(path) {
            Some(_) => Err(changed(path, "git no longer lists it as a worktree")),
            None => Ok(Go::Gone),
        };
    };
    precheck(&reg, force)?;
    let mut now = scan::final_facts(root, &reg.record).await;
    // Nothing is awaited from here until git or herdr removes it.
    let b = board();
    if let Some(name) = busy_agent(&b.workspaces, &b.agents, path) {
        return Err(busy(&name, path));
    }
    b.place(&mut now);
    let checked = verdict(path, expect, &now).and_then(|()| match expect.stale_before {
        Some(cut) => stale_verdict(path, cut, &now),
        None => Ok(()),
    });
    if let Err(e) = checked {
        scan::show_row(session, root, now);
        return Err(e);
    }
    let held = b.workspaces.iter().find(|w| w.worktree.as_ref().is_some_and(|t| same_path(Path::new(&t.path), path)));
    Ok(held.map_or(Go::Git, |w| Go::Herdr(w.id.clone())))
}

/// The last look before git or herdr removes a worktree: its checkout is still there (a folder with
/// its `.git`). A folder gone or unmounted in between is not removed: git would drop its record.
fn still_a_checkout(path: &Path) -> Result<(), ApiError> {
    if path.join(".git").is_file() {
        Ok(())
    } else {
        Err(changed(path, "its folder is gone (a disk unplugged, or the folder moved away)"))
    }
}

fn changed(path: &Path, what: &str) -> ApiError {
    ApiError::new("worktree_changed", format!("{} changed since the report: {what}", path.display()))
        .with_hint("Nothing was deleted. Look at it as it is now: the page shows it again.")
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

/// What changed in a worktree since the page showed it (`expect`) that its removal was not
/// confirmed on; empty when it is what the page showed. Uncommitted changes are not among them:
/// git refuses those without `force` itself, which asks for the force confirm as it always did.
/// Gone now (missing, prunable or not a folder) is: Delete would drop git's registration of a
/// checkout on a disk that comes back.
pub(crate) fn changes(expect: &CleanupExpect, now: &CleanupWorktree) -> Vec<String> {
    if now.missing {
        return vec!["its folder is gone (a disk unplugged, or the folder moved away)".to_string()];
    }
    let mut out = Vec::new();
    if expect.branch != now.branch {
        out.push(match &now.branch {
            Some(b) => format!("it is on branch {b} now"),
            None => "its HEAD is detached now".to_string(),
        });
    } else if expect.head != now.head {
        out.push(format!("its HEAD moved to {} (new commits, or another checkout)", now.head.as_deref().unwrap_or("?")));
    } else if now.unpushed.unwrap_or(0) > expect.unpushed.unwrap_or(0) {
        let n = now.unpushed.unwrap_or(0);
        out.push(format!("{n} commit{} not pushed now", if n == 1 { " is" } else { "s are" }));
    }
    if now.agents > expect.agents {
        out.push(format!("{} agent{} in it now", now.agents, if now.agents == 1 { " is" } else { "s are" }));
    }
    if now.workspace_id.is_some() && expect.workspace_id.is_none() {
        out.push("a herdr workspace shows it now (deleting it closes that workspace)".to_string());
    }
    out
}

/// `worktree_changed` when [`changes`] finds any.
pub(crate) fn verdict(path: &Path, expect: &CleanupExpect, now: &CleanupWorktree) -> Result<(), ApiError> {
    let what = changes(expect, now);
    if what.is_empty() {
        return Ok(());
    }
    let hint = if now.missing {
        "Nothing was deleted and git still knows it: it is whole again once its folder is back. Forget it only if it is gone for good."
    } else {
        "Look at it as it is now before deleting it: the page shows it again."
    };
    Err(ApiError::new("worktree_changed", format!("{} changed since the report: {}", path.display(), what.join("; "))).with_hint(hint))
}

/// A removal chosen as stale (`cut`: untouched since before it, the "untouched N+ days" the user
/// confirmed) against the worktree's last use now (`active_at`, else when it was created): used
/// since → `worktree_changed`.
pub(crate) fn stale_verdict(path: &Path, cut: Millis, now: &CleanupWorktree) -> Result<(), ApiError> {
    let last = now.active_at.or(now.created_at);
    if last.is_some_and(|t| t <= cut) {
        return Ok(());
    }
    let by = match now.active_by {
        Some(WorktreeUse::Agent) => " (an agent worked in it)",
        Some(WorktreeUse::Git) => " (its git history moved: a commit, checkout or reset)",
        Some(WorktreeUse::Files) => " (its files changed)",
        None => "",
    };
    Err(ApiError::new("worktree_changed", format!("{} changed since the report: it was used since the report{by}", path.display()))
        .with_hint("Nothing was deleted: it is no longer untouched for as long as you chose. The page shows it as it is now."))
}

/// A removal chosen for its pull request (`want`: merged or closed) against what gh says now: the
/// same pull request, still merged or closed at the worktree's HEAD, or no removal. Reopened,
/// another one on the branch, or none at its HEAD any more → `worktree_changed`; gh can't tell →
/// `pr_unverified`. Never on the report's pull request alone.
pub(crate) fn pr_verdict(path: &Path, want: &CleanupExpectPr, found: &Lookup) -> Result<(), ApiError> {
    let changed = |what: String| -> Result<(), ApiError> {
        Err(ApiError::new("worktree_changed", format!("{} changed since the report: {what}", path.display()))
            .with_hint("Nothing was deleted. Look at its pull request as it is now: the page shows it again."))
    };
    match found {
        Lookup::Found(Some(pr)) if pr.number == want.number && (pr.state == "MERGED" || pr.state == "CLOSED") => Ok(()),
        Lookup::Found(Some(pr)) if pr.number == want.number => changed(format!("its pull request #{} was reopened", pr.number)),
        Lookup::Found(Some(pr)) => changed(format!("another pull request is on its branch now (#{}, {})", pr.number, pr.state.to_lowercase())),
        Lookup::Found(None) => changed(format!("gh lists no merged or closed pull request at its HEAD any more (#{} was)", want.number)),
        Lookup::GhDown(e) | Lookup::NotGithub(e) | Lookup::Failed(e) => Err(ApiError::new("pr_unverified", format!("couldn't check its pull request #{}: {e}", want.number))
            .with_hint("Nothing was deleted: a worktree chosen for its merged or closed pull request goes only once gh confirms that. Try again when gh answers (signed in, rate limit over).")),
    }
}

/// Forget: drops git's record of a worktree whose folder is gone, never a checkout (module doc).
async fn forget(ctx: &Ctx, path: &Path, trust: bool) -> Result<Empty, ApiError> {
    let root = repo_root(ctx, path).await?;
    match forget_at(&root, path, trust).await {
        Ok(()) => {
            ctx.state.drop_parked_where(|r| crate::state::parked::ran_in(r, path, |other| same_path(Path::new(other), path)));
            scan::forget(&ctx.herdr_session, path);
            ctx.state.refresh();
            Ok(Empty {})
        }
        Err(e) => {
            if e.code == "not_missing"
                && let Ok(Some(reg)) = registration(&root, path, trust).await
            {
                // The page shows the worktree as it is now.
                scan::recheck(ctx, &root, &reg.record).await;
            }
            Err(e)
        }
    }
}

/// [`forget`] in the repository at `root`: refused when anything is at `path` (or it can't be told),
/// or the worktree is locked; else its admin dir only.
pub(crate) async fn forget_at(root: &Path, path: &Path, trust: bool) -> Result<(), ApiError> {
    if let Some(why) = still_there(path) {
        return Err(not_missing(path, &why));
    }
    let Some(reg) = registration(root, path, trust).await? else {
        return Ok(());
    };
    precheck(&reg, true)?;
    drop_registration(root, path).await
}

/// What is at `path`, when it is not definitely gone: `None` only when the path does not exist
/// (a missing folder on the way counts, a file on the way too: nothing can be there).
pub(crate) fn still_there(path: &Path) -> Option<String> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => Some(match std::fs::read_dir(path).map(|mut d| d.next().is_none()) {
            Ok(true) => "an empty folder is there (a disk not mounted on it?)".to_string(),
            Ok(false) => "the folder is there again (a disk mounted again, or the folder restored)".to_string(),
            Err(e) => format!("a folder is there that can't be read ({e})"),
        }),
        Ok(_) => Some("something that is no folder is there".to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        #[cfg(unix)]
        Err(e) if e.raw_os_error() == Some(libc::ENOTDIR) => None,
        Err(e) => Some(format!("whether it is gone can't be told ({e})")),
    }
}

fn not_missing(path: &Path, why: &str) -> ApiError {
    ApiError::new("not_missing", format!("{}: {why}. Nothing was forgotten.", path.display()))
        .with_hint("Its files stay as they are. Delete it on its own if it should go (the checkout goes, the branch stays).")
}

/// Deletes the admin dir of the linked worktree at `path` (`<git dir>/worktrees/<id>`), nothing
/// else, after checking once more that nothing is at `path`.
async fn drop_registration(root: &Path, path: &Path) -> Result<(), ApiError> {
    let common = scan::common_dir(root).await.ok_or_else(|| ApiError::new("not_git_repo", format!("{} has no git dir", root.display())))?;
    let admins = common.join("worktrees");
    let Some(admin) = scan::admin_dir(path, &common).filter(|a| a.parent().is_some_and(|p| same_path(p, &admins))) else {
        return Ok(());
    };
    if let Some(why) = still_there(path) {
        return Err(not_missing(path, &why));
    }
    std::fs::remove_dir_all(&admin).map_err(|e| ApiError::new("io_error", format!("removing {}: {e}", admin.display())))?;
    tracing::info!(path = %path.display(), admin = %admin.display(), "forgot a worktree whose folder is gone");
    Ok(())
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
    use tf_proto::CleanupPr;

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

    fn expect_of(w: &CleanupWorktree) -> CleanupExpect {
        CleanupExpect { head: w.head.clone(), branch: w.branch.clone(), unpushed: w.unpushed, agents: w.agents, workspace_id: w.workspace_id.clone(), pr: None, stale_before: None }
    }

    /// A removal confirmed on facts that still hold goes at once; one whose worktree changed since
    /// (a commit, another branch, more unpushed commits, an agent or a workspace in it) gets its
    /// confirm again. Uncommitted changes are git's to refuse (the force confirm), not a change here.
    #[tokio::test]
    async fn a_removal_acts_on_the_worktree_as_it_is_now() {
        let td = fixture();
        let root = td.path();
        sh(root, &["checkout", "-q", "-f", "main"]);
        let wt = root.parent().unwrap().join(format!("{}-rv", root.file_name().unwrap().to_string_lossy()));
        sh(root, &["worktree", "add", "-q", "-b", "rv", wt.to_str().unwrap(), "main"]);
        let common = root.join(".git");
        let now = || {
            let (root, wt, common) = (root.to_path_buf(), wt.clone(), common.clone());
            async move {
                let reg = registration(&root, &wt, false).await.unwrap().unwrap();
                scan::git_facts_now(&root, &common, reg.record).await
            }
        };
        let seen = now().await;
        let expect = expect_of(&seen);
        assert!(verdict(&wt, &expect, &now().await).is_ok(), "unchanged: acts at once");

        std::fs::write(wt.join("wip.txt"), "x").unwrap();
        let dirty = now().await;
        assert_eq!(dirty.dirty, Some(1));
        assert!(verdict(&wt, &expect, &dirty).is_ok(), "uncommitted changes: git refuses without force, as always");

        sh(&wt, &["add", "wip.txt"]);
        sh(&wt, &["commit", "-q", "-m", "wip"]);
        let committed = now().await;
        let err = verdict(&wt, &expect, &committed).unwrap_err();
        assert_eq!(err.code, "worktree_changed");
        assert!(err.message.contains("HEAD moved"), "{}", err.message);
        assert!(verdict(&wt, &expect_of(&committed), &committed).is_ok(), "confirmed again on what it is now: acts");

        sh(&wt, &["checkout", "-q", "-b", "other"]);
        assert!(changes(&expect_of(&committed), &now().await)[0].contains("branch other"));

        let mut board = committed.clone();
        (board.agents, board.workspace_id) = (1, Some("w9".into()));
        let what = changes(&expect_of(&committed), &board);
        assert_eq!(what.len(), 2, "{what:?}");
        let pushed_less = CleanupWorktree { unpushed: Some(3), ..committed.clone() };
        assert_eq!(changes(&CleanupExpect { unpushed: Some(1), ..expect_of(&committed) }, &pushed_less).len(), 1, "more commits not pushed");
        assert!(changes(&CleanupExpect { unpushed: Some(5), ..expect_of(&committed) }, &pushed_less).is_empty(), "fewer is no reason to ask again");
    }

    /// Delete never forgets: a worktree the report showed there whose folder is gone now (a disk
    /// unplugged after the scan) is refused with `worktree_changed`, git keeps its registration,
    /// and once the folder is back the checkout is whole again and goes as confirmed.
    #[tokio::test]
    async fn delete_keeps_a_checkout_gone_since_the_report() {
        let td = fixture();
        let root = td.path();
        sh(root, &["checkout", "-q", "-f", "main"]);
        let wt = root.parent().unwrap().join(format!("{}-disk", root.file_name().unwrap().to_string_lossy()));
        sh(root, &["worktree", "add", "-q", "-b", "disk", wt.to_str().unwrap(), "main"]);
        let common = root.join(".git");
        let now = || {
            let (root, wt, common) = (root.to_path_buf(), wt.clone(), common.clone());
            async move {
                let reg = registration(&root, &wt, false).await.unwrap().unwrap();
                (reg.record.prunable, scan::git_facts_now(&root, &common, reg.record).await)
            }
        };
        let listed = || {
            let out = std::process::Command::new("git").args(["worktree", "list", "--porcelain"]).current_dir(root).output().unwrap();
            String::from_utf8_lossy(&out.stdout).lines().any(|l| l.strip_prefix("worktree ").is_some_and(|p| same_path(Path::new(p), &wt)))
        };
        let (_, seen) = now().await;
        assert!(!seen.missing);
        let expect = expect_of(&seen);

        // The disk goes: the row the page confirmed on said "there".
        let away = wt.with_extension("unplugged");
        std::fs::rename(&wt, &away).unwrap();
        let (prunable, gone) = now().await;
        assert!(prunable && gone.missing);
        let err = verdict(&wt, &expect, &gone).unwrap_err();
        assert_eq!(err.code, "worktree_changed");
        assert!(err.message.contains("folder is gone"), "{}", err.message);
        assert!(err.hint.as_deref().is_some_and(|h| h.contains("git still knows it")), "{:?}", err.hint);
        assert!(listed(), "git still lists the worktree");

        // The disk comes back: whole again, and Delete goes as confirmed.
        std::fs::rename(&away, &wt).unwrap();
        let (prunable, back) = now().await;
        assert!(!prunable && !back.missing && back.dirty == Some(0));
        assert!(verdict(&wt, &expect, &back).is_ok());
        assert!(listed());
    }

    fn pr(number: u32, state: &str) -> CleanupPr {
        CleanupPr { number, url: format!("https://github.com/lab/repo/pull/{number}"), title: "lab".into(), state: state.into(), draft: false, closed_at: None }
    }

    /// As `remove` goes with `expect.pr`: the worktree as it is now, then gh's answer of now
    /// (`found`, what `prs::lookup` returns), then the removal.
    async fn delete_chosen_for_pr(root: &Path, wt: &Path, expect: &CleanupExpect, now: &CleanupWorktree, found: Lookup) -> Result<(), ApiError> {
        verdict(wt, expect, now)?;
        pr_verdict(wt, expect.pr.as_ref().unwrap(), &found)?;
        remove_checkout(wt, Some(root), false, false).await.map(|_| ())
    }

    /// A worktree chosen for its merged or closed pull request goes only while gh still says so.
    /// Closed, then reopened on the same HEAD: refused (`worktree_changed`), the checkout and its
    /// ignored `.env.local` kept; another pull request on the branch, or none at its HEAD any more:
    /// refused too; gh can't tell (signed out, rate limit, no GitHub remote): `pr_unverified`, kept;
    /// still merged: deleted.
    #[tokio::test]
    async fn a_removal_chosen_for_its_pull_request_asks_gh_again() {
        let td = fixture();
        let root = td.path();
        sh(root, &["checkout", "-q", "-f", "main"]);
        std::fs::write(root.join(".gitignore"), ".env.local\n").unwrap();
        sh(root, &["add", ".gitignore"]);
        sh(root, &["commit", "-q", "-m", "ignore .env.local"]);
        let wt = root.parent().unwrap().join(format!("{}-pr", root.file_name().unwrap().to_string_lossy()));
        sh(root, &["worktree", "add", "-q", "-b", "fix-41", wt.to_str().unwrap(), "main"]);
        std::fs::write(wt.join(".env.local"), "SECRET=1\n").unwrap();
        let reg = registration(root, &wt, false).await.unwrap().unwrap();
        let now = scan::git_facts_now(root, &root.join(".git"), reg.record).await;
        assert_eq!(now.dirty, Some(0), "an ignored file is no change");
        let closed = CleanupExpect { pr: Some(CleanupExpectPr { number: 41, state: "CLOSED".into() }), ..expect_of(&now) };

        let err = delete_chosen_for_pr(root, &wt, &closed, &now, Lookup::Found(Some(pr(41, "OPEN")))).await.unwrap_err();
        assert_eq!(err.code, "worktree_changed");
        assert!(err.message.contains("its pull request #41 was reopened"), "{}", err.message);
        for other in [Lookup::Found(Some(pr(57, "OPEN"))), Lookup::Found(Some(pr(57, "MERGED"))), Lookup::Found(None)] {
            assert_eq!(delete_chosen_for_pr(root, &wt, &closed, &now, other.clone()).await.unwrap_err().code, "worktree_changed", "{other:?}");
        }
        for down in [Lookup::GhDown("gh is not signed in".into()), Lookup::Failed("HTTP 403: API rate limit exceeded".into()), Lookup::NotGithub("no GitHub remote".into())] {
            let err = delete_chosen_for_pr(root, &wt, &closed, &now, down).await.unwrap_err();
            assert_eq!(err.code, "pr_unverified");
            assert!(err.message.starts_with("couldn't check its pull request #41: "), "{}", err.message);
        }
        assert_eq!(std::fs::read_to_string(wt.join(".env.local")).unwrap(), "SECRET=1\n", "the checkout and its ignored file stay");
        assert!(registration(root, &wt, false).await.unwrap().is_some());

        let merged = CleanupExpect { pr: Some(CleanupExpectPr { number: 41, state: "MERGED".into() }), ..expect_of(&now) };
        delete_chosen_for_pr(root, &wt, &merged, &now, Lookup::Found(Some(pr(41, "MERGED")))).await.unwrap();
        assert!(!wt.exists(), "still merged: deleted");
    }

    /// Prune stale goes only while the worktree is still untouched since the cutoff the user
    /// confirmed: one that got a same-HEAD `git reset` after the report (a reflog entry, no change to
    /// its HEAD, branch, changes or commits) is refused and stays; one left untouched goes.
    #[tokio::test]
    async fn prune_stale_keeps_a_worktree_used_since_the_report() {
        let td = fixture();
        let root = td.path();
        sh(root, &["checkout", "-q", "-f", "main"]);
        let add = |name: &str| {
            let wt = root.parent().unwrap().join(format!("{}-{name}", root.file_name().unwrap().to_string_lossy()));
            sh(root, &["worktree", "add", "-q", "-b", name, wt.to_str().unwrap(), "main"]);
            wt
        };
        let (used, untouched) = (add("stale-used"), add("stale-untouched"));
        let now = |wt: PathBuf| async move {
            let reg = registration(root, &wt, false).await.unwrap().unwrap();
            scan::final_facts(root, &reg.record).await
        };
        // The report: both last used when they were created; the cutoff the user confirmed is then.
        let (seen_used, seen_untouched) = (now(used.clone()).await, now(untouched.clone()).await);
        let cut = seen_used.active_at.max(seen_untouched.active_at).expect("a last use from the reflog");
        assert!(stale_verdict(&used, cut, &seen_used).is_ok() && stale_verdict(&untouched, cut, &seen_untouched).is_ok());
        let stale = |w: &CleanupWorktree| CleanupExpect { stale_before: Some(cut), ..expect_of(w) };

        // A second later, a same-HEAD reset in one of them: its reflog moves, nothing else does.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        sh(&used, &["reset", "-q", "HEAD"]);
        let after = now(used.clone()).await;
        assert_eq!((after.head.as_deref(), after.branch.as_deref(), after.dirty), (seen_used.head.as_deref(), seen_used.branch.as_deref(), Some(0)));
        assert!(verdict(&used, &stale(&seen_used), &after).is_ok(), "nothing the other checks see");
        let err = stale_verdict(&used, cut, &after).unwrap_err();
        assert_eq!(err.code, "worktree_changed");
        assert!(err.message.contains("used since the report"), "{}", err.message);
        assert!(used.is_dir() && registration(root, &used, false).await.unwrap().is_some(), "refused: the checkout stays");

        // Untouched since the report: it goes.
        let still = now(untouched.clone()).await;
        verdict(&untouched, &stale(&seen_untouched), &still).unwrap();
        stale_verdict(&untouched, cut, &still).unwrap();
        remove_checkout(&untouched, Some(root), false, false).await.unwrap();
        assert!(!untouched.exists());
    }

    /// The removal as `remove` runs it with `expect.pr`, its gh lookup held until `release` fires,
    /// then answering MERGED; nothing on the board.
    fn held_removal(root: &Path, wt: &Path, expect: CleanupExpect) -> (tokio::sync::oneshot::Sender<()>, tokio::task::JoinHandle<Result<(), ApiError>>) {
        let (root, wt) = (root.to_path_buf(), wt.to_path_buf());
        let (release, held) = tokio::sync::oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            let slow = async {
                held.await.ok();
                pr_verdict(&wt, expect.pr.as_ref().unwrap(), &Lookup::Found(Some(pr(41, "MERGED"))))
            };
            let empty = || BoardNow { workspaces: Vec::new(), agents: Vec::new(), autos: None };
            match in_order(slow, "cleanup-test", &root, &wt, &expect, false, false, empty).await? {
                Go::Git => remove_registered(&wt, &root, false, false, || still_a_checkout(&wt)).await,
                other => panic!("{other:?}"),
            }
        });
        (release, task)
    }

    /// gh first, the worktree last: what changes while the pull request lookup is slow (another
    /// branch checked out, the folder moved away as by an unplugged disk) is seen right before git
    /// would run, and nothing goes: the checkout and git's registration stay. Unchanged, it goes.
    #[tokio::test]
    async fn what_changes_while_gh_is_slow_is_seen_before_anything_goes() {
        let td = fixture();
        let root = td.path();
        sh(root, &["checkout", "-q", "-f", "main"]);
        let add = |name: &str| {
            let wt = root.parent().unwrap().join(format!("{}-{name}", root.file_name().unwrap().to_string_lossy()));
            sh(root, &["worktree", "add", "-q", "-b", name, wt.to_str().unwrap(), "main"]);
            wt
        };
        let merged = |w: &CleanupWorktree| CleanupExpect { pr: Some(CleanupExpectPr { number: 41, state: "MERGED".into() }), ..expect_of(w) };
        let seen = |wt: PathBuf| async move {
            let reg = registration(root, &wt, false).await.unwrap().unwrap();
            scan::final_facts(root, &reg.record).await
        };

        // Another branch checked out while gh is slow.
        let switched = add("held-switch");
        let (release, task) = held_removal(root, &switched, merged(&seen(switched.clone()).await));
        sh(&switched, &["checkout", "-q", "-b", "held-other"]);
        release.send(()).unwrap();
        let err = task.await.unwrap().unwrap_err();
        assert_eq!(err.code, "worktree_changed");
        assert!(err.message.contains("branch held-other"), "{}", err.message);
        assert!(switched.join(".git").is_file() && registration(root, &switched, false).await.unwrap().is_some(), "the checkout and its registration stay");

        // The folder moved away while gh is slow: git keeps its registration; back, it is whole.
        let unplugged = add("held-unplug");
        let (release, task) = held_removal(root, &unplugged, merged(&seen(unplugged.clone()).await));
        let away = unplugged.with_extension("away");
        std::fs::rename(&unplugged, &away).unwrap();
        release.send(()).unwrap();
        let err = task.await.unwrap().unwrap_err();
        assert_eq!(err.code, "worktree_changed");
        assert!(err.message.contains("folder is gone"), "{}", err.message);
        assert!(registration(root, &unplugged, false).await.unwrap().is_some(), "git still lists it");
        std::fs::rename(&away, &unplugged).unwrap();
        assert!(!registration(root, &unplugged, false).await.unwrap().unwrap().record.prunable, "whole again");

        // Unchanged: it goes once gh answers.
        let kept = add("held-kept");
        let (release, task) = held_removal(root, &kept, merged(&seen(kept.clone()).await));
        release.send(()).unwrap();
        task.await.unwrap().unwrap();
        assert!(!kept.exists() && registration(root, &kept, false).await.unwrap().is_none());
    }

    /// Forget never deletes a checkout. A worktree the report saw gone whose folder came back
    /// (holding a file git ignores) is refused with `not_missing`, and the checkout and its ignored
    /// file stay; an empty folder at the path (a mount point without its disk) too. A folder truly
    /// gone: only its registration goes. Locked: refused.
    #[tokio::test]
    async fn forget_drops_a_record_and_never_a_checkout() {
        let td = fixture();
        let root = td.path();
        sh(root, &["checkout", "-q", "-f", "main"]);
        std::fs::write(root.join(".gitignore"), ".env.local\n").unwrap();
        sh(root, &["add", ".gitignore"]);
        sh(root, &["commit", "-q", "-m", "ignore env"]);
        let wt = root.parent().unwrap().join(format!("{}-fg", root.file_name().unwrap().to_string_lossy()));
        let away = wt.with_extension("away");
        sh(root, &["worktree", "add", "-q", "-b", "fg", wt.to_str().unwrap(), "main"]);
        std::fs::write(wt.join(".env.local"), "SECRET=1\n").unwrap();

        // The disk is unplugged (the folder moved away): the report lists it as gone.
        std::fs::rename(&wt, &away).unwrap();
        assert!(registration(root, &wt, false).await.unwrap().unwrap().record.prunable, "git calls it prunable");
        // …and plugged in again before someone presses Forget.
        std::fs::rename(&away, &wt).unwrap();
        let err = forget_at(root, &wt, false).await.unwrap_err();
        assert_eq!(err.code, "not_missing");
        assert!(err.message.contains("there again"), "{}", err.message);
        assert_eq!(std::fs::read_to_string(wt.join(".env.local")).unwrap(), "SECRET=1\n", "the ignored file survives");
        assert!(wt.join("a.txt").exists() && listed(root).contains("-fg"), "the checkout and its registration stay");

        // An empty mount point at the path is not "gone" either.
        std::fs::rename(&wt, &away).unwrap();
        std::fs::create_dir(&wt).unwrap();
        let err = forget_at(root, &wt, false).await.unwrap_err();
        assert!(err.code == "not_missing" && err.message.contains("empty folder"), "{}", err.message);
        std::fs::remove_dir(&wt).unwrap();

        // Locked and gone: refused.
        sh(root, &["worktree", "lock", wt.to_str().unwrap()]);
        assert_eq!(forget_at(root, &wt, false).await.unwrap_err().code, "worktree_locked");
        sh(root, &["worktree", "unlock", wt.to_str().unwrap()]);

        // Truly gone: only the registration goes; the moved-away copy is untouched.
        forget_at(root, &wt, false).await.unwrap();
        assert_eq!(registration(root, &wt, false).await.unwrap(), None);
        assert!(!listed(root).contains("-fg"));
        assert_eq!(std::fs::read_to_string(away.join(".env.local")).unwrap(), "SECRET=1\n");
        sh(root, &["rev-parse", "--verify", "-q", "refs/heads/fg"]);
        forget_at(root, &wt, false).await.unwrap();
        assert!(still_there(&root.join("a.txt/below")).is_none(), "a file on the way: nothing can be there");
    }
}
