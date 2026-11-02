//! What the host says about a pane's shell (`rules::Probe`; architecture §3.17 "Idle shells").
//!
//! Linux reads `/proc`: the pane's own process (`stat`: its name, controlling terminal and that
//! terminal's foreground process group), its children, every other process on its terminal, and
//! the terminal's times. The kernel stamps a terminal's access time when a process reads input
//! from it and its modification time when one writes output to it (in 8-second steps, and never
//! for herdr's own reads of the screen), so the last input or output is known even for a
//! terminal hostd never watched, also right after hostd started. Elsewhere, and for a shell
//! hostd cannot read, herdr's `pane.process_info` says what holds the foreground, `ps` lists the
//! shell's children and every other process on its terminal (not on Windows: jobs stay unknown
//! there, so nothing counts as idle), and the janitor watches the screen instead of the
//! terminal's times.

use std::collections::HashMap;

use tf_herdr::ProcessInfo;

use super::rules::Probe;

/// Process names that live as long as the shell and run nothing of the user's (powerlevel10k's
/// gitstatusd, as in `herdr_health::idle`).
fn helper(comm: &str) -> bool {
    comm.trim().rsplit('/').next().unwrap_or_default().starts_with("gitstatusd")
}

/// The host's processes as one check needs them, read once per check.
#[derive(Debug, Default)]
pub struct System {
    /// Linux: controlling terminal (`tty_nr`) → the processes on it (pid, name).
    by_tty: Option<HashMap<u32, Vec<(u32, String)>>>,
    /// Other Unix: every process, from `ps`.
    ps: Option<Vec<PsRow>>,
}

/// One process as `ps -A -o pid=,ppid=,tty=,comm=` lists it.
#[derive(Debug)]
struct PsRow {
    pid: u32,
    ppid: u32,
    /// Its controlling terminal (`ttys003`); `None` without one (`??`, `-`).
    tty: Option<String>,
    comm: String,
}

impl System {
    pub async fn scan() -> System {
        #[cfg(target_os = "linux")]
        {
            let by_tty = tokio::task::spawn_blocking(terminals).await.ok().flatten();
            System { by_tty, ps: None }
        }
        #[cfg(all(unix, not(target_os = "linux")))]
        {
            System { by_tty: None, ps: ps_rows().await }
        }
        #[cfg(windows)]
        {
            System::default()
        }
    }

    /// Everything from `/proc` (Linux); `None` when the shell's process can't be read.
    #[cfg(target_os = "linux")]
    pub fn linux(&self, shell_pid: u32) -> Option<Probe> {
        let stat = crate::state::procs::parse_stat(&std::fs::read_to_string(format!("/proc/{shell_pid}/stat")).ok()?)?;
        let kids = crate::herdr_health::idle::background_jobs(shell_pid);
        let others = self.by_tty.as_ref().map(|m| {
            stat.tty_nr != 0 && m.get(&stat.tty_nr).is_some_and(|ps| ps.iter().any(|(pid, comm)| *pid != shell_pid && !helper(comm)))
        });
        Some(Probe {
            shell: Some(stat.comm),
            at_prompt: stat.tpgid.map(|g| g == shell_pid),
            jobs: either(kids, others),
            quiet_since: terminal_quiet_since(shell_pid, stat.tty_nr),
        })
    }

    #[cfg(not(target_os = "linux"))]
    pub fn linux(&self, _shell_pid: u32) -> Option<Probe> {
        None
    }

    /// From herdr's `pane.process_info` (no terminal times: the janitor watches the screen).
    pub fn from_info(&self, info: &ProcessInfo) -> Probe {
        let Some(shell_pid) = info.shell_pid else { return Probe::default() };
        Probe {
            // herdr lists the foreground group's processes: the shell is among them at its prompt.
            shell: info.foreground_processes.iter().find(|p| p.pid == shell_pid).map(|p| p.name.clone()).filter(|n| !n.is_empty()),
            at_prompt: info.foreground_process_group_id.map(|g| g == i64::from(shell_pid)),
            jobs: self.ps.as_deref().and_then(|rows| ps_jobs(rows, shell_pid)),
            quiet_since: None,
        }
    }
}

/// `Some(true)` when either says yes, `Some(false)` when both say no, else unknown.
fn either(a: Option<bool>, b: Option<bool>) -> Option<bool> {
    match (a, b) {
        (Some(true), _) | (_, Some(true)) => Some(true),
        (Some(false), Some(false)) => Some(false),
        _ => None,
    }
}

/// From `ps`, as Linux reads it from `/proc`: the shell `shell_pid` has a child, or another
/// process is on its terminal (gitstatusd excepted, both). A server started as `(npm run dev &)`
/// leaves the shell (launchd adopts it) but keeps writing to the terminal. Without the shell's own
/// row or terminal only a child can tell.
fn ps_jobs(rows: &[PsRow], shell_pid: u32) -> Option<bool> {
    let kids = rows.iter().any(|r| r.ppid == shell_pid && !helper(&r.comm));
    let tty = rows.iter().find(|r| r.pid == shell_pid).and_then(|r| r.tty.as_deref());
    let others = tty.map(|t| rows.iter().any(|r| r.pid != shell_pid && r.tty.as_deref() == Some(t) && !helper(&r.comm)));
    either(Some(kids), others)
}

/// Every running process with a controlling terminal, by terminal (one pass over `/proc`).
#[cfg(target_os = "linux")]
fn terminals() -> Option<HashMap<u32, Vec<(u32, String)>>> {
    let mut out: HashMap<u32, Vec<(u32, String)>> = HashMap::new();
    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
        let Some(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok().and_then(|s| crate::state::procs::parse_stat(&s)) else { continue };
        if stat.tty_nr != 0 && !stat.exited() {
            out.entry(stat.tty_nr).or_default().push((pid, stat.comm));
        }
    }
    Some(out)
}

/// `(major, minor)` of a `tty_nr` from `/proc/<pid>/stat` (the kernel's `new_encode_dev`).
fn tty_nr_parts(tty_nr: u32) -> (u64, u64) {
    let n = u64::from(tty_nr);
    ((n >> 8) & 0xfff, (n & 0xff) | ((n >> 12) & 0xfff00))
}

/// `(major, minor)` of a `st_rdev` (glibc's `dev_t` layout).
fn rdev_parts(dev: u64) -> (u64, u64) {
    (((dev >> 32) & 0xffff_f000) | ((dev >> 8) & 0xfff), ((dev >> 12) & 0xffff_ff00) | (dev & 0xff))
}

/// The newest of the terminal's access and modification times, read through whichever of the
/// shell's stdin, stdout or stderr is its controlling terminal.
#[cfg(target_os = "linux")]
fn terminal_quiet_since(shell_pid: u32, tty_nr: u32) -> Option<tf_proto::Millis> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    if tty_nr == 0 {
        return None;
    }
    let want = tty_nr_parts(tty_nr);
    (0..=2).find_map(|fd| {
        let m = std::fs::metadata(format!("/proc/{shell_pid}/fd/{fd}")).ok()?;
        (m.file_type().is_char_device() && rdev_parts(m.rdev()) == want).then(|| m.atime().max(m.mtime()) * 1000)
    })
}

/// Every process from `ps` (Unix without `/proc`).
#[cfg(all(unix, not(target_os = "linux")))]
async fn ps_rows() -> Option<Vec<PsRow>> {
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::process::Command::new("ps").args(["-A", "-o", "pid=,ppid=,tty=,comm="]).kill_on_drop(true).output(),
    )
    .await
    .ok()?
    .ok()?;
    out.status.success().then(|| parse_ps(&String::from_utf8_lossy(&out.stdout)))
}

/// `ps -A -o pid=,ppid=,tty=,comm=` lines (`comm` last: a path may hold spaces).
#[cfg_attr(not(any(test, all(unix, not(target_os = "linux")))), allow(dead_code))]
fn parse_ps(text: &str) -> Vec<PsRow> {
    text.lines()
        .filter_map(|line| {
            let mut f = line.split_whitespace();
            let pid = f.next()?.parse().ok()?;
            let ppid = f.next()?.parse().ok()?;
            // `??` (macOS), `-` or `?`: no controlling terminal.
            let tty = f.next().filter(|t| t.chars().any(|c| c.is_ascii_alphanumeric())).map(str::to_string);
            Some(PsRow { pid, ppid, tty, comm: f.collect::<Vec<_>>().join(" ") })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tf_herdr::ProcessEntry;

    /// zsh (pid 10) at its prompt, as herdr's `pane.process_info` says it.
    fn at_prompt() -> ProcessInfo {
        let shell = ProcessEntry { pid: 10, name: "zsh".into(), ..Default::default() };
        ProcessInfo { shell_pid: Some(10), foreground_process_group_id: Some(10), foreground_processes: vec![shell], ..Default::default() }
    }

    fn ps(text: &str) -> System {
        System { by_tty: None, ps: Some(parse_ps(text)) }
    }

    #[test]
    fn herdr_says_what_holds_the_foreground() {
        let prompt = at_prompt();
        let sys = ps("   10     1 ttys003  /bin/zsh\n   11    10 ttys003  /opt/gitstatusd-darwin\n   12     1 ??       /usr/sbin/sshd\n");
        assert_eq!(sys.from_info(&prompt), Probe { shell: Some("zsh".into()), at_prompt: Some(true), jobs: Some(false), quiet_since: None });
        let job = ProcessInfo { foreground_process_group_id: Some(20), foreground_processes: vec![ProcessEntry { pid: 20, name: "sleep".into(), ..Default::default() }], ..prompt.clone() };
        assert_eq!(sys.from_info(&job).at_prompt, Some(false));
        // `sleep 1000 &`: a child of the shell.
        assert_eq!(ps("10 1 ttys003 zsh\n30 10 ttys003 sleep\n").from_info(&prompt).jobs, Some(true));
        // Processes unknown (Windows): jobs unknown.
        assert_eq!(System::default().from_info(&prompt).jobs, None);
        assert_eq!(sys.from_info(&ProcessInfo::default()), Probe::default());
    }

    /// `(npm run dev &)` on macOS: the server leaves the shell (launchd adopts it) but keeps writing
    /// to its terminal; closing the pane takes that terminal away (EIO ends a Node server).
    #[test]
    fn ps_sees_other_processes_on_the_shells_terminal() {
        let jobs = |text: &str| ps(text).from_info(&at_prompt()).jobs;
        assert_eq!(jobs("10 1 ttys003 -zsh\n40 1 ttys003 node\n"), Some(true));
        // Other terminals' processes, processes without one and prompt helpers are not its jobs.
        assert_eq!(jobs("10 1 ttys003 -zsh\n41 1 ttys004 node\n42 1 ?? /sbin/launchd\n43 1 - cron\n44 1 ttys003 gitstatusd-darwin-arm64\n"), Some(false));
        // The shell's own terminal unknown (none, or gone from the list): unknown, unless a child shows.
        assert_eq!(jobs("10 1 ?? zsh\n"), None);
        assert_eq!(jobs("11 1 ttys003 zsh\n"), None);
        assert_eq!(jobs("10 1 ?? zsh\n30 10 ?? sleep\n"), Some(true));
    }

    #[test]
    fn device_numbers_match_across_encodings() {
        // /dev/pts/9 (136:9) and a pts above 255 (136:300; minor bits split in both encodings).
        assert_eq!(tty_nr_parts(34825), (136, 9));
        assert_eq!(rdev_parts(34825), (136, 9));
        let tty_nr = (136 << 8) | (300 & 0xff) | ((300 & !0xff) << 12);
        let rdev: u64 = ((136 & 0xfff) << 8) | (300 & 0xff) | ((300 & !0xff) << 12);
        assert_eq!(tty_nr_parts(tty_nr), (136, 300));
        assert_eq!(rdev_parts(rdev), (136, 300));
    }

    /// A shell on a real pseudo-terminal: at its prompt, then with `sleep` in front, then with
    /// `sleep &` behind, then with that job killed (dash reaps it only at its next prompt: the
    /// zombie runs nothing); the terminal's times follow its output.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_real_shell_on_a_terminal() {
        use std::io::Write;
        use std::os::fd::FromRawFd;
        use std::time::{Duration, Instant};

        let (mut master, child) = spawn_shell();
        let wait_for = |what: &dyn Fn(&Probe) -> bool| {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let sys = System { by_tty: terminals(), ps: None };
                if let Some(p) = sys.linux(child)
                    && what(&p)
                {
                    return p;
                }
                assert!(Instant::now() < deadline, "shell never got there: {:?}", sys.linux(child));
                std::thread::sleep(Duration::from_millis(50));
            }
        };
        let prompt = wait_for(&|p| p.at_prompt == Some(true));
        assert_eq!(prompt.shell.as_deref(), Some("sh"));
        assert_eq!(prompt.jobs, Some(false));
        assert!(prompt.quiet_since.is_some_and(|t| (crate::util::now_ms() - t).abs() < 60_000), "{prompt:?}");
        master.write_all(b"sleep 30\n").unwrap();
        let busy = wait_for(&|p| p.at_prompt == Some(false));
        assert_eq!(busy.jobs, Some(true));
        master.write_all(b"\x03").unwrap();
        wait_for(&|p| p.at_prompt == Some(true) && p.jobs == Some(false));
        master.write_all(b"sleep 30 &\n").unwrap();
        let bg = wait_for(&|p| p.jobs == Some(true));
        assert_eq!(bg.at_prompt, Some(true));
        master.write_all(b"kill $!\n").unwrap();
        wait_for(&|p| p.at_prompt == Some(true) && p.jobs == Some(false));
        unsafe {
            libc::kill(child as i32, libc::SIGKILL);
            libc::waitpid(child as i32, std::ptr::null_mut(), 0);
        }

        /// `sh -i` as a session leader on a new pseudo-terminal, like a herdr pane's shell.
        fn spawn_shell() -> (std::fs::File, u32) {
            unsafe {
                let mut m = 0;
                let mut s = 0;
                assert_eq!(libc::openpty(&mut m, &mut s, std::ptr::null_mut(), std::ptr::null(), std::ptr::null()), 0);
                let pid = libc::fork();
                assert!(pid >= 0);
                if pid == 0 {
                    libc::setsid();
                    libc::ioctl(s, libc::TIOCSCTTY, 0);
                    for fd in 0..=2 {
                        libc::dup2(s, fd);
                    }
                    libc::close(m);
                    libc::close(s);
                    let sh = c"/bin/sh";
                    let args = [sh.as_ptr(), c"-i".as_ptr(), std::ptr::null()];
                    libc::execv(sh.as_ptr(), args.as_ptr());
                    libc::_exit(127);
                }
                libc::close(s);
                (std::fs::File::from_raw_fd(m), pid as u32)
            }
        }
    }
}
