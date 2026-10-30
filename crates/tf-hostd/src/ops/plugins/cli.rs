//! omp's skill and plugin CLI (`omp skill …`, `omp plugin …`): how hostd runs it, the arguments
//! it takes from the app, and what its output means.
//!
//! Runs without a shell or TTY (stdin closed: omp's own prompts take their non-interactive
//! answer), in its own process group (a timeout stops the installs it started: `bun install`,
//! `git clone`), `NO_COLOR=1`. Exit 0 is success; omp prints what changed on stdout and why it
//! failed on stderr (`error <message>`, `skill <action>: <message>`, `✗ Failed to … : <message>`).

use std::path::Path;
use std::time::Duration;

use tf_proto::ApiError;

use super::Plugins;
use crate::ops::tools;
use crate::util::clip;

/// `omp skill` / `omp plugin` in `cwd`, failing only when omp couldn't be run or timed out.
pub(super) async fn omp(pl: &Plugins, cwd: &Path, args: &[&str], timeout: Duration) -> Result<tools::Out, ApiError> {
    let bin = pl.omp()?;
    let agent_dir = pl.helper.agent_dir.as_ref().map(|d| d.to_string_lossy().into_owned());
    let mut env: Vec<(&str, &str)> = vec![("FORCE_COLOR", "0")];
    if let Some(dir) = agent_dir.as_deref() {
        env.push(("PI_CODING_AGENT_DIR", dir));
    }
    tracing::info!(args = %args.join(" "), cwd = %cwd.display(), "omp plugins cli");
    tools::run_in(cwd, bin, args, timeout, &env, &[]).await.map_err(|e| {
        if e.contains("timed out") {
            ApiError::new("timeout", e).with_hint("omp may still be downloading: look again in a moment.").retryable()
        } else {
            ApiError::new("omp_error", e)
        }
    })
}

/// A spec, id, name or source as it may go on omp's command line: trimmed, single-line, not empty,
/// not a flag. `field` names it in the error.
pub(super) fn arg<'a>(field: &str, raw: &'a str) -> Result<&'a str, ApiError> {
    let v = raw.trim();
    if v.is_empty() {
        return Err(ApiError::new("invalid_params", format!("{field}: empty")));
    }
    if v.len() > 1000 || v.chars().any(char::is_control) {
        return Err(ApiError::new("invalid_params", format!("{field}: not a valid value")));
    }
    if v.starts_with('-') {
        return Err(ApiError::new("invalid_params", format!("{field}: can't start with `-`")));
    }
    Ok(v)
}

/// `@scope/name` with an optional `@<range|tag|version>` (omp's `SKILL_SPEC_RE`).
pub(super) fn is_skill_spec(s: &str, allow_range: bool) -> bool {
    let Some(rest) = s.strip_prefix('@') else { return false };
    let Some((scope, tail)) = rest.split_once('/') else { return false };
    let (name, range) = match tail.split_once('@') {
        Some((n, r)) => (n, Some(r)),
        None => (tail, None),
    };
    let scope_ok = (3..=32).contains(&scope.len())
        && scope.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && scope.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    let name_ok = !name.is_empty() && name.split('-').all(|w| !w.is_empty() && w.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
    let range_ok = match range {
        None => true,
        Some(r) => allow_range && !r.is_empty(),
    };
    scope_ok && name_ok && range_ok
}

/// The lines omp printed about what changed (stdout without its file notes).
pub(super) fn changes(out: &tools::Out) -> Vec<String> {
    out.stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("Saved "))
        .map(|l| clip(l, 300))
        .collect()
}

/// Whether a successful `omp skill install|update` changed nothing.
pub(super) fn nothing_changed(out: &tools::Out) -> bool {
    let t = out.stdout.trim();
    t == "Already up to date." || t == "All skills are up to date." || t == "All marketplace plugins are up to date." || t.is_empty()
}

/// Why omp failed, in its words: its error line (status glyph and the JS `Error: ` prefix taken
/// off), else its last line, else the exit code.
pub(super) fn failure_message(out: &tools::Out) -> String {
    let lines: Vec<&str> = out.stderr.lines().chain(out.stdout.lines()).map(str::trim).filter(|l| !l.is_empty()).collect();
    let pick = lines
        .iter()
        .find_map(|l| l.strip_prefix("error ").or_else(|| l.strip_prefix("error: ")))
        .or_else(|| lines.iter().find(|l| l.starts_with('✗') || l.starts_with("Failed to") || (l.starts_with("skill ") && l.contains(": "))).copied())
        .or_else(|| lines.last().copied());
    let Some(line) = pick else { return format!("omp exited with code {}", out.code) };
    let line = line.trim_start_matches(['✗', '×', '✖']).trim();
    clip(&line.replacen(": Error: ", ": ", 1), 600)
}

/// A failed `omp skill install|update`: the script approval it refused (`scripts_need_consent`,
/// the message is omp's listing of the files), else its error.
pub(super) fn skill_failure(out: &tools::Out) -> ApiError {
    let text = &out.stderr;
    if text.contains("Refusing to install scripts without confirmation") {
        let mut listing = Vec::new();
        let mut inside = false;
        for line in text.lines() {
            let l = line.trim_end();
            if let Some(i) = l.find(" ships scripts:") {
                // `error @a/b@1.0.0 ships scripts:` (omp prefixes its error lines).
                let head = &l[..i];
                let id = head.rsplit(' ').next().unwrap_or(head);
                listing.push(format!("{id} ships scripts:"));
                inside = true;
            } else if inside && l.starts_with("  ") {
                listing.push(l.to_string());
            } else if inside {
                inside = false;
            }
        }
        let message = if listing.is_empty() { "This version ships scripts.".to_string() } else { listing.join("\n") };
        return ApiError::new("scripts_need_consent", clip(&message, 4000)).with_hint(
            "Its scripts run on the host with your user's rights whenever a session uses the skill. Install it only if you trust its publisher.",
        );
    }
    classify(failure_message(out))
}

/// A failed `omp plugin …`: its error.
pub(super) fn plugin_failure(out: &tools::Out) -> ApiError {
    classify(failure_message(out))
}

/// The wire error for omp's message.
pub(super) fn classify(message: String) -> ApiError {
    let lower = message.to_lowercase();
    if lower.contains("not found in the registry") || lower.contains("is not installed") || lower.contains("not found in marketplace") || lower.contains("no marketplace named") {
        ApiError::new("not_found", message)
    } else if lower.contains("invalid skill spec") || lower.contains("invalid skill name") || lower.contains("unrecognized source format") || lower.contains("usage:") {
        ApiError::new("invalid_params", message)
    } else if lower.contains("not a project root") {
        ApiError::new("invalid_params", message).with_hint("Pick a project folder (a git repository or a folder with .omp/), or install for every session.")
    } else if lower.contains("cannot reach") || lower.contains("network") || lower.contains("timed out") || lower.contains("econn") {
        ApiError::new("omp_error", message).retryable()
    } else {
        ApiError::new("omp_error", message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out(code: i32, stdout: &str, stderr: &str) -> tools::Out {
        tools::Out { code, stdout: stdout.into(), stderr: stderr.into(), text: format!("{stdout}\n{stderr}") }
    }

    #[test]
    fn skill_specs_follow_omps_pattern() {
        assert!(is_skill_spec("@alice/pdf-tools", false));
        assert!(is_skill_spec("@alice/pdf-tools@^1.2", true));
        assert!(!is_skill_spec("@alice/pdf-tools@^1.2", false), "an id takes no range");
        assert!(!is_skill_spec("@al/pdf", false), "scopes have 3–32 characters");
        assert!(!is_skill_spec("@alice/PDF", false));
        assert!(!is_skill_spec("@alice/pdf--tools", false));
        assert!(!is_skill_spec("alice/pdf", false));
        assert!(!is_skill_spec("@alice/pdf@", true));
    }

    #[test]
    fn arguments_never_become_flags() {
        assert_eq!(arg("spec", "  github:me/x  ").unwrap(), "github:me/x");
        assert_eq!(arg("spec", "--force").unwrap_err().code, "invalid_params");
        assert!(arg("spec", "a\nb").unwrap_err().message.starts_with("spec:"));
        assert!(arg("spec", " ").is_err());
    }

    #[test]
    fn script_listings_become_a_consent_request() {
        let e = skill_failure(&out(
            1,
            "",
            "error @alice/pdf-tools@1.2.0 ships scripts:\n  scripts/extract.sh (executable)\n  scripts/lib.py\nRefusing to install scripts without confirmation; re-run with --yes to allow them.\n",
        ));
        assert_eq!(e.code, "scripts_need_consent");
        assert_eq!(e.message, "@alice/pdf-tools@1.2.0 ships scripts:\n  scripts/extract.sh (executable)\n  scripts/lib.py");
        assert!(e.hint.is_some());
    }

    #[test]
    fn failures_keep_omps_words() {
        assert_eq!(skill_failure(&out(1, "", "error @alice/nope was not found in the registry\n")).code, "not_found");
        let e = classify(failure_message(&out(1, "", "✗ Failed to install foo@bar: Error: Plugin \"foo\" not found in marketplace \"bar\"\n")));
        assert_eq!((e.code.as_str(), e.message.as_str()), ("not_found", "Failed to install foo@bar: Plugin \"foo\" not found in marketplace \"bar\""));
        assert_eq!(failure_message(&out(1, "", "skill install: This directory is not a project root; pass --global to install for your user.\n")), "skill install: This directory is not a project root; pass --global to install for your user.");
        assert_eq!(failure_message(&out(7, "", "")), "omp exited with code 7");
    }

    #[test]
    fn change_lines_drop_file_notes() {
        let o = out(0, "+ @alice/pdf-tools@1.2.0\nSaved /x/skills.json\n", "");
        assert_eq!(changes(&o), ["+ @alice/pdf-tools@1.2.0"]);
        assert!(!nothing_changed(&o));
        assert!(nothing_changed(&out(0, "Already up to date.\n", "")));
    }
}
