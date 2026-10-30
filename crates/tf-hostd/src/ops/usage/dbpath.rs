//! Where omp keeps its stats index (`getStatsDbPath()`): a port of the parts of omp 18.13.3's
//! `pi-utils` `dirs.ts` and `env.ts` that decide it.
//!
//! - Config root: `$HOME/<PI_CONFIG_DIR or .omp>`, `/profiles/<name>` for a named profile
//!   (`OMP_PROFILE`, else `PI_PROFILE`; an invalid name falls back to the default profile).
//! - Agent dir: the profile's `agent/`, else `PI_CODING_AGENT_DIR` (unless that is just the
//!   `PI_PROFILE` profile's own agent dir), else `<config root>/agent`.
//! - XDG (Linux, macOS): with the default agent dir and `XDG_DATA_HOME` set, the data root is
//!   `$XDG_DATA_HOME/omp` (`…/omp/profiles/<name>` for a profile) once that directory exists.
//! - `stats.db` lives in the data root.
//!
//! omp resolves once from its environment, then overlays the dotenv files `<cwd>/.env`,
//! `<agent dir>/.env`, `<config root>/.env` and `~/.env` (earlier files win; a variable already
//! set and non-empty is kept, `OMP_X` also sets `PI_X`) and resolves again with the same profile.
//! hostd runs `omp stats` in an empty directory of its own, so there is no project `.env` (nor one
//! for Bun's dotenv autoload), and resolves with that same directory.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

/// omp's stats database for this environment, home directory and working directory.
pub(crate) fn stats_db_path(env: &HashMap<String, String>, home: &Path, cwd: &Path) -> PathBuf {
    let first = Resolved::new(env, home, cwd);
    let mut env = env.clone();
    // env.ts: project, agent, config root, home; each fills only what is still unset or empty.
    for file in [cwd.join(".env"), first.agent_dir.join(".env"), first.config_root.join(".env"), home.join(".env")] {
        let Ok(text) = std::fs::read_to_string(&file) else { continue };
        for (k, v) in dotenv(&text) {
            if env.get(&k).is_none_or(|cur| cur.is_empty()) {
                env.insert(k, v);
            }
        }
    }
    // refreshDirsFromEnv(): directory variables from the dotenv files apply; the profile stays.
    Resolved::with_profile(&env, home, cwd, first.profile).data_root.join("stats.db")
}

struct Resolved {
    profile: Option<String>,
    config_root: PathBuf,
    agent_dir: PathBuf,
    data_root: PathBuf,
}

impl Resolved {
    fn new(env: &HashMap<String, String>, home: &Path, cwd: &Path) -> Self {
        // `OMP_PROFILE` when defined at all (an empty one selects the default), else `PI_PROFILE`.
        let raw = env.get("OMP_PROFILE").or_else(|| env.get("PI_PROFILE"));
        Self::with_profile(env, home, cwd, raw.and_then(|p| profile_name(p)))
    }

    fn with_profile(env: &HashMap<String, String>, home: &Path, cwd: &Path, profile: Option<String>) -> Self {
        let get = |k: &str| env.get(k).map(String::as_str).filter(|v| !v.is_empty());
        let base_root = node_join(home, get("PI_CONFIG_DIR").unwrap_or(".omp"));
        let profile_agent_dir = |p: &str| base_root.join("profiles").join(p).join("agent");
        // resolvePreProfileAgentDir: an override equal to the PI_PROFILE profile's agent dir was
        // propagated by a parent's setProfile and is not the default profile's own override.
        let override_dir = match &profile {
            Some(_) => None,
            None => get("PI_CODING_AGENT_DIR").filter(|dir| {
                let derived = get("PI_PROFILE").and_then(profile_name).map(|p| profile_agent_dir(&p));
                derived.is_none_or(|d| d.as_os_str() != *dir)
            }),
        };
        let config_root = match &profile {
            Some(p) => base_root.join("profiles").join(p),
            None => base_root.clone(),
        };
        let default_agent = config_root.join("agent");
        let agent_dir = override_dir.map(|d| node_resolve(cwd, d)).unwrap_or_else(|| default_agent.clone());
        let mut data_root = None;
        if cfg!(any(target_os = "linux", target_os = "macos")) && agent_dir == default_agent
            && let Some(xdg) = get("XDG_DATA_HOME")
        {
            let app_root = node_resolve(cwd, xdg).join("omp");
            let candidate = match &profile {
                Some(p) => app_root.join("profiles").join(p),
                None => app_root,
            };
            if candidate.exists() {
                data_root = Some(candidate);
            }
        }
        Self { profile, data_root: data_root.unwrap_or_else(|| config_root.clone()), config_root, agent_dir }
    }
}

/// `normalizeProfileName`: trimmed, `""` / `default` → the default profile; names omp refuses
/// (it fails to start with them) also mean the default here.
fn profile_name(raw: &str) -> Option<String> {
    let p = raw.trim();
    if p.is_empty() || p == "default" || p == "." || p == ".." || p.ends_with('.') || p.len() > 64 {
        return None;
    }
    let mut chars = p.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let rest_ok = chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'));
    if !first_ok || !rest_ok || is_windows_reserved(p) {
        return None;
    }
    Some(p.to_string())
}

fn is_windows_reserved(name: &str) -> bool {
    let base = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((base.starts_with("COM") || base.starts_with("LPT")) && base.len() == 4 && base.as_bytes()[3].is_ascii_digit())
}

/// Node's `path.join(base, rel)`: `rel` is appended even when absolute, then normalized.
fn node_join(base: &Path, rel: &str) -> PathBuf {
    let mut out = base.to_path_buf();
    for part in rel.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            p => out.push(p),
        }
    }
    normalize(&out)
}

/// Node's `path.resolve(cwd, p)`.
fn node_resolve(cwd: &Path, p: &str) -> PathBuf {
    let p = Path::new(p);
    if p.is_absolute() { normalize(p) } else { normalize(&cwd.join(p)) }
}

/// Lexical `.` / `..` removal (no symlinks are followed, like Node).
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The variables of a dotenv file as omp keeps them (`parseEnvFile`): shell-identifier names,
/// values without NUL, and `OMP_X` mirrored to `PI_X`. Grammar of Node's `util.parseEnv`:
/// `KEY=value` lines, optional `export `, `#` comments (in unquoted values everything from the
/// first `#`), single, double or backtick quotes (double quotes expand `\n`), multi-line quotes.
pub(crate) fn dotenv(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut rest = text;
    while !rest.is_empty() {
        let (line, after) = rest.split_once('\n').unwrap_or((rest, ""));
        rest = after;
        let line = line.trim_start();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").map(str::trim_start).unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = key.trim();
        let value = value.trim_start();
        let v = match value.chars().next() {
            Some(q @ ('"' | '\'' | '`')) => {
                let body = &value[1..];
                let raw = match body.find(q) {
                    Some(end) => body[..end].to_string(),
                    None => {
                        // Multi-line: the value runs to the closing quote on a later line.
                        let joined = format!("{body}\n{rest}");
                        match joined.find(q) {
                            Some(end) => {
                                let in_rest = end - (body.len() + 1);
                                rest = rest[in_rest..].split_once('\n').map(|(_, a)| a).unwrap_or("");
                                joined[..end].to_string()
                            }
                            // Never closed: the line as written.
                            None => value.trim_end().to_string(),
                        }
                    }
                };
                if q == '"' { raw.replace("\\n", "\n") } else { raw }
            }
            _ => value.split('#').next().unwrap_or("").trim_end().to_string(),
        };
        let valid_key = key.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if valid_key && !v.contains('\0') {
            out.insert(key.to_string(), v);
        }
    }
    let mirrored: Vec<(String, String)> = out.iter().filter_map(|(k, v)| k.strip_prefix("OMP_").map(|s| (format!("PI_{s}"), v.clone()))).collect();
    out.extend(mirrored);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn default_is_the_config_root() {
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        assert_eq!(stats_db_path(&env(&[]), home.path(), cwd.path()), home.path().join(".omp/stats.db"));
        // PI_CODING_AGENT_DIR moves the agent dir, never the config root (and disables XDG).
        let e = env(&[("PI_CODING_AGENT_DIR", "/elsewhere/agent"), ("XDG_DATA_HOME", "/nope")]);
        assert_eq!(stats_db_path(&e, home.path(), cwd.path()), home.path().join(".omp/stats.db"));
    }

    #[test]
    fn config_dir_and_profiles() {
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let h = home.path();
        assert_eq!(stats_db_path(&env(&[("PI_CONFIG_DIR", ".omp-dev")]), h, cwd.path()), h.join(".omp-dev/stats.db"));
        // path.join semantics: an absolute PI_CONFIG_DIR still lands under home.
        assert_eq!(stats_db_path(&env(&[("PI_CONFIG_DIR", "/abs/x")]), h, cwd.path()), h.join("abs/x/stats.db"));
        assert_eq!(stats_db_path(&env(&[("OMP_PROFILE", "work")]), h, cwd.path()), h.join(".omp/profiles/work/stats.db"));
        assert_eq!(stats_db_path(&env(&[("PI_PROFILE", "work")]), h, cwd.path()), h.join(".omp/profiles/work/stats.db"));
        // An explicitly empty OMP_PROFILE selects the default profile over PI_PROFILE.
        assert_eq!(stats_db_path(&env(&[("OMP_PROFILE", ""), ("PI_PROFILE", "work")]), h, cwd.path()), h.join(".omp/stats.db"));
        assert_eq!(stats_db_path(&env(&[("OMP_PROFILE", "default")]), h, cwd.path()), h.join(".omp/stats.db"));
        // Names omp refuses fall back to the default profile.
        for bad in ["Work", "-x", "a.", "con", "lpt1.txt", "a b"] {
            assert_eq!(stats_db_path(&env(&[("OMP_PROFILE", bad)]), h, cwd.path()), h.join(".omp/stats.db"), "{bad}");
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn xdg_data_home_once_migrated() {
        let home = tempfile::tempdir().unwrap();
        let xdg = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let h = home.path();
        let e = env(&[("XDG_DATA_HOME", xdg.path().to_str().unwrap())]);
        // Not migrated yet ($XDG_DATA_HOME/omp missing): the config root.
        assert_eq!(stats_db_path(&e, h, cwd.path()), h.join(".omp/stats.db"));
        std::fs::create_dir_all(xdg.path().join("omp")).unwrap();
        assert_eq!(stats_db_path(&e, h, cwd.path()), xdg.path().join("omp/stats.db"));
        // A profile follows its own XDG directory only.
        let mut p = e.clone();
        p.insert("OMP_PROFILE".into(), "work".into());
        assert_eq!(stats_db_path(&p, h, cwd.path()), h.join(".omp/profiles/work/stats.db"));
        std::fs::create_dir_all(xdg.path().join("omp/profiles/work")).unwrap();
        assert_eq!(stats_db_path(&p, h, cwd.path()), xdg.path().join("omp/profiles/work/stats.db"));
        // A custom agent dir turns XDG off; the profile's own agent dir (propagated through
        // PI_CODING_AGENT_DIR by a parent's setProfile) does not count as custom.
        let mut c = e.clone();
        c.insert("PI_CODING_AGENT_DIR".into(), "/somewhere/agent".into());
        assert_eq!(stats_db_path(&c, h, cwd.path()), h.join(".omp/stats.db"));
        let mut d = e.clone();
        d.insert("PI_PROFILE".into(), "work".into());
        d.insert("OMP_PROFILE".into(), String::new());
        d.insert("PI_CODING_AGENT_DIR".into(), h.join(".omp/profiles/work/agent").display().to_string());
        assert_eq!(stats_db_path(&d, h, cwd.path()), xdg.path().join("omp/stats.db"));
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn dotenv_files_fill_unset_variables() {
        let home = tempfile::tempdir().unwrap();
        let xdg = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let h = home.path();
        std::fs::create_dir_all(xdg.path().join("omp")).unwrap();
        // ~/.env sets XDG_DATA_HOME (as OMP_ → PI_ mirroring shows, any key may come from there).
        std::fs::write(h.join(".env"), format!("# omp\nexport XDG_DATA_HOME=\"{}\"\n", xdg.path().display())).unwrap();
        assert_eq!(stats_db_path(&env(&[]), h, cwd.path()), xdg.path().join("omp/stats.db"));
        // A value already set in the environment wins; an empty one does not.
        let other = tempfile::tempdir().unwrap();
        let set = env(&[("XDG_DATA_HOME", other.path().to_str().unwrap())]);
        assert_eq!(stats_db_path(&set, h, cwd.path()), h.join(".omp/stats.db"));
        assert_eq!(stats_db_path(&env(&[("XDG_DATA_HOME", "")]), h, cwd.path()), xdg.path().join("omp/stats.db"));
        // <config root>/.env beats ~/.env; OMP_CONFIG_DIR there is mirrored to PI_CONFIG_DIR.
        std::fs::create_dir_all(h.join(".omp")).unwrap();
        std::fs::write(h.join(".omp/.env"), "OMP_CONFIG_DIR=.omp-alt # moved\nXDG_DATA_HOME=\n").unwrap();
        assert_eq!(stats_db_path(&env(&[]), h, cwd.path()), xdg.path().join("omp/stats.db"), "empty dotenv values never override");
        std::fs::remove_file(h.join(".env")).unwrap();
        assert_eq!(stats_db_path(&env(&[]), h, cwd.path()), h.join(".omp-alt/stats.db"));
    }

    #[test]
    fn dotenv_grammar() {
        let v = dotenv("A=1\n  export B = two words # note\nC='x # y'\nD=\"l1\\nl2\"\nE=\"multi\nline\"\nF=after\n1X=bad\nOMP_PROFILE=p\n#G=no\n");
        assert_eq!(v.get("A").map(String::as_str), Some("1"));
        assert_eq!(v.get("B").map(String::as_str), Some("two words"));
        assert_eq!(v.get("C").map(String::as_str), Some("x # y"));
        assert_eq!(v.get("D").map(String::as_str), Some("l1\nl2"));
        assert_eq!(v.get("E").map(String::as_str), Some("multi\nline"));
        assert_eq!(v.get("F").map(String::as_str), Some("after"));
        assert!(!v.contains_key("1X") && !v.contains_key("G") && !v.contains_key("#G"));
        assert_eq!(v.get("PI_PROFILE").map(String::as_str), Some("p"));
    }
}
