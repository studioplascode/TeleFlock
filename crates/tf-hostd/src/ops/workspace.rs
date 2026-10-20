//! `workspace.*` methods (herdr workspaces) and the herdr → `ApiError` mapping shared with
//! `worktree.*` and `term.*`.

use serde_json::Value;
use tf_herdr::HerdrError;
use tf_proto::{ApiError, Empty, HostMethod, WorkspaceCreateParams, WorkspaceRef};

use crate::clients::ClientHandle;
use crate::ops::fs::resolve_path;
use crate::ops::{herdr_err, to_value, Ctx};

pub async fn handle(ctx: &Ctx, req: HostMethod, _client: &ClientHandle) -> Result<Value, ApiError> {
    match req {
        HostMethod::WorkspaceCreate(p) => to_value(create(ctx, &p).await?),
        HostMethod::WorkspaceRename(p) => {
            let label = p.label.trim();
            if label.is_empty() {
                return Err(ApiError::new("invalid_params", "label is empty"));
            }
            ctx.herdr.workspace_rename(&p.workspace_id, label).await.map_err(map_herdr)?;
            ctx.state.refresh();
            to_value(Empty {})
        }
        HostMethod::WorkspaceClose(p) => {
            ctx.herdr.workspace_close(&p.workspace_id, p.group).await.map_err(map_herdr)?;
            ctx.state.refresh();
            to_value(Empty {})
        }
        other => Err(ApiError::new("unknown_method", format!("{} is not a workspace method", other.name()))),
    }
}

/// Validates `cwd` (herdr silently falls back to `$HOME` for missing paths) and creates an
/// unfocused workspace there.
pub async fn create(ctx: &Ctx, p: &WorkspaceCreateParams) -> Result<WorkspaceRef, ApiError> {
    let cwd = existing_dir(&p.cwd)?;
    let created = ctx
        .herdr
        .workspace_create(&tf_herdr::WorkspaceCreate {
            cwd: Some(cwd),
            label: p.label.as_ref().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()),
            focus: false,
            ..Default::default()
        })
        .await
        .map_err(map_herdr)?;
    ctx.state.refresh();
    Ok(WorkspaceRef { workspace_id: created.workspace.workspace_id })
}

/// Resolves and checks a directory argument, returning its display string.
pub(crate) fn existing_dir(input: &str) -> Result<String, ApiError> {
    let dir = resolve_path(input)?;
    match std::fs::metadata(&dir) {
        Ok(m) if m.is_dir() => Ok(dir.display().to_string()),
        Ok(_) => Err(ApiError::new("invalid_params", format!("{} is not a directory", dir.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            Err(ApiError::new("permission_denied", format!("permission denied: {}", dir.display())))
        }
        Err(_) => Err(ApiError::new("not_found", format!("{} does not exist", dir.display()))),
    }
}

/// herdr errors with workspace/worktree-specific codes and hints. Codes beyond the generic
/// `herdr_error`: `untrusted_repo`, `branch_in_use`, `path_exists`, `dirty_worktree`,
/// `not_git_repo`, `group_close_required`.
pub(crate) fn map_herdr(e: HerdrError) -> ApiError {
    use tf_herdr::code;
    let msg = e.message.clone();
    let lower = msg.to_lowercase();
    let clean = git_message(&msg);
    if lower.contains("dubious ownership") {
        return ApiError::new("untrusted_repo", clean)
            .with_hint("This repository is owned by another user. Retry with “Trust repository” (applies safe.directory to this command only; your git config is not changed).");
    }
    if lower.contains("is already used by worktree") || lower.contains("is already checked out at") {
        let at = msg.rsplit_once(" at ").map(|(_, p)| p.trim().trim_matches('\'').to_string());
        return ApiError::new("branch_in_use", clean).with_hint(match at {
            Some(p) => format!("That branch is checked out in {p}. Pick another branch, or open that worktree instead."),
            None => "That branch is checked out in another worktree. Pick another branch.".to_string(),
        });
    }
    match e.code.as_str() {
        code::DIRTY_WORKTREE_REQUIRES_FORCE => {
            return ApiError::new("dirty_worktree", clean)
                .with_hint("The worktree has uncommitted or untracked files. Remove it with “force” to discard them (the branch is kept).");
        }
        code::NOT_GIT_WORKTREE => {
            return ApiError::new("not_git_repo", clean).with_hint("Pick a folder inside a git repository.");
        }
        code::WORKSPACE_GROUP_CLOSE_REQUIRED => {
            return ApiError::new("group_close_required", clean)
                .with_hint("This repository workspace has linked worktree workspaces. Close the whole group.");
        }
        code::WORKTREE_CREATE_FAILED if lower.contains("already exists") => {
            return ApiError::new("path_exists", clean).with_hint("The checkout folder already exists. Choose another path or branch name.");
        }
        code::WORKTREE_CREATE_FAILED if lower.contains("invalid reference") || lower.contains("not a valid object name") => {
            return ApiError::new("invalid_params", clean).with_hint("The base ref does not exist in this repository.");
        }
        _ => {}
    }
    herdr_err(e)
}

/// git's last `fatal:`/`error:` line without the prefix (herdr forwards raw git stderr).
fn git_message(msg: &str) -> String {
    msg.lines()
        .rev()
        .find_map(|l| l.strip_prefix("fatal: ").or_else(|| l.strip_prefix("error: ")))
        .unwrap_or(msg.lines().next().unwrap_or(msg))
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn he(code: &str, message: &str) -> HerdrError {
        HerdrError { code: code.into(), message: message.into() }
    }

    #[test]
    fn maps_herdr_samples() {
        // docs/research/herdr-samples/error-worktree-*.json
        let e = map_herdr(he("worktree_create_failed", "Preparing worktree (checking out 'main')\nfatal: 'main' is already used by worktree at '/tmp/tf-lab-repo'"));
        assert_eq!(e.code, "branch_in_use");
        assert_eq!(e.message, "'main' is already used by worktree at '/tmp/tf-lab-repo'");
        assert!(e.hint.unwrap().contains("/tmp/tf-lab-repo"));
        let e = map_herdr(he("worktree_list_failed", "fatal: detected dubious ownership in repository at '/tmp/tf-lab-repo2'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory /tmp/tf-lab-repo2"));
        assert_eq!(e.code, "untrusted_repo");
        assert_eq!(e.message, "detected dubious ownership in repository at '/tmp/tf-lab-repo2'");
        let e = map_herdr(he("dirty_worktree_requires_force", "fatal: '/root/.herdr/worktrees/tf-lab-repo/feat-y' contains modified or untracked files, use --force to delete it"));
        assert_eq!(e.code, "dirty_worktree");
        assert_eq!(map_herdr(he("not_git_worktree", "Herdr worktree actions require a path inside a Git work tree")).code, "not_git_repo");
        assert_eq!(map_herdr(he("workspace_group_close_required", "workspace has linked worktree workspaces; use --group")).code, "group_close_required");
        assert_eq!(map_herdr(he("worktree_create_failed", "fatal: '/x/feat-x' already exists")).code, "path_exists");
        assert_eq!(map_herdr(he("workspace_not_found", "no workspace w9")).code, "not_found");
    }

    #[test]
    fn existing_dir_checks() {
        assert_eq!(existing_dir("/definitely/missing").unwrap_err().code, "not_found");
        let f = tempfile::NamedTempFile::new().unwrap();
        assert_eq!(existing_dir(&f.path().display().to_string()).unwrap_err().code, "invalid_params");
        assert!(existing_dir("~").is_ok());
    }
}
