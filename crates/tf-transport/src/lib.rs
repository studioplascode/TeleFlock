//! TeleFlock app-side transports (architecture §5.1).
//!
//! One [`Transport`] per host connection:
//! * [`HostKind::TailscaleSsh`]: one long-lived russh connection (`none` auth, check-mode
//!   aware) multiplexing exec, spawn and `direct-tcpip` channels.
//! * [`HostKind::Local`]: `tokio::process`, no shell.
//! * [`HostKind::Wsl`]: `wsl.exe -d <distro> --exec …` through the local transport.
//!
//! See `README.md` for the API contract.

use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot};

pub use tf_proto::app::{ConnPhase, HostKind, HostProfile, WslDistro};

mod error;
mod local;
pub mod quote;
mod ssh;
mod wsl;

pub use error::TransportError;
pub use local::LocalTransport;
pub use ssh::SshTransport;
pub use wsl::{WslTransport, list_distros, parse_distros};

/// A connection to one host.
#[async_trait::async_trait]
pub trait Transport: Send + Sync {
    /// Run a command to completion. `cmd.stdin` (if any) is written and closed; without it
    /// stdin is closed immediately. `cmd.timeout` bounds the whole run (→ `Timeout`).
    async fn exec(&self, cmd: &Cmd) -> Result<Output, TransportError>;
    /// Start a long-lived command with streaming stdio (attach, uploads). `cmd.stdin` and
    /// `cmd.timeout` are ignored; write through [`Child::stdin`].
    async fn spawn(&self, cmd: &Cmd) -> Result<Child, TransportError>;
    /// Open a TCP stream to `host:port` as seen from the host (previews, relay tunnel).
    async fn forward_tcp(&self, host: &str, port: u16) -> Result<BoxedStream, TransportError>;
    fn kind(&self) -> HostKind;
    /// Close the connection. Emits `TransportEvent::Closed(None)` once; later calls fail
    /// with `TransportError::Closed(None)`.
    async fn close(&self);
}

/// A command as argv. Remote kinds (SSH, WSL) run it in the user's login shell
/// (`$SHELL -lc`, POSIX-quoted) so PATH includes `~/.local/bin`; Local runs argv directly.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Cmd {
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Working directory. Remote kinds accept `~` and `~/…`.
    pub cwd: Option<String>,
    /// Bytes written to stdin by [`Transport::exec`] (then EOF).
    pub stdin: Option<Vec<u8>>,
    /// Deadline for [`Transport::exec`].
    pub timeout: Option<Duration>,
}

impl Cmd {
    pub fn new<I, S>(argv: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self { argv: argv.into_iter().map(Into::into).collect(), ..Self::default() }
    }
    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }
    pub fn cwd(mut self, dir: impl Into<String>) -> Self {
        self.cwd = Some(dir.into());
        self
    }
    pub fn stdin(mut self, bytes: impl Into<Vec<u8>>) -> Self {
        self.stdin = Some(bytes.into());
        self
    }
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    pub(crate) fn check(&self) -> Result<(), TransportError> {
        if self.argv.is_empty() || self.argv[0].is_empty() {
            return Err(TransportError::Config("empty command".into()));
        }
        Ok(())
    }
}

/// How a command ended. `code` is the exit code; `signal` the signal name without the
/// `SIG` prefix (e.g. `KILL`). Both `None` when the host closed the channel without
/// reporting a status.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExitStatus {
    pub code: Option<i32>,
    pub signal: Option<String>,
}

impl ExitStatus {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }
}

impl std::fmt::Display for ExitStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match (&self.code, &self.signal) {
            (Some(c), _) => write!(f, "exit code {c}"),
            (None, Some(s)) => write!(f, "killed by SIG{s}"),
            (None, None) => f.write_str("no exit status"),
        }
    }
}

/// Result of [`Transport::exec`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Output {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl Output {
    pub fn stdout_str(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
    pub fn stderr_str(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

pub type BoxedRead = Box<dyn AsyncRead + Send + Unpin>;
pub type BoxedWrite = Box<dyn AsyncWrite + Send + Unpin>;

/// A bidirectional byte stream (TCP or SSH `direct-tcpip` channel).
pub trait AsyncStream: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> AsyncStream for T {}
pub type BoxedStream = Box<dyn AsyncStream>;

/// A running command started by [`Transport::spawn`].
///
/// Take the stdio fields with `.take()`. Shutting down or dropping `stdin` sends EOF.
/// Dropping the `Child` kills the command.
pub struct Child {
    pub stdin: Option<BoxedWrite>,
    pub stdout: Option<BoxedRead>,
    pub stderr: Option<BoxedRead>,
    exit: oneshot::Receiver<Result<ExitStatus, TransportError>>,
    done: Option<Result<ExitStatus, TransportError>>,
    kill: Option<oneshot::Sender<()>>,
}

impl Child {
    pub(crate) fn new(
        stdin: BoxedWrite,
        stdout: BoxedRead,
        stderr: BoxedRead,
        exit: oneshot::Receiver<Result<ExitStatus, TransportError>>,
        kill: oneshot::Sender<()>,
    ) -> Self {
        Self { stdin: Some(stdin), stdout: Some(stdout), stderr: Some(stderr), exit, done: None, kill: Some(kill) }
    }

    /// Wait for the command to end. Returns `Err(Closed(..))` if the connection died first.
    /// Cancel-safe (usable in `select!`) and repeatable after it returned.
    pub async fn wait(&mut self) -> Result<ExitStatus, TransportError> {
        if let Some(done) = &self.done {
            return done.clone();
        }
        // Polling `&mut` keeps the receiver in `self` if this future is dropped mid-await.
        let res = (&mut self.exit).await.unwrap_or_else(|_| Err(TransportError::Closed(Some("process driver ended".into()))));
        self.done = Some(res.clone());
        res
    }

    /// Kill the command and wait until it is gone. Cancel-safe.
    pub async fn kill(&mut self) {
        if let Some(k) = self.kill.take() {
            let _ = k.send(());
        }
        let _ = self.wait().await;
    }
}

impl std::fmt::Debug for Child {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Child").field("done", &self.done).finish_non_exhaustive()
    }
}

/// Connection lifecycle events, sent on the channel given to [`connect`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportEvent {
    /// Phase change with an optional human status line. Transports emit `Connecting`,
    /// `Authenticating` and `AuthRequired`; the engine owns the later phases.
    Phase(ConnPhase, Option<String>),
    /// Tailscale SSH check mode: the user must open this URL to approve the connection.
    /// The connect call keeps waiting (up to `ConnectOptions::auth_timeout`).
    AuthUrl(String),
    /// Round-trip time of the latest keepalive ping, in ms.
    Latency(u32),
    /// Emitted once when an established connection ends. `None` = closed by the app via
    /// [`Transport::close`]; `Some(reason)` = lost (remote disconnect, keepalive timeout).
    Closed(Option<String>),
}

/// App-provided connection settings.
#[derive(Debug, Clone)]
pub struct ConnectOptions {
    /// OpenSSH-format known_hosts file for host key pinning.
    pub known_hosts: PathBuf,
    /// Decides whether a host key that is not pinned yet may be pinned now.
    pub host_key_policy: HostKeyPolicy,
    /// DNS resolution deadline.
    pub resolve_timeout: Duration,
    /// TCP connect deadline (per resolved address).
    pub connect_timeout: Duration,
    /// SSH version exchange + key exchange deadline.
    pub handshake_timeout: Duration,
    /// How long to wait for `none` auth, including a check-mode approval (31 min).
    pub auth_timeout: Duration,
    /// Keepalive/latency ping period after auth.
    pub ping_interval: Duration,
    /// Per-ping reply deadline.
    pub ping_timeout: Duration,
    /// Consecutive missed pings before the connection is declared lost.
    pub ping_max_misses: u32,
    /// Deadline for the WSL distro warm-up (`true`) run by `connect`.
    pub wsl_start_timeout: Duration,
}

impl ConnectOptions {
    pub fn new(known_hosts: impl Into<PathBuf>) -> Self {
        Self {
            known_hosts: known_hosts.into(),
            host_key_policy: HostKeyPolicy::tailnet_only(),
            resolve_timeout: Duration::from_secs(10),
            connect_timeout: Duration::from_secs(15),
            handshake_timeout: Duration::from_secs(20),
            auth_timeout: Duration::from_secs(31 * 60),
            ping_interval: Duration::from_secs(15),
            ping_timeout: Duration::from_secs(10),
            ping_max_misses: 3,
            wsl_start_timeout: Duration::from_secs(90),
        }
    }
}

/// A host key presented by an SSH server that is not pinned in known_hosts yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostKeyCheck {
    /// known_hosts host field (`name` or `[name]:port`).
    pub host: String,
    /// Resolved peer address the key was presented by.
    pub address: IpAddr,
    /// Key algorithm, e.g. `ssh-ed25519`.
    pub algorithm: String,
    /// `SHA256:…` fingerprint.
    pub fingerprint: String,
}

/// Outcome of [`HostKeyPolicy::decide`]. A key that differs from a pinned one is always
/// rejected ([`TransportError::HostKeyMismatch`]) and never reaches the policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyDecision {
    /// Pin the key and continue the handshake.
    Trust,
    /// Abort with [`TransportError::HostKeyUnconfirmed`] so the user can confirm the
    /// fingerprint; connect again once it is trusted.
    Confirm,
}

/// Host key decision hook for keys seen for the first time. Called synchronously during
/// the SSH key exchange, so it must not block.
#[derive(Clone)]
pub struct HostKeyPolicy(Arc<dyn Fn(&HostKeyCheck) -> HostKeyDecision + Send + Sync>);

impl HostKeyPolicy {
    pub fn new(decide: impl Fn(&HostKeyCheck) -> HostKeyDecision + Send + Sync + 'static) -> Self {
        Self(Arc::new(decide))
    }

    /// Silent trust-on-first-use for tailnet addresses (Tailscale authenticates the node);
    /// every other address needs an explicit confirmation.
    pub fn tailnet_only() -> Self {
        Self::new(|c| if is_tailnet_ip(c.address) { HostKeyDecision::Trust } else { HostKeyDecision::Confirm })
    }

    pub fn decide(&self, check: &HostKeyCheck) -> HostKeyDecision {
        (self.0)(check)
    }
}

impl std::fmt::Debug for HostKeyPolicy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("HostKeyPolicy")
    }
}

/// Tailscale node address: `100.64.0.0/10` (CGNAT range Tailscale assigns) or
/// `fd7a:115c:a1e0::/48` (Tailscale's ULA prefix), including IPv4-mapped IPv6.
pub fn is_tailnet_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 100 && (o[1] & 0xC0) == 64
        }
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_tailnet_ip(IpAddr::V4(v4)),
            None => {
                let s = v6.segments();
                s[0] == 0xfd7a && s[1] == 0x115c && s[2] == 0xa1e0
            }
        },
    }
}

/// Connect to the host described by `profile`. Resolves once the transport is usable
/// (for SSH: after auth). Cancel a pending connect (e.g. a check-mode approval the user
/// gave up on) by dropping the future.
pub async fn connect(
    profile: &HostProfile,
    opts: &ConnectOptions,
    events: mpsc::Sender<TransportEvent>,
) -> Result<Arc<dyn Transport>, TransportError> {
    match profile.kind {
        HostKind::TailscaleSsh => Ok(SshTransport::connect(profile, opts, events).await?),
        HostKind::Local => Ok(Arc::new(LocalTransport::new(events))),
        HostKind::Wsl => Ok(WslTransport::connect(profile.distro.clone(), opts, events).await?),
        HostKind::Demo => Err(TransportError::Unsupported("the demo host is simulated by the frontend".into())),
    }
}
