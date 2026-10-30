//! omp's session transfer commands (omp ≥ 18.10): `omp session pack <session> <out.tar>`,
//! `omp session unpack <archive.tar> --cwd <dir>` (prints the session file it placed) and
//! `omp session moved <session> --to <label>` (the copy left behind forks when resumed).
//! Values go as `--flag=value`, so a label starting with `-` is never read as a flag.

use std::path::Path;
use std::time::Duration;

use tf_proto::ApiError;

use crate::ops::git::{run_cmd, CmdOut};
use crate::ops::host::omp_bin;

/// omp that packs, unpacks and marks sessions moved.
pub const MIN_OMP: (u32, u32, u32) = (18, 10, 0);

pub fn pack_args(session_file: &str, archive: &str) -> Vec<String> {
    vec!["session".into(), "pack".into(), session_file.into(), archive.into()]
}

pub fn unpack_args(archive: &str, cwd: &str) -> Vec<String> {
    vec!["session".into(), "unpack".into(), archive.into(), format!("--cwd={cwd}")]
}

pub fn moved_args(session_file: &str, label: &str) -> Vec<String> {
    vec!["session".into(), "moved".into(), session_file.into(), format!("--to={}", one_line(label))]
}

/// A label for omp's transcript: one line, at most 80 characters.
fn one_line(label: &str) -> String {
    let flat: String = label.split_whitespace().collect::<Vec<_>>().join(" ");
    let flat = if flat.is_empty() { "another host".to_string() } else { flat };
    flat.chars().take(80).collect()
}

/// How `unpack` placed the session (its stderr note).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placed {
    Created,
    /// Older copies of the session here were replaced (they were prefixes of the incoming one).
    Replaced,
    /// A copy here diverged: the incoming transcript landed as a fork with a new id.
    Forked,
}

/// The session file `unpack` printed (its last stdout line) and how it placed it.
pub fn unpacked(stdout: &str, stderr: &str) -> Option<(String, Placed)> {
    let file = stdout.lines().map(str::trim).rfind(|l| !l.is_empty())?;
    if !file.ends_with(".jsonl") || !Path::new(file).is_absolute() {
        return None;
    }
    let placed = if stderr.contains("diverged") {
        Placed::Forked
    } else if stderr.contains("Replaced") {
        Placed::Replaced
    } else {
        Placed::Created
    };
    Some((file.to_string(), placed))
}

/// `pack` / `moved` refused because an omp process still holds the session (it is exiting).
pub fn held_by_live_omp(stderr: &str) -> bool {
    stderr.contains("another live omp process")
}

/// The version is new enough for `omp session pack|unpack|moved`.
pub fn supports_transfer(version: &str) -> bool {
    crate::ops::host::parse_version(version).is_some_and(|v| v >= MIN_OMP)
}

/// omp's error line (`error: …`, colors off), else the whole stderr, trimmed and capped.
pub fn error_text(out: &CmdOut) -> String {
    let msg = out.message();
    let line = msg.lines().map(str::trim).find_map(|l| l.strip_prefix("error:")).map(str::trim).unwrap_or(msg.trim());
    line.chars().take(400).collect()
}

/// Runs `omp <args>` without a shell (colors off), in the user's home.
pub async fn run(args: &[String], timeout: Duration) -> Result<CmdOut, ApiError> {
    let bin = omp_bin().ok_or_else(|| ApiError::new("not_found", "omp is not installed on this host").with_hint("Install omp from Host setup."))?;
    let home = crate::paths::home_dir();
    run_cmd(&bin, args, Some(&home), &[("NO_COLOR", "1"), ("FORCE_COLOR", "0")], None, timeout).await.map_err(|e| match e.kind() {
        std::io::ErrorKind::TimedOut => ApiError::new("timeout", format!("omp {} timed out", args.get(1).map(String::as_str).unwrap_or("session"))).retryable(),
        _ => ApiError::new("omp_error", format!("failed to run omp: {e}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argv() {
        assert_eq!(pack_args("/s/a.jsonl", "/h/moves/m1/session.tar"), ["session", "pack", "/s/a.jsonl", "/h/moves/m1/session.tar"]);
        assert_eq!(unpack_args("/h/uploads/session.tar", "/w/app"), ["session", "unpack", "/h/uploads/session.tar", "--cwd=/w/app"]);
        // a label that looks like a flag stays the flag's value; newlines are flattened
        assert_eq!(moved_args("/s/a.jsonl", "-build\n server "), ["session", "moved", "/s/a.jsonl", "--to=-build server"]);
        assert_eq!(moved_args("/s/a.jsonl", "  ")[3], "--to=another host");
    }

    #[test]
    fn unpack_output() {
        let (file, placed) = unpacked("/root/.omp/agent/sessions/-w-app/2026_x.jsonl\n", "Unpacked session (x).\n").unwrap();
        assert_eq!((file.as_str(), placed), ("/root/.omp/agent/sessions/-w-app/2026_x.jsonl", Placed::Created));
        assert_eq!(unpacked("/s/b.jsonl\n", "Replaced the local copy of this session (x).").unwrap().1, Placed::Replaced);
        assert_eq!(unpacked("/s/c.jsonl", "The local copy of this session diverged; unpacked as a fork (y).").unwrap().1, Placed::Forked);
        assert_eq!(unpacked("", ""), None);
        assert_eq!(unpacked("warning: something\n", ""), None);
        assert!(held_by_live_omp("error: Cannot pack /s/a.jsonl: another live omp process writes this session. Exit it first."));
        let out = CmdOut { code: 1, stdout: vec![], stderr: "error: Bad session archive /x.tar: no manifest.json.\n".into() };
        assert_eq!(error_text(&out), "Bad session archive /x.tar: no manifest.json.");
    }

    #[test]
    fn versions() {
        assert!(supports_transfer("18.13.3"));
        assert!(supports_transfer("omp/18.10.0"));
        assert!(!supports_transfer("18.9.4"));
        assert!(!supports_transfer("unknown"));
    }
}
