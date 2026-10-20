//! POSIX quoting and the remote command line used by SSH exec channels and WSL.
//!
//! The quoting is also valid fish syntax: a single quote or backslash is emitted *outside*
//! single quotes as `\'` / `\\`, which every shell (sh, bash, zsh, fish) reads as the
//! literal character. Everything else goes inside single quotes.

use crate::Cmd;

/// The script run by `sh -c`: re-exec the user's login shell so profile files run and
/// PATH includes `~/.local/bin` (where herdr, omp and tf-hostd live).
const LOGIN_WRAPPER: &str = r#"exec "${SHELL:-/bin/sh}" -lc "$1""#;

fn is_safe(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | '=' | ':' | ',' | '+' | '@')
}

/// Quote one word so any POSIX shell (and fish) reads it back verbatim.
pub fn shell_quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(is_safe) {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len() + 2);
    let mut open = false;
    for c in s.chars() {
        if c == '\'' || c == '\\' {
            if open {
                out.push('\'');
                open = false;
            }
            out.push('\\');
            out.push(c);
        } else {
            if !open {
                out.push('\'');
                open = true;
            }
            out.push(c);
        }
    }
    if open {
        out.push('\'');
    }
    if out.is_empty() {
        out.push_str("''");
    }
    out
}

/// Quote a working directory, keeping a leading `~` / `~/` expandable.
fn quote_dir(dir: &str) -> String {
    if dir == "~" {
        "~".into()
    } else if let Some(rest) = dir.strip_prefix("~/") {
        if rest.is_empty() { "~/".into() } else { format!("~/{}", shell_quote(rest)) }
    } else {
        shell_quote(dir)
    }
}

/// The inner command line: `[cd DIR && ]exec [env K=V …] ARGV…`.
pub fn inner_command(cmd: &Cmd) -> String {
    let mut s = String::new();
    if let Some(dir) = cmd.cwd.as_deref().filter(|d| !d.is_empty()) {
        s.push_str("cd ");
        s.push_str(&quote_dir(dir));
        s.push_str(" && ");
    }
    s.push_str("exec");
    if !cmd.env.is_empty() {
        s.push_str(" env");
        for (k, v) in &cmd.env {
            s.push(' ');
            s.push_str(&shell_quote(&format!("{k}={v}")));
        }
    }
    for a in &cmd.argv {
        s.push(' ');
        s.push_str(&shell_quote(a));
    }
    s
}

/// Words that run `cmd` in the user's login shell: `sh -c WRAPPER sh INNER`.
pub fn login_shell_argv(cmd: &Cmd) -> Vec<String> {
    vec!["sh".into(), "-c".into(), LOGIN_WRAPPER.into(), "sh".into(), inner_command(cmd)]
}

/// The full command string sent in an SSH `exec` request (parsed by the user's shell).
/// Every level `exec`s the next (user shell → sh → login shell → program), so the
/// command is the channel's only process and an SSH `signal` reaches it directly.
pub fn remote_command(cmd: &Cmd) -> String {
    let words = login_shell_argv(cmd).iter().map(|w| shell_quote(w)).collect::<Vec<_>>().join(" ");
    format!("exec {words}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_words() {
        assert_eq!(shell_quote("herdr"), "herdr");
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
        assert_eq!(shell_quote(r"a\b"), r"'a'\\'b'");
        assert_eq!(shell_quote("'"), r"\'");
        assert_eq!(shell_quote("$HOME"), "'$HOME'");
        assert_eq!(shell_quote("~"), "'~'");
    }

    #[test]
    fn builds_inner_command() {
        let cmd = Cmd::new(["herdr", "agent", "list", "--json"]).cwd("~/src/my repo").env("HERDR_SESSION", "lab 1");
        assert_eq!(inner_command(&cmd), "cd ~/'src/my repo' && exec env 'HERDR_SESSION=lab 1' herdr agent list --json");
        let cmd = Cmd::new(["echo", "x"]);
        assert_eq!(inner_command(&cmd), "exec echo x");
        assert_eq!(remote_command(&cmd), r#"exec sh -c 'exec "${SHELL:-/bin/sh}" -lc "$1"' sh 'exec echo x'"#);
    }

    /// Round-trip hostile arguments through a real `sh` (and fish if installed).
    #[test]
    fn round_trips_through_real_shells() {
        let args = ["plain", "", "with space", "it's", r"back\slash", r"\\", "$HOME `id` $(id)", "*?[a]{b,c}~", "new\nline", "émoji 🐑", "-n", "'", "\"dq\""];
        for shell in ["sh", "bash", "fish"] {
            if std::process::Command::new(shell).arg("-c").arg("true").output().map(|o| !o.status.success()).unwrap_or(true) {
                continue;
            }
            let line = format!("printf '%s\\0' {}", args.iter().map(|a| shell_quote(a)).collect::<Vec<_>>().join(" "));
            let out = std::process::Command::new(shell).arg("-c").arg(&line).output().unwrap();
            let got: Vec<String> = out.stdout.split(|b| *b == 0).map(|s| String::from_utf8_lossy(s).into_owned()).collect();
            assert_eq!(&got[..args.len()], &args[..], "shell {shell}");
        }
    }
}
