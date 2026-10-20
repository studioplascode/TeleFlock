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
            return Ok(BranchPlan { branch: branch.to_string(), base: None });
        }
        // A remote branch (`origin/x`, or `x` that only exists on origin): create the local
        // tracking branch from it.
        let remotes = git::git(root, &["remote"], QUICK).await.map(|o| o.stdout_str()).unwrap_or_default();
        for remote in remotes.lines().filter(|r| !r.is_empty()) {
            if let Some(short) = branch.strip_prefix(&format!("{remote}/"))
                && ref_exists(root, &format!("refs/remotes/{branch}")).await {
                    if ref_exists(root, &format!("refs/heads/{short}")).await {
                        return Ok(BranchPlan { branch: short.to_string(), base: None });
                    }
                    return Ok(BranchPlan { branch: short.to_string(), base: Some(branch.to_string()) });
                }
        }
        for remote in ["origin"].into_iter().chain(remotes.lines().filter(|r| !r.is_empty() && *r != "origin")) {
            let full = format!("{remote}/{branch}");
            if ref_exists(root, &format!("refs/remotes/{full}")).await {
                return Ok(BranchPlan { branch: branch.to_string(), base: Some(full) });
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
    let base = p.base.as_deref().map(str::trim).filter(|b| !b.is_empty()).map(str::to_string);
    if let Some(b) = &base
        && !ref_exists(root, b).await {
            return Err(ApiError::new("invalid_params", format!("base ref `{b}` does not exist")));
        }
    Ok(BranchPlan { branch: branch.to_string(), base })
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
    // Untrusted repos cannot be inspected with plain git; let herdr do the work then.
    let plan = if p.trust && !git::git(&root, &["rev-parse", "--git-dir"], QUICK).await.map(|o| o.ok()).unwrap_or(false) {
        BranchPlan { branch: p.branch.trim().to_string(), base: p.base.clone() }
    } else {
        plan_branch(&root, &p).await?
    };
    let path = match p.path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => Some(resolve_path(s)?.display().to_string()),
        None => None,
    };
    let mut req = tf_herdr::WorktreeCreate::new(tf_herdr::WorktreeScope::Cwd(cwd));
    req.branch = Some(plan.branch.clone());
    req.base = plan.base;
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

        assert_eq!(plan_branch(root, &params("feat", true, None)).await.unwrap(), BranchPlan { branch: "feat".into(), base: None });
        assert_eq!(
            plan_branch(root, &params("remote-only", true, None)).await.unwrap(),
            BranchPlan { branch: "remote-only".into(), base: Some("origin/remote-only".into()) }
        );
        assert_eq!(
            plan_branch(root, &params("origin/remote-only", true, None)).await.unwrap(),
            BranchPlan { branch: "remote-only".into(), base: Some("origin/remote-only".into()) }
        );
        assert_eq!(plan_branch(root, &params("nope", true, None)).await.unwrap_err().code, "not_found");
        assert_eq!(plan_branch(root, &params("feat", false, None)).await.unwrap_err().code, "branch_exists");
        assert_eq!(plan_branch(root, &params("bad..name", false, None)).await.unwrap_err().code, "invalid_params");
        assert_eq!(plan_branch(root, &params("new/x", false, Some("nosuchref"))).await.unwrap_err().code, "invalid_params");
        assert_eq!(
            plan_branch(root, &params("new/x", false, Some("main"))).await.unwrap(),
            BranchPlan { branch: "new/x".into(), base: Some("main".into()) }
        );
    }
}
