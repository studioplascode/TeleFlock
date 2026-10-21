//! `tf-hostd attach` (stdio ⇄ client socket, starting the daemon if needed) and
//! `tf-hostd stop` (architecture §3.2).
//!
//! stdout carries protocol lines only; human diagnostics go to stderr prefixed `tf-hostd:`.

use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use crate::daemon::{exe_identity, InstanceLock};
use crate::ipc;
use crate::paths::Paths;

const START_WAIT: Duration = Duration::from_secs(10);

/// `tf-hostd attach`. `session` is informational: the client's `hello` selects the
/// herdr session, so one daemon serves every session.
pub fn run(paths: Paths, session: &str, replace: bool, relay_port: u16) -> anyhow::Result<i32> {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    rt.block_on(async move {
        paths.ensure_dirs()?;
        if replace {
            replace_if_stale(&paths).await;
        }
        let (read, write) = match ipc::connect(&paths).await {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                eprintln!("tf-hostd: {} is not owned by this user: {e}", paths.endpoint());
                return Ok(1);
            }
            Err(_) => {
                eprintln!("tf-hostd: starting daemon (herdr session {session})");
                match start_and_connect(&paths, relay_port).await {
                    Ok(c) => c,
                    Err(msg) => {
                        eprintln!("tf-hostd: {msg}; see {}", paths.log.display());
                        return Ok(1);
                    }
                }
            }
        };
        pump(read, write).await;
        Ok(0)
    })
}

/// `tf-hostd stop`: asks the daemon to shut down and waits for the lock to be released.
pub fn stop(paths: Paths) -> anyhow::Result<i32> {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    rt.block_on(async move {
        if !InstanceLock::is_held(&paths) {
            eprintln!("tf-hostd: not running");
            return Ok(0);
        }
        match control(&paths, "stop").await {
            Some(reply) => eprintln!("tf-hostd: stopping (pid {})", reply["pid"]),
            None => {
                eprintln!("tf-hostd: daemon holds the lock but does not answer on {}", paths.endpoint());
                return Ok(1);
            }
        }
        if wait_released(&paths, START_WAIT).await {
            eprintln!("tf-hostd: stopped");
            Ok(0)
        } else {
            eprintln!("tf-hostd: daemon did not stop within 10 s");
            Ok(1)
        }
    })
}

/// Sends one control line (`info` / `stop`) and returns the JSON reply.
pub async fn control(paths: &Paths, op: &str) -> Option<serde_json::Value> {
    let (read, mut write) = ipc::connect(paths).await.ok()?;
    write.write_all(format!("{{\"ctl\":\"{op}\"}}\n").as_bytes()).await.ok()?;
    write.flush().await.ok()?;
    let mut reader = BufReader::new(read);
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line)).await.ok()?.ok()?;
    serde_json::from_str(&line).ok()
}

/// `--replace`: stop a running daemon that runs a different binary than this one.
async fn replace_if_stale(paths: &Paths) {
    if !InstanceLock::is_held(paths) {
        return;
    }
    let ours = exe_identity();
    let Some(info) = control(paths, "info").await else { return };
    if info["exe"].as_str() == Some(ours.as_str()) {
        return;
    }
    eprintln!("tf-hostd: replacing daemon pid {} ({})", info["pid"], info["version"].as_str().unwrap_or("?"));
    let _ = control(paths, "stop").await;
    if !wait_released(paths, START_WAIT).await {
        eprintln!("tf-hostd: old daemon did not stop within 10 s");
    }
}

async fn wait_released(paths: &Paths, max: Duration) -> bool {
    let deadline = Instant::now() + max;
    while Instant::now() < deadline {
        if !InstanceLock::is_held(paths) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

async fn start_and_connect(paths: &Paths, relay_port: u16) -> Result<(ipc::BoxRead, ipc::BoxWrite), String> {
    let mut child = spawn_daemon(paths, relay_port).map_err(|e| format!("cannot start daemon: {e}"))?;
    let deadline = Instant::now() + START_WAIT;
    let mut exited: Option<i32> = None;
    while Instant::now() < deadline {
        match ipc::connect(paths).await {
            Ok(c) => return Ok(c),
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                return Err(format!("{} is not owned by this user: {e}", paths.endpoint()));
            }
            Err(_) => {}
        }
        if exited.is_none() {
            if let Ok(Some(status)) = child.try_wait() {
                // Code 3: another daemon won the race; keep waiting for its socket.
                let code = status.code().unwrap_or(-1);
                if code != 3 {
                    return Err(format!("daemon exited with status {code}"));
                }
                exited = Some(code);
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err("daemon not ready after 10 s".into())
}

fn spawn_daemon(paths: &Paths, relay_port: u16) -> std::io::Result<std::process::Child> {
    let exe = std::env::current_exe()?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("daemon")
        .arg("--relay-port")
        .arg(relay_port.to_string())
        .env("TF_HOSTD_HOME", &paths.home)
        .current_dir(crate::paths::home_dir())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // The daemon outlives this attach; it must not inherit a pane's herdr targeting.
    for var in ["HERDR_SOCKET_PATH", "HERDR_SESSION", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_ENV"] {
        cmd.env_remove(var);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid is async-signal-safe; called between fork and exec.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        cmd.spawn()
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB);
        match cmd.spawn() {
            Ok(c) => Ok(c),
            Err(_) => {
                cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
                cmd.spawn()
            }
        }
    }
}

/// stdin → socket, socket → stdout, until the socket closes.
async fn pump(mut read: ipc::BoxRead, mut write: ipc::BoxWrite) {
    let up = tokio::spawn(async move {
        let mut stdin = tokio::io::stdin();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match stdin.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if write.write_all(&buf[..n]).await.is_err() || write.flush().await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = write.shutdown().await;
    });
    let mut stdout = tokio::io::stdout();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match read.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if stdout.write_all(&buf[..n]).await.is_err() || stdout.flush().await.is_err() {
                    break;
                }
            }
        }
    }
    let _ = stdout.flush().await;
    up.abort();
    // The blocking stdin reader thread cannot be cancelled; exit the process directly.
    std::process::exit(0);
}
