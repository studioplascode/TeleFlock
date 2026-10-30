//! systemd keepalive: while at least one automation is enabled, or the agent ledger holds agents
//! to bring back after a reboot (`crate::restart`, with auto-resume on), a timer runs
//! `tf-hostd ensure` (start the daemon if it is not running) at boot and every 10 minutes, so
//! schedules fire and agents come back after reboots and crashes with no app connected.
//!
//! - root: system manager units in `/etc/systemd/system`;
//! - other users: user units in `$XDG_CONFIG_HOME/systemd/user` (`~/.config/systemd/user`), only
//!   with lingering (otherwise the user manager stops at logout and never starts at boot);
//! - elsewhere (macOS, Windows, Linux without systemd): nothing to install; automations run
//!   while tf-hostd runs.
//!
//! Units are named `teleflock-hostd-<hash of TF_HOSTD_HOME>.{service,timer}` so every hostd
//! home (the real one, lab instances) owns its own pair. `ensure` starts the daemon in its own
//! transient scope (`durable::Scope`), so the oneshot service's cgroup teardown spares it.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tracing::{info, warn};

use tf_proto::{AutomationScheduler, BootService};

use crate::paths::Paths;

const SYSTEMCTL_TIMEOUT: Duration = Duration::from_secs(20);

/// Which systemd instance holds the units.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    System { dir: PathBuf },
    User { dir: PathBuf, runtime_dir: PathBuf },
    /// systemd user units would work, but the user has no lingering. Units installed while it
    /// was on still live in `dir` (and the user manager, while one runs, at `runtime_dir`).
    NeedsLinger { user: String, dir: PathBuf, runtime_dir: PathBuf },
    /// No systemd here.
    None,
}

impl Target {
    pub fn detect() -> Target {
        detect()
    }

    fn dir(&self) -> Option<&Path> {
        match self {
            Target::System { dir } | Target::User { dir, .. } => Some(dir),
            _ => None,
        }
    }
}

/// What the host setting "Bring agents back after a reboot" can really do here: whether a boot
/// service (the keepalive timer) can be installed for this tf-hostd home (`target`: systemd as
/// root, or user units with lingering; `allowed`: the real home, or `TF_HOSTD_KEEPALIVE=1`) and
/// whether the scheduler `status` says it is installed and active.
pub fn boot_service(target: &Target, allowed: bool, status: &AutomationScheduler) -> BootService {
    let unavailable = |note: String| BootService { available: false, installed: false, note: Some(note) };
    match target {
        Target::None if cfg!(target_os = "linux") => unavailable(
            "Not available on this host: there is no systemd to install a boot service in, so agents come back after a reboot once TeleFlock or tf-hostd runs here again.".into(),
        ),
        Target::None => unavailable(format!(
            "Not available on this host: boot services are only installed with systemd on Linux (this host runs {}), so agents come back after a reboot once TeleFlock or tf-hostd runs here again.",
            std::env::consts::OS
        )),
        Target::NeedsLinger { user, .. } => unavailable(format!(
            "Not available yet: systemd stops {user}'s services at logout and does not start them at boot. Run `loginctl enable-linger {user}` on this host."
        )),
        Target::System { .. } | Target::User { .. } if !allowed => unavailable(
            "Not installed by this tf-hostd home: only the default home (~/.teleflock) installs a boot service (development homes opt in with TF_HOSTD_KEEPALIVE=1).".into(),
        ),
        Target::System { .. } | Target::User { .. } => BootService {
            available: true,
            installed: status.kind == "systemd" && status.persistent,
            note: status.note.clone().filter(|_| !(status.kind == "systemd" && status.persistent)),
        },
    }
}

#[cfg(target_os = "linux")]
fn detect() -> Target {
    if tf_herdr::durable::systemd_tool("systemctl").is_none() {
        return Target::None;
    }
    // SAFETY: geteuid has no preconditions.
    let uid = unsafe { libc::geteuid() };
    if uid == 0 {
        return Target::System { dir: PathBuf::from("/etc/systemd/system") };
    }
    let Some(user) = tf_herdr::durable::user_name(uid) else { return Target::None };
    let runtime_dir = PathBuf::from(format!("/run/user/{uid}"));
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::paths::home_dir().join(".config"));
    let dir = config.join("systemd").join("user");
    if !Path::new("/var/lib/systemd/linger").join(&user).exists() || !runtime_dir.is_dir() {
        return Target::NeedsLinger { user, dir, runtime_dir };
    }
    Target::User { dir, runtime_dir }
}

#[cfg(not(target_os = "linux"))]
fn detect() -> Target {
    Target::None
}

/// The unit file pair for one hostd home.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Units {
    pub stem: String,
    pub service: String,
    pub timer: String,
}

impl Units {
    pub fn service_name(&self) -> String {
        format!("{}.service", self.stem)
    }
    pub fn timer_name(&self) -> String {
        format!("{}.timer", self.stem)
    }
}

/// Quotes one word for a unit file (`%` is a specifier, `\` and `"` need escaping).
fn quote(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"").replace('%', "%%");
    if escaped.chars().any(|c| c.is_whitespace() || c == ';' || c == '\'') || escaped.is_empty() {
        format!("\"{escaped}\"")
    } else {
        escaped
    }
}

/// Builds the units. `env` carries the variables the daemon needs and a service manager does
/// not provide (`HOME`, `PATH` of the daemon that installs them, …), besides `TF_HOSTD_HOME`.
pub fn render(paths: &Paths, exe: &Path, relay_port: u16, env: &[(&str, String)]) -> Units {
    let stem = paths.unit_stem();
    let home = paths.home.display().to_string();
    let mut environment = format!("Environment={}\n", quote(&format!("TF_HOSTD_HOME={home}")));
    for (k, v) in env {
        environment.push_str(&format!("Environment={}\n", quote(&format!("{k}={v}"))));
    }
    let service = format!(
        "# Written by tf-hostd (TeleFlock automations and agent recovery); removed when neither needs it.\n\
         [Unit]\n\
         Description=TeleFlock host daemon keepalive ({home})\n\
         \n\
         [Service]\n\
         Type=oneshot\n\
         {environment}\
         ExecStart={} ensure --relay-port {relay_port}\n",
        quote(&exe.display().to_string()),
    );
    let timer = format!(
        "# Written by tf-hostd (TeleFlock automations and agent recovery); removed when neither needs it.\n\
         [Unit]\n\
         Description=Keeps the TeleFlock host daemon running for automations and agent recovery ({home})\n\
         \n\
         [Timer]\n\
         OnBootSec=1min\n\
         OnUnitActiveSec=10min\n\
         AccuracySec=30s\n\
         Unit={stem}.service\n\
         \n\
         [Install]\n\
         WantedBy=timers.target\n"
    );
    Units { stem, service, timer }
}

/// The running binary (without the ` (deleted)` suffix Linux adds after it was replaced).
fn exe_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let s = exe.to_string_lossy();
    Some(match s.strip_suffix(" (deleted)") {
        Some(p) => PathBuf::from(p),
        None => exe,
    })
}

/// Variables the daemon inherits from its login session but a service manager lacks.
fn daemon_env() -> Vec<(&'static str, String)> {
    ["HOME", "PATH", "USER", "LANG"]
        .into_iter()
        .filter_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()).map(|v| (k, v)))
        .collect()
}

async fn systemctl(target: &Target, args: &[&str]) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new("systemctl");
    if let Target::User { runtime_dir, .. } = target {
        cmd.arg("--user");
        if std::env::var_os("XDG_RUNTIME_DIR").is_none_or(|v| v.is_empty()) {
            cmd.env("XDG_RUNTIME_DIR", runtime_dir);
        }
    }
    cmd.args(args).stdin(std::process::Stdio::null()).kill_on_drop(true);
    let out = tokio::time::timeout(SYSTEMCTL_TIMEOUT, cmd.output())
        .await
        .map_err(|_| format!("systemctl {} timed out", args.join(" ")))?
        .map_err(|e| format!("systemctl: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() {
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(format!("systemctl {} failed: {}", args.join(" "), if stderr.is_empty() { stdout } else { stderr }))
    }
}

/// Writes `bytes` to `path` when it differs; true when written.
fn write_if_changed(path: &Path, bytes: &str) -> std::io::Result<bool> {
    if std::fs::read_to_string(path).is_ok_and(|cur| cur == bytes) {
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

/// Disables and deletes this home's units in `dir` (also the `timers.target.wants` link
/// `enable` made). `manager`: the systemd instance to tell, when one runs; without it the
/// files alone go (a user manager that starts later never sees them).
async fn remove_units(manager: Option<&Target>, dir: &Path, stem: &str) {
    let service = format!("{stem}.service");
    let timer = format!("{stem}.timer");
    let wants = dir.join("timers.target.wants").join(&timer);
    let files = [dir.join(&timer), dir.join(&service), wants];
    if !files.iter().any(|f| f.symlink_metadata().is_ok()) {
        return;
    }
    if let Some(m) = manager
        && let Err(e) = systemctl(m, &["disable", "--now", &timer]).await
    {
        warn!("automations: {e}");
    }
    for f in &files {
        let _ = std::fs::remove_file(f);
    }
    if let Some(m) = manager
        && let Err(e) = systemctl(m, &["daemon-reload"]).await
    {
        warn!("automations: {e}");
    }
    info!(unit = %timer, "automations: systemd keepalive removed");
}

/// Installs (`want`) or removes the keepalive units and reports the resulting scheduler kind.
pub async fn reconcile(paths: &Paths, relay_port: u16, want: bool) -> AutomationScheduler {
    let timezone = super::cron::tz_name(&super::cron::local_tz());
    let target = Target::detect();
    let daemon_only = |note: &str| AutomationScheduler { kind: "daemon".into(), persistent: false, note: Some(note.into()), timezone: timezone.clone() };
    match &target {
        Target::None => {
            return daemon_only(
                "Automations run while tf-hostd runs on this host: it starts when a TeleFlock app connects and keeps running after the app disconnects, until the host restarts.",
            );
        }
        Target::NeedsLinger { user, dir, runtime_dir } => {
            if !want {
                // Installed while lingering was on: the timer would keep running `ensure`.
                let manager = runtime_dir.is_dir().then(|| Target::User { dir: dir.clone(), runtime_dir: runtime_dir.clone() });
                remove_units(manager.as_ref(), dir, &paths.unit_stem()).await;
            }
            return AutomationScheduler {
                kind: "systemd".into(),
                persistent: false,
                note: Some(format!(
                    "Without lingering, systemd stops your services at logout and does not start them at boot. Run `loginctl enable-linger {user}` on this host so automations survive reboots; until then they run while tf-hostd runs."
                )),
                timezone,
            };
        }
        Target::System { .. } | Target::User { .. } => {}
    }
    let dir = target.dir().expect("systemd target has a unit dir").to_path_buf();
    if !want {
        remove_units(Some(&target), &dir, &paths.unit_stem()).await;
        return AutomationScheduler { kind: "systemd".into(), persistent: false, note: None, timezone };
    }
    let Some(exe) = exe_path() else {
        return daemon_only("Cannot locate the tf-hostd binary to install the systemd timer.");
    };
    let units = render(paths, &exe, relay_port, &daemon_env());
    let service_path = dir.join(units.service_name());
    let timer_path = dir.join(units.timer_name());
    let timer = units.timer_name();
    let changed = match (write_if_changed(&service_path, &units.service), write_if_changed(&timer_path, &units.timer)) {
        (Ok(a), Ok(b)) => a || b,
        (Err(e), _) | (_, Err(e)) => {
            warn!(dir = %dir.display(), "automations: cannot write systemd units: {e}");
            return AutomationScheduler {
                kind: "systemd".into(),
                persistent: false,
                note: Some(format!("Could not install the systemd timer in {}: {e}. Automations run while tf-hostd runs.", dir.display())),
                timezone,
            };
        }
    };
    let mut err = None;
    if changed && let Err(e) = systemctl(&target, &["daemon-reload"]).await {
        err = Some(e);
    }
    if err.is_none() && let Err(e) = systemctl(&target, &["enable", "--now", &timer]).await {
        err = Some(e);
    }
    let active = systemctl(&target, &["is-active", &timer]).await.is_ok_and(|s| s == "active");
    if changed && active {
        info!(unit = %timer, "automations: systemd keepalive installed");
    }
    AutomationScheduler {
        kind: "systemd".into(),
        persistent: active,
        note: (!active).then(|| match err {
            Some(e) => format!("The systemd timer is not active ({e}). Automations run while tf-hostd runs."),
            None => "The systemd timer is not active. Automations run while tf-hostd runs.".into(),
        }),
        timezone,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_files() {
        let paths = Paths::new(PathBuf::from("/tmp/tf lab"), true);
        let units = render(
            &paths,
            Path::new("/opt/tf/tf-hostd"),
            47605,
            &[("HOME", "/root".into()), ("PATH", "/root/.local/bin:/usr/bin".into())],
        );
        assert!(units.stem.starts_with("teleflock-hostd-") && units.stem.len() == "teleflock-hostd-".len() + 8);
        assert_ne!(units.stem, Paths::new(PathBuf::from("/root/.teleflock"), false).unit_stem());
        assert_eq!(
            units.service,
            "# Written by tf-hostd (TeleFlock automations and agent recovery); removed when neither needs it.\n\
             [Unit]\n\
             Description=TeleFlock host daemon keepalive (/tmp/tf lab)\n\
             \n\
             [Service]\n\
             Type=oneshot\n\
             Environment=\"TF_HOSTD_HOME=/tmp/tf lab\"\n\
             Environment=HOME=/root\n\
             Environment=PATH=/root/.local/bin:/usr/bin\n\
             ExecStart=/opt/tf/tf-hostd ensure --relay-port 47605\n"
        );
        assert!(units.timer.contains("\n[Timer]\nOnBootSec=1min\nOnUnitActiveSec=10min\n"));
        assert!(units.timer.contains(&format!("\nUnit={}.service\n", units.stem)));
        assert!(units.timer.ends_with("[Install]\nWantedBy=timers.target\n"));
    }

    #[test]
    fn quoting() {
        assert_eq!(quote("/usr/bin/x"), "/usr/bin/x");
        assert_eq!(quote("/a b/x"), "\"/a b/x\"");
        assert_eq!(quote("50%"), "50%%");
        assert_eq!(quote("a\"b c"), "\"a\\\"b c\"");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn units_go_without_a_running_manager() {
        // Lingering turned off after install: no user manager to tell, the files still go.
        let td = tempfile::tempdir().unwrap();
        let dir = td.path();
        let stem = Paths::new(PathBuf::from("/tmp/tf lab"), true).unit_stem();
        let other = dir.join("teleflock-hostd-0000beef.timer");
        std::fs::create_dir_all(dir.join("timers.target.wants")).unwrap();
        for f in [format!("{stem}.service"), format!("{stem}.timer")] {
            std::fs::write(dir.join(f), "x").unwrap();
        }
        std::fs::write(&other, "x").unwrap();
        let link = dir.join("timers.target.wants").join(format!("{stem}.timer"));
        std::os::unix::fs::symlink(dir.join(format!("{stem}.timer")), &link).unwrap();
        remove_units(None, dir, &stem).await;
        assert!(!dir.join(format!("{stem}.service")).exists() && !dir.join(format!("{stem}.timer")).exists());
        assert!(link.symlink_metadata().is_err(), "the enable link is gone too");
        assert!(other.exists(), "another home's units stay");
    }

    #[test]
    fn the_boot_service_setting_says_what_this_host_can_do() {
        let status = |kind: &str, persistent: bool, note: Option<&str>| AutomationScheduler { kind: kind.into(), persistent, note: note.map(Into::into), timezone: "UTC".into() };
        let system = Target::System { dir: PathBuf::from("/etc/systemd/system") };
        let user = Target::User { dir: PathBuf::from("/home/u/.config/systemd/user"), runtime_dir: PathBuf::from("/run/user/1000") };
        // root or a lingering user: available, and installed once the timer is active.
        for t in [&system, &user] {
            let off = boot_service(t, true, &status("systemd", false, None));
            assert_eq!((off.available, off.installed, off.note), (true, false, None));
            assert!(boot_service(t, true, &status("systemd", true, None)).installed);
            let broken = boot_service(t, true, &status("systemd", false, Some("The systemd timer is not active (boom).")));
            assert!(broken.available && !broken.installed && broken.note.as_deref().is_some_and(|n| n.contains("boom")), "{broken:?}");
        }
        // A user without lingering: systemd cannot start anything at boot for them.
        let linger = boot_service(&Target::NeedsLinger { user: "ada".into(), dir: PathBuf::new(), runtime_dir: PathBuf::new() }, true, &status("systemd", false, None));
        assert!(!linger.available && !linger.installed);
        assert!(linger.note.unwrap().contains("loginctl enable-linger ada"));
        // macOS, Windows, Linux without systemd: not available, whatever the scheduler says.
        let none = boot_service(&Target::None, true, &status("daemon", false, None));
        assert!(!none.available && !none.installed);
        assert!(none.note.unwrap().starts_with("Not available on this host"));
        // A development home installs none.
        let lab = boot_service(&system, false, &status("systemd", false, None));
        assert!(!lab.available && lab.note.unwrap().contains("TF_HOSTD_KEEPALIVE=1"));
    }
}
