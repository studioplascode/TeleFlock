//! `gh.*` methods: pull request status, create and merge through the GitHub CLI; its sign-in
//! (`gh.authStatus`, `gh.authStart`) lives in [`crate::ops::gh_auth`].

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;
use tf_proto::{ApiError, ChecksSummary, Empty, HostMethod, MergeMethod, PrCreateParams, PrInfo, PrMergeParams, PrStatusResult};

use crate::clients::ClientHandle;
use crate::ops::fs::resolve_path;
use crate::ops::git::{self, CmdOut};
use crate::ops::gh_auth;
use crate::ops::{to_value, Ctx};

const PR_FIELDS: &str = "number,url,title,state,isDraft,mergeable,statusCheckRollup,mergeStateStatus,baseRefName";
const GH_TIMEOUT: Duration = Duration::from_secs(60);
const GH_SLOW: Duration = Duration::from_secs(180);

pub async fn handle(ctx: &Ctx, req: HostMethod, _client: &ClientHandle) -> Result<Value, ApiError> {
    match req {
        HostMethod::GhPrStatus(p) => to_value(pr_status(&resolve_path(&p.cwd)?).await?),
        HostMethod::GhPrCreate(p) => to_value(pr_create(&p).await?),
        HostMethod::GhPrMerge(p) => to_value(pr_merge(&p).await?),
        HostMethod::GhAuthStatusReq(_) => to_value(gh_auth::auth_status(ctx).await?),
        HostMethod::GhAuthStart(p) => to_value(gh_auth::auth_start(ctx, p).await?),
        other => Err(ApiError::new("unknown_method", format!("{} is not a gh method", other.name()))),
    }
}

fn gh_bin() -> Result<PathBuf, ApiError> {
    git::resolve_bin("gh").ok_or_else(gh_auth::no_gh)
}

pub(crate) async fn gh(cwd: &Path, args: &[&str], timeout: Duration) -> Result<CmdOut, ApiError> {
    let bin = gh_bin()?;
    let env = [("GH_PROMPT_DISABLED", "1"), ("GH_NO_UPDATE_NOTIFIER", "1"), ("NO_COLOR", "1"), ("GIT_TERMINAL_PROMPT", "0"), ("LC_ALL", "C")];
    git::run_cmd(&bin, args, Some(cwd), &env, None, timeout).await.map_err(|e| match e.kind() {
        std::io::ErrorKind::TimedOut => ApiError::new("timeout", format!("gh {} timed out", args.first().unwrap_or(&""))).retryable(),
        _ => ApiError::new("gh_error", format!("failed to run gh: {e}")),
    })
}

/// Maps a failed gh run to `gh_error` with a hint for the common causes.
pub(crate) fn gh_failure(out: &CmdOut) -> ApiError {
    let msg = out.message();
    let lower = msg.to_lowercase();
    let err = ApiError::new("gh_error", if msg.is_empty() { format!("gh failed (exit {})", out.code) } else { msg.clone() });
    if lower.contains("gh auth login") || lower.contains("not logged into") || lower.contains("authentication") || lower.contains("http 401") {
        err.with_hint("gh is not signed in on this host. Sign in from Host setup in the app (or run `gh auth login` on the host, or set GH_TOKEN for the daemon).")
    } else if lower.contains("not a git repository") {
        err.with_hint("This folder is not inside a git repository.")
    } else if lower.contains("none of the git remotes") || lower.contains("no git remotes") || lower.contains("could not determine") {
        err.with_hint("This repository has no GitHub remote. Add one with `git remote add origin <url>`.")
    } else if lower.contains("must first push") || lower.contains("push the current branch") || lower.contains("no commits between") {
        err.with_hint("Push the branch (with at least one commit beyond the base) before creating a pull request.")
    } else if lower.contains("already exists") {
        err.with_hint("A pull request for this branch already exists.")
    } else if lower.contains("not mergeable") || lower.contains("merge conflict") {
        err.with_hint("The pull request has conflicts or failing required checks.")
    } else if lower.contains("could not resolve to a pullrequest") || lower.contains("no pull requests found") {
        err.with_hint("There is no pull request for this branch yet.")
    } else {
        err
    }
}

pub(crate) fn is_no_pr(out: &CmdOut) -> bool {
    let m = out.message().to_lowercase();
    m.contains("no pull requests found") || m.contains("could not resolve to a pullrequest") || m.contains("no open pull requests")
}

/// Parses `gh pr view --json` with [`PR_FIELDS`].
pub(crate) fn parse_pr(v: &Value) -> Option<PrInfo> {
    let mergeable = match v.get("mergeable").and_then(Value::as_str) {
        Some("MERGEABLE") => Some(true),
        Some("CONFLICTING") => Some(false),
        _ => None,
    };
    let checks = v.get("statusCheckRollup").and_then(Value::as_array).filter(|a| !a.is_empty()).map(|items| {
        let mut s = ChecksSummary { passed: 0, failed: 0, pending: 0 };
        for it in items {
            // CheckRun: status + conclusion; StatusContext: state.
            let conclusion = it.get("conclusion").and_then(Value::as_str).unwrap_or("");
            let status = it.get("status").and_then(Value::as_str).unwrap_or("");
            let state = it.get("state").and_then(Value::as_str).unwrap_or("");
            let verdict = if !state.is_empty() { state } else if status == "COMPLETED" || !conclusion.is_empty() { conclusion } else { "PENDING" };
            match verdict {
                "SUCCESS" | "NEUTRAL" | "SKIPPED" => s.passed += 1,
                "FAILURE" | "ERROR" | "CANCELLED" | "TIMED_OUT" | "ACTION_REQUIRED" | "STARTUP_FAILURE" | "STALE" => s.failed += 1,
                _ => s.pending += 1,
            }
        }
        s
    });
    Some(PrInfo {
        number: v.get("number")?.as_u64()? as u32,
        url: v.get("url")?.as_str()?.to_string(),
        title: v.get("title").and_then(Value::as_str).unwrap_or_default().to_string(),
        state: v.get("state").and_then(Value::as_str).unwrap_or("OPEN").to_string(),
        draft: v.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        mergeable,
        checks,
        merge_state: v.get("mergeStateStatus").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string),
        base_ref: v.get("baseRefName").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string),
    })
}

async fn view(cwd: &Path, selector: Option<&str>) -> Result<Option<PrInfo>, ApiError> {
    let mut args = vec!["pr", "view"];
    if let Some(s) = selector {
        args.push(s);
    }
    args.extend(["--json", PR_FIELDS]);
    let out = gh(cwd, &args, GH_TIMEOUT).await?;
    if !out.ok() {
        return if is_no_pr(&out) { Ok(None) } else { Err(gh_failure(&out)) };
    }
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| ApiError::new("gh_error", format!("unexpected gh output: {e}")))?;
    Ok(parse_pr(&v))
}

pub async fn pr_status(cwd: &Path) -> Result<PrStatusResult, ApiError> {
    let root = git::toplevel(cwd).await?;
    Ok(PrStatusResult { pr: view(&root, None).await? })
}

pub async fn pr_create(p: &PrCreateParams) -> Result<PrInfo, ApiError> {
    if p.title.trim().is_empty() {
        return Err(ApiError::new("invalid_params", "pull request title is empty"));
    }
    let root = git::toplevel(&resolve_path(&p.cwd)?).await?;
    let mut args = vec!["pr", "create", "--title", p.title.trim(), "--body", p.body.as_str()];
    if p.draft {
        args.push("--draft");
    }
    if let Some(base) = p.base.as_deref().filter(|b| !b.trim().is_empty()) {
        args.extend(["--base", base]);
    }
    let out = gh(&root, &args, GH_SLOW).await?;
    if !out.ok() {
        return Err(gh_failure(&out));
    }
    // gh prints the new PR URL as the last stdout line.
    let stdout = out.stdout_str();
    let url = stdout.lines().rev().map(str::trim).find(|l| l.starts_with("http")).map(str::to_string);
    match view(&root, url.as_deref()).await? {
        Some(pr) => Ok(pr),
        None => Err(ApiError::new("gh_error", "the pull request was created but could not be read back").with_hint(url.unwrap_or_default())),
    }
}

pub async fn pr_merge(p: &PrMergeParams) -> Result<Empty, ApiError> {
    let root = git::toplevel(&resolve_path(&p.cwd)?).await?;
    let method = match p.method {
        MergeMethod::Merge => "--merge",
        MergeMethod::Squash => "--squash",
        MergeMethod::Rebase => "--rebase",
    };
    let mut args = vec!["pr", "merge", method];
    if p.delete_branch {
        args.push("--delete-branch");
    }
    let out = gh(&root, &args, GH_SLOW).await?;
    if !out.ok() {
        let mut err = gh_failure(&out);
        let lower = err.message.to_lowercase();
        // In a linked worktree, gh cannot switch the local checkout to the base branch
        // after deleting; the remote merge itself already succeeded in that case.
        if p.delete_branch && (lower.contains("is already used by worktree") || lower.contains("already checked out")) {
            err.hint = Some("The PR was merged, but the local branch could not be deleted because it is checked out in a worktree. Remove the worktree to finish.".into());
        }
        return Err(err);
    }
    Ok(Empty {})
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_pr_view_json() {
        let v = json!({
            "number": 42, "url": "https://github.com/o/r/pull/42", "title": "Add thing", "state": "OPEN",
            "isDraft": true, "mergeable": "CONFLICTING", "mergeStateStatus": "DIRTY", "baseRefName": "main",
            "statusCheckRollup": [
                {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS"},
                {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "FAILURE"},
                {"__typename": "CheckRun", "status": "IN_PROGRESS", "conclusion": ""},
                {"__typename": "StatusContext", "state": "SUCCESS"},
                {"__typename": "StatusContext", "state": "PENDING"},
                {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SKIPPED"}
            ]
        });
        let pr = parse_pr(&v).unwrap();
        assert_eq!(pr.number, 42);
        assert!(pr.draft);
        assert_eq!(pr.mergeable, Some(false));
        assert_eq!((pr.merge_state.as_deref(), pr.base_ref.as_deref()), (Some("DIRTY"), Some("main")));
        assert_eq!(pr.checks, Some(ChecksSummary { passed: 3, failed: 1, pending: 2 }));
        let none = parse_pr(&json!({"number": 1, "url": "u", "title": "t", "state": "MERGED", "isDraft": false, "mergeable": "UNKNOWN", "statusCheckRollup": []})).unwrap();
        assert_eq!((none.mergeable, none.checks, none.merge_state, none.base_ref), (None, None, None, None));
    }

    #[test]
    fn failure_hints() {
        let out = |s: &str| CmdOut { code: 1, stdout: vec![], stderr: s.into() };
        assert!(gh_failure(&out("To get started with GitHub CLI, please run:  gh auth login")).hint.unwrap().contains("gh auth login"));
        assert!(is_no_pr(&out("no pull requests found for branch \"feat\"")));
        assert!(gh_failure(&out("aborted: you must first push the current branch to a remote, or use the --head flag")).hint.is_some());
    }

    #[tokio::test]
    async fn status_without_github_remote_is_gh_error() {
        if git::resolve_bin("gh").is_none() {
            return;
        }
        let td = crate::ops::git::tests::fixture();
        let err = pr_status(td.path()).await.unwrap_err();
        assert_eq!(err.code, "gh_error");
    }
}
