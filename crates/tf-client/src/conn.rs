//! Per-host connection runtime (architecture §5.2): the phase state machine with backoff,
//! deploy, `tf-hostd attach`, the protocol link, and the client-side view of the host
//! (status, last state, notifications, session mirrors, open terminals).

use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use tf_proto::{
    ApiError, AppEvent, ClientInfo, ClientMsg, ConnPhase, ConnStatus, HostKeyInfo, HostKind, HostProfile, HostState, Millis,
    Notification, PROTOCOL_VERSION, ServerMsg, StatePatch, TermEvent,
};
use tf_transport::{
    Cmd, ConnectOptions, HostKeyDecision, HostKeyPolicy, Transport, TransportError, TransportEvent, WslKeepalive,
};
use tokio::sync::{Notify, mpsc, watch};

use crate::deploy;
use crate::engine::{Inner, session_host};
use crate::link::{Link, LinkSink};
use crate::sessions::{self, Sessions};
use crate::util::now_ms;

pub(crate) enum ConnCmd {
    /// Connect if idle; retry now if waiting in backoff.
    Connect,
    /// Drop the current attempt/link and connect again now (profile changed).
    Reconnect,
    Disconnect,
    Shutdown,
}

/// Client-side view of one host, guarded by `HostRt::view`.
pub(crate) struct HostView {
    pub status: ConnStatus,
    /// Last known state and its revision (live while `live`, else cached/stale).
    pub state: Option<(u64, HostState)>,
    pub live: bool,
    /// State changed since the last cache write.
    pub dirty: bool,
    /// Recent notifications (`notification_action`, cross-surface read/resolved sync).
    pub notifications: VecDeque<Tracked>,
    pub terms: HashSet<String>,
    /// Fingerprint the user confirmed with `hosts.trustKey`; consumed by the next attempt.
    pub approved_key: Option<String>,
}

/// A remembered notification and where it still demands attention.
#[derive(Debug, Clone)]
pub(crate) struct Tracked {
    pub n: Notification,
    /// Shown by the OS right now: posted, and not replaced (one per agent), retracted or
    /// dismissed since.
    pub posted: bool,
    /// Needs-you: the request was seen pending in host state, so its absence later means it
    /// was resolved (and not that the state has not caught up yet).
    pub seen: bool,
    pub read: bool,
    /// Needs-you: the request was handled (answered anywhere, cancelled, agent gone).
    pub resolved: bool,
}

pub(crate) struct HostRt {
    pub id: String,
    pub cmd: mpsc::UnboundedSender<ConnCmd>,
    pub view: Mutex<HostView>,
    pub link: Mutex<Option<Arc<Link>>>,
    pub transport: Mutex<Option<Arc<dyn Transport>>>,
    pub online: watch::Sender<bool>,
    /// The user wants this host connected.
    pub wanted: AtomicBool,
    /// What the app core keeps of the sessions the UI opens on this host.
    pub sessions: Sessions,
}

const NOTIFICATION_RING: usize = 100;
/// Our own codes that end auto-reconnect; `deploy_failed`: the host can't run the setup (deploy.rs).
const FATAL_CODES: &[&str] =
    &["unsupported", "version_mismatch", "deploy_failed", "invalid_params", "not_found", "permission_denied", "auth_denied"];
/// `TransportError::HostKeyUnconfirmed`: fatal, but parks in `hostKey` instead of `error`.
const HOST_KEY_UNCONFIRMED: &str = "transport.hostKeyUnconfirmed";

fn idle_status() -> ConnStatus {
    ConnStatus {
        phase: ConnPhase::Idle,
        since: now_ms(),
        latency_ms: None,
        auth_url: None,
        message: None,
        error: None,
        attempt: 0,
        next_retry_at: None,
        last_online_at: None,
        hostd_version: None,
        host_key: None,
    }
}

/// Host key policy for one connect attempt: tailnet addresses are trusted on first use
/// (Tailscale authenticates the node); any other address needs the fingerprint the user
/// confirmed (`approved`).
pub(crate) fn host_key_policy(approved: Option<String>) -> HostKeyPolicy {
    HostKeyPolicy::new(move |c| {
        if tf_transport::is_tailnet_ip(c.address) || approved.as_deref() == Some(c.fingerprint.as_str()) {
            HostKeyDecision::Trust
        } else {
            HostKeyDecision::Confirm
        }
    })
}

/// Reconnect delay for the n-th consecutive failure (1, 2, 4 … 30 s, +0–20 % jitter).
pub fn backoff(attempt: u32) -> Duration {
    let base = 1u64 << attempt.saturating_sub(1).min(5);
    let base = base.min(30) as f64;
    Duration::from_millis((base * 1000.0 * (1.0 + rand::random::<f64>() * 0.2)) as u64)
}

/// Permanent failures stop auto-reconnect (`error` phase) until the user retries: our own
/// non-retryable codes above, and every non-retryable `transport.*` error (host key
/// mismatch, not Tailscale SSH, auth denied, WSL/spawn/config problems).
pub fn is_fatal(e: &ApiError) -> bool {
    !e.retryable && (FATAL_CODES.contains(&e.code.as_str()) || e.code.starts_with("transport."))
}

impl HostRt {
    pub fn new(id: String, cached: Option<(u64, HostState)>) -> (Arc<Self>, mpsc::UnboundedReceiver<ConnCmd>) {
        let (cmd, rx) = mpsc::unbounded_channel();
        let rt = Arc::new(HostRt {
            id,
            cmd,
            view: Mutex::new(HostView {
                status: idle_status(),
                state: cached,
                live: false,
                dirty: false,
                notifications: VecDeque::new(),
                terms: HashSet::new(),
                approved_key: None,
            }),
            link: Mutex::new(None),
            transport: Mutex::new(None),
            online: watch::channel(false).0,
            wanted: AtomicBool::new(false),
            sessions: Sessions::default(),
        });
        (rt, rx)
    }

    pub fn link(&self) -> Option<Arc<Link>> {
        self.link.lock().unwrap().clone().filter(|l| !l.is_closed())
    }

    pub fn transport(&self) -> Option<Arc<dyn Transport>> {
        self.transport.lock().unwrap().clone()
    }

    pub fn status(&self) -> ConnStatus {
        self.view.lock().unwrap().status.clone()
    }

    /// Waits until the link is online (or the timeout passes).
    pub async fn wait_online(&self, timeout: Duration) -> bool {
        let mut rx = self.online.subscribe();
        tokio::time::timeout(timeout, rx.wait_for(|o| *o)).await.is_ok_and(|r| r.is_ok())
    }

    pub fn find_notification(&self, id: &str) -> Option<Tracked> {
        self.view.lock().unwrap().notifications.iter().find(|t| t.n.id == id).cloned()
    }

    /// Remembers a notification. A posted one replaces the OS notification of the same agent
    /// (`Platform::notify` keeps one per agent), so older ones are no longer shown.
    pub fn remember_notification(&self, t: Tracked) {
        let mut v = self.view.lock().unwrap();
        if t.posted && !t.n.agent_id.is_empty() {
            for old in v.notifications.iter_mut().filter(|o| o.n.agent_id == t.n.agent_id) {
                old.posted = false;
            }
        }
        if v.notifications.len() == NOTIFICATION_RING {
            v.notifications.pop_front();
        }
        v.notifications.push_back(t);
    }

    /// Notification `id` was posted to the OS after the fact (an escalation): it replaces the OS
    /// notification of its agent, like a fresh one.
    pub fn mark_posted(&self, id: &str) {
        let mut v = self.view.lock().unwrap();
        let Some(agent) = v.notifications.iter().find(|t| t.n.id == id).map(|t| t.n.agent_id.clone()) else { return };
        for t in v.notifications.iter_mut() {
            if t.n.id == id {
                t.posted = true;
            } else if !agent.is_empty() && t.n.agent_id == agent {
                t.posted = false;
            }
        }
    }

    /// `hosts.trustKey`: accept the key awaiting confirmation (phase `hostKey`) when the
    /// fingerprint matches what the user was shown. The caller then connects again.
    pub fn approve_host_key(&self, fingerprint: &str) -> Result<(), ApiError> {
        let mut v = self.view.lock().unwrap();
        let pending = match (&v.status.phase, &v.status.host_key) {
            (ConnPhase::HostKey, Some(k)) => k.fingerprint.clone(),
            _ => return Err(ApiError::new("invalid_params", "no host key is waiting for confirmation on this host")),
        };
        if pending != fingerprint.trim() {
            return Err(ApiError::new("invalid_params", "the fingerprint does not match the host key awaiting confirmation")
                .with_hint("The host presented a different key; reconnect and compare the fingerprint again."));
        }
        v.approved_key = Some(pending);
        Ok(())
    }
}

/// Bridges the link's pushes into engine state and events.
struct Sink {
    inner: Weak<Inner>,
    rt: Weak<HostRt>,
    /// [`Link::id`] of the link this sink serves, once established.
    link_id: AtomicU64,
}

impl LinkSink for Sink {
    fn snapshot(&self, rev: u64, state: HostState) {
        let (Some(inner), Some(rt)) = (self.inner.upgrade(), self.rt.upgrade()) else { return };
        inner.apply_snapshot(&rt, rev, state);
    }

    fn patch(&self, rev: u64, ops: Vec<StatePatch>) {
        let (Some(inner), Some(rt)) = (self.inner.upgrade(), self.rt.upgrade()) else { return };
        inner.apply_patch(&rt, rev, ops);
    }

    fn push(&self, msg: ServerMsg) {
        let (Some(inner), Some(rt)) = (self.inner.upgrade(), self.rt.upgrade()) else { return };
        let host_id = rt.id.clone();
        match msg {
            ServerMsg::Pulse { at, pulses } => inner.send(AppEvent::Pulse { host_id, at, pulses }),
            ServerMsg::Session { agent_id, ev, seq } => {
                let link = match self.link_id.load(Ordering::SeqCst) {
                    0 => rt.link().map_or(0, |l| l.id),
                    id => id,
                };
                sessions::on_event(&session_host(&inner, &rt), link, agent_id, ev, seq);
            }
            ServerMsg::Term { term_id, ev } => {
                if matches!(ev, TermEvent::Closed { .. }) {
                    rt.view.lock().unwrap().terms.remove(&term_id);
                }
                inner.send(AppEvent::Term { host_id, term_id, ev })
            }
            ServerMsg::Notify { notification, alert } => inner.on_notify(&rt, notification, alert),
            ServerMsg::NotifyAlert { id } => inner.on_notify_alert(&rt, &id),
            ServerMsg::NotifyDone { ids, .. } => inner.on_remote_read(&rt, &ids),
            _ => {}
        }
    }

    fn latency(&self, ms: u32) {
        let (Some(inner), Some(rt)) = (self.inner.upgrade(), self.rt.upgrade()) else { return };
        inner.update_status(&rt, |s| s.latency_ms = Some(ms));
    }
}

enum Outcome {
    Ended(Result<String, ApiError>, Option<Instant>),
    Cmd(Option<ConnCmd>),
}

/// A process holding a WSL distro up (seam over [`WslKeepalive`] for tests).
pub(crate) trait Holding {
    fn is_running(&mut self) -> bool;
}

impl Holding for WslKeepalive {
    fn is_running(&mut self) -> bool {
        WslKeepalive::is_running(self)
    }
}

/// Keeps a WSL host's distro running from its first connect attempt until the host is no longer
/// wanted: reconnects and backoff would otherwise leave WSL without a client long enough to stop
/// the distro, and tf-hostd, herdr and every agent with it ([`WslKeepalive`]).
pub(crate) struct DistroHold<H, F> {
    start: F,
    /// The held distro (`None`: the default one) and the process holding it.
    held: Option<(Option<String>, H)>,
}

impl<H: Holding, F: FnMut(Option<&str>) -> Result<H, TransportError>> DistroHold<H, F> {
    pub fn new(start: F) -> Self {
        Self { start, held: None }
    }

    /// Before each connect attempt: holds a WSL profile's distro, starting the hold again when it
    /// ended and moving it when the distro changed; other kinds hold nothing.
    pub fn attempt(&mut self, host: &str, p: &HostProfile) {
        if p.kind != HostKind::Wsl {
            self.held = None;
            return;
        }
        if let Some((distro, h)) = &mut self.held
            && *distro == p.distro
            && h.is_running()
        {
            return;
        }
        self.held = None;
        let name = p.distro.as_deref().unwrap_or("the default distro");
        match (self.start)(p.distro.as_deref()) {
            Ok(h) => {
                log::info!("host {host}: keeping WSL {name} running between connections");
                self.held = Some((p.distro.clone(), h));
            }
            Err(e) => log::warn!("host {host}: keeping WSL {name} running failed: {e}"),
        }
    }

    /// The host is no longer wanted (disconnect, a permanent error, removal, quit): WSL may stop
    /// the distro again.
    pub fn release(&mut self) {
        self.held = None;
    }
}

/// Host task: runs until `Shutdown` (or the engine is dropped).
pub(crate) async fn run(inner: Weak<Inner>, rt: Arc<HostRt>, mut rx: mpsc::UnboundedReceiver<ConnCmd>) {
    let mut attempt: u32 = 0;
    let mut hold = DistroHold::new(WslKeepalive::start);
    loop {
        if !rt.wanted.load(Ordering::SeqCst) {
            hold.release();
            match rx.recv().await {
                None | Some(ConnCmd::Shutdown) => break,
                Some(ConnCmd::Connect | ConnCmd::Reconnect) => {
                    rt.wanted.store(true, Ordering::SeqCst);
                    attempt = 0;
                    if let Some(i) = inner.upgrade() {
                        i.refresh_keep_alive();
                    }
                }
                Some(ConnCmd::Disconnect) => {
                    // Cancel on the host key card: leave `hostKey` for `offline`.
                    if rt.status().phase == ConnPhase::HostKey
                        && let Some(eng) = inner.upgrade()
                    {
                        rt.view.lock().unwrap().approved_key = None;
                        eng.set_phase(&rt, ConnPhase::Offline, Some("Disconnected".into()));
                    }
                    continue;
                }
            }
        }
        let Some(eng) = inner.upgrade() else { break };
        let Some(profile) = eng.profile(&rt.id) else { break };
        hold.attempt(&rt.id, &profile);
        let online_at: Arc<Mutex<Option<Instant>>> = Arc::default();
        // The attempt runs in its own task so a panic in a lower layer becomes a retryable
        // error instead of killing this state machine.
        let mut task = {
            let (eng, rt, online_at) = (eng.clone(), rt.clone(), online_at.clone());
            tokio::spawn(async move { connect_and_serve(&eng, &rt, &profile, attempt, online_at).await })
        };
        let outcome = loop {
            tokio::select! {
                r = &mut task => {
                    let r = r.unwrap_or_else(|e| {
                        log::error!("host {}: connection task failed: {e}", rt.id);
                        Err(ApiError::new("internal", format!("connection task failed: {e}")).retryable())
                    });
                    break Outcome::Ended(r, *online_at.lock().unwrap());
                }
                c = rx.recv() => match c {
                    Some(ConnCmd::Connect) => continue,
                    other => {
                        task.abort();
                        let _ = (&mut task).await;
                        break Outcome::Cmd(other);
                    }
                },
            }
        };
        teardown(&eng, &rt).await;
        match outcome {
            Outcome::Cmd(None | Some(ConnCmd::Shutdown)) => break,
            Outcome::Cmd(Some(ConnCmd::Disconnect)) => {
                rt.wanted.store(false, Ordering::SeqCst);
                eng.set_phase(&rt, ConnPhase::Offline, Some("Disconnected".into()));
                eng.refresh_keep_alive();
            }
            Outcome::Cmd(Some(_)) => attempt = 0,
            Outcome::Ended(result, online) => {
                if online.is_some_and(|t| t.elapsed() >= Duration::from_secs(60)) {
                    attempt = 0;
                }
                let error = match result {
                    Ok(reason) => ApiError::new("not_connected", reason).retryable(),
                    Err(e) => e,
                };
                if is_fatal(&error) {
                    rt.wanted.store(false, Ordering::SeqCst);
                    // An unconfirmed host key waits in `hostKey` for `hosts.trustKey`.
                    let phase = if error.code == HOST_KEY_UNCONFIRMED { ConnPhase::HostKey } else { ConnPhase::Error };
                    eng.update_status(&rt, |s| {
                        s.phase = phase;
                        s.message = Some(error.message.clone());
                        s.error = Some(error.clone());
                        s.next_retry_at = None;
                        s.auth_url = None;
                    });
                    eng.refresh_keep_alive();
                    continue;
                }
                attempt += 1;
                let delay = backoff(attempt);
                let retry_at = now_ms() + delay.as_millis() as Millis;
                log::info!("host {}: {} (retry {attempt} in {:?})", rt.id, error, delay);
                eng.update_status(&rt, |s| {
                    s.phase = ConnPhase::Reconnecting;
                    s.message = Some(error.message.clone());
                    s.error = Some(error.clone());
                    s.attempt = attempt;
                    s.next_retry_at = Some(retry_at);
                    s.auth_url = None;
                });
                drop(eng);
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    c = rx.recv() => match c {
                        None | Some(ConnCmd::Shutdown) => break,
                        Some(ConnCmd::Disconnect) => {
                            rt.wanted.store(false, Ordering::SeqCst);
                            if let Some(eng) = inner.upgrade() {
                                eng.set_phase(&rt, ConnPhase::Offline, Some("Disconnected".into()));
                                eng.refresh_keep_alive();
                            }
                        }
                        Some(ConnCmd::Connect | ConnCmd::Reconnect) => {}
                    },
                }
            }
        }
    }
    if let Some(eng) = inner.upgrade() {
        teardown(&eng, &rt).await;
    }
}

/// Closes link + transport, ends open terminals, marks state stale, flushes the caches.
async fn teardown(eng: &Arc<Inner>, rt: &Arc<HostRt>) {
    let link = rt.link.lock().unwrap().take();
    if let Some(link) = link {
        link.bye();
        link.close("disconnected");
    }
    rt.sessions.link_down();
    rt.online.send_replace(false);
    let transport = rt.transport.lock().unwrap().take();
    if let Some(t) = transport {
        // Bounded: never let a wedged transport block the host task.
        let _ = tokio::time::timeout(Duration::from_secs(3), t.close()).await;
    }
    let terms: Vec<String> = {
        let mut v = rt.view.lock().unwrap();
        v.live = false;
        v.terms.drain().collect()
    };
    for term_id in terms {
        eng.send(AppEvent::Term {
            host_id: rt.id.clone(),
            term_id,
            ev: TermEvent::Closed { reason: "connection lost".into() },
        });
    }
    eng.refresh_badge();
    eng.flush_cache(rt).await;
    // Bounded like the transport close: a slow disk must not hold up a reconnect.
    let _ = tokio::time::timeout(Duration::from_secs(5), sessions::persist_all(session_host(eng, rt))).await;
}

fn transport_err(e: tf_transport::TransportError) -> ApiError {
    e.into()
}

async fn connect_and_serve(
    eng: &Arc<Inner>,
    rt: &Arc<HostRt>,
    profile: &HostProfile,
    attempt: u32,
    online_at: Arc<Mutex<Option<Instant>>>,
) -> Result<String, ApiError> {
    if profile.kind == HostKind::Demo {
        return Err(ApiError::new("unsupported", "demo hosts are simulated by the frontend"));
    }
    eng.update_status(rt, |s| {
        s.phase = ConnPhase::Connecting;
        s.message = Some(if attempt > 0 { format!("Reconnecting (retry {attempt})…") } else { "Connecting…".into() });
        s.attempt = attempt;
        s.next_retry_at = None;
        s.auth_url = None;
        s.host_key = None;
    });

    // Transport events → status.
    let (ev_tx, mut ev_rx) = mpsc::channel::<TransportEvent>(32);
    // Set (with the reason) when the transport reports it was lost.
    let lost: Arc<(Notify, Mutex<Option<String>>)> = Arc::default();
    {
        let inner = Arc::downgrade(eng);
        let rtw = Arc::downgrade(rt);
        let lost = lost.clone();
        tokio::spawn(async move {
            while let Some(ev) = ev_rx.recv().await {
                let (Some(eng), Some(rt)) = (inner.upgrade(), rtw.upgrade()) else { break };
                match ev {
                    TransportEvent::Phase(phase, msg) => eng.update_status(&rt, |s| {
                        if matches!(s.phase, ConnPhase::Connecting | ConnPhase::Authenticating | ConnPhase::AuthRequired) {
                            s.phase = phase;
                            if msg.is_some() {
                                s.message = msg;
                            }
                            if phase != ConnPhase::AuthRequired {
                                s.auth_url = None;
                            }
                        }
                    }),
                    TransportEvent::AuthUrl(url) => eng.update_status(&rt, |s| {
                        s.phase = ConnPhase::AuthRequired;
                        s.message = Some("Tailscale needs you to re-authenticate".into());
                        s.auth_url = Some(url);
                    }),
                    TransportEvent::Latency(ms) => eng.update_status(&rt, |s| s.latency_ms = Some(ms)),
                    TransportEvent::Closed(Some(reason)) => {
                        *lost.1.lock().unwrap() = Some(reason);
                        lost.0.notify_one();
                    }
                    TransportEvent::Closed(None) => {}
                }
            }
        });
    }

    let mut opts = ConnectOptions::new(eng.data_dir().join("known_hosts"));
    opts.secrets = eng.ssh_secrets(profile).await?;
    opts.host_key_policy = host_key_policy(rt.view.lock().unwrap().approved_key.take());
    let transport = tf_transport::connect(profile, &opts, ev_tx).await.map_err(|e| {
        if let TransportError::HostKeyUnconfirmed { address, algorithm, fingerprint, .. } = &e {
            // `run` moves to `hostKey`; the card shows this until `hosts.trustKey`.
            let info = HostKeyInfo { address: address.clone(), algorithm: algorithm.clone(), fingerprint: fingerprint.clone() };
            eng.update_status(rt, |s| s.host_key = Some(info));
        }
        transport_err(e)
    })?;
    *rt.transport.lock().unwrap() = Some(transport.clone());

    eng.set_phase(rt, ConnPhase::Deploying, Some("Checking host…".into()));
    let relay_port = profile.relay_port.unwrap_or(tf_proto::DEFAULT_RELAY_PORT);
    let progress = {
        let inner = Arc::downgrade(eng);
        let rtw = Arc::downgrade(rt);
        move |m: String| {
            if let (Some(eng), Some(rt)) = (inner.upgrade(), rtw.upgrade()) {
                eng.update_status(&rt, |s| s.message = Some(m));
            }
        }
    };
    let deployed = deploy::deploy(&*transport, profile.kind, relay_port, eng.artifacts(), &progress).await?;
    if let Some(newer) = &deployed.newer {
        log::info!("host {}: {newer} is newer than this app's tf-hostd; using it", rt.id);
    }

    eng.set_phase(rt, ConnPhase::Starting, Some("Starting tf-hostd…".into()));
    let mut argv = vec![deployed.hostd.clone(), "attach".into(), "--session".into(), profile.herdr_session.clone()];
    if let Some(p) = profile.relay_port {
        argv.extend(["--relay-port".into(), p.to_string()]);
    }
    if deployed.replaced {
        argv.push("--replace".into());
    }
    let mut child = transport.spawn(&Cmd::new(argv)).await.map_err(transport_err)?;
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        return Err(ApiError::new("internal", "tf-hostd attach has no stdio"));
    };
    let hello = ClientMsg::Hello {
        protocol: PROTOCOL_VERSION,
        client: ClientInfo {
            app: eng.cfg.client_app.clone(),
            version: eng.cfg.version.clone(),
            platform: eng.cfg.platform_name.clone(),
            device: eng.device_name(),
            features: Some(crate::link::requested_features()),
        },
        herdr_session: profile.herdr_session.clone(),
    };
    let sink = Arc::new(Sink { inner: Arc::downgrade(eng), rt: Arc::downgrade(rt), link_id: AtomicU64::new(0) });
    let link = Link::establish(stdin, stdout, child.stderr.take(), hello, sink.clone()).await?;
    sink.link_id.store(link.id, Ordering::SeqCst);
    *rt.link.lock().unwrap() = Some(link.clone());
    *online_at.lock().unwrap() = Some(Instant::now());
    let hostd_version = link.hostd_version.clone();
    log::info!("host {}: online (tf-hostd {}, client {}, {:?})", rt.id, hostd_version, link.client_id, link.features);
    eng.update_status(rt, |s| {
        s.phase = ConnPhase::Online;
        s.message = None;
        s.error = None;
        s.attempt = 0;
        s.next_retry_at = None;
        s.auth_url = None;
        s.last_online_at = Some(now_ms());
        s.hostd_version = Some(hostd_version);
    });
    rt.online.send_replace(true);
    // A host ≥ 0.7.0 routes notifications to the device in use: tell it what this one is doing.
    eng.presence_link_up(&link);
    tokio::spawn(sessions::reopen(session_host(eng, rt), link.clone()));

    let reason = tokio::select! {
        r = link.closed() => r,
        st = child.wait() => match st {
            Ok(st) => {
                let tail = link.stderr_tail();
                format!("tf-hostd attach exited (code {:?}){}", st.code, if tail.is_empty() { String::new() } else { format!(": {tail}") })
            }
            Err(e) => ApiError::from(e).message,
        },
        _ = lost.0.notified() => {
            lost.1.lock().unwrap().clone().unwrap_or_else(|| "connection lost".into())
        }
    };
    link.close(&reason);
    // Dropping the child kills `attach` if it is still running.
    drop(child);
    Ok(reason)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_schedule() {
        for (attempt, base) in [(1u32, 1u64), (2, 2), (3, 4), (4, 8), (5, 16), (6, 30), (7, 30), (20, 30)] {
            let d = backoff(attempt).as_millis() as u64;
            assert!(d >= base * 1000 && d <= base * 1200, "attempt {attempt}: {d}ms");
        }
    }

    #[test]
    fn fatality() {
        assert!(is_fatal(&ApiError::new("unsupported", "x")));
        assert!(!is_fatal(&ApiError::new("unsupported", "x").retryable()));
        assert!(!is_fatal(&ApiError::new("timeout", "x")));
        assert!(is_fatal(&ApiError::new("transport.hostKeyMismatch", "x")));
        assert!(!is_fatal(&ApiError::new("transport.timeout", "x").retryable()));
    }

    /// A WSL host's distro is held by one process across every attempt, held again when that
    /// process ended, moved with a distro change, and let go for other kinds, on release (not
    /// wanted any more) and with the host task.
    #[test]
    fn distro_hold_lifecycle() {
        // Fake keepalive `i`: running while `live[i]`; dropping it kills it.
        struct Fake(usize, Arc<Mutex<Vec<bool>>>);
        impl Holding for Fake {
            fn is_running(&mut self) -> bool {
                self.1.lock().unwrap()[self.0]
            }
        }
        impl Drop for Fake {
            fn drop(&mut self) {
                self.1.lock().unwrap()[self.0] = false;
            }
        }
        let live: Arc<Mutex<Vec<bool>>> = Arc::default();
        let started: Arc<Mutex<Vec<Option<String>>>> = Arc::default();
        let fail = Arc::new(AtomicBool::new(false));
        let mut hold = {
            let (live, started, fail) = (live.clone(), started.clone(), fail.clone());
            DistroHold::new(move |distro: Option<&str>| {
                if fail.load(Ordering::SeqCst) {
                    return Err(TransportError::Wsl("wsl.exe could not be started".into()));
                }
                started.lock().unwrap().push(distro.map(String::from));
                let mut l = live.lock().unwrap();
                l.push(true);
                Ok(Fake(l.len() - 1, live.clone()))
            })
        };
        let wsl = |distro: &str| HostProfile {
            id: "h".into(),
            name: "h".into(),
            kind: HostKind::Wsl,
            address: None,
            user: None,
            port: None,
            auth: None,
            key_path: None,
            distro: Some(distro.into()),
            herdr_session: "default".into(),
            color: None,
            auto_connect: false,
            relay_port: None,
            group: None,
        };
        let live_now = || live.lock().unwrap().clone();

        // Attempts and backoff: one process.
        for _ in 0..3 {
            hold.attempt("h", &wsl("Ubuntu"));
        }
        assert_eq!(*started.lock().unwrap(), [Some("Ubuntu".to_string())]);
        assert_eq!(live_now(), [true]);
        // It ended (`wsl --terminate`): the next attempt holds the distro again.
        live.lock().unwrap()[0] = false;
        hold.attempt("h", &wsl("Ubuntu"));
        assert_eq!(live_now(), [false, true]);
        // Another distro: the old hold goes.
        hold.attempt("h", &wsl("Debian"));
        assert_eq!(live_now(), [false, false, true]);
        assert_eq!(started.lock().unwrap()[2].as_deref(), Some("Debian"));
        // Not WSL any more.
        hold.attempt("h", &HostProfile { kind: HostKind::Local, distro: None, ..wsl("Debian") });
        assert_eq!(live_now(), [false, false, false]);
        // Disconnect, a permanent error, removal.
        hold.attempt("h", &wsl("Ubuntu"));
        hold.release();
        assert_eq!(live_now(), [false, false, false, false]);
        // A failed start holds nothing; the next attempt tries again, and the task's end lets go.
        fail.store(true, Ordering::SeqCst);
        hold.attempt("h", &wsl("Ubuntu"));
        fail.store(false, Ordering::SeqCst);
        hold.attempt("h", &wsl("Ubuntu"));
        assert_eq!(live_now(), [false, false, false, false, true]);
        drop(hold);
        assert_eq!(live_now(), [false; 5]);
    }
}
