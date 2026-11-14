//! What [`super`] asks of the host: look at it, raise units and processes, move a process into a
//! scope. [`real`] is this OS's; tests hand in a recorder, so they never change a real unit or
//! process.

use std::sync::Arc;
#[cfg(target_os = "linux")]
use std::time::Duration;

use tf_herdr::durable::Manager;

#[cfg(target_os = "linux")]
use super::{Proc, Target, Unit};
use super::{Facts, Services};

/// Why a change did not happen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fail {
    /// Not permitted (needs root, or an administrator on Windows).
    Denied,
    /// The process or unit is gone.
    Gone,
    Other(String),
}

/// The weights a raise replaced (`None`: left as it was, already that high).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Replaced {
    pub cpu: Option<u64>,
    pub io: Option<u64>,
}

pub trait System: Send + Sync {
    /// What runs here and what decides its priority; `services`: what this home may touch.
    fn observe(&self, services: &Services) -> Facts;
    /// Whether a process can be moved into a new transient scope of `manager` now: moves a
    /// throwaway one, as [`super::work`] does for agents' work.
    fn probe(&self, manager: Manager) -> bool;
    /// `CPUWeight` and `IOWeight` of `unit` at least [`super::WEIGHT`] (runtime only).
    fn raise_weights(&self, unit: &super::Unit) -> Result<Replaced, Fail>;
    /// Puts back what [`System::raise_weights`] replaced.
    fn restore_weights(&self, unit: &super::Unit, replaced: &Replaced) -> Result<(), Fail>;
    /// nice [`super::NICE`] on every thread of `pid` that runs below it, and on its autogroup.
    fn renice(&self, pid: u32, autogroup: bool) -> Result<(), Fail>;
    /// Windows: `ABOVE_NORMAL_PRIORITY_CLASS` for `pid`, unless it runs higher.
    fn raise_class(&self, pid: u32) -> Result<(), Fail>;
    /// Moves `pid` into a new transient scope `unit` of `manager` (systemd's `StartTransientUnit`)
    /// and waits until it is there. [`Fail::Gone`]: the process ended first.
    fn place(&self, manager: Manager, unit: &str, description: &str, pid: u32) -> Result<(), Fail>;
}

/// This OS's [`System`].
pub fn real() -> Arc<dyn System> {
    Arc::new(Real)
}

struct Real;

/// `attach`: raises the calling process where that needs no one's help (see [`super::raise_attach`]).
pub(super) fn raise_self() {
    #[cfg(unix)]
    // SAFETY: plain system calls on this process; getpriority(PRIO_PROCESS, 0) cannot fail.
    unsafe {
        if libc::geteuid() == 0 && libc::getpriority(libc::PRIO_PROCESS, 0) > super::NICE {
            libc::setpriority(libc::PRIO_PROCESS, 0, super::NICE);
        }
    }
    #[cfg(windows)]
    windows::raise_own();
}

// ───────────────────────────── Linux ─────────────────────────────

#[cfg(target_os = "linux")]
impl System for Real {
    fn observe(&self, services: &Services) -> Facts {
        linux::observe(services)
    }

    fn probe(&self, manager: Manager) -> bool {
        linux::probe(manager)
    }

    fn raise_weights(&self, unit: &Unit) -> Result<Replaced, Fail> {
        linux::raise_weights(unit)
    }

    fn restore_weights(&self, unit: &Unit, replaced: &Replaced) -> Result<(), Fail> {
        linux::restore_weights(unit, replaced)
    }

    fn renice(&self, pid: u32, autogroup: bool) -> Result<(), Fail> {
        linux::renice(pid, autogroup)
    }

    fn raise_class(&self, _pid: u32) -> Result<(), Fail> {
        Err(Fail::Other("priority classes are Windows only".into()))
    }

    fn place(&self, manager: Manager, unit: &str, description: &str, pid: u32) -> Result<(), Fail> {
        linux::place(manager, unit, description, pid)
    }
}

#[cfg(target_os = "linux")]
pub(super) mod linux {
    use std::io::Read as _;
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::time::Instant;

    use super::*;
    use crate::priority::{NICE, Os, WEIGHT};

    const CGROUP_ROOT: &str = "/sys/fs/cgroup";
    /// One `systemctl` or `busctl` call.
    const TOOL_TIMEOUT: Duration = Duration::from_secs(20);
    /// How long a moved process may take to show up in its new scope (systemd moves it once the
    /// job runs, after it answered).
    const MOVE_WAIT: Duration = Duration::from_secs(3);

    /// What holds for every process of the host, read once per check.
    struct Host {
        systemd: bool,
        v2: bool,
        /// cgroup v2 with the CPU controller enabled below the root: nothing but `/` is in the
        /// root CPU group.
        cpu_below_root: bool,
        autogroup: bool,
        euid: u32,
    }

    impl Host {
        fn read() -> Host {
            let v2 = Path::new(CGROUP_ROOT).join("cgroup.controllers").exists();
            Host {
                systemd: tf_herdr::durable::systemd_tool("systemctl").is_some(),
                v2,
                cpu_below_root: v2 && has_word(&read(&format!("{CGROUP_ROOT}/cgroup.subtree_control")), "cpu"),
                autogroup: read("/proc/sys/kernel/sched_autogroup_enabled").trim() == "1",
                // SAFETY: geteuid has no preconditions.
                euid: unsafe { libc::geteuid() },
            }
        }

        fn proc(&self, pid: u32) -> Option<Proc> {
            let text = std::fs::read_to_string(format!("/proc/{pid}/cgroup")).ok()?;
            let unit = tf_herdr::durable::cgroup_path(&text).and_then(unit_of);
            let weights = self.systemd && self.v2 && unit.as_ref().is_some_and(|u| offers(&u.cgroup, "cpu"));
            let autogroup = self.autogroup && in_root_cpu_group(&text, self.v2, self.cpu_below_root);
            Some(Proc { pid, unit, weights, autogroup })
        }

        /// The processes of a unit standing for a service (labs): its first process stands for it.
        fn unit_procs(&self, name: &str) -> Vec<Proc> {
            let manager = if self.euid == 0 { Manager::System } else { Manager::User };
            let Ok(cgroup) = systemctl(manager, &["show", "--property=ControlGroup", "--value", name]) else { return Vec::new() };
            let first = read(&format!("{CGROUP_ROOT}{cgroup}/cgroup.procs")).lines().find_map(|l| l.trim().parse::<u32>().ok());
            first.and_then(|pid| self.proc(pid)).into_iter().collect()
        }

        /// A herdr server (`herdr [--session S] server`) among the processes of `cgroup`, other
        /// than `own`. The short-lived `herdr` commands tf-hostd runs itself (`status`,
        /// `terminal session …`) are not servers.
        fn herdr_server_in(&self, cgroup: &str, own: u32) -> bool {
            self.v2
                && read(&format!("{CGROUP_ROOT}{cgroup}/cgroup.procs"))
                    .lines()
                    .filter_map(|l| l.trim().parse::<u32>().ok())
                    .filter(|pid| *pid != own)
                    .any(|pid| read(&format!("/proc/{pid}/comm")).trim() == "herdr" && is_server_cmdline(&std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default()))
        }
    }

    pub(in crate::priority) fn observe(services: &Services) -> Facts {
        let host = Host::read();
        let pid = std::process::id();
        let own = host.proc(pid).unwrap_or_else(|| Proc::plain(pid));
        let herdr_in_own_cgroup = own.unit.is_some() && tf_herdr::durable::process_cgroup(pid).is_some_and(|cg| host.herdr_server_in(&cg, pid));
        let services = match services {
            Services::Untouched => Vec::new(),
            Services::Discover => {
                let procs = proc_table();
                let found = |name: &str| started_by_init(&procs, name).into_iter().filter_map(|pid| host.proc(pid)).collect::<Vec<_>>();
                vec![(Target::Ssh, found("sshd")), (Target::Tailscale, found("tailscaled"))]
            }
            Services::StandIns(units) => units.iter().map(|(target, unit)| (*target, host.unit_procs(unit))).collect(),
        };
        Facts { os: Os::Linux, privileged: host.euid == 0, own, herdr_in_own_cgroup, services }
    }

    /// The systemd unit a cgroup path belongs to: its deepest `.service` or `.scope`, in a user
    /// manager when below a `user@<uid>.service`.
    pub(in crate::priority) fn unit_of(cgroup: &str) -> Option<Unit> {
        let parts: Vec<&str> = cgroup.split('/').filter(|p| !p.is_empty()).collect();
        let i = parts.iter().rposition(|p| p.ends_with(".service") || p.ends_with(".scope"))?;
        let user = parts[..i].iter().any(|p| p.starts_with("user@") && p.ends_with(".service"));
        Some(Unit { manager: if user { Manager::User } else { Manager::System }, name: parts[i].to_string(), cgroup: format!("/{}", parts[..=i].join("/")) })
    }

    /// Whether the parent of `cgroup` offers `controller` to its children (so systemd can enable
    /// it for the unit).
    fn offers(cgroup: &str, controller: &str) -> bool {
        let parent = cgroup.rsplit_once('/').map_or("", |(p, _)| p);
        has_word(&read(&format!("{CGROUP_ROOT}{parent}/cgroup.controllers")), controller)
    }

    /// Whether a task (its `/proc/<pid>/cgroup` text) is in the root CPU group, where autogroups
    /// compete: cgroup v2 without the CPU controller below the root, or the root cgroup itself;
    /// cgroup v1 with the `cpu` hierarchy's root (or no `cpu` hierarchy).
    pub(in crate::priority) fn in_root_cpu_group(proc_cgroup: &str, v2: bool, cpu_below_root: bool) -> bool {
        if v2 {
            return !cpu_below_root || tf_herdr::durable::cgroup_path(proc_cgroup) == Some("/");
        }
        proc_cgroup
            .lines()
            .filter_map(|l| {
                let mut parts = l.splitn(3, ':');
                let (_, controllers, path) = (parts.next()?, parts.next()?, parts.next()?);
                controllers.split(',').any(|c| c == "cpu").then_some(path)
            })
            .next()
            .is_none_or(|path| path == "/")
    }

    /// `herdr [--session S] server` (NUL-separated `/proc/<pid>/cmdline`).
    pub(in crate::priority) fn is_server_cmdline(cmdline: &[u8]) -> bool {
        cmdline.split(|b| *b == 0).rfind(|a| !a.is_empty()) == Some(b"server")
    }

    /// pid → (command name, parent pid) of every process.
    fn proc_table() -> Vec<(u32, String, u32)> {
        let Ok(dir) = std::fs::read_dir("/proc") else { return Vec::new() };
        dir.flatten()
            .filter_map(|e| e.file_name().to_str()?.parse::<u32>().ok())
            .filter_map(|pid| {
                let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
                let (comm, ppid, _) = parse_stat(&stat)?;
                Some((pid, comm.to_string(), ppid))
            })
            .collect()
    }

    /// The processes named `name` that init started: the SSH server's listener, tailscaled's main
    /// process; not their per-connection children (`be-child`), not a container's copies (their
    /// parent is the container's init).
    pub(in crate::priority) fn started_by_init(table: &[(u32, String, u32)], name: &str) -> Vec<u32> {
        table.iter().filter(|(_, comm, ppid)| comm == name && *ppid == 1).map(|(pid, ..)| *pid).collect()
    }

    /// (command name, parent pid, nice) from a `/proc/<pid>/stat` line (the name may hold spaces
    /// and parentheses).
    pub(in crate::priority) fn parse_stat(stat: &str) -> Option<(&str, u32, i32)> {
        let open = stat.find('(')?;
        let close = stat.rfind(')')?;
        let comm = stat.get(open + 1..close)?;
        let rest: Vec<&str> = stat.get(close + 1..)?.split_whitespace().collect();
        // rest[0] is field 3 (state): the parent is field 4, nice field 19.
        Some((comm, rest.get(1)?.parse().ok()?, rest.get(16)?.parse().ok()?))
    }

    /// The nice value in `/proc/<pid>/autogroup` (`/autogroup-123 nice 0`).
    pub(in crate::priority) fn autogroup_nice(text: &str) -> Option<i32> {
        text.split_whitespace().skip_while(|w| *w != "nice").nth(1)?.parse().ok()
    }

    /// `io.weight`'s default (`default 100`).
    pub(in crate::priority) fn io_weight(text: &str) -> Option<u64> {
        text.lines().find_map(|l| l.strip_prefix("default "))?.trim().parse().ok()
    }

    pub(in crate::priority) fn renice(pid: u32, autogroup: bool) -> Result<(), Fail> {
        let tasks = std::fs::read_dir(format!("/proc/{pid}/task")).map_err(|_| Fail::Gone)?;
        let (mut any, mut denied) = (false, false);
        for tid in tasks.flatten().filter_map(|e| e.file_name().to_str()?.parse::<u32>().ok()) {
            let Some(nice) = std::fs::read_to_string(format!("/proc/{pid}/task/{tid}/stat")).ok().and_then(|s| parse_stat(&s).map(|(_, _, n)| n)) else { continue };
            if nice <= NICE {
                any = true;
                continue;
            }
            // SAFETY: setpriority on one thread id; no memory is passed.
            if unsafe { libc::setpriority(libc::PRIO_PROCESS, tid as libc::id_t, NICE) } == 0 {
                any = true;
                continue;
            }
            match std::io::Error::last_os_error().raw_os_error() {
                Some(libc::EPERM | libc::EACCES) => denied = true,
                // The thread ended meanwhile.
                Some(libc::ESRCH) => {}
                _ => return Err(Fail::Other(format!("setpriority: {}", std::io::Error::last_os_error()))),
            }
        }
        if autogroup && !denied {
            let path = format!("/proc/{pid}/autogroup");
            if autogroup_nice(&read(&path)).is_some_and(|n| n > NICE)
                && let Err(e) = std::fs::write(&path, NICE.to_string())
            {
                match e.raw_os_error() {
                    Some(libc::EPERM | libc::EACCES) => denied = true,
                    Some(libc::ESRCH | libc::ENOENT) => {}
                    _ => return Err(Fail::Other(format!("{path}: {e}"))),
                }
            }
        }
        if denied {
            Err(Fail::Denied)
        } else if any {
            Ok(())
        } else {
            Err(Fail::Gone)
        }
    }

    pub(in crate::priority) fn raise_weights(unit: &Unit) -> Result<Replaced, Fail> {
        let dir = format!("{CGROUP_ROOT}{}", unit.cgroup);
        // Files that are missing (the controller not enabled for the unit yet) mean the default.
        let cpu = read(&format!("{dir}/cpu.weight")).trim().parse().unwrap_or(100);
        let io = io_weight(&read(&format!("{dir}/io.weight"))).unwrap_or(100);
        let mut replaced = Replaced::default();
        let mut set = Vec::new();
        if cpu < WEIGHT {
            set.push(format!("CPUWeight={WEIGHT}"));
            replaced.cpu = Some(cpu);
        }
        // Only where systemd can enable the I/O controller for it: else it would ask every time.
        if io < WEIGHT && offers(&unit.cgroup, "io") {
            set.push(format!("IOWeight={WEIGHT}"));
            replaced.io = Some(io);
        }
        if !set.is_empty() {
            let mut args = vec!["set-property", "--runtime", unit.name.as_str()];
            args.extend(set.iter().map(String::as_str));
            systemctl(unit.manager, &args).map_err(classify)?;
        }
        Ok(replaced)
    }

    pub(in crate::priority) fn restore_weights(unit: &Unit, replaced: &Replaced) -> Result<(), Fail> {
        let set: Vec<String> = [("CPUWeight", replaced.cpu), ("IOWeight", replaced.io)].iter().filter_map(|(k, v)| Some(format!("{k}={}", (*v)?))).collect();
        if set.is_empty() {
            return Ok(());
        }
        let mut args = vec!["set-property", "--runtime", unit.name.as_str()];
        args.extend(set.iter().map(String::as_str));
        systemctl(unit.manager, &args).map(|_| ()).map_err(classify)
    }

    pub(in crate::priority) fn probe(manager: Manager) -> bool {
        use std::os::unix::process::CommandExt;
        let unit = crate::priority::work::unit_name("teleflock-priority-check");
        let place: crate::priority::work::Place = Arc::new(move |pid| place(manager, &unit, "TeleFlock priority check", pid));
        let Ok(gate) = crate::priority::work::Gate::new(place) else { return false };
        let mut noop = Command::new("/bin/sh");
        noop.args(["-c", ":"]);
        let mut cmd = gate.wrap(&noop);
        let fd = gate.child_fd();
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        // SAFETY: setsid, dup2 and fcntl are async-signal-safe.
        unsafe {
            cmd.pre_exec(move || {
                libc::setsid();
                crate::priority::work::keep(fd)
            });
        }
        let Ok(mut child) = cmd.spawn() else { return false };
        let moved = gate.go(Some(child.id()));
        let deadline = Instant::now() + MOVE_WAIT;
        let ran = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status.success(),
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break false;
                }
            }
        };
        if let Err(e) = &moved {
            tracing::debug!("priority probe: {e:?}");
        }
        moved.is_ok() && ran
    }

    pub(in crate::priority) fn place(manager: Manager, unit: &str, description: &str, pid: u32) -> Result<(), Fail> {
        let busctl = tf_herdr::durable::systemd_tool("busctl").ok_or_else(|| Fail::Other("busctl is not installed".into()))?;
        let mut cmd = Command::new(busctl);
        user_manager(&mut cmd, manager);
        let pid_arg = pid.to_string();
        let mut props = vec!["PIDs", "au", "1", pid_arg.as_str(), "Description", "s", description, "CollectMode", "s", "inactive-or-failed"];
        if manager == Manager::System {
            // As `systemd-run --scope` from `tf_herdr::durable`: system units default to
            // DefaultTasksMax, login sessions have no task limit.
            props.extend(["TasksMax", "t", "18446744073709551615"]);
        }
        let count = (props.len() / 3).to_string();
        cmd.args(["--timeout=5", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "StartTransientUnit", "ssa(sv)a(sa(sv))", unit, "fail"])
            .arg(&count)
            .args(&props)
            .arg("0");
        // systemd refuses a pid that is gone: "Failed to set unit properties: No such process".
        run(cmd).map_err(|e| if e.contains("No such process") { Fail::Gone } else { classify(e) })?;
        let deadline = Instant::now() + MOVE_WAIT;
        loop {
            match tf_herdr::durable::process_cgroup(pid) {
                Some(cgroup) if cgroup.rsplit('/').next() == Some(unit) => return Ok(()),
                None => return Err(Fail::Gone),
                Some(_) if Instant::now() >= deadline => return Err(Fail::Other(format!("{unit} did not take process {pid} within {} s", MOVE_WAIT.as_secs()))),
                Some(_) => std::thread::sleep(Duration::from_millis(10)),
            }
        }
    }

    fn user_manager(cmd: &mut Command, manager: Manager) {
        if manager == Manager::User {
            cmd.arg("--user");
            if std::env::var_os("XDG_RUNTIME_DIR").is_none_or(|v| v.is_empty()) {
                // SAFETY: geteuid has no preconditions.
                cmd.env("XDG_RUNTIME_DIR", format!("/run/user/{}", unsafe { libc::geteuid() }));
            }
        }
    }

    fn systemctl(manager: Manager, args: &[&str]) -> Result<String, String> {
        let mut cmd = Command::new(tf_herdr::durable::systemd_tool("systemctl").ok_or("systemctl is not installed")?);
        user_manager(&mut cmd, manager);
        cmd.args(args);
        run(cmd)
    }

    /// Runs a short tool to its end (killed after [`TOOL_TIMEOUT`]): its trimmed stdout, or why
    /// it failed.
    fn run(mut cmd: Command) -> Result<String, String> {
        let name = Path::new(cmd.get_program()).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let line = format!("{name} {}", cmd.get_args().map(|a| a.to_string_lossy()).collect::<Vec<_>>().join(" "));
        let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("{name}: {e}"))?;
        let deadline = Instant::now() + TOOL_TIMEOUT;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("{line} timed out"));
                }
                Err(e) => return Err(format!("{name}: {e}")),
            }
        };
        let (mut out, mut err) = (String::new(), String::new());
        if let Some(mut s) = child.stdout.take() {
            let _ = s.read_to_string(&mut out);
        }
        if let Some(mut s) = child.stderr.take() {
            let _ = s.read_to_string(&mut err);
        }
        if status.success() {
            Ok(out.trim().to_string())
        } else {
            Err(format!("{line} failed: {}", if err.trim().is_empty() { out.trim() } else { err.trim() }))
        }
    }

    /// `systemctl`'s error as a [`Fail`].
    fn classify(e: String) -> Fail {
        let lower = e.to_lowercase();
        if lower.contains("access denied") || lower.contains("interactive authentication required") || lower.contains("permission denied") {
            Fail::Denied
        } else if lower.contains("not loaded") || lower.contains("not found") {
            Fail::Gone
        } else {
            Fail::Other(e)
        }
    }

    fn read(path: &str) -> String {
        std::fs::read_to_string(path).unwrap_or_default()
    }

    fn has_word(text: &str, word: &str) -> bool {
        text.split_whitespace().any(|w| w == word)
    }
}

// ───────────────────────────── macOS, Windows, other systems ─────────────────────────────

#[cfg(not(target_os = "linux"))]
impl System for Real {
    fn observe(&self, services: &Services) -> Facts {
        other::observe(services)
    }

    fn probe(&self, _manager: Manager) -> bool {
        false
    }

    fn raise_weights(&self, _unit: &super::Unit) -> Result<Replaced, Fail> {
        Err(Fail::Other("unit weights are systemd's (Linux)".into()))
    }

    fn restore_weights(&self, _unit: &super::Unit, _replaced: &Replaced) -> Result<(), Fail> {
        Ok(())
    }

    #[cfg(unix)]
    fn renice(&self, pid: u32, _autogroup: bool) -> Result<(), Fail> {
        other::renice(pid)
    }

    #[cfg(not(unix))]
    fn renice(&self, _pid: u32, _autogroup: bool) -> Result<(), Fail> {
        Err(Fail::Other("nice values are Unix only".into()))
    }

    #[cfg(windows)]
    fn raise_class(&self, pid: u32) -> Result<(), Fail> {
        windows::raise(pid)
    }

    #[cfg(not(windows))]
    fn raise_class(&self, _pid: u32) -> Result<(), Fail> {
        Err(Fail::Other("priority classes are Windows only".into()))
    }

    fn place(&self, _manager: Manager, _unit: &str, _description: &str, _pid: u32) -> Result<(), Fail> {
        Err(Fail::Other("transient scopes are systemd's (Linux)".into()))
    }
}

#[cfg(not(target_os = "linux"))]
mod other {
    use super::*;
    use crate::priority::{Os, Proc, Target};

    /// What the SSH server and Tailscale run as here. macOS starts `sshd` (or `sshd-session`) per
    /// connection from launchd; Windows runs `sshd.exe` and `tailscaled.exe` as services.
    const SSH: &[&str] = if cfg!(windows) { &["sshd.exe", "sshd-session.exe"] } else { &["sshd", "sshd-session"] };
    const TAILSCALE: &[&str] = if cfg!(windows) { &["tailscaled.exe"] } else { &["tailscaled"] };

    pub(super) fn observe(services: &Services) -> Facts {
        let own = Proc::plain(std::process::id());
        let services = match services {
            Services::Discover => {
                use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System as Procs};
                let mut sys = Procs::new();
                sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
                let found = |names: &[&str]| -> Vec<Proc> {
                    let mut pids: Vec<u32> = sys
                        .processes()
                        .iter()
                        .filter(|(_, p)| names.iter().any(|n| p.name().to_string_lossy().eq_ignore_ascii_case(n)))
                        .map(|(pid, _)| pid.as_u32())
                        .collect();
                    pids.sort_unstable();
                    pids.into_iter().map(Proc::plain).collect()
                };
                vec![(Target::Ssh, found(SSH)), (Target::Tailscale, found(TAILSCALE))]
            }
            // Stand-ins are systemd units (Linux labs).
            Services::StandIns(_) | Services::Untouched => Vec::new(),
        };
        Facts { os: Os::current(), privileged: privileged(), own, herdr_in_own_cgroup: false, services }
    }

    #[cfg(unix)]
    fn privileged() -> bool {
        // SAFETY: geteuid has no preconditions.
        unsafe { libc::geteuid() == 0 }
    }

    #[cfg(windows)]
    fn privileged() -> bool {
        super::windows::elevated()
    }

    #[cfg(unix)]
    pub(super) fn renice(pid: u32) -> Result<(), Fail> {
        // SAFETY: plain system calls on one process id. errno is cleared first: -1 is a valid
        // nice value.
        unsafe {
            *libc::__error() = 0;
            let nice = libc::getpriority(libc::PRIO_PROCESS, pid as libc::id_t);
            if nice == -1 && *libc::__error() != 0 {
                return Err(errno_fail("getpriority"));
            }
            if nice <= crate::priority::NICE {
                return Ok(());
            }
            if libc::setpriority(libc::PRIO_PROCESS, pid as libc::id_t, crate::priority::NICE) != 0 {
                return Err(errno_fail("setpriority"));
            }
        }
        Ok(())
    }

    #[cfg(unix)]
    fn errno_fail(what: &str) -> Fail {
        let e = std::io::Error::last_os_error();
        match e.raw_os_error() {
            Some(libc::EPERM | libc::EACCES) => Fail::Denied,
            Some(libc::ESRCH) => Fail::Gone,
            _ => Fail::Other(format!("{what}: {e}")),
        }
    }
}

#[cfg(windows)]
mod windows {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, HANDLE};
    use windows_sys::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetPriorityClass, OpenProcess, OpenProcessToken, SetPriorityClass, ABOVE_NORMAL_PRIORITY_CLASS, BELOW_NORMAL_PRIORITY_CLASS,
        IDLE_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_INFORMATION,
    };

    use super::Fail;

    /// Whether a class runs below ABOVE_NORMAL (idle, below normal, normal; unknown values count
    /// as higher: never lowered).
    fn below_above_normal(class: u32) -> bool {
        class == IDLE_PRIORITY_CLASS || class == BELOW_NORMAL_PRIORITY_CLASS || class == NORMAL_PRIORITY_CLASS
    }

    /// Raises `process` (a handle with query and set rights).
    fn raise_handle(process: HANDLE) -> Result<(), Fail> {
        // SAFETY: a valid process handle.
        let class = unsafe { GetPriorityClass(process) };
        if class != 0 && !below_above_normal(class) {
            return Ok(());
        }
        // SAFETY: as above.
        if unsafe { SetPriorityClass(process, ABOVE_NORMAL_PRIORITY_CLASS) } == 0 {
            return Err(last_fail("SetPriorityClass"));
        }
        Ok(())
    }

    pub(super) fn raise_own() {
        // SAFETY: the pseudo-handle of this process always has every right.
        let _ = raise_handle(unsafe { GetCurrentProcess() });
    }

    pub(super) fn raise(pid: u32) -> Result<(), Fail> {
        if pid == std::process::id() {
            // SAFETY: as above.
            return raise_handle(unsafe { GetCurrentProcess() });
        }
        // SAFETY: OpenProcess has no memory arguments; the handle is closed below.
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_INFORMATION, 0, pid) };
        if process.is_null() {
            return Err(last_fail("OpenProcess"));
        }
        let r = raise_handle(process);
        // SAFETY: the handle is ours and closed once.
        unsafe { CloseHandle(process) };
        r
    }

    pub(super) fn elevated() -> bool {
        let mut token: HANDLE = std::ptr::null_mut();
        // SAFETY: the out-pointer is valid; the token is closed below.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut len = 0u32;
        // SAFETY: the buffer is a TOKEN_ELEVATION of the size passed.
        let ok = unsafe {
            GetTokenInformation(token, TokenElevation, (&mut elevation as *mut TOKEN_ELEVATION).cast(), std::mem::size_of::<TOKEN_ELEVATION>() as u32, &mut len)
        };
        // SAFETY: the token is ours and closed once.
        unsafe { CloseHandle(token) };
        ok != 0 && elevation.TokenIsElevated != 0
    }

    fn last_fail(what: &str) -> Fail {
        // SAFETY: no preconditions.
        match unsafe { GetLastError() } {
            ERROR_ACCESS_DENIED => Fail::Denied,
            ERROR_INVALID_PARAMETER => Fail::Gone,
            code => Fail::Other(format!("{what} failed (error {code})")),
        }
    }
}
