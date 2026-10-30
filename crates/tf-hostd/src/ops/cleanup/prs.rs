//! Pull requests of worktree branches, through the GitHub CLI (`gh pr view`), as the board's
//! cards ask `gh.prStatus`: in the checkout, or by branch name from the main worktree when the
//! checkout is gone.

use std::path::Path;
use std::time::Duration;

use serde_json::Value;
use tf_proto::{CleanupPr, Millis};

use crate::ops::gh;

const FIELDS: &str = "number,url,title,state,isDraft,mergedAt,closedAt,headRefOid";
const TIMEOUT: Duration = Duration::from_secs(45);

const MIN: Duration = Duration::from_secs(60);

/// How long an answer holds (as the board's cards: settled ones rarely change).
pub(crate) fn ttl(found: &Result<Option<CleanupPr>, String>) -> Duration {
    match found {
        Ok(Some(pr)) if pr.state == "MERGED" || pr.state == "CLOSED" => 30 * MIN,
        Ok(Some(_)) => 5 * MIN,
        Ok(None) => 10 * MIN,
        Err(_) => 2 * MIN,
    }
}

/// One lookup's outcome.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Lookup {
    /// gh answered: the branch's pull request, or none.
    Found(Option<CleanupPr>),
    /// gh can't answer anything on this host (not installed, signed out).
    GhDown(String),
    /// This repository has no GitHub remote.
    NotGithub(String),
    /// This lookup failed.
    Failed(String),
}

/// `gh pr view [<branch>] --json …` in `dir`. `head` (the worktree's HEAD, a full or abbreviated
/// commit) keeps a settled pull request of an earlier use of the same branch name from being shown
/// as this worktree's: a merged or closed one only counts when its head commit is the worktree's.
pub(crate) async fn lookup(dir: &Path, branch: Option<&str>, head: Option<&str>) -> Lookup {
    let mut args = vec!["pr", "view"];
    if let Some(b) = branch {
        // gh reads a purely numeric argument as a pull request number, not a branch.
        if b.chars().all(|c| c.is_ascii_digit()) {
            return Lookup::Found(None);
        }
        args.push(b);
    }
    args.extend(["--json", FIELDS]);
    let out = match gh::gh(dir, &args, TIMEOUT).await {
        Ok(out) => out,
        Err(e) if e.message.contains("not installed") => return Lookup::GhDown(e.message),
        Err(e) => return Lookup::Failed(e.message),
    };
    if out.ok() {
        return match serde_json::from_slice::<Value>(&out.stdout) {
            Ok(v) => Lookup::Found(parse(&v).filter(|pr| is_this_head(&v, &pr.state, head))),
            Err(e) => Lookup::Failed(format!("unexpected gh output: {e}")),
        };
    }
    if gh::is_no_pr(&out) {
        return Lookup::Found(None);
    }
    failure(&out.message())
}

/// A merged or closed pull request whose head commit is not `head` belongs to an earlier use of
/// the branch name. Open ones, and answers without either commit, are taken as they are.
fn is_this_head(v: &Value, state: &str, head: Option<&str>) -> bool {
    if state != "MERGED" && state != "CLOSED" {
        return true;
    }
    let (Some(head), Some(oid)) = (head.filter(|h| !h.is_empty()), v.get("headRefOid").and_then(Value::as_str)) else {
        return true;
    };
    oid.starts_with(head) || head.starts_with(oid)
}

/// A failed `gh pr view`, by its message. gh's "no GitHub remote" message also names `gh auth
/// login` (to add a host), so it is told apart first: it concerns one repository, not the host.
pub(crate) fn failure(msg: &str) -> Lookup {
    let lower = msg.to_lowercase();
    let msg = msg.trim().lines().next().unwrap_or_default().to_string();
    if lower.contains("none of the git remotes")
        || lower.contains("no git remotes")
        || lower.contains("not a github")
    {
        Lookup::NotGithub("no GitHub remote".into())
    } else if lower.contains("gh auth login")
        || lower.contains("not logged into")
        || lower.contains("http 401")
        || lower.contains("authentication")
    {
        Lookup::GhDown(if msg.is_empty() {
            "gh is not signed in".into()
        } else {
            msg
        })
    } else {
        Lookup::Failed(if msg.is_empty() {
            "gh failed".into()
        } else {
            msg
        })
    }
}

/// `gh pr view --json number,url,title,state,isDraft,mergedAt,closedAt`.
pub(crate) fn parse(v: &Value) -> Option<CleanupPr> {
    let state = v
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("OPEN")
        .to_string();
    let time = |key: &str| -> Option<Millis> {
        v.get(key)
            .and_then(Value::as_str)
            .and_then(|s| s.parse::<jiff::Timestamp>().ok())
            .map(|t| t.as_millisecond())
    };
    Some(CleanupPr {
        number: v.get("number")?.as_u64()? as u32,
        url: v.get("url")?.as_str()?.to_string(),
        title: v
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        closed_at: match state.as_str() {
            "MERGED" => time("mergedAt").or_else(|| time("closedAt")),
            "CLOSED" => time("closedAt"),
            _ => None,
        },
        draft: v.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        state,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_settled_and_open_prs() {
        let merged = parse(&json!({
            "number": 96, "url": "https://github.com/o/r/pull/96", "title": "Kanban", "state": "MERGED", "isDraft": false,
            "mergedAt": "2026-10-20T12:00:00Z", "closedAt": "2026-10-20T12:00:00Z"
        }))
        .unwrap();
        assert_eq!(
            (merged.number, merged.state.as_str(), merged.closed_at),
            (96, "MERGED", Some(1_792_497_600_000))
        );
        let closed = parse(&json!({"number": 3, "url": "u", "title": "", "state": "CLOSED", "isDraft": true, "mergedAt": null, "closedAt": "2026-10-01T00:00:00Z"})).unwrap();
        assert_eq!(
            (
                closed.state.as_str(),
                closed.draft,
                closed.closed_at.is_some()
            ),
            ("CLOSED", true, true)
        );
        let open = parse(&json!({"number": 4, "url": "u", "title": "t", "state": "OPEN", "isDraft": false, "mergedAt": null, "closedAt": null})).unwrap();
        assert_eq!((open.state.as_str(), open.closed_at), ("OPEN", None));
        assert_eq!(parse(&json!({"url": "u"})), None);
    }

    #[test]
    fn failures_by_cause() {
        assert!(matches!(
            failure("To get started with GitHub CLI, please run:  gh auth login"),
            Lookup::GhDown(_)
        ));
        assert_eq!(
            failure(
                "none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`"
            ),
            Lookup::NotGithub("no GitHub remote".into()),
            "one repository without a GitHub remote must not stop the lookups of the others"
        );
        assert_eq!(
            failure("no git remotes found"),
            Lookup::NotGithub("no GitHub remote".into())
        );
        assert_eq!(
            failure("GraphQL: Something went wrong\nmore"),
            Lookup::Failed("GraphQL: Something went wrong".into())
        );
    }

    #[test]
    fn answers_hold_by_state() {
        let pr = |state: &str| {
            Ok(Some(CleanupPr {
                number: 1,
                url: "u".into(),
                title: String::new(),
                state: state.into(),
                draft: false,
                closed_at: None,
            }))
        };
        assert_eq!(ttl(&pr("MERGED")), 30 * MIN);
        assert_eq!(ttl(&pr("CLOSED")), 30 * MIN);
        assert_eq!(ttl(&pr("OPEN")), 5 * MIN);
        assert_eq!(ttl(&Ok(None)), 10 * MIN);
        assert_eq!(ttl(&Err("x".into())), 2 * MIN);
    }

    #[test]
    fn a_settled_pr_must_end_at_the_worktrees_head() {
        let v = json!({ "headRefOid": "abcdef0123456789" });
        assert!(is_this_head(&v, "MERGED", Some("abcdef0")));
        assert!(!is_this_head(&v, "MERGED", Some("1234567")), "an old PR of a reused branch name");
        assert!(!is_this_head(&v, "CLOSED", Some("1234567")));
        // Open ones, and answers without a commit on either side, stand.
        assert!(is_this_head(&v, "OPEN", Some("1234567")));
        assert!(is_this_head(&v, "MERGED", None));
        assert!(is_this_head(&json!({}), "MERGED", Some("1234567")));
    }
}
