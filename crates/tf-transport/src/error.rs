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
    /// Password sign-in: the host refused the password (or the user name is wrong).
    #[error("password sign-in as {user} failed: the host rejected the password")]
    PasswordRejected { user: String },
    /// Key sign-in: the host does not accept this key for the user.
    #[error("key sign-in as {user} failed: the host does not accept key {fingerprint}")]
    KeyRejected { user: String, fingerprint: String },
    /// The host does not offer the configured sign-in method (`password` / `key`) at all.
    #[error("{method} sign-in failed: the host does not allow it (it offers: {offered})")]
    AuthMethodNotAllowed { method: &'static str, offered: String },
    /// The configured method went through, but the host asks for more (a second method, or a
    /// keyboard-interactive prompt other than the password).
    #[error("{method} sign-in as {user} failed: the host also asks for {needs}")]
    AuthIncomplete { method: &'static str, user: String, needs: String },
    /// The host ended a password / key sign-in by closing the connection.
    #[error("{method} sign-in as {user} failed: the host closed the connection{}", banner.as_deref().map(|b| format!(": {b}")).unwrap_or_default())]
    SignInClosed { method: &'static str, user: String, banner: Option<String> },
    /// The configured method's secret is not saved (`what`: `password`, `private key`).
    #[error("{method} sign-in failed: no {what} is saved for this host")]
    CredentialMissing { method: &'static str, what: &'static str },
    /// The private key is encrypted and no passphrase is saved.
    #[error("key sign-in failed: {key} is encrypted and no passphrase is saved")]
    KeyPassphraseNeeded { key: String },
    /// The saved passphrase does not decrypt the private key.
    #[error("key sign-in failed: wrong passphrase for {key}")]
    KeyPassphraseWrong { key: String },
    /// The key file is missing or unreadable, or the text is not a supported private key.
    #[error("key sign-in failed: {key}: {detail}")]
    KeyUnreadable { key: String, detail: String },
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
            Self::PasswordRejected { .. } => "transport.passwordRejected",
            Self::KeyRejected { .. } => "transport.keyRejected",
            Self::AuthMethodNotAllowed { .. } => "transport.authMethodNotAllowed",
            Self::AuthIncomplete { .. } => "transport.authIncomplete",
            Self::SignInClosed { .. } => "transport.signInClosed",
            Self::CredentialMissing { .. } => "transport.credentialMissing",
            Self::KeyPassphraseNeeded { .. } => "transport.keyPassphraseNeeded",
            Self::KeyPassphraseWrong { .. } => "transport.keyPassphraseWrong",
            Self::KeyUnreadable { .. } => "transport.keyUnreadable",
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
                "Reached a regular sshd. Enable Tailscale SSH on the host (`tailscale set --ssh`) and connect via its Tailscale IP, or sign in with a key or password under Advanced: authentication.".into()
            }
            Self::AuthTimeout { .. } => "Open the login link and approve the connection, then retry.".into(),
            Self::PasswordRejected { .. } => {
                "Check the password and the user name under Advanced: authentication. TeleFlock does not retry a rejected password on its own.".into()
            }
            Self::KeyRejected { user, .. } => format!(
                "Add the public key to ~/.ssh/authorized_keys of {user} on the host (e.g. with `ssh-copy-id`), or choose the key that is already there."
            ),
            Self::AuthMethodNotAllowed { method: "password", .. } => {
                "The host's sshd has password sign-in turned off (`PasswordAuthentication no`). Sign in with a key, or use Tailscale SSH.".into()
            }
            Self::AuthMethodNotAllowed { .. } => {
                "The host's sshd has key sign-in turned off (`PubkeyAuthentication no`). Sign in with a password, or use Tailscale SSH.".into()
            }
            Self::AuthIncomplete { .. } => {
                "TeleFlock signs in with one method. Let this user sign in with it alone (sshd `AuthenticationMethods`), or use Tailscale SSH.".into()
            }
            Self::SignInClosed { .. } => {
                "Check the user name and that the host's sshd lets this user sign in (`AllowUsers`, `DenyUsers`, `MaxAuthTries`).".into()
            }
            Self::CredentialMissing { .. } => "Edit the host and enter it under Advanced: authentication.".into(),
            Self::KeyPassphraseNeeded { .. } => "Enter the key's passphrase under Advanced: authentication.".into(),
            Self::KeyPassphraseWrong { .. } => "Re-enter the key's passphrase under Advanced: authentication.".into(),
            Self::KeyUnreadable { .. } => "Use an OpenSSH or PEM private key, e.g. ~/.ssh/id_ed25519 (not the .pub file).".into(),
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
        match self {
            // A cold or busy WSL VM fails its start now and then (timeouts, HCS errors); only a
            // missing WSL or distro is final.
            Self::Wsl(msg) => !wsl_permanent(msg),
            _ => matches!(
                self,
                Self::Resolve { .. }
                    | Self::Connect { .. }
                    | Self::Timeout { .. }
                    | Self::AuthTimeout { .. }
                    | Self::Ssh(_)
                    | Self::Io(_)
                    | Self::Closed(_)
                    | Self::ForwardFailed { .. }
            ),
        }
    }

    pub(crate) fn io(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

/// wsl.exe failures that no retry fixes: WSL not installed or not startable, no such distro.
fn wsl_permanent(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    [
        "could not be started",
        "wsl_e_distro_not_found",
        "no distribution with the supplied name",
        "wsl_e_default_distro_not_found",
        "has no installed distributions",
        "optional_component_required",
    ]
    .iter()
    .any(|p| m.contains(p))
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
