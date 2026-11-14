//! Each agent's share of the host (`HostHealth.agents`, hosts ≥ 0.9.5): CPU and memory of the
//! agent's process tree, sampled with the host's health every few seconds.
//!
//! **Which processes.** An agent's tree starts at its omp process (`OmpInfo.pid`) when that runs
//! in the agent's pane, else at the pane's shell (herdr's `pane.process_info`, kept in
//! [`super::procs`]): agents other than omp, and omp before its pid is known. omp starts what its
//! tools run (tests, builds, servers, browsers) as its own children, each in a session of its own
//! without the pane's terminal, so parent links find them where the terminal would not, and they
//! never reach into another pane. A process counts for the nearest root above it; one that
//! detaches (a daemon reparented to init) leaves its agent.
//!
//! **CPU** is CPU time over the interval since the previous sample, on the host's scale
//! (`HostHealth.cpuPct`: all cores together), from per-process deltas keyed by (pid, start time),
//! so a reused pid is a new process. A process born since the previous sample counts all its time
//! (its whole life lies in the interval); one that ran before but is missing from the previous
//! sample only sets a baseline, as does every process after a gap of more than [`MAX_GAP`] (no
//! client was connected). On Linux the time of exited children that their parent reaped
//! (`cutime`/`cstime`) counts too, minus what earlier samples saw of those children: commands
//! shorter than the interval (compiler jobs, a loop of `grep`s) are not lost, and a long-lived
//! process that exits adds no spike.
//!
//! **Memory** is resident memory summed over the tree (pages shared between its processes count
//! once per process, as `top` adds them up).
//!
//! **Cost.** Linux reads `/proc/stat` and one `/proc/<pid>/stat` per process (open, one read,
//! close), nothing else per process: in a debug build `scan_cost` below measured under 35 µs of
//! CPU per process for a whole sample (76 ms for 2,759 processes, 9 ms for 260; tf-hostd ships as a
//! release build), and the pure part 58 ms for a synthetic 20,000 processes.
//! macOS and Windows refresh `sysinfo`'s process list with CPU time and memory only.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use tf_proto::model::AgentLoad;

/// After a longer gap between two samples the newer one is only a baseline (CPU 0).
const MAX_GAP: Duration = Duration::from_secs(30);
/// Ancestor walks give up after this many steps (a corrupt or cyclic table).
const MAX_DEPTH: usize = 512;

/// The processes an agent's tree can start at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Root {
    pub agent_id: String,
    /// Its omp process (`OmpInfo.pid`).
    pub omp: Option<u32>,
    /// Its pane's shell.
    pub shell: Option<u32>,
}

/// One process as read.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Proc {
    pid: u32,
    ppid: u32,
    /// Start time on [`Table::born_at`]'s clock: with the pid it tells a reused pid apart.
    start: u64,
    /// CPU time it used so far, in [`Table::cpu_at`]'s unit.
    cpu: u64,
    /// CPU time of the exited children it reaped (Linux `cutime + cstime`; 0 elsewhere).
    reaped: u64,
    /// Resident memory, bytes.
    rss: u64,
    /// Exited, not reaped yet: it runs nothing, and its parent has not collected its time.
    zombie: bool,
}

/// Every process on the host at one moment.
#[derive(Debug, Default)]
struct Table {
    procs: Vec<Proc>,
    /// Now, on the processes' start-time clock.
    born_at: u64,
    /// The host's CPU capacity used up so far (busy or idle, all cores together), in the
    /// processes' CPU-time unit.
    cpu_at: u64,
}

/// What a sample saw of one process.
#[derive(Debug, Clone, Copy)]
struct Seen {
    start: u64,
    ppid: u32,
    cpu: u64,
    reaped: u64,
}

#[derive(Debug)]
struct Prev {
    at: Instant,
    born_at: u64,
    cpu_at: u64,
    procs: HashMap<u32, Seen>,
}

/// Agent loads between consecutive samples. One per state store: each board measures between
/// its own health ticks.
#[derive(Default)]
pub struct Sampler {
    prev: Option<Prev>,
    reader: platform::Reader,
}

impl Sampler {
    /// Reads the process table and returns the load of every agent whose root process runs,
    /// busiest first, CPU measured since the previous call.
    pub fn sample(&mut self, roots: &[Root]) -> Vec<AgentLoad> {
        match self.reader.read() {
            Some(table) => self.next(table, roots, Instant::now()),
            None => Vec::new(),
        }
    }

    fn next(&mut self, table: Table, roots: &[Root], now: Instant) -> Vec<AgentLoad> {
        let prev = self.prev.take();
        let out = loads(&table, prev.as_ref().filter(|p| now.saturating_duration_since(p.at) <= MAX_GAP), roots);
        let mut procs = prev.map(|p| p.procs).unwrap_or_default();
        procs.clear();
        procs.extend(table.procs.iter().map(|p| (p.pid, Seen { start: p.start, ppid: p.ppid, cpu: p.cpu, reaped: p.reaped })));
        self.prev = Some(Prev { at: now, born_at: table.born_at, cpu_at: table.cpu_at, procs });
        out
    }
}

/// Each running agent's load in `t`, CPU measured against `prev` (none: a baseline, CPU 0).
fn loads(t: &Table, prev: Option<&Prev>, roots: &[Root]) -> Vec<AgentLoad> {
    let index: HashMap<u32, usize> = t.procs.iter().enumerate().map(|(i, p)| (p.pid, i)).collect();
    let tree = Tree { t, index: &index };
    // Process → the root (index into `roots`) it is; the first agent to claim a process keeps it.
    let mut root_of: HashMap<usize, usize> = HashMap::new();
    for (r, root) in roots.iter().enumerate() {
        if let Some(i) = tree.root(root) {
            root_of.entry(i).or_insert(r);
        }
    }
    if root_of.is_empty() {
        return Vec::new();
    }
    let owner = tree.owners(&root_of);
    let used = prev.map(|p| interval_cpu(t, &index, p));
    let span = prev.map_or(0, |p| t.cpu_at.saturating_sub(p.cpu_at));
    // (cpu, mem, procs) per root.
    let mut sums = vec![(0u64, 0u64, 0u32); roots.len()];
    for (i, p) in t.procs.iter().enumerate() {
        let Some(r) = owner[i] else { continue };
        let s = &mut sums[r];
        // A zombie's last moments still ran in the interval; it is no longer a process.
        s.0 += used.as_ref().map_or(0, |u| u[i]);
        s.1 += p.rss;
        s.2 += u32::from(!p.zombie);
    }
    let mut out: Vec<AgentLoad> = root_of
        .values()
        .map(|&r| {
            let (cpu, mem, procs) = sums[r];
            AgentLoad { agent_id: roots[r].agent_id.clone(), cpu_pct: share(cpu, span), mem, procs }
        })
        .collect();
    out.sort_by(|a, b| b.cpu_pct.total_cmp(&a.cpu_pct).then(b.mem.cmp(&a.mem)).then_with(|| a.agent_id.cmp(&b.agent_id)));
    out
}

/// `used` of `span` in percent (0 without a span).
fn share(used: u64, span: u64) -> f32 {
    if span == 0 {
        return 0.0;
    }
    (used as f64 / span as f64 * 100.0).clamp(0.0, 100.0) as f32
}

/// CPU each process of `t` used since `prev` (see the module docs).
fn interval_cpu(t: &Table, index: &HashMap<u32, usize>, prev: &Prev) -> Vec<u64> {
    let alive = |pid: u32, start: u64| index.get(&pid).is_some_and(|&i| t.procs[i].start == start);
    // What earlier samples saw of the processes that exited since, by the process that reaped
    // them: their parent when it still runs, else (orphaned) the nearest ancestor that does.
    let mut seen_reaped: HashMap<u32, u64> = HashMap::new();
    for (&pid, s) in &prev.procs {
        if alive(pid, s.start) {
            continue;
        }
        let mut up = s.ppid;
        for _ in 0..MAX_DEPTH {
            let Some(a) = prev.procs.get(&up) else { break };
            if alive(up, a.start) {
                *seen_reaped.entry(up).or_default() += s.cpu + s.reaped;
                break;
            }
            up = a.ppid;
        }
    }
    t.procs
        .iter()
        .map(|p| match prev.procs.get(&p.pid) {
            Some(s) if s.start == p.start => {
                let reaped = p.reaped.saturating_sub(s.reaped).saturating_sub(seen_reaped.get(&p.pid).copied().unwrap_or(0));
                p.cpu.saturating_sub(s.cpu) + reaped
            }
            // Born since the previous sample: its whole life lies in the interval.
            _ if p.start >= prev.born_at => p.cpu + p.reaped,
            // It ran before but the previous sample missed it: a baseline.
            _ => 0,
        })
        .collect()
}

struct Tree<'a> {
    t: &'a Table,
    index: &'a HashMap<u32, usize>,
}

impl Tree<'_> {
    /// `i`'s parent. One younger than its child is a stale link, not a parent: Windows keeps a dead
    /// parent's pid, which a newer process may have reused.
    fn parent(&self, i: usize) -> Option<usize> {
        let p = &self.t.procs[i];
        let j = *self.index.get(&p.ppid)?;
        (j != i && self.t.procs[j].start <= p.start).then_some(j)
    }

    fn live(&self, pid: Option<u32>) -> Option<usize> {
        pid.and_then(|p| self.index.get(&p).copied()).filter(|&i| !self.t.procs[i].zombie)
    }

    /// The process an agent's tree starts at: its omp process when that runs in its pane (or the
    /// pane's shell is unknown), else the pane's shell. An omp pid outside the pane (stale, or
    /// reused by another process) does not count.
    fn root(&self, r: &Root) -> Option<usize> {
        let shell = self.live(r.shell);
        match (self.live(r.omp), shell) {
            (Some(omp), Some(shell)) if self.descends(omp, shell) => Some(omp),
            (Some(omp), None) => Some(omp),
            _ => shell,
        }
    }

    fn descends(&self, mut i: usize, ancestor: usize) -> bool {
        for _ in 0..MAX_DEPTH {
            if i == ancestor {
                return true;
            }
            match self.parent(i) {
                Some(p) => i = p,
                None => return false,
            }
        }
        false
    }

    /// Every process's owner: the root nearest above it (itself included), as an index into the
    /// roots. Each process is walked once: a walk stops at the first process already settled.
    fn owners(&self, root_of: &HashMap<usize, usize>) -> Vec<Option<usize>> {
        let n = self.t.procs.len();
        // `None`: not settled yet.
        let mut owner: Vec<Option<Option<usize>>> = vec![None; n];
        let mut path = Vec::new();
        for i in 0..n {
            if owner[i].is_some() {
                continue;
            }
            path.clear();
            let mut cur = Some(i);
            let found = loop {
                let Some(c) = cur else { break None };
                if let Some(known) = owner[c] {
                    break known;
                }
                if let Some(&r) = root_of.get(&c) {
                    owner[c] = Some(Some(r));
                    break Some(r);
                }
                if path.len() >= MAX_DEPTH {
                    break None;
                }
                path.push(c);
                cur = self.parent(c);
            };
            for &c in &path {
                owner[c] = Some(found);
            }
        }
        owner.into_iter().map(Option::flatten).collect()
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::io::Read;

    use super::{Proc, Table};

    /// `/proc`: start times and CPU times in clock ticks, the host's capacity from `/proc/stat`.
    pub(super) struct Reader {
        /// One `stat` line, or as much of it as fits: the fields read come in its first few hundred bytes.
        buf: Box<[u8; 1024]>,
        path: String,
        page: u64,
        hz: u64,
    }

    impl Default for Reader {
        fn default() -> Self {
            // SAFETY: sysconf has no preconditions.
            let (page, hz) = unsafe { (libc::sysconf(libc::_SC_PAGESIZE), libc::sysconf(libc::_SC_CLK_TCK)) };
            Self {
                buf: Box::new([0; 1024]),
                path: String::with_capacity(24),
                page: u64::try_from(page).ok().filter(|p| *p > 0).unwrap_or(4096),
                hz: u64::try_from(hz).ok().filter(|h| *h > 0).unwrap_or(100),
            }
        }
    }

    impl Reader {
        pub(super) fn read(&mut self) -> Option<Table> {
            let born_at = self.boot_ticks()?;
            let cpu_at = total_ticks(&std::fs::read_to_string("/proc/stat").ok()?)?;
            let mut procs = Vec::with_capacity(1024);
            for entry in std::fs::read_dir("/proc").ok()?.flatten() {
                let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
                // A process that exited since the listing is skipped.
                if let Some(n) = self.read_stat(pid)
                    && let Some(p) = parse_stat(pid, &self.buf[..n], self.page)
                {
                    procs.push(p);
                }
            }
            Some(Table { procs, born_at, cpu_at })
        }

        /// `/proc/<pid>/stat` into `buf` with a single `read` (the kernel renders the line at once):
        /// open, read, close per process and nothing else. Its length.
        fn read_stat(&mut self, pid: u32) -> Option<usize> {
            use std::fmt::Write;
            self.path.clear();
            let _ = write!(self.path, "/proc/{pid}/stat");
            std::fs::File::open(&self.path).and_then(|mut f| f.read(&mut self.buf[..])).ok().filter(|n| *n > 0)
        }

        /// Time since boot in clock ticks: the clock of `/proc/<pid>/stat`'s start times.
        fn boot_ticks(&self) -> Option<u64> {
            // SAFETY: an all-zero timespec is valid, and `ts` is a properly sized out-param.
            let mut ts: libc::timespec = unsafe { std::mem::zeroed() };
            if unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut ts) } != 0 {
                return None;
            }
            let (secs, nanos) = (u64::try_from(ts.tv_sec).ok()?, u64::try_from(ts.tv_nsec).ok()?);
            Some(secs * self.hz + nanos * self.hz / 1_000_000_000)
        }
    }

    /// Every core's time so far, busy or idle, from `/proc/stat`'s `cpu` line (user nice system
    /// idle iowait irq softirq steal; guest time is already in user and nice), as `ops::host`
    /// sums it for the host's CPU%.
    pub(super) fn total_ticks(stat: &str) -> Option<u64> {
        let line = stat.lines().next()?.strip_prefix("cpu ")?;
        let v: Vec<u64> = line.split_whitespace().filter_map(|x| x.parse().ok()).take(8).collect();
        (v.len() >= 4).then(|| v.iter().sum())
    }

    /// The fields of a `/proc/<pid>/stat` line this reads: `pid (comm) state ppid pgrp session
    /// tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice
    /// num_threads itrealvalue starttime vsize rss …`, counted from the last `)` (`comm` may
    /// contain spaces and parens).
    pub(super) fn parse_stat(pid: u32, stat: &[u8], page: u64) -> Option<Proc> {
        let close = memchr::memrchr(b')', stat)?;
        let mut f = stat.get(close + 1..)?.split(|b| b.is_ascii_whitespace()).filter(|s| !s.is_empty());
        let state = *f.next()?.first()?;
        let ppid = u32::try_from(signed(f.next()?)?).ok()?;
        let mut f = f.skip(9);
        let (utime, stime) = (unsigned(f.next()?)?, unsigned(f.next()?)?);
        let (cutime, cstime) = (signed(f.next()?)?, signed(f.next()?)?);
        let mut f = f.skip(4);
        let start = unsigned(f.next()?)?;
        let rss = signed(f.nth(1)?)?;
        Some(Proc {
            pid,
            ppid,
            start,
            cpu: utime + stime,
            reaped: cutime + cstime,
            rss: rss.saturating_mul(page),
            zombie: matches!(state, b'Z' | b'X' | b'x'),
        })
    }

    fn unsigned(s: &[u8]) -> Option<u64> {
        std::str::from_utf8(s).ok()?.parse().ok()
    }

    /// A field the kernel prints as signed (`%ld`), negative read as 0.
    fn signed(s: &[u8]) -> Option<u64> {
        let v: i64 = std::str::from_utf8(s).ok()?.parse().ok()?;
        Some(v.max(0).unsigned_abs())
    }
}

#[cfg(not(target_os = "linux"))]
mod platform {
    use std::time::{Instant, SystemTime, UNIX_EPOCH};

    use sysinfo::{CpuRefreshKind, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System};

    use super::{Proc, Table};

    /// `sysinfo`'s process list, refreshed with CPU time and memory only: start times in seconds
    /// since the epoch, CPU times in milliseconds, the host's capacity wall time × logical CPUs
    /// (what the host's CPU% averages over).
    pub(super) struct Reader {
        sys: System,
        epoch: Instant,
        cores: u64,
    }

    impl Default for Reader {
        fn default() -> Self {
            let mut sys = System::new();
            sys.refresh_cpu_list(CpuRefreshKind::nothing());
            let cores = u64::try_from(sys.cpus().len()).unwrap_or(1).max(1);
            Self { sys, epoch: Instant::now(), cores }
        }
    }

    impl Reader {
        pub(super) fn read(&mut self) -> Option<Table> {
            self.sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cpu().with_memory());
            let born_at = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
            let cpu_at = u64::try_from(self.epoch.elapsed().as_millis()).ok()?.saturating_mul(self.cores);
            let procs = self
                .sys
                .processes()
                .iter()
                .map(|(pid, p)| Proc {
                    pid: pid.as_u32(),
                    ppid: p.parent().map_or(0, |pp| pp.as_u32()),
                    start: p.start_time(),
                    cpu: p.accumulated_cpu_time(),
                    reaped: 0,
                    rss: p.memory(),
                    zombie: matches!(p.status(), ProcessStatus::Zombie),
                })
                .collect();
            Some(Table { procs, born_at, cpu_at })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GB: u64 = 1 << 30;

    fn proc(pid: u32, ppid: u32, start: u64, cpu: u64) -> Proc {
        Proc { pid, ppid, start, cpu, rss: 100, ..Default::default() }
    }

    fn table(born_at: u64, cpu_at: u64, procs: &[Proc]) -> Table {
        Table { procs: procs.to_vec(), born_at, cpu_at }
    }

    fn root(agent: &str, omp: Option<u32>, shell: Option<u32>) -> Root {
        Root { agent_id: agent.into(), omp, shell }
    }

    /// (agent, cpu %, mem, procs) rounded to 0.1 %.
    fn view(loads: &[AgentLoad]) -> Vec<(String, f32, u64, u32)> {
        loads.iter().map(|l| (l.agent_id.clone(), (l.cpu_pct * 10.0).round() / 10.0, l.mem, l.procs)).collect()
    }

    /// Two panes (herdr 1 → shell → omp → tools) and a process outside every pane.
    fn host(at: u64, cpu: [u64; 7]) -> Vec<Proc> {
        vec![
            proc(1, 0, 0, 0),
            proc(10, 1, 5, 0),          // herdr server
            proc(20, 10, 6, 1),         // pane A's shell
            proc(21, 20, 7, cpu[0]),    // A's omp
            proc(22, 21, at, cpu[1]),   // A's test run
            proc(23, 22, at, cpu[2]),   // its worker
            proc(30, 10, 6, 1),         // pane B's shell
            proc(31, 30, 7, cpu[3]),    // B's omp
            proc(32, 31, 8, cpu[4]),    // B's dev server
            proc(40, 1, 9, cpu[5]),     // a daemon outside the panes
            proc(41, 31, 9, cpu[6]),    // B's browser
        ]
    }

    #[test]
    fn trees_add_up_per_agent_on_the_host_scale() {
        let roots = [root("a", Some(21), Some(20)), root("b", Some(31), Some(30))];
        let mut s = Sampler::default();
        let t0 = Instant::now();
        // The first sample is a baseline: memory and processes, no CPU yet.
        let first = s.next(table(100, 10_000, &host(50, [100, 10, 10, 200, 50, 900, 30])), &roots, t0);
        assert_eq!(view(&first), [("a".into(), 0.0, 300, 3), ("b".into(), 0.0, 300, 3)]);
        // 1000 ticks of capacity later (2 cores × 5 s at 100 Hz): a's tests ran 400 + 200, its omp 40;
        // b's omp 20, server 10, browser 30. The daemon outside the panes counts for nobody.
        let second = s.next(table(600, 11_000, &host(50, [140, 410, 210, 220, 60, 1_900, 60])), &roots, t0 + Duration::from_secs(5));
        assert_eq!(view(&second), [("a".into(), 64.0, 300, 3), ("b".into(), 6.0, 300, 3)]);
    }

    #[test]
    fn omp_outside_its_pane_falls_back_to_the_shell() {
        let procs = host(50, [0; 7]);
        let tables = |procs: &[Proc]| table(100, 0, procs);
        let mut s = Sampler::default();
        let now = Instant::now();
        // A stale omp pid that now belongs to pane B's omp: a counts its own pane, B's tree stays B's.
        let loads = s.next(tables(&procs), &[root("a", Some(31), Some(20)), root("b", Some(31), Some(30))], now);
        assert_eq!(view(&loads), [("a".into(), 0.0, 400, 4), ("b".into(), 0.0, 300, 3)]);
        // No pid known yet: the pane's shell; no shell either: only omp; neither running: absent.
        let loads = s.next(tables(&procs), &[root("a", None, Some(20)), root("b", Some(31), None), root("c", Some(99), Some(98))], now);
        assert_eq!(view(&loads), [("a".into(), 0.0, 400, 4), ("b".into(), 0.0, 300, 3)]);
    }

    #[test]
    fn a_process_counts_for_the_nearest_agent_above_it() {
        // An agent started a herdr of its own whose pane runs another board agent: the inner
        // agent's tree is its own, never both (the inner pane's shell sits under the outer omp).
        let procs = [proc(1, 0, 0, 0), proc(20, 1, 1, 0), proc(21, 20, 2, 0), proc(50, 21, 3, 0), proc(51, 50, 4, 0), proc(52, 51, 5, 0), proc(53, 52, 6, 0)];
        let loads = Sampler::default().next(table(10, 0, &procs), &[root("outer", Some(21), Some(20)), root("inner", Some(52), Some(51))], Instant::now());
        assert_eq!(view(&loads), [("outer".into(), 0.0, 300, 3), ("inner".into(), 0.0, 200, 2)]);
    }

    #[test]
    fn new_processes_count_their_whole_life_and_missed_ones_start_a_baseline() {
        let roots = [root("a", Some(2), None)];
        let mut s = Sampler::default();
        let t0 = Instant::now();
        s.next(table(100, 0, &[proc(1, 0, 0, 0), proc(2, 1, 10, 50)]), &roots, t0);
        // 3 was born after the previous sample (start 150 ≥ 100): all its 300 ticks are this
        // interval's. 4 started long before but the previous sample missed it: no spike.
        let procs = [proc(1, 0, 0, 0), proc(2, 1, 10, 50), proc(3, 2, 150, 300), proc(4, 2, 20, 5_000)];
        let loads = s.next(table(200, 1_000, &procs), &roots, t0 + Duration::from_secs(5));
        assert_eq!(view(&loads), [("a".into(), 30.0, 300, 3)]);
    }

    #[test]
    fn a_reused_pid_is_a_new_process() {
        let roots = [root("a", Some(2), None)];
        let mut s = Sampler::default();
        let t0 = Instant::now();
        s.next(table(100, 0, &[proc(1, 0, 0, 0), proc(2, 1, 10, 0), proc(3, 2, 20, 9_000)]), &roots, t0);
        // pid 3 exited (nobody collected its time: no `reaped`) and a new process took the pid:
        // its 40 ticks count, not 40 − 9000 or the old process's history.
        let loads = s.next(table(200, 1_000, &[proc(1, 0, 0, 0), proc(2, 1, 10, 0), proc(3, 2, 180, 40)]), &roots, t0 + Duration::from_secs(5));
        assert_eq!(view(&loads), [("a".into(), 4.0, 200, 2)]);
    }

    #[test]
    fn exited_children_add_only_their_last_moments() {
        let roots = [root("a", Some(2), None)];
        let mut s = Sampler::default();
        let t0 = Instant::now();
        let parent = |cpu, reaped| Proc { reaped, ..proc(2, 1, 10, cpu) };
        // A long-lived child with 5000 ticks of history, and a zombie child the parent hasn't
        // reaped yet.
        let zombie = Proc { zombie: true, rss: 0, ..proc(4, 2, 30, 700) };
        s.next(table(100, 0, &[proc(1, 0, 0, 0), parent(10, 0), proc(3, 2, 20, 5_000), zombie]), &roots, t0);
        // Both were reaped: the parent's `reaped` grew by their final times (5060 + 700). Only the
        // child's 60 ticks since the last sample are new; the zombie had nothing left. A command
        // born and reaped within the interval (25 ticks) counts in full.
        let loads = s.next(table(200, 1_000, &[proc(1, 0, 0, 0), parent(20, 5_060 + 700 + 25)]), &roots, t0 + Duration::from_secs(5));
        assert_eq!(view(&loads), [("a".into(), 9.5, 100, 1)]);
        // A parent that never collects its children's time (SIGCHLD ignored) goes no lower than its
        // own time.
        let mut s = Sampler::default();
        s.next(table(100, 0, &[proc(1, 0, 0, 0), parent(10, 0), proc(3, 2, 20, 5_000)]), &roots, t0);
        let loads = s.next(table(200, 1_000, &[proc(1, 0, 0, 0), parent(30, 0)]), &roots, t0 + Duration::from_secs(5));
        assert_eq!(view(&loads), [("a".into(), 2.0, 100, 1)]);
    }

    #[test]
    fn grandchildren_reaped_through_an_exited_child_add_only_their_last_moments() {
        // omp 2 → sh 3 → cc 4; cc exits and sh reaps it, then sh exits and omp reaps sh: omp's
        // `reaped` grows by sh's final time, which includes cc's.
        let roots = [root("a", Some(2), None)];
        let mut s = Sampler::default();
        let t0 = Instant::now();
        s.next(table(100, 0, &[proc(1, 0, 0, 0), proc(2, 1, 10, 0), proc(3, 2, 20, 100), proc(4, 3, 30, 1_000)]), &roots, t0);
        let omp = Proc { reaped: (110 + 1_050), ..proc(2, 1, 10, 0) };
        let loads = s.next(table(200, 1_000, &[proc(1, 0, 0, 0), omp]), &roots, t0 + Duration::from_secs(5));
        assert_eq!(view(&loads), [("a".into(), 6.0, 100, 1)]);
    }

    #[test]
    fn after_a_long_gap_the_sample_is_a_baseline() {
        let roots = [root("a", Some(2), None)];
        let mut s = Sampler::default();
        let t0 = Instant::now();
        s.next(table(100, 0, &[proc(1, 0, 0, 0), proc(2, 1, 10, 0)]), &roots, t0);
        let loads = s.next(table(90_000, 900_000, &[proc(1, 0, 0, 0), proc(2, 1, 10, 600_000)]), &roots, t0 + MAX_GAP + Duration::from_secs(1));
        assert_eq!(view(&loads), [("a".into(), 0.0, 100, 1)]);
        let loads = s.next(table(90_500, 901_000, &[proc(1, 0, 0, 0), proc(2, 1, 10, 600_100)]), &roots, t0 + MAX_GAP + Duration::from_secs(6));
        assert_eq!(view(&loads), [("a".into(), 10.0, 100, 1)]);
    }

    #[test]
    fn a_parent_younger_than_its_child_is_not_its_parent() {
        // Windows: 3's parent died and a newer process took pid 2.
        let procs = [proc(1, 0, 0, 0), proc(2, 1, 50, 0), proc(3, 2, 20, 0)];
        let loads = Sampler::default().next(table(100, 0, &procs), &[root("a", Some(2), None)], Instant::now());
        assert_eq!(view(&loads), [("a".into(), 0.0, 100, 1)]);
    }

    #[test]
    fn busiest_first_then_largest() {
        let roots = [root("idle", Some(2), None), root("busy", Some(3), None), root("big", Some(4), None)];
        let mut s = Sampler::default();
        let t0 = Instant::now();
        let big = |cpu| Proc { rss: 3 * GB, ..proc(4, 1, 10, cpu) };
        s.next(table(100, 0, &[proc(1, 0, 0, 0), proc(2, 1, 10, 0), proc(3, 1, 10, 0), big(0)]), &roots, t0);
        let loads = s.next(table(200, 1_000, &[proc(1, 0, 0, 0), proc(2, 1, 10, 0), proc(3, 1, 10, 500), big(0)]), &roots, t0 + Duration::from_secs(5));
        assert_eq!(view(&loads).into_iter().map(|l| l.0).collect::<Vec<_>>(), ["busy", "big", "idle"]);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn parses_proc_stat_lines() {
        // `comm` with spaces and parens; negative priority and nice (a real-time process).
        let line = b"4242 (tf (x) y) S 4200 4242 4200 34823 4242 4194304 1033 0 0 0 123 45 67 8 -2 -5 9 0 77777 1234567 2500 18446744073709551615 1 1 0 0 0\n";
        let p = platform::parse_stat(4242, line, 4096).unwrap();
        assert_eq!(p, Proc { pid: 4242, ppid: 4200, start: 77777, cpu: 168, reaped: 75, rss: 2500 * 4096, zombie: false });
        assert!(platform::parse_stat(1, b"1 (x) Z 0 1 1 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 10 0 0", 4096).unwrap().zombie);
        assert_eq!(platform::parse_stat(1, b"1 (x) S 0", 4096), None);
        assert_eq!(platform::total_ticks("cpu  100 2 30 400 5 6 7 8 9 10\ncpu0 1 2 3 4\n"), Some(558));
    }

    /// The real `/proc`: a shell spinning between two samples, with a child of its own.
    #[cfg(target_os = "linux")]
    #[test]
    fn samples_a_real_process_tree() {
        /// Ends the shell's loop however the test ends (the loop also ends with its `sleep`).
        struct Stop(std::path::PathBuf);
        impl Drop for Stop {
            fn drop(&mut self) {
                let _ = std::fs::write(&self.0, b"");
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let stop = Stop(dir.path().join("stop"));
        let mut sh = std::process::Command::new("sh")
            .arg("-c")
            .arg(r#"sleep 10 & while [ ! -e "$STOP" ] && kill -0 $! 2>/dev/null; do :; done; kill $! 2>/dev/null; wait"#)
            .env("STOP", &stop.0)
            .spawn()
            .unwrap();
        let roots = [root("lab", Some(sh.id()), None)];
        let mut s = Sampler::default();
        let first = s.sample(&roots);
        std::thread::sleep(Duration::from_millis(400));
        let second = s.sample(&roots);
        drop(stop);
        let _ = sh.wait();
        assert_eq!(first.len(), 1, "{first:?}");
        let load = &second[0];
        assert_eq!((load.agent_id.as_str(), load.procs), ("lab", 2), "sh and its sleep: {second:?}");
        assert!(load.mem > 0 && load.cpu_pct > 0.0, "{load:?}");
    }

    /// This thread's CPU time: what a measurement costs, whatever else the machine runs meanwhile.
    #[cfg(target_os = "linux")]
    fn thread_cpu() -> Duration {
        // SAFETY: an all-zero timespec is valid, and `ts` is a properly sized out-param.
        let mut ts: libc::timespec = unsafe { std::mem::zeroed() };
        unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
        Duration::new(ts.tv_sec.unsigned_abs(), u32::try_from(ts.tv_nsec).unwrap_or(0))
    }

    /// The cost of a scan on this machine (CPU time, and wall time on a busy machine), optionally
    /// with `TF_LOADS_SPAWN` extra sleeping processes: `cargo test -p tf-hostd --release scan_cost
    /// -- --ignored --nocapture`.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "measures; run by hand"]
    fn scan_cost() {
        let extra: usize = std::env::var("TF_LOADS_SPAWN").ok().and_then(|n| n.parse().ok()).unwrap_or(0);
        let mut kids: Vec<std::process::Child> = (0..extra).filter_map(|_| std::process::Command::new("sleep").arg("120").spawn().ok()).collect();
        let roots: Vec<Root> = kids.iter().take(50).enumerate().map(|(i, k)| root(&format!("a{i}"), Some(k.id()), None)).collect();
        let mut s = Sampler::default();
        s.sample(&roots);
        let rounds = 20;
        let (wall, cpu) = (Instant::now(), thread_cpu());
        let mut n = 0;
        for _ in 0..rounds {
            n = s.sample(&roots).len().max(n);
        }
        let (wall, cpu) = (wall.elapsed() / rounds, (thread_cpu() - cpu) / rounds);
        let procs = platform::Reader::default().read().unwrap().procs.len();
        for k in &mut kids {
            let _ = k.kill();
            let _ = k.wait();
        }
        println!("{procs} processes, {n} agents: {cpu:?} CPU per sample ({:?} per process), {wall:?} wall", cpu / procs as u32);
    }

    /// The pure part (deltas, trees, sums) on a synthetic table of 20,000 processes.
    #[test]
    #[ignore = "measures; run by hand"]
    fn aggregate_cost() {
        let n = 20_000u32;
        let procs = |tick: u64| -> Vec<Proc> {
            (1..=n).map(|pid| proc(pid, if pid <= 100 { 1 } else { 1 + pid % 100 }, u64::from(pid), u64::from(pid) * tick)).collect()
        };
        let roots: Vec<Root> = (2..=100).map(|pid| root(&format!("a{pid}"), Some(pid), None)).collect();
        let mut s = Sampler::default();
        let t0 = Instant::now();
        s.next(table(n.into(), 0, &procs(1)), &roots, t0);
        let start = Instant::now();
        let loads = s.next(table(u64::from(n) + 1, 1_000_000, &procs(2)), &roots, t0 + Duration::from_secs(5));
        println!("{n} processes, {} agents: {:?}", loads.len(), start.elapsed());
    }
}
