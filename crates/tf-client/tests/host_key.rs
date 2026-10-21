//! Host key confirmation end to end: engine + SSH transport against tf-transport's
//! in-process SSH server on loopback (not a tailnet address, so new keys need `hosts.trustKey`).
//! Unix only, like the shared server fixture (its exec path runs `sh`).
#![cfg(unix)]

#[path = "../../tf-transport/tests/support/mod.rs"]
mod support;

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use support::{AuthMode, KEY_A, KEY_B, TempDir, TestServer};
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
