//! Daemon lifecycle through the real binary, without herdr: `--version`, `attach`
//! auto-starting the daemon, the protocol version check, single instance, `stop`.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

const BIN: &str = env!("CARGO_BIN_EXE_tf-hostd");

fn home() -> tempfile::TempDir {
    tempfile::Builder::new().prefix("tf-hostd-it-").tempdir().unwrap()
}

/// A free loopback port for the relay.
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

#[test]
fn version_line() {
    let out = Command::new(BIN).arg("--version").output().unwrap();
    assert!(out.status.success());
    let s = String::from_utf8(out.stdout).unwrap();
    assert_eq!(s.trim(), format!("tf-hostd {} proto {}", env!("CARGO_PKG_VERSION"), tf_proto::PROTOCOL_VERSION));
}

#[test]
fn attach_starts_daemon_checks_protocol_and_stops() {
    let home = home();
    let port = free_port().to_string();
    let mut attach = Command::new(BIN)
        .args(["attach", "--session", "tf-hostd-it", "--relay-port", &port])
        .env("TF_HOSTD_HOME", home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = attach.stdin.take().unwrap();
    // Wrong protocol: the daemon answers with a fatal `version_mismatch` and closes.
    writeln!(
        stdin,
        r#"{{"t":"hello","protocol":999,"client":{{"app":"it","version":"0","platform":"linux","device":"ci"}},"herdrSession":"tf-hostd-it"}}"#
    )
    .unwrap();
    let mut line = String::new();
    BufReader::new(attach.stdout.take().unwrap()).read_line(&mut line).unwrap();
    let msg: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(msg["t"], "error", "{line}");
    assert_eq!(msg["error"]["code"], "version_mismatch");
    let status = attach.wait().unwrap();
    assert!(status.success(), "attach exits cleanly when the daemon closes");

    // The daemon keeps running: lock held, pid recorded, log written.
    let pid = std::fs::read_to_string(home.path().join("run/hostd.lock")).unwrap();
    assert!(pid.trim().parse::<u32>().is_ok(), "lock holds the pid: {pid:?}");
    assert!(home.path().join("run/hostd.sock").exists());

    // A second daemon refuses to start (exit code 3).
    let second = Command::new(BIN)
        .args(["daemon", "--relay-port", &port])
        .env("TF_HOSTD_HOME", home.path())
        .output()
        .unwrap();
    assert_eq!(second.status.code(), Some(3), "{}", String::from_utf8_lossy(&second.stderr));

    let stop = Command::new(BIN).arg("stop").env("TF_HOSTD_HOME", home.path()).output().unwrap();
    assert!(stop.status.success(), "{}", String::from_utf8_lossy(&stop.stderr));
    std::thread::sleep(Duration::from_millis(200));
    assert!(!home.path().join("run/hostd.sock").exists(), "socket removed on shutdown");
    let log = std::fs::read_to_string(home.path().join("hostd.log")).unwrap();
    assert!(log.contains("daemon starting") && log.contains("daemon stopped"), "{log}");

    let again = Command::new(BIN).arg("stop").env("TF_HOSTD_HOME", home.path()).output().unwrap();
    assert!(String::from_utf8_lossy(&again.stderr).contains("not running"));
}
