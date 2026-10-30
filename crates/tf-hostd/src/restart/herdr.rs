//! The resume command hostd reports to herdr for every omp agent TeleFlock launched
//! (`pane.report_agent_session` with `resume_argv`, herdr ≥ 0.9.4), so herdr's own pane restore
//! after a server or host restart reopens the session with TeleFlock's launch flags instead of its
//! built-in `omp --resume=<file>`, which drops them:
//!
//! ```text
//! omp --config <home>/omp-overlay.yml [--config <home>/agent-config/<file>.yml] -e <home>/ext/teleflock-bridge.ts --resume=<file>
//! ```
//!
//! Always `--resume`, never `--restore`: omp's restore runs a cut-off tool call again verbatim,
//! and only TeleFlock's decision (`crate::restart::decide`) may let it. `--model` / `--thinking`
//! are left out (omp restores the session's own). herdr types the command into the restored
//! pane's shell, so it takes it only from the reporter holding the pane (`source: teleflock`, no
//! other reporter: herdr's omp integration, when installed, holds omp panes and herdr then
//! answers `resume_not_accepted`; its built-in restore stays, and TeleFlock takes the agent over
//! afterwards), and only as a plain command name followed by arguments without apostrophes or
//! control characters. Servers TeleFlock starts restore no agents themselves
//! (`crate::herdr_health`): TeleFlock brings them back.
//!
//! The same pass rebinds an agent's own omp settings (`crate::agentcfg`) to the new agent id of a
//! pane herdr restored with that command: the process names its overlay file.

use std::collections::HashMap;
use std::path::Path;

use tracing::{info, warn};

use tf_herdr::AgentSessionReport;
use tf_proto::model::Agent;
use tf_proto::Millis;

use crate::agentcfg::Store;
use crate::ops::agent::{omp_args, SessionArg};
use crate::ops::Ctx;
use crate::paths::Paths;

/// The `source` hostd reports under (not one of herdr's own `herdr:<agent>` integrations).
pub const SOURCE: &str = "teleflock";
/// herdr's limits for a reported command (`agent_resume::validate_resume_argv`).
const MAX_ARGS: usize = 64;
const MAX_BYTES: usize = 8192;
/// A pane another reporter holds is asked again after this long (or when its process changes).
const REFUSED_RETRY_MS: Millis = 10 * 60_000;
/// A failed report is tried again after this long.
const FAILED_RETRY_MS: Millis = 60_000;
/// First herdr that keeps `resume_argv` (older ones accept the field and ignore it).
pub const MIN_HERDR: (u32, u32, u32) = (0, 9, 4);

/// herdr's rules for a reported resume command: a plain command name first
/// (`[A-Za-z0-9._-]`, not starting with `-`), at most 64 arguments and 8192 bytes, no control
/// characters, no apostrophes (herdr quotes POSIX-style, which PowerShell reads differently).
pub fn check_argv(argv: &[String]) -> Result<(), String> {
    let Some(command) = argv.first() else { return Err("the command is empty".into()) };
    if argv.len() > MAX_ARGS {
        return Err(format!("more than {MAX_ARGS} arguments"));
    }
    if argv.iter().map(String::len).sum::<usize>() > MAX_BYTES {
        return Err(format!("longer than {MAX_BYTES} bytes"));
    }
    if argv.iter().any(|a| a.chars().any(char::is_control)) {
        return Err("an argument holds a control character".into());
    }
    if argv.iter().any(|a| a.contains('\'')) {
        return Err("an argument holds an apostrophe (herdr cannot type it safely)".into());
    }
    let plain = !command.is_empty() && !command.starts_with('-') && command.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'));
    if !plain {
        return Err("the command is not a plain command name".into());
    }
    Ok(())
}

/// The command that reopens `file` with TeleFlock's launch flags (the ones that exist).
pub fn resume_argv(paths: &Paths, agent_overlay: Option<&Path>, file: &str) -> Vec<String> {
    let overlay = paths.overlay.is_file().then(|| paths.overlay.display().to_string());
    let ext = paths.ext.is_file().then(|| paths.ext.display().to_string());
    let own = agent_overlay.filter(|p| p.is_file()).map(|p| p.display().to_string());
    let session = SessionArg::Resume(file);
    let spec = tf_proto::methods::AgentSpec {
        name: None,
        kind: "omp".into(),
        model: None,
        thinking: None,
        plan: false,
        prompt: None,
        images: Vec::new(),
        role_models: Default::default(),
        fallback_chains: Default::default(),
        auto_answer: None,
    };
    let mut argv = vec!["omp".to_string()];
    argv.extend(omp_args(&spec, overlay.as_deref(), own.as_deref(), ext.as_deref(), Some(session)));
    argv
}

/// The command line of a process (Linux `/proc/<pid>/cmdline`; `None` elsewhere or when gone).
pub fn cmdline(pid: u32) -> Option<Vec<String>> {
    #[cfg(target_os = "linux")]
    {
        let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
        let args: Vec<String> = raw.split(|b| *b == 0).filter(|a| !a.is_empty()).map(|a| String::from_utf8_lossy(a).into_owned()).collect();
        (!args.is_empty()).then_some(args)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        None
    }
}

/// The value of an option given as `--opt=<v>` or `--opt <v>`.
fn values<'a>(args: &'a [String], names: &'a [&'a str]) -> impl Iterator<Item = &'a str> + 'a {
    args.iter().enumerate().filter_map(move |(i, a)| {
        names.iter().find_map(|n| {
            if a == n {
                args.get(i + 1).map(String::as_str)
            } else {
                a.strip_prefix(n).and_then(|rest| rest.strip_prefix('='))
            }
        })
    })
}

/// TeleFlock launched this omp: its arguments name this home's overlay or extension.
pub fn launched_by_us(paths: &Paths, args: &[String]) -> bool {
    let overlay = paths.overlay.display().to_string();
    let ext = paths.ext.display().to_string();
    values(args, &["--config"]).any(|v| v == overlay) || values(args, &["-e", "--extension", "--hook"]).any(|v| v == ext)
}

/// The agent's own overlay (a file name in `<home>/agent-config/`) the process was started with.
pub fn agent_overlay_in(store: &Store, args: &[String]) -> Option<String> {
    let dir = store.dir();
    values(args, &["--config"]).find_map(|v| {
        let p = Path::new(v);
        (p.parent() == Some(dir)).then(|| p.file_name().map(|n| n.to_string_lossy().into_owned())).flatten()
    })
}

/// The process is continuing its session by itself (`omp --restore`).
pub fn restoring(args: &[String]) -> bool {
    args.iter().any(|a| a == "--restore" || a.starts_with("--restore="))
}

/// An omp process (other than `except`) whose arguments name `file` or `session_id` as the session
/// it resumes (herdr restoring a pane, a launch that is not on the board yet). Linux only.
pub fn omp_running(file: &str, session_id: Option<&str>, except: &[u32]) -> Option<u32> {
    #[cfg(target_os = "linux")]
    {
        let dir = std::fs::read_dir("/proc").ok()?;
        for d in dir.flatten() {
            let Some(pid) = d.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
            if except.contains(&pid) || pid == std::process::id() {
                continue;
            }
            let Some(args) = cmdline(pid) else { continue };
            let omp = args.iter().take(3).any(|a| Path::new(a).file_name().is_some_and(|n| n == "omp" || n == "omp.exe"));
            if !omp {
                continue;
            }
            let named = values(&args, &["--resume", "--restore", "-r", "--session"]).any(|v| (!file.is_empty() && v == file) || session_id.is_some_and(|s| v == s));
            if named {
                return Some(pid);
            }
        }
        None
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (file, session_id, except);
        None
    }
}

/// What herdr answered for an agent's last report.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Outcome {
    Kept,
    /// Another reporter holds the pane (herdr's omp integration): herdr keeps its own restore.
    Refused,
    Failed,
}

#[derive(Debug, Clone)]
struct Reported {
    pane: String,
    argv: Vec<String>,
    pid: Option<u32>,
    outcome: Outcome,
    at: Millis,
}

/// Per-context memory of what was reported to herdr.
#[derive(Default)]
pub struct Reports {
    by_agent: HashMap<String, Reported>,
    /// Agents whose command herdr could not take as is (logged once).
    invalid: HashMap<String, String>,
}

impl Reports {
    /// What herdr keeps for an agent's pane: the argv when herdr took it.
    pub fn kept(&self, agent_id: &str) -> Option<&[String]> {
        self.by_agent.get(agent_id).filter(|r| r.outcome == Outcome::Kept).map(|r| r.argv.as_slice())
    }
}

/// One report pass over the board: every live omp agent TeleFlock launched gets its resume
/// command reported (again when the command, the pane or the process changed).
pub async fn report(ctx: &Ctx, agents: &[Agent], reports: &mut Reports, now: Millis) {
    let live: std::collections::HashSet<&str> = agents.iter().filter(|a| a.parked.is_none()).map(|a| a.id.as_str()).collect();
    reports.by_agent.retain(|id, _| live.contains(id.as_str()));
    let store = Store::new(&ctx.paths);
    for a in agents {
        if a.parked.is_some() || a.kind != "omp" || a.pane_id.is_empty() {
            continue;
        }
        let Some(o) = &a.omp else { continue };
        let (Some(file), Some(pid)) = (o.session_file.as_deref().filter(|f| !f.is_empty()), o.pid) else { continue };
        let Some(args) = cmdline(pid) else { continue };
        if !launched_by_us(&ctx.paths, &args) {
            continue;
        }
        // The agent's own settings follow a pane herdr restored with the command (new agent id).
        let own = agent_overlay_in(&store, &args);
        let mut record = store.get(&ctx.herdr_session, &a.id);
        if record.as_ref().and_then(|r| r.file.as_deref()) != own.as_deref()
            && let Some(file_name) = &own
            && let Some((old, _)) = store.find_by_file(&ctx.herdr_session, file_name)
            && old != a.id
            && !live.contains(old.as_str())
        {
            match store.rebind(&ctx.herdr_session, &old, &a.id, now) {
                Ok(true) => {
                    info!(agent = %a.id, %old, file = %file_name, "agent omp settings follow its restored pane");
                    record = store.get(&ctx.herdr_session, &a.id);
                }
                Ok(false) => {}
                Err(e) => warn!(agent = %a.id, "rebinding the agent's omp settings: {e}"),
            }
        }
        let overlay = record.as_ref().and_then(|r| store.path_of(r)).filter(|_| own.is_some());
        let argv = resume_argv(&ctx.paths, overlay.as_deref(), file);
        if let Err(why) = check_argv(&argv) {
            if reports.invalid.get(&a.id) != Some(&why) {
                warn!(agent = %a.id, "herdr cannot restore this agent with TeleFlock's flags: {why}");
                reports.invalid.insert(a.id.clone(), why);
            }
            continue;
        }
        reports.invalid.remove(&a.id);
        if let Some(prev) = reports.by_agent.get(&a.id)
            && prev.pane == a.pane_id
            && prev.pid == Some(pid)
        {
            let fresh = match prev.outcome {
                Outcome::Kept => prev.argv == argv,
                Outcome::Refused => now - prev.at < REFUSED_RETRY_MS,
                Outcome::Failed => prev.argv == argv && now - prev.at < FAILED_RETRY_MS,
            };
            if fresh {
                continue;
            }
        }
        let report = AgentSessionReport {
            pane_id: a.pane_id.clone(),
            source: SOURCE.into(),
            agent: "omp".into(),
            resume_argv: Some(argv.clone()),
            ..Default::default()
        };
        let outcome = match ctx.herdr.pane_report_agent_session(&report).await {
            Ok(()) => {
                info!(agent = %a.id, pane = %a.pane_id, ?argv, "resume command reported to herdr");
                Outcome::Kept
            }
            Err(e) if e.is("resume_not_accepted") => {
                info!(agent = %a.id, pane = %a.pane_id, "herdr keeps its own restore for this pane (another reporter holds it): {}", e.message);
                Outcome::Refused
            }
            Err(e) => {
                warn!(agent = %a.id, pane = %a.pane_id, "reporting the resume command to herdr failed: {e}");
                Outcome::Failed
            }
        };
        reports.by_agent.insert(a.id.clone(), Reported { pane: a.pane_id.clone(), argv, pid: Some(pid), outcome, at: now });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn herdr_takes_only_plain_commands() {
        assert!(check_argv(&s(&["omp", "--config", "/root/.teleflock/omp-overlay.yml", "--resume=/s/a b.jsonl"])).is_ok());
        for bad in [
            s(&[]),
            s(&[""]),
            s(&["/root/.local/bin/omp", "--resume=/s/a.jsonl"]),
            s(&["-omp"]),
            s(&["omp x"]),
            s(&["omp", "--resume=/home/o'neil/s.jsonl"]),
            s(&["omp", "--resume=/s/a\nb.jsonl"]),
            vec!["omp".to_string(); MAX_ARGS + 1],
            vec!["omp".to_string(), "x".repeat(MAX_BYTES)],
        ] {
            assert!(check_argv(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn the_command_carries_teleflocks_flags() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path().to_path_buf(), true);
        std::fs::create_dir_all(paths.ext.parent().unwrap()).unwrap();
        // Nothing deployed: only the session flag.
        assert_eq!(resume_argv(&paths, None, "/s/a.jsonl"), s(&["omp", "--resume=/s/a.jsonl"]));
        std::fs::write(&paths.overlay, "collab: {}\n").unwrap();
        std::fs::write(&paths.ext, "// bridge\n").unwrap();
        let own = dir.path().join("agent-config").join("ab12.yml");
        std::fs::create_dir_all(own.parent().unwrap()).unwrap();
        // An overlay that is gone is left out (omp would refuse to start on a missing --config).
        let overlay = paths.overlay.display().to_string();
        let ext = paths.ext.display().to_string();
        assert_eq!(resume_argv(&paths, Some(&own), "/s/a.jsonl"), s(&["omp", "--config", &overlay, "-e", &ext, "--resume=/s/a.jsonl"]));
        std::fs::write(&own, "modelRoles: {}\n").unwrap();
        let own_s = own.display().to_string();
        let argv = resume_argv(&paths, Some(&own), "/s/a b.jsonl");
        assert_eq!(argv, s(&["omp", "--config", &overlay, "--config", &own_s, "-e", &ext, "--resume=/s/a b.jsonl"]));
        assert!(check_argv(&argv).is_ok(), "a space in the session path is fine: herdr quotes it");
    }

    #[test]
    fn reading_a_launch() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path().to_path_buf(), true);
        let store = Store::new(&paths);
        let overlay = paths.overlay.display().to_string();
        let own = store.dir().join("ab12.yml").display().to_string();
        let ext = paths.ext.display().to_string();
        let ours = s(&["bun", "/root/.bun/bin/omp", "--config", &overlay, &format!("--config={own}"), "-e", &ext, "--restore=/s/a.jsonl"]);
        assert!(launched_by_us(&paths, &ours));
        assert_eq!(agent_overlay_in(&store, &ours).as_deref(), Some("ab12.yml"));
        assert!(restoring(&ours));
        // herdr's built-in restore: no TeleFlock flags.
        let builtin = s(&["omp", "--resume=/s/a.jsonl"]);
        assert!(!launched_by_us(&paths, &builtin));
        assert_eq!(agent_overlay_in(&store, &builtin), None);
        assert!(!restoring(&builtin));
        // Another home's overlay is not ours.
        assert!(!launched_by_us(&paths, &s(&["omp", "--config", "/root/.teleflock/omp-overlay.yml"])));
        let args = s(&["omp", "-r", "01ab", "--resume=/x.jsonl"]);
        let got: Vec<&str> = values(&args, &["--resume", "-r"]).collect();
        assert_eq!(got, vec!["01ab", "/x.jsonl"]);
    }

    /// Never two omps on one session: an omp naming the session file (herdr's own restore, a
    /// resume by hand, one not on the board yet) is found in `/proc`.
    #[cfg(target_os = "linux")]
    #[test]
    fn an_omp_already_running_the_session_is_found() {
        use std::os::unix::process::CommandExt;
        let poll = |f: &dyn Fn() -> Option<u32>| {
            for _ in 0..50 {
                if let Some(p) = f() {
                    return Some(p);
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            None
        };
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("2026-10-29_01sess.jsonl").display().to_string();
        // A stand-in whose command line reads like `omp --resume=<file>` (argv[0] `omp`).
        let mut child = std::process::Command::new("/bin/sh").arg0("omp").args(["-c", "sleep 30; :", "omp", &format!("--resume={file}")]).spawn().unwrap();
        let pid = child.id();
        assert_eq!(poll(&|| omp_running(&file, None, &[])), Some(pid));
        assert_eq!(omp_running(&file, None, &[pid]), None, "the process asked about itself is skipped");
        assert_eq!(omp_running("/s/other.jsonl", Some("other-id"), &[]), None, "another session");
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(omp_running(&file, None, &[]), None, "gone with its process");
        // `--session <id>` / `-r <id>` name it by id.
        let mut by_id = std::process::Command::new("/bin/sh").arg0("omp").args(["-c", "sleep 30; :", "omp", "-r", "01sess"]).spawn().unwrap();
        assert_eq!(poll(&|| omp_running("/s/elsewhere.jsonl", Some("01sess"), &[])), Some(by_id.id()));
        by_id.kill().unwrap();
        by_id.wait().unwrap();
    }
}
