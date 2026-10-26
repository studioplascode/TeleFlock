//! `worktree.*` methods: herdr worktrees (linked git checkouts opened as workspaces).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;
use tf_proto::{
    ApiError, Empty, HostMethod, StartTarget, WorktreeCreateParams, WorktreeCreated, WorktreeEntry, WorktreeList,
    WorktreeRemoveParams,
};

use crate::clients::ClientHandle;
use crate::ops::fs::resolve_path;
use crate::ops::git;
use crate::ops::workspace::{existing_dir, map_herdr};
use crate::ops::{to_value, Ctx};

/// Per-worktree budget for the dirty count in `worktree.list`.
const DIRTY_BUDGET: Duration = Duration::from_secs(2);
const QUICK: Duration = Duration::from_secs(10);
/// Budget for fetching a new branch's remote base; past it the worktree forks from the ref as is.
const FETCH_BASE: Duration = Duration::from_secs(30);

pub async fn handle(ctx: &Ctx, req: HostMethod, _client: &ClientHandle) -> Result<Value, ApiError> {
    match req {
        HostMethod::WorktreeListReq(p) => to_value(list(ctx, &p.cwd).await?),
        HostMethod::WorktreeCreate(p) => to_value(create(ctx, p).await?),
        HostMethod::WorktreeRemove(p) => to_value(remove(ctx, &p).await?),
        other => Err(ApiError::new("unknown_method", format!("{} is not a worktree method", other.name()))),
    }
}

pub async fn list(ctx: &Ctx, cwd: &str) -> Result<WorktreeList, ApiError> {
    let cwd = existing_dir(cwd)?;
    let listed = ctx.herdr.worktree_list(&tf_herdr::WorktreeScope::Cwd(cwd), false).await.map_err(map_herdr)?;
    let root = PathBuf::from(&listed.source.repo_root);
    let heads: HashMap<String, String> = match git::git(&root, &["worktree", "list", "--porcelain"], QUICK).await {
        Ok(o) if o.ok() => git::parse_worktree_porcelain(&o.stdout_str())
            .into_iter()
            .filter_map(|w| w.head.map(|h| (normalize_key(&w.path), h.chars().take(7).collect())))
            .collect(),
        _ => HashMap::new(),
    };
    let mut set = tokio::task::JoinSet::new();
    for (i, w) in listed.worktrees.iter().enumerate() {
        if w.is_bare || w.is_prunable {
            continue;
        }
        let path = PathBuf::from(&w.path);
        set.spawn(async move { (i, git::dirty_count(&path, DIRTY_BUDGET).await) });
    }
    let mut dirty: HashMap<usize, u32> = HashMap::new();
    while let Some(r) = set.join_next().await {
        if let Ok((i, Some(n))) = r {
            dirty.insert(i, n);
        }
    }
    let worktrees = listed
        .worktrees
        .iter()
        .enumerate()
        .map(|(i, w)| WorktreeEntry {
            head: heads.get(&normalize_key(&w.path)).cloned(),
            path: w.path.clone(),
            branch: w.branch.clone(),
            primary: !w.is_linked_worktree,
            workspace_id: w.open_workspace_id.clone(),
            dirty: dirty.get(&i).copied(),
        })
        .collect();
    Ok(WorktreeList { worktrees })
}

fn normalize_key(p: &str) -> String {
    Path::new(p).components().collect::<PathBuf>().display().to_string()
}

/// How the requested branch maps onto herdr's `worktree.create` (which checks out an
/// existing local branch, or creates `branch` from `base`).
#[derive(Debug, PartialEq)]
struct BranchPlan {
    branch: String,
    base: Option<String>,
    /// A new branch forked from a remote-tracking base (`origin/main`): fetched first, and the
    /// upstream git gives it (`branch.autoSetupMerge`) is dropped after creation.
    from_remote: bool,
}

async fn ref_exists(root: &Path, r: &str) -> bool {
    git::git(root, &["rev-parse", "-q", "--verify", &format!("{r}^{{commit}}")], QUICK).await.map(|o| o.ok()).unwrap_or(false)
}

async fn plan_branch(root: &Path, p: &WorktreeCreateParams) -> Result<BranchPlan, ApiError> {
    let branch = p.branch.trim();
    if branch.is_empty() {
        return Err(ApiError::new("invalid_params", "branch is empty"));
    }
    let local = ref_exists(root, &format!("refs/heads/{branch}")).await;
    if p.existing {
        if local {
            return Ok(BranchPlan { branch: branch.to_string(), base: None, from_remote: false });
        }
        // A remote branch (`origin/x`, or `x` that only exists on origin): create the local
        // tracking branch from it.
        let remotes = git::git(root, &["remote"], QUICK).await.map(|o| o.stdout_str()).unwrap_or_default();
        for remote in remotes.lines().filter(|r| !r.is_empty()) {
            if let Some(short) = branch.strip_prefix(&format!("{remote}/"))
                && ref_exists(root, &format!("refs/remotes/{branch}")).await {
                    if ref_exists(root, &format!("refs/heads/{short}")).await {
                        return Ok(BranchPlan { branch: short.to_string(), base: None, from_remote: false });
                    }
                    return Ok(BranchPlan { branch: short.to_string(), base: Some(branch.to_string()), from_remote: false });
                }
        }
        for remote in ["origin"].into_iter().chain(remotes.lines().filter(|r| !r.is_empty() && *r != "origin")) {
            let full = format!("{remote}/{branch}");
            if ref_exists(root, &format!("refs/remotes/{full}")).await {
                return Ok(BranchPlan { branch: branch.to_string(), base: Some(full), from_remote: false });
            }
        }
        return Err(ApiError::new("not_found", format!("branch `{branch}` does not exist")).with_hint("Pick an existing branch, or create a new one."));
    }
    let valid = git::git(root, &["check-ref-format", "--branch", branch], QUICK).await?;
    if !valid.ok() {
        return Err(ApiError::new("invalid_params", format!("`{branch}` is not a valid branch name")));
    }
    if local {
        return Err(ApiError::new("branch_exists", format!("branch `{branch}` already exists"))
            .with_hint("Choose “existing branch” to check it out, or pick a new name."));
    }
    // Untouched base: what `git.branches` reports as `defaultBase` (`origin/<default>`), not
    // herdr's default (HEAD of the main checkout: often a local `main` far behind the remote).
    let base = match p.base.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        Some(b) => Some(b.to_string()),
        None => git::default_branch(root).await.map(|d| d.base),
    };
    let remote = match &base {
        Some(b) => git::remote_tracking(root, b).await,
        None => None,
    };
    // Best effort: offline (or a remote that wants credentials) must not block creation.
    if let (Some(b), Some((remote, name))) = (&base, &remote)
        && let Err(e) = git::fetch_branch(root, remote, name, FETCH_BASE).await {
            tracing::warn!(base = %b, root = %root.display(), "could not fetch the worktree base, forking from the local ref: {e}");
        }
    if let Some(b) = &base
        && !ref_exists(root, b).await {
            return Err(ApiError::new("invalid_params", format!("base ref `{b}` does not exist")));
        }
    Ok(BranchPlan { branch: branch.to_string(), base, from_remote: remote.is_some() })
}

/// git can make a branch created from a remote-tracking ref track it (`branch.autoSetupMerge`:
/// `git branch` does by default; `git worktree add -b` with `--track`, or depending on the git
/// version and config): `feat/x` forked from `origin/main` would then `git push` into main and
/// count ahead/behind against it. Drops that upstream (only that one); the first `git.push` then
/// publishes `feat/x` under its own name.
async fn drop_base_upstream(root: &Path, branch: &str, base: &str) {
    let up = git::git(root, &["for-each-ref", "--format=%(upstream:short)", &format!("refs/heads/{branch}")], QUICK).await;
    if !up.is_ok_and(|o| o.ok() && o.line() == base) {
        return;
    }
    match git::git(root, &["branch", "--unset-upstream", branch], QUICK).await {
        Ok(o) if o.ok() => {}
        Ok(o) => tracing::warn!(branch, "could not drop the upstream {base}: {}", o.message()),
        Err(e) => tracing::warn!(branch, "could not drop the upstream {base}: {}", e.message),
    }
}

pub async fn create(ctx: &Ctx, p: WorktreeCreateParams) -> Result<WorktreeCreated, ApiError> {
    let cwd = existing_dir(&p.cwd)?;
    let root = match git::toplevel(Path::new(&cwd)).await {
        Ok(r) => r,
        Err(e) if e.code == "permission_denied" && p.trust => PathBuf::from(&cwd),
        Err(e) if e.code == "permission_denied" => {
            return Err(ApiError::new("untrusted_repo", e.message).with_hint(
                "This repository is owned by another user. Retry with “Trust repository” (applies safe.directory to this command only).",
            ));
        }
        Err(e) if e.code == "not_found" => {
            return Err(ApiError::new("not_git_repo", e.message).with_hint("Pick a folder inside a git repository."));
        }
        Err(e) => return Err(e),
    };
    // Untrusted repos cannot be inspected with plain git; let herdr do the work then (an absent
    // base is herdr's HEAD there: no default base, no fetch).
    let plan = if p.trust && !git::git(&root, &["rev-parse", "--git-dir"], QUICK).await.map(|o| o.ok()).unwrap_or(false) {
        BranchPlan { branch: p.branch.trim().to_string(), base: p.base.clone(), from_remote: false }
    } else {
        plan_branch(&root, &p).await?
    };
    let path = match p.path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => Some(resolve_path(s)?.display().to_string()),
        None => None,
    };
    let mut req = tf_herdr::WorktreeCreate::new(tf_herdr::WorktreeScope::Cwd(cwd));
    req.branch = Some(plan.branch.clone());
    req.base = plan.base.clone();
    req.path = path;
    req.label = p.label.as_ref().map(|l| l.trim().to_string()).filter(|l| !l.is_empty());
    req.focus = false;
    req.trust_repository = p.trust;
    let created = ctx.herdr.worktree_create(&req).await.map_err(map_herdr)?;
    ctx.state.refresh();

    let workspace_id = created.workspace.workspace_id.clone();
    let checkout = created
        .workspace
        .worktree
        .as_ref()
        .map(|w| w.checkout_path.clone())
        .unwrap_or_else(|| created.worktree.path.clone());
    let branch = created.worktree.branch.clone().unwrap_or(plan.branch);
    if plan.from_remote
        && let Some(base) = &plan.base {
            drop_base_upstream(&root, &branch, base).await;
        }
    let agent = match &p.agent {
        Some(spec) => {
            let target = StartTarget::Pane { pane_id: created.root_pane.pane_id.clone() };
            match crate::ops::agent::start_agent(ctx, target, spec, None).await {
                Ok(started) => Some(started),
                Err(mut e) => {
                    e.hint = Some(format!(
                        "The worktree was created at {checkout} (workspace {workspace_id}), but the agent did not start{}. Start one from the workspace.",
                        e.hint.as_deref().map(|h| format!(": {h}")).unwrap_or_default()
                    ));
                    return Err(e);
                }
            }
        }
        None => None,
    };
    Ok(WorktreeCreated { workspace_id, path: checkout, branch, agent })
}

pub async fn remove(ctx: &Ctx, p: &WorktreeRemoveParams) -> Result<Empty, ApiError> {
    ctx.herdr.worktree_remove(&p.workspace_id, p.force, p.trust).await.map_err(map_herdr)?;
    ctx.state.refresh();
    Ok(Empty {})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::git::tests::{fixture, sh};

    fn params(branch: &str, existing: bool, base: Option<&str>) -> WorktreeCreateParams {
        WorktreeCreateParams {
            cwd: String::new(),
            branch: branch.into(),
            base: base.map(str::to_string),
            path: None,
            label: None,
            existing,
            trust: false,
            agent: None,
        }
    }

    #[tokio::test]
    async fn branch_planning() {
        let td = fixture();
        let root = td.path();
        // a fake remote-tracking branch
        sh(root, &["update-ref", "refs/remotes/origin/remote-only", "main"]);
        sh(root, &["remote", "add", "origin", "https://example.invalid/x.git"]);

        let plan = |branch: &str, base: Option<&str>| BranchPlan { branch: branch.into(), base: base.map(str::to_string), from_remote: false };
        assert_eq!(plan_branch(root, &params("feat", true, None)).await.unwrap(), plan("feat", None));
        assert_eq!(plan_branch(root, &params("remote-only", true, None)).await.unwrap(), plan("remote-only", Some("origin/remote-only")));
        assert_eq!(plan_branch(root, &params("origin/remote-only", true, None)).await.unwrap(), plan("remote-only", Some("origin/remote-only")));
        assert_eq!(plan_branch(root, &params("nope", true, None)).await.unwrap_err().code, "not_found");
        assert_eq!(plan_branch(root, &params("feat", false, None)).await.unwrap_err().code, "branch_exists");
        assert_eq!(plan_branch(root, &params("bad..name", false, None)).await.unwrap_err().code, "invalid_params");
        assert_eq!(plan_branch(root, &params("new/x", false, Some("nosuchref"))).await.unwrap_err().code, "invalid_params");
        assert_eq!(plan_branch(root, &params("new/x", false, Some("main"))).await.unwrap(), plan("new/x", Some("main")));
        // no `origin/main`: the default base is the local default branch (no fetch)
        assert_eq!(plan_branch(root, &params("new/x", false, None)).await.unwrap(), plan("new/x", Some("main")));
    }

    fn git_out(dir: &Path, args: &[&str]) -> Option<String> {
        let out = std::process::Command::new("git").args(args).current_dir(dir).output().unwrap();
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    fn rev(dir: &Path, r: &str) -> String {
        git_out(dir, &["rev-parse", r]).unwrap()
    }

    fn upstream(dir: &Path, branch: &str) -> Option<String> {
        git_out(dir, &["for-each-ref", "--format=%(upstream:short)", &format!("refs/heads/{branch}")]).filter(|u| !u.is_empty())
    }

    /// A bare `origin` whose `main` is one commit ahead of a clone that has not fetched it yet:
    /// the clone's `main` and `origin/main` both sit at `old`, the remote's `main` at `new`.
    /// Returns `(tempdir, clone, old, new)`.
    fn stale_clone() -> (tempfile::TempDir, PathBuf, String, String) {
        let td = tempfile::tempdir().unwrap();
        let bare = td.path().join("origin.git");
        let seed = td.path().join("seed");
        let clone = td.path().join("clone");
        std::fs::create_dir_all(&seed).unwrap();
        sh(td.path(), &["init", "-q", "--bare", "-b", "main", bare.to_str().unwrap()]);
        sh(&seed, &["init", "-q", "-b", "main"]);
        std::fs::write(seed.join("a.txt"), "one\n").unwrap();
        sh(&seed, &["add", "."]);
        sh(&seed, &["commit", "-q", "-m", "one"]);
        sh(&seed, &["remote", "add", "origin", bare.to_str().unwrap()]);
        sh(&seed, &["push", "-q", "origin", "main"]);
        sh(td.path(), &["clone", "-q", bare.to_str().unwrap(), clone.to_str().unwrap()]);
        std::fs::write(seed.join("a.txt"), "one\ntwo\n").unwrap();
        sh(&seed, &["commit", "-q", "-am", "two"]);
        sh(&seed, &["push", "-q", "origin", "main"]);
        let (old, new) = (rev(&clone, "main"), rev(&seed, "main"));
        assert_ne!(old, new);
        assert_eq!(rev(&clone, "origin/main"), old);
        (td, clone, old, new)
    }

    /// What herdr runs for a new branch (`git worktree add -b <branch> <path> <base>`), then what
    /// `create` does once herdr is done. Whether that command makes the branch track a remote base
    /// depends on git's version and config, so the worst case (tracking) is forced first.
    async fn herdr_add(root: &Path, plan: &BranchPlan) -> PathBuf {
        let path = root.parent().unwrap().join(plan.branch.replace('/', "-"));
        let base = plan.base.as_deref().unwrap_or("HEAD");
        sh(root, &["worktree", "add", "-q", "-b", &plan.branch, path.to_str().unwrap(), base]);
        if plan.from_remote {
            sh(root, &["branch", "-q", "--set-upstream-to", base, &plan.branch]);
            assert_eq!(upstream(root, &plan.branch).as_deref(), Some(base));
            drop_base_upstream(root, &plan.branch, base).await;
        }
        path
    }

    #[tokio::test]
    async fn untouched_base_forks_from_fetched_origin_without_tracking_it() {
        let (_td, clone, old, new) = stale_clone();
        let list = git::branches(&clone).await.unwrap();
        assert_eq!((list.default_branch.as_deref(), list.default_base.as_deref()), (Some("main"), Some("origin/main")));

        let plan = plan_branch(&clone, &params("feat/new", false, None)).await.unwrap();
        assert_eq!(plan, BranchPlan { branch: "feat/new".into(), base: Some("origin/main".into()), from_remote: true });
        assert_eq!(rev(&clone, "origin/main"), new, "the base was fetched");
        assert_eq!(rev(&clone, "main"), old, "the local default branch is left alone");
        // control: other upstreams are not touched
        let wt = clone.parent().unwrap().join("control");
        sh(&clone, &["worktree", "add", "-q", "--track", "-b", "control", wt.to_str().unwrap(), "origin/main"]);
        drop_base_upstream(&clone, "control", "origin/other").await;
        assert_eq!(upstream(&clone, "control").as_deref(), Some("origin/main"));

        let wt = herdr_add(&clone, &plan).await;
        assert_eq!(rev(&wt, "HEAD"), new);
        assert_eq!(upstream(&clone, "feat/new"), None, "a new branch must not track origin/main");

        // review compares against the fork point (origin/main), not the stale local main
        std::fs::write(wt.join("b.txt"), "b\n").unwrap();
        sh(&wt, &["add", "."]);
        sh(&wt, &["commit", "-q", "-m", "work"]);
        let st = git::status(&wt).await.unwrap();
        assert_eq!(st.base.as_deref(), Some(new.as_str()));
        assert_eq!((st.upstream.as_deref(), st.ahead, st.behind), (None, 0, 0));
        let d = git::diff(&tf_proto::GitDiffParams { cwd: wt.display().to_string(), base: None, path: None, context: None }).await.unwrap();
        assert_eq!(d.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["b.txt"]);

        // git.push publishes the branch under its own name and tracks that
        git::push(&wt).await.unwrap();
        assert_eq!(upstream(&clone, "feat/new").as_deref(), Some("origin/feat/new"));
        let bare = clone.parent().unwrap().join("origin.git");
        assert_eq!(rev(&bare, "refs/heads/feat/new"), rev(&wt, "HEAD"));
        assert_eq!(rev(&bare, "refs/heads/main"), new, "main on the remote is untouched");
    }

    #[tokio::test]
    async fn explicit_base_is_honored() {
        let (_td, clone, old, new) = stale_clone();
        let plan = plan_branch(&clone, &params("feat/local", false, Some("main"))).await.unwrap();
        assert_eq!(plan, BranchPlan { branch: "feat/local".into(), base: Some("main".into()), from_remote: false });
        assert_eq!(rev(&clone, "origin/main"), old, "a local base fetches nothing");
        let wt = herdr_add(&clone, &plan).await;
        assert_eq!(rev(&wt, "HEAD"), old);

        let plan = plan_branch(&clone, &params("feat/remote", false, Some("origin/main"))).await.unwrap();
        assert_eq!(plan, BranchPlan { branch: "feat/remote".into(), base: Some("origin/main".into()), from_remote: true });
        let wt = herdr_add(&clone, &plan).await;
        assert_eq!(rev(&wt, "HEAD"), new);
        assert_eq!(upstream(&clone, "feat/remote"), None);

        // existing-branch mode still checks out / tracks the remote branch as before
        let plan = plan_branch(&clone, &params("origin/main", true, None)).await.unwrap();
        assert_eq!(plan, BranchPlan { branch: "main".into(), base: None, from_remote: false });
    }

    #[tokio::test]
    async fn offline_remote_still_creates_from_the_existing_ref() {
        let (td, clone, old, _new) = stale_clone();
        let gone = td.path().join("gone.git");
        sh(&clone, &["remote", "set-url", "origin", gone.to_str().unwrap()]);
        let plan = plan_branch(&clone, &params("feat/offline", false, None)).await.unwrap();
        assert_eq!(plan, BranchPlan { branch: "feat/offline".into(), base: Some("origin/main".into()), from_remote: true });
        let wt = herdr_add(&clone, &plan).await;
        assert_eq!(rev(&wt, "HEAD"), old);
        assert_eq!(upstream(&clone, "feat/offline"), None);
        // a remote branch that was never fetched cannot be a base offline
        assert_eq!(plan_branch(&clone, &params("feat/y", false, Some("origin/unfetched"))).await.unwrap_err().code, "invalid_params");
    }
}
