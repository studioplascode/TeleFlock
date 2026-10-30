//! `tf-hostd daemon`: single-instance lock, client endpoint, relay + guests + bridge,
//! per-herdr-session contexts, graceful shutdown (architecture §3.1–§3.2).

use std::cmp::Ordering as VersionOrder;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use anyhow::Context as _;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use tf_proto::ApiError;

use crate::bridge::BridgeHandle;
use crate::ipc::Listener;
use crate::omp::OmpHandle;
use crate::ops::Ctx;
use crate::paths::Paths;
use crate::util::now_ms;

pub struct Daemon {
    pub paths: Paths,
    pub relay_port: u16,
    pub omp: OmpHandle,
    pub bridge: BridgeHandle,
    /// `state.json` (archive, turns, activity, usage ledger).
    pub persist: Arc<crate::state::persist::Persist>,
    /// Keeps omp and herdr up to date (`<home>/tools.json`).
    pub tools: crate::ops::tools::Tools,
    /// Presence, notification routing and push channels (`<home>/notify.json`, `crate::notify`).
    pub notify: crate::notify::Notifier,
    pub shutdown: CancellationToken,
    pub started_at: i64,
    /// Identity of the binary this daemon runs (`attach --replace` compares it).
    pub exe_id: String,
    /// Clients past hello, over every herdr session.
    clients: AtomicUsize,
    /// One herdr session's context per key, created once ([`Flights`]).
    ctxs: Flights<Arc<Ctx>>,
}

impl Daemon {
    /// Answers an internal control line (`{"ctl":"info"|"stop"}`) with one JSON object.
    pub fn control(&self, op: &str) -> serde_json::Value {
        serde_json::json!({
            "ok": matches!(op, "info" | "stop"),
            "op": op,
            "pid": std::process::id(),
            "version": crate::version_line(),
            "exe": self.exe_id,
            "relayPort": self.relay_port,
            "home": self.paths.home.display().to_string(),
            "startedAt": self.started_at,
            "clients": self.clients(),
        })
    }

    /// Connected clients (past hello) over every herdr session.
    pub fn clients(&self) -> usize {
        self.clients.load(Ordering::Relaxed)
    }

    /// Counts one connected client until the returned guard drops.
    pub fn count_client(self: &Arc<Self>) -> ClientCount {
        self.clients.fetch_add(1, Ordering::Relaxed);
        ClientCount(self.clone())
    }

    /// Decides a `stop` control request ([`stop_policy`]). `requester` is the version line the
    /// request carries; `force` (`tf-hostd stop --force`) always stops.
    pub fn may_stop(&self, requester: Option<&str>, force: bool) -> Result<(), String> {
        if force {
            return Ok(());
        }
        stop_policy(requester, &crate::version_line(), self.clients())
    }

    /// The context of one herdr session, created on first use and shared by its clients. Creation
    /// waits for herdr's server to start (up to a minute): only callers for the same session wait
    /// for it, and it runs to the end even when the caller that began it goes away.
    pub async fn ctx_for(self: &Arc<Self>, session: &str) -> Result<Arc<Ctx>, ApiError> {
        if self.shutdown.is_cancelled() {
            return Err(ApiError::new("shutting_down", "tf-hostd is shutting down").retryable());
        }
        let (daemon, name) = (self.clone(), session.to_string());
        let create = async move {
            let ctx = Ctx::create(&daemon, &name).await?;
            info!(session = %name, "herdr session context created");
            Ok::<_, ApiError>(ctx)
        };
        self.ctxs
            .get_or_try_init(session, create)
            .await
            .map_err(|e| ApiError::new("internal", format!("creating the herdr session context failed: {e}")).retryable())?
    }

    async fn all_ctxs(&self) -> Vec<Arc<Ctx>> {
        self.ctxs.all().await
    }
}

/// Values created at most once per key, without holding any lock while one is being created:
/// callers for the same key wait for the one creation, other keys never do. The creation runs in
/// a task of its own, so a caller that gives up (a client that went away) does not cancel it half
/// way; a failed creation is forgotten and the next caller tries again.
struct Flights<T> {
    cells: tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::OnceCell<T>>>>,
}

impl<T: Clone + Send + Sync + 'static> Flights<T> {
    fn new() -> Self {
        Self { cells: tokio::sync::Mutex::new(HashMap::new()) }
    }

    async fn get_or_try_init<E: Send + 'static>(
        &self,
        key: &str,
        make: impl Future<Output = Result<T, E>> + Send + 'static,
    ) -> Result<Result<T, E>, tokio::task::JoinError> {
        let cell = self.cells.lock().await.entry(key.to_string()).or_default().clone();
        if let Some(v) = cell.get() {
            return Ok(Ok(v.clone()));
        }
        tokio::spawn(async move { cell.get_or_try_init(|| make).await.cloned() }).await
    }

    /// Every value created so far.
    async fn all(&self) -> Vec<T> {
        self.cells.lock().await.values().filter_map(|c| c.get().cloned()).collect()
    }
}

/// Keeps [`Daemon::clients`] counting one client while alive.
pub struct ClientCount(Arc<Daemon>);

impl Drop for ClientCount {
    fn drop(&mut self) {
        self.0.clients.fetch_sub(1, Ordering::Relaxed);
    }
}

/// A host is shared by every device, and devices update at different times. An app that is
/// behind installs its own tf-hostd and asks the running daemon to stop; obeying would drop every
/// other client, whose apps then reinstall their build and stop that daemon in turn (each device
/// drops every few seconds). So while clients are attached, the daemon refuses `stop` from:
/// - builds that predate this rule: they send no version line (and always ask right after
///   installing themselves over this daemon's binary);
/// - builds older than `own`.
///
/// The refused `attach` connects to this daemon instead. An idle daemon always stops.
pub fn stop_policy(requester: Option<&str>, own: &str, clients: usize) -> Result<(), String> {
    if clients == 0 {
        return Ok(());
    }
    match requester {
        None => Err(format!("an older TeleFlock asked without a version while {clients} client(s) are connected")),
        Some(r) if tf_proto::version::cmp_lines(r, own) == Some(VersionOrder::Less) => {
            Err(format!("`{r}` is older than this daemon (`{own}`) and {clients} client(s) are connected"))
        }
        Some(_) => Ok(()),
    }
}

/// Holds `hostd.lock` (exclusive OS file lock) for the daemon's lifetime.
pub struct InstanceLock {
    file: File,
}

impl InstanceLock {
    /// Takes the lock and writes our pid into it. `Err(Some(pid))` when another daemon holds it.
    pub fn acquire(paths: &Paths) -> Result<Self, Option<u32>> {
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&paths.lock)
            .map_err(|_| None)?;
        match file.try_lock() {
            Ok(()) => {}
            Err(_) => {
                let mut s = String::new();
                let _ = file.read_to_string(&mut s);
                return Err(s.trim().parse().ok());
            }
        }
        let _ = file.set_len(0);
        let _ = file.rewind();
        let _ = write!(file, "{}", std::process::id());
        let _ = file.flush();
        Ok(Self { file })
    }

    /// True when a daemon currently holds the lock (probe without keeping it).
    pub fn is_held(paths: &Paths) -> bool {
        let Ok(file) = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&paths.lock)
        else {
            return false;
        };
        match file.try_lock() {
            Ok(()) => {
                let _ = file.unlock();
                false
            }
            Err(_) => true,
        }
    }
}

impl Drop for InstanceLock {
    fn drop(&mut self) {
        let _ = self.file.set_len(0);
        let _ = self.file.unlock();
    }
}

/// Identity of the running executable: path, size and mtime.
pub fn exe_identity() -> String {
    let Ok(exe) = std::env::current_exe() else { return String::new() };
    let meta = std::fs::metadata(&exe).ok();
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let mtime = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{}|{size}|{mtime}", exe.display())
}

/// Entry point of `tf-hostd daemon`. Exit code 3 when another daemon holds the lock.
///
/// Startup order: lock, client socket (so `attach` can connect at once), the user's PATH
/// ([`crate::userenv::prepare`], which must run while this is the only thread), logging, runtime.
pub fn run(paths: Paths, relay_port: u16) -> anyhow::Result<i32> {
    paths.ensure_dirs().with_context(|| format!("create {}", paths.run.display()))?;
    let lock = match InstanceLock::acquire(&paths) {
        Ok(l) => l,
        Err(pid) => {
            eprintln!(
                "tf-hostd: another daemon is running{}",
                pid.map(|p| format!(" (pid {p})")).unwrap_or_default()
            );
            return Ok(3);
        }
    };
    let bound = crate::ipc::Bound::bind(&paths).with_context(|| format!("bind {}", paths.endpoint()))?;
    let env = crate::userenv::prepare();
    crate::logging::init_file(&paths.log).with_context(|| format!("open {}", paths.log.display()))?;
    info!(version = %crate::version_line(), pid = std::process::id(), home = %paths.home.display(), relay_port, "daemon starting");
    env.log();

    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().thread_name("tf-hostd").build()?;
    let code = rt.block_on(async_main(paths.clone(), relay_port, bound));
    rt.shutdown_timeout(Duration::from_secs(2));
    #[cfg(unix)]
    {
        let _ = std::fs::remove_file(&paths.sock);
    }
    drop(lock);
    info!("daemon stopped");
    code
}

async fn async_main(paths: Paths, relay_port: u16, bound: crate::ipc::Bound) -> anyhow::Result<i32> {
    let shutdown = CancellationToken::new();
    let persist = crate::state::persist::Persist::load(paths.state_file.clone());
    persist.spawn_saver(shutdown.child_token());
    let (originals, notes, rows) = (crate::originals::dir(&paths.home), crate::notes::dir(&paths.home), crate::live_rows::dir(&paths.home));
    tokio::task::spawn_blocking(move || {
        crate::originals::prune(&originals);
        crate::notes::prune(&notes);
        crate::live_rows::prune(&rows);
    });
    // The app uploaded this build's extension before starting it: bring a consented global copy
    // up to date before omp loads it again.
    let ext_paths = paths.clone();
    tokio::task::spawn_blocking(move || crate::ops::host::refresh_global_bridge(&ext_paths));
    let bridge = match BridgeHandle::start(&paths) {
        Ok(b) => b,
        Err(e) => {
            error!("bridge socket: {e}");
            return Err(anyhow::anyhow!("bridge socket: {e}"));
        }
    };
    // Bridges ≥ 2.0 serve their sessions to the omp data plane directly (no collab room).
    let omp = OmpHandle::start(relay_port, persist.clone(), shutdown.clone(), bridge.clone()).await;
    // Automatic tool updates default on for the real daemon (`~/.teleflock`), off for lab homes.
    let tools = crate::ops::tools::Tools::load(paths.home.join("tools.json"), paths.is_default_home());
    tools.spawn(shutdown.child_token());
    // omp's stats index for `host.usage`: synced on demand; warmed every 30 min on the real daemon.
    crate::ops::usage::start(&paths, persist.clone(), shutdown.child_token());
    let notify = crate::notify::Notifier::load(&paths.home, shutdown.child_token());
    let mut listener = Listener::start(bound, &paths).with_context(|| format!("bind {}", paths.endpoint()))?;
    info!(endpoint = %paths.endpoint(), "listening");

    let daemon = Arc::new(Daemon {
        paths: paths.clone(),
        relay_port,
        omp: omp.clone(),
        bridge,
        persist: persist.clone(),
        tools,
        notify,
        shutdown: shutdown.clone(),
        started_at: now_ms(),
        exe_id: exe_identity(),
        clients: AtomicUsize::new(0),
        ctxs: Flights::new(),
    });

    crate::automations::start(&daemon);
    // Auto-resume tickets (limits, restarts): due ones resume with no app connected.
    crate::recovery::start(&daemon);
    // Limit stops reported by 2.1.0 bridges, their `context` guard (§3.22).
    crate::limit_resume::start(&daemon);
    // Decide for me answers with no app connected: watch the sessions that have it on.
    crate::autoanswer::start(&daemon);
    // Push channels deliver with no app connected: watch the sessions this host knows (§3.21).
    crate::notify::start(&daemon);
    // herdr's servers are watched (and started again) with no app connected (§3.29).
    crate::herdr_health::start(&daemon);
    // Agents the ledger holds come back after a reboot with no app connected (§3.25).
    crate::restart::start(&daemon);
    spawn_signal_handler(shutdown.clone());

    let mut conns = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            accepted = listener.accept() => match accepted {
                Ok((r, w)) => {
                    let d = daemon.clone();
                    conns.spawn(crate::clients::serve(d, r, w));
                }
                Err(e) => {
                    warn!("accept: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            },
            Some(_) = conns.join_next(), if !conns.is_empty() => {}
        }
    }

    info!("shutting down");
    drop(listener);
    let _ = tokio::time::timeout(Duration::from_secs(3), async { while conns.join_next().await.is_some() {} }).await;
    for ctx in daemon.all_ctxs().await {
        ctx.state.persist_now();
        ctx.close().await;
    }
    // The agent ledger's last write (after the cards above are saved): awaited, not left to the
    // workers' detached tails.
    crate::restart::flush_ledger(&daemon.paths.home, Duration::from_secs(3)).await;
    daemon.omp.shutdown().await;
    daemon.persist.save_now();
    Ok(0)
}

fn spawn_signal_handler(shutdown: CancellationToken) {
    #[cfg(unix)]
    tokio::spawn(async move {
        use tokio::signal::unix::{signal, SignalKind};
        let (Ok(mut term), Ok(mut int), Ok(mut hup)) =
            (signal(SignalKind::terminate()), signal(SignalKind::interrupt()), signal(SignalKind::hangup()))
        else {
            return;
        };
        tokio::select! {
            _ = term.recv() => info!("SIGTERM"),
            _ = int.recv() => info!("SIGINT"),
            _ = hup.recv() => info!("SIGHUP"),
            _ = shutdown.cancelled() => return,
        }
        shutdown.cancel();
    });
    #[cfg(windows)]
    tokio::spawn(async move {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => shutdown.cancel(),
            _ = shutdown.cancelled() => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_is_exclusive() {
        let dir = std::env::temp_dir().join(format!("tf-hostd-lock-{}", std::process::id()));
        let paths = Paths::new(dir.clone(), true);
        paths.ensure_dirs().unwrap();
        let held = InstanceLock::acquire(&paths).unwrap();
        assert!(InstanceLock::is_held(&paths));
        let pid = std::fs::read_to_string(&paths.lock).unwrap();
        assert_eq!(pid.trim(), std::process::id().to_string());
        drop(held);
        assert!(!InstanceLock::is_held(&paths));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn older_builds_cannot_stop_a_shared_daemon() {
        let own = "tf-hostd 0.3.0 proto 1";
        // An app that is behind would restart the host under the attached clients.
        assert!(stop_policy(Some("tf-hostd 0.2.0 proto 1"), own, 1).is_err());
        // Builds from before this rule send no version, whatever version they are.
        assert!(stop_policy(None, own, 1).is_err());
        // Nobody to drop: any build may take an idle daemon over.
        assert!(stop_policy(Some("tf-hostd 0.2.0 proto 1"), own, 0).is_ok());
        assert!(stop_policy(None, own, 0).is_ok());
        // The same or a newer build replaces it (upgrade, or `tf-hostd stop` of this build).
        assert!(stop_policy(Some(own), own, 2).is_ok());
        assert!(stop_policy(Some("tf-hostd 0.4.0 proto 1"), own, 2).is_ok());
    }

    #[tokio::test]
    async fn a_slow_creation_blocks_only_its_own_key_and_runs_once() {
        use std::sync::atomic::AtomicU32;
        let flights = Arc::new(Flights::<u32>::new());
        let runs = Arc::new(AtomicU32::new(0));
        let gate = Arc::new(tokio::sync::Notify::new());
        let slow = |value: u32| {
            let (runs, gate) = (runs.clone(), gate.clone());
            async move {
                runs.fetch_add(1, Ordering::SeqCst);
                gate.notified().await;
                Ok::<_, String>(value)
            }
        };
        // Two callers for "a" while its creation waits (a herdr server taking its time to start).
        let first = tokio::spawn({
            let (f, make) = (flights.clone(), slow(1));
            async move { f.get_or_try_init("a", make).await }
        });
        let second = tokio::spawn({
            let (f, make) = (flights.clone(), slow(2));
            async move { f.get_or_try_init("a", make).await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        // Another key is not held up behind it, and the registry lock is free.
        let other = tokio::time::timeout(Duration::from_secs(2), flights.get_or_try_init("b", async { Ok::<_, String>(9) })).await;
        assert_eq!(other.expect("an unrelated session waited for a slow one").unwrap().unwrap(), 9);
        assert!(tokio::time::timeout(Duration::from_secs(2), flights.all()).await.is_ok());
        assert_eq!(runs.load(Ordering::SeqCst), 1, "one creation for both callers");
        gate.notify_one();
        let (a, b) = (first.await.unwrap().unwrap().unwrap(), second.await.unwrap().unwrap().unwrap());
        assert_eq!(a, b, "both callers get the one value");
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        let mut all = flights.all().await;
        all.sort();
        assert_eq!(all, vec![a.min(9), a.max(9)]);
    }

    #[tokio::test]
    async fn a_failed_creation_is_tried_again_and_a_caller_that_leaves_does_not_cancel_it() {
        let flights = Flights::<u32>::new();
        assert_eq!(flights.get_or_try_init("a", async { Err::<u32, _>("boom".to_string()) }).await.unwrap(), Err("boom".to_string()));
        assert!(flights.all().await.is_empty());
        assert_eq!(flights.get_or_try_init("a", async { Ok::<_, String>(5) }).await.unwrap(), Ok(5));
        assert_eq!(flights.get_or_try_init("a", async { Ok::<_, String>(6) }).await.unwrap(), Ok(5), "created once");

        // The caller gives up while the creation runs: it still completes and is kept.
        let flights = Arc::new(Flights::<u32>::new());
        let done = Arc::new(tokio::sync::Notify::new());
        let waiter = tokio::spawn({
            let (f, done) = (flights.clone(), done.clone());
            async move {
                f.get_or_try_init("a", async move {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    done.notify_one();
                    Ok::<_, String>(7)
                })
                .await
            }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        waiter.abort();
        tokio::time::timeout(Duration::from_secs(2), done.notified()).await.expect("the creation was cancelled with its caller");
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(flights.get_or_try_init("a", async { Ok::<_, String>(8) }).await.unwrap(), Ok(7));
    }
}
