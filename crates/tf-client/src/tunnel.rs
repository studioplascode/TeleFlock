//! Preview tunnels: a loopback listener on this device whose connections are piped to
//! `host:port` as seen from the agent host, over the host's live transport.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, Weak};

use tf_proto::{ApiError, TunnelInfo, TunnelOpenParams};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use crate::conn::HostRt;
use crate::util::{now_ms, rand_id};

struct Tunnel {
    info: TunnelInfo,
    task: JoinHandle<()>,
}

#[derive(Default)]
pub(crate) struct Tunnels {
    map: Mutex<BTreeMap<String, Tunnel>>,
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
        if let Some(t) = self
            .map
            .lock()
            .unwrap()
            .values()
            .find(|t| t.info.host_id == rt.id && t.info.remote_host == remote_host && t.info.remote_port == p.port)
        {
            return Ok(t.info.clone());
        }
        if rt.transport().is_none() {
            return Err(ApiError::new("not_connected", "the host is not connected").retryable());
        }
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| ApiError::new("io_error", format!("bind: {e}")))?;
        let local_port = listener.local_addr().map_err(|e| ApiError::new("io_error", e.to_string()))?.port();
        let info = TunnelInfo {
            tunnel_id: rand_id("tun_"),
            host_id: rt.id.clone(),
            remote_host: remote_host.clone(),
            remote_port: p.port,
            local_port,
            url: format!("http://127.0.0.1:{local_port}/"),
            opened_at: now_ms(),
        };
        let task = tokio::spawn(accept_loop(listener, Arc::downgrade(rt), remote_host, p.port));
        self.map.lock().unwrap().insert(info.tunnel_id.clone(), Tunnel { info: info.clone(), task });
        Ok(info)
    }

    pub fn close(&self, tunnel_id: &str) -> bool {
        match self.map.lock().unwrap().remove(tunnel_id) {
            Some(t) => {
                t.task.abort();
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
                t.task.abort();
            }
        }
        !ids.is_empty()
    }
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
    use super::loopback_target;

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
