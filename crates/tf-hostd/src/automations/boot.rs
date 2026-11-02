//! The boot service behind "Bring agents back after a reboot" and the automations keepalive
//! (architecture §3.11, §3.25): while an automation is enabled, or the agent ledger holds agents to
//! bring back, one per-user mechanism of the OS runs `tf-hostd ensure` (start the daemon if it is
//! not running) every 10 minutes and when the machine starts or the user logs in, so schedules fire
//! and agents come back with no app connected.
//!
//! - Linux: a systemd timer, at boot ([`super::systemd`]);
//! - macOS: a launchd agent, after login ([`super::launchd`]);
//! - Windows: a Task Scheduler task, after login ([`super::schtasks`]);
//! - any other OS: nothing to install; automations run while tf-hostd runs.
//!
//! The OS this binary was built for decides which one runs. Every module's rendering and planning is
//! plain code that all platforms compile and test (a Linux build checks the plist and the task XML);
//! only the one for this OS ever starts its tool. This module holds what they share.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tf_proto::{AutomationScheduler, BootService};

use super::{launchd, schtasks, systemd};
use crate::paths::Paths;

/// How long one call of `launchctl` or `schtasks` may take.
const TOOL_TIMEOUT: Duration = Duration::from_secs(20);

/// Whether this daemon may install a boot service: always for the real home (`~/.teleflock`). Any
/// other home (labs, dev builds) leaves nothing behind that outlives it: only the Linux timer can be
/// opted in, with `TF_HOSTD_KEEPALIVE=1` (`scripts/lab/stop` removes it). A launchd agent or a Task
/// Scheduler task is the user's own login item that a lab could neither stop nor tidy up (and on
/// Windows a task cannot carry `TF_HOSTD_HOME` to `ensure`), so those are the real home's alone.
pub fn allowed(paths: &Paths) -> bool {
    permitted(paths.is_default_home(), std::env::var_os("TF_HOSTD_KEEPALIVE").as_deref(), cfg!(not(any(target_os = "macos", windows))))
}

fn permitted(default_home: bool, opt_in: Option<&OsStr>, opt_in_counts: bool) -> bool {
    default_home || (opt_in_counts && opt_in.is_some_and(|v| v == "1"))
}

/// Installs (`want`) or removes this home's boot service and reports the resulting scheduler.
pub async fn reconcile(paths: &Paths, relay_port: u16, want: bool) -> AutomationScheduler {
    if cfg!(target_os = "macos") {
        launchd::reconcile(paths, relay_port, want, allowed(paths)).await
    } else if cfg!(windows) {
        schtasks::reconcile(paths, relay_port, want, allowed(paths)).await
    } else {
        systemd::reconcile(paths, relay_port, want).await
    }
}

/// What "Bring agents back after a reboot" can do on this host, from the scheduler `status` (the
/// last [`reconcile`]) and the host's own mechanism.
pub fn service(paths: &Paths, status: &AutomationScheduler) -> BootService {
    let allowed = allowed(paths);
    if cfg!(target_os = "macos") {
        launchd::boot_service(allowed, status)
    } else if cfg!(windows) {
        schtasks::boot_service(allowed, status)
    } else {
        systemd::boot_service(&systemd::Target::detect(), allowed, status)
    }
}

/// The scheduler status of mechanism `kind` on this host.
pub(super) fn status(kind: &str, persistent: bool, note: Option<String>) -> AutomationScheduler {
    AutomationScheduler { kind: kind.into(), persistent, note, timezone: super::cron::tz_name(&super::cron::local_tz()) }
}

/// No boot service: automations run while tf-hostd runs. `note` says why.
pub(super) fn daemon_only(note: &str) -> AutomationScheduler {
    status("daemon", false, Some(note.into()))
}

/// The running binary (without the ` (deleted)` suffix Linux adds after it was replaced).
pub(super) fn exe_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let s = exe.to_string_lossy();
    Some(match s.strip_suffix(" (deleted)") {
        Some(p) => PathBuf::from(p),
        None => exe,
    })
}

/// Variables the daemon inherits from its login session but a service manager lacks.
pub(super) fn daemon_env() -> Vec<(&'static str, String)> {
    ["HOME", "PATH", "USER", "LANG"]
        .into_iter()
        .filter_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()).map(|v| (k, v)))
        .collect()
}

/// Writes `bytes` to `path` when it differs; true when written.
pub(super) fn write_if_changed(path: &Path, bytes: &[u8]) -> std::io::Result<bool> {
    if std::fs::read(path).is_ok_and(|cur| cur == bytes) {
        return Ok(false);
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(true)
}

/// `s` as XML text: `&`, `<` and `>` escaped. What a plist and a task file hold (paths with spaces
/// or non-ASCII letters pass through, both formats being Unicode).
pub(super) fn xml_text(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// One OS tool the boot service drives (`launchctl`, `schtasks`): [`RealTool`] runs it; tests hand
/// in a recorder, so they never reach the user's real login items.
pub(super) trait Tool: Send + Sync {
    /// Runs the tool with `args`: its trimmed stdout, or why it failed (exit status, stderr).
    fn run(&self, args: &[String]) -> impl Future<Output = Result<String, String>> + Send;
}

/// The tool at an absolute path (never found through PATH, which holds the user's directories).
pub(super) struct RealTool(pub PathBuf);

impl Tool for RealTool {
    async fn run(&self, args: &[String]) -> Result<String, String> {
        let name = self.0.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let line = format!("{name} {}", args.join(" "));
        let mut cmd = tokio::process::Command::new(&self.0);
        cmd.args(args).stdin(std::process::Stdio::null()).kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: never flash a console from the background daemon
        let out = tokio::time::timeout(TOOL_TIMEOUT, cmd.output())
            .await
            .map_err(|_| format!("{line} timed out"))?
            .map_err(|e| format!("{name}: {e}"))?;
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() {
            Ok(stdout)
        } else {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(format!("{line} failed: {}", if stderr.is_empty() { stdout } else { stderr }))
        }
    }
}

#[cfg(test)]
pub(super) mod testing {
    use std::sync::Mutex;

    use super::Tool;

    /// A [`Tool`] that runs nothing: it records every call and answers from `reply(args, n)`
    /// (`n`: how many calls came before).
    pub struct Recorder {
        calls: Mutex<Vec<String>>,
        reply: Box<dyn Fn(&[String], usize) -> Result<String, String> + Send + Sync>,
    }

    impl Recorder {
        pub fn new(reply: impl Fn(&[String], usize) -> Result<String, String> + Send + Sync + 'static) -> Self {
            Self { calls: Mutex::new(Vec::new()), reply: Box::new(reply) }
        }

        /// Every call so far, as `arg arg arg`.
        pub fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl Tool for Recorder {
        async fn run(&self, args: &[String]) -> Result<String, String> {
            let n = {
                let mut calls = self.calls.lock().unwrap();
                calls.push(args.join(" "));
                calls.len() - 1
            };
            (self.reply)(args, n)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_real_home_installs_a_login_item_and_only_the_linux_timer_can_be_opted_in() {
        let opt = |v: &str| Some(OsStr::new(v).to_owned());
        let allowed = |default_home: bool, opt_in: Option<std::ffi::OsString>, opt_in_counts: bool| permitted(default_home, opt_in.as_deref(), opt_in_counts);
        for opt_in_counts in [false, true] {
            assert!(allowed(true, None, opt_in_counts), "the real home");
            assert!(allowed(true, opt("0"), opt_in_counts));
            assert!(!allowed(false, None, opt_in_counts), "a lab home leaves no boot-time item behind");
            assert!(!allowed(false, opt("0"), opt_in_counts));
        }
        assert!(allowed(false, opt("1"), true), "a lab that tests the Linux timer opts in");
        assert!(!allowed(false, opt("1"), false), "a launchd agent or a Task Scheduler task is the real home's alone");
    }

    #[test]
    fn xml_text_escapes_markup_and_keeps_every_letter() {
        assert_eq!(xml_text("a&b <c> \"d\" 'e'"), "a&amp;b &lt;c&gt; \"d\" 'e'");
        assert_eq!(xml_text("C:\\Users\\Jörg Müller\\日本"), "C:\\Users\\Jörg Müller\\日本");
        assert_eq!(xml_text("&lt;"), "&amp;lt;", "no double-escaping guesses: text goes in as written");
    }

    #[test]
    fn a_file_is_only_written_when_it_changed() {
        let td = tempfile::tempdir().unwrap();
        let path = td.path().join("a").join("item.plist");
        assert!(write_if_changed(&path, b"one").unwrap(), "created with its folder");
        assert!(!write_if_changed(&path, b"one").unwrap());
        assert!(write_if_changed(&path, b"two").unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        assert!(!path.with_extension("tmp").exists(), "no temp file left behind");
    }
}
