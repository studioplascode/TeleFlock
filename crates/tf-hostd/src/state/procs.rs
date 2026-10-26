//! Foreground process of every herdr pane (`PaneInfo.process`: `zsh`, `vim`, `bun`).
//!
//! herdr has no batch process API: `pane.process_info` answers one pane at a time. hostd asks it
//! once per pane terminal (a pane new to a snapshot, or a respawned terminal) for the shell pid and
//! the current foreground job. On Linux the name then follows the terminal's foreground process
//! group straight from `/proc` on board rebuilds (two tiny file reads per pane, at most every
//! [`READ_EVERY`]), the same lookup herdr does (`tpgid` → `comm`). Where `/proc` is unavailable
//! (Windows, or a pid namespace hostd cannot see into) the name comes from herdr and is refreshed
//! every [`REFETCH_EVERY`] at snapshot time.

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
        self.by_pane.insert(
            pane_id.to_string(),
            Entry { terminal_id: terminal_id.to_string(), shell_pid, name, fetched: now, read: now },
        );
    }

    /// Drops panes that no longer exist.
    pub fn retain(&mut self, live: &HashSet<String>) {
        self.by_pane.retain(|k, _| live.contains(k));
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
                Some(name) => e.name = name,
                // Shell gone or /proc not ours: fall back to herdr (refetched after REFETCH_EVERY).
                None => e.shell_pid = None,
            }
        }
    }

    pub fn name(&self, pane_id: &str) -> Option<&str> {
        self.by_pane.get(pane_id).and_then(|e| e.name.as_deref())
    }
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

/// `Some(name)` from `/proc/<shell>/stat`'s `tpgid` and that leader's `comm` (`Some(None)`: the
/// shell is readable but its foreground leader just exited); `None` when the shell is unreadable.
fn read_foreground(shell_pid: u32) -> Option<Option<String>> {
    let stat = std::fs::read_to_string(format!("/proc/{shell_pid}/stat")).ok()?;
    let Some(tpgid) = stat_tpgid(&stat) else { return Some(None) };
    let comm = std::fs::read_to_string(format!("/proc/{tpgid}/comm")).ok();
    Some(comm.map(|c| c.trim_end().to_string()).filter(|c| !c.is_empty()))
}

/// The terminal's foreground process group from a `/proc/<pid>/stat` line
/// (`pid (comm) state ppid pgrp session tty_nr tpgid …`; `comm` may contain spaces and parens).
fn stat_tpgid(stat: &str) -> Option<u32> {
    let rest = stat.get(stat.rfind(')')? + 2..)?;
    let tpgid: i64 = rest.split_whitespace().nth(5)?.parse().ok()?;
    (tpgid > 0).then_some(tpgid as u32)
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
        assert_eq!(read_foreground(u32::MAX), None);
    }
}
