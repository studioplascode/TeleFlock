//! Local transport: direct process execution (no shell) and localhost forwarding.

mod support;

use std::time::{Duration, Instant};

use support::{Events, TempDir, echo_server};
use tf_transport::{Cmd, ConnectOptions, HostKind, HostProfile, Transport, TransportError, TransportEvent, connect};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const T: Duration = Duration::from_secs(10);

async fn local(ev: &Events) -> std::sync::Arc<dyn Transport> {
    let p = HostProfile {
        id: "local".into(),
        name: "local".into(),
        kind: HostKind::Local,
        address: None,
        user: None,
        port: None,
        distro: None,
        herdr_session: "default".into(),
        color: None,
        auto_connect: false,
        relay_port: None,
    };
    connect(&p, &ConnectOptions::new(std::env::temp_dir().join("tf-unused-known-hosts")), ev.tx.clone()).await.unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn exec_without_shell() {
    let ev = Events::new();
    let t = local(&ev).await;
    assert_eq!(t.kind(), HostKind::Local);

    // argv goes to the program verbatim: no shell expansion.
    let out = t.exec(&Cmd::new(["printf", "[%s]", "$HOME", "a b", "*"])).await.unwrap();
    assert_eq!(out.stdout_str(), "[$HOME][a b][*]");

    let dir = TempDir::new("cwd");
    let out = t.exec(&Cmd::new(["sh", "-c", "echo \"$TF_X\"; pwd; echo e >&2; exit 4"]).env("TF_X", "y z").cwd(dir.0.to_str().unwrap())).await.unwrap();
    assert_eq!(out.status.code, Some(4));
    assert_eq!(out.stdout_str(), format!("y z\n{}\n", dir.0.canonicalize().unwrap().display()));
    assert_eq!(out.stderr_str(), "e\n");

    let blob = vec![7u8; 1 << 20];
    let out = t.exec(&Cmd::new(["wc", "-c"]).stdin(blob)).await.unwrap();
    assert_eq!(out.stdout_str().trim(), "1048576");

    let t0 = Instant::now();
    let err = t.exec(&Cmd::new(["sleep", "20"]).timeout(Duration::from_millis(200))).await.unwrap_err();
    assert!(matches!(err, TransportError::Timeout { .. }), "{err:?}");
    assert!(t0.elapsed() < Duration::from_secs(3));

    let err = t.exec(&Cmd::new(["tf-definitely-not-a-program"])).await.unwrap_err();
    assert!(matches!(err, TransportError::Spawn { .. }), "{err:?}");
    assert!(matches!(t.exec(&Cmd::new(Vec::<String>::new())).await.unwrap_err(), TransportError::Config(_)));
}

#[tokio::test(flavor = "multi_thread")]
async fn spawn_stream_kill_and_close() {
    let ev = Events::new();
    let t = local(&ev).await;

    let mut c = t.spawn(&Cmd::new(["cat"])).await.unwrap();
    let mut w = c.stdin.take().unwrap();
    let mut r = c.stdout.take().unwrap();
    for i in 0..3 {
        let line = format!("echo {i}\n");
        w.write_all(line.as_bytes()).await.unwrap();
        let mut buf = vec![0; line.len()];
        tokio::time::timeout(T, r.read_exact(&mut buf)).await.unwrap().unwrap();
        assert_eq!(buf, line.as_bytes());
    }
    drop(w);
    assert!(tokio::time::timeout(T, c.wait()).await.unwrap().unwrap().success());

    let mut c = t.spawn(&Cmd::new(["sh", "-c", "echo out; echo err >&2; exit 5"])).await.unwrap();
    let mut err = String::new();
    c.stderr.take().unwrap().read_to_string(&mut err).await.unwrap();
    assert_eq!(err, "err\n");
    assert_eq!(c.wait().await.unwrap().code, Some(5));

    let mut c = t.spawn(&Cmd::new(["sleep", "30"])).await.unwrap();
    tokio::time::timeout(T, c.kill()).await.unwrap();
    assert_eq!(c.wait().await.unwrap().signal.as_deref(), Some("KILL"));

    // close() kills running children and emits Closed(None) once.
    let mut c = t.spawn(&Cmd::new(["sleep", "30"])).await.unwrap();
    t.close().await;
    let res = tokio::time::timeout(T, c.wait()).await.unwrap();
    assert!(matches!(res, Err(TransportError::Closed(None))), "{res:?}");
    ev.wait_for(T, |e| *e == TransportEvent::Closed(None)).await;
    t.close().await;
    assert_eq!(ev.all().iter().filter(|e| matches!(e, TransportEvent::Closed(_))).count(), 1);
    assert!(matches!(t.exec(&Cmd::new(["true"])).await.unwrap_err(), TransportError::Closed(None)));
}

#[tokio::test(flavor = "multi_thread")]
async fn forward_tcp_localhost() {
    let ev = Events::new();
    let t = local(&ev).await;
    let echo = echo_server().await;
    let mut s = t.forward_tcp("127.0.0.1", echo.port()).await.unwrap();
    s.write_all(b"local").await.unwrap();
    let mut buf = [0u8; 5];
    tokio::time::timeout(T, s.read_exact(&mut buf)).await.unwrap().unwrap();
    assert_eq!(&buf, b"local");
    let err = t.forward_tcp("127.0.0.1", support::dead_port().await).await.err().unwrap();
    assert!(matches!(err, TransportError::Connect { .. }), "{err:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn wsl_without_wsl_exe_is_a_clear_error() {
    // This box has no wsl.exe: both entry points must fail with a WSL-specific message.
    if std::process::Command::new("wsl.exe").arg("--version").output().is_ok() {
        return;
    }
    let err = tf_transport::list_distros().await.unwrap_err();
    assert!(matches!(&err, TransportError::Wsl(m) if m.contains("wsl.exe")), "{err:?}");
    let err = tf_transport::WslTransport::connect(Some("Ubuntu".into()), &ConnectOptions::new("/tmp/x"), Events::new().tx).await.err().unwrap();
    assert!(matches!(err, TransportError::Wsl(_)), "{err:?}");
}
