//! Runs the MCP helper extension (`host/teleflock-mcp/teleflock-mcp.ts`, embedded here) in a
//! throwaway headless omp, so status, tools, sign-in and registry search use omp's own code
//! (architecture §3.15 "Helper"). One request per process:
//!
//! ```text
//! omp --mode rpc --no-session --no-skills --no-rules --no-lsp --no-tools --no-extensions -e <home>/ext/teleflock-mcp.ts
//!     # cwd = the folder the request is about; env TF_MCP_IN / TF_MCP_OUT [/ TF_MCP_INPUT], NO_COLOR=1,
//!     # OMP_MCP_STARTUP_TIMEOUT_MS=1
//! ```
//!
//! The request goes through an owner-only file the helper deletes on read (it may hold a draft's
//! secrets); answers come back as JSON lines appended to the output file: `hello`, events
//! (`auth`, `progress`), then one `result` or `error` line. Nothing travels on argv.
//!
//! **Deadlines.** Every request has one. Waiting for a free slot counts against it (`busy` when
//! none frees up in time); sign-ins have slots of their own, so one waiting minutes for the user
//! never holds up a check. The helper gets the deadline as `deadlineAt` (wall clock, less
//! [`ANSWER_MARGIN`]) and fits its work into it: omp's own discovery window is kept at 1 ms
//! (`OMP_MCP_STARTUP_TIMEOUT_MS` overrides what the helper asks for, and `0` would wait for every
//! server's first connection), the helper waits for the servers itself, then disconnects every
//! one. A helper still running at the deadline is stopped.
//!
//! **Stopping.** The helper leads its own process group. On Linux omp starts stdio MCP servers in
//! sessions of their own (`setsid`), so they would outlive a killed omp: they are found through
//! `/proc` while the helper still runs and stopped with it — SIGTERM, up to [`STOP_GRACE`], then
//! SIGKILL. omp's worker daemons (`__omp_worker_*` in their argv: shared with other omp processes,
//! detached on purpose) are left alone. Windows: `taskkill /T /F` of the helper's tree.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde_json::Value;
use tf_proto::ApiError;
use tokio::io::AsyncReadExt;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinHandle;

/// The helper, embedded so it always matches this tf-hostd.
pub const SOURCE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../host/teleflock-mcp/teleflock-mcp.ts"));
const FILE_NAME: &str = "teleflock-mcp.ts";
/// Checks, tests, sign-outs and searches at once (each starts omp and maybe several MCP servers).
const MAX_RUNNING: usize = 4;
/// Sign-ins at once (each waits minutes for the user).
const MAX_SIGN_INS: usize = 2;
/// Longest wait for a free slot.
const MAX_SLOT_WAIT: Duration = Duration::from_secs(20);
/// Least time left worth starting omp for.
const MIN_RUN: Duration = Duration::from_secs(5);
/// The helper answers this long before the deadline, so its answer is read before it is stopped.
const ANSWER_MARGIN: Duration = Duration::from_millis(1500);
/// SIGTERM to SIGKILL when a helper is stopped.
#[cfg(unix)]
const STOP_GRACE: Duration = Duration::from_secs(1);
/// How long an exited helper's stderr may take to drain (its last words say why it exited).
const STDERR_DRAIN: Duration = Duration::from_millis(500);
const POLL: Duration = Duration::from_millis(100);
/// Kept from the helper's stderr for error messages.
const STDERR_TAIL: usize = 2048;

/// Serializes writing the helper file (concurrent first runs).
static WRITE: Mutex<()> = Mutex::new(());

/// Helper slots: checks, tests, sign-outs and searches share one pool, sign-ins have their own.
#[derive(Debug, Clone)]
pub struct Slots {
    work: Arc<Semaphore>,
    sign_in: Arc<Semaphore>,
}

impl Slots {
    /// This daemon's slots, shared by every request.
    pub fn shared() -> Slots {
        static SHARED: LazyLock<Slots> = LazyLock::new(|| Slots::new(MAX_RUNNING, MAX_SIGN_INS));
        SHARED.clone()
    }

    pub fn new(work: usize, sign_in: usize) -> Slots {
        Slots { work: Arc::new(Semaphore::new(work)), sign_in: Arc::new(Semaphore::new(sign_in)) }
    }

    /// A slot for `op`, waited for at most [`MAX_SLOT_WAIT`] and only while [`MIN_RUN`] would
    /// still be left before `deadline`.
    async fn take(&self, op: &str, deadline: Instant) -> Result<OwnedSemaphorePermit, ApiError> {
        let sign_in = op == "auth";
        let pool = if sign_in { &self.sign_in } else { &self.work };
        let now = Instant::now();
        let by = deadline.checked_sub(MIN_RUN).unwrap_or(now).min(now + MAX_SLOT_WAIT);
        match tokio::time::timeout_at(by.into(), pool.clone().acquire_owned()).await {
            Ok(Ok(slot)) => Ok(slot),
            Ok(Err(_)) => Err(ApiError::new("internal", "helper slots closed")),
            Err(_) if sign_in => Err(ApiError::new("busy", "Other sign-ins are still waiting on this host").with_hint("Finish or cancel them first.").retryable()),
            Err(_) => Err(ApiError::new("busy", "omp is busy checking MCP servers on this host").with_hint("Try again in a moment.").retryable()),
        }
    }
}

/// Where and with what the helper runs.
#[derive(Debug, Clone)]
pub struct HelperEnv {
    pub omp: Option<PathBuf>,
    /// `<home>/ext` (the helper is written there).
    pub ext_dir: PathBuf,
    /// `<home>/run` (owner-only request / answer files).
    pub run_dir: PathBuf,
    /// Tests and labs: the omp agent dir for the child (`PI_CODING_AGENT_DIR`).
    pub agent_dir: Option<PathBuf>,
    /// [`Slots::shared`]; tests use their own.
    pub slots: Slots,
}

impl HelperEnv {
    fn omp(&self) -> Result<&Path, ApiError> {
        self.omp.as_deref().ok_or_else(|| {
            ApiError::new("omp_error", "omp is not installed on this host").with_hint("Install omp (Host setup) to check MCP servers and sign in.")
        })
    }

    /// Writes the embedded helper when the file is missing or differs (an older tf-hostd's copy).
    fn ensure_file(&self) -> Result<PathBuf, ApiError> {
        let path = self.ext_dir.join(FILE_NAME);
        let _g = WRITE.lock().unwrap_or_else(|p| p.into_inner());
        if std::fs::read(&path).is_ok_and(|b| b == SOURCE.as_bytes()) {
            return Ok(path);
        }
        let io = |e: std::io::Error| ApiError::new("io_error", format!("{}: {e}", path.display()));
        std::fs::create_dir_all(&self.ext_dir).map_err(io)?;
        let tmp = self.ext_dir.join(format!(".{FILE_NAME}.{}.tmp", std::process::id()));
        std::fs::write(&tmp, SOURCE).map_err(io)?;
        std::fs::rename(&tmp, &path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            io(e)
        })?;
        Ok(path)
    }

    fn scratch(&self, stem: &str) -> Result<PathBuf, ApiError> {
        create_private_dir(&self.run_dir).map_err(|e| ApiError::new("io_error", format!("{}: {e}", self.run_dir.display())))?;
        let nanos = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        Ok(self.run_dir.join(format!("mcp-{stem}-{}-{nanos}", std::process::id())))
    }
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    b.create(dir)
}

/// Writes `bytes` to a new owner-only file (`O_EXCL`), then renames it to `path`.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let tmp = PathBuf::from(format!("{}.tmp", path.display()));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    let res = opts.open(&tmp).and_then(|mut f| f.write_all(bytes)).and_then(|()| std::fs::rename(&tmp, path));
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

/// When the helper's answer is due, on the wall clock: `deadline` less [`ANSWER_MARGIN`].
fn deadline_at(deadline: Instant) -> i64 {
    let left = deadline.saturating_duration_since(Instant::now()).saturating_sub(ANSWER_MARGIN);
    crate::util::now_ms() + i64::try_from(left.as_millis()).unwrap_or(i64::MAX / 2)
}

/// One running helper. Dropping it kills the helper with the servers it started and removes its
/// files.
pub struct Running {
    child: tokio::process::Child,
    req: PathBuf,
    out: PathBuf,
    input: PathBuf,
    offset: usize,
    pending: Vec<u8>,
    stderr: Arc<Mutex<Vec<u8>>>,
    /// Copies stderr into `stderr` until the pipe closes.
    drain: Option<JoinHandle<()>>,
    started: Instant,
    exited: bool,
    _slot: OwnedSemaphorePermit,
}

impl Running {
    /// Starts the helper for `req` (`{op, …}`) with `cwd` as omp's folder; `deadline` bounds the
    /// wait for a slot and is handed to the helper.
    pub async fn start(env: &HelperEnv, cwd: &Path, mut req: Value, deadline: Instant) -> Result<Running, ApiError> {
        let omp = env.omp()?.to_path_buf();
        let op = req.get("op").and_then(Value::as_str).unwrap_or("op").to_string();
        let slot = env.slots.take(&op, deadline).await?;
        let ext = env.ensure_file()?;
        let base = env.scratch(&op)?;
        let (req_path, out, input) = (base.with_extension("in.json"), base.with_extension("out.jsonl"), base.with_extension("input"));
        if let Some(o) = req.as_object_mut() {
            o.insert("v".into(), 1.into());
            o.insert("deadlineAt".into(), deadline_at(deadline).into());
        }
        write_private(&req_path, req.to_string().as_bytes()).map_err(|e| ApiError::new("io_error", format!("helper request: {e}")))?;
        let mut cmd = tokio::process::Command::new(&omp);
        cmd.args(["--mode", "rpc", "--no-session", "--no-skills", "--no-rules", "--no-lsp", "--no-tools", "--no-extensions", "-e"])
            .arg(&ext)
            .current_dir(cwd)
            .env("TF_MCP_IN", &req_path)
            .env("TF_MCP_OUT", &out)
            .env("TF_MCP_INPUT", &input)
            .env("NO_COLOR", "1")
            .env("OMP_MCP_STARTUP_TIMEOUT_MS", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        if let Some(dir) = &env.agent_dir {
            cmd.env("PI_CODING_AGENT_DIR", dir);
        }
        #[cfg(unix)]
        cmd.process_group(0);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = spawn(&mut cmd).await.map_err(|e| {
            let _ = std::fs::remove_file(&req_path);
            ApiError::new("omp_error", format!("start omp: {e}"))
        })?;
        let stderr = Arc::new(Mutex::new(Vec::new()));
        let drain = child.stderr.take().map(|mut pipe| {
            let tail = stderr.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                while let Ok(n) = pipe.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    let mut t = tail.lock().unwrap_or_else(|p| p.into_inner());
                    t.extend_from_slice(&buf[..n]);
                    let over = t.len().saturating_sub(STDERR_TAIL);
                    t.drain(..over);
                }
            })
        });
        Ok(Running { child, req: req_path, out, input, offset: 0, pending: Vec::new(), stderr, drain, started: Instant::now(), exited: false, _slot: slot })
    }

    /// The next answer line; `None` once the process exited and every line was read.
    pub async fn next(&mut self) -> Option<Value> {
        loop {
            if let Some(v) = self.take_line() {
                return Some(v);
            }
            if self.exited {
                return None;
            }
            // Read after checking the exit status: the helper writes, then exits.
            self.exited = matches!(self.child.try_wait(), Ok(Some(_)) | Err(_));
            if self.read_more() {
                continue;
            }
            if !self.exited {
                tokio::time::sleep(POLL).await;
            }
        }
    }

    fn take_line(&mut self) -> Option<Value> {
        while let Some(nl) = self.pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=nl).collect();
            if let Ok(v) = serde_json::from_slice::<Value>(&line) {
                return Some(v);
            }
        }
        None
    }

    /// Appends new bytes of the output file to `pending`; whether there were any.
    fn read_more(&mut self) -> bool {
        let Ok(bytes) = std::fs::read(&self.out) else { return false };
        if bytes.len() <= self.offset {
            return false;
        }
        self.pending.extend_from_slice(&bytes[self.offset..]);
        self.offset = bytes.len();
        true
    }

    /// Hands pasted text to the helper (omp's `onManualCodeInput`).
    pub fn send_input(&self, text: &str) -> Result<(), ApiError> {
        let _ = std::fs::remove_file(&self.input);
        write_private(&self.input, text.as_bytes()).map_err(|e| ApiError::new("io_error", format!("hand the sign-in input to omp: {e}")))
    }

    /// Stops the helper and the servers it started (module docs, "Stopping").
    pub async fn stop(&mut self) {
        if !self.exited {
            tree::stop(&mut self.child).await;
            self.exited = true;
        }
    }

    /// The end of the helper's stderr, once the pipe closed (or after [`STDERR_DRAIN`]): omp's
    /// own words when it failed before answering.
    pub async fn last_words(&mut self) -> String {
        if let Some(drain) = self.drain.take() {
            let _ = tokio::time::timeout(STDERR_DRAIN, drain).await;
        }
        let t = self.stderr.lock().unwrap_or_else(|p| p.into_inner());
        String::from_utf8_lossy(&t).trim().lines().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" ")
    }

    /// Waits for the `result` (Ok) or `error` (Err) line, stopping the helper at `deadline`.
    /// Events before it go to `on_event`.
    pub async fn finish(&mut self, deadline: Instant, mut on_event: impl FnMut(&Value)) -> Result<Value, ApiError> {
        loop {
            match tokio::time::timeout_at(deadline.into(), self.next()).await {
                Ok(Some(line)) => match line.get("t").and_then(Value::as_str) {
                    Some("result") => return Ok(line),
                    Some("error") => return Err(helper_error(&line)),
                    _ => on_event(&line),
                },
                Ok(None) => {
                    let tail = self.last_words().await;
                    let detail = if tail.is_empty() { String::new() } else { format!(": {}", crate::util::clip(&tail, 300)) };
                    return Err(ApiError::new("omp_error", format!("omp exited without an answer{detail}")));
                }
                Err(_) => {
                    let secs = self.started.elapsed().as_secs();
                    self.stop().await;
                    return Err(ApiError::new("timeout", format!("omp did not answer within {secs}s")).retryable());
                }
            }
        }
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        if !self.exited {
            tree::kill(&mut self.child);
        }
        for p in [&self.req, &self.out, &self.input] {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// The helper's `error` line as an [`ApiError`].
pub fn helper_error(line: &Value) -> ApiError {
    let code = line.get("code").and_then(Value::as_str).unwrap_or("omp_error");
    let msg = line.get("message").and_then(Value::as_str).unwrap_or("failed").to_string();
    match code {
        "unsupported" => ApiError::new("unsupported", msg).with_hint("Update omp on the host (Host setup → Tools)."),
        "not_found" => ApiError::new("not_found", msg),
        "invalid_params" | "refused" => ApiError::new("invalid_params", msg),
        "cancelled" => ApiError::new("cancelled", msg),
        "timeout" => ApiError::new("timeout", msg).retryable(),
        _ => ApiError::new("omp_error", msg),
    }
}

/// `cmd.spawn()`, tried again for a moment on `ETXTBSY`: an executable written just before (an omp
/// update, tests' stand-in) can still be open for writing in a child another thread is forking.
#[cfg(unix)]
async fn spawn(cmd: &mut tokio::process::Command) -> std::io::Result<tokio::process::Child> {
    let mut tries = 0;
    loop {
        match cmd.spawn() {
            Err(e) if e.raw_os_error() == Some(libc::ETXTBSY) && tries < 20 => {
                tries += 1;
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            other => return other,
        }
    }
}

#[cfg(not(unix))]
async fn spawn(cmd: &mut tokio::process::Command) -> std::io::Result<tokio::process::Child> {
    cmd.spawn()
}

/// One request, start to answer, ended at `deadline`.
pub async fn call(env: &HelperEnv, cwd: &Path, req: Value, deadline: Instant) -> Result<Value, ApiError> {
    let mut run = Running::start(env, cwd, req, deadline).await?;
    run.finish(deadline, |_| {}).await
}

/// The helper's process tree (module docs, "Stopping").
#[cfg(unix)]
mod tree {
    use std::time::{Duration, Instant};

    use super::STOP_GRACE;

    /// A process under the helper, with its start time (so a reused pid is never hit).
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Member {
        pub pid: u32,
        pub start: u64,
    }

    /// Stops `child` and what it started: SIGTERM, up to [`STOP_GRACE`] for the helper to exit,
    /// SIGKILL to whatever is left, then reaps the helper.
    pub async fn stop(child: &mut tokio::process::Child) {
        let Some(pid) = child.id() else { return };
        let mut known = members(pid);
        signal(pid, &known, libc::SIGTERM);
        let until = Instant::now() + STOP_GRACE;
        while !exited(pid) && Instant::now() < until {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // And servers started meanwhile (omp may have been reconnecting one).
        for m in members(pid) {
            if !known.contains(&m) {
                known.push(m);
            }
        }
        signal(pid, &known, libc::SIGKILL);
        let _ = child.wait().await;
    }

    /// Kills `child` and what it started at once (a helper dropped while it may still run).
    pub fn kill(child: &mut tokio::process::Child) {
        let Some(pid) = child.id() else { return };
        signal(pid, &members(pid), libc::SIGKILL);
        let _ = child.try_wait();
    }

    /// `sig` to the helper's process group (it and what it started there) and to every member.
    fn signal(leader: u32, members: &[Member], sig: libc::c_int) {
        if let Ok(pgid) = libc::pid_t::try_from(leader) {
            // SAFETY: plain syscall; the helper is not reaped yet, so its group id is still ours.
            unsafe { libc::killpg(pgid, sig) };
        }
        for m in members {
            m.signal(sig);
        }
    }

    /// Whether the helper exited: a zombie not reaped yet (`WNOWAIT`), so its pid — and with it
    /// its process group id — cannot have been reused.
    fn exited(pid: u32) -> bool {
        #[allow(clippy::unnecessary_cast)]
        let id = pid as libc::id_t;
        // SAFETY: a zeroed `siginfo_t` is a valid out-parameter; WNOWAIT leaves the child unreaped.
        unsafe {
            let mut info: libc::siginfo_t = std::mem::zeroed();
            if libc::waitid(libc::P_PID, id, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) != 0 {
                return true; // no such child any more
            }
            #[cfg(any(target_os = "linux", target_os = "android"))]
            let who = info.si_pid();
            #[cfg(not(any(target_os = "linux", target_os = "android")))]
            let who = info.si_pid;
            who != 0
        }
    }

    /// Linux: every process under the helper, subtrees of omp's worker daemons left out.
    #[cfg(target_os = "linux")]
    fn members(leader: u32) -> Vec<Member> {
        under(leader, &table(), omp_worker)
    }

    /// Elsewhere omp starts stdio servers in its own process group: the group signal reaches them.
    #[cfg(not(target_os = "linux"))]
    fn members(_leader: u32) -> Vec<Member> {
        Vec::new()
    }

    impl Member {
        /// `sig` to this process (to its group when it leads one: a server started in a session of
        /// its own, with whatever it started), unless it is gone and its pid was reused.
        #[cfg(target_os = "linux")]
        fn signal(&self, sig: libc::c_int) {
            let Some((_, pgrp, start)) = stat(self.pid) else { return };
            let Ok(pid) = libc::pid_t::try_from(self.pid) else { return };
            if start != self.start {
                return;
            }
            // SAFETY: plain syscalls on the process just checked to be this member.
            unsafe {
                if pgrp == self.pid {
                    libc::killpg(pid, sig);
                } else {
                    libc::kill(pid, sig);
                }
            }
        }

        #[cfg(not(target_os = "linux"))]
        fn signal(&self, _sig: libc::c_int) {}
    }

    /// `(pid, ppid, start time)` of every process in `/proc`.
    #[cfg(target_os = "linux")]
    fn table() -> Vec<(u32, u32, u64)> {
        let Ok(dir) = std::fs::read_dir("/proc") else { return Vec::new() };
        dir.filter_map(|e| {
            let pid: u32 = e.ok()?.file_name().to_str()?.parse().ok()?;
            let (ppid, _, start) = stat(pid)?;
            Some((pid, ppid, start))
        })
        .collect()
    }

    #[cfg(target_os = "linux")]
    fn stat(pid: u32) -> Option<(u32, u32, u64)> {
        stat_fields(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)
    }

    /// `(ppid, pgrp, start time)` of a `/proc/<pid>/stat` line (`pid (comm) state ppid pgrp …`,
    /// the start time 20th after the state). Fields are counted from the last `)`: comm may hold
    /// spaces and parentheses.
    #[cfg(target_os = "linux")]
    pub fn stat_fields(stat: &str) -> Option<(u32, u32, u64)> {
        let f: Vec<&str> = stat.get(stat.rfind(')')? + 1..)?.split_whitespace().collect();
        Some((f.get(1)?.parse().ok()?, f.get(2)?.parse().ok()?, f.get(19)?.parse().ok()?))
    }

    /// Every process under `leader` in `procs` (`(pid, ppid, start)`), leaving out the subtrees of
    /// processes `skip` picks.
    #[cfg(target_os = "linux")]
    pub fn under(leader: u32, procs: &[(u32, u32, u64)], skip: impl Fn(u32) -> bool) -> Vec<Member> {
        let mut out: Vec<Member> = Vec::new();
        let mut parents = vec![leader];
        while let Some(parent) = parents.pop() {
            for &(pid, ppid, start) in procs {
                if ppid == parent && pid != parent && pid != leader && !out.iter().any(|m| m.pid == pid) && !skip(pid) {
                    out.push(Member { pid, start });
                    parents.push(pid);
                }
            }
        }
        out
    }

    /// omp's worker daemons name themselves in their argv (`__omp_worker_<kind>`).
    #[cfg(target_os = "linux")]
    fn omp_worker(pid: u32) -> bool {
        std::fs::read(format!("/proc/{pid}/cmdline")).is_ok_and(|raw| raw.split(|&b| b == 0).any(|a| a.starts_with(b"__omp_worker_")))
    }
}

/// The helper's process tree: `taskkill /T` (Windows has no SIGTERM to offer first).
#[cfg(windows)]
mod tree {
    pub async fn stop(child: &mut tokio::process::Child) {
        kill(child);
        let _ = child.wait().await;
    }

    pub fn kill(child: &mut tokio::process::Child) {
        if let Some(pid) = child.id() {
            drop(crate::ops::tools::TreeGuard(Some(pid)));
        }
        let _ = child.start_kill();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// A stand-in omp (a shell script) that follows the helper protocol.
    fn fake_omp(dir: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let p = dir.join("omp");
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    fn env(dir: &Path, omp: PathBuf) -> HelperEnv {
        HelperEnv { omp: Some(omp), ext_dir: dir.join("ext"), run_dir: dir.join("run"), agent_dir: None, slots: Slots::new(MAX_RUNNING, MAX_SIGN_INS) }
    }

    fn soon() -> Instant {
        Instant::now() + Duration::from_secs(30)
    }

    /// Alive: listed and not a zombie.
    #[cfg(target_os = "linux")]
    fn alive(pid: u32) -> bool {
        std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|s| s.rsplit(')').next().is_some_and(|r| !r.trim_start().starts_with('Z')))
    }

    #[cfg(target_os = "linux")]
    async fn pid_in(file: &Path) -> u32 {
        for _ in 0..250 {
            if let Some(pid) = std::fs::read_to_string(file).ok().and_then(|s| s.trim().parse().ok()) {
                return pid;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("{} never written", file.display());
    }

    #[tokio::test]
    async fn request_travels_in_a_private_file_and_events_come_before_the_result() {
        let td = tempfile::tempdir().unwrap();
        let omp = fake_omp(
            td.path(),
            r#"stat -c %a "$TF_MCP_IN" > "$TF_MCP_OUT.mode"; cp "$TF_MCP_IN" "$TF_MCP_OUT.req"; rm -f "$TF_MCP_IN"
echo "$OMP_MCP_STARTUP_TIMEOUT_MS" > "$TF_MCP_OUT.window"
case "$*" in *--no-extensions*-e*teleflock-mcp.ts*) ;; *) exit 9;; esac
printf '{"t":"hello","ompVersion":"18.13.2"}\n{"t":"progress","message":"half' >> "$TF_MCP_OUT"; sleep 0.3
printf 'way"}\n{"t":"result","ok":true}\n' >> "$TF_MCP_OUT""#,
        );
        let e = env(td.path(), omp);
        let before = crate::util::now_ms();
        let mut run = Running::start(&e, td.path(), serde_json::json!({"op": "test", "config": {"env": {"API_KEY": "sk-secret"}}}), soon()).await.unwrap();
        let out = run.out.clone();
        let mut events = Vec::new();
        let res = run.finish(soon(), |l| events.push(l.clone())).await.unwrap();
        assert_eq!(res["ok"], true);
        assert_eq!(events.iter().filter_map(|l| l["message"].as_str()).collect::<Vec<_>>(), ["halfway"], "a line split across writes is read whole");
        assert_eq!(std::fs::read_to_string(format!("{}.mode", out.display())).unwrap().trim(), "600");
        let req: Value = serde_json::from_str(&std::fs::read_to_string(format!("{}.req", out.display())).unwrap()).unwrap();
        assert_eq!((req["v"].as_u64(), req["op"].as_str()), (Some(1), Some("test")));
        let due = req["deadlineAt"].as_i64().unwrap();
        assert!(due > before + 25_000 && due < before + 30_000, "the deadline less the answer margin, on the wall clock: {due} vs {before}");
        assert_eq!(std::fs::read_to_string(format!("{}.window", out.display())).unwrap().trim(), "1", "omp's discovery returns at once");
        assert_eq!(std::fs::read_to_string(e.ext_dir.join(FILE_NAME)).unwrap(), SOURCE, "helper written next to the bridge");
        drop(run);
        assert!(!out.exists(), "answer file removed");
    }

    #[tokio::test]
    async fn errors_exits_and_timeouts_are_reported() {
        let td = tempfile::tempdir().unwrap();
        let e = env(td.path(), fake_omp(td.path(), r#"printf '{"t":"error","code":"unsupported","message":"omp 18.0.0 lacks mcp/manager"}\n' >> "$TF_MCP_OUT""#));
        let err = call(&e, td.path(), serde_json::json!({"op": "probe"}), soon()).await.unwrap_err();
        assert_eq!(err.code, "unsupported");
        assert!(err.hint.is_some());

        // Its last words come through even when it exits before its stderr was read.
        let e = env(td.path(), fake_omp(td.path(), "echo 'No default model selected.' >&2; exit 1"));
        for _ in 0..5 {
            let err = call(&e, td.path(), serde_json::json!({"op": "probe"}), soon()).await.unwrap_err();
            assert_eq!(err.code, "omp_error");
            assert!(err.message.contains("No default model selected"), "{}", err.message);
        }

        let e = env(td.path(), fake_omp(td.path(), "sleep 30"));
        let started = Instant::now();
        let err = call(&e, td.path(), serde_json::json!({"op": "probe"}), Instant::now() + Duration::from_millis(500)).await.unwrap_err();
        assert_eq!(err.code, "timeout");
        assert!(started.elapsed() < Duration::from_secs(5), "stopped, not waited for: {:?}", started.elapsed());
    }

    #[tokio::test]
    async fn pasted_input_reaches_the_helper() {
        let td = tempfile::tempdir().unwrap();
        let e = env(
            td.path(),
            fake_omp(
                td.path(),
                r#"printf '{"t":"auth","url":"https://idp/authorize"}\n' >> "$TF_MCP_OUT"
while [ ! -f "$TF_MCP_INPUT" ]; do sleep 0.05; done
v=$(cat "$TF_MCP_INPUT"); rm -f "$TF_MCP_INPUT"
printf '{"t":"result","got":"%s"}\n' "$v" >> "$TF_MCP_OUT""#,
            ),
        );
        let mut run = Running::start(&e, td.path(), serde_json::json!({"op": "auth"}), soon()).await.unwrap();
        let first = run.next().await.unwrap();
        assert_eq!(first["t"], "auth");
        run.send_input("http://localhost:3000/callback?code=c&state=s").unwrap();
        let res = run.finish(soon(), |_| {}).await.unwrap();
        assert_eq!(res["got"], "http://localhost:3000/callback?code=c&state=s");
    }

    /// omp on Linux starts stdio servers in sessions of their own: killing omp alone would leave
    /// them running (the stand-in's server even ignores SIGTERM, like one stuck in a long start).
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_helper_that_overruns_is_stopped_with_the_servers_it_started() {
        let td = tempfile::tempdir().unwrap();
        let e = env(
            td.path(),
            fake_omp(
                td.path(),
                r#"setsid sh -c 'trap "" TERM; echo $$ > "$TF_MCP_OUT.server"; exec sleep 300' &
setsid sh -c 'echo $$ > "$TF_MCP_OUT.worker"; sleep 300' __omp_worker_test &
trap '' TERM
sleep 30"#,
            ),
        );
        let mut run = Running::start(&e, td.path(), serde_json::json!({"op": "test"}), soon()).await.unwrap();
        let out = run.out.clone();
        let server = pid_in(Path::new(&format!("{}.server", out.display()))).await;
        let worker = pid_in(Path::new(&format!("{}.worker", out.display()))).await;
        let helper = run.child.id().unwrap();
        let started = Instant::now();
        let err = run.finish(Instant::now() + Duration::from_millis(200), |_| {}).await.unwrap_err();
        assert_eq!(err.code, "timeout");
        assert!(started.elapsed() < Duration::from_secs(4), "SIGTERM, a second of grace, SIGKILL: {:?}", started.elapsed());
        let mut gone = false;
        for _ in 0..100 {
            if !alive(server) && !alive(helper) {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let worker_alive = alive(worker);
        // SAFETY: cleanup of the stand-in worker's own session (it leads its process group).
        unsafe { libc::killpg(worker as libc::pid_t, libc::SIGKILL) };
        assert!(gone, "the helper and its detached server are gone");
        assert!(worker_alive, "omp's worker daemons are left alone");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn proc_tree_parsing() {
        assert_eq!(tree::stat_fields("4242 (we ird) name) S 1 4242 4242 0 -1 4194560 1 0 0 0 3 2 0 0 20 0 1 0 987654 0 0"), Some((1, 4242, 987654)));
        assert_eq!(tree::stat_fields("7 (x) S 1 7"), None);
        // leader 10 → 11 → 12, 10 → 13 (a worker) → 14; 20 is unrelated.
        let procs = [(10, 1, 0), (11, 10, 5), (12, 11, 6), (13, 10, 7), (14, 13, 8), (20, 1, 9)];
        let pids: Vec<u32> = tree::under(10, &procs, |pid| pid == 13).iter().map(|m| m.pid).collect();
        assert_eq!(pids, [11, 12]);
    }

    #[tokio::test]
    async fn slot_waits_end_before_the_deadline_and_sign_ins_have_their_own() {
        let td = tempfile::tempdir().unwrap();
        let mut e = env(td.path(), fake_omp(td.path(), "sleep 10"));
        e.slots = Slots::new(1, 1);
        let held = Running::start(&e, td.path(), serde_json::json!({"op": "probe"}), soon()).await.unwrap();
        let started = Instant::now();
        let err = Running::start(&e, td.path(), serde_json::json!({"op": "test"}), Instant::now() + MIN_RUN + Duration::from_millis(300)).await.err().unwrap();
        assert_eq!(err.code, "busy");
        assert!(started.elapsed() < Duration::from_secs(2), "gave up while time was left to run omp: {:?}", started.elapsed());
        // A sign-in waiting for the user doesn't take a check's slot, nor the other way round.
        let sign_in = Running::start(&e, td.path(), serde_json::json!({"op": "auth"}), soon()).await.unwrap();
        drop(held);
        let next = Running::start(&e, td.path(), serde_json::json!({"op": "test"}), Instant::now() + MIN_RUN + Duration::from_millis(300)).await;
        assert!(next.is_ok(), "the freed slot is taken at once");
        drop(sign_in);
    }
}
