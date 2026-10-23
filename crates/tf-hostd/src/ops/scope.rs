//! A herdr server stuck in a login session (setup fix [`FIX_HERDR_SCOPE`]).
//!
//! On Linux with systemd, a herdr server started from an SSH command (by hand, or by an older
//! tf-hostd) lives in that login's `session-*.scope` together with every pane shell and omp
//! agent under it. systemd stops that scope, killing all of them, when logind tears the session
//! down: on logout with `KillUserProcesses=yes`, or when a restarted logind cleans up sessions
//! that had already ended. New servers start in their own scope ([`tf_herdr::durable`]); this
//! module finds a running one that does not and, on request, moves its live process tree into a
//! new transient scope (systemd `StartTransientUnit` with `PIDs`). Nothing is stopped or restarted.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{Duration, Instant};

use tf_herdr::durable;

pub const FIX_HERDR_SCOPE: &str = "move-herdr-out-of-login-session";

const BUSCTL_TIMEOUT_S: u32 = 20;

/// The herdr server this daemon talks to, found in a login-session scope.
#[derive(Debug, Clone, PartialEq)]
pub struct LoginBound {
    pub pid: u32,
    /// logind session id (`c16` for `session-c16.scope`).
    pub session: String,
    /// Processes of the server's tree (itself included) in a login-session scope.
    pub processes: usize,
}

/// Whether this daemon may move processes between systemd units: root, systemd, `busctl`.
pub fn can_adopt() -> bool {
    #[cfg(unix)]
    // SAFETY: geteuid has no preconditions.
    let root = unsafe { libc::geteuid() } == 0;
    #[cfg(not(unix))]
    let root = false;
    root && durable::systemd_tool("busctl").is_some()
}

/// The herdr server behind `socket`, when it runs in a login-session scope (Linux only).
pub async fn herdr_in_login_session(socket: &Path) -> Option<LoginBound> {
    let pid = listener_pid(socket).await?;
    tokio::task::spawn_blocking(move || {
        let session = durable::login_session(&durable::process_cgroup(pid)?)?.to_string();
        Some(LoginBound { pid, session, processes: login_tree(pid).len() })
    })
    .await
    .ok()?
}

/// The pid of the process that listens on `socket` (`SO_PEERCRED`).
#[cfg(target_os = "linux")]
async fn listener_pid(socket: &Path) -> Option<u32> {
    let stream = tokio::time::timeout(Duration::from_secs(2), tokio::net::UnixStream::connect(socket)).await.ok()?.ok()?;
    stream.peer_cred().ok()?.pid().and_then(|p| u32::try_from(p).ok()).filter(|p| *p > 0)
}

#[cfg(not(target_os = "linux"))]
async fn listener_pid(_socket: &Path) -> Option<u32> {
    None
}

/// The setup issue for `bound`: fixable for root on systemd, an explanation otherwise.
pub fn issue(bound: &LoginBound, herdr_session: &str) -> tf_proto::SetupIssue {
    let LoginBound { pid, session, processes } = bound;
    let what = format!(
        "The herdr server of session {herdr_session} (pid {pid}) and {} run in login session {session} (session-{session}.scope). When logind tears that session down (on logout with KillUserProcesses=yes, or when a restarted logind cleans up sessions that already ended), systemd stops the scope and every agent in it dies.",
        match processes.saturating_sub(1) {
            0 => "nothing else".to_string(),
            1 => "1 process under it".to_string(),
            n => format!("{n} processes under it (pane shells, omp agents and their tools)"),
        }
    );
    let (fixable, how) = if can_adopt() {
        (true, " Moves them, still running, into their own systemd scope (teleflock-herdr-…); nothing is stopped or restarted.".to_string())
    } else {
        (false, unprivileged_hint())
    };
    tf_proto::SetupIssue {
        id: FIX_HERDR_SCOPE.into(),
        severity: tf_proto::Severity::Warn,
        title: "Move herdr out of its login session".into(),
        detail: format!("{what}{how}"),
        fixable,
        recommended: true,
    }
}

/// Why this daemon can't fix it, and what the user can do.
fn unprivileged_hint() -> String {
    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions.
        let uid = unsafe { libc::geteuid() };
        if uid == 0 {
            return " TeleFlock cannot move it here: busctl is not available.".into();
        }
        let user = durable::user_name(uid).unwrap_or_else(|| uid.to_string());
        let restart = "The running server stays exposed until herdr is restarted (which restarts its agents); TeleFlock never does that for you.";
        if Path::new("/var/lib/systemd/linger").join(&user).exists() {
            format!(" Moving a running server needs root. Lingering is on, so herdr servers TeleFlock starts run under your systemd user manager, outside login sessions. {restart}")
        } else {
            format!(" Moving a running server needs root. Enable lingering (`sudo loginctl enable-linger {user}`) so herdr servers TeleFlock starts run under your systemd user manager, outside login sessions. {restart}")
        }
    }
    #[cfg(not(unix))]
    {
        String::new()
    }
}

/// Moves the herdr server `pid` and every process under it that sits in a login-session scope
/// into the new scope `teleflock-herdr-<session>-<pid>-<ms>.scope`; returns the unit name.
/// Blocking (runs `busctl`).
pub fn adopt(pid: u32, herdr_session: &str) -> Result<String, String> {
    let busctl = durable::systemd_tool("busctl").ok_or("busctl is not available")?;
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let unit = durable::unit_name(&format!("teleflock-herdr-{herdr_session}"), pid, ms);
    let description = format!("herdr server (session {herdr_session}) and its agents, moved out of a login session by TeleFlock");
    let busctl_run = |args: Vec<String>| -> Result<(), String> {
        let out = std::process::Command::new(&busctl).args(args).stdin(std::process::Stdio::null()).output().map_err(|e| format!("busctl: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    };

    if !durable::process_cgroup(pid).is_some_and(|c| durable::login_session(&c).is_some()) {
        return Err(format!("herdr server (pid {pid}) is no longer in a login session"));
    }
    // The scope starts with the long-lived server alone: one listed process that exits before
    // systemd reads the list fails the whole call, and short-lived tool processes come and go.
    busctl_run(start_transient_unit_args(&unit, pid, &description)).map_err(|e| format!("systemd refused to create {unit}: {e}"))?;
    let in_unit = |p: u32| durable::process_cgroup(p).is_some_and(|c| c.rsplit('/').next() == Some(unit.as_str()));
    let deadline = Instant::now() + Duration::from_secs(5);
    while !in_unit(pid) {
        if Instant::now() > deadline {
            return Err(format!("herdr server (pid {pid}) did not move into {unit}"));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    // Then the rest of the tree, parents first, so whatever they fork from then on starts in the
    // unit; a few passes catch processes forked meanwhile. A batch fails as a whole when one of
    // its processes exits meanwhile; then each is attached on its own.
    for _ in 0..5 {
        let rest = login_tree(pid);
        if rest.is_empty() {
            return Ok(unit);
        }
        if busctl_run(attach_processes_args(&unit, &rest)).is_err() {
            for p in rest {
                let _ = busctl_run(attach_processes_args(&unit, &[p]));
            }
        }
    }
    match login_tree(pid).len() {
        0 => Ok(unit),
        n => Err(format!("moved herdr into {unit}, but {n} of its processes stayed in the login session")),
    }
}

/// `busctl` arguments for `Manager.StartTransientUnit(<unit>, "fail", {PIDs: [pid], Description,
/// CollectMode, TasksMax, Delegate}, [])` on the system bus.
pub(crate) fn start_transient_unit_args(unit: &str, pid: u32, description: &str) -> Vec<String> {
    let mut a = manager_call("StartTransientUnit", "ssa(sv)a(sa(sv))");
    a.extend([unit.to_string(), "fail".into(), "5".into(), "PIDs".into(), "au".into(), "1".into(), pid.to_string()]);
    a.extend(["Description".into(), "s".into(), description.to_string()]);
    a.extend(["CollectMode".into(), "s".into(), "inactive-or-failed".into()]);
    // Login-session scopes have no task limit; system units default to DefaultTasksMax.
    a.extend(["TasksMax".into(), "t".into(), u64::MAX.to_string()]);
    // systemd attaches further processes (AttachProcessesToUnit) only to delegated units.
    a.extend(["Delegate".into(), "b".into(), "true".into()]);
    a.push("0".into());
    a
}

/// `busctl` arguments for `Manager.AttachProcessesToUnit(<unit>, "", pids)`.
pub(crate) fn attach_processes_args(unit: &str, pids: &[u32]) -> Vec<String> {
    let mut a = manager_call("AttachProcessesToUnit", "ssau");
    a.extend([unit.to_string(), String::new(), pids.len().to_string()]);
    a.extend(pids.iter().map(u32::to_string));
    a
}

fn manager_call(method: &str, signature: &str) -> Vec<String> {
    [
        &format!("--timeout={BUSCTL_TIMEOUT_S}"),
        "call",
        "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
        method,
        signature,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// `pid` and its descendants that currently sit in a login-session scope.
fn login_tree(pid: u32) -> Vec<u32> {
    descendants(pid, &proc_table())
        .into_iter()
        .filter(|p| durable::process_cgroup(*p).is_some_and(|c| durable::login_session(&c).is_some()))
        .collect()
}

/// `(pid, ppid)` of every process in `/proc`.
fn proc_table() -> Vec<(u32, u32)> {
    let Ok(dir) = std::fs::read_dir("/proc") else { return Vec::new() };
    dir.filter_map(|e| {
        let pid: u32 = e.ok()?.file_name().to_str()?.parse().ok()?;
        let ppid = parse_ppid(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)?;
        Some((pid, ppid))
    })
    .collect()
}

/// The parent pid from `/proc/<pid>/stat` (`pid (comm) state ppid …`; comm may hold spaces and
/// parentheses, so fields are read after the last `)`).
pub(crate) fn parse_ppid(stat: &str) -> Option<u32> {
    let rest = &stat[stat.rfind(')')? + 1..];
    rest.split_whitespace().nth(1)?.parse().ok()
}

/// `root` followed by every descendant of it in `procs` (`(pid, ppid)` pairs), breadth first.
/// Empty when `root` is not in `procs`.
pub(crate) fn descendants(root: u32, procs: &[(u32, u32)]) -> Vec<u32> {
    if !procs.iter().any(|(p, _)| *p == root) {
        return Vec::new();
    }
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for &(pid, ppid) in procs {
        if pid != ppid {
            children.entry(ppid).or_default().push(pid);
        }
    }
    let mut out = vec![root];
    let mut seen: HashSet<u32> = HashSet::from([root]);
    let mut i = 0;
    while i < out.len() {
        for &c in children.get(&out[i]).map(Vec::as_slice).unwrap_or_default() {
            if seen.insert(c) {
                out.push(c);
            }
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ppid_from_stat() {
        assert_eq!(parse_ppid("4894 (herdr) S 1 4894 4894 0 -1 4194560 …"), Some(1));
        assert_eq!(parse_ppid("77 (weird ) name) (x) R 4894 77 77 0"), Some(4894));
        assert_eq!(parse_ppid("77 (no close paren S 1"), None);
        assert_eq!(parse_ppid("77 (x)"), None);
    }

    #[test]
    fn process_tree() {
        // 10 = herdr; 11, 12 = pane shells; 13 = omp under 11; 14 = tool under 13; 20 = unrelated.
        let procs = [(1, 0), (10, 1), (11, 10), (12, 10), (13, 11), (14, 13), (20, 1), (21, 20)];
        assert_eq!(descendants(10, &procs), vec![10, 11, 12, 13, 14]);
        assert_eq!(descendants(13, &procs), vec![13, 14]);
        assert_eq!(descendants(99, &procs), Vec::<u32>::new());
        // A (corrupt) cycle terminates.
        assert_eq!(descendants(5, &[(5, 6), (6, 5)]), vec![5, 6]);
    }

    #[test]
    fn busctl_argv() {
        let a = start_transient_unit_args("teleflock-herdr-default-7-1.scope", 7, "herdr");
        assert_eq!(
            a,
            [
                "--timeout=20",
                "call",
                "org.freedesktop.systemd1",
                "/org/freedesktop/systemd1",
                "org.freedesktop.systemd1.Manager",
                "StartTransientUnit",
                "ssa(sv)a(sa(sv))",
                "teleflock-herdr-default-7-1.scope",
                "fail",
                "5",
                "PIDs",
                "au",
                "1",
                "7",
                "Description",
                "s",
                "herdr",
                "CollectMode",
                "s",
                "inactive-or-failed",
                "TasksMax",
                "t",
                "18446744073709551615",
                "Delegate",
                "b",
                "true",
                "0",
            ]
        );
        let b = attach_processes_args("u.scope", &[42, 43]);
        assert_eq!(b[5..], ["AttachProcessesToUnit", "ssau", "u.scope", "", "2", "42", "43"]);
    }
}
