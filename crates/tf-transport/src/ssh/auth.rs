//! Sign-in for [`HostProfile::auth`](crate::HostProfile).
//!
//! * `tailscale`: SSH `none`; Tailscale SSH vouches for this device. A check-mode hold is waited
//!   out (up to `ConnectOptions::auth_timeout`); other methods offered instead mean a regular sshd.
//! * `password` / `key`: the credential is loaded first (a key is decrypted with the saved
//!   passphrase), then `none` learns what the host offers (a host that needs no credentials, such
//!   as Tailscale SSH, accepts it), then the configured credential is tried once. A password is
//!   also answered over `keyboard-interactive` when the host offers only that. Nothing else is
//!   ever tried: no agent, no default key files, no other saved secret.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{AuthResult, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::{PrivateKey, PrivateKeyWithHashAlg, decode_secret_key};
use russh::{Disconnect, MethodKind, MethodSet};

use super::{ClientHandler, fingerprint};
use crate::{HostSecrets, SshAuth, TransportError};

/// Deadline for one password, key or keyboard-interactive exchange.
const STEP_TIMEOUT: Duration = Duration::from_secs(60);
/// Private key files are a few KiB; anything this large is not one.
const MAX_KEY_BYTES: u64 = 1024 * 1024;
/// How messages name a key saved in the app (imported or pasted).
const SAVED_KEY: &str = "the saved key";

/// Method name in messages (`password sign-in as …`).
pub(super) fn method_name(auth: SshAuth) -> &'static str {
    match auth {
        SshAuth::Tailscale => "Tailscale SSH",
        SshAuth::Key => "key",
        SshAuth::Password => "password",
    }
}

/// The secret a sign-in uses, loaded before the host is asked.
pub(super) enum Credential {
    Tailscale,
    Password(String),
    Key(PrivateKey),
}

impl Credential {
    /// The secret `auth` signs in with: the saved password, or the private key (`key_path` on
    /// this device, else the saved key) decrypted with the saved passphrase.
    pub(super) async fn load(auth: SshAuth, key_path: Option<&str>, secrets: &HostSecrets) -> Result<Self, TransportError> {
        match auth {
            SshAuth::Tailscale => Ok(Self::Tailscale),
            SshAuth::Password => secrets
                .password
                .clone()
                .filter(|p| !p.is_empty())
                .map(Self::Password)
                .ok_or(TransportError::CredentialMissing { method: "password", what: "password" }),
            SshAuth::Key => {
                let path = key_path.map(str::trim).filter(|p| !p.is_empty()).map(str::to_owned);
                let saved = secrets.private_key.clone().filter(|k| !k.trim().is_empty());
                if path.is_none() && saved.is_none() {
                    return Err(TransportError::CredentialMissing { method: "key", what: "private key" });
                }
                let passphrase = secrets.passphrase.clone();
                // The file read and bcrypt-pbkdf (encrypted OpenSSH keys) stay off the async workers.
                let key = tokio::task::spawn_blocking(move || match path {
                    Some(path) => load_key(&read_key_file(&path)?, passphrase.as_deref(), &path),
                    None => load_key(saved.as_deref().unwrap_or_default(), passphrase.as_deref(), SAVED_KEY),
                })
                .await
                .map_err(|e| TransportError::Io(format!("decoding the private key failed: {e}")))??;
                Ok(Self::Key(key))
            }
        }
    }

    fn method(&self) -> &'static str {
        match self {
            Self::Tailscale => method_name(SshAuth::Tailscale),
            Self::Password(_) => method_name(SshAuth::Password),
            Self::Key(_) => method_name(SshAuth::Key),
        }
    }
}

/// Checks that `text` is a private key this transport can sign in with, decrypting it with
/// `passphrase` when it is encrypted. Returns its `SHA256:` fingerprint.
pub fn check_private_key(text: &str, passphrase: Option<&str>) -> Result<String, TransportError> {
    load_key(text, passphrase, SAVED_KEY).map(|k| fingerprint(k.public_key()))
}

/// `~` and `~/…` → the home dir of this device's user.
fn expand_home(path: &str) -> PathBuf {
    match path.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => match std::env::home_dir() {
            Some(home) => home.join(rest.trim_start_matches(['/', '\\'])),
            None => PathBuf::from(path),
        },
        _ => PathBuf::from(path),
    }
}

fn read_key_file(path: &str) -> Result<String, TransportError> {
    let unreadable = |detail: String| TransportError::KeyUnreadable { key: path.to_owned(), detail };
    let io_detail = |e: std::io::Error| match e.kind() {
        std::io::ErrorKind::NotFound => "no such file on this device".to_owned(),
        std::io::ErrorKind::PermissionDenied => "permission denied".to_owned(),
        _ => e.to_string(),
    };
    let full = expand_home(path);
    let meta = std::fs::metadata(&full).map_err(|e| unreadable(io_detail(e)))?;
    if !meta.is_file() {
        return Err(unreadable("not a file".into()));
    }
    if meta.len() > MAX_KEY_BYTES {
        return Err(unreadable("too large for a private key file".into()));
    }
    let bytes = std::fs::read(&full).map_err(|e| unreadable(io_detail(e)))?;
    String::from_utf8(bytes).map_err(|_| unreadable("not a text key file (expected OpenSSH or PEM)".into()))
}

/// Parses a private key (OpenSSH; PEM: PKCS#1, PKCS#8, SEC1; PuTTY) and decrypts it with
/// `passphrase` when it is encrypted. A passphrase for an unencrypted key is ignored, so a stale
/// saved one never breaks a key that no longer needs it.
fn load_key(text: &str, passphrase: Option<&str>, name: &str) -> Result<PrivateKey, TransportError> {
    let unreadable = |detail: &str| TransportError::KeyUnreadable { key: name.to_owned(), detail: detail.to_owned() };
    let ppk = text.trim_start().starts_with("PuTTY-User-Key-File-");
    // Pasted keys may carry indentation, CRLF line ends or blank lines; the PEM decoder wants bare
    // lines. PuTTY files stay as they are (their MAC covers the comment line).
    let text = if ppk {
        text.trim().to_owned()
    } else {
        text.lines().map(str::trim).filter(|l| !l.is_empty()).fold(String::new(), |mut s, l| {
            s.push_str(l);
            s.push('\n');
            s
        })
    };
    let first = text.lines().next().unwrap_or_default();
    if ["ssh-", "ecdsa-sha2-", "sk-ssh-", "sk-ecdsa-", "---- BEGIN SSH2 PUBLIC KEY"].iter().any(|p| first.starts_with(p)) {
        return Err(unreadable("this is a public key; use the private key (the file without .pub)"));
    }
    if !ppk && !first.starts_with("-----BEGIN ") {
        return Err(unreadable("not a private key (expected an OpenSSH or PEM private key)"));
    }
    // Legacy PEM encryption: the decoder handles AES-128-CBC only.
    let legacy_encrypted = text.lines().any(|l| l == "Proc-Type: 4,ENCRYPTED");
    if legacy_encrypted && !text.lines().any(|l| l.starts_with("DEK-Info: AES-128-CBC,")) {
        return Err(unreadable("its encryption is not supported; re-save it with `ssh-keygen -p -f <file>`"));
    }
    let encrypted = legacy_encrypted
        || first == "-----BEGIN ENCRYPTED PRIVATE KEY-----"
        || (ppk && !text.lines().any(|l| l.trim() == "Encryption: none"))
        || match decode_secret_key(&text, None) {
            Ok(key) => return Ok(key),
            Err(russh::keys::Error::KeyIsEncrypted) => true,
            Err(e) => return Err(unreadable(&describe_key_error(&e))),
        };
    debug_assert!(encrypted);
    let Some(passphrase) = passphrase.filter(|p| !p.is_empty()) else {
        return Err(TransportError::KeyPassphraseNeeded { key: name.to_owned() });
    };
    // The key parsed without a passphrase up to its encrypted part, so a failure here is the
    // passphrase (a wrong one fails the checkint, padding or MAC check).
    decode_secret_key(&text, Some(passphrase)).map_err(|_| TransportError::KeyPassphraseWrong { key: name.to_owned() })
}

fn describe_key_error(e: &russh::keys::Error) -> String {
    match e {
        russh::keys::Error::CouldNotReadKey | russh::keys::Error::Decode(_) => {
            "not a supported private key (expected OpenSSH, PEM or PuTTY)".into()
        }
        russh::keys::Error::UnsupportedKeyType { key_type_string, .. } => format!("unsupported key type {key_type_string}"),
        other => format!("not a usable private key ({other})"),
    }
}

/// Comma-separated method names (`publickey, password`).
fn names(methods: &MethodSet) -> String {
    methods.iter().map(<&str>::from).collect::<Vec<_>>().join(", ")
}

async fn step<T>(what: &str, fut: impl Future<Output = Result<T, russh::Error>>) -> Result<T, TransportError> {
    match tokio::time::timeout(STEP_TIMEOUT, fut).await {
        Ok(r) => r.map_err(TransportError::from),
        Err(_) => Err(TransportError::Timeout { what: what.to_owned(), secs: STEP_TIMEOUT.as_secs() }),
    }
}

/// The host ended the sign-in (closed the connection, or refused with nothing left to try).
fn ended(method: &'static str, user: &str, banner: Option<String>) -> TransportError {
    if method == method_name(SshAuth::Tailscale) {
        TransportError::AuthDenied { banner }
    } else {
        TransportError::SignInClosed { method, user: user.to_owned(), banner }
    }
}

/// Authenticates as `user` with `credential`. `banner` returns the latest server banner (tidied)
/// for denial messages. On failure the connection is closed politely.
pub(super) async fn sign_in(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    credential: Credential,
    auth_timeout: Duration,
    banner: impl Fn() -> Option<String>,
) -> Result<(), TransportError> {
    let method = credential.method();
    let result = async {
        // `none` first: Tailscale SSH signs in here (holding it through check mode); a regular
        // sshd refuses it and lists the methods it offers.
        let offered = match tokio::time::timeout(auth_timeout, handle.authenticate_none(user)).await {
            Err(_) => return Err(TransportError::AuthTimeout { mins: auth_timeout.as_secs() / 60 }),
            Ok(Err(e)) if !handle.is_closed() => return Err(e.into()),
            Ok(Ok(AuthResult::Success)) => return Ok(()),
            // The server closing during auth lands here too, with no methods left.
            Ok(Ok(AuthResult::Failure { remaining_methods, .. })) if !remaining_methods.is_empty() && !handle.is_closed() => {
                remaining_methods
            }
            Ok(_) => return Err(ended(method, user, banner())),
        };
        match credential {
            Credential::Tailscale => Err(TransportError::NotTailscaleSsh { methods: names(&offered) }),
            Credential::Password(password) => sign_in_password(handle, user, &password, &offered, &banner).await,
            Credential::Key(key) => sign_in_key(handle, user, key, &offered, &banner).await,
        }
    }
    .await;
    if result.is_err() && !handle.is_closed() {
        let _ = tokio::time::timeout(Duration::from_secs(2), handle.disconnect(Disconnect::ByApplication, "", "en")).await;
    }
    result
}

/// Maps the host's answer to one password / key attempt.
fn settle(
    answer: AuthResult,
    handle: &Handle<ClientHandler>,
    method: &'static str,
    user: &str,
    banner: &impl Fn() -> Option<String>,
    rejected: impl FnOnce() -> TransportError,
) -> Result<(), TransportError> {
    match answer {
        AuthResult::Success => Ok(()),
        AuthResult::Failure { remaining_methods, partial_success: true } => {
            Err(TransportError::AuthIncomplete { method, user: user.to_owned(), needs: names(&remaining_methods) })
        }
        AuthResult::Failure { remaining_methods, .. } if remaining_methods.is_empty() || handle.is_closed() => {
            Err(ended(method, user, banner()))
        }
        AuthResult::Failure { .. } => Err(rejected()),
    }
}

async fn sign_in_password(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    password: &str,
    offered: &MethodSet,
    banner: &impl Fn() -> Option<String>,
) -> Result<(), TransportError> {
    let rejected = || TransportError::PasswordRejected { user: user.to_owned() };
    if offered.contains(&MethodKind::Password) {
        let answer = step("password sign-in", handle.authenticate_password(user, password)).await?;
        return settle(answer, handle, "password", user, banner, rejected);
    }
    if !offered.contains(&MethodKind::KeyboardInteractive) {
        return Err(TransportError::AuthMethodNotAllowed { method: "password", offered: names(offered) });
    }
    // Hosts that take passwords through PAM's conversation only (`PasswordAuthentication no`,
    // `KbdInteractiveAuthentication yes`): answer the password prompt, nothing else.
    let mut answered = false;
    let mut reply = step("password sign-in", handle.authenticate_keyboard_interactive_start(user, None::<String>)).await?;
    for _ in 0..8 {
        let prompts = match reply {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure { remaining_methods, partial_success } => {
                let answer = AuthResult::Failure { remaining_methods, partial_success };
                return settle(answer, handle, "password", user, banner, rejected);
            }
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => prompts,
        };
        let answers = match prompts.as_slice() {
            // Informational round.
            [] => Vec::new(),
            [p] if !p.echo && !answered => {
                answered = true;
                vec![password.to_owned()]
            }
            // Asked for the password again: it was wrong.
            [p] if !p.echo && p.prompt.to_lowercase().contains("password") => return Err(rejected()),
            _ => {
                let needs = prompts.iter().map(|p| format!("\"{}\"", p.prompt.trim())).collect::<Vec<_>>().join(", ");
                return Err(TransportError::AuthIncomplete { method: "password", user: user.to_owned(), needs });
            }
        };
        reply = step("password sign-in", handle.authenticate_keyboard_interactive_respond(answers)).await?;
    }
    Err(TransportError::Ssh("keyboard-interactive sign-in did not finish".into()))
}

async fn sign_in_key(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    key: PrivateKey,
    offered: &MethodSet,
    banner: &impl Fn() -> Option<String>,
) -> Result<(), TransportError> {
    if !offered.contains(&MethodKind::PublicKey) {
        return Err(TransportError::AuthMethodNotAllowed { method: "key", offered: names(offered) });
    }
    let fingerprint = fingerprint(key.public_key());
    // RSA signs with the best `rsa-sha2-*` the host lists (legacy `ssh-rsa` when it lists none).
    let hash = if key.algorithm().is_rsa() { handle.best_supported_rsa_hash().await?.flatten() } else { None };
    let answer = step("key sign-in", handle.authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))).await?;
    settle(answer, handle, "key", user, banner, || TransportError::KeyRejected { user: user.to_owned(), fingerprint })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ED25519: &str = include_str!("../../tests/fixtures/user_ed25519");
    const ED25519_PUB: &str = include_str!("../../tests/fixtures/user_ed25519.pub");
    const ED25519_ENCRYPTED: &str = include_str!("../../tests/fixtures/user_ed25519_encrypted");
    const ECDSA_PKCS8_ENCRYPTED: &str = include_str!("../../tests/fixtures/user_ecdsa_pkcs8_encrypted");
    const RSA_PEM: &str = include_str!("../../tests/fixtures/user_rsa_pem");
    const PASSPHRASE: &str = "correct horse";

    fn code(r: Result<PrivateKey, TransportError>) -> &'static str {
        r.err().map(|e| e.code()).unwrap_or("ok")
    }

    #[test]
    fn keys_decode_and_decrypt() {
        let fp = |pem, pass| check_private_key(pem, pass).unwrap();
        // As `ssh-keygen -lf tests/fixtures/user_ed25519.pub` prints it; the encrypted fixture is
        // the same key saved with a passphrase.
        let expected = "SHA256:w5faCCjlOpNNSoVVvra5jf/2tnLXOECusm0NORvtULw";
        assert!(ED25519_PUB.starts_with("ssh-ed25519 "));
        assert_eq!(fp(ED25519, None), expected);
        assert_eq!(fp(ED25519_ENCRYPTED, Some(PASSPHRASE)), expected);
        assert!(fp(ECDSA_PKCS8_ENCRYPTED, Some(PASSPHRASE)).starts_with("SHA256:"));
        assert!(fp(RSA_PEM, None).starts_with("SHA256:"));
        // A stale passphrase does not break keys that are not encrypted (PKCS#8 would refuse it).
        assert_eq!(fp(ED25519, Some("stale")), fp(ED25519, None));
        assert!(fp(RSA_PEM, Some("stale")).starts_with("SHA256:"));
        // Pasted with CRLF, indentation and blank lines.
        let messy = format!("\n\n{}\n", ED25519.lines().map(|l| format!("   {l}\r")).collect::<Vec<_>>().join("\n\n"));
        assert_eq!(fp(&messy, None), fp(ED25519, None));
    }

    #[test]
    fn passphrase_problems_are_named() {
        for pem in [ED25519_ENCRYPTED, ECDSA_PKCS8_ENCRYPTED] {
            assert_eq!(code(load_key(pem, None, "k")), "transport.keyPassphraseNeeded");
            assert_eq!(code(load_key(pem, Some(""), "k")), "transport.keyPassphraseNeeded");
            assert_eq!(code(load_key(pem, Some("wrong"), "k")), "transport.keyPassphraseWrong");
            assert_eq!(code(load_key(pem, Some(PASSPHRASE), "k")), "ok");
        }
        let e = load_key(ED25519_ENCRYPTED, Some("wrong"), "~/.ssh/id_ed25519").unwrap_err();
        assert_eq!(e.to_string(), "key sign-in failed: wrong passphrase for ~/.ssh/id_ed25519");
    }

    #[test]
    fn non_keys_are_unreadable() {
        let detail = |text: &str| match load_key(text, None, "k") {
            Err(TransportError::KeyUnreadable { detail, .. }) => detail,
            other => panic!("expected KeyUnreadable, got {:?}", other.map(|_| ())),
        };
        assert!(detail(ED25519_PUB).contains("public key"));
        assert!(detail("hello").contains("not a private key"));
        assert!(detail("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n").contains("not a "));
        let des = "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: DES-EDE3-CBC,0011223344556677\n\nAAAA\n-----END RSA PRIVATE KEY-----\n";
        assert!(detail(des).contains("ssh-keygen -p"));
    }

    #[tokio::test]
    async fn credentials_load_from_file_or_saved_text() {
        let dir = std::env::temp_dir().join(format!("tf-transport-cred-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("id_test");
        std::fs::write(&path, ED25519_ENCRYPTED).unwrap();
        let path = path.to_string_lossy().into_owned();
        let secrets = |key: Option<&str>, pass: Option<&str>| HostSecrets {
            password: Some("unused".into()),
            private_key: key.map(Into::into),
            passphrase: pass.map(Into::into),
        };

        let key = Credential::load(SshAuth::Key, Some(&path), &secrets(None, Some(PASSPHRASE))).await.unwrap();
        assert!(matches!(key, Credential::Key(_)));
        let e = Credential::load(SshAuth::Key, Some(&path), &secrets(None, None)).await.err().unwrap();
        assert_eq!(e.to_string(), format!("key sign-in failed: {path} is encrypted and no passphrase is saved"));
        let missing = format!("{path}-missing");
        let e = Credential::load(SshAuth::Key, Some(&missing), &secrets(None, None)).await.err().unwrap();
        assert_eq!(e.to_string(), format!("key sign-in failed: {missing}: no such file on this device"));
        // Without a path the saved key is used; the file path wins over it.
        assert!(matches!(Credential::load(SshAuth::Key, None, &secrets(Some(ED25519), None)).await, Ok(Credential::Key(_))));
        let e = Credential::load(SshAuth::Key, None, &secrets(None, None)).await.err().unwrap();
        assert_eq!(e.code(), "transport.credentialMissing");
        assert_eq!(e.to_string(), "key sign-in failed: no private key is saved for this host");
        let e = Credential::load(SshAuth::Password, None, &HostSecrets::default()).await.err().unwrap();
        assert_eq!(e.to_string(), "password sign-in failed: no password is saved for this host");
        assert!(matches!(Credential::load(SshAuth::Tailscale, None, &HostSecrets::default()).await, Ok(Credential::Tailscale)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn home_expansion() {
        let home = std::env::home_dir().unwrap();
        assert_eq!(expand_home("~/.ssh/id_rsa"), home.join(".ssh/id_rsa"));
        assert_eq!(expand_home("~"), home);
        assert_eq!(expand_home("/etc/key"), PathBuf::from("/etc/key"));
        assert_eq!(expand_home("~other/key"), PathBuf::from("~other/key"));
    }
}
