//! Hermetic test fixtures: an in-process russh server that behaves like Tailscale SSH
//! (`none` auth, optional check-mode banner + delayed accept, deny, OpenSSH-like refusal),
//! runs exec requests with a real `sh -c`, proxies `direct-tcpip`, plus a TCP proxy that
//! can freeze or cut connections and a TCP echo server.

#![allow(dead_code)]

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use russh::keys::{PrivateKey, decode_secret_key};
use russh::server::{self, Auth, ChannelOpenHandle, Msg, Session};
use russh::{Channel, ChannelId, ChannelMsg, ChannelOpenFailure, ChannelWriteHalf, Disconnect, MethodKind, MethodSet, SshId};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use tf_transport::{ConnectOptions, HostKind, HostProfile, TransportEvent};

pub const KEY_A: &str = include_str!("../fixtures/host_key_a");
pub const KEY_B: &str = include_str!("../fixtures/host_key_b");
pub const CHECK_URL: &str = "https://login.tailscale.com/a/abc123def";

pub fn key(pem: &str) -> PrivateKey {
    decode_secret_key(pem, None).expect("fixture key")
}

/// A fresh temp dir (removed on drop).
pub struct TempDir(pub PathBuf);
impl TempDir {
    pub fn new(tag: &str) -> Self {
        static N: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!("tf-transport-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Clone, Debug)]
pub enum AuthMode {
    /// Tailscale accept mode.
    Accept,
    /// Check mode: banner with a login URL, then hold `none` for `delay`, then accept.
    Check { delay: Duration },
    /// Policy denial: a `tailscale: …` banner, then the server drops the connection.
    Deny,
    /// A regular sshd: `none` rejected with publickey/password offered.
    OpenSsh,
}

struct Shared {
    config: Mutex<Arc<server::Config>>,
    auth: Mutex<AuthMode>,
    /// Server session handles (for graceful disconnects).
    sessions: Mutex<Vec<server::Handle>>,
    /// HOME for exec'd commands.
    home: PathBuf,
    connections: AtomicUsize,
}

pub struct TestServer {
    pub addr: SocketAddr,
    shared: Arc<Shared>,
    accept: JoinHandle<()>,
}

fn config(pem: &str) -> Arc<server::Config> {
    Arc::new(server::Config {
        server_id: SshId::Standard("SSH-2.0-Tailscale".into()),
        methods: MethodSet::from(&[MethodKind::None, MethodKind::Password, MethodKind::PublicKey][..]),
        keys: vec![key(pem)],
        auth_rejection_time: Duration::from_millis(5),
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    })
}

impl TestServer {
    pub async fn start(pem: &str, auth: AuthMode, home: PathBuf) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let shared = Arc::new(Shared {
            config: Mutex::new(config(pem)),
            auth: Mutex::new(auth),
            sessions: Mutex::new(Vec::new()),
            home,
            connections: AtomicUsize::new(0),
        });
        let s = shared.clone();
        let accept = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { return };
                s.connections.fetch_add(1, Ordering::SeqCst);
                let cfg = s.config.lock().unwrap().clone();
                let handler = ServerHandler { auth: s.auth.lock().unwrap().clone(), channels: HashMap::new(), home: s.home.clone() };
                let s2 = s.clone();
                tokio::spawn(async move {
                    if let Ok(running) = server::run_stream(cfg, stream, handler).await {
                        s2.sessions.lock().unwrap().push(running.handle());
                        let _ = running.await;
                    }
                });
            }
        });
        Self { addr, shared, accept }
    }

    pub fn set_key(&self, pem: &str) {
        *self.shared.config.lock().unwrap() = config(pem);
    }

    pub fn connections(&self) -> usize {
        self.shared.connections.load(Ordering::SeqCst)
    }

    /// Send SSH_MSG_DISCONNECT on every live session.
    pub async fn disconnect_all(&self, message: &str) {
        let handles: Vec<_> = self.shared.sessions.lock().unwrap().drain(..).collect();
        for h in handles {
            let _ = h.disconnect(Disconnect::ByApplication, message.into(), "en".into()).await;
        }
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.accept.abort();
    }
}

struct ServerHandler {
    auth: AuthMode,
    channels: HashMap<ChannelId, Channel<Msg>>,
    home: PathBuf,
}

impl server::Handler for ServerHandler {
    type Error = russh::Error;

    async fn authentication_banner(&mut self) -> Result<Option<String>, Self::Error> {
        Ok(match self.auth {
            AuthMode::Check { .. } => Some(format!("# Tailscale SSH requires an additional check.\n# To authenticate, visit: {CHECK_URL}\n")),
            AuthMode::Deny => Some("tailscale: access denied\n".into()),
            _ => None,
        })
    }

    async fn auth_none(&mut self, _user: &str) -> Result<Auth, Self::Error> {
        match self.auth.clone() {
            AuthMode::Accept => Ok(Auth::Accept),
            AuthMode::Check { delay } => {
                tokio::time::sleep(delay).await;
                Ok(Auth::Accept)
            }
            // Like Tailscale's errTerminal: no USERAUTH_FAILURE, the connection just ends.
            AuthMode::Deny => {
                tokio::time::sleep(Duration::from_millis(50)).await;
                Err(russh::Error::Disconnect)
            }
            AuthMode::OpenSsh => Ok(Auth::Reject {
                proceed_with_methods: Some(MethodSet::from(&[MethodKind::PublicKey, MethodKind::Password][..])),
                partial_success: false,
            }),
        }
    }

    async fn channel_open_session(&mut self, channel: Channel<Msg>, reply: ChannelOpenHandle, _s: &mut Session) -> Result<(), Self::Error> {
        reply.accept().await;
        self.channels.insert(channel.id(), channel);
        Ok(())
    }

    async fn exec_request(&mut self, ch: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        session.channel_success(ch)?;
        if let Some(channel) = self.channels.remove(&ch) {
            tokio::spawn(run_exec(channel, String::from_utf8_lossy(data).into_owned(), self.home.clone()));
        }
        Ok(())
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host: &str,
        port: u32,
        _orig: &str,
        _orig_port: u32,
        reply: ChannelOpenHandle,
        _s: &mut Session,
    ) -> Result<(), Self::Error> {
        if host == "forbidden.invalid" {
            reply.reject(ChannelOpenFailure::AdministrativelyProhibited).await;
            return Ok(());
        }
        match TcpStream::connect((host, port as u16)).await {
            Ok(mut tcp) => {
                reply.accept().await;
                tokio::spawn(async move {
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut stream, &mut tcp).await;
                });
            }
            Err(_) => reply.reject(ChannelOpenFailure::ConnectFailed).await,
        }
        Ok(())
    }
}

async fn pump(mut r: impl AsyncRead + Unpin, wr: Arc<ChannelWriteHalf<Msg>>, ext: Option<u32>) {
    let mut buf = vec![0u8; 32 * 1024];
    loop {
        let n = match r.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        let chunk = Bytes::copy_from_slice(&buf[..n]);
        let res = match ext {
            None => wr.data_bytes(chunk).await,
            Some(e) => wr.extended_data_bytes(e, chunk).await,
        };
        if res.is_err() {
            return;
        }
    }
}

/// Run an exec request the way sshd does: `sh -c <command>` with stdio on the channel.
async fn run_exec(channel: Channel<Msg>, command: String, home: PathBuf) {
    let (mut rd, wr) = channel.split();
    let wr = Arc::new(wr);
    let mut child = match tokio::process::Command::new("sh")
        .arg("-c")
        .arg(&command)
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("SHELL", "/bin/sh")
        .env("HOME", &home)
        .current_dir(&home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            let _ = wr.extended_data_bytes(1, Bytes::from(e.to_string())).await;
            let _ = wr.exit_status(127).await;
            let _ = wr.close().await;
            return;
        }
    };
    let out = tokio::spawn(pump(child.stdout.take().unwrap(), wr.clone(), None));
    let err = tokio::spawn(pump(child.stderr.take().unwrap(), wr.clone(), Some(1)));
    // Feed stdin from a separate task: blocking here would stall the whole server session.
    let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<Bytes>();
    let mut child_stdin = child.stdin.take().unwrap();
    tokio::spawn(async move {
        while let Some(b) = stdin_rx.recv().await {
            if child_stdin.write_all(&b).await.is_err() {
                return;
            }
        }
    });
    let mut stdin = Some(stdin_tx);
    let mut rd_open = true;
    let status = loop {
        tokio::select! {
            st = child.wait() => break st,
            msg = rd.wait(), if rd_open => match msg {
                Some(ChannelMsg::Data { data }) => {
                    if let Some(tx) = &stdin {
                        let _ = tx.send(data);
                    }
                }
                Some(ChannelMsg::Eof) => stdin = None,
                // Commands carrying `tf-ignore-signal` simulate a host without signal support.
                Some(ChannelMsg::Signal { .. }) if !command.contains("tf-ignore-signal") => { let _ = child.start_kill(); }
                Some(ChannelMsg::Close) | None => { rd_open = false; let _ = child.start_kill(); }
                Some(_) => {}
            },
        }
    };
    let _ = out.await;
    let _ = err.await;
    let code = match status {
        Ok(s) => s.code().unwrap_or_else(|| {
            use std::os::unix::process::ExitStatusExt;
            128 + s.signal().unwrap_or(0)
        }),
        Err(_) => 255,
    };
    let _ = wr.exit_status(code as u32).await;
    let _ = wr.eof().await;
    let _ = wr.close().await;
}

/// TCP echo server.
pub async fn echo_server() -> SocketAddr {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            tokio::spawn(async move {
                let (mut r, mut w) = s.split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            });
        }
    });
    addr
}

/// A port with nothing listening. The returned socket is bound but never listens, so
/// connects are refused and parallel tests can't grab the port while it is held.
pub fn dead_port() -> (tokio::net::TcpSocket, u16) {
    let s = tokio::net::TcpSocket::new_v4().unwrap();
    s.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let port = s.local_addr().unwrap().port();
    (s, port)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ProxyState {
    Flowing,
    /// Keep sockets open but stop forwarding (a stalled network path).
    Frozen,
    /// Drop every connection (abrupt network loss).
    Cut,
}

/// TCP proxy in front of the SSH server for network-failure tests.
pub struct Proxy {
    pub addr: SocketAddr,
    state: watch::Sender<ProxyState>,
}

impl Proxy {
    pub async fn start(upstream: SocketAddr) -> Self {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let state = watch::Sender::new(ProxyState::Flowing);
        let st = state.clone();
        tokio::spawn(async move {
            while let Ok((down, _)) = l.accept().await {
                let Ok(up) = TcpStream::connect(upstream).await else { continue };
                let (dr, dw) = down.into_split();
                let (ur, uw) = up.into_split();
                tokio::spawn(forward(dr, uw, st.subscribe()));
                tokio::spawn(forward(ur, dw, st.subscribe()));
            }
        });
        Self { addr, state }
    }

    pub fn set(&self, s: ProxyState) {
        self.state.send_replace(s);
    }
}

async fn forward(mut r: tokio::net::tcp::OwnedReadHalf, mut w: tokio::net::tcp::OwnedWriteHalf, mut state: watch::Receiver<ProxyState>) {
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let n = tokio::select! {
            n = r.read(&mut buf) => match n { Ok(0) | Err(_) => return, Ok(n) => n },
            _ = state.wait_for(|s| *s == ProxyState::Cut) => return,
        };
        // Hold bytes while frozen; drop everything when cut.
        match state.wait_for(|s| *s != ProxyState::Frozen).await.map(|s| *s) {
            Ok(ProxyState::Flowing) => {}
            _ => return,
        }
        if w.write_all(&buf[..n]).await.is_err() {
            return;
        }
    }
}

pub fn profile(addr: SocketAddr) -> HostProfile {
    HostProfile {
        id: "test".into(),
        name: "test".into(),
        kind: HostKind::TailscaleSsh,
        address: Some(addr.ip().to_string()),
        user: Some("tester".into()),
        port: Some(addr.port()),
        distro: None,
        herdr_session: "default".into(),
        color: None,
        auto_connect: false,
        relay_port: None,
    }
}

pub fn opts(dir: &TempDir) -> ConnectOptions {
    let mut o = ConnectOptions::new(dir.0.join("known_hosts"));
    o.connect_timeout = Duration::from_secs(3);
    o.handshake_timeout = Duration::from_secs(5);
    o
}

/// Collects transport events in the background.
pub struct Events {
    pub tx: mpsc::Sender<TransportEvent>,
    seen: Arc<Mutex<Vec<TransportEvent>>>,
    notify: Arc<tokio::sync::Notify>,
}

impl Events {
    pub fn new() -> Self {
        let (tx, mut rx) = mpsc::channel(256);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let notify = Arc::new(tokio::sync::Notify::new());
        let (s, n) = (seen.clone(), notify.clone());
        tokio::spawn(async move {
            while let Some(e) = rx.recv().await {
                s.lock().unwrap().push(e);
                n.notify_waiters();
            }
        });
        Self { tx, seen, notify }
    }

    pub fn all(&self) -> Vec<TransportEvent> {
        self.seen.lock().unwrap().clone()
    }

    /// Wait until an event matching `f` arrives (or panic after `within`).
    pub async fn wait_for(&self, within: Duration, f: impl Fn(&TransportEvent) -> bool) -> TransportEvent {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            let notified = self.notify.notified();
            if let Some(e) = self.all().into_iter().find(|e| f(e)) {
                return e;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                panic!("event not seen within {within:?}; got {:?}", self.all());
            }
        }
    }
}
