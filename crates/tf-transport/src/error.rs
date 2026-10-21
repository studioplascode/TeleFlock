//! Transport errors. Every variant carries a human message; `code()`, `hint()` and
//! `retryable()` feed `tf_proto::ApiError` so the UI can explain what went wrong.

use tf_proto::ApiError;

#[derive(Debug, Clone, thiserror::Error)]
pub enum TransportError {
    /// The host name could not be resolved (MagicDNS off, typo, Tailscale down).
    #[error("could not resolve {host}: {detail}")]
    Resolve { host: String, detail: String },
    /// TCP connect failed (refused, unreachable, timed out).
    #[error("could not connect to {addr}: {detail}")]
    Connect { addr: String, detail: String, hint: Option<String> },
    /// An operation exceeded its deadline (`what` names it).
    #[error("{what} timed out after {secs} s")]
    Timeout { what: String, secs: u64 },
    /// The host presented a different key than the one pinned in known_hosts.
    #[error("host key for {host} changed: got {actual}, expected {}", expected.join(" or "))]
    HostKeyMismatch { host: String, expected: Vec<String>, actual: String, known_hosts: String },
    /// A host key seen for the first time needs the user's confirmation
    /// ([`crate::HostKeyDecision::Confirm`]). Nothing was pinned.
    #[error("new host key for {host} ({address}) needs confirmation: {algorithm} {fingerprint}")]
    HostKeyUnconfirmed { host: String, address: String, algorithm: String, fingerprint: String },
    /// Reading or writing the known_hosts file failed, or the key could not be handled.
    #[error("host key store error: {0}")]
    HostKeyStore(String),
    /// The server ended authentication (Tailscale policy denied access, check timed out).
    #[error("access denied by host{}", banner.as_deref().map(|b| format!(": {b}")).unwrap_or_default())]
    AuthDenied { banner: Option<String> },
    /// `none` auth was refused with other methods offered: this is a regular sshd, not Tailscale SSH.
    #[error("host does not accept Tailscale SSH (offered: {methods})")]
    NotTailscaleSsh { methods: String },
    /// The check-mode approval was not completed in time.
    #[error("Tailscale SSH approval not completed within {mins} min")]
    AuthTimeout { mins: u64 },
    /// The host refused a `direct-tcpip` forward (policy or `TS_SSH_DISABLE_FORWARDING`).
    #[error("port forwarding to {target} was refused by the host")]
    ForwardDenied { target: String },
    /// The host accepted the forward but could not reach the target.
    #[error("host could not connect to {target}: {detail}")]
    ForwardFailed { target: String, detail: String },
    /// Any other SSH protocol error.
    #[error("ssh: {0}")]
    Ssh(String),
    /// Local I/O error.
    #[error("i/o: {0}")]
    Io(String),
    /// Starting a local process failed (`program` not found, permission denied, …).
    #[error("could not start {program}: {detail}")]
    Spawn { program: String, detail: String },
    /// wsl.exe reported an error (its own message, decoded from UTF-16).
    #[error("wsl: {0}")]
    Wsl(String),
    /// The operation is not available for this host kind / platform.
    #[error("unsupported: {0}")]
    Unsupported(String),
    /// The profile or command is invalid.
    #[error("invalid configuration: {0}")]
    Config(String),
    /// The connection is closed. `None` = closed by the app, `Some` = lost (reason).
    #[error("connection closed{}", .0.as_deref().map(|r| format!(": {r}")).unwrap_or_default())]
    Closed(Option<String>),
}

impl TransportError {
    /// Stable machine code (`transport.<kind>`), used as `ApiError::code`.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Resolve { .. } => "transport.resolve",
            Self::Connect { .. } => "transport.connect",
            Self::Timeout { .. } => "transport.timeout",
            Self::HostKeyMismatch { .. } => "transport.hostKeyMismatch",
            Self::HostKeyUnconfirmed { .. } => "transport.hostKeyUnconfirmed",
            Self::HostKeyStore(_) => "transport.hostKeyStore",
            Self::AuthDenied { .. } => "transport.authDenied",
            Self::NotTailscaleSsh { .. } => "transport.notTailscaleSsh",
            Self::AuthTimeout { .. } => "transport.authTimeout",
            Self::ForwardDenied { .. } => "transport.forwardDenied",
            Self::ForwardFailed { .. } => "transport.forwardFailed",
            Self::Ssh(_) => "transport.ssh",
            Self::Io(_) => "transport.io",
            Self::Spawn { .. } => "transport.spawn",
            Self::Wsl(_) => "transport.wsl",
            Self::Unsupported(_) => "transport.unsupported",
            Self::Config(_) => "transport.config",
            Self::Closed(_) => "transport.closed",
        }
    }

    /// How the user can fix it, if we know.
    pub fn hint(&self) -> Option<String> {
        Some(match self {
            Self::Resolve { .. } => {
                "MagicDNS may be off on this tailnet. Use the host's 100.x Tailscale IP, and check that Tailscale is connected.".into()
            }
            Self::Connect { hint, .. } => return hint.clone(),
            Self::HostKeyMismatch { known_hosts, host, .. } => format!(
                "If the host was reinstalled or re-keyed, remove the {host} line from {known_hosts} and reconnect. Otherwise someone may be intercepting the connection."
            ),
            Self::HostKeyUnconfirmed { .. } => {
                "This is not a Tailscale address, so the key is not vouched for by the tailnet. Compare the fingerprint with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the host before trusting it.".into()
            }
            Self::AuthDenied { .. } => "Check the tailnet SSH policy (ssh rules and users) for this device and user.".into(),
            Self::NotTailscaleSsh { .. } => {
                "Reached a regular sshd. Enable Tailscale SSH on the host (`tailscale set --ssh`) and connect via its Tailscale IP from another device.".into()
            }
            Self::AuthTimeout { .. } => "Open the login link and approve the connection, then retry.".into(),
            Self::ForwardDenied { .. } => {
                "Allow local port forwarding in the tailnet SSH policy (`allowLocalPortForwarding`) and make sure TS_SSH_DISABLE_FORWARDING is not set.".into()
            }
            Self::Wsl(_) => "Check that WSL is installed and the distro exists (`wsl -l -v`).".into(),
            Self::Spawn { .. } => "Check that the program is installed and on PATH.".into(),
            _ => return None,
        })
    }

    /// Whether retrying the same operation later can succeed.
    pub fn retryable(&self) -> bool {
        matches!(
            self,
            Self::Resolve { .. }
                | Self::Connect { .. }
                | Self::Timeout { .. }
                | Self::AuthTimeout { .. }
                | Self::Ssh(_)
                | Self::Io(_)
                | Self::Closed(_)
                | Self::ForwardFailed { .. }
        )
    }

    pub(crate) fn io(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

impl From<TransportError> for ApiError {
    fn from(e: TransportError) -> Self {
        let mut api = ApiError::new(e.code(), e.to_string());
        api.hint = e.hint();
        api.retryable = e.retryable();
        api
    }
}

impl From<russh::Error> for TransportError {
    fn from(e: russh::Error) -> Self {
        match e {
            russh::Error::ChannelOpenFailure(f) => Self::Ssh(format!("channel open failed: {f:?}")),
            russh::Error::Disconnect | russh::Error::SendError | russh::Error::RecvError => Self::Closed(Some(describe_russh(&e))),
            other => Self::Ssh(describe_russh(&other)),
        }
    }
}

/// Human description of a russh error (used for close reasons).
pub(crate) fn describe_russh(e: &russh::Error) -> String {
    match e {
        russh::Error::IO(io) if io.kind() == std::io::ErrorKind::UnexpectedEof => "host closed the connection".into(),
        russh::Error::IO(io) => format!("network error: {io}"),
        russh::Error::Disconnect => "disconnected".into(),
        russh::Error::SendError | russh::Error::RecvError => "session ended".into(),
        russh::Error::KeepaliveTimeout => "keepalive timeout".into(),
        russh::Error::InactivityTimeout => "inactivity timeout".into(),
        other => other.to_string(),
    }
}
