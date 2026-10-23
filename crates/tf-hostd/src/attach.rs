//! `tf-hostd attach` (stdio ⇄ client socket, starting the daemon if needed) and
//! `tf-hostd stop` (architecture §3.2).
//!
//! stdout carries protocol lines only; human diagnostics go to stderr prefixed `tf-hostd:`.

use std::cmp::Ordering;
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
/// `force` stops it even when it refuses an older build (see [`crate::daemon::stop_policy`]).
pub fn stop(paths: Paths, force: bool) -> anyhow::Result<i32> {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    rt.block_on(async move {
        if !InstanceLock::is_held(&paths) {
            eprintln!("tf-hostd: not running");
            return Ok(0);
        }
        match control(&paths, "stop", force).await {
            Some(reply) if reply["refused"].is_string() => {
                eprintln!(
                    "tf-hostd: the daemon refused to stop: {}; `tf-hostd stop --force` stops it anyway",
                    reply["refused"].as_str().unwrap_or_default()
                );
                return Ok(1);
            }
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

/// Sends one control line (`info` / `stop`) and returns the JSON reply. Every line carries
/// this build's version line: the daemon judges `stop` requests by it.
pub async fn control(paths: &Paths, op: &str, force: bool) -> Option<serde_json::Value> {
    let (read, mut write) = ipc::connect(paths).await.ok()?;
    let line = serde_json::json!({ "ctl": op, "version": crate::version_line(), "force": force });
    write.write_all(format!("{line}\n").as_bytes()).await.ok()?;
    write.flush().await.ok()?;
    let mut reader = BufReader::new(read);
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line)).await.ok()?.ok()?;
    serde_json::from_str(&line).ok()
}

/// `--replace` (the app just installed this build): stop a running daemon that runs another
/// binary, unless [`replace_policy`] keeps it. A kept or refusing daemon is attached to as is.
async fn replace_if_stale(paths: &Paths) {
    if !InstanceLock::is_held(paths) {
        return;
    }
    let ours = exe_identity();
    let Some(info) = control(paths, "info", false).await else { return };
    if info["exe"].as_str() == Some(ours.as_str()) {
        return;
    }
    let running = info["version"].as_str().unwrap_or("?");
    if let Err(why) = replace_policy(running, &crate::version_line(), info["clients"].as_u64()) {
        eprintln!("tf-hostd: keeping daemon pid {} ({running}): {why}", info["pid"]);
        return;
    }
    eprintln!("tf-hostd: replacing daemon pid {} ({running})", info["pid"]);
    if let Some(reply) = control(paths, "stop", false).await
        && let Some(why) = reply["refused"].as_str()
    {
        eprintln!("tf-hostd: daemon pid {} refused to stop: {why}", info["pid"]);
        return;
    }
    if !wait_released(paths, START_WAIT).await {
        eprintln!("tf-hostd: old daemon did not stop within 10 s");
    }
}

/// Whether `attach --replace` stops the running daemon (version line `running`) for this build
/// (`ours`). Every device of the user shares the daemon, so the host only moves forward:
/// - older (or unreadable): replace. Its clients reconnect to this build.
/// - newer: keep. A newer app on another device installed it; downgrading it would drop that
///   device, which would reinstall its build and drop this one in turn.
/// - the same version (another build, or the same one uploaded again): replace only when no
///   client is attached. `clients` is `None` for older daemons, which don't report it.
pub fn replace_policy(running: &str, ours: &str, clients: Option<u64>) -> Result<(), String> {
    match tf_proto::version::cmp_lines(running, ours) {
        Some(Ordering::Greater) => Err(format!("it is newer than this build ({ours})")),
        Some(Ordering::Equal) => match clients {
            Some(n) if n > 0 => Err(format!("same version, {n} client(s) connected")),
            _ => Ok(()),
        },
        Some(Ordering::Less) | None => Ok(()),
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
    let mut scope = tf_herdr::durable::Scope::plan("teleflock-hostd");
    let mut child = spawn_daemon(paths, relay_port, scope.as_ref()).map_err(|e| format!("cannot start daemon: {e}"))?;
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
                    match scope.take() {
                        // systemd-run exits with 1 without exec'ing when it cannot create the
                        // scope (no bus, no permission). A daemon that failed on its own fails
                        // the direct retry the same way.
                        Some(s) => {
                            eprintln!("tf-hostd: systemd-run could not start the daemon in {} (status {code}); starting it directly", s.unit);
                            child = spawn_daemon(paths, relay_port, None).map_err(|e| format!("cannot start daemon: {e}"))?;
                            continue;
                        }
                        None => return Err(format!("daemon exited with status {code}")),
                    }
                }
                exited = Some(code);
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err("daemon not ready after 10 s".into())
}

/// Starts `tf-hostd daemon` detached, inside `scope` when given (Linux with systemd: outside the
/// login session that runs this attach, so tearing that session down spares the daemon).
fn spawn_daemon(paths: &Paths, relay_port: u16, scope: Option<&tf_herdr::durable::Scope>) -> std::io::Result<std::process::Child> {
    let exe = std::env::current_exe()?;
    let mut cmd = match scope {
        Some(s) => s.command(&exe, "TeleFlock host daemon (tf-hostd)"),
        None => std::process::Command::new(&exe),
    };
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
        // SAFETY: setsid is async-signal-safe; called between fork and exec. systemd-run execs
        // the daemon in place, so the new session carries over.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        match cmd.spawn() {
            Err(e) if scope.is_some() => {
                eprintln!("tf-hostd: cannot run systemd-run ({e}); starting the daemon directly");
                spawn_daemon(paths, relay_port, None)
            }
            r => r,
        }
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

#[cfg(test)]
mod tests {
    use super::replace_policy;

    const OURS: &str = "tf-hostd 0.3.0 proto 1";

    #[test]
    fn the_host_only_moves_forward() {
        // Upgrade: replaced even with clients attached (they reconnect to the new daemon).
        assert!(replace_policy("tf-hostd 0.2.0 proto 1", OURS, Some(2)).is_ok());
        assert!(replace_policy("tf-hostd 0.2.0 proto 1", OURS, None).is_ok());
        // A newer daemon is never downgraded, attached clients or not.
        assert!(replace_policy("tf-hostd 0.4.0 proto 1", OURS, Some(0)).is_err());
        assert!(replace_policy("tf-hostd 0.3.0 proto 2", OURS, Some(0)).is_err());
        // Another build of the same version only replaces an idle daemon.
        assert!(replace_policy(OURS, OURS, Some(1)).is_err());
        assert!(replace_policy(OURS, OURS, Some(0)).is_ok());
        assert!(replace_policy(OURS, OURS, None).is_ok());
        // A daemon whose version can't be read is replaced.
        assert!(replace_policy("?", OURS, Some(3)).is_ok());
    }
}
