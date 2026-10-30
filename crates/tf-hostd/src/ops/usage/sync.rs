//! Keeps omp's stats index current with omp's own sync: `omp stats --summary` (output discarded)
//! runs omp-stats' incremental `syncAllSessions()` and `refreshRollups()` over every session file.
//!
//! One sync at a time (single flight), in the background: a request that finds the index stale
//! answers at once with what the index holds and `syncing: true`; the next poll gets the fresh
//! figures. Low priority (nice 10, lowest best-effort I/O class; Windows: below normal), its own
//! process group (killed with everything it started on timeout or drop), stdin closed,
//! `NO_COLOR=1`, run in an empty directory of hostd's own (no project `.env` for omp to pick up).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};

use tokio::io::AsyncReadExt;
use tokio::sync::watch;
use tracing::{info, warn};

use tf_proto::Millis;

use crate::ops::tools::{strip_ansi, TreeGuard};
use crate::util::now_ms;

/// A request finds the index stale when this daemon's last successful sync is older than this.
pub(crate) const STALE_AFTER: Duration = Duration::from_secs(10 * 60);
/// `refresh: true` re-syncs unless a sync finished this recently.
pub(crate) const REFRESH_MIN: Duration = Duration::from_secs(30);
/// A sync that makes no progress for this long is killed (omp also waits up to an hour for
/// another sync's lock). One that keeps changing its index may run [`SYNC_CAP`]: the first sync
/// on a host with months of sessions reads gigabytes. omp-stats commits rows and file cursors in
/// bounded batches (512 files / 8192 rows, never one transaction across file I/O; omp 18.13.3
/// `aggregator.ts`), so what a killed sync did stays and the next one carries on.
pub(crate) const SYNC_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// The longest a sync may run, however it progresses.
pub(crate) const SYNC_CAP: Duration = Duration::from_secs(3 * 3600);

/// The command that syncs the index (`omp stats --summary`, or a test script).
#[derive(Debug, Clone)]
pub(crate) struct SyncCmd {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
    /// omp's stats index: while it keeps changing, the sync is making progress and the timeout
    /// does not apply (it is then a stall limit).
    pub watch: Option<PathBuf>,
}

/// Builds the command at run time (omp may be installed or moved while the daemon runs).
pub(crate) type CmdFn = Arc<dyn Fn() -> Result<SyncCmd, String> + Send + Sync>;
/// Runs right after a successful sync, before its result is published.
pub(crate) type DoneFn = Arc<dyn Fn() + Send + Sync>;

/// Why a sync may start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Want {
    /// Someone looks at usage: sync when the index is older than [`STALE_AFTER`] (not while
    /// backing off after failures).
    IfStale,
    /// The user asked to refresh: sync unless one finished within [`REFRESH_MIN`].
    Now,
    /// Periodic warm-up: sync when the last success is older than the period.
    Warmup(Duration),
}

/// What a client sees of the syncs.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct SyncStatus {
    pub running: bool,
    pub synced_at: Option<Millis>,
    pub added: Option<u64>,
    pub error: Option<String>,
    pub error_at: Option<Millis>,
    /// Bumped by every finished sync (success or not).
    pub generation: u64,
}

#[derive(Default)]
struct State {
    running: bool,
    ok_at: Option<Instant>,
    finished: Option<Instant>,
    failures: u32,
    status: SyncStatus,
}

pub(crate) struct Syncer {
    st: Mutex<State>,
    cmd: CmdFn,
    on_done: Mutex<Option<DoneFn>>,
    timeout: Duration,
    done: watch::Sender<u64>,
}

/// A parsed `Synced N new entries from M files (T total)` line.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct Outcome {
    pub added: Option<u64>,
    pub files: Option<u64>,
    pub total: Option<u64>,
}

impl Syncer {
    pub(crate) fn new(cmd: CmdFn, timeout: Duration) -> Arc<Self> {
        Arc::new(Self { st: Mutex::new(State::default()), cmd, on_done: Mutex::new(None), timeout, done: watch::channel(0).0 })
    }

    pub(crate) fn set_on_done(&self, f: DoneFn) {
        *lock(&self.on_done) = Some(f);
    }

    pub(crate) fn status(&self) -> SyncStatus {
        let st = lock(&self.st);
        SyncStatus { running: st.running, ..st.status.clone() }
    }

    /// Starts a sync in the background when `want` calls for one. True when a sync runs now
    /// (just started or already running).
    pub(crate) fn request(self: &Arc<Self>, want: Want) -> bool {
        {
            let mut st = lock(&self.st);
            if st.running {
                return true;
            }
            if !should_start(&st, want, Instant::now()) {
                return false;
            }
            st.running = true;
        }
        let me = self.clone();
        tokio::spawn(async move { me.run().await });
        true
    }

    /// Resolves once no sync runs.
    #[cfg(test)]
    pub(crate) async fn idle(&self) {
        let mut rx = self.done.subscribe();
        while lock(&self.st).running {
            if rx.changed().await.is_err() {
                return;
            }
        }
    }

    async fn run(self: Arc<Self>) {
        let started = Instant::now();
        let result = match (self.cmd)() {
            Ok(cmd) => run_cmd(&cmd, self.timeout).await,
            Err(e) => Err(e),
        };
        if result.is_ok() {
            // The live mark must be taken before `synced_at` moves (a request in between would
            // count live spend from the previous sync on top of the new index).
            let hook = lock(&self.on_done).clone();
            if let Some(f) = hook {
                f();
            }
        }
        let generation = {
            let mut st = lock(&self.st);
            st.running = false;
            st.finished = Some(Instant::now());
            st.status.generation += 1;
            match &result {
                Ok(o) => {
                    st.ok_at = st.finished;
                    st.failures = 0;
                    st.status.synced_at = Some(now_ms());
                    st.status.added = o.added;
                    st.status.error = None;
                    st.status.error_at = None;
                }
                Err(e) => {
                    st.failures = st.failures.saturating_add(1);
                    st.status.error = Some(e.clone());
                    st.status.error_at = Some(now_ms());
                }
            }
            st.status.generation
        };
        match &result {
            Ok(o) => info!(added = o.added, files = o.files, total = o.total, ms = started.elapsed().as_millis() as u64, "omp stats index synced"),
            Err(e) => warn!(ms = started.elapsed().as_millis() as u64, "omp stats sync failed: {e}"),
        }
        self.done.send_replace(generation);
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Automatic retries after failures back off: 1, 2, 4 … 30 min.
fn backoff(failures: u32) -> Duration {
    let mins = 1u64 << failures.saturating_sub(1).min(5);
    Duration::from_secs(60 * mins.min(30))
}

fn should_start(st: &State, want: Want, now: Instant) -> bool {
    let since_finish = st.finished.map(|t| now.saturating_duration_since(t));
    let backing_off = st.failures > 0 && since_finish.is_some_and(|d| d < backoff(st.failures));
    let ok_age = st.ok_at.map(|t| now.saturating_duration_since(t));
    match want {
        Want::Now => since_finish.is_none_or(|d| d >= REFRESH_MIN),
        Want::IfStale => !backing_off && ok_age.is_none_or(|d| d >= STALE_AFTER),
        Want::Warmup(period) => !backing_off && ok_age.is_none_or(|d| d >= period),
    }
}

/// Runs one sync: stdout discarded, the tail of stderr kept for the outcome line and errors.
async fn run_cmd(cmd: &SyncCmd, timeout: Duration) -> Result<Outcome, String> {
    std::fs::create_dir_all(&cmd.cwd).map_err(|e| format!("create {}: {e}", cmd.cwd.display()))?;
    let mut c = tokio::process::Command::new(&cmd.program);
    c.args(&cmd.args)
        .current_dir(&cmd.cwd)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        c.process_group(0);
        // SAFETY: only async-signal-safe syscalls between fork and exec.
        unsafe {
            c.pre_exec(|| {
                // Background work: never compete with agents or the UI for CPU or disk.
                libc::setpriority(libc::PRIO_PROCESS, 0, 10);
                #[cfg(target_os = "linux")]
                {
                    // IOPRIO_WHO_PROCESS, this process, best-effort class at its lowest level.
                    libc::syscall(libc::SYS_ioprio_set, 1, 0, (2 << 13) | 7);
                }
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS
        c.creation_flags(0x0800_0000 | 0x0000_4000);
    }
    let name = cmd.program.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut child = c.spawn().map_err(|e| format!("couldn't run {name}: {e}"))?;
    let mut tree = TreeGuard(child.id());
    let mut stderr = child.stderr.take();
    let read = async move {
        let mut tail: Vec<u8> = Vec::new();
        let mut buf = [0u8; 4096];
        if let Some(err) = stderr.as_mut() {
            while let Ok(n) = err.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                tail.extend_from_slice(&buf[..n]);
                if tail.len() > 16 * 1024 {
                    tail.drain(..tail.len() - 8 * 1024);
                }
            }
        }
        tail
    };
    let work = async { tokio::join!(child.wait(), read) };
    tokio::pin!(work);
    // The timeout is a stall limit: a sync that keeps writing its index (`watch`) goes on, up to SYNC_CAP.
    let started = Instant::now();
    let mut last_change = started;
    let mut seen = cmd.watch.as_deref().map(fingerprint);
    let poll = (timeout / 10).clamp(Duration::from_millis(20), Duration::from_secs(10));
    let done = loop {
        tokio::select! {
            r = &mut work => break Some(r),
            _ = tokio::time::sleep(poll) => {
                if let Some(db) = cmd.watch.as_deref() {
                    let now = fingerprint(db);
                    if seen.as_ref() != Some(&now) {
                        seen = Some(now);
                        last_change = Instant::now();
                    }
                }
                if last_change.elapsed() >= timeout || started.elapsed() >= SYNC_CAP {
                    break None;
                }
            }
        }
    };
    let Some((status, tail)) = done else {
        drop(tree);
        let long = started.elapsed() >= SYNC_CAP;
        return Err(if long {
            format!("omp stats was still running after {}", human(SYNC_CAP))
        } else if cmd.watch.is_some() {
            format!("omp stats made no progress for {} (another `omp stats` may hold its sync lock)", human(timeout))
        } else {
            format!("omp stats did not finish within {} (another `omp stats` may hold its sync lock)", human(timeout))
        });
    };
    // Exited (and reaped): leave anything it deliberately left running alone.
    tree.0 = None;
    let text = strip_ansi(&String::from_utf8_lossy(&tail));
    let status = status.map_err(|e| format!("{name}: {e}"))?;
    if !status.success() {
        let last = text.lines().map(str::trim).rev().find(|l| !l.is_empty()).unwrap_or("");
        let mut msg = if last.is_empty() { format!("omp stats exited with {status}") } else { format!("omp stats: {last}") };
        if msg.len() > 300 {
            let cut = (0..=300).rev().find(|i| msg.is_char_boundary(*i)).unwrap_or(0);
            msg.truncate(cut);
            msg.push('…');
        }
        return Err(msg);
    }
    Ok(parse_outcome(&text))
}

/// `Synced 12 new entries from 3 files (4171 total)` (omp's stderr summary).
pub(crate) fn parse_outcome(text: &str) -> Outcome {
    let Some(line) = text.lines().rev().find(|l| l.contains("Synced ")) else { return Outcome::default() };
    let nums: Vec<u64> = line
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse().ok())
        .collect();
    Outcome { added: nums.first().copied(), files: nums.get(1).copied(), total: nums.get(2).copied() }
}

/// "10 min" / "1 s".
fn human(d: Duration) -> String {
    let secs = d.as_secs_f64();
    if secs >= 60.0 { format!("{} min", (secs / 60.0).round()) } else { format!("{} s", secs.ceil()) }
}

/// Size and mtime of the index and its WAL: any write omp makes moves one of them.
fn fingerprint(db: &Path) -> [Option<(u64, SystemTime)>; 2] {
    let mut wal = db.as_os_str().to_owned();
    wal.push("-wal");
    let of = |p: &Path| std::fs::metadata(p).ok().and_then(|m| Some((m.len(), m.modified().ok()?)));
    [of(db), of(Path::new(&wal))]
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// A fake omp: appends a line to `runs` per start, waits `secs`, prints omp's summary line
    /// (or fails when `fail` exists).
    fn script(dir: &std::path::Path, secs: &str) -> CmdFn {
        let path = dir.join("omp");
        let body = format!(
            "#!/bin/sh\necho \"$PWD $*\" >> '{d}/runs'\nsleep {secs}\nif [ -e '{d}/fail' ]; then echo 'boom: stats.db is locked' >&2; exit 3; fi\n\
             echo 'Syncing session files...' >&2\necho 'Synced 12 new entries from 3 files (40 total)' >&2\necho '=== AI Usage Statistics ==='\n",
            d = dir.display()
        );
        crate::test_exe::write_exe(&path, body);
        let cwd = dir.join("cwd");
        Arc::new(move || Ok(SyncCmd { program: path.clone(), args: vec!["stats".into(), "--summary".into()], cwd: cwd.clone(), watch: None }))
    }

    fn runs(dir: &std::path::Path) -> Vec<String> {
        std::fs::read_to_string(dir.join("runs")).unwrap_or_default().lines().map(str::to_string).collect()
    }

    #[tokio::test]
    async fn single_flight_and_staleness() {
        let td = tempfile::tempdir().unwrap();
        let s = Syncer::new(script(td.path(), "0.3"), Duration::from_secs(10));
        let marks = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let m = marks.clone();
        s.set_on_done(Arc::new(move || {
            m.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }));
        // Never synced: stale. Concurrent asks join the one running sync.
        assert!(s.request(Want::IfStale));
        assert!(s.request(Want::IfStale));
        assert!(s.request(Want::Now));
        assert!(s.status().running);
        s.idle().await;
        let st = s.status();
        assert!(!st.running);
        assert_eq!(runs(td.path()).len(), 1, "one process for three asks");
        assert_eq!(st.added, Some(12));
        assert!(st.synced_at.is_some() && st.error.is_none());
        assert_eq!(st.generation, 1);
        assert_eq!(marks.load(std::sync::atomic::Ordering::SeqCst), 1, "live mark taken once");
        // In its own empty directory, as `omp stats --summary`.
        let line = &runs(td.path())[0];
        assert!(line.ends_with("/cwd stats --summary"), "{line}");
        // Fresh: neither a look nor a warm-up syncs again; a refresh within 30 s does not either.
        assert!(!s.request(Want::IfStale));
        assert!(!s.request(Want::Warmup(Duration::from_secs(60))));
        assert!(!s.request(Want::Now));
        assert_eq!(runs(td.path()).len(), 1);
    }

    #[test]
    fn decisions_over_time() {
        let t0 = Instant::now();
        let mut st = State::default();
        assert!(should_start(&st, Want::IfStale, t0), "never synced");
        st.ok_at = Some(t0);
        st.finished = Some(t0);
        assert!(!should_start(&st, Want::IfStale, t0 + Duration::from_secs(9 * 60)));
        assert!(should_start(&st, Want::IfStale, t0 + STALE_AFTER), "older than 10 min");
        assert!(!should_start(&st, Want::Now, t0 + Duration::from_secs(29)));
        assert!(should_start(&st, Want::Now, t0 + REFRESH_MIN));
        assert!(!should_start(&st, Want::Warmup(Duration::from_secs(1800)), t0 + Duration::from_secs(1799)));
        assert!(should_start(&st, Want::Warmup(Duration::from_secs(1800)), t0 + Duration::from_secs(1800)));
        // After failures automatic syncs back off (1, 2, 4 … 30 min); a refresh still may.
        let t1 = t0 + Duration::from_secs(3600);
        st.finished = Some(t1);
        st.failures = 1;
        assert!(!should_start(&st, Want::IfStale, t1 + Duration::from_secs(59)));
        assert!(should_start(&st, Want::IfStale, t1 + Duration::from_secs(60)));
        st.failures = 3;
        assert!(!should_start(&st, Want::IfStale, t1 + Duration::from_secs(239)));
        assert!(!should_start(&st, Want::Warmup(Duration::ZERO), t1 + Duration::from_secs(239)));
        assert!(should_start(&st, Want::Now, t1 + REFRESH_MIN));
        st.failures = 40;
        assert_eq!(backoff(st.failures), Duration::from_secs(1800));
    }

    #[tokio::test]
    async fn failures_and_timeouts_are_reported() {
        let td = tempfile::tempdir().unwrap();
        std::fs::write(td.path().join("fail"), "").unwrap();
        let s = Syncer::new(script(td.path(), "0"), Duration::from_secs(10));
        assert!(s.request(Want::IfStale));
        s.idle().await;
        let st = s.status();
        assert_eq!(st.error.as_deref(), Some("omp stats: boom: stats.db is locked"));
        assert!(st.error_at.is_some() && st.synced_at.is_none());
        // Backing off: looking again does not retry at once.
        assert!(!s.request(Want::IfStale));

        // A sync that hangs is killed with its process group at the timeout.
        let td2 = tempfile::tempdir().unwrap();
        let s = Syncer::new(script(td2.path(), "30"), Duration::from_millis(300));
        let t = Instant::now();
        assert!(s.request(Want::Now));
        s.idle().await;
        assert!(t.elapsed() < Duration::from_secs(10), "killed, not waited for");
        let err = s.status().error.unwrap();
        assert!(err.contains("did not finish within 1 s"), "{err}");
        // An omp that is missing reports why.
        let s = Syncer::new(Arc::new(|| Err("omp is not installed on this host".to_string())), Duration::from_secs(1));
        assert!(s.request(Want::Now));
        s.idle().await;
        assert_eq!(s.status().error.as_deref(), Some("omp is not installed on this host"));
    }

    /// A sync that outlasts the timeout while its index keeps changing is left alone; the same
    /// run without changes is killed.
    #[tokio::test]
    async fn a_progressing_sync_outlives_the_timeout() {
        let td = tempfile::tempdir().unwrap();
        let path = td.path().join("omp");
        let db = td.path().join("stats.db");
        let body = |writes: bool| {
            format!(
                "#!/bin/sh\nfor i in $(seq 40); do {w} sleep 0.05; done\necho 'Synced 5 new entries from 1 files (9 total)' >&2\n",
                w = if writes { format!("echo x >> '{}';", db.display()) } else { String::new() }
            )
        };
        let cmd = |watch: bool| {
            let (path, cwd, db) = (path.clone(), td.path().join("cwd"), db.clone());
            Arc::new(move || Ok(SyncCmd { program: path.clone(), args: vec![], cwd: cwd.clone(), watch: watch.then(|| db.clone()) })) as CmdFn
        };
        let write = |text: String| crate::test_exe::write_exe(&path, text);
        write(body(true));
        let s = Syncer::new(cmd(true), Duration::from_secs(1));
        assert!(s.request(Want::Now));
        s.idle().await;
        assert_eq!(s.status().error, None, "2 s of writes outlasts a 1 s stall limit");
        assert_eq!(s.status().added, Some(5));
        write(body(false));
        let s = Syncer::new(cmd(true), Duration::from_secs(1));
        assert!(s.request(Want::Now));
        s.idle().await;
        let err = s.status().error.unwrap();
        assert!(err.contains("made no progress"), "{err}");
    }

    #[test]
    fn outcome_line() {
        let o = parse_outcome("Syncing session files...\nSynced 0 new entries from 0 files (4171 total)\n\n");
        assert_eq!(o, Outcome { added: Some(0), files: Some(0), total: Some(4171) });
        let o = parse_outcome("Syncing session files...\nSynced 1204 new entries from 37 files (98765 total)\n");
        assert_eq!(o, Outcome { added: Some(1204), files: Some(37), total: Some(98765) });
        assert_eq!(parse_outcome("nothing"), Outcome::default());
    }
}
