//! Preview tunnels: a loopback listener on this device whose connections are piped to
//! `host:port` as seen from the agent host, over the host's live transport.
//!
//! A tunnel normally listens on any free port. With `localPort` it listens on exactly that port
//! (sign-in callbacks: a provider redirects the device's browser to `http://localhost:<port>/…`,
//! which must reach the callback server listening on the same port on the host).

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, Weak};

use tf_proto::{ApiError, TunnelInfo, TunnelOpenParams};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use crate::conn::HostRt;
use crate::util::{now_ms, rand_id};

struct Tunnel {
    info: TunnelInfo,
    /// One accept loop per listener (`127.0.0.1`, plus `::1` for a fixed port).
    tasks: Vec<JoinHandle<()>>,
}

impl Tunnel {
    fn stop(self) {
        for t in self.tasks {
            t.abort();
        }
    }
}

#[derive(Default)]
pub(crate) struct Tunnels {
    map: Mutex<BTreeMap<String, Tunnel>>,
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

    /// Opens (or returns the existing) tunnel to `remote_host:port` on `rt`'s host.
    pub async fn open(&self, rt: &Arc<HostRt>, p: TunnelOpenParams) -> Result<TunnelInfo, ApiError> {
        let remote_host = loopback_target(p.remote_host.as_deref())?;
        if p.port == 0 {
            return Err(ApiError::new("invalid_params", "port must be 1-65535"));
        }
        if p.local_port == Some(0) {
            return Err(ApiError::new("invalid_params", "localPort must be 1-65535"));
        }
        let _one_at_a_time = self.opening.lock().await;
        {
            let map = self.map.lock().unwrap();
            if let Some(info) = reusable(map.values().map(|t| &t.info), &rt.id, &remote_host, p.port, p.local_port)? {
                return Ok(info);
            }
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
        self.map.lock().unwrap().insert(info.tunnel_id.clone(), Tunnel { info: info.clone(), tasks });
        Ok(info)
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
/// `::1` when that is free too (browsers may resolve `localhost` to either).
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
    use super::{bind_local, loopback_target, reusable};
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
