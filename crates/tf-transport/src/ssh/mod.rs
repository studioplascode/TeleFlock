//! Tailscale SSH transport over one long-lived russh connection.
//!
//! * TCP dial with friendly resolve/connect errors, then SSH with the `ring` backend.
//! * Host key: pinned in the app's known_hosts file; a key seen for the first time is
//!   pinned when `ConnectOptions::host_key_policy` trusts it, else the connect fails with
//!   `HostKeyUnconfirmed`. A mismatch is always a hard error.
//! * Auth: `none` only (Tailscale identity comes from the tailnet). A banner carrying a
//!   URL (check mode) becomes `AuthUrl` + `authRequired`, and we keep waiting.
//! * russh's own keepalive is off (it busy-loops while auth is pending in 0.64.1); after
//!   auth our own ping task measures latency and detects dead links.
//! * Exec/spawn run through `sh -c 'exec "${SHELL:-/bin/sh}" -lc "$1"'` with POSIX-quoted argv.

mod known_hosts;

use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::task::{Context, Poll, ready};
use std::time::{Duration, Instant};

use russh::client::{self, AuthResult, DisconnectReason, Handle, Msg, Session};
use russh::keys::PublicKeyOrCertificate;
use russh::{ChannelMsg, ChannelOpenFailure, ChannelReadHalf, ChannelWriteHalf, Disconnect, Sig};
use bytes::Bytes;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, watch};

use crate::{
    BoxedStream, Child, Cmd, ConnPhase, ConnectOptions, ExitStatus, HostKeyCheck, HostKeyDecision, HostKeyPolicy, HostKind,
    HostProfile, Output, Transport, TransportError, TransportEvent, quote,
};
pub use known_hosts::{KnownHosts, Verdict, fingerprint, host_pattern};

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Send without blocking the caller; falls back to a task when the channel is full.
fn emit_nowait(events: &mpsc::Sender<TransportEvent>, ev: TransportEvent) {
    if let Err(mpsc::error::TrySendError::Full(ev)) = events.try_send(ev)
        && let Ok(rt) = tokio::runtime::Handle::try_current()
    {
        let tx = events.clone();
        rt.spawn(async move {
            let _ = tx.send(ev).await;
        });
    }
}

/// Connection state shared by the transport, the russh handler and the ping task.
struct Shared {
    events: mpsc::Sender<TransportEvent>,
    /// Auth succeeded and the transport was handed out (only then is `Closed` emitted).
    established: AtomicBool,
    /// The connection has ended (or is ending); `Closed` was emitted if established.
    finished: AtomicBool,
    closed_by_app: AtomicBool,
    /// Why the session ended (remote disconnect message, network error, keepalive).
    reason: Mutex<Option<String>>,
    /// Flipped to `true` on finish; stops the ping task.
    stop: watch::Sender<bool>,
}

impl Shared {
    fn set_reason(&self, reason: String) {
        lock(&self.reason).get_or_insert(reason);
    }

    fn reason(&self) -> String {
        lock(&self.reason).clone().unwrap_or_else(|| "connection lost".into())
    }

    fn is_finished(&self) -> bool {
        self.finished.load(Ordering::SeqCst)
    }

    /// Error for operations on a finished connection.
    fn closed_error(&self) -> TransportError {
        if self.closed_by_app.load(Ordering::SeqCst) { TransportError::Closed(None) } else { TransportError::Closed(Some(self.reason())) }
    }

    /// Mark the connection finished. Returns true when the caller must emit `Closed`
    /// (first call on an established connection).
    fn finish(&self) -> bool {
        if self.finished.swap(true, Ordering::SeqCst) {
            return false;
        }
        self.stop.send_replace(true);
        self.established.load(Ordering::SeqCst)
    }
}

struct ClientHandler {
    shared: Arc<Shared>,
    known_hosts: KnownHosts,
    host_pattern: String,
    /// Resolved peer address of the TCP connection.
    peer: std::net::IpAddr,
    policy: HostKeyPolicy,
    banners: Arc<Mutex<Vec<String>>>,
}

impl Drop for ClientHandler {
    /// The handler lives inside the russh session task, so dropping it means the session
    /// ended, whichever way (russh skips `disconnected` on some error paths).
    fn drop(&mut self) {
        if self.shared.finish() {
            let reason = if self.shared.closed_by_app.load(Ordering::SeqCst) { None } else { Some(self.shared.reason()) };
            emit_nowait(&self.shared.events, TransportEvent::Closed(reason));
        }
    }
}

/// First `https://` URL in a banner (trailing punctuation trimmed).
pub(crate) fn banner_url(text: &str) -> Option<String> {
    let start = text.find("https://")?;
    let url: String = text[start..].chars().take_while(|c| !c.is_whitespace()).collect();
    let url = url.trim_end_matches(['.', ',', ';', ':', ')', ']', '>', '"', '\'']);
    (url.len() > "https://".len()).then(|| url.to_owned())
}

/// Banner text without `#` comment decoration and blank lines.
pub(crate) fn tidy_banner(text: &str) -> String {
    text.lines()
        .map(|l| l.trim().trim_start_matches('#').trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

impl client::Handler for ClientHandler {
    type Error = TransportError;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key,
            PublicKeyOrCertificate::Certificate(_) => {
                return Err(TransportError::HostKeyStore("host presented an SSH certificate; only plain host keys are supported".into()));
            }
        };
        let check = HostKeyCheck {
            host: self.host_pattern.clone(),
            address: self.peer,
            algorithm: key.algorithm().to_string(),
            fingerprint: fingerprint(key),
        };
        let policy = &self.policy;
        match self.known_hosts.verify(&self.host_pattern, key, || policy.decide(&check) == HostKeyDecision::Trust)? {
            Verdict::Known => Ok(true),
            Verdict::Learned => {
                let msg = format!("Trusted new host key {} (first connection)", check.fingerprint);
                let _ = self.shared.events.send(TransportEvent::Phase(ConnPhase::Connecting, Some(msg))).await;
                Ok(true)
            }
            Verdict::Unconfirmed => Err(TransportError::HostKeyUnconfirmed {
                host: check.host,
                address: check.address.to_string(),
                algorithm: check.algorithm,
                fingerprint: check.fingerprint,
            }),
            Verdict::Mismatch(expected) => Err(TransportError::HostKeyMismatch {
                host: self.host_pattern.clone(),
                expected,
                actual: check.fingerprint,
                known_hosts: self.known_hosts.path().display().to_string(),
            }),
        }
    }

    async fn auth_banner(&mut self, banner: &str, _session: &mut Session) -> Result<(), Self::Error> {
        log::info!("ssh banner from {}: {banner:?}", self.host_pattern);
        lock(&self.banners).push(banner.to_owned());
        if let Some(url) = banner_url(banner) {
            let events = &self.shared.events;
            let _ = events.send(TransportEvent::Phase(ConnPhase::AuthRequired, Some(tidy_banner(banner)))).await;
            let _ = events.send(TransportEvent::AuthUrl(url)).await;
        }
        Ok(())
    }

    async fn disconnected(&mut self, reason: DisconnectReason<Self::Error>) -> Result<(), Self::Error> {
        match reason {
            DisconnectReason::ReceivedDisconnect(info) => {
                self.shared.set_reason(if info.message.trim().is_empty() {
                    format!("host disconnected ({:?})", info.reason_code)
                } else {
                    format!("host disconnected: {}", info.message.trim())
                });
                Ok(())
            }
            DisconnectReason::Error(e) => {
                self.shared.set_reason(match &e {
                    TransportError::Closed(Some(r)) | TransportError::Ssh(r) => r.clone(),
                    other => other.to_string(),
                });
                Err(e)
            }
        }
    }
}

/// An authenticated SSH connection.
pub struct SshTransport {
    handle: Arc<Handle<ClientHandler>>,
    shared: Arc<Shared>,
}

fn default_user() -> String {
    ["USER", "USERNAME"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .find(|u| !u.trim().is_empty())
        .unwrap_or_else(|| "root".into())
}

fn connect_error(addr: &str, port: u16, e: &std::io::Error) -> TransportError {
    let hint = match e.kind() {
        std::io::ErrorKind::ConnectionRefused => {
            format!("Nothing accepts SSH on port {port}. Enable Tailscale SSH on the host (`tailscale set --ssh`).")
        }
        _ => "Host unreachable. Check that Tailscale is connected on this device (and TeleFlock is not excluded from it) and that the host is online.".into(),
    };
    TransportError::Connect { addr: format!("{addr}:{port}"), detail: e.to_string(), hint: Some(hint) }
}

async fn dial(addr: &str, port: u16, opts: &ConnectOptions) -> Result<TcpStream, TransportError> {
    let resolve_err = |detail: String| TransportError::Resolve { host: addr.to_owned(), detail };
    let mut addrs: Vec<SocketAddr> = tokio::time::timeout(opts.resolve_timeout, tokio::net::lookup_host((addr, port)))
        .await
        .map_err(|_| resolve_err(format!("DNS lookup timed out after {} s", opts.resolve_timeout.as_secs())))?
        .map_err(|e| resolve_err(e.to_string()))?
        .collect();
    if addrs.is_empty() {
        return Err(resolve_err("no addresses found".into()));
    }
    // Prefer the 100.x IPv4 address.
    addrs.sort_by_key(|a| a.is_ipv6());
    let mut last = None;
    for sa in addrs {
        match tokio::time::timeout(opts.connect_timeout, TcpStream::connect(sa)).await {
            Ok(Ok(s)) => {
                let _ = s.set_nodelay(true);
                return Ok(s);
            }
            Ok(Err(e)) => last = Some(connect_error(addr, port, &e)),
            Err(_) => {
                let e = std::io::Error::new(std::io::ErrorKind::TimedOut, format!("timed out after {} s", opts.connect_timeout.as_secs()));
                last = Some(connect_error(addr, port, &e));
            }
        }
    }
    Err(last.expect("at least one address tried"))
}

impl SshTransport {
    /// Dial, verify the host key, authenticate with `none` (waiting through check mode)
    /// and start the keepalive task.
    pub async fn connect(
        profile: &HostProfile,
        opts: &ConnectOptions,
        events: mpsc::Sender<TransportEvent>,
    ) -> Result<Arc<Self>, TransportError> {
        let addr = profile
            .address
            .as_deref()
            .map(str::trim)
            .filter(|a| !a.is_empty())
            .ok_or_else(|| TransportError::Config("a Tailscale SSH host needs an address (MagicDNS name or 100.x IP)".into()))?;
        let port = profile.port.unwrap_or(22);
        let user = profile.user.clone().filter(|u| !u.trim().is_empty()).unwrap_or_else(default_user);

        let _ = events.send(TransportEvent::Phase(ConnPhase::Connecting, Some(format!("Connecting to {addr}…")))).await;
        let tcp = dial(addr, port, opts).await?;

        let shared = Arc::new(Shared {
            events: events.clone(),
            established: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            closed_by_app: AtomicBool::new(false),
            reason: Mutex::new(None),
            stop: watch::Sender::new(false),
        });
        let banners = Arc::new(Mutex::new(Vec::new()));
        let peer = tcp.peer_addr().map_err(TransportError::io)?.ip();
        let peer = match peer {
            std::net::IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(peer, std::net::IpAddr::V4),
            v4 => v4,
        };
        let handler = ClientHandler {
            shared: shared.clone(),
            known_hosts: KnownHosts::new(&opts.known_hosts),
            host_pattern: host_pattern(addr, port),
            peer,
            policy: opts.host_key_policy.clone(),
            banners: banners.clone(),
        };
        let config = Arc::new(client::Config {
            // russh 0.64.1 busy-loops before auth with keepalive_interval set, and an
            // inactivity timeout would kill a check-mode hold. Liveness = our ping task.
            keepalive_interval: None,
            inactivity_timeout: None,
            nodelay: true,
            ..Default::default()
        });
        let secs = opts.handshake_timeout.as_secs();
        let mut handle = tokio::time::timeout(opts.handshake_timeout, client::connect_stream(config, tcp, handler))
            .await
            .map_err(|_| TransportError::Timeout { what: format!("SSH handshake with {addr}"), secs })?
            .map_err(|e| match e {
                TransportError::Closed(r) => {
                    TransportError::Ssh(format!("SSH handshake with {addr} failed: {}", r.unwrap_or_else(|| "connection closed".into())))
                }
                other => other,
            })?;

        let _ = events.send(TransportEvent::Phase(ConnPhase::Authenticating, Some(format!("Signing in as {user}…")))).await;
        let last_banner = || lock(&banners).last().map(|b| tidy_banner(b)).filter(|b| !b.is_empty());
        let auth = tokio::time::timeout(opts.auth_timeout, handle.authenticate_none(user.clone())).await;
        match auth {
            Err(_) => {
                let _ = tokio::time::timeout(Duration::from_secs(2), handle.disconnect(Disconnect::ByApplication, "auth timeout", "en")).await;
                return Err(TransportError::AuthTimeout { mins: opts.auth_timeout.as_secs() / 60 });
            }
            Ok(Err(e)) => {
                return Err(if handle.is_closed() { TransportError::AuthDenied { banner: last_banner() } } else { e.into() });
            }
            Ok(Ok(AuthResult::Success)) => {}
            Ok(Ok(AuthResult::Failure { remaining_methods, .. })) => {
                // The server closing during auth also lands here, with no methods left.
                if remaining_methods.is_empty() || handle.is_closed() {
                    return Err(TransportError::AuthDenied { banner: last_banner() });
                }
                let methods = remaining_methods.iter().map(|m| <&str>::from(m).to_owned()).collect::<Vec<_>>().join(", ");
                let _ = tokio::time::timeout(Duration::from_secs(2), handle.disconnect(Disconnect::ByApplication, "", "en")).await;
                return Err(TransportError::NotTailscaleSsh { methods });
            }
        }

        shared.established.store(true, Ordering::SeqCst);
        if shared.is_finished() {
            return Err(shared.closed_error());
        }
        let handle = Arc::new(handle);
        tokio::spawn(keepalive(Arc::downgrade(&handle), shared.clone(), opts.clone()));
        Ok(Arc::new(Self { handle, shared }))
    }

    fn ensure_open(&self) -> Result<(), TransportError> {
        if self.shared.is_finished() || self.handle.is_closed() { Err(self.shared.closed_error()) } else { Ok(()) }
    }

    /// Map a russh error, preferring the close reason once the connection is gone.
    fn map_err(&self, e: russh::Error) -> TransportError {
        if self.shared.is_finished() || self.handle.is_closed() { self.shared.closed_error() } else { e.into() }
    }

    /// Open a session channel and start `cmd` in the login shell.
    async fn start(&self, cmd: &Cmd) -> Result<(ChannelReadHalf, ChannelWriteHalf<Msg>), TransportError> {
        cmd.check()?;
        self.ensure_open()?;
        let ch = self.handle.channel_open_session().await.map_err(|e| self.map_err(e))?;
        ch.exec(true, quote::remote_command(cmd)).await.map_err(|e| self.map_err(e))?;
        Ok(ch.split())
    }
}

fn signal_name(sig: Sig) -> String {
    match sig {
        Sig::Custom(s) => s,
        other => format!("{other:?}"),
    }
}

async fn kill_channel(wr: &ChannelWriteHalf<Msg>) {
    let _ = wr.signal(Sig::KILL).await;
    let _ = wr.eof().await;
    let _ = wr.close().await;
}

/// Collect an exec channel to completion.
async fn collect(rd: &mut ChannelReadHalf, shared: &Shared) -> Result<Output, TransportError> {
    let mut out = Output::default();
    let mut got_status = false;
    loop {
        match rd.wait().await {
            Some(ChannelMsg::Data { data }) => out.stdout.extend_from_slice(&data),
            Some(ChannelMsg::ExtendedData { data, ext: 1 }) => out.stderr.extend_from_slice(&data),
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                out.status.code = Some(exit_status as i32);
                got_status = true;
            }
            Some(ChannelMsg::ExitSignal { signal_name: sig, .. }) => {
                out.status.signal = Some(signal_name(sig));
                got_status = true;
            }
            Some(ChannelMsg::Failure) => return Err(TransportError::Ssh("the host refused to run the command".into())),
            Some(ChannelMsg::Close) => return Ok(out),
            Some(_) => {}
            None if got_status => return Ok(out),
            None => return Err(shared.closed_error()),
        }
    }
}

/// Read side of a spawn's stdout/stderr. The channel driver never blocks on it: russh
/// delivers every channel's messages from one session loop, so a slow reader that applied
/// backpressure there would stall the whole connection (including keepalive pings).
struct PipeReader {
    rx: mpsc::UnboundedReceiver<Bytes>,
    buf: Bytes,
}

fn pipe() -> (mpsc::UnboundedSender<Bytes>, PipeReader) {
    let (tx, rx) = mpsc::unbounded_channel();
    (tx, PipeReader { rx, buf: Bytes::new() })
}

impl AsyncRead for PipeReader {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, out: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        while self.buf.is_empty() {
            match ready!(self.rx.poll_recv(cx)) {
                Some(b) => self.buf = b,
                // Sender dropped: EOF.
                None => return Poll::Ready(Ok(())),
            }
        }
        let n = self.buf.len().min(out.remaining());
        out.put_slice(&self.buf.split_to(n));
        Poll::Ready(Ok(()))
    }
}

/// How long a killed spawn may take to report its exit before we close the channel.
const KILL_GRACE: Duration = Duration::from_secs(2);

/// Drive a spawn channel: route stdout/stderr, record the exit status, honour kill.
async fn drive(
    mut rd: ChannelReadHalf,
    wr: Arc<ChannelWriteHalf<Msg>>,
    stdout: mpsc::UnboundedSender<Bytes>,
    stderr: mpsc::UnboundedSender<Bytes>,
    mut kill_rx: oneshot::Receiver<()>,
    exit_tx: oneshot::Sender<Result<ExitStatus, TransportError>>,
    shared: Arc<Shared>,
) {
    let (mut out, mut err) = (Some(stdout), Some(stderr));
    let mut status = ExitStatus::default();
    let (mut got_status, mut refused) = (false, false);
    let mut kill_deadline: Option<tokio::time::Instant> = None;
    let clean = loop {
        let grace = async {
            match kill_deadline {
                Some(d) => tokio::time::sleep_until(d).await,
                None => std::future::pending().await,
            }
        };
        let msg = tokio::select! {
            m = rd.wait() => m,
            // Explicit kill or the Child being dropped: signal first so the host can
            // report a real exit status.
            _ = &mut kill_rx, if kill_deadline.is_none() => {
                let _ = wr.signal(Sig::KILL).await;
                let _ = wr.eof().await;
                kill_deadline = Some(tokio::time::Instant::now() + KILL_GRACE);
                continue;
            }
            // The host ignored the signal. Close the channel; russh delivers nothing for a
            // channel after we closed it, so stop here.
            () = grace => {
                let _ = wr.close().await;
                if !got_status {
                    status.signal = Some("KILL".into());
                    got_status = true;
                }
                break true;
            }
        };
        match msg {
            // A dropped reader just discards its stream.
            Some(ChannelMsg::Data { data }) => {
                if let Some(tx) = &out {
                    let _ = tx.send(data);
                }
            }
            Some(ChannelMsg::ExtendedData { data, ext: 1 }) => {
                if let Some(tx) = &err {
                    let _ = tx.send(data);
                }
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                status.code = Some(exit_status as i32);
                got_status = true;
            }
            Some(ChannelMsg::ExitSignal { signal_name: sig, .. }) => {
                status.signal = Some(signal_name(sig));
                got_status = true;
            }
            Some(ChannelMsg::Eof) => {
                out = None;
                err = None;
            }
            Some(ChannelMsg::Failure) => {
                refused = true;
                kill_channel(&wr).await;
                break true;
            }
            Some(ChannelMsg::Close) => break true,
            Some(_) => {}
            None => break false,
        }
    };
    drop((out, err));
    let res = if refused {
        Err(TransportError::Ssh("the host refused to run the command".into()))
    } else if got_status || (clean && !shared.is_finished()) {
        Ok(status)
    } else {
        Err(shared.closed_error())
    };
    let _ = exit_tx.send(res);
}

/// Spawn stdin: a channel writer that sends EOF on shutdown or drop.
struct SshStdin {
    tx: Pin<Box<dyn AsyncWrite + Send + Sync>>,
    wr: Arc<ChannelWriteHalf<Msg>>,
    eof_sent: bool,
}

impl AsyncWrite for SshStdin {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        if buf.is_empty() {
            return Poll::Ready(Ok(0));
        }
        self.tx.as_mut().poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        self.tx.as_mut().poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        if self.eof_sent {
            return Poll::Ready(Ok(()));
        }
        let r = ready!(self.tx.as_mut().poll_shutdown(cx));
        self.eof_sent = true;
        Poll::Ready(r)
    }
}

impl Drop for SshStdin {
    fn drop(&mut self) {
        if !self.eof_sent
            && let Ok(rt) = tokio::runtime::Handle::try_current()
        {
            let wr = self.wr.clone();
            rt.spawn(async move {
                let _ = wr.eof().await;
            });
        }
    }
}

/// Ping after auth: emits `Latency`, declares the link lost after `ping_max_misses`
/// consecutive unanswered pings.
async fn keepalive(handle: Weak<Handle<ClientHandler>>, shared: Arc<Shared>, opts: ConnectOptions) {
    let mut stop = shared.stop.subscribe();
    let mut misses = 0u32;
    loop {
        let Some(h) = handle.upgrade() else { return };
        let t0 = Instant::now();
        let r = tokio::select! {
            r = tokio::time::timeout(opts.ping_timeout, h.send_ping()) => r,
            _ = stop.wait_for(|s| *s) => return,
        };
        match r {
            Ok(Ok(())) => {
                misses = 0;
                let ms = t0.elapsed().as_millis().min(u32::MAX as u128) as u32;
                let _ = shared.events.try_send(TransportEvent::Latency(ms));
            }
            // The session ended; the handler reports why.
            Ok(Err(_)) => return,
            Err(_) => {
                misses += 1;
                log::warn!("ssh keepalive: no reply ({misses}/{})", opts.ping_max_misses);
                if misses >= opts.ping_max_misses {
                    let silent = opts.ping_timeout * misses;
                    shared.set_reason(format!("no response from host for {silent:?} (keepalive timeout)"));
                    if shared.finish() {
                        let _ = shared.events.send(TransportEvent::Closed(Some(shared.reason()))).await;
                    }
                    let _ = tokio::time::timeout(Duration::from_secs(2), h.disconnect(Disconnect::ByApplication, "keepalive timeout", "en")).await;
                    return;
                }
                // Probe again right away instead of waiting a full interval.
                continue;
            }
        }
        drop(h);
        tokio::select! {
            _ = tokio::time::sleep(opts.ping_interval) => {}
            _ = stop.wait_for(|s| *s) => return,
        }
    }
}

#[async_trait::async_trait]
impl Transport for SshTransport {
    async fn exec(&self, cmd: &Cmd) -> Result<Output, TransportError> {
        let (mut rd, wr) = self.start(cmd).await?;
        let input = cmd.stdin.as_deref();
        let io = async {
            let write = async {
                if let Some(data) = input {
                    let _ = wr.data(data).await;
                }
                let _ = wr.eof().await;
                // Completion is decided by the reader.
                std::future::pending::<()>().await
            };
            tokio::select! {
                r = collect(&mut rd, &self.shared) => r,
                () = write => unreachable!(),
            }
        };
        match cmd.timeout {
            Some(t) => match tokio::time::timeout(t, io).await {
                Ok(r) => r,
                Err(_) => {
                    kill_channel(&wr).await;
                    Err(TransportError::Timeout { what: format!("`{}`", cmd.argv[0]), secs: t.as_secs() })
                }
            },
            None => io.await,
        }
    }

    async fn spawn(&self, cmd: &Cmd) -> Result<Child, TransportError> {
        let (rd, wr) = self.start(cmd).await?;
        let wr = Arc::new(wr);
        let stdin = SshStdin { tx: Box::pin(wr.make_writer()), wr: wr.clone(), eof_sent: false };
        let (out_w, out_r) = pipe();
        let (err_w, err_r) = pipe();
        let (exit_tx, exit_rx) = oneshot::channel();
        let (kill_tx, kill_rx) = oneshot::channel();
        tokio::spawn(drive(rd, wr, out_w, err_w, kill_rx, exit_tx, self.shared.clone()));
        Ok(Child::new(Box::new(stdin), Box::new(out_r), Box::new(err_r), exit_rx, kill_tx))
    }

    async fn forward_tcp(&self, host: &str, port: u16) -> Result<BoxedStream, TransportError> {
        self.ensure_open()?;
        let target = format!("{host}:{port}");
        match self.handle.channel_open_direct_tcpip(host, u32::from(port), "127.0.0.1", 0).await {
            Ok(ch) => Ok(Box::new(ch.into_stream())),
            Err(russh::Error::ChannelOpenFailure(ChannelOpenFailure::AdministrativelyProhibited)) => {
                Err(TransportError::ForwardDenied { target })
            }
            Err(russh::Error::ChannelOpenFailure(ChannelOpenFailure::ConnectFailed)) => {
                Err(TransportError::ForwardFailed { target, detail: "connection refused or unreachable".into() })
            }
            Err(russh::Error::ChannelOpenFailure(other)) => Err(TransportError::ForwardFailed { target, detail: format!("{other:?}") }),
            Err(e) => Err(self.map_err(e)),
        }
    }

    fn kind(&self) -> HostKind {
        HostKind::TailscaleSsh
    }

    async fn close(&self) {
        self.shared.closed_by_app.store(true, Ordering::SeqCst);
        if self.shared.finish() {
            let _ = self.shared.events.send(TransportEvent::Closed(None)).await;
        }
        let _ = tokio::time::timeout(
            Duration::from_secs(3),
            self.handle.disconnect(Disconnect::ByApplication, "TeleFlock closed the connection", "en"),
        )
        .await;
    }
}

impl Drop for SshTransport {
    fn drop(&mut self) {
        // Dropping the transport (and with it the russh handle) ends the session.
        self.shared.closed_by_app.store(true, Ordering::SeqCst);
        if self.shared.finish() {
            emit_nowait(&self.shared.events, TransportEvent::Closed(None));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_check_mode_url() {
        let b = "# Tailscale SSH requires an additional check.\n# To authenticate, visit: https://login.tailscale.com/a/abc123def\n";
        assert_eq!(banner_url(b).as_deref(), Some("https://login.tailscale.com/a/abc123def"));
        assert_eq!(tidy_banner(b), "Tailscale SSH requires an additional check.\nTo authenticate, visit: https://login.tailscale.com/a/abc123def");
        assert_eq!(banner_url("see (https://x.example/a)."), Some("https://x.example/a".into()));
        assert_eq!(banner_url("tailscale: access denied\n"), None);
        assert_eq!(banner_url("https:// nope"), None);
    }
}
