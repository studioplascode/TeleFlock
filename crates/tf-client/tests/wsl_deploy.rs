//! The WSL deploy end to end: engine + `WslTransport` against a fake `wsl.exe` on PATH that does
//! what WSL does on the Linux side (runs the words after `--exec`), with the user's login shell
//! from the test. Regression for a host whose deploy failed on every attempt with
//! `upload bin/tf-hostd failed (exit 2): sha256sum: 4: Syntax error: Unterminated quoted string`:
//! the login shell was nushell, which reads POSIX quoting (`'\''`) differently.
//!
//! - The fake refuses any argument a Windows command-line parser could split differently
//!   (quotes, backslashes, control characters, empty): the real wsl.exe gets them through one
//!   flattened command line (`tf_transport` simulates those parsers in its unit tests).
//! - The default login shell runs only TeleFlock's fixed login command, so the test proves the
//!   login shell never parses the command itself, whatever its syntax. Real shells can be added
//!   with `TF_TEST_LOGIN_SHELLS=/usr/bin/nu:/usr/bin/fish`.
//!
//! Unix only (the fakes are shell scripts); this file's only test, so changing PATH races no
//! other test.
#![cfg(target_os = "linux")]

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;
use tf_client::tf_proto::{ApiError, HostProfile, Notification, PROTOCOL_VERSION};
use tf_client::{BadgeState, Engine, EngineConfig, HOSTD_VERSION, NotifyStyle, Platform};

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

/// wsl.exe on the Linux side: the words after `--exec`, run in a clean environment with the
/// test's home and login shell (`fake.env`). Refuses arguments that are not plain.
const FAKE_WSL: &str = r#"#!/bin/sh
dir=$(dirname "$0")
. "$dir/fake.env"
for a in "$@"; do
  case $a in
    ''|*[\"\\\']*|*[[:cntrl:]]*) printf '%s\n' "$a" >> "$dir/unsafe.log"; echo "fake wsl.exe: an argument is not plain" >&2; exit 99 ;;
  esac
done
while [ $# -gt 0 ] && [ "$1" != --exec ]; do shift; done
shift
exec env -i HOME="$TF_FAKE_HOME" SHELL="$TF_FAKE_SHELL" PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 USER=tester "$@"
"#;

/// A login shell that runs nothing but TeleFlock's login command (after `~/.profile`), logging
/// each call to `calls` next to it. Placed as `…/nu`: a name TeleFlock runs as a login shell
/// (other names fall back to `sh -l`).
fn strict_login_shell() -> String {
    format!(
        "#!/bin/sh\necho \"$2\" >> \"$(dirname \"$0\")/calls\"\nif [ \"$1\" != -lc ] || [ \"$2\" != {} ]; then\n  echo \"strict login shell: refusing to parse a command other than TeleFlock's login command\" >&2\n  exit 2\nfi\n[ -r \"$HOME/.profile\" ] && . \"$HOME/.profile\"\nexec sh -c \"$2\"\n",
        tf_transport::quote::shell_quote(tf_transport::quote::LOGIN_COMMAND)
    )
}

fn write_exe(path: &Path, text: &str) {
    tf_hostd::test_exe::write_exe(path, text);
}

/// Connects a WSL host whose login shell is `shell` and waits until the deploy installed
/// tf-hostd, the bridge and the overlay (the fake tf-hostd then fails `attach`, which only retries).
async fn deploy_with(shell: &Path, fake: &Path) {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        fake.join("fake.env"),
        format!("TF_FAKE_HOME='{}'\nTF_FAKE_SHELL='{}'\n", home.path().display(), shell.display()),
    )
    .unwrap();
    let hostd = fake.join("tf-hostd");
    let version = format!("tf-hostd {HOSTD_VERSION} proto {PROTOCOL_VERSION}");
    write_exe(&hostd, &format!("#!/bin/sh\ncase \"$1\" in --version) echo '{version}' ;; *) echo 'fake tf-hostd' >&2; exit 1 ;; esac\n"));

    let data = tempfile::tempdir().unwrap();
    let cfg = EngineConfig {
        data_dir: data.path().to_path_buf(),
        platform_name: "windows".into(),
        client_app: "teleflock-test".into(),
        version: "0.0.0".into(),
        hostd_bins_override: Some(hostd.clone()),
    };
    let (engine, _rx) = Engine::start(cfg, Arc::new(NullPlatform)).await;
    let host = json!({ "id": "w", "name": "w", "kind": "wsl", "distro": "Ubuntu", "herdrSession": "default", "autoConnect": false });
    engine.call(None, "hosts.save", host).await.unwrap();
    engine.call(None, "hosts.connect", json!({ "hostId": "w" })).await.unwrap();

    let tf = home.path().join(".teleflock");
    let installed = || ["bin/tf-hostd", "bin/tf-hostd.sha256", "ext/teleflock-bridge.ts", "omp-overlay.yml"].iter().all(|f| tf.join(f).is_file());
    let t0 = Instant::now();
    while !installed() {
        if t0.elapsed() > Duration::from_secs(60) {
            let list = engine.call(None, "hosts.list", json!({})).await.unwrap();
            panic!("{}: not deployed after 60 s; host status: {}", shell.display(), list["statuses"][0]["status"]);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(std::fs::read(tf.join("bin/tf-hostd")).unwrap(), std::fs::read(&hostd).unwrap(), "{}", shell.display());
    engine.shutdown().await;
}

#[test]
fn wsl_deploy_runs_with_any_login_shell() {
    let fake = tempfile::tempdir().unwrap();
    write_exe(&fake.path().join("wsl.exe"), FAKE_WSL);
    std::fs::create_dir(fake.path().join("strict")).unwrap();
    let strict = fake.path().join("strict/nu");
    write_exe(&strict, &strict_login_shell());
    let path = format!("{}:{}", fake.path().display(), std::env::var("PATH").unwrap_or_default());
    // SAFETY: the only test in this binary, and no runtime or other thread of ours exists yet.
    unsafe { std::env::set_var("PATH", path) };
    let mut shells = vec![strict];
    shells.extend(std::env::var("TF_TEST_LOGIN_SHELLS").unwrap_or_default().split(':').filter(|s| !s.is_empty()).map(Into::into));
    tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap().block_on(async {
        for shell in &shells {
            deploy_with(shell, fake.path()).await;
        }
    });
    let calls = std::fs::read_to_string(fake.path().join("strict/calls")).unwrap_or_default();
    assert!(calls.lines().count() >= 3, "the strict login shell ran the probe and both uploads:\n{calls}");
    let unsafe_args = std::fs::read_to_string(fake.path().join("unsafe.log")).unwrap_or_default();
    assert!(unsafe_args.is_empty(), "wsl.exe got arguments a Windows command line can split differently:\n{unsafe_args}");
}
