//! Durable spawning: long-lived children (the herdr server, tf-hostd's daemon) must outlive the
//! login session that started them. On Linux with systemd, a process started from an SSH command
//! lives in that login's `session-*.scope`, and systemd stops the scope (killing everything in it)
//! whenever logind tears the session down: on logout with `KillUserProcesses=yes`, or when a
//! restarted logind cleans up sessions that had already ended.
//!
//! [`Scope::plan`] picks a fresh transient scope outside any login session:
//! - root: the system manager (`systemd-run --scope`);
//! - other users: their user manager (`systemd-run --user --scope`), only when lingering is
//!   enabled. Without lingering the user manager itself stops when the last session ends, which
//!   would be worse than staying in the session scope.
//!
//! Everywhere else (macOS, Windows, Linux without systemd) there is no plan and callers spawn
//! directly. `systemd-run --scope` moves itself into the new unit and then execs the command in
//! place (same pid), so callers keep their own `setsid`, stdio and environment handling. When it
//! cannot create the unit (no bus, permission) it exits with status 1 before exec'ing; callers
//! then retry with a plain spawn.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// The systemd instance that owns a transient scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Manager {
    System,
    User,
}

/// A transient scope to start a child in.
#[derive(Debug, Clone)]
pub struct Scope {
    pub manager: Manager,
    /// Full unit name, e.g. `teleflock-hostd-4242-1761165557000.scope`.
    pub unit: String,
    systemd_run: PathBuf,
    /// `XDG_RUNTIME_DIR` to set for `systemd-run --user` when the environment lacks it.
    runtime_dir: Option<PathBuf>,
}

impl Scope {
    /// A fresh scope named `<prefix>-<pid>-<unix ms>.scope`, or `None` when this host cannot
    /// (or should not) use one: not Linux, no systemd, no `systemd-run` on `PATH`, or a non-root
    /// user without lingering.
    pub fn plan(prefix: &str) -> Option<Scope> {
        let (manager, systemd_run, runtime_dir) = detect()?;
        Some(Scope { manager, unit: unit_name(prefix, std::process::id(), now_ms()), systemd_run, runtime_dir })
    }

    /// `systemd-run … -- <program>`: append the program's own arguments, then configure stdio,
    /// environment and `setsid` as for a plain spawn.
    pub fn command(&self, program: &Path, description: &str) -> Command {
        let mut cmd = Command::new(&self.systemd_run);
        cmd.args(systemd_run_args(self.manager, &self.unit, description)).arg(program);
        if let Some(dir) = &self.runtime_dir {
            cmd.env("XDG_RUNTIME_DIR", dir);
        }
        cmd
    }
}

/// `systemd-run` arguments up to and including `--` (the command follows).
pub fn systemd_run_args(manager: Manager, unit: &str, description: &str) -> Vec<String> {
    let mut args = Vec::with_capacity(8);
    if manager == Manager::User {
        args.push("--user".to_string());
    }
    args.extend(["--scope".to_string(), "--quiet".to_string(), "--collect".to_string()]);
    args.push(format!("--unit={unit}"));
    args.push(format!("--description={description}"));
    if manager == Manager::System {
        // Login-session scopes have no task limit; system units default to DefaultTasksMax.
        args.push("--property=TasksMax=infinity".to_string());
    }
    args.push("--".to_string());
    args
}

/// `<prefix>-<pid>-<ms>.scope`, with every byte outside `[A-Za-z0-9_-]` of the prefix replaced
/// by `_` (unit names allow few characters; session names may contain more).
pub fn unit_name(prefix: &str, pid: u32, ms: u64) -> String {
    let clean: String = prefix.chars().take(64).map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    format!("{clean}-{pid}-{ms}.scope")
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The systemd cgroup path from the text of `/proc/<pid>/cgroup`: the unified (`0::`) line,
/// else the v1 `name=systemd` line.
pub fn cgroup_path(proc_cgroup: &str) -> Option<&str> {
    let mut v1 = None;
    for line in proc_cgroup.lines() {
        let mut parts = line.splitn(3, ':');
        let (Some(id), Some(controllers), Some(path)) = (parts.next(), parts.next(), parts.next()) else { continue };
        if id == "0" && controllers.is_empty() {
            return Some(path);
        }
        if controllers == "name=systemd" {
            v1 = Some(path);
        }
    }
    v1
}

/// The login session id when `cgroup` lies in a logind session scope (`…/session-<id>.scope`).
pub fn login_session(cgroup: &str) -> Option<&str> {
    cgroup.split('/').find_map(|c| c.strip_prefix("session-")?.strip_suffix(".scope")).filter(|id| !id.is_empty())
}

/// The systemd cgroup path of a running process (`None` off Linux or when it is gone).
pub fn process_cgroup(pid: u32) -> Option<String> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/cgroup")).ok()?;
    cgroup_path(&text).map(str::to_string)
}

#[cfg(target_os = "linux")]
fn detect() -> Option<(Manager, PathBuf, Option<PathBuf>)> {
    if !Path::new("/run/systemd/system").is_dir() {
        return None;
    }
    let systemd_run = find_on_path("systemd-run")?;
    // SAFETY: geteuid has no preconditions.
    let uid = unsafe { libc::geteuid() };
    if uid == 0 {
        return Some((Manager::System, systemd_run, None));
    }
    let name = user_name(uid)?;
    let runtime = PathBuf::from(format!("/run/user/{uid}"));
    if !Path::new("/var/lib/systemd/linger").join(&name).exists() || !runtime.is_dir() {
        return None;
    }
    let runtime_dir = std::env::var_os("XDG_RUNTIME_DIR").filter(|v| !v.is_empty()).is_none().then_some(runtime);
    Some((Manager::User, systemd_run, runtime_dir))
}

#[cfg(not(target_os = "linux"))]
fn detect() -> Option<(Manager, PathBuf, Option<PathBuf>)> {
    None
}

/// Whether systemd runs as the init system and `program` is on `PATH` (Linux only).
pub fn systemd_tool(program: &str) -> Option<PathBuf> {
    if !cfg!(target_os = "linux") || !Path::new("/run/systemd/system").is_dir() {
        return None;
    }
    find_on_path(program)
}

fn find_on_path(program: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(program)).find(|p| crate::client::is_executable(p))
}

/// The user name of `uid` from the password database.
#[cfg(unix)]
pub fn user_name(uid: u32) -> Option<String> {
    let mut buf = vec![0 as libc::c_char; 16 * 1024];
    // SAFETY: a zeroed passwd is a valid out-parameter; getpwuid_r writes into it and `buf` only.
    let mut pw: libc::passwd = unsafe { std::mem::zeroed() };
    let mut out: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: every pointer is valid for the duration of the call and `buf.len()` is its size.
    let rc = unsafe { libc::getpwuid_r(uid, &mut pw, buf.as_mut_ptr(), buf.len(), &mut out) };
    if rc != 0 || out.is_null() || pw.pw_name.is_null() {
        return None;
    }
    // SAFETY: on success pw_name points to a NUL-terminated string inside `buf`.
    Some(unsafe { std::ffi::CStr::from_ptr(pw.pw_name) }.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn systemd_run_argv() {
        let unit = unit_name("teleflock-herdr-tf lab/1", 42, 1700);
        assert_eq!(unit, "teleflock-herdr-tf_lab_1-42-1700.scope");
        assert_eq!(
            systemd_run_args(Manager::System, &unit, "herdr server"),
            [
                "--scope",
                "--quiet",
                "--collect",
                "--unit=teleflock-herdr-tf_lab_1-42-1700.scope",
                "--description=herdr server",
                "--property=TasksMax=infinity",
                "--"
            ]
        );
        assert_eq!(
            systemd_run_args(Manager::User, "u.scope", "d"),
            ["--user", "--scope", "--quiet", "--collect", "--unit=u.scope", "--description=d", "--"]
        );
    }

    #[test]
    fn scope_command_wraps_the_program() {
        let scope = Scope { manager: Manager::System, unit: "x.scope".into(), systemd_run: "/usr/bin/systemd-run".into(), runtime_dir: None };
        let mut cmd = scope.command(Path::new("/bin/herdr"), "herdr");
        cmd.arg("server");
        assert_eq!(cmd.get_program(), "/usr/bin/systemd-run");
        let args: Vec<_> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args[args.len() - 3..], ["--", "/bin/herdr", "server"]);
    }

    #[test]
    fn cgroup_lines() {
        assert_eq!(cgroup_path("0::/user.slice/user-0.slice/session-c3.scope\n"), Some("/user.slice/user-0.slice/session-c3.scope"));
        // cgroup v1 (and hybrid without a unified line): the name=systemd hierarchy.
        let v1 = "12:pids:/user.slice/user-1000.slice\n1:name=systemd:/user.slice/user-1000.slice/session-2.scope\n";
        assert_eq!(cgroup_path(v1), Some("/user.slice/user-1000.slice/session-2.scope"));
        let hybrid = "1:name=systemd:/system.slice/a.scope\n0::/system.slice/a.scope\n";
        assert_eq!(cgroup_path(hybrid), Some("/system.slice/a.scope"));
        assert_eq!(cgroup_path("garbage\n3:cpu:/x\n"), None);

        assert_eq!(login_session("/user.slice/user-0.slice/session-c16.scope"), Some("c16"));
        assert_eq!(login_session("/user.slice/user-1000.slice/session-2.scope"), Some("2"));
        assert_eq!(login_session("/system.slice/teleflock-herdr-default-1-2.scope"), None);
        assert_eq!(login_session("/user.slice/user-1000.slice/user@1000.service/app.slice/x.scope"), None);
        assert_eq!(login_session("/user.slice/session-.scope"), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn own_cgroup_is_readable() {
        assert!(process_cgroup(std::process::id()).is_some_and(|p| p.starts_with('/')));
    }
}
