//! SSH transport against the in-process russh server (hermetic; no network beyond loopback).

mod support;

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use support::*;
use tf_transport::{
    Cmd, ConnPhase, ConnectOptions, HostKeyDecision, HostKeyPolicy, HostKind, HostProfile, HostSecrets, SshAuth, TransportError,
    TransportEvent, connect, is_tailnet_ip,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const T: Duration = Duration::from_secs(10);

async fn read_exact_string(r: &mut (impl tokio::io::AsyncRead + Unpin), n: usize) -> String {
    let mut buf = vec![0u8; n];
    tokio::time::timeout(T, r.read_exact(&mut buf)).await.expect("read timed out").unwrap();
    String::from_utf8(buf).unwrap()
}

/// HOME with a ~/.profile that adds ~/.local/bin to PATH and a `tf-hello` there,
/// to prove commands run in a login shell.
fn home() -> TempDir {
    let home = TempDir::new("home");
    std::fs::create_dir_all(home.0.join(".local/bin")).unwrap();
    std::fs::write(home.0.join(".profile"), "PATH=\"$HOME/.local/bin:$PATH\"\nexport PATH\n").unwrap();
    let script = home.0.join(".local/bin/tf-hello");
    std::fs::write(&script, "#!/bin/sh\necho \"hello from login PATH: $*\"\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    home
}

#[tokio::test(flavor = "multi_thread")]
async fn exec_paths_and_phases() {
    let home = home();
    let srv = TestServer::start(KEY_A, AuthMode::Accept, home.0.clone()).await;
    let dir = TempDir::new("kh");
    let ev = Events::new();
    let t = connect(&profile(srv.addr), &opts(&dir), ev.tx.clone()).await.expect("connect");
    assert_eq!(t.kind(), HostKind::TailscaleSsh);

    // Hostile argv survives POSIX quoting through the remote shell.
    let args = ["a b", "it's", "$HOME", "`id`", r"back\slash", "", "*"];
    let mut argv = vec!["printf", "[%s]"];
    argv.extend(args);
    let out = t.exec(&Cmd::new(argv)).await.unwrap();
    assert!(out.status.success());
    assert_eq!(out.stdout_str(), "[a b][it's][$HOME][`id`][back\\slash][][*]");

    // Login shell: ~/.local/bin is on PATH.
    let out = t.exec(&Cmd::new(["tf-hello", "x y"])).await.unwrap();
    assert_eq!(out.stdout_str(), "hello from login PATH: x y\n");

    // Exit code, stderr, env and cwd (with ~).
    let out = t.exec(&Cmd::new(["sh", "-c", "echo oops >&2; exit 7"])).await.unwrap();
    assert_eq!(out.status.code, Some(7));
    assert_eq!(out.stderr_str(), "oops\n");
    std::fs::create_dir_all(home.0.join("my dir")).unwrap();
    let out = t.exec(&Cmd::new(["sh", "-c", "echo \"$FOO\"; pwd"]).env("FOO", "bar 'baz'").cwd("~/my dir")).await.unwrap();
    assert_eq!(out.stdout_str(), format!("bar 'baz'\n{}/my dir\n", home.0.display()));

    // Large stdin (upload path) with EOF.
    let blob: Vec<u8> = (0..3 * 1024 * 1024u32).map(|i| (i % 251) as u8).collect();
    let out = t.exec(&Cmd::new(["sh", "-c", "cat > up.bin && wc -c < up.bin"]).stdin(blob.clone())).await.unwrap();
    assert_eq!(out.stdout_str().trim(), blob.len().to_string());
    assert_eq!(std::fs::read(home.0.join("up.bin")).unwrap(), blob);
    // Without stdin, stdin is closed right away (no hang).
    let out = t.exec(&Cmd::new(["cat"]).timeout(T)).await.unwrap();
    assert!(out.status.success() && out.stdout.is_empty());

    // Timeout kills the command; the connection stays usable.
    let t0 = Instant::now();
    let err = t.exec(&Cmd::new(["sleep", "20"]).timeout(Duration::from_millis(300))).await.unwrap_err();
    assert!(matches!(err, TransportError::Timeout { .. }), "{err:?}");
    assert!(t0.elapsed() < Duration::from_secs(5));
    assert!(t.exec(&Cmd::new(["true"])).await.unwrap().status.success());

    // Many concurrent channels over the one connection.
    let mut set = tokio::task::JoinSet::new();
    for i in 0..16 {
        let t = t.clone();
        set.spawn(async move { t.exec(&Cmd::new(["echo", &i.to_string()])).await.unwrap().stdout_str() });
    }
    let mut got: Vec<String> = set.join_all().await;
    got.sort();
    assert_eq!(got.len(), 16);

    // Phases + latency.
    let evs = ev.all();
    assert!(matches!(evs[0], TransportEvent::Phase(ConnPhase::Connecting, _)), "{evs:?}");
    assert!(evs.iter().any(|e| matches!(e, TransportEvent::Phase(ConnPhase::Connecting, Some(m)) if m.contains("Trusted new host key SHA256:"))));
    assert!(evs.iter().any(|e| matches!(e, TransportEvent::Phase(ConnPhase::Authenticating, _))));
    ev.wait_for(T, |e| matches!(e, TransportEvent::Latency(_))).await;
    assert!(!evs.iter().any(|e| matches!(e, TransportEvent::AuthUrl(_))));

    // Clean close.
    t.close().await;
    ev.wait_for(T, |e| *e == TransportEvent::Closed(None)).await;
    let err = t.exec(&Cmd::new(["true"])).await.unwrap_err();
    assert!(matches!(err, TransportError::Closed(None)), "{err:?}");
    t.close().await;
    assert_eq!(ev.all().iter().filter(|e| matches!(e, TransportEvent::Closed(_))).count(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn host_key_tofu_and_mismatch() {
    let home = TempDir::new("home");
    let srv = TestServer::start(KEY_A, AuthMode::Accept, home.0.clone()).await;
    let dir = TempDir::new("kh");
    let o = opts(&dir);

    let ev = Events::new();
    let t = connect(&profile(srv.addr), &o, ev.tx.clone()).await.expect("first connect pins");
    t.close().await;
    let kh = std::fs::read_to_string(&o.known_hosts).unwrap();
    assert_eq!(kh.lines().count(), 1);
    assert!(kh.starts_with(&format!("[127.0.0.1]:{} ssh-ed25519 ", srv.addr.port())), "{kh}");

    let ev2 = Events::new();
    let t = connect(&profile(srv.addr), &o, ev2.tx.clone()).await.expect("known key");
    t.close().await;
    assert!(!ev2.all().iter().any(|e| matches!(e, TransportEvent::Phase(_, Some(m)) if m.contains("Trusted new host key"))));

    srv.set_key(KEY_B);
    let err = connect(&profile(srv.addr), &o, Events::new().tx).await.err().expect("mismatch must fail");
    match &err {
        TransportError::HostKeyMismatch { host, expected, actual, known_hosts } => {
            assert_eq!(host, &format!("[127.0.0.1]:{}", srv.addr.port()));
            assert_eq!(expected.len(), 1);
            assert_ne!(&expected[0], actual);
            assert!(actual.starts_with("SHA256:"));
            assert!(known_hosts.ends_with("known_hosts"));
        }
        other => panic!("expected HostKeyMismatch, got {other:?}"),
    }
    assert_eq!(err.code(), "transport.hostKeyMismatch");
    assert!(err.hint().unwrap().contains("known_hosts"));
    // The pinned key was not replaced.
    assert_eq!(std::fs::read_to_string(&o.known_hosts).unwrap(), kh);
}

#[tokio::test(flavor = "multi_thread")]
async fn non_tailnet_key_needs_confirmation() {
    let home = TempDir::new("home");
    let srv = TestServer::start(KEY_A, AuthMode::Accept, home.0.clone()).await;
    let dir = TempDir::new("kh");
    // Default policy: loopback is not a tailnet address, so the first key is not pinned.
    let mut o = opts(&dir);
    o.host_key_policy = HostKeyPolicy::tailnet_only();
    let err = connect(&profile(srv.addr), &o, Events::new().tx).await.err().expect("unconfirmed key must stop");
    let TransportError::HostKeyUnconfirmed { host, address, algorithm, fingerprint } = &err else {
        panic!("expected HostKeyUnconfirmed, got {err:?}")
    };
    assert_eq!(host, &format!("[127.0.0.1]:{}", srv.addr.port()));
    assert_eq!(address, "127.0.0.1");
    assert_eq!(algorithm, "ssh-ed25519");
    assert!(fingerprint.starts_with("SHA256:"));
    assert_eq!(err.code(), "transport.hostKeyUnconfirmed");
    assert!(!err.retryable());
    assert!(!o.known_hosts.exists(), "nothing pinned before confirmation");

    // The user confirmed this fingerprint: pin it and connect.
    let confirmed = fingerprint.clone();
    o.host_key_policy = HostKeyPolicy::new(move |c| {
        if c.fingerprint == confirmed { HostKeyDecision::Trust } else { HostKeyDecision::Confirm }
    });
    let t = connect(&profile(srv.addr), &o, Events::new().tx).await.expect("confirmed key connects");
    t.close().await;
    assert_eq!(std::fs::read_to_string(&o.known_hosts).unwrap().lines().count(), 1);

    // A changed key is a mismatch even under a policy that would trust anything new.
    srv.set_key(KEY_B);
    o.host_key_policy = HostKeyPolicy::new(|_| HostKeyDecision::Trust);
    let err = connect(&profile(srv.addr), &o, Events::new().tx).await.err().expect("mismatch");
    assert!(matches!(err, TransportError::HostKeyMismatch { .. }), "{err:?}");
}

#[test]
fn tailnet_ranges() {
    let tailnet = |s: &str| is_tailnet_ip(s.parse().unwrap());
    assert!(tailnet("100.64.0.1"));
    assert!(tailnet("100.127.255.254"));
    assert!(tailnet("::ffff:100.100.1.2"));
    assert!(tailnet("fd7a:115c:a1e0::1"));
    assert!(tailnet("fd7a:115c:a1e0:ab12:4843:cd96:6258:b240"));
    assert!(!tailnet("100.63.255.255"));
    assert!(!tailnet("100.128.0.1"));
    assert!(!tailnet("127.0.0.1"));
    assert!(!tailnet("192.168.1.10"));
    assert!(!tailnet("fd7a:115c:a1e1::1"));
    assert!(!tailnet("::1"));
}

#[tokio::test(flavor = "multi_thread")]
async fn check_mode_banner_then_delayed_accept() {
    let home = TempDir::new("home");
    let delay = Duration::from_millis(1500);
    let srv = TestServer::start(KEY_A, AuthMode::Check { delay }, home.0.clone()).await;
    let dir = TempDir::new("kh");
    let ev = Events::new();
    let t0 = Instant::now();
    let task = tokio::spawn({
        let (p, o, tx) = (profile(srv.addr), opts(&dir), ev.tx.clone());
        async move { connect(&p, &o, tx).await }
    });
    // The URL shows up while auth is still pending.
    let url = ev.wait_for(T, |e| matches!(e, TransportEvent::AuthUrl(_))).await;
    assert_eq!(url, TransportEvent::AuthUrl(CHECK_URL.into()));
    assert!(t0.elapsed() < delay, "AuthUrl must arrive before approval");
    assert!(!task.is_finished());
    let phase = ev.wait_for(T, |e| matches!(e, TransportEvent::Phase(ConnPhase::AuthRequired, _))).await;
    let TransportEvent::Phase(_, Some(msg)) = phase else { panic!() };
    assert!(msg.contains("additional check") && msg.contains(CHECK_URL), "{msg}");

    let t = task.await.unwrap().expect("accepted after approval");
    assert!(t0.elapsed() >= delay);
    assert_eq!(t.exec(&Cmd::new(["echo", "ok"])).await.unwrap().stdout_str(), "ok\n");
    t.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn check_mode_cancel_by_dropping_connect() {
    let home = TempDir::new("home");
    let srv = TestServer::start(KEY_A, AuthMode::Check { delay: Duration::from_secs(60) }, home.0.clone()).await;
    let dir = TempDir::new("kh");
    let ev = Events::new();
    let (p, o) = (profile(srv.addr), opts(&dir));
    let fut = connect(&p, &o, ev.tx.clone());
    assert!(tokio::time::timeout(Duration::from_millis(700), fut).await.is_err());
    assert!(ev.all().iter().any(|e| matches!(e, TransportEvent::AuthUrl(_))));
    // No Closed for a connection that never got established.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!ev.all().iter().any(|e| matches!(e, TransportEvent::Closed(_))));
}

#[tokio::test(flavor = "multi_thread")]
async fn auth_denied_and_not_tailscale() {
    let home = TempDir::new("home");
    let dir = TempDir::new("kh");

    let srv = TestServer::start(KEY_A, AuthMode::Deny, home.0.clone()).await;
    let err = connect(&profile(srv.addr), &opts(&dir), Events::new().tx).await.err().unwrap();
    match &err {
        TransportError::AuthDenied { banner } => assert_eq!(banner.as_deref(), Some("tailscale: access denied")),
        other => panic!("expected AuthDenied, got {other:?}"),
    }
    assert!(!err.retryable());

    let srv = TestServer::start(KEY_A, AuthMode::OpenSsh, home.0.clone()).await;
    let err = connect(&profile(srv.addr), &opts(&dir), Events::new().tx).await.err().unwrap();
    match &err {
        TransportError::NotTailscaleSsh { methods } => assert!(methods.contains("publickey"), "{methods}"),
        other => panic!("expected NotTailscaleSsh, got {other:?}"),
    }
    assert!(err.hint().unwrap().contains("tailscale set --ssh"));
}

/// `profile` signing in with `auth` (and the key file at `key_path`).
fn signing_in(addr: SocketAddr, auth: SshAuth, key_path: Option<&std::path::Path>) -> HostProfile {
    let mut p = profile(addr);
    p.auth = Some(auth);
    p.key_path = key_path.map(|k| k.to_string_lossy().into_owned());
    p
}

fn with_secrets(dir: &TempDir, password: Option<&str>, private_key: Option<&str>, passphrase: Option<&str>) -> ConnectOptions {
    let mut o = opts(dir);
    o.secrets = HostSecrets { password: password.map(Into::into), private_key: private_key.map(Into::into), passphrase: passphrase.map(Into::into) };
    o
}

fn sshd(password: Option<&str>, keys: &[&str], keyboard_interactive: bool) -> AuthMode {
    AuthMode::Sshd { password: password.map(Into::into), keys: keys.iter().map(|k| public_key(k)).collect(), keyboard_interactive }
}

/// Writes `pem` as a key file in `dir`.
fn key_file(dir: &TempDir, name: &str, pem: &str) -> std::path::PathBuf {
    let path = dir.0.join(name);
    std::fs::write(&path, pem).unwrap();
    path
}

const USER_FP: &str = "SHA256:w5faCCjlOpNNSoVVvra5jf/2tnLXOECusm0NORvtULw";

#[tokio::test(flavor = "multi_thread")]
async fn password_sign_in() {
    let (home, dir) = (TempDir::new("home"), TempDir::new("kh"));
    let srv = TestServer::start(KEY_A, sshd(Some("s3cret pw"), &[USER_KEY], false), home.0.clone()).await;
    let p = signing_in(srv.addr, SshAuth::Password, None);

    let ev = Events::new();
    let t = connect(&p, &with_secrets(&dir, Some("s3cret pw"), None, None), ev.tx.clone()).await.expect("password accepted");
    assert_eq!(t.exec(&Cmd::new(["echo", "ok"])).await.unwrap().stdout_str(), "ok\n");
    t.close().await;
    let signing = TransportEvent::Phase(ConnPhase::Authenticating, Some("Signing in as tester with a password…".into()));
    assert!(ev.all().contains(&signing), "{:?}", ev.all());
    assert_eq!(srv.attempts(), ["none", "password"]);

    // A wrong password is named, tried once and never retried; the key the host would accept
    // is not a fallback.
    let err = connect(&p, &with_secrets(&dir, Some("nope"), Some(USER_KEY), None), Events::new().tx).await.err().unwrap();
    assert!(matches!(&err, TransportError::PasswordRejected { user } if user == "tester"), "{err:?}");
    assert_eq!(err.to_string(), "password sign-in as tester failed: the host rejected the password");
    assert_eq!(err.code(), "transport.passwordRejected");
    assert!(!err.retryable());
    assert_eq!(srv.attempts()[2..], ["none", "password"]);

    // Nothing saved: refused before the host is asked anything.
    let err = connect(&p, &with_secrets(&dir, None, None, None), Events::new().tx).await.err().unwrap();
    assert_eq!(err.to_string(), "password sign-in failed: no password is saved for this host");
    assert_eq!(srv.attempts().len(), 4);

    // Password and key sign-in need a user name (Tailscale SSH defaults to this device's).
    let mut nameless = p.clone();
    nameless.user = None;
    let err = connect(&nameless, &with_secrets(&dir, Some("s3cret pw"), None, None), Events::new().tx).await.err().unwrap();
    assert!(matches!(&err, TransportError::Config(m) if m.contains("needs a user name")), "{err:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn password_over_keyboard_interactive() {
    let (home, dir) = (TempDir::new("home"), TempDir::new("kh"));
    let srv = TestServer::start(KEY_A, sshd(Some("s3cret pw"), &[], true), home.0.clone()).await;
    let p = signing_in(srv.addr, SshAuth::Password, None);

    let t = connect(&p, &with_secrets(&dir, Some("s3cret pw"), None, None), Events::new().tx).await.expect("password prompt answered");
    t.close().await;
    assert_eq!(srv.attempts(), ["none", "keyboard-interactive", "keyboard-interactive answer"]);

    let err = connect(&p, &with_secrets(&dir, Some("nope"), None, None), Events::new().tx).await.err().unwrap();
    assert_eq!(err.code(), "transport.passwordRejected", "{err:?}");
    assert_eq!(srv.attempts()[3..], ["none", "keyboard-interactive", "keyboard-interactive answer"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn key_sign_in() {
    let (home, dir, keys) = (TempDir::new("home"), TempDir::new("kh"), TempDir::new("keys"));
    let ed25519 = key_file(&keys, "id_ed25519", USER_KEY);
    let rsa = key_file(&keys, "id_rsa", USER_KEY_RSA);
    let srv = TestServer::start(KEY_A, sshd(Some("pw"), &[USER_KEY, USER_KEY_RSA], false), home.0.clone()).await;

    // Key file on this device; the password the host would accept is not a fallback.
    let ev = Events::new();
    let p = signing_in(srv.addr, SshAuth::Key, Some(&ed25519));
    let t = connect(&p, &with_secrets(&dir, Some("pw"), None, None), ev.tx.clone()).await.expect("key accepted");
    assert_eq!(t.exec(&Cmd::new(["echo", "ok"])).await.unwrap().stdout_str(), "ok\n");
    t.close().await;
    assert!(ev.all().contains(&TransportEvent::Phase(ConnPhase::Authenticating, Some("Signing in as tester with a key…".into()))));
    assert_eq!(srv.attempts(), ["none".to_string(), format!("publickey {USER_FP}")]);

    // RSA (PEM / PKCS#1), signed with an rsa-sha2 hash the host lists.
    let t = connect(&signing_in(srv.addr, SshAuth::Key, Some(&rsa)), &opts(&dir), Events::new().tx).await.expect("RSA key accepted");
    t.close().await;

    // The saved key (imported on Android) when the profile names no file.
    let t = connect(&signing_in(srv.addr, SshAuth::Key, None), &with_secrets(&dir, None, Some(USER_KEY), None), Events::new().tx)
        .await
        .expect("saved key accepted");
    t.close().await;

    // A key the host does not authorize: rejected, named by fingerprint, nothing else tried.
    let srv = TestServer::start(KEY_A, sshd(Some("pw"), &[USER_KEY_RSA], false), home.0.clone()).await;
    let err = connect(&signing_in(srv.addr, SshAuth::Key, Some(&ed25519)), &with_secrets(&dir, Some("pw"), None, None), Events::new().tx)
        .await
        .err()
        .unwrap();
    assert!(matches!(&err, TransportError::KeyRejected { user, fingerprint } if user == "tester" && fingerprint == USER_FP), "{err:?}");
    assert_eq!(err.to_string(), format!("key sign-in as tester failed: the host does not accept key {USER_FP}"));
    assert!(err.hint().unwrap().contains("authorized_keys of tester"));
    assert!(!err.retryable());
    assert_eq!(srv.attempts(), ["none".to_string(), format!("publickey {USER_FP}")]);
}

#[tokio::test(flavor = "multi_thread")]
async fn encrypted_key_needs_its_passphrase() {
    let (home, dir, keys) = (TempDir::new("home"), TempDir::new("kh"), TempDir::new("keys"));
    let encrypted = key_file(&keys, "id_ed25519", USER_KEY_ENCRYPTED);
    let srv = TestServer::start(KEY_A, sshd(None, &[USER_KEY, USER_KEY_PKCS8_ENCRYPTED], false), home.0.clone()).await;
    let p = signing_in(srv.addr, SshAuth::Key, Some(&encrypted));

    let t = connect(&p, &with_secrets(&dir, None, None, Some(PASSPHRASE)), Events::new().tx).await.expect("decrypted key accepted");
    t.close().await;
    assert_eq!(srv.attempts(), ["none".to_string(), format!("publickey {USER_FP}")]);

    // Passphrase problems are found on this device: the host is never asked.
    let path = encrypted.display().to_string();
    let err = connect(&p, &with_secrets(&dir, None, None, None), Events::new().tx).await.err().unwrap();
    assert!(matches!(&err, TransportError::KeyPassphraseNeeded { key } if *key == path), "{err:?}");
    assert_eq!(err.to_string(), format!("key sign-in failed: {path} is encrypted and no passphrase is saved"));
    let err = connect(&p, &with_secrets(&dir, None, None, Some("wrong")), Events::new().tx).await.err().unwrap();
    assert!(matches!(&err, TransportError::KeyPassphraseWrong { key } if *key == path), "{err:?}");
    assert!(!err.retryable());
    assert_eq!(srv.attempts().len(), 2);

    // An encrypted PKCS#8 key saved in the app.
    let saved = signing_in(srv.addr, SshAuth::Key, None);
    let t = connect(&saved, &with_secrets(&dir, None, Some(USER_KEY_PKCS8_ENCRYPTED), Some(PASSPHRASE)), Events::new().tx)
        .await
        .expect("saved PKCS#8 key accepted");
    t.close().await;
    let err = connect(&saved, &with_secrets(&dir, None, Some(USER_KEY_PKCS8_ENCRYPTED), Some("wrong")), Events::new().tx).await.err().unwrap();
    assert_eq!(err.to_string(), "key sign-in failed: wrong passphrase for the saved key");
}

#[tokio::test(flavor = "multi_thread")]
async fn method_the_host_does_not_offer() {
    let (home, dir, keys) = (TempDir::new("home"), TempDir::new("kh"), TempDir::new("keys"));
    let ed25519 = key_file(&keys, "id_ed25519", USER_KEY);

    // Keys only: the password is never sent.
    let srv = TestServer::start(KEY_A, sshd(None, &[USER_KEY], false), home.0.clone()).await;
    let err = connect(&signing_in(srv.addr, SshAuth::Password, None), &with_secrets(&dir, Some("pw"), None, None), Events::new().tx)
        .await
        .err()
        .unwrap();
    assert!(matches!(&err, TransportError::AuthMethodNotAllowed { method: "password", offered } if offered == "publickey"), "{err:?}");
    assert_eq!(err.to_string(), "password sign-in failed: the host does not allow it (it offers: publickey)");
    assert!(err.hint().unwrap().contains("PasswordAuthentication"));
    assert_eq!(srv.attempts(), ["none"]);

    // Passwords only: the key is never offered.
    let srv = TestServer::start(KEY_A, sshd(Some("pw"), &[], false), home.0.clone()).await;
    let err = connect(&signing_in(srv.addr, SshAuth::Key, Some(&ed25519)), &opts(&dir), Events::new().tx).await.err().unwrap();
    assert!(matches!(&err, TransportError::AuthMethodNotAllowed { method: "key", offered } if offered == "password"), "{err:?}");
    assert_eq!(err.code(), "transport.authMethodNotAllowed");
    assert_eq!(srv.attempts(), ["none"]);

    // A host that needs no credentials (Tailscale SSH) takes `none`: nothing secret is sent.
    let srv = TestServer::start(KEY_A, AuthMode::Accept, home.0.clone()).await;
    let t = connect(&signing_in(srv.addr, SshAuth::Password, None), &with_secrets(&dir, Some("pw"), None, None), Events::new().tx)
        .await
        .expect("none accepted");
    t.close().await;
    assert_eq!(srv.attempts(), ["none"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn host_key_is_confirmed_before_any_credential_is_sent() {
    let (home, dir, keys) = (TempDir::new("home"), TempDir::new("kh"), TempDir::new("keys"));
    let ed25519 = key_file(&keys, "id_ed25519", USER_KEY);
    let srv = TestServer::start(KEY_A, sshd(Some("pw"), &[USER_KEY], false), home.0.clone()).await;
    for p in [signing_in(srv.addr, SshAuth::Password, None), signing_in(srv.addr, SshAuth::Key, Some(&ed25519))] {
        let mut o = with_secrets(&dir, Some("pw"), None, None);
        o.host_key_policy = HostKeyPolicy::tailnet_only();
        let err = connect(&p, &o, Events::new().tx).await.err().expect("unconfirmed key must stop");
        let TransportError::HostKeyUnconfirmed { fingerprint, .. } = &err else { panic!("expected HostKeyUnconfirmed, got {err:?}") };
        assert!(srv.attempts().is_empty(), "no auth request before the host key is trusted");
        assert!(!o.known_hosts.exists());

        let confirmed = fingerprint.clone();
        o.host_key_policy = HostKeyPolicy::new(move |c| if c.fingerprint == confirmed { HostKeyDecision::Trust } else { HostKeyDecision::Confirm });
        let t = connect(&p, &o, Events::new().tx).await.expect("confirmed key, then sign-in");
        t.close().await;
        std::fs::remove_file(&o.known_hosts).unwrap();
        srv.clear_attempts();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn dial_errors_are_friendly() {
    let dir = TempDir::new("kh");
    let mut p = profile("127.0.0.1:1".parse().unwrap());
    p.address = Some("no-such-host.invalid".into());
    let err = connect(&p, &opts(&dir), Events::new().tx).await.err().unwrap();
    assert!(matches!(err, TransportError::Resolve { .. }), "{err:?}");
    assert!(err.hint().unwrap().contains("100.x"));

    let (_guard, port) = dead_port();
    let err = connect(&profile(format!("127.0.0.1:{port}").parse().unwrap()), &opts(&dir), Events::new().tx).await.err().unwrap();
    match &err {
        TransportError::Connect { hint: Some(h), .. } => assert!(h.contains("tailscale set --ssh"), "{h}"),
        other => panic!("expected Connect, got {other:?}"),
    }
    let api: tf_proto::ApiError = err.into();
    assert_eq!(api.code, "transport.connect");
    assert!(api.retryable);

    let mut p = profile("127.0.0.1:22".parse().unwrap());
    p.address = None;
    assert!(matches!(connect(&p, &opts(&dir), Events::new().tx).await.err().unwrap(), TransportError::Config(_)));

    // Hosts signing in with a password or key are not told to turn on Tailscale SSH.
    let p = signing_in(format!("127.0.0.1:{port}").parse().unwrap(), SshAuth::Password, None);
    match connect(&p, &opts(&dir), Events::new().tx).await.err().unwrap() {
        TransportError::Connect { hint: Some(h), .. } => assert!(h.contains("sshd") && !h.contains("tailscale"), "{h}"),
        other => panic!("expected Connect, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn forward_tcp_direct_tcpip() {
    let home = TempDir::new("home");
    let srv = TestServer::start(KEY_A, AuthMode::Accept, home.0.clone()).await;
    let dir = TempDir::new("kh");
    let t = connect(&profile(srv.addr), &opts(&dir), Events::new().tx).await.unwrap();
    let echo = echo_server().await;

    let mut s = t.forward_tcp("127.0.0.1", echo.port()).await.unwrap();
    s.write_all(b"hello through the tunnel").await.unwrap();
    assert_eq!(read_exact_string(&mut s, 24).await, "hello through the tunnel");
    // Two tunnels at once.
    let mut s2 = t.forward_tcp("127.0.0.1", echo.port()).await.unwrap();
    s2.write_all(b"second").await.unwrap();
    assert_eq!(read_exact_string(&mut s2, 6).await, "second");

    let err = t.forward_tcp("forbidden.invalid", 80).await.err().unwrap();
    assert!(matches!(err, TransportError::ForwardDenied { .. }), "{err:?}");
    let (_guard, port) = dead_port();
    let err = t.forward_tcp("127.0.0.1", port).await.err().unwrap();
    assert!(matches!(err, TransportError::ForwardFailed { .. }), "{err:?}");
    t.close().await;

    // wait()/kill() are cancel-safe under select! for SSH children too.
    let t = connect(&profile(srv.addr), &opts(&dir), Events::new().tx).await.unwrap();
    let mut c = t.spawn(&Cmd::new(["sleep", "30"])).await.unwrap();
    for _ in 0..3 {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(30)) => {}
            _ = c.wait() => panic!("sleep 30 cannot have exited"),
        }
    }
    let _ = tokio::time::timeout(Duration::from_millis(1), c.kill()).await;
    tokio::time::timeout(T, c.kill()).await.unwrap();
    assert_eq!(c.wait().await.unwrap().code, Some(128 + 9));
    t.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn spawn_streams_and_kill() {
    let home = TempDir::new("home");
    let srv = TestServer::start(KEY_A, AuthMode::Accept, home.0.clone()).await;
    let dir = TempDir::new("kh");
    let t = connect(&profile(srv.addr), &opts(&dir), Events::new().tx).await.unwrap();

    // Interactive round trips through a long-lived child.
    let mut c = t.spawn(&Cmd::new(["cat"])).await.unwrap();
    let mut stdin = c.stdin.take().unwrap();
    let mut stdout = c.stdout.take().unwrap();
    for i in 0..5 {
        let line = format!("line {i}\n");
        stdin.write_all(line.as_bytes()).await.unwrap();
        assert_eq!(read_exact_string(&mut stdout, line.len()).await, line);
    }
    stdin.shutdown().await.unwrap();
    let mut rest = Vec::new();
    tokio::time::timeout(T, stdout.read_to_end(&mut rest)).await.unwrap().unwrap();
    assert!(rest.is_empty());
    assert!(tokio::time::timeout(T, c.wait()).await.unwrap().unwrap().success());

    // stdout + stderr + exit code; dropping stdin sends EOF.
    let mut c = t.spawn(&Cmd::new(["sh", "-c", "read x; echo \"got $x\"; echo warn >&2; exit 3"])).await.unwrap();
    let mut stdin = c.stdin.take().unwrap();
    stdin.write_all(b"ping\n").await.unwrap();
    drop(stdin);
    let (mut out, mut err) = (String::new(), String::new());
    c.stdout.take().unwrap().read_to_string(&mut out).await.unwrap();
    c.stderr.take().unwrap().read_to_string(&mut err).await.unwrap();
    assert_eq!((out.as_str(), err.as_str()), ("got ping\n", "warn\n"));
    assert_eq!(tokio::time::timeout(T, c.wait()).await.unwrap().unwrap().code, Some(3));
    assert_eq!(c.wait().await.unwrap().code, Some(3), "wait is repeatable");

    // Kill a child that would run for a long time: the host reports the signal death.
    let mut c = t.spawn(&Cmd::new(["sleep", "30"])).await.unwrap();
    let t0 = Instant::now();
    tokio::time::timeout(T, c.kill()).await.unwrap();
    assert!(t0.elapsed() < Duration::from_secs(1));
    assert_eq!(c.wait().await.unwrap().code, Some(128 + 9));

    // A host that ignores `signal`: after the grace period the channel is closed.
    let mut c = t.spawn(&Cmd::new(["sleep", "30"]).env("TF_MARK", "tf-ignore-signal")).await.unwrap();
    let t0 = Instant::now();
    tokio::time::timeout(T, c.kill()).await.unwrap();
    assert!(t0.elapsed() >= Duration::from_millis(1900) && t0.elapsed() < Duration::from_secs(4), "{:?}", t0.elapsed());
    assert_eq!(c.wait().await.unwrap().signal.as_deref(), Some("KILL"));

    // Dropping the Child kills the remote process.
    let mut c = t.spawn(&Cmd::new(["sh", "-c", "echo $$; exec sleep 30"])).await.unwrap();
    let mut out = c.stdout.take().unwrap();
    let mut line = String::new();
    while !line.ends_with('\n') {
        let mut b = [0u8; 1];
        tokio::time::timeout(T, out.read_exact(&mut b)).await.unwrap().unwrap();
        line.push(b[0] as char);
    }
    let pid = line.trim().to_owned();
    assert!(std::path::Path::new(&format!("/proc/{pid}")).exists());
    drop(c);
    let gone = async {
        while std::path::Path::new(&format!("/proc/{pid}")).exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    };
    tokio::time::timeout(T, gone).await.expect("remote process must die when the Child is dropped");

    // Binary-safe streaming of a large payload in both directions.
    let mut c = t.spawn(&Cmd::new(["cat"])).await.unwrap();
    let (mut w, mut r) = (c.stdin.take().unwrap(), c.stdout.take().unwrap());
    let blob: Vec<u8> = (0..2 * 1024 * 1024u32).map(|i| (i.wrapping_mul(7) % 256) as u8).collect();
    let b2 = blob.clone();
    let writer = tokio::spawn(async move {
        w.write_all(&b2).await.unwrap();
        w.shutdown().await.unwrap();
    });
    let mut got = Vec::new();
    tokio::time::timeout(T, r.read_to_end(&mut got)).await.unwrap().unwrap();
    writer.await.unwrap();
    assert_eq!(got.len(), blob.len());
    assert!(got == blob);
    assert!(c.wait().await.unwrap().success());
    t.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn abrupt_disconnect_mid_spawn() {
    let home = TempDir::new("home");
    let srv = TestServer::start(KEY_A, AuthMode::Accept, home.0.clone()).await;
    let proxy = Proxy::start(srv.addr).await;
    let dir = TempDir::new("kh");
    let ev = Events::new();
    let t = connect(&profile(proxy.addr), &opts(&dir), ev.tx.clone()).await.unwrap();

    let mut c = t.spawn(&Cmd::new(["cat"])).await.unwrap();
    let mut stdin = c.stdin.take().unwrap();
    let mut stdout = c.stdout.take().unwrap();
    stdin.write_all(b"before\n").await.unwrap();
    assert_eq!(read_exact_string(&mut stdout, 7).await, "before\n");

    proxy.set(ProxyState::Cut);
    let res = tokio::time::timeout(T, c.wait()).await.expect("wait must end when the link dies");
    assert!(matches!(res, Err(TransportError::Closed(Some(_)))), "{res:?}");
    let mut rest = Vec::new();
    tokio::time::timeout(T, stdout.read_to_end(&mut rest)).await.unwrap().unwrap();
    let closed = ev.wait_for(T, |e| matches!(e, TransportEvent::Closed(_))).await;
    let TransportEvent::Closed(Some(reason)) = closed else { panic!("expected Closed(Some), got {closed:?}") };
    assert!(!reason.is_empty());
    let err = t.exec(&Cmd::new(["true"])).await.unwrap_err();
    assert!(matches!(err, TransportError::Closed(Some(_))), "{err:?}");
    assert!(err.retryable());
}

#[tokio::test(flavor = "multi_thread")]
async fn remote_disconnect_mid_spawn() {
    let home = TempDir::new("home");
    let srv = TestServer::start(KEY_A, AuthMode::Accept, home.0.clone()).await;
    let dir = TempDir::new("kh");
    let ev = Events::new();
    let t = connect(&profile(srv.addr), &opts(&dir), ev.tx.clone()).await.unwrap();
    let mut c = t.spawn(&Cmd::new(["sleep", "30"])).await.unwrap();

    srv.disconnect_all("server shutting down").await;
    let res = tokio::time::timeout(T, c.wait()).await.unwrap();
    assert!(matches!(res, Err(TransportError::Closed(Some(_)))), "{res:?}");
    let closed = ev.wait_for(T, |e| matches!(e, TransportEvent::Closed(_))).await;
    assert_eq!(closed, TransportEvent::Closed(Some("host disconnected: server shutting down".into())));
}

#[tokio::test(flavor = "multi_thread")]
async fn keepalive_latency_and_stall_detection() {
    let home = TempDir::new("home");
    let srv = TestServer::start(KEY_A, AuthMode::Accept, home.0.clone()).await;
    let proxy = Proxy::start(srv.addr).await;
    let dir = TempDir::new("kh");
    let mut o = opts(&dir);
    o.ping_interval = Duration::from_millis(100);
    o.ping_timeout = Duration::from_millis(300);
    o.ping_max_misses = 2;
    let ev = Events::new();
    let t = connect(&profile(proxy.addr), &o, ev.tx.clone()).await.unwrap();

    // Several latency samples while healthy.
    tokio::time::sleep(Duration::from_millis(600)).await;
    let samples = ev.all().iter().filter(|e| matches!(e, TransportEvent::Latency(_))).count();
    assert!(samples >= 3, "latency samples: {samples}");

    // A stalled path (no FIN, no RST) is detected by our pings.
    proxy.set(ProxyState::Frozen);
    let t0 = Instant::now();
    let closed = ev.wait_for(T, |e| matches!(e, TransportEvent::Closed(_))).await;
    let TransportEvent::Closed(Some(reason)) = closed else { panic!("{closed:?}") };
    assert!(reason.contains("keepalive"), "{reason}");
    assert!(t0.elapsed() < Duration::from_secs(3), "{:?}", t0.elapsed());
    assert!(matches!(t.exec(&Cmd::new(["true"])).await, Err(TransportError::Closed(Some(_)))));
    proxy.set(ProxyState::Cut);
}
