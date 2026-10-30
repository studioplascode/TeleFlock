//! Which clone on the target is the agent's repository: remotes are compared by URL, normalized so
//! the forms git accepts for one repository compare equal (`git@host:org/repo.git`,
//! `ssh://git@host/org/repo`, `https://host/org/repo`, with or without `.git` or a trailing `/`).

/// A comparable form of a git remote URL: `host/path` for network remotes (scheme, user, the
/// default ssh port, a trailing `.git` and `/` dropped; lowercased), the path for local ones
/// (`file://` dropped, trailing `/` dropped; a `.git` suffix is kept: `x.git` and `x` are
/// different folders).
pub fn normalize(url: &str) -> String {
    let url = url.trim();
    if let Some(path) = url.strip_prefix("file://") {
        return local(path);
    }
    if let Some((scheme, rest)) = url.split_once("://") {
        if scheme.is_empty() || !scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) {
            return local(url);
        }
        let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
        let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
        let host = match host.rsplit_once(':') {
            // `ssh://host:22/…` is `host/…`; another port names another server.
            Some((h, "22")) if scheme.contains("ssh") => h,
            Some((h, port)) if port.is_empty() => h,
            _ => host,
        };
        return network(host, path);
    }
    // scp-like `[user@]host:path`: a colon before any slash (and not a Windows drive letter).
    if let Some((before, path)) = url.split_once(':')
        && !before.is_empty()
        && !before.contains('/')
        && !(before.len() == 1 && before.chars().all(|c| c.is_ascii_alphabetic()))
    {
        let host = before.rsplit_once('@').map_or(before, |(_, h)| h);
        return network(host, path);
    }
    local(url)
}

fn network(host: &str, path: &str) -> String {
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path).trim_end_matches('/');
    format!("{}/{}", host.to_ascii_lowercase(), path.to_ascii_lowercase())
}

fn local(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() { path.to_string() } else { trimmed.to_string() }
}

/// The two URLs name the same repository.
pub fn same_repo(a: &str, b: &str) -> bool {
    let (na, nb) = (normalize(a), normalize(b));
    if na == nb {
        return true;
    }
    // Local remotes: the same folder reached by two spellings (symlinks, `..`).
    match (std::fs::canonicalize(&na), std::fs::canonicalize(&nb)) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => false,
    }
}

/// The repository's name from its URL (`org/app.git` → `app`).
pub fn repo_name(url: &str) -> Option<String> {
    let n = normalize(url);
    let last = n.trim_end_matches('/').rsplit(['/', '\\']).next()?;
    let last = last.strip_suffix(".git").unwrap_or(last);
    (!last.is_empty()).then(|| last.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_repository_in_every_spelling() {
        let forms = [
            "git@github.com:Org/App.git",
            "ssh://git@github.com/org/app",
            "ssh://git@github.com:22/org/app.git",
            "https://github.com/org/app",
            "https://user:token@github.com/org/app.git/",
            "git://github.com/org/app.git",
            "github.com:org/app",
        ];
        for f in forms {
            assert_eq!(normalize(f), "github.com/org/app", "{f}");
        }
        assert!(same_repo(forms[0], forms[3]));
        // another port is another server; another path another repository
        assert_ne!(normalize("ssh://git@github.com:2222/org/app"), "github.com/org/app");
        assert!(!same_repo("git@github.com:org/app.git", "git@github.com:org/app2.git"));
        assert!(!same_repo("git@github.com:org/app.git", "git@gitlab.com:org/app.git"));
    }

    #[test]
    fn local_remotes_keep_their_path() {
        assert_eq!(normalize("/tmp/remote.git/"), "/tmp/remote.git");
        assert_eq!(normalize("file:///tmp/remote.git"), "/tmp/remote.git");
        assert_ne!(normalize("/tmp/x.git"), normalize("/tmp/x"));
        assert_eq!(normalize(r"C:\repos\app.git"), r"C:\repos\app.git");
        assert_eq!(normalize("../up/repo"), "../up/repo");
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("r.git");
        std::fs::create_dir(&real).unwrap();
        let spelled = format!("{}/./r.git", dir.path().display());
        assert!(same_repo(&real.display().to_string(), &spelled));
    }

    #[test]
    fn names() {
        assert_eq!(repo_name("git@github.com:org/App.git").as_deref(), Some("app"));
        assert_eq!(repo_name("/tmp/lab/remote.git").as_deref(), Some("remote"));
        assert_eq!(repo_name("https://host/").as_deref(), Some("host"));
    }
}
