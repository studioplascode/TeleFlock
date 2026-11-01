//! Host-to-host forwarding end to end: an app core relaying between two real tf-hostd daemons,
//! each on its own "remote" host (tf-transport's in-process SSH server with a home of its own),
//! driven from the from-host the way its processes use it: `tf-forward` (commands with their
//! output and exit status, a multi-MB binary stdin, an interactive shell on a terminal), a tool
//! shim, a forwarded port, and a link that drops mid-stream.
//!
//! The daemons are the tf-hostd binary of this workspace (`cargo build -p tf-hostd`, or
//! `TF_TEST_HOSTD=<path>`), preinstalled in each host's home so the deploy finds it current. Each
//! host's `~/.profile` points `TF_HOSTD_HOME` into its home, so nothing touches `~/.teleflock`;
//! the daemons are stopped at the end. Unix only (the SSH fixture runs `sh`).
#![cfg(unix)]

#[path = "../../tf-transport/tests/support/mod.rs"]
mod support;

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use support::{AuthMode, KEY_A, TempDir, TestServer};
use tf_client::tf_proto::{ApiError, ConnPhase, ForwardList, ForwardState, HostProfile, HostsListResult, Notification};
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

/// This workspace's tf-hostd binary, built for the profile these tests run in.
fn hostd_bin() -> PathBuf {
    if let Some(p) = std::env::var_os("TF_TEST_HOSTD") {
        return p.into();
    }
    // <target>/<profile>/deps/forward-<hash>
    let exe = std::env::current_exe().unwrap();
    let profile_dir = exe.parent().and_then(Path::parent).unwrap().to_path_buf();
    let target = profile_dir.parent().unwrap();
    let mut build = Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()));
    build.args(["build", "-q", "-p", "tf-hostd", "--bin", "tf-hostd"]).env("CARGO_TARGET_DIR", target).current_dir(env!("CARGO_MANIFEST_DIR"));
    if profile_dir.file_name().is_some_and(|n| n == "release") {
        build.arg("--release");
    }
    assert!(build.status().unwrap().success(), "building tf-hostd failed");
    profile_dir.join("tf-hostd")
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

/// One "remote" host: an SSH server whose commands run in `home` with a clean environment.
struct Host {
    home: TempDir,
    srv: TestServer,
    /// `TF_HOSTD_HOME` there.
    tf: PathBuf,
    bin: PathBuf,
}

impl Host {
    async fn start(tag: &str, bin: &Path, sha: &str) -> Host {
        let home = TempDir::new(tag);
        let tf = home.0.join("tf");
        std::fs::create_dir_all(tf.join("bin")).unwrap();
        std::fs::write(home.0.join(".profile"), "export TF_HOSTD_HOME=\"$HOME/tf\"\n").unwrap();
        // The deploy finds this build installed and current: no upload of a debug binary.
        let installed = tf.join("bin/tf-hostd");
        if std::fs::hard_link(bin, &installed).is_err() {
            std::fs::copy(bin, &installed).unwrap();
        }
        std::fs::write(tf.join("bin/tf-hostd.sha256"), sha).unwrap();
        let srv = TestServer::start(KEY_A, AuthMode::Accept, home.0.clone()).await;
        Host { home, srv, tf, bin: installed }
    }

    fn log(&self) -> String {
        std::fs::read_to_string(self.tf.join("hostd.log")).unwrap_or_default()
    }

    /// Runs `program args` on this host as one of its processes (its HOME, a plain PATH).
    fn command(&self, program: &Path) -> Command {
        let mut c = Command::new(program);
        c.env_clear().env("HOME", &self.home.0).env("PATH", "/usr/local/bin:/usr/bin:/bin").env("LANG", "C.UTF-8");
        c
    }

    fn tf_forward(&self) -> PathBuf {
        self.tf.join("bin/tf-forward")
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = Command::new(&self.bin).args(["stop", "--force"]).env("TF_HOSTD_HOME", &self.tf).stderr(Stdio::null()).status();
    }
}

async fn wait<T>(what: &str, secs: u64, mut f: impl AsyncFnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        if let Some(v) = f().await {
            return v;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn host_phase(engine: &Engine, id: &str) -> (ConnPhase, Value) {
    let list: HostsListResult = serde_json::from_value(engine.call(None, "hosts.list", json!({})).await.unwrap()).unwrap();
    let s = list.statuses.into_iter().find(|s| s.host_id == id).unwrap().status;
    (s.phase, serde_json::to_value(&s).unwrap())
}

/// Saves and connects an SSH host, confirming its (loopback, so not tailnet) host key.
async fn connect(engine: &Engine, host: &Host, id: &str, name: &str) {
    let profile = json!({"id": id, "name": name, "kind": "tailscaleSsh", "address": "127.0.0.1", "user": "tester",
        "port": host.srv.addr.port(), "herdrSession": "default", "autoConnect": false, "relayPort": free_port()});
    engine.call(None, "hosts.save", profile).await.unwrap();
    engine.call(None, "hosts.connect", json!({"hostId": id})).await.unwrap();
    let fingerprint = wait("the host key", 30, async || {
        let (phase, s) = host_phase(engine, id).await;
        (phase == ConnPhase::HostKey).then(|| s["hostKey"]["fingerprint"].as_str().unwrap().to_string())
    })
    .await;
    engine.call(None, "hosts.trustKey", json!({"hostId": id, "fingerprint": fingerprint})).await.unwrap();
    online(engine, host, id).await;
}

async fn online(engine: &Engine, host: &Host, id: &str) {
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let (phase, s) = host_phase(engine, id).await;
        if phase == ConnPhase::Online {
            return;
        }
        assert!(Instant::now() < deadline && phase != ConnPhase::Error, "host {id} did not come online: {s}\n{}", host.log());
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn forwards(engine: &Engine) -> ForwardList {
    serde_json::from_value(engine.call(None, "forward.list", json!({})).await.unwrap()).unwrap()
}

/// `tf-forward` run on the from-host to completion: (status, stdout, stderr).
async fn run(from: &Host, args: &[&str], stdin: &[u8]) -> (i32, Vec<u8>, String) {
    let mut cmd = from.command(&from.tf_forward());
    cmd.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let input = stdin.to_vec();
    tokio::task::spawn_blocking(move || {
        let mut child = cmd.spawn().unwrap();
        let mut sin = child.stdin.take().unwrap();
        let writer = std::thread::spawn(move || {
            use std::io::Write;
            let _ = sin.write_all(&input);
        });
        let out = child.wait_with_output().unwrap();
        writer.join().unwrap();
        (out.status.code().unwrap_or(-1), out.stdout, String::from_utf8_lossy(&out.stderr).into_owned())
    })
    .await
    .unwrap()
}

fn alive(pid: i32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists() && !std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|s| s.contains(") Z "))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn forwarding_between_two_real_daemons() {
    let bin = hostd_bin();
    let sha = format!("{:x}", Sha256::digest(std::fs::read(&bin).unwrap()));
    let dev = Host::start("fwd-dev", &bin, &sha).await;
    let mac = Host::start("fwd-mac", &bin, &sha).await;
    // A tool the to-host has on its PATH (`~/.local/bin` is always on tf-hostd's PATH).
    let tool = mac.home.0.join(".local/bin/fwdtool");
    std::fs::create_dir_all(tool.parent().unwrap()).unwrap();
    std::fs::write(&tool, "#!/bin/sh\necho \"fwdtool on $HOME:\"\nfor a in \"$@\"; do echo \"[$a]\"; done\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
    // A local HTTP server on the to-host for the port forward.
    let web = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let web_port = web.local_addr().unwrap().port();
    tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        while let Ok((mut s, _)) = web.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf).await;
                let _ = s.write_all(b"HTTP/1.0 200 OK\r\nContent-Length: 14\r\n\r\nhello from mac").await;
            });
        }
    });

    let data = tempfile::tempdir().unwrap();
    let cfg = EngineConfig {
        data_dir: data.path().to_path_buf(),
        platform_name: "linux".into(),
        client_app: "teleflock-test".into(),
        version: "0.0.0".into(),
        hostd_bins_override: Some(bin.clone()),
    };
    let (engine, _rx) = Engine::start(cfg, Arc::new(NullPlatform)).await;
    connect(&engine, &dev, "dev", "dev box").await;
    connect(&engine, &mac, "mac", "Studio Mac").await;

    let listen = free_port();
    let rule = json!({"id": "", "fromHost": "dev", "toHost": "mac", "name": "mac", "enabled": true, "shell": true,
        "tools": ["fwdtool"], "ports": [{"listen": listen, "target": web_port}]});
    let saved: ForwardList = serde_json::from_value(engine.call(None, "forward.save", json!({"rule": rule})).await.unwrap()).unwrap();
    let rule_id = saved.rules[0].id.clone();
    wait("the forward to be ready", 30, async || {
        let l = forwards(&engine).await;
        (l.status[0].state == ForwardState::Ready && l.status[0].port_errors.is_empty()).then_some(())
    })
    .await;
    let shim = dev.tf.join("forward/bin/fwdtool");
    wait("the tool shim", 10, async || shim.is_file().then_some(())).await;
    assert!(dev.tf.join("forward/bin/tf-forward").is_file(), "tf-forward next to the shims");

    // `--list` on the from-host.
    let (code, out, _) = run(&dev, &["--list"], b"").await;
    let listed = String::from_utf8_lossy(&out).into_owned();
    assert_eq!(code, 0);
    assert!(listed.contains("mac → Studio Mac, relayed by TeleFlock on test-device: ready"), "{listed}");

    // A command: stdout, stderr and the exit status come back; the words are joined for the
    // to-host's shell, which runs in its home.
    let (code, out, err) = run(&dev, &["mac", "echo", "out:$HOME;", "echo", "err", ">&2;", "exit", "7"], b"").await;
    assert_eq!((code, String::from_utf8_lossy(&out).into_owned(), err.as_str()), (7, format!("out:{}\n", mac.home.0.display()), "err\n"), "{}", dev.log());

    // A caller whose stdin stays open and silent (a terminal nobody types into) ends with the
    // remote command, as ssh does: nothing waits for one more read of stdin.
    let mut quiet = dev.command(&dev.tf_forward());
    quiet.args(["mac", "echo", "done"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = quiet.spawn().unwrap();
    let open_stdin = child.stdin.take();
    let ended = wait("tf-forward to end while its stdin is open", 15, async || child.try_wait().unwrap()).await;
    drop(open_stdin);
    let out = child.wait_with_output().unwrap();
    assert_eq!((ended.code(), String::from_utf8_lossy(&out.stdout).into_owned()), (Some(0), "done\n".to_string()));

    // stdin: a multi-MB binary payload through both links and back, intact.
    let payload: Vec<u8> = (0..6_000_000u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8).collect();
    let started = Instant::now();
    let (code, out, err) = run(&dev, &["-T", "mac", "cat"], &payload).await;
    assert_eq!((code, err.as_str()), (0, ""));
    assert!(out == payload, "6 MB round trip differs ({} bytes back)", out.len());
    eprintln!("6 MB stdin → cat → stdout in {:?}", started.elapsed());

    // An interactive shell on a terminal there (`-t`: this caller has no terminal of its own).
    // The terminal echoes the typed lines, so the checks look for what only the output has.
    let (code, out, _) = run(&dev, &["-t", "mac"], b"echo TTY=$(tty | cut -c1-8)\nstty size\necho $((6*7))\nexit 3\n").await;
    let text = String::from_utf8_lossy(&out).into_owned();
    assert!(text.contains("TTY=/dev/pts") && text.contains("24 80") && text.contains("42"), "{text}");
    assert_eq!(code, 3);

    // A tool shim: called by its plain name on the from-host, runs on the to-host with its
    // arguments exactly.
    let mut sh = dev.command(Path::new("/bin/sh"));
    sh.args(["-c", "PATH=\"$1:$PATH\" fwdtool 'a b' '$HOME' --flag", "sh"]).arg(dev.tf.join("forward/bin"));
    let out = tokio::task::spawn_blocking(move || sh.output().unwrap()).await.unwrap();
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        format!("fwdtool on {}:\n[a b]\n[$HOME]\n[--flag]\n", mac.home.0.display()),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );

    // A port: 127.0.0.1:<listen> on the from-host reaches the to-host's local web server.
    let body = tokio::task::spawn_blocking(move || {
        use std::io::{Read, Write};
        let mut c = std::net::TcpStream::connect(("127.0.0.1", listen)).unwrap();
        c.write_all(b"GET / HTTP/1.0\r\n\r\n").unwrap();
        let mut s = String::new();
        c.read_to_string(&mut s).unwrap();
        s
    })
    .await
    .unwrap();
    assert!(body.ends_with("hello from mac"), "{body}");

    // Both directions ended: the port stream is over everywhere.
    wait("the port stream to end", 10, async || forwards(&engine).await.streams.is_empty().then_some(())).await;

    // Active streams show while they run, with Stop.
    let mut long = dev.command(&dev.tf_forward());
    long.args(["-T", "mac", "echo started; sleep 300"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = long.spawn().unwrap();
    let stream = wait("the active stream", 20, async || forwards(&engine).await.streams.into_iter().next()).await;
    assert_eq!((stream.rule_id.as_str(), stream.label.as_str()), (rule_id.as_str(), "echo started; sleep 300"));
    engine.call(None, "forward.stop", json!({"streamId": stream.id})).await.unwrap();
    let out = tokio::task::spawn_blocking(move || child.wait_with_output().unwrap()).await.unwrap();
    assert_eq!(out.status.code(), Some(255));
    assert_eq!(String::from_utf8_lossy(&out.stderr), "tf-forward: stopped from TeleFlock on test-device\n");
    assert!(forwards(&engine).await.streams.is_empty());

    // The to-host's link drops mid-stream: the caller ends with 255 and the reason, and the
    // to-host kills what it ran.
    let mut long = dev.command(&dev.tf_forward());
    long.args(["-T", "mac", "echo $$; exec sleep 300"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = long.spawn().unwrap();
    let pid: i32 = {
        use std::io::BufRead;
        let mut line = String::new();
        std::io::BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        line.trim().parse().unwrap_or_else(|_| panic!("a pid, got {line:?}"))
    };
    assert!(alive(pid));
    engine.call(None, "hosts.disconnect", json!({"hostId": "mac"})).await.unwrap();
    let out = tokio::task::spawn_blocking(move || child.wait_with_output().unwrap()).await.unwrap();
    assert_eq!(out.status.code(), Some(255));
    assert_eq!(String::from_utf8_lossy(&out.stderr), "tf-forward: TeleFlock lost the connection to Studio Mac\n");
    wait("the remote process to be killed", 15, async || (!alive(pid)).then_some(())).await;
    let l = forwards(&engine).await;
    assert_eq!((l.status[0].state, l.status[0].message.as_deref()), (ForwardState::Waiting, Some("Studio Mac is not connected")));
    // The from-host learns it, and why, from the app's next offer.
    wait("the offer to say so", 10, async || {
        let (_, out, _) = run(&dev, &["--list"], b"").await;
        String::from_utf8_lossy(&out).contains("test-device: Studio Mac is not connected to TeleFlock on test-device").then_some(())
    })
    .await;
    let (code, _, err) = run(&dev, &["mac", "true"], b"").await;
    assert_eq!((code, err.as_str()), (255, "tf-forward: Studio Mac is not connected to TeleFlock on test-device\n"));

    // Back online: it works again.
    engine.call(None, "hosts.connect", json!({"hostId": "mac"})).await.unwrap();
    online(&engine, &mac, "mac").await;
    wait("ready again", 30, async || (forwards(&engine).await.status[0].state == ForwardState::Ready).then_some(())).await;
    wait("the from-host to know", 10, async || {
        let (_, out, _) = run(&dev, &["--list"], b"").await;
        String::from_utf8_lossy(&out).contains("test-device: ready").then_some(())
    })
    .await;
    let (code, out, _) = run(&dev, &["mac", "echo", "again"], b"").await;
    assert_eq!((code, out), (0, b"again\n".to_vec()));

    // The from-host's link drops mid-stream: its tf-hostd ends the caller, the app the stream.
    let mut long = dev.command(&dev.tf_forward());
    long.args(["-T", "mac", "echo $$; exec sleep 300"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = long.spawn().unwrap();
    let pid: i32 = {
        use std::io::BufRead;
        let mut line = String::new();
        std::io::BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        line.trim().parse().unwrap()
    };
    engine.call(None, "hosts.disconnect", json!({"hostId": "dev"})).await.unwrap();
    let out = tokio::task::spawn_blocking(move || child.wait_with_output().unwrap()).await.unwrap();
    assert_eq!(out.status.code(), Some(255));
    assert_eq!(String::from_utf8_lossy(&out.stderr), "tf-forward: the TeleFlock app relaying it disconnected (test-device)\n");
    wait("the remote process to be killed", 15, async || (!alive(pid)).then_some(())).await;
    // No app relays it any more: the shim is gone, the port closed.
    wait("the shim to go", 10, async || (!shim.exists()).then_some(())).await;
    assert!(std::net::TcpStream::connect(("127.0.0.1", listen)).is_err());
    let (code, _, err) = run(&dev, &["mac", "true"], b"").await;
    assert_eq!((code, err.as_str()), (255, "tf-forward: no TeleFlock app is connected to relay to \"mac\" (TeleFlock on test-device relayed it)\n"));

    engine.shutdown().await;
}
