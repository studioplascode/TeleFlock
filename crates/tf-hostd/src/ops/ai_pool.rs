//! Warm omp workers for `ai.complete`: most of a call's wall time is omp starting up (≈ 1–2.5 s of
//! module loading, settings, auth and model resolution, against a model answering in 0.2–0.9 s).
//!
//! A worker is one `omp --mode rpc` with the call's role and system prompt, started ahead of the
//! call and kept while that (role, system prompt, cwd) is in demand. omp reads a piped prompt
//! (`--mode json`) before it initializes, so only RPC mode can finish its startup first. Every
//! call starts a fresh context (`new_session` after each call, in the background), so a worker
//! never sees a former call's text.
//!
//! - [`Pool::acquire`] hands out the idle worker for a key, waits for one that is starting, or
//!   else starts one for the caller.
//! - A worker is only *kept* after a call (an idle omp holds ≈ 200 MB) for a key that was
//!   prewarmed or called before within [`Limits::idle_ttl`]: a one-off call's worker ends with it.
//!   A kept worker goes back ([`Lease::release`]); one that was cut short (the caller timed out or
//!   was cancelled) is killed and, while the key is kept, started again.
//! - [`Pool::ensure_warm`] (`ai.prewarm`) starts a worker without a call and marks the key wanted.
//! - At most [`Limits::warm`] workers are idle or starting; the least recently used idle one makes
//!   room. Idle ones are reaped after [`Limits::idle_ttl`], and a worker is retired after
//!   [`Limits::max_uses`] calls.
//!
//! A worker that cannot be used (exit, protocol error, rejected prompt) is [`Failure::Broken`]: the
//! caller runs a fresh `--mode json` omp instead, which also produces the authoritative error text.
//! Prompt and system text go only to omp, never to logs.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::ai::{unresolved_role, Answer, Stream};

/// Idle plus starting workers per daemon (an idle omp holds ≈ 200 MB).
const WARM_MAX: usize = 2;
/// An idle worker is killed after this long without a call or prewarm.
const IDLE_TTL: Duration = Duration::from_secs(120);
/// A worker is replaced after this many calls.
const MAX_USES: u32 = 40;
/// A worker started in the background gets this long to become ready.
const STARTUP_LIMIT: Duration = Duration::from_secs(30);
/// Clearing a used worker's context gets this long.
const RESET_LIMIT: Duration = Duration::from_secs(10);
/// Longer prompts skip the pool (omp's RPC frames are capped at 1 MiB).
pub(crate) const MAX_PROMPT_BYTES: usize = 256 * 1024;
const STDERR_CAP: usize = 16 * 1024;

#[derive(Debug, Clone, Copy)]
pub(crate) struct Limits {
    pub warm: usize,
    pub idle_ttl: Duration,
    pub max_uses: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { warm: WARM_MAX, idle_ttl: IDLE_TTL, max_uses: MAX_USES }
    }
}

/// What a worker is configured with: calls with the same key can share one.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct Key {
    pub role: String,
    /// The one-line system prompt (as given to `--system-prompt`).
    pub system: String,
    pub cwd: PathBuf,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Failure {
    /// The omp binary could not be spawned (not found).
    Missing,
    /// omp does not know the role.
    Unresolved,
    TimedOut,
    /// omp answered with an error or nothing (message: omp's own words).
    Model(String),
    /// The worker is unusable; run a fresh `--mode json` omp.
    Broken,
}

// ───────────────────────────── one worker ─────────────────────────────

struct Worker {
    role: String,
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    stderr: Option<JoinHandle<String>>,
    next_id: u64,
    uses: u32,
    /// A prompt ran since the last `new_session`: its messages are still in the context.
    dirty: bool,
}

impl Worker {
    /// Starts omp and asks for its state: the answer arrives once omp is initialized.
    async fn spawn(bin: &Path, key: &Key) -> Result<Worker, Failure> {
        let model = format!("@{}", key.role);
        let mut cmd = tokio::process::Command::new(bin);
        cmd.args([
            "--mode", "rpc", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-title",
            "--model", &model, "--system-prompt", &key.system,
        ])
        .current_dir(&key.cwd)
        .env("NO_COLOR", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
        #[cfg(windows)]
        {
            // CREATE_NO_WINDOW: never flash a console window from the background daemon.
            cmd.creation_flags(0x0800_0000);
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(Failure::Missing),
            Err(_) => return Err(Failure::Broken),
        };
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else { return Err(Failure::Broken) };
        let stderr = child.stderr.take().map(|mut err| {
            tokio::spawn(async move {
                let mut kept = Vec::new();
                let mut buf = [0u8; 4096];
                while let Ok(n) = err.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    kept.extend_from_slice(&buf[..n]);
                    if kept.len() > STDERR_CAP {
                        kept.drain(..kept.len() - STDERR_CAP);
                    }
                }
                String::from_utf8_lossy(&kept).into_owned()
            })
        });
        let mut w = Worker { role: key.role.clone(), child, stdin, lines: BufReader::new(stdout).lines(), stderr, next_id: 0, uses: 0, dirty: false };
        let id = w.id();
        // An omp that already exited (unknown role) breaks the pipe: `ready` reads why from its stderr.
        let _ = w.send(json!({ "id": id, "type": "get_state" })).await;
        Ok(w)
    }

    fn id(&mut self) -> String {
        self.next_id += 1;
        format!("tf-{}", self.next_id)
    }

    async fn send(&mut self, cmd: Value) -> Result<(), Failure> {
        let mut line = cmd.to_string();
        line.push('\n');
        match self.stdin.write_all(line.as_bytes()).await {
            Ok(()) => self.stdin.flush().await.map_err(|_| Failure::Broken),
            Err(_) => Err(Failure::Broken),
        }
    }

    /// The next stdout line (parsed when it is JSON); `None` at the end of the stream.
    async fn line(&mut self, deadline: Instant) -> Result<Option<(String, Option<Value>)>, Failure> {
        match tokio::time::timeout_at(deadline, self.lines.next_line()).await {
            Err(_) => Err(Failure::TimedOut),
            Ok(Ok(Some(l))) => {
                let v = l.trim_start().starts_with('{').then(|| serde_json::from_str::<Value>(&l).ok()).flatten();
                Ok(Some((l, v)))
            }
            Ok(Ok(None)) | Ok(Err(_)) => Ok(None),
        }
    }

    /// Waits for the state answer sent by [`Worker::spawn`]. omp that exits first is judged by its stderr.
    async fn ready(&mut self, deadline: Instant) -> Result<(), Failure> {
        loop {
            match self.line(deadline).await? {
                Some((_, Some(v))) if is_response(&v, "tf-1") => return if success(&v) { Ok(()) } else { Err(Failure::Broken) },
                Some(_) => {}
                None => return Err(self.exited().await),
            }
        }
    }

    async fn exited(&mut self) -> Failure {
        let _ = tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await;
        let err = match self.stderr.take() {
            Some(h) => tokio::time::timeout(Duration::from_millis(500), h).await.ok().and_then(Result::ok).unwrap_or_default(),
            None => String::new(),
        };
        if unresolved_role(&err, &self.role) {
            Failure::Unresolved
        } else {
            Failure::Broken
        }
    }

    /// Whether the process still runs.
    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// A fresh context: omp forgets the messages of the former call.
    async fn reset(&mut self, deadline: Instant) -> Result<(), Failure> {
        let id = self.id();
        self.send(json!({ "id": id, "type": "new_session" })).await?;
        loop {
            match self.line(deadline).await? {
                Some((_, Some(v))) if is_response(&v, &id) => {
                    let cancelled = v.pointer("/data/cancelled").and_then(Value::as_bool).unwrap_or(false);
                    return if success(&v) && !cancelled {
                        self.dirty = false;
                        Ok(())
                    } else {
                        Err(Failure::Broken)
                    };
                }
                Some(_) => {}
                None => return Err(Failure::Broken),
            }
        }
    }

    /// One prompt in a fresh context; the answer is the final assistant text (`agent_end`).
    async fn ask(&mut self, prompt: &str, deadline: Instant) -> Result<Answer, Failure> {
        if self.dirty {
            self.reset(deadline).await?;
        }
        self.uses += 1;
        self.dirty = true;
        let id = self.id();
        self.send(json!({ "id": id, "type": "prompt", "message": prompt })).await?;
        let mut stream = Stream::default();
        loop {
            let Some((line, parsed)) = self.line(deadline).await? else { return Err(Failure::Broken) };
            if let Some(v) = &parsed {
                // omp refused the prompt itself (no credential, busy, oversized): a fresh run tells why.
                if is_response(v, &id) && !success(v) {
                    return Err(Failure::Broken);
                }
                if v.get("type").and_then(Value::as_str) == Some("prompt_result") && v.get("id").and_then(Value::as_str) == Some(&id) && v.get("status").and_then(Value::as_str) != Some("completed") {
                    return Err(Failure::Broken);
                }
            }
            if let Some(done) = stream.feed(&line) {
                return done.map_err(Failure::Model);
            }
        }
    }
}

fn is_response(v: &Value, id: &str) -> bool {
    v.get("type").and_then(Value::as_str) == Some("response") && v.get("id").and_then(Value::as_str) == Some(id)
}

fn success(v: &Value) -> bool {
    v.get("success").and_then(Value::as_bool) == Some(true)
}

// ───────────────────────────── the pool ─────────────────────────────

struct Idle {
    key: Key,
    worker: Worker,
    since: Instant,
}

struct Starting {
    id: u64,
    key: Key,
    done: watch::Receiver<Option<Result<(), Failure>>>,
}

#[derive(Default)]
struct State {
    idle: Vec<Idle>,
    starting: Vec<Starting>,
    /// When a call or prewarm last wanted a key: a worker is only kept for a key wanted again within the idle window.
    demand: HashMap<Key, Instant>,
    reaper: bool,
    next: u64,
}

impl State {
    /// Makes room for one more idle or starting worker: the least recently used idle one goes.
    fn make_room(&mut self, warm: usize) -> bool {
        while self.idle.len() + self.starting.len() >= warm {
            let Some(oldest) = self.idle.iter().enumerate().min_by_key(|(_, e)| e.since).map(|(i, _)| i) else { return false };
            tracing::debug!(role = %self.idle[oldest].key.role, "ai worker evicted");
            self.idle.remove(oldest);
        }
        true
    }
}

/// What [`Pool::ensure_warm`] found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Warmth {
    /// A worker is idle.
    Ready,
    /// One is starting (now or already).
    Starting,
    /// All warm slots are taken by workers still starting.
    Full,
}

struct Shared {
    limits: Limits,
    state: Mutex<State>,
}

#[derive(Clone)]
pub(crate) struct Pool(Arc<Shared>);

impl Pool {
    pub(crate) fn new(limits: Limits) -> Pool {
        Pool(Arc::new(Shared { limits, state: Mutex::new(State::default()) }))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Records that `key` is wanted now; whether it already was within the idle window.
    fn want(&self, st: &mut State, key: &Key) -> bool {
        let now = Instant::now();
        let ttl = self.0.limits.idle_ttl;
        st.demand.retain(|_, at| now.duration_since(*at) < ttl);
        st.demand.insert(key.clone(), now).is_some()
    }

    /// A worker for `key`: idle, else the one starting, else one started here. A worker started here
    /// stays afterwards only if the key was wanted before (prewarmed or called) within the idle window.
    pub(crate) async fn acquire(&self, bin: &Path, key: &Key, deadline: Instant) -> Result<Lease, Failure> {
        let mut repeat = false;
        loop {
            let waiting = {
                let mut st = self.lock();
                let mut taken = None;
                while let Some(i) = st.idle.iter().position(|e| &e.key == key) {
                    let mut e = st.idle.remove(i);
                    if e.worker.alive() {
                        taken = Some(e.worker);
                        break;
                    }
                }
                if let Some(worker) = taken {
                    self.want(&mut st, key);
                    drop(st);
                    tracing::debug!(role = %key.role, "ai worker reused");
                    return Ok(self.lease(worker, bin, key, true, true));
                }
                let starting = st.starting.iter().find(|s| &s.key == key).map(|s| s.done.clone());
                if starting.is_none() {
                    repeat = self.want(&mut st, key);
                }
                starting
            };
            let Some(mut rx) = waiting else { break };
            match tokio::time::timeout_at(deadline, rx.wait_for(Option::is_some)).await {
                Err(_) => return Err(Failure::TimedOut),
                Ok(Err(_)) => return Err(Failure::Broken),
                Ok(Ok(done)) => {
                    // A role omp lacks or no omp at all is the answer; any other failure of the worker we waited for
                    // leaves nothing starting, so the next round starts one here.
                    if let Some(Err(f @ (Failure::Missing | Failure::Unresolved))) = &*done {
                        return Err(f.clone());
                    }
                }
            }
        }
        tracing::debug!(role = %key.role, repeat, "ai worker started for a call");
        let mut worker = Worker::spawn(bin, key).await?;
        worker.ready(deadline).await?;
        Ok(self.lease(worker, bin, key, false, repeat))
    }

    fn lease(&self, worker: Worker, bin: &Path, key: &Key, warm: bool, keep: bool) -> Lease {
        Lease { worker: Some(worker), pool: self.clone(), bin: bin.to_path_buf(), key: key.clone(), refill: keep, keep, warm }
    }

    /// Starts a worker for `key` unless one is idle or starting (an idle one counts as demand again).
    pub(crate) fn ensure_warm(&self, bin: &Path, key: &Key) -> Warmth {
        let (id, tx) = {
            let mut st = self.lock();
            self.want(&mut st, key);
            if let Some(e) = st.idle.iter_mut().find(|e| &e.key == key) {
                e.since = Instant::now();
                return Warmth::Ready;
            }
            if st.starting.iter().any(|s| &s.key == key) {
                return Warmth::Starting;
            }
            match self.register(&mut st, key) {
                Some(slot) => slot,
                None => return Warmth::Full,
            }
        };
        let (bin, key2) = (bin.to_path_buf(), key.clone());
        self.run_start(id, tx, key.clone(), async move {
            let mut w = Worker::spawn(&bin, &key2).await?;
            w.ready(Instant::now() + STARTUP_LIMIT).await?;
            Ok(w)
        });
        Warmth::Starting
    }

    /// Reserves a warm slot for a worker that will be idle shortly (a new one, or one being reset).
    fn register(&self, st: &mut State, key: &Key) -> Option<(u64, watch::Sender<Option<Result<(), Failure>>>)> {
        if !st.make_room(self.0.limits.warm) {
            return None;
        }
        let handle = tokio::runtime::Handle::try_current().ok()?;
        let (tx, rx) = watch::channel(None);
        st.next += 1;
        let id = st.next;
        st.starting.push(Starting { id, key: key.clone(), done: rx });
        self.ensure_reaper(st, &handle);
        Some((id, tx))
    }

    /// Runs `ready` for the slot `id`; its worker becomes the idle one for `key` and callers waiting on it go on.
    fn run_start(&self, id: u64, tx: watch::Sender<Option<Result<(), Failure>>>, key: Key, ready: impl Future<Output = Result<Worker, Failure>> + Send + 'static) {
        let pool = self.clone();
        tokio::spawn(async move {
            let started = ready.await;
            let outcome = {
                let mut st = pool.lock();
                st.starting.retain(|s| s.id != id);
                match started {
                    Ok(worker) => {
                        // A call that found none started its own: one idle per key.
                        if !st.idle.iter().any(|e| e.key == key) {
                            st.idle.push(Idle { key, worker, since: Instant::now() });
                        }
                        Ok(())
                    }
                    Err(f) => Err(f),
                }
            };
            let _ = tx.send(Some(outcome));
        });
    }

    /// Takes a worker back after a successful call. Its context is cleared now, in the background (omp
    /// takes ~0.2 s to start a session with a real system prompt), so the next call finds it ready.
    fn put_back(&self, bin: &Path, key: &Key, mut worker: Worker) {
        if worker.uses >= self.0.limits.max_uses {
            // Retired: the worker goes (killed on drop) and a new one starts.
            drop(worker);
            self.ensure_warm(bin, key);
            return;
        }
        let slot = {
            let mut st = self.lock();
            if st.idle.iter().any(|e| &e.key == key) {
                return;
            }
            self.register(&mut st, key)
        };
        let Some((id, tx)) = slot else { return };
        self.run_start(id, tx, key.clone(), async move {
            worker.reset(Instant::now() + RESET_LIMIT).await?;
            Ok(worker)
        });
    }

    /// Kills idle workers that waited longer than the TTL; stops when nothing is left to watch.
    fn ensure_reaper(&self, st: &mut State, handle: &tokio::runtime::Handle) {
        if st.reaper {
            return;
        }
        st.reaper = true;
        let pool = self.clone();
        let ttl = self.0.limits.idle_ttl;
        let tick = (ttl / 4).clamp(Duration::from_millis(10), Duration::from_secs(5));
        handle.spawn(async move {
            loop {
                tokio::time::sleep(tick).await;
                let mut st = pool.lock();
                let now = Instant::now();
                st.idle.retain(|e| {
                    let keep = now.duration_since(e.since) < ttl;
                    if !keep {
                        tracing::debug!(role = %e.key.role, "ai worker reaped");
                    }
                    keep
                });
                if st.idle.is_empty() && st.starting.is_empty() {
                    st.reaper = false;
                    return;
                }
            }
        });
    }

    /// (idle, starting) workers.
    #[cfg(test)]
    pub(crate) fn counts(&self) -> (usize, usize) {
        let st = self.lock();
        (st.idle.len(), st.starting.len())
    }
}

/// A worker on loan for one call. Dropped without [`Lease::release`] it is killed; while the key is
/// in demand (the call timed out or was cancelled) a replacement starts.
pub(crate) struct Lease {
    worker: Option<Worker>,
    pool: Pool,
    bin: PathBuf,
    key: Key,
    refill: bool,
    /// The worker stays in the pool after the call (the key was prewarmed or called before within the window).
    keep: bool,
    /// Taken from the pool, not started for this call (read by the tests).
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) warm: bool,
}

impl Lease {
    /// One prompt in a fresh context. A worker that failed is not given back.
    pub(crate) async fn ask(&mut self, prompt: &str, deadline: Instant) -> Result<Answer, Failure> {
        let worker = self.worker.as_mut().ok_or(Failure::Broken)?;
        let res = worker.ask(prompt, deadline).await;
        // Only an unfinished call keeps its key in demand; a broken or refusing worker must not respawn in a loop.
        self.refill = self.keep && matches!(res, Err(Failure::TimedOut));
        res
    }

    /// The call succeeded: a kept worker waits for the next one, any other ends with the call.
    pub(crate) fn release(mut self) {
        self.refill = false;
        if let Some(worker) = self.worker.take() {
            if self.keep {
                self.pool.put_back(&self.bin, &self.key, worker);
            }
        }
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        // `ask` not finished (cancelled) counts as in demand too: `refill` starts as `keep`.
        if self.worker.take().is_some() && self.refill {
            self.pool.ensure_warm(&self.bin, &self.key);
        }
    }
}

/// A stand-in omp (a shell script) speaking just enough of `--mode rpc`, shared with `ai.rs` tests.
#[cfg(all(test, unix))]
pub(crate) mod fake {
    use std::path::{Path, PathBuf};

    /// `startup` runs before the script reads its first command (argument `$2` is the mode); `on_prompt`
    /// runs after a prompt was logged and before it is answered (`$msg` is the prompt text). The
    /// script logs one line per spawn (its pid) to `spawns` and every prompt / reset to `events`.
    /// `delay` (a file holding seconds) makes it answer later.
    pub(crate) fn omp(dir: &Path, startup: &str, on_prompt: &str) -> PathBuf {
        let bin = dir.join("omp");
        let body = format!(
            r#"#!/bin/sh
D={dir}
echo "$$" >> "$D/spawns"
{startup}
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
  case "$line" in
    *'"get_state"'*) printf '{{"type":"response","id":"%s","command":"get_state","success":true}}\n' "$id" ;;
    *'"new_session"'*) echo reset >> "$D/events"; printf '{{"type":"response","id":"%s","command":"new_session","success":true,"data":{{"cancelled":false}}}}\n' "$id" ;;
    *'"prompt"'*)
      msg=$(printf '%s' "$line" | sed -n 's/.*"message":"\([^"]*\)".*/\1/p')
      echo "prompt $msg" >> "$D/events"
      {on_prompt}
      printf '{{"type":"response","id":"%s","command":"prompt","success":true}}\n' "$id"
      [ -f "$D/delay" ] && sleep "$(cat "$D/delay")"
      printf '{{"type":"agent_end","messages":[{{"role":"assistant","content":[{{"type":"text","text":"echo: %s"}}],"provider":"mock","model":"m"}}]}}\n' "$msg"
      printf '{{"type":"prompt_result","id":"%s","status":"completed"}}\n' "$id" ;;
  esac
done
"#,
            dir = dir.display()
        );
        crate::test_exe::write_exe(&bin, body);
        bin
    }

    /// Pids of the processes started so far.
    pub(crate) fn spawns(dir: &Path) -> Vec<u32> {
        std::fs::read_to_string(dir.join("spawns")).unwrap_or_default().lines().filter_map(|l| l.trim().parse().ok()).collect()
    }

    /// Prompts and resets in the order omp saw them.
    pub(crate) fn events(dir: &Path) -> Vec<String> {
        std::fs::read_to_string(dir.join("events")).unwrap_or_default().lines().map(str::to_string).collect()
    }

    pub(crate) fn alive(pid: u32) -> bool {
        // SAFETY: signal 0 only checks that the process exists.
        unsafe { libc::kill(pid as i32, 0) == 0 && !std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|s| s.contains(") Z")) }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::fake;
    use super::*;

    fn key(role: &str) -> Key {
        Key { role: role.into(), system: "Rewrite".into(), cwd: std::env::temp_dir() }
    }

    fn limits(warm: usize, idle_ttl_ms: u64, max_uses: u32) -> Limits {
        Limits { warm, idle_ttl: Duration::from_millis(idle_ttl_ms), max_uses }
    }

    fn soon() -> Instant {
        Instant::now() + Duration::from_secs(10)
    }

    async fn until(what: &str, mut cond: impl FnMut() -> bool) {
        for _ in 0..400 {
            if cond() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("timed out waiting for {what}");
    }

    async fn call(pool: &Pool, bin: &Path, key: &Key, prompt: &str) -> (Answer, bool) {
        let mut lease = pool.acquire(bin, key, soon()).await.expect("worker");
        let warm = lease.warm;
        let answer = lease.ask(prompt, soon()).await.expect("answer");
        lease.release();
        (answer, warm)
    }

    #[tokio::test]
    async fn a_one_off_call_leaves_no_worker_and_a_second_one_starts_keeping_one() {
        let td = tempfile::tempdir().unwrap();
        let bin = fake::omp(td.path(), "", "");
        let pool = Pool::new(limits(2, 60_000, 40));
        let (a, warm_a) = call(&pool, &bin, &key("tiny"), "one").await;
        assert_eq!((a.text.as_str(), warm_a), ("echo: one", false));
        assert_eq!(a.model.as_deref(), Some("mock/m"));
        let first = fake::spawns(td.path())[0];
        assert_eq!(pool.counts(), (0, 0), "nothing is kept for a one-off");
        until("the one-off's process to end", || !fake::alive(first)).await;
        // Called again within the window: still started for the call, but kept afterwards.
        let (b, warm_b) = call(&pool, &bin, &key("tiny"), "two").await;
        assert_eq!((b.text.as_str(), warm_b), ("echo: two", false));
        // The third call finds it, its context cleared right after the second (never before the first).
        let (c, warm_c) = call(&pool, &bin, &key("tiny"), "three").await;
        assert_eq!((c.text.as_str(), warm_c), ("echo: three", true));
        assert_eq!(fake::spawns(td.path()).len(), 2, "one for the one-off, one kept for the other two");
        assert_eq!(fake::events(td.path())[..4], ["prompt one", "prompt two", "reset", "prompt three"]);
        // Another key is a one-off of its own.
        let (_, warm) = call(&pool, &bin, &key("smol"), "x").await;
        assert!(!warm);
        until("the third call's reset", || pool.counts() == (1, 0)).await;
    }

    #[tokio::test]
    async fn a_prewarmed_worker_is_what_the_first_call_uses() {
        let td = tempfile::tempdir().unwrap();
        // Startup takes a while: the call waits for the worker already starting instead of starting another.
        let bin = fake::omp(td.path(), "sleep 0.4", "");
        let pool = Pool::new(limits(3, 60_000, 40));
        assert_eq!(pool.ensure_warm(&bin, &key("tiny")), Warmth::Starting);
        assert_eq!(pool.ensure_warm(&bin, &key("tiny")), Warmth::Starting, "asking again starts nothing");
        let t = std::time::Instant::now();
        let (a, warm) = call(&pool, &bin, &key("tiny"), "first").await;
        assert!(warm && a.text == "echo: first");
        assert!(t.elapsed() >= Duration::from_millis(300), "it waited for the startup");
        assert_eq!(fake::spawns(td.path()).len(), 1);
        until("the worker to be ready again", || pool.counts() == (1, 0)).await;
        assert_eq!(pool.ensure_warm(&bin, &key("tiny")), Warmth::Ready);
        // Ready: the next call needs no startup at all.
        let t = std::time::Instant::now();
        call(&pool, &bin, &key("tiny"), "second").await;
        assert!(t.elapsed() < Duration::from_millis(300));
        assert_eq!(fake::spawns(td.path()).len(), 1);
    }

    #[tokio::test]
    async fn idle_workers_are_reaped_and_their_processes_end() {
        let td = tempfile::tempdir().unwrap();
        let bin = fake::omp(td.path(), "", "");
        let pool = Pool::new(limits(3, 600, 40));
        pool.ensure_warm(&bin, &key("tiny"));
        until("the worker to be ready", || pool.counts() == (1, 0)).await;
        let pid = fake::spawns(td.path())[0];
        assert!(fake::alive(pid));
        until("the idle worker to be reaped", || pool.counts() == (0, 0)).await;
        until("its process to end", || !fake::alive(pid)).await;
    }

    #[tokio::test]
    async fn a_key_not_wanted_for_a_while_is_a_one_off_again() {
        let td = tempfile::tempdir().unwrap();
        let bin = fake::omp(td.path(), "", "");
        let pool = Pool::new(limits(3, 300, 40));
        call(&pool, &bin, &key("tiny"), "x").await;
        tokio::time::sleep(Duration::from_millis(400)).await;
        // The first call is forgotten: this one is a one-off too.
        call(&pool, &bin, &key("tiny"), "y").await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(pool.counts(), (0, 0));
        for pid in fake::spawns(td.path()) {
            until("the one-off's process to end", || !fake::alive(pid)).await;
        }
    }

    #[tokio::test]
    async fn a_cancelled_call_kills_its_worker_and_the_next_one_is_ready() {
        let td = tempfile::tempdir().unwrap();
        std::fs::write(td.path().join("delay"), "5").unwrap();
        let bin = fake::omp(td.path(), "", "");
        let pool = Pool::new(limits(3, 60_000, 40));
        pool.ensure_warm(&bin, &key("tiny"));
        until("the worker to be ready", || pool.counts() == (1, 0)).await;
        let mut lease = pool.acquire(&bin, &key("tiny"), soon()).await.unwrap();
        let first = fake::spawns(td.path())[0];
        // The caller gives up (its future is dropped) while omp is still thinking.
        assert!(tokio::time::timeout(Duration::from_millis(150), lease.ask("slow", soon())).await.is_err());
        drop(lease);
        until("the cancelled worker to end", || !fake::alive(first)).await;
        until("a replacement to be ready", || pool.counts() == (1, 0)).await;
        assert_eq!(fake::spawns(td.path()).len(), 2);
        // A call that times out on its own deadline is the same.
        let mut lease = pool.acquire(&bin, &key("tiny"), soon()).await.unwrap();
        assert!(lease.warm);
        let second = fake::spawns(td.path())[1];
        assert_eq!(lease.ask("slow", Instant::now() + Duration::from_millis(150)).await.unwrap_err(), Failure::TimedOut);
        drop(lease);
        until("the timed-out worker to end", || !fake::alive(second)).await;
        until("a replacement to be ready", || pool.counts() == (1, 0) && fake::spawns(td.path()).len() == 3).await;
    }

    #[tokio::test]
    async fn unusable_workers_are_broken_and_never_replaced() {
        // Exits at once.
        let td = tempfile::tempdir().unwrap();
        let bin = fake::omp(td.path(), "echo 'boom' >&2; exit 1", "");
        let pool = Pool::new(limits(3, 60_000, 40));
        assert_eq!(pool.acquire(&bin, &key("tiny"), soon()).await.err(), Some(Failure::Broken));
        // omp's message for a role it does not have.
        let td2 = tempfile::tempdir().unwrap();
        let bin = fake::omp(td2.path(), r#"echo 'Model "@tiny" not found' >&2; exit 1"#, "");
        assert_eq!(pool.acquire(&bin, &key("tiny"), soon()).await.err(), Some(Failure::Unresolved));
        assert_eq!(pool.acquire(&bin, &key("smol"), soon()).await.err(), Some(Failure::Broken), "another role's message is not this role's");
        // Dies while thinking.
        let td3 = tempfile::tempdir().unwrap();
        let bin = fake::omp(td3.path(), "", "exit 3");
        let mut lease = pool.acquire(&bin, &key("tiny"), soon()).await.unwrap();
        assert_eq!(lease.ask("x", soon()).await.unwrap_err(), Failure::Broken);
        drop(lease);
        // Refuses the prompt.
        let td4 = tempfile::tempdir().unwrap();
        let bin = fake::omp(td4.path(), "", r#"printf '{"type":"response","id":"%s","command":"prompt","success":false,"error":"No API key"}\n' "$id"; continue"#);
        let mut lease = pool.acquire(&bin, &key("tiny"), soon()).await.unwrap();
        assert_eq!(lease.ask("x", soon()).await.unwrap_err(), Failure::Broken);
        drop(lease);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(pool.counts(), (0, 0));
        assert_eq!((fake::spawns(td3.path()).len(), fake::spawns(td4.path()).len()), (1, 1), "no respawn loop");
    }

    #[tokio::test]
    async fn the_model_failing_is_an_answer_of_its_own() {
        let td = tempfile::tempdir().unwrap();
        let bin = fake::omp(
            td.path(),
            "",
            r#"printf '{"type":"response","id":"%s","command":"prompt","success":true}\n{"type":"agent_end","messages":[{"role":"assistant","content":[],"stopReason":"error","errorMessage":"429 rate limited"}]}\n' "$id"; continue"#,
        );
        let pool = Pool::new(limits(3, 60_000, 40));
        let mut lease = pool.acquire(&bin, &key("tiny"), soon()).await.unwrap();
        assert_eq!(lease.ask("x", soon()).await.unwrap_err(), Failure::Model("429 rate limited".into()));
    }

    #[tokio::test]
    async fn warm_slots_are_capped_and_the_least_recently_used_makes_room() {
        let td = tempfile::tempdir().unwrap();
        let bin = fake::omp(td.path(), "", "");
        let pool = Pool::new(limits(2, 60_000, 40));
        for role in ["a", "b", "c"] {
            pool.ensure_warm(&bin, &key(role));
            until("the worker to be ready", || pool.counts().1 == 0).await;
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        until("c to be ready", || pool.counts() == (2, 0)).await;
        let pids = fake::spawns(td.path());
        until("the evicted process to end", || !fake::alive(pids[0])).await;
        assert!(fake::alive(pids[1]) && fake::alive(pids[2]));
        // `a` was evicted: its next call starts a worker (and in turn evicts `b`, now the oldest).
        let (_, warm) = call(&pool, &bin, &key("a"), "x").await;
        assert!(!warm);
        until("a to be ready", || pool.counts() == (2, 0)).await;
        until("b to end", || !fake::alive(pids[1])).await;
        let (_, warm) = call(&pool, &bin, &key("c"), "y").await;
        assert!(warm);
    }

    #[tokio::test]
    async fn a_worker_is_replaced_after_its_last_use() {
        let td = tempfile::tempdir().unwrap();
        let bin = fake::omp(td.path(), "", "");
        let pool = Pool::new(limits(3, 60_000, 2));
        pool.ensure_warm(&bin, &key("tiny"));
        until("the worker to be ready", || pool.counts() == (1, 0)).await;
        call(&pool, &bin, &key("tiny"), "1").await;
        call(&pool, &bin, &key("tiny"), "2").await;
        let first = fake::spawns(td.path())[0];
        until("the retired process to end", || !fake::alive(first)).await;
        until("its replacement to be ready", || pool.counts() == (1, 0)).await;
        let (_, warm) = call(&pool, &bin, &key("tiny"), "3").await;
        assert!(warm);
        assert_eq!(fake::spawns(td.path()).len(), 2);
        assert_eq!(fake::events(td.path()), ["prompt 1", "reset", "prompt 2", "prompt 3"], "the new worker needs no reset");
    }

    /// The second of two calls at once counts as a repeat, so one worker stays: a one-off's ends with its call.
    #[tokio::test]
    async fn concurrent_calls_leave_one_idle_worker_per_key() {
        let td = tempfile::tempdir().unwrap();
        std::fs::write(td.path().join("delay"), "0.2").unwrap();
        let bin = fake::omp(td.path(), "", "");
        let pool = Pool::new(limits(3, 60_000, 40));
        let k = key("tiny");
        let (a, b) = tokio::join!(call(&pool, &bin, &k, "a"), call(&pool, &bin, &k, "b"));
        assert_eq!((a.0.text.as_str(), b.0.text.as_str()), ("echo: a", "echo: b"));
        assert_eq!(fake::spawns(td.path()).len(), 2);
        until("the worker to be ready again", || pool.counts() == (1, 0)).await;
        let spare = fake::spawns(td.path());
        until("the spare process to end", || spare.iter().filter(|p| fake::alive(**p)).count() == 1).await;
    }

    #[tokio::test]
    async fn a_worker_that_died_while_idle_is_not_handed_out() {
        let td = tempfile::tempdir().unwrap();
        let bin = fake::omp(td.path(), "", "");
        let pool = Pool::new(limits(3, 60_000, 40));
        pool.ensure_warm(&bin, &key("tiny"));
        until("the worker to be ready", || pool.counts() == (1, 0)).await;
        let pid = fake::spawns(td.path())[0];
        // SAFETY: the pid is the fake omp started above.
        unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        until("it to die", || !fake::alive(pid)).await;
        let (a, warm) = call(&pool, &bin, &key("tiny"), "2").await;
        assert!(!warm && a.text == "echo: 2");
    }
}
