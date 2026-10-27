//! The WSL distro keepalive end to end: engine + `WslTransport` against a fake `wsl.exe` on PATH.
//! One keepalive per wanted WSL host, kept across failed attempts and the backoff between them,
//! killed on disconnect, on removal and at shutdown. Unix only (the fake is a shell script, and
//! liveness is read from `/proc`); this file's only test, so changing PATH races no other test.
#![cfg(target_os = "linux")]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;
use tf_client::tf_proto::{ApiError, HostProfile, Notification};
use tf_client::{BadgeState, Engine, EngineConfig, NotifyStyle, Platform};

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

/// Logs `<pid> <args>`. The keepalive sleeps; every other call fails like a cold VM that timed
/// out (retryable), so a connected host keeps retrying with backoff.
const FAKE_WSL: &str = r#"#!/bin/sh
echo "$$ $*" >> "$(dirname "$0")/calls.log"
case "$*" in
  *"--exec sleep "*) exec sleep 600 ;;
esac
echo "The operation timed out. Error code: Wsl/Service/CreateInstance/HCS_E_CONNECTION_TIMEOUT" >&2
exit 1
"#;

fn calls(dir: &Path, what: &str) -> Vec<u32> {
    let log = std::fs::read_to_string(dir.join("calls.log")).unwrap_or_default();
    log.lines().filter(|l| l.contains(what)).map(|l| l.split(' ').next().unwrap().parse().unwrap()).collect()
}

/// Running and not a zombie (a killed child stays one until tokio reaps it).
fn alive(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .is_ok_and(|s| s.rsplit(')').next().is_some_and(|rest| !rest.trim_start().starts_with('Z')))
}

async fn until(what: &str, f: impl Fn() -> bool) {
    let t0 = Instant::now();
    while !f() {
        assert!(t0.elapsed() < Duration::from_secs(20), "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[test]
fn wsl_keepalive_follows_the_wanted_host() {
    let fake = tempfile::tempdir().unwrap();
    let exe = fake.path().join("wsl.exe");
    std::fs::write(&exe, FAKE_WSL).unwrap();
    std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!("{}:{}", fake.path().display(), std::env::var("PATH").unwrap_or_default());
    // SAFETY: the only test in this binary, and no runtime or other thread of ours exists yet.
    unsafe { std::env::set_var("PATH", path) };
    let dir = fake.path();
    tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap().block_on(async {
        let data = tempfile::tempdir().unwrap();
        let cfg = EngineConfig {
            data_dir: data.path().to_path_buf(),
            platform_name: "windows".into(),
            client_app: "teleflock-test".into(),
            version: "0.0.0".into(),
            hostd_bins_override: None,
        };
        let (engine, _rx) = Engine::start(cfg, Arc::new(NullPlatform)).await;
        let call = |method: &'static str, params: serde_json::Value| {
            let engine = engine.clone();
            async move { engine.call(None, method, params).await.unwrap() }
        };
        let save = |id: &'static str| {
            call("hosts.save", json!({ "id": id, "name": id, "kind": "wsl", "distro": "Ubuntu", "herdrSession": "default", "autoConnect": false }))
        };

        // Two failed attempts and the backoff between them: one keepalive throughout.
        save("w1").await;
        call("hosts.connect", json!({ "hostId": "w1" })).await;
        until("a second attempt", || calls(dir, "--exec true").len() >= 2).await;
        let k = calls(dir, "--exec sleep 2147483647");
        assert_eq!(k.len(), 1, "one keepalive per wanted host");
        assert!(alive(k[0]));

        call("hosts.disconnect", json!({ "hostId": "w1" })).await;
        until("the keepalive killed on disconnect", || !alive(k[0])).await;

        call("hosts.connect", json!({ "hostId": "w1" })).await;
        until("a keepalive for the reconnect", || calls(dir, "--exec sleep").len() == 2).await;
        let k = calls(dir, "--exec sleep")[1];
        assert!(alive(k));
        call("hosts.remove", json!({ "hostId": "w1" })).await;
        until("the keepalive killed on removal", || !alive(k)).await;

        save("w2").await;
        call("hosts.connect", json!({ "hostId": "w2" })).await;
        until("a keepalive for the second host", || calls(dir, "--exec sleep").len() == 3).await;
        let k = calls(dir, "--exec sleep")[2];
        assert!(alive(k));
        engine.shutdown().await;
        until("the keepalive killed at shutdown", || !alive(k)).await;
    });
}
