//! Per-host connection runtime (architecture §5.2): the phase state machine with backoff,
//! deploy, `tf-hostd attach`, the protocol link, and the client-side view of the host
//! (status, last state, notifications, open sessions/terminals).

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use serde_json::Value;
use tf_proto::{
    ApiError, AppEvent, ClientInfo, ClientMsg, ConnPhase, ConnStatus, HostKind, HostProfile, HostState, Millis,
    Notification, PROTOCOL_VERSION, ServerMsg, SessionEvent, SessionSnapshot, StatePatch, TermEvent,
};
use tf_transport::{Cmd, ConnectOptions, Transport, TransportEvent};
use tokio::sync::{Notify, mpsc, watch};

use crate::deploy;
use crate::engine::Inner;
use crate::link::{Link, LinkSink};
use crate::state::apply_patches;
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
    /// Recent notifications for `notification_action`.
    pub notifications: VecDeque<Notification>,
    /// Open sessions (`session.open` params by agent id), re-opened after a reconnect.
    pub sessions: HashMap<String, Value>,
    pub terms: HashSet<String>,
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
}

const NOTIFICATION_RING: usize = 100;
const FATAL_CODES: &[&str] =
    &["unsupported", "version_mismatch", "invalid_params", "not_found", "permission_denied", "auth_denied"];

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
    }
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
                sessions: HashMap::new(),
                terms: HashSet::new(),
            }),
            link: Mutex::new(None),
            transport: Mutex::new(None),
            online: watch::channel(false).0,
            wanted: AtomicBool::new(false),
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

    pub fn find_notification(&self, id: &str) -> Option<Notification> {
        self.view.lock().unwrap().notifications.iter().find(|n| n.id == id).cloned()
    }

    pub fn remember_notification(&self, n: Notification) {
        let mut v = self.view.lock().unwrap();
        if v.notifications.len() == NOTIFICATION_RING {
            v.notifications.pop_front();
        }
        v.notifications.push_back(n);
    }
}

/// Bridges the link's pushes into engine state and events.
struct Sink {
    inner: Weak<Inner>,
    rt: Weak<HostRt>,
}

impl LinkSink for Sink {
    fn snapshot(&self, rev: u64, state: HostState) {
        let (Some(inner), Some(rt)) = (self.inner.upgrade(), self.rt.upgrade()) else { return };
        {
            let _g = inner.emit_lock.lock().unwrap();
            let mut v = rt.view.lock().unwrap();
            v.state = Some((rev, state.clone()));
            v.live = true;
            v.dirty = true;
            inner.send(AppEvent::HostSnapshot { host_id: rt.id.clone(), rev, state });
        }
        inner.refresh_badge();
    }

    fn patch(&self, rev: u64, ops: Vec<StatePatch>) {
        let (Some(inner), Some(rt)) = (self.inner.upgrade(), self.rt.upgrade()) else { return };
        {
            let _g = inner.emit_lock.lock().unwrap();
            let mut v = rt.view.lock().unwrap();
            if let Some((r, s)) = v.state.as_mut() {
                apply_patches(s, ops.clone());
                *r = rev;
            }
            v.dirty = true;
            inner.send(AppEvent::HostPatch { host_id: rt.id.clone(), rev, ops });
        }
        inner.refresh_badge();
    }

    fn push(&self, msg: ServerMsg) {
        let (Some(inner), Some(rt)) = (self.inner.upgrade(), self.rt.upgrade()) else { return };
        let host_id = rt.id.clone();
        match msg {
            ServerMsg::Pulse { at, pulses } => inner.send(AppEvent::Pulse { host_id, at, pulses }),
            ServerMsg::Session { agent_id, ev } => {
                if matches!(ev, SessionEvent::Ended { .. }) {
                    rt.view.lock().unwrap().sessions.remove(&agent_id);
                }
                inner.send(AppEvent::Session { host_id, agent_id, ev })
            }
            ServerMsg::Term { term_id, ev } => {
                if matches!(ev, TermEvent::Closed { .. }) {
                    rt.view.lock().unwrap().terms.remove(&term_id);
                }
                inner.send(AppEvent::Term { host_id, term_id, ev })
            }
            ServerMsg::Notify { notification } => inner.on_notify(&rt, notification),
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

/// Host task: runs until `Shutdown` (or the engine is dropped).
pub(crate) async fn run(inner: Weak<Inner>, rt: Arc<HostRt>, mut rx: mpsc::UnboundedReceiver<ConnCmd>) {
    let mut attempt: u32 = 0;
    loop {
        if !rt.wanted.load(Ordering::SeqCst) {
            match rx.recv().await {
                None | Some(ConnCmd::Shutdown) => break,
                Some(ConnCmd::Connect | ConnCmd::Reconnect) => {
                    rt.wanted.store(true, Ordering::SeqCst);
                    attempt = 0;
                    if let Some(i) = inner.upgrade() {
                        i.refresh_keep_alive();
                    }
                }
                Some(ConnCmd::Disconnect) => continue,
            }
        }
        let Some(eng) = inner.upgrade() else { break };
        let Some(profile) = eng.profile(&rt.id) else { break };
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
                    eng.update_status(&rt, |s| {
                        s.phase = ConnPhase::Error;
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

/// Closes link + transport, ends open terminals, marks state stale, flushes the cache.
async fn teardown(eng: &Arc<Inner>, rt: &Arc<HostRt>) {
    let link = rt.link.lock().unwrap().take();
    if let Some(link) = link {
        link.bye();
        link.close("disconnected");
    }
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

    let opts = ConnectOptions::new(eng.data_dir().join("known_hosts"));
    let transport = tf_transport::connect(profile, &opts, ev_tx).await.map_err(transport_err)?;
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
        },
        herdr_session: profile.herdr_session.clone(),
    };
    let sink = Arc::new(Sink { inner: Arc::downgrade(eng), rt: Arc::downgrade(rt) });
    let link = Link::establish(stdin, stdout, child.stderr.take(), hello, sink).await?;
    *rt.link.lock().unwrap() = Some(link.clone());
    *online_at.lock().unwrap() = Some(Instant::now());
    let hostd_version = link.hostd_version.clone();
    log::info!("host {}: online (tf-hostd {}, client {})", rt.id, hostd_version, link.client_id);
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
    tokio::spawn(reopen_sessions(Arc::downgrade(eng), rt.clone(), link.clone()));

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

/// After a reconnect, re-subscribe sessions the UI still has open and push a `reset`.
async fn reopen_sessions(inner: Weak<Inner>, rt: Arc<HostRt>, link: Arc<Link>) {
    let open: Vec<(String, Value)> =
        rt.view.lock().unwrap().sessions.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    for (agent_id, params) in open {
        let r = link.request("session.open", params, crate::link::DEFAULT_TIMEOUT).await;
        let Some(eng) = inner.upgrade() else { return };
        let ev = match r.and_then(|v| {
            serde_json::from_value::<SessionSnapshot>(v).map_err(|e| ApiError::new("internal", e.to_string()))
        }) {
            Ok(snapshot) => SessionEvent::Reset { snapshot },
            Err(e) if e.code == "not_connected" => return,
            Err(e) => {
                rt.view.lock().unwrap().sessions.remove(&agent_id);
                SessionEvent::Ended { reason: e.message }
            }
        };
        eng.send(AppEvent::Session { host_id: rt.id.clone(), agent_id, ev });
    }
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
}
