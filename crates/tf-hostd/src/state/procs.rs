//! Foreground process of every herdr pane (`PaneInfo.process`: `zsh`, `vim`, `bun`).
//!
//! herdr has no batch process API: `pane.process_info` answers one pane at a time. hostd asks it
//! once per pane terminal (a pane new to a snapshot, or a respawned terminal) for the shell pid and
//! the current foreground job. On Linux the name then follows the terminal's foreground process
//! group straight from `/proc` on board rebuilds (two tiny file reads per pane, at most every
//! [`READ_EVERY`]), the same lookup herdr does (`tpgid` → `comm`). Where `/proc` is unavailable
//! (Windows, or a pid namespace hostd cannot see into) the name comes from herdr and is refreshed
//! every [`REFETCH_EVERY`] at snapshot time.
//!
//! Each new job seen in front of the shell leaves its command line as the pane's last job (the
//! Cleanup page's "last command" of an idle shell); a job shorter than the reads in between goes
//! unseen.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use tf_herdr::{PaneInfo, ProcessInfo};

/// Minimum gap between two `/proc` reads for one pane.
const READ_EVERY: Duration = Duration::from_millis(250);
/// herdr re-query interval for panes whose name cannot be read locally (also retries failures).
const REFETCH_EVERY: Duration = Duration::from_secs(60);

#[derive(Debug)]
struct Entry {
    terminal_id: String,
    /// The pane's shell (its PTY child); `None` when unknown or unreadable locally.
    shell_pid: Option<u32>,
    name: Option<String>,
    /// The terminal's foreground process group as last read (the shell's own at its prompt).
    fg: Option<u32>,
    /// The command line of the newest job seen in front of the shell.
    last_job: Option<String>,
    fetched: Instant,
    read: Instant,
}

impl Entry {
    fn refetch_due(&self, now: Instant) -> bool {
        !(cfg!(target_os = "linux") && self.shell_pid.is_some()) && now.duration_since(self.fetched) >= REFETCH_EVERY
    }
}

/// Pane id → foreground process (see the module docs).
#[derive(Debug, Default)]
pub struct PaneProcs {
    by_pane: HashMap<String, Entry>,
}

impl PaneProcs {
    /// Panes to ask herdr about: unknown, on a new terminal, or due for a refetch.
    pub fn wanted(&self, panes: &[PaneInfo]) -> Vec<String> {
        let now = Instant::now();
        panes
            .iter()
            .filter(|p| self.by_pane.get(&p.pane_id).is_none_or(|e| e.terminal_id != p.terminal_id || e.refetch_due(now)))
            .map(|p| p.pane_id.clone())
            .collect()
    }

    /// Stores a `pane.process_info` answer (`None`: the request failed; retried after [`REFETCH_EVERY`]).
    pub fn record(&mut self, pane_id: &str, terminal_id: &str, info: Option<&ProcessInfo>) {
        let now = Instant::now();
        let name = info.and_then(leader_name);
        let shell_pid = info.and_then(|i| i.shell_pid);
        let fg = info.and_then(|i| i.foreground_process_group_id).and_then(|g| u32::try_from(g).ok());
        // An answer without a job (the shell at its prompt, a failed request) keeps the job this
        // terminal showed before.
        let before = self.by_pane.get(pane_id).filter(|e| e.terminal_id == terminal_id).and_then(|e| e.last_job.clone());
        let last_job = info.and_then(job_line).or(before);
        self.by_pane.insert(
            pane_id.to_string(),
            Entry { terminal_id: terminal_id.to_string(), shell_pid, name, fg, last_job, fetched: now, read: now },
        );
    }

    /// Drops panes that no longer exist.
    pub fn retain(&mut self, live: &HashSet<String>) {
        self.by_pane.retain(|k, _| live.contains(k));
    }

    /// Pane → its shell's pid, where known (`herdr_health`: background jobs of idle shells).
    pub fn shells(&self) -> HashMap<String, u32> {
        self.by_pane.iter().filter_map(|(k, e)| Some((k.clone(), e.shell_pid?))).collect()
    }

    /// Pane → the command line of the newest job seen in front of its shell.
    pub fn last_jobs(&self) -> HashMap<String, String> {
        self.by_pane.iter().filter_map(|(k, e)| Some((k.clone(), e.last_job.clone()?))).collect()
    }

    /// Re-reads the foreground process of panes not read for [`READ_EVERY`] (Linux; no-op elsewhere).
    pub fn refresh(&mut self) {
        if !cfg!(target_os = "linux") {
            return;
        }
        let now = Instant::now();
        for e in self.by_pane.values_mut() {
            let Some(pid) = e.shell_pid else { continue };
            if now.duration_since(e.read) < READ_EVERY {
                continue;
            }
            e.read = now;
            match read_foreground(pid) {
                Some(fg) => {
                    // A new job in front of the shell: remember what it runs.
                    if let Some(job) = fg.pgid.filter(|g| *g != pid && Some(*g) != e.fg)
                        && let Some(line) = read_cmdline(job)
                    {
                        e.last_job = Some(line);
                    }
                    e.fg = fg.pgid;
                    e.name = fg.name;
                }
                // Shell gone or /proc not ours: fall back to herdr (refetched after REFETCH_EVERY).
                None => e.shell_pid = None,
            }
        }
    }

    pub fn name(&self, pane_id: &str) -> Option<&str> {
        self.by_pane.get(pane_id).and_then(|e| e.name.as_deref())
    }
}

/// A job's command line as shown: arguments joined by spaces, at most [`JOB_CHARS`] characters.
const JOB_CHARS: usize = 200;

fn job_text(line: &str) -> Option<String> {
    let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty() {
        return None;
    }
    Some(match line.char_indices().nth(JOB_CHARS) {
        Some((at, _)) => format!("{}…", &line[..at]),
        None => line,
    })
}

/// herdr's foreground job when it is not the shell: the group leader's command line.
fn job_line(info: &ProcessInfo) -> Option<String> {
    let fg = info.foreground_process_group_id?;
    if info.shell_pid.is_some_and(|s| i64::from(s) == fg) {
        return None;
    }
    let p = info.foreground_processes.iter().find(|p| i64::from(p.pid) == fg).or_else(|| info.foreground_processes.first())?;
    job_text(if p.cmdline.trim().is_empty() { &p.name } else { &p.cmdline })
}

/// `/proc/<pid>/cmdline`, arguments joined by spaces.
fn read_cmdline(pid: u32) -> Option<String> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    job_text(&String::from_utf8_lossy(&raw).replace('\0', " "))
}

/// herdr's foreground job: the process group leader, else its first member.
fn leader_name(info: &ProcessInfo) -> Option<String> {
    let leader = info.foreground_process_group_id;
    info.foreground_processes
        .iter()
        .find(|p| leader == Some(i64::from(p.pid)))
        .or_else(|| info.foreground_processes.first())
        .map(|p| p.name.clone())
        .filter(|n| !n.is_empty())
}

/// The terminal's foreground process group and its leader's name, from `/proc`.
struct Foreground {
    pgid: Option<u32>,
    /// `None` while the leader just exited.
    name: Option<String>,
}

/// `/proc/<shell>/stat`'s `tpgid` and that leader's `comm`; `None` when the shell is unreadable.
fn read_foreground(shell_pid: u32) -> Option<Foreground> {
    let stat = std::fs::read_to_string(format!("/proc/{shell_pid}/stat")).ok()?;
    let Some(tpgid) = stat_tpgid(&stat) else { return Some(Foreground { pgid: None, name: None }) };
    let comm = std::fs::read_to_string(format!("/proc/{tpgid}/comm")).ok();
    Some(Foreground { pgid: Some(tpgid), name: comm.map(|c| c.trim_end().to_string()).filter(|c| !c.is_empty()) })
}

/// The fields of a `/proc/<pid>/stat` line hostd reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stat {
    pub comm: String,
    /// `R`, `S`, `Z`, …
    pub state: char,
    /// Controlling terminal (`dev_t` as the kernel encodes it; 0: none).
    pub tty_nr: u32,
    /// The controlling terminal's foreground process group (`None`: no terminal).
    pub tpgid: Option<u32>,
}

impl Stat {
    /// It exited (a zombie its parent has not reaped yet, or on its way out): nothing runs.
    pub fn exited(&self) -> bool {
        matches!(self.state, 'Z' | 'X' | 'x')
    }
}

/// Parses a `/proc/<pid>/stat` line (`pid (comm) state ppid pgrp session tty_nr tpgid …`; `comm`
/// may contain spaces and parens).
pub fn parse_stat(stat: &str) -> Option<Stat> {
    let open = stat.find('(')?;
    let close = stat.rfind(')')?;
    let comm = stat.get(open + 1..close)?.to_string();
    let mut f = stat.get(close + 2..)?.split_whitespace();
    let state = f.next()?.chars().next()?;
    let tty_nr: i64 = f.nth(3)?.parse().ok()?;
    let tpgid: i64 = f.next()?.parse().ok()?;
    Some(Stat { comm, state, tty_nr: u32::try_from(tty_nr).unwrap_or(0), tpgid: u32::try_from(tpgid).ok().filter(|g| *g > 0) })
}

/// The terminal's foreground process group from a `/proc/<pid>/stat` line.
fn stat_tpgid(stat: &str) -> Option<u32> {
    parse_stat(stat)?.tpgid
}

#[cfg(test)]
mod tests {
    use super::*;
    use tf_herdr::ProcessEntry;

    fn pane(id: &str, term: &str) -> PaneInfo {
        PaneInfo { pane_id: id.into(), terminal_id: term.into(), ..Default::default() }
    }

    fn proc_entry(pid: u32, name: &str) -> ProcessEntry {
        ProcessEntry { pid, name: name.into(), ..Default::default() }
    }

    #[test]
    fn tpgid_survives_odd_comm() {
        assert_eq!(stat_tpgid("4242 (zsh) S 1 4242 4242 34817 5151 4194560 0"), Some(5151));
        assert_eq!(stat_tpgid("77 (we ird) (x) S 1 77 77 0 -1 4194560"), None);
        assert_eq!(stat_tpgid("77 (a) b) R 1 77 77 34817 77 0"), Some(77));
        assert_eq!(stat_tpgid("garbage"), None);
        let s = parse_stat("4242 (we ird) zsh) S 1 4242 4242 34817 5151 4194560 0").unwrap();
        assert_eq!(s, Stat { comm: "we ird) zsh".into(), state: 'S', tty_nr: 34817, tpgid: Some(5151) });
        assert!(!s.exited() && parse_stat("9 (sleep) Z 4242 9 4242 34817 -1 0").unwrap().exited());
        assert_eq!(parse_stat("9 (daemon) S 1 9 9 0 -1 0").unwrap().tty_nr, 0);
    }

    #[test]
    fn remembers_the_last_job_of_a_terminal() {
        let mut procs = PaneProcs::default();
        let shell = ProcessEntry { pid: 10, name: "bash".into(), cmdline: "-bash".into(), ..Default::default() };
        let job = ProcessEntry { pid: 21, name: "cargo".into(), cmdline: "cargo  test -p\ttf-hostd".into(), ..Default::default() };
        let running = ProcessInfo { shell_pid: Some(10), foreground_process_group_id: Some(21), foreground_processes: vec![job], ..Default::default() };
        let prompt = ProcessInfo { shell_pid: Some(10), foreground_process_group_id: Some(10), foreground_processes: vec![shell], ..Default::default() };
        procs.record("w1:p1", "t1", Some(&prompt));
        assert!(procs.last_jobs().is_empty());
        procs.record("w1:p1", "t1", Some(&running));
        assert_eq!(procs.last_jobs()["w1:p1"], "cargo test -p tf-hostd");
        // Back at the prompt, or a failed request: the job stays.
        procs.record("w1:p1", "t1", Some(&prompt));
        procs.record("w1:p1", "t1", None);
        assert_eq!(procs.last_jobs()["w1:p1"], "cargo test -p tf-hostd");
        // A new terminal in the pane starts without one.
        procs.record("w1:p1", "t2", Some(&prompt));
        assert!(procs.last_jobs().is_empty());
        assert_eq!(job_text(&"x".repeat(250)).unwrap().chars().count(), JOB_CHARS + 1);
    }

    #[test]
    fn leader_wins_over_other_members() {
        let info = ProcessInfo {
            pane_id: "w1:p1".into(),
            shell_pid: Some(10),
            foreground_process_group_id: Some(21),
            foreground_processes: vec![proc_entry(20, "cat"), proc_entry(21, "bun")],
        };
        assert_eq!(leader_name(&info).as_deref(), Some("bun"));
        let none = ProcessInfo { foreground_process_group_id: Some(99), ..info.clone() };
        assert_eq!(leader_name(&none).as_deref(), Some("cat"));
        assert_eq!(leader_name(&ProcessInfo::default()), None);
    }

    #[test]
    fn fetches_each_terminal_once() {
        let mut procs = PaneProcs::default();
        let panes = vec![pane("w1:p1", "t1"), pane("w1:p2", "t2")];
        assert_eq!(procs.wanted(&panes), ["w1:p1", "w1:p2"]);
        let info = ProcessInfo { shell_pid: Some(std::process::id()), foreground_processes: vec![proc_entry(1, "vim")], ..Default::default() };
        procs.record("w1:p1", "t1", Some(&info));
        procs.record("w1:p2", "t2", None);
        assert_eq!(procs.name("w1:p1"), Some("vim"));
        // A failed request waits for the refetch interval; a known shell is not asked again.
        assert!(procs.wanted(&panes).is_empty());
        // A respawned terminal in the same pane is new.
        assert_eq!(procs.wanted(&[pane("w1:p1", "t9")]), ["w1:p1"]);
        procs.retain(&HashSet::from(["w1:p2".to_string()]));
        assert_eq!(procs.name("w1:p1"), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reads_own_process_from_proc() {
        // The test process has a readable stat; without a controlling terminal there is no tpgid.
        let own = read_foreground(std::process::id());
        assert!(own.is_some());
        assert!(read_foreground(u32::MAX).is_none());
        assert!(read_cmdline(std::process::id()).is_some_and(|l| !l.is_empty()));
    }
}
