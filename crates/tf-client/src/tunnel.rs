//! Preview tunnels: a loopback listener on this device whose connections are piped to
//! `host:port` as seen from the agent host, over the host's live transport.
//!
//! A tunnel normally listens on any free port. With `localPort` it listens on exactly that port
//! (sign-in callbacks: a provider redirects the device's browser to `http://localhost:<port>/…`,
//! which must reach the callback server listening on the same port on the host). Such a sign-in
//! tunnel lives only while its sign-in does: it closes once the host lists no sign-in waiting on
//! that callback port (`auth.list`, every [`FLOW_CHECK_EVERY`]), and by itself
//! [`SIGN_IN_TUNNEL_TTL`] after it was last opened.

use std::collections::BTreeMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use tf_proto::{ApiError, AuthFlowList, TunnelInfo, TunnelOpenParams};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::conn::HostRt;
use crate::util::{now_ms, rand_id};

/// A sign-in tunnel closes by itself this long after it was last opened, whatever the host says
/// (offline, or an older tf-hostd): the app closes it when the sign-in ends, but a window that went
/// away mid sign-in (reload, crash, closed tab) must not keep a well-known port of this device
/// (3000, …) forwarded to the host. Sign-ins wait at most 5 min for their callback (omp's limit;
/// the host stops an MCP sign-in after 6).
pub(crate) const SIGN_IN_TUNNEL_TTL: Duration = Duration::from_secs(10 * 60);
/// How often the host is asked whether a sign-in still waits on a sign-in tunnel's port.
pub(crate) const FLOW_CHECK_EVERY: Duration = Duration::from_secs(5);
const FLOW_CHECK_TIMEOUT: Duration = Duration::from_secs(10);

/// The host's answer to a [`FlowCheck`].
pub(crate) type FlowAnswer = Pin<Box<dyn Future<Output = Option<bool>> + Send>>;
/// Whether a sign-in on the host still waits on a callback port: `Some(false)` once none does,
/// `None` when the host can't tell now (offline, an older tf-hostd).
pub(crate) type FlowCheck = Arc<dyn Fn(u16) -> FlowAnswer + Send + Sync>;

struct Tunnel {
    info: TunnelInfo,
    /// One accept loop per listener (`127.0.0.1`, plus `::1` for a fixed port), and the watcher of
    /// a sign-in tunnel.
    tasks: Vec<JoinHandle<()>>,
    sign_in: Option<SignIn>,
}

/// A sign-in tunnel's lease, renewed by every open that hands it out.
#[derive(Clone, Copy)]
struct SignIn {
    /// When it closes by itself.
    closes_at: Instant,
    /// Opens that handed it out: a host answer from before the latest one says nothing about it.
    opens: u64,
}

impl Tunnel {
    fn stop(self) {
        for t in self.tasks {
            t.abort();
        }
    }
}

type Map = Mutex<BTreeMap<String, Tunnel>>;

#[derive(Default)]
pub(crate) struct Tunnels {
    map: Arc<Map>,
    /// Opens run one at a time, so two opens of one target (a UI effect running twice) share
    /// one tunnel instead of the second finding its fixed port taken by the first.
    opening: tokio::sync::Mutex<()>,
}

impl Tunnels {
    pub fn list(&self) -> Vec<TunnelInfo> {
        let mut v: Vec<_> = self.map.lock().unwrap().values().map(|t| t.info.clone()).collect();
        v.sort_by_key(|t| t.opened_at);
        v
    }

    /// Opens (or returns the existing) tunnel to `remote_host:port` on `rt`'s host. `closed` runs
    /// when a sign-in tunnel closes by itself (its sign-in ended, or its lease ran out).
    pub async fn open(&self, rt: &Arc<HostRt>, p: TunnelOpenParams, closed: impl Fn() + Send + 'static) -> Result<TunnelInfo, ApiError> {
        let remote_host = loopback_target(p.remote_host.as_deref())?;
        if p.port == 0 {
            return Err(ApiError::new("invalid_params", "port must be 1-65535"));
        }
        if p.local_port == Some(0) {
            return Err(ApiError::new("invalid_params", "localPort must be 1-65535"));
        }
        let _one_at_a_time = self.opening.lock().await;
        if let Some(info) = self.reuse(&rt.id, &remote_host, p.port, p.local_port)? {
            return Ok(info);
        }
        if rt.transport().is_none() {
            return Err(ApiError::new("not_connected", "the host is not connected").retryable());
        }
        let listeners = bind_local(p.local_port).await?;
        let local_port = listeners[0].local_addr().map_err(|e| ApiError::new("io_error", e.to_string()))?.port();
        let info = TunnelInfo {
            tunnel_id: rand_id("tun_"),
            host_id: rt.id.clone(),
            remote_host: remote_host.clone(),
            remote_port: p.port,
            local_port,
            url: format!("http://127.0.0.1:{local_port}/"),
            opened_at: now_ms(),
        };
        let tasks = listeners
            .into_iter()
            .map(|l| tokio::spawn(accept_loop(l, Arc::downgrade(rt), remote_host.clone(), p.port)))
            .collect();
        self.add(info.clone(), tasks, p.local_port.map(|_| host_flows(rt)), closed);
        Ok(info)
    }

    /// An open tunnel that serves the request (see [`reusable`]). A sign-in that gets it again
    /// renews its lease; a preview that gets a sign-in tunnel keeps it open.
    fn reuse(&self, host_id: &str, remote_host: &str, port: u16, local_port: Option<u16>) -> Result<Option<TunnelInfo>, ApiError> {
        let mut map = self.map.lock().unwrap();
        let Some(info) = reusable(map.values().map(|t| &t.info), host_id, remote_host, port, local_port)? else { return Ok(None) };
        if let Some(t) = map.get_mut(&info.tunnel_id) {
            t.sign_in = match (local_port, t.sign_in) {
                (Some(_), Some(s)) => Some(SignIn { closes_at: Instant::now() + SIGN_IN_TUNNEL_TTL, opens: s.opens + 1 }),
                _ => None,
            };
        }
        Ok(Some(info))
    }

    /// Registers a tunnel serving through `tasks`; a sign-in tunnel (`sign_in`: asks its host about
    /// its sign-in) is also watched.
    fn add(&self, info: TunnelInfo, mut tasks: Vec<JoinHandle<()>>, sign_in: Option<FlowCheck>, closed: impl Fn() + Send + 'static) {
        let lease = sign_in.is_some().then(|| SignIn { closes_at: Instant::now() + SIGN_IN_TUNNEL_TTL, opens: 1 });
        if let (Some(lease), Some(check)) = (lease, sign_in) {
            tasks.push(tokio::spawn(watch_sign_in(Arc::downgrade(&self.map), info.tunnel_id.clone(), info.remote_port, lease.closes_at, check, closed)));
        }
        self.map.lock().unwrap().insert(info.tunnel_id.clone(), Tunnel { info, tasks, sign_in: lease });
    }

    pub fn close(&self, tunnel_id: &str) -> bool {
        match self.map.lock().unwrap().remove(tunnel_id) {
            Some(t) => {
                t.stop();
                true
            }
            None => false,
        }
    }

    pub fn close_host(&self, host_id: &str) -> bool {
        let mut map = self.map.lock().unwrap();
        let ids: Vec<String> = map.values().filter(|t| t.info.host_id == host_id).map(|t| t.info.tunnel_id.clone()).collect();
        for id in &ids {
            if let Some(t) = map.remove(id) {
                t.stop();
            }
        }
        !ids.is_empty()
    }
}

/// [`FlowCheck`] against `rt`'s host: the sign-ins it runs (`auth.list`).
fn host_flows(rt: &Arc<HostRt>) -> FlowCheck {
    let rt = Arc::downgrade(rt);
    Arc::new(move |port: u16| -> FlowAnswer {
        let rt = rt.clone();
        Box::pin(async move {
            let link = rt.upgrade()?.link()?;
            let flows = link.request("auth.list", serde_json::json!({}), FLOW_CHECK_TIMEOUT).await.ok()?;
            let flows: AuthFlowList = serde_json::from_value(flows).ok()?;
            Some(flows.flows.iter().any(|f| !f.state.is_final() && f.callback_port == Some(port)))
        })
    })
}

/// Closes sign-in tunnel `id` once `waiting` says no sign-in waits on its remote `port` any more, or
/// its lease has run out (first `due`); then runs `closed`. Ends quietly when the tunnel was closed
/// meanwhile or a preview took it over.
async fn watch_sign_in(map: Weak<Map>, id: String, port: u16, mut due: Instant, waiting: FlowCheck, closed: impl Fn()) {
    let mut check_at = Instant::now() + FLOW_CHECK_EVERY;
    loop {
        tokio::time::sleep_until(due.min(check_at)).await;
        // The lease the host's answer is about: a sign-in that gets the tunnel meanwhile renews it.
        let mut over = None;
        if Instant::now() >= check_at {
            let Some(opens) = map.upgrade().and_then(|m| m.lock().unwrap().get(&id).and_then(|t| t.sign_in)).map(|s| s.opens) else { return };
            if waiting(port).await == Some(false) {
                over = Some(opens);
            }
            check_at = Instant::now() + FLOW_CHECK_EVERY;
        }
        let Some(map) = map.upgrade() else { return };
        let mut map = map.lock().unwrap();
        let Some(lease) = map.get(&id).and_then(|t| t.sign_in) else { return };
        let ended = over == Some(lease.opens);
        if !ended && Instant::now() < lease.closes_at {
            due = lease.closes_at;
            continue;
        }
        if let Some(t) = map.remove(&id) {
            let why = if ended { "its sign-in is over" } else { "by itself" };
            log::info!("tunnel {id}: sign-in tunnel on port {} closed ({why})", t.info.local_port);
            // Aborts this task too, at its next await: there is none left.
            t.stop();
        }
        drop(map);
        closed();
        return;
    }
}

/// An open tunnel that serves the request: same host and target, and the requested local port
/// (any, when none is requested). A requested port held by another of our tunnels is an error
/// that names it.
fn reusable<'a>(
    open: impl Iterator<Item = &'a TunnelInfo>,
    host_id: &str,
    remote_host: &str,
    port: u16,
    local_port: Option<u16>,
) -> Result<Option<TunnelInfo>, ApiError> {
    let mut holder = None;
    for t in open {
        if t.host_id == host_id && t.remote_host == remote_host && t.remote_port == port && local_port.is_none_or(|lp| t.local_port == lp) {
            return Ok(Some(t.clone()));
        }
        if local_port == Some(t.local_port) {
            holder = Some(t);
        }
    }
    match holder {
        Some(t) => Err(port_in_use(t.local_port, Some(format!("TeleFlock's tunnel to port {} of another host uses it", t.remote_port)))),
        None => Ok(None),
    }
}

fn port_in_use(port: u16, why: Option<String>) -> ApiError {
    let why = why.unwrap_or_else(|| "another program on this device uses it".into());
    ApiError::new("port_in_use", format!("port {port} is not free on this device: {why}"))
        .with_hint("Finish the sign-in by pasting the address the browser lands on, or free the port and try again.")
}

/// Listeners for a tunnel: any free `127.0.0.1` port, or exactly `local_port` on `127.0.0.1` plus
/// `::1` when this device has IPv6 (browsers may resolve `localhost` to either, and try `::1`
/// first: another program on `[::1]:<port>` would get the redirect, so that port is busy too).
async fn bind_local(local_port: Option<u16>) -> Result<Vec<TcpListener>, ApiError> {
    let Some(port) = local_port else {
        let l = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| ApiError::new("io_error", format!("bind: {e}")))?;
        return Ok(vec![l]);
    };
    let v4 = TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| match e.kind() {
        std::io::ErrorKind::AddrInUse => port_in_use(port, None),
        _ => ApiError::new("port_unavailable", format!("can't listen on port {port} of this device: {e}"))
            .with_hint("Finish the sign-in by pasting the address the browser lands on."),
    })?;
    let mut out = vec![v4];
    match TcpListener::bind(("::1", port)).await {
        Ok(v6) => out.push(v6),
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => return Err(port_in_use(port, None)),
        Err(e) => log::debug!("tunnel: [::1]:{port} not served: {e}"),
    }
    Ok(out)
}

async fn accept_loop(listener: TcpListener, rt: Weak<HostRt>, host: String, port: u16) {
    loop {
        let Ok((mut tcp, _)) = listener.accept().await else { continue };
        let Some(transport) = rt.upgrade().and_then(|rt| rt.transport()) else {
            // Host offline: refuse by closing; the browser shows a connection error.
            drop(tcp);
            continue;
        };
        let host = host.clone();
        tokio::spawn(async move {
            let _ = tcp.set_nodelay(true);
            match transport.forward_tcp(&host, port).await {
                Ok(mut remote) => {
                    if let Err(e) = tokio::io::copy_bidirectional(&mut tcp, &mut remote).await {
                        log::debug!("tunnel {host}:{port}: {e}");
                    }
                }
                Err(e) => log::warn!("tunnel {host}:{port}: forward failed: {e}"),
            }
        });
    }
}

/// Normalized tunnel target. Previews only reach services on the host's own loopback, so
/// a tunnel can never be pointed at other machines on the host's network.
fn loopback_target(remote_host: Option<&str>) -> Result<String, ApiError> {
    let h = remote_host.map(str::trim).filter(|h| !h.is_empty()).unwrap_or("127.0.0.1");
    let unbracketed = h.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(h);
    if h.eq_ignore_ascii_case("localhost") {
        return Ok("localhost".into());
    }
    match unbracketed.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) if ip == std::net::Ipv4Addr::LOCALHOST => Ok("127.0.0.1".into()),
        Ok(std::net::IpAddr::V6(ip)) if ip == std::net::Ipv6Addr::LOCALHOST => Ok("::1".into()),
        _ => Err(ApiError::new("invalid_params", format!("tunnels only reach the host's loopback, not `{h}`"))
            .with_hint("Use 127.0.0.1, ::1 or localhost.")),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Weak};
    use std::time::Duration;

    use super::{FLOW_CHECK_EVERY, FlowAnswer, FlowCheck, SIGN_IN_TUNNEL_TTL, Tunnels, accept_loop, bind_local, loopback_target, reusable};
    use tf_proto::TunnelInfo;

    fn tunnel(host: &str, remote_port: u16, local_port: u16) -> TunnelInfo {
        TunnelInfo {
            tunnel_id: format!("tun_{host}_{remote_port}_{local_port}"),
            host_id: host.into(),
            remote_host: "127.0.0.1".into(),
            remote_port,
            local_port,
            url: format!("http://127.0.0.1:{local_port}/"),
            opened_at: 0,
        }
    }

    #[test]
    fn reuse_matches_target_and_requested_port() {
        let open = [tunnel("a", 3000, 41000), tunnel("a", 1455, 1455)];
        let find = |host: &str, port: u16, local: Option<u16>| reusable(open.iter(), host, "127.0.0.1", port, local);
        // Any local port will do: the existing tunnel to the target is reused.
        assert_eq!(find("a", 3000, None).unwrap().unwrap().local_port, 41000);
        assert_eq!(find("a", 1455, None).unwrap().unwrap().local_port, 1455);
        // Same target on the same fixed port: reused.
        assert_eq!(find("a", 1455, Some(1455)).unwrap().unwrap().tunnel_id, "tun_a_1455_1455");
        // Same target, but the preview tunnel listens elsewhere: a new one is needed.
        assert!(find("a", 3000, Some(3000)).unwrap().is_none());
        // Another host's sign-in holds the port: named in the error.
        let err = find("b", 1455, Some(1455)).unwrap_err();
        assert_eq!(err.code, "port_in_use");
        assert!(err.message.contains("another host"), "{}", err.message);
        // Another target of the same host on that local port too.
        assert_eq!(find("a", 8080, Some(41000)).unwrap_err().code, "port_in_use");
    }

    #[tokio::test]
    async fn fixed_port_binds_exactly_that_port() {
        let probe = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let listeners = bind_local(Some(port)).await.unwrap();
        assert_eq!(listeners[0].local_addr().unwrap().port(), port);
        assert!(listeners[0].local_addr().unwrap().ip().is_loopback());
        for l in &listeners {
            assert_eq!(l.local_addr().unwrap().port(), port, "every listener uses the requested port");
        }
        // The bound port accepts connections.
        let connect = tokio::net::TcpStream::connect(("127.0.0.1", port));
        let (accepted, connected) = tokio::join!(listeners[0].accept(), connect);
        assert!(accepted.is_ok() && connected.is_ok());
        // Any free port without a request.
        let any = bind_local(None).await.unwrap();
        assert_eq!(any.len(), 1);
        assert_ne!(any[0].local_addr().unwrap().port(), 0);
    }

    #[tokio::test]
    async fn taken_port_is_port_in_use() {
        let other = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = other.local_addr().unwrap().port();
        let err = bind_local(Some(port)).await.unwrap_err();
        assert_eq!(err.code, "port_in_use", "{err:?}");
        assert!(!err.retryable);
        assert!(err.message.contains(&port.to_string()));
        assert!(err.hint.as_deref().unwrap_or_default().contains("pasting"), "{err:?}");
    }

    #[tokio::test]
    async fn port_taken_on_ipv6_loopback_is_port_in_use() {
        // Another program serves `localhost:<port>` over IPv6 only: a browser that tries `::1`
        // first would hand it the sign-in, so the tunnel must not claim the port.
        let Ok(other) = std::net::TcpListener::bind(("::1", 0)) else { return }; // no IPv6 here
        let port = other.local_addr().unwrap().port();
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_err() {
            return; // the IPv4 side is taken too, by chance
        }
        let err = bind_local(Some(port)).await.unwrap_err();
        assert_eq!(err.code, "port_in_use", "{err:?}");
        std::net::TcpListener::bind(("127.0.0.1", port)).expect("the IPv4 listener is not kept");
    }

    /// The host can't tell (offline, an older tf-hostd): only the lease counts.
    fn unknown() -> FlowCheck {
        Arc::new(|_: u16| -> FlowAnswer { Box::pin(async { None }) })
    }

    /// The host answers after `delay` whether a sign-in waits, as `waits` held when asked.
    fn host(waits: &Arc<AtomicBool>, delay: Duration) -> FlowCheck {
        let waits = waits.clone();
        Arc::new(move |_: u16| -> FlowAnswer {
            let w = waits.load(Ordering::SeqCst);
            Box::pin(async move {
                tokio::time::sleep(delay).await;
                Some(w)
            })
        })
    }

    /// A sign-in tunnel registered like `Tunnels::open` does, serving no host.
    async fn sign_in_tunnel(tunnels: &Tunnels, closed: &Arc<AtomicUsize>, check: FlowCheck) -> TunnelInfo {
        let listener = bind_local(None).await.unwrap().remove(0);
        let info = tunnel("a", 3000, listener.local_addr().unwrap().port());
        let task = tokio::spawn(accept_loop(listener, Weak::new(), "127.0.0.1".into(), 3000));
        let closed = closed.clone();
        tunnels.add(info.clone(), vec![task], Some(check), move || {
            closed.fetch_add(1, Ordering::SeqCst);
        });
        info
    }

    #[tokio::test(start_paused = true)]
    async fn sign_in_tunnel_closes_once_its_sign_in_is_over() {
        let tunnels = Tunnels::default();
        let closed = Arc::new(AtomicUsize::new(0));
        let waits = Arc::new(AtomicBool::new(true));
        let info = sign_in_tunnel(&tunnels, &closed, host(&waits, Duration::ZERO)).await;
        // The host's sign-in waits on the callback: the tunnel stays.
        tokio::time::sleep(FLOW_CHECK_EVERY * 20).await;
        assert_eq!(tunnels.list().len(), 1);
        // Over (done, cancelled, expired, or its window went away and it timed out): closed at
        // the next look, the app told, the port free again.
        waits.store(false, Ordering::SeqCst);
        tokio::time::sleep(FLOW_CHECK_EVERY + Duration::from_millis(1)).await;
        assert!(tunnels.list().is_empty());
        assert_eq!(closed.load(Ordering::SeqCst), 1);
        for _ in 0..10 {
            tokio::task::yield_now().await; // the aborted accept loop drops its listener
        }
        std::net::TcpListener::bind(("127.0.0.1", info.local_port)).expect("the port is released");
    }

    #[tokio::test(start_paused = true)]
    async fn a_sign_in_that_gets_the_tunnel_while_the_host_answers_keeps_it() {
        let tunnels = Tunnels::default();
        let closed = Arc::new(AtomicUsize::new(0));
        let waits = Arc::new(AtomicBool::new(false));
        let info = sign_in_tunnel(&tunnels, &closed, host(&waits, Duration::from_secs(1))).await;
        // The first look (+5 s) finds the last sign-in over; before the answer is back, a new
        // sign-in on the same port gets the tunnel.
        tokio::time::sleep(FLOW_CHECK_EVERY + Duration::from_millis(500)).await;
        assert_eq!(tunnels.reuse("a", "127.0.0.1", 3000, Some(info.local_port)).unwrap().unwrap().tunnel_id, info.tunnel_id);
        waits.store(true, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(tunnels.list().len(), 1, "an answer from before it was handed out again closes nothing");
        // Once that sign-in is over too: closed.
        waits.store(false, Ordering::SeqCst);
        tokio::time::sleep(FLOW_CHECK_EVERY * 2).await;
        assert!(tunnels.list().is_empty());
        assert_eq!(closed.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn sign_in_tunnel_closes_by_itself_unless_handed_out_again() {
        let tunnels = Tunnels::default();
        let closed = Arc::new(AtomicUsize::new(0));
        let info = sign_in_tunnel(&tunnels, &closed, unknown()).await;
        let port = info.local_port;
        // A sign-in gets it again a minute before it was due: its time starts over.
        tokio::time::sleep(SIGN_IN_TUNNEL_TTL - Duration::from_secs(60)).await;
        assert_eq!(tunnels.reuse("a", "127.0.0.1", 3000, Some(port)).unwrap().unwrap().tunnel_id, info.tunnel_id);
        tokio::time::sleep(Duration::from_secs(120)).await;
        assert_eq!(tunnels.list().len(), 1, "still open past its first due time");
        assert_eq!(closed.load(Ordering::SeqCst), 0);
        // Nobody wanted it for a whole TTL: closed, the app told, the port free again.
        tokio::time::sleep(SIGN_IN_TUNNEL_TTL).await;
        assert!(tunnels.list().is_empty());
        assert_eq!(closed.load(Ordering::SeqCst), 1);
        for _ in 0..10 {
            tokio::task::yield_now().await; // the aborted accept loop drops its listener
        }
        std::net::TcpListener::bind(("127.0.0.1", port)).expect("the port is released");
    }

    #[tokio::test(start_paused = true)]
    async fn sign_in_tunnel_taken_over_by_a_preview_or_closed_stays_quiet() {
        let tunnels = Tunnels::default();
        let closed = Arc::new(AtomicUsize::new(0));
        // A preview of the same target gets the sign-in tunnel: it stays open for good, whatever
        // the host says about sign-ins.
        let over = Arc::new(AtomicBool::new(false));
        let kept = sign_in_tunnel(&tunnels, &closed, host(&over, Duration::ZERO)).await;
        assert_eq!(tunnels.reuse("a", "127.0.0.1", 3000, None).unwrap().unwrap().tunnel_id, kept.tunnel_id);
        // Closed by the app before it was due: its watcher ends without a word.
        let gone = tunnel("b", 1455, 1455);
        tunnels.add(gone.clone(), vec![], Some(unknown()), {
            let closed = closed.clone();
            move || {
                closed.fetch_add(1, Ordering::SeqCst);
            }
        });
        assert!(tunnels.close(&gone.tunnel_id));
        tokio::time::sleep(SIGN_IN_TUNNEL_TTL * 3).await;
        assert_eq!(tunnels.list().iter().map(|t| t.tunnel_id.as_str()).collect::<Vec<_>>(), [kept.tunnel_id.as_str()]);
        assert_eq!(closed.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn only_loopback_targets() {
        assert_eq!(loopback_target(None).unwrap(), "127.0.0.1");
        assert_eq!(loopback_target(Some(" ")).unwrap(), "127.0.0.1");
        assert_eq!(loopback_target(Some("127.0.0.1")).unwrap(), "127.0.0.1");
        assert_eq!(loopback_target(Some("LocalHost")).unwrap(), "localhost");
        assert_eq!(loopback_target(Some("::1")).unwrap(), "::1");
        assert_eq!(loopback_target(Some("[::1]")).unwrap(), "::1");
        for bad in ["10.0.0.5", "127.0.0.2", "0.0.0.0", "169.254.169.254", "example.com", "localhost.evil.com", "::", "[::ffff:127.0.0.1]"] {
            assert_eq!(loopback_target(Some(bad)).unwrap_err().code, "invalid_params", "{bad}");
        }
    }
}
