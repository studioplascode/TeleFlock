//! Host key confirmation and password / key sign-in end to end: engine + SSH transport against
//! tf-transport's in-process SSH server on loopback (not a tailnet address, so new keys need
//! `hosts.trustKey`). Unix only, like the shared server fixture (its exec path runs `sh`).
#![cfg(unix)]

#[path = "../../tf-transport/tests/support/mod.rs"]
mod support;

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use support::{AuthMode, KEY_A, KEY_B, PASSPHRASE, TempDir, TestServer, USER_KEY, USER_KEY_ENCRYPTED, public_key};
use tf_client::tf_proto::{
    ApiError, AppEvent, ConnPhase, ConnStatus, HostProfile, Notification,
};
use tf_client::{BadgeState, Engine, EngineConfig, NotifyStyle, Platform};
use tokio::sync::broadcast;

struct NullPlatform;
impl Platform for NullPlatform {
    fn notify(&self, _: Option<&HostProfile>, _: &Notification, _: NotifyStyle) {}
    fn open_external(&self, _: &str) -> Result<(), ApiError> {
        Ok(())
    }
    fn set_keep_alive(&self, _: bool) {}
    fn set_badge(&self, _: BadgeState) {}
    fn device_name(&self) -> String {
        "test-device".into()
    }
}

/// Next `HostStatus` for `id` matching `f`.
async fn status(rx: &mut broadcast::Receiver<AppEvent>, id: &str, f: impl Fn(&ConnStatus) -> bool) -> ConnStatus {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            match rx.recv().await {
                Ok(AppEvent::HostStatus { host_id, status }) if host_id == id && f(&status) => return status,
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(e) => panic!("event stream ended: {e}"),
            }
        }
    })
    .await
    .expect("expected host status")
}

#[tokio::test(flavor = "multi_thread")]
async fn new_non_tailnet_key_waits_for_trust() {
    let home = TempDir::new("hk-home");
    let srv = TestServer::start(KEY_A, AuthMode::Accept, home.0.clone()).await;
    let data = tempfile::tempdir().unwrap();
    // An empty override dir makes deploy fail with `not_found` right after the transport is
    // up, so the test proves the SSH connection succeeded without starting a real daemon.
    let bins = tempfile::tempdir().unwrap();
    let cfg = EngineConfig {
        data_dir: data.path().to_path_buf(),
        platform_name: "linux".into(),
        client_app: "teleflock-test".into(),
        version: "0.0.0".into(),
        hostd_bins_override: Some(bins.path().to_path_buf()),
    };
    let (engine, mut rx) = Engine::start(cfg, Arc::new(NullPlatform)).await;
    let saved = engine
        .call(
            None,
            "hosts.save",
            json!({"id": "", "name": "lan box", "kind": "tailscaleSsh", "address": "127.0.0.1",
                   "user": "tester", "port": srv.addr.port(), "herdrSession": "default", "autoConnect": false}),
        )
        .await
        .unwrap();
    let id = saved["id"].as_str().unwrap().to_string();
    let known_hosts = data.path().join("known_hosts");

    // First connect stops at `hostKey` with the fingerprint; nothing is pinned.
    engine.call(None, "hosts.connect", json!({"hostId": id})).await.unwrap();
    let s = status(&mut rx, &id, |s| s.phase == ConnPhase::HostKey).await;
    let key = s.host_key.clone().expect("hostKey info");
    assert_eq!(key.address, "127.0.0.1");
    assert_eq!(key.algorithm, "ssh-ed25519");
    assert!(key.fingerprint.starts_with("SHA256:"), "{key:?}");
    assert_eq!(s.error.as_ref().unwrap().code, "transport.hostKeyUnconfirmed");
    assert!(!known_hosts.exists());

    // Cancel: `hosts.disconnect` leaves `hostKey` for `offline`, and the key is gone.
    engine.call(None, "hosts.disconnect", json!({"hostId": id})).await.unwrap();
    let s = status(&mut rx, &id, |s| s.phase == ConnPhase::Offline).await;
    assert!(s.host_key.is_none());
    let e = engine.call(None, "hosts.trustKey", json!({"hostId": id, "fingerprint": key.fingerprint})).await.unwrap_err();
    assert_eq!(e.code, "invalid_params", "nothing awaits confirmation after cancel");

    // Connect again; a wrong fingerprint is refused, the right one connects and pins.
    engine.call(None, "hosts.connect", json!({"hostId": id})).await.unwrap();
    status(&mut rx, &id, |s| s.phase == ConnPhase::HostKey).await;
    let e = engine.call(None, "hosts.trustKey", json!({"hostId": id, "fingerprint": "SHA256:nope"})).await.unwrap_err();
    assert_eq!(e.code, "invalid_params");
    engine.call(None, "hosts.trustKey", json!({"hostId": id, "fingerprint": key.fingerprint})).await.unwrap();
    status(&mut rx, &id, |s| s.phase == ConnPhase::Deploying).await;
    let s = status(&mut rx, &id, |s| s.phase == ConnPhase::Error).await;
    assert_eq!(s.error.as_ref().unwrap().code, "not_found", "transport up, deploy reached artifacts: {s:?}");
    assert!(s.host_key.is_none());
    let pinned = std::fs::read_to_string(&known_hosts).unwrap();
    assert!(pinned.starts_with(&format!("[127.0.0.1]:{} ssh-ed25519 ", srv.addr.port())), "{pinned}");

    // A changed key is always an error, never a new confirmation.
    srv.set_key(KEY_B);
    engine.call(None, "hosts.connect", json!({"hostId": id})).await.unwrap();
    let s = status(&mut rx, &id, |s| s.phase == ConnPhase::Error).await;
    assert_eq!(s.error.as_ref().unwrap().code, "transport.hostKeyMismatch");
    assert!(s.host_key.is_none());
    let e: Value = serde_json::to_value(
        engine.call(None, "hosts.trustKey", json!({"hostId": id, "fingerprint": key.fingerprint})).await.unwrap_err(),
    )
    .unwrap();
    assert_eq!(e["code"], "invalid_params");
    engine.shutdown().await;
}

fn engine_config(data: &std::path::Path, bins: &std::path::Path) -> EngineConfig {
    EngineConfig {
        data_dir: data.to_path_buf(),
        platform_name: "linux".into(),
        client_app: "teleflock-test".into(),
        version: "0.0.0".into(),
        hostd_bins_override: Some(bins.to_path_buf()),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn password_host_keeps_its_secret_out_of_profiles_and_events() {
    let home = TempDir::new("pw-home");
    let srv = TestServer::start(KEY_A, AuthMode::Sshd { password: Some("s3cret".into()), keys: vec![], keyboard_interactive: false }, home.0.clone()).await;
    let (data, bins) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (engine, mut rx) = Engine::start(engine_config(data.path(), bins.path()), Arc::new(NullPlatform)).await;
    let mut everything = engine.subscribe();
    let mut profile = json!({"id": "", "name": "lan box", "kind": "tailscaleSsh", "address": "127.0.0.1", "user": "tester",
                             "port": srv.addr.port(), "auth": "password", "herdrSession": "default", "autoConnect": false});
    let with = |p: &Value, secrets: Value| {
        let mut p = p.clone();
        p["secrets"] = secrets;
        p
    };

    // A password host needs its password.
    let e = engine.call(None, "hosts.save", profile.clone()).await.unwrap_err();
    assert_eq!((e.code.as_str(), e.message.as_str()), ("invalid_params", "enter the password for password sign-in"));

    let saved = engine.call(None, "hosts.save", with(&profile, json!({"password": "wrong-one"}))).await.unwrap();
    let id = saved["id"].as_str().unwrap().to_string();
    profile["id"] = json!(id);
    assert_eq!(saved["auth"], "password");
    assert!(saved.get("secrets").is_none(), "{saved}");
    let stored = |id: &str| engine.call(None, "hosts.secretStatus", json!({"hostId": id}));
    assert_eq!(stored(&id).await.unwrap(), json!({"password": true, "privateKey": false, "passphrase": false}));
    let secrets_file = data.path().join("secrets.json");
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&secrets_file).unwrap().permissions().mode() & 0o777, 0o600);
    }

    // Host key first (loopback is not the tailnet), then the wrong password: an error that is
    // tried once and never retried on its own.
    engine.call(None, "hosts.connect", json!({"hostId": id})).await.unwrap();
    let s = status(&mut rx, &id, |s| s.phase == ConnPhase::HostKey).await;
    assert!(srv.attempts().is_empty(), "no credential before the host key is confirmed");
    let fingerprint = s.host_key.unwrap().fingerprint;
    engine.call(None, "hosts.trustKey", json!({"hostId": id, "fingerprint": fingerprint})).await.unwrap();
    let s = status(&mut rx, &id, |s| s.phase == ConnPhase::Error).await;
    let e = s.error.unwrap();
    assert_eq!(e.code, "transport.passwordRejected");
    assert_eq!(e.message, "password sign-in as tester failed: the host rejected the password");
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(srv.attempts(), ["none", "password"]);

    // Fix the password; editing other fields later keeps it.
    engine.call(None, "hosts.save", with(&profile, json!({"password": "s3cret"}))).await.unwrap();
    engine.call(None, "hosts.connect", json!({"hostId": id})).await.unwrap();
    status(&mut rx, &id, |s| s.phase == ConnPhase::Deploying).await;
    let s = status(&mut rx, &id, |s| s.phase == ConnPhase::Error).await;
    assert_eq!(s.error.unwrap().code, "not_found", "signed in, deploy reached the (empty) artifacts");
    let mut renamed = profile.clone();
    renamed["name"] = json!("lan box 2");
    engine.call(None, "hosts.save", renamed).await.unwrap();
    assert_eq!(stored(&id).await.unwrap()["password"], true);

    // Diagnostics name the method; typed secrets are tried instead of the saved ones.
    let auth_step = |report: Value| report["steps"].as_array().unwrap().iter().find(|s| s["id"] == "auth").unwrap().clone();
    let auth = auth_step(engine.call(None, "hosts.test", profile.clone()).await.unwrap());
    assert_eq!((auth["label"].as_str(), auth["status"].as_str()), (Some("Password sign-in"), Some("ok")), "{auth}");
    let auth = auth_step(engine.call(None, "hosts.test", with(&profile, json!({"password": "nope"}))).await.unwrap());
    assert_eq!(auth["status"], "fail");
    assert!(auth["detail"].as_str().unwrap().contains("rejected the password"), "{auth}");
    assert_eq!(stored(&id).await.unwrap()["password"], true, "a test never saves");

    // Back to Tailscale SSH: the password goes. Removing the host deletes what is left.
    let mut ts = profile.clone();
    ts["auth"] = json!("tailscale");
    let saved = engine.call(None, "hosts.save", ts).await.unwrap();
    assert!(saved.get("auth").is_none(), "tailscale is the default: {saved}");
    assert_eq!(stored(&id).await.unwrap()["password"], false);
    assert!(!secrets_file.exists());
    engine.call(None, "hosts.save", with(&profile, json!({"password": "s3cret"}))).await.unwrap();
    assert!(secrets_file.exists());
    engine.call(None, "hosts.remove", json!({"hostId": id})).await.unwrap();
    assert!(!secrets_file.exists());
    assert_eq!(stored(&id).await.unwrap_err().code, "not_found");

    // The secrets never reached the profile file or the event stream.
    let hosts = std::fs::read_to_string(data.path().join("hosts.json")).unwrap();
    let mut events = Vec::new();
    while let Ok(ev) = everything.try_recv() {
        events.push(serde_json::to_string(&ev).unwrap());
    }
    assert!(events.len() > 10);
    for text in events.iter().chain([&hosts]) {
        assert!(!text.contains("s3cret") && !text.contains("wrong-one") && !text.contains("nope"), "{text}");
    }
    engine.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn saved_keys_are_checked_and_follow_the_method() {
    let home = TempDir::new("key-home");
    let srv = TestServer::start(KEY_A, AuthMode::Sshd { password: None, keys: vec![public_key(USER_KEY)], keyboard_interactive: false }, home.0.clone()).await;
    let (data, bins) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (engine, mut rx) = Engine::start(engine_config(data.path(), bins.path()), Arc::new(NullPlatform)).await;
    let host = |secrets: Value, key_path: Option<&str>| {
        json!({"id": "box", "name": "box", "kind": "tailscaleSsh", "address": "127.0.0.1", "user": "tester",
               "port": srv.addr.port(), "auth": "key", "keyPath": key_path, "herdrSession": "default",
               "autoConnect": false, "secrets": secrets})
    };
    let save = |p: Value| engine.call(None, "hosts.save", p);

    // An imported key is checked before it is saved, passphrase included.
    let e = save(host(json!({}), None)).await.unwrap_err();
    assert_eq!(e.message, "choose a key file or import a private key for key sign-in");
    let e = save(host(json!({"privateKey": "ssh-ed25519 AAAA… me@laptop"}), None)).await.unwrap_err();
    assert!(e.message.contains("public key"), "{e:?}");
    let e = save(host(json!({"privateKey": USER_KEY_ENCRYPTED}), None)).await.unwrap_err();
    assert_eq!(e.message, "this private key is encrypted: enter its passphrase");
    let e = save(host(json!({"privateKey": USER_KEY_ENCRYPTED, "passphrase": "wrong"}), None)).await.unwrap_err();
    assert_eq!((e.code.as_str(), e.message.as_str()), ("invalid_params", "wrong passphrase for this private key"));
    save(host(json!({"privateKey": USER_KEY_ENCRYPTED, "passphrase": PASSPHRASE}), None)).await.unwrap();
    let stored = || engine.call(None, "hosts.secretStatus", json!({"hostId": "box"}));
    assert_eq!(stored().await.unwrap(), json!({"password": false, "privateKey": true, "passphrase": true}));

    // It signs in (after the host key), with the saved passphrase.
    engine.call(None, "hosts.connect", json!({"hostId": "box"})).await.unwrap();
    let s = status(&mut rx, "box", |s| s.phase == ConnPhase::HostKey).await;
    engine.call(None, "hosts.trustKey", json!({"hostId": "box", "fingerprint": s.host_key.unwrap().fingerprint})).await.unwrap();
    let s = status(&mut rx, "box", |s| s.phase == ConnPhase::Error).await;
    assert_eq!(s.error.unwrap().code, "not_found", "signed in, deploy reached the (empty) artifacts");
    let fingerprint = public_key(USER_KEY).fingerprint(russh::keys::HashAlg::Sha256);
    assert_eq!(srv.attempts(), ["none".to_string(), format!("publickey {fingerprint}")]);

    // A key file replaces the imported key; its passphrase stays.
    save(host(json!({}), Some("~/.ssh/id_ed25519"))).await.unwrap();
    assert_eq!(stored().await.unwrap(), json!({"password": false, "privateKey": false, "passphrase": true}));
    // An empty value deletes a saved secret.
    save(host(json!({"passphrase": ""}), Some("~/.ssh/id_ed25519"))).await.unwrap();
    assert_eq!(stored().await.unwrap(), json!({"password": false, "privateKey": false, "passphrase": false}));
    assert!(!data.path().join("secrets.json").exists());
    engine.shutdown().await;
}
