//! The browser process's supervisor: one task owns the running browser. It starts it in the mode
//! asked for (relaunching it to switch), stops it, starts it again after a crash on the
//! [`Restarts`] schedule, and brings it back headless when the user closed its own window. It
//! holds the profile lock (`<data_dir>/browser/profile.lock`) from a start until the stop: one
//! app core per profile.

use std::fs::File;
use std::path::Path;
use std::sync::{Arc, Weak};
use std::time::Duration;

use tf_proto::BrowserEngine;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use super::launch::{self, Proc, Restarts};
use super::{Run, engine_to_run, running, set_run};
use crate::engine::Inner;

pub(super) enum Cmd {
    /// Start, or relaunch in the other mode; the reply says how it went.
    Start { headed: bool, reply: oneshot::Sender<Result<(), String>> },
    Stop { reply: oneshot::Sender<()> },
}

enum Ev {
    Cmd(Option<Cmd>),
    Exited(std::process::ExitStatus),
    Retry,
}

pub(super) async fn actor(inner: Weak<Inner>, mut rx: mpsc::UnboundedReceiver<Cmd>) {
    let mut proc: Option<Proc> = None;
    let mut lock: Option<File> = None;
    let mut restarts = Restarts::default();
    // A restart after a crash: when, and in which mode.
    let mut retry: Option<(Instant, bool)> = None;
    loop {
        let ev = tokio::select! {
            c = rx.recv() => Ev::Cmd(c),
            st = async { proc.as_mut().expect("guarded").wait().await }, if proc.is_some() => Ev::Exited(st),
            _ = tokio::time::sleep_until(retry.map_or_else(Instant::now, |r| r.0)), if retry.is_some() => Ev::Retry,
        };
        let Some(inner) = inner.upgrade() else {
            if let Some(p) = proc.take() {
                launch::stop(p).await;
            }
            return;
        };
        match ev {
            Ev::Cmd(None) => {
                if let Some(p) = proc.take() {
                    launch::stop(p).await;
                }
                return;
            }
            Ev::Cmd(Some(Cmd::Stop { reply })) => {
                retry = None;
                if let Some(p) = proc.take() {
                    log::info!("browser {}: stopping", p.pid);
                    launch::stop(p).await;
                }
                lock = None;
                set_run(&inner, Run::Off, None);
                let _ = reply.send(());
            }
            Ev::Cmd(Some(Cmd::Start { headed, reply })) => {
                retry = None;
                restarts.reset();
                if proc.as_ref().is_some_and(|p| p.headed == headed) {
                    let _ = reply.send(Ok(()));
                    continue;
                }
                if let Some(p) = proc.take() {
                    log::info!("browser {}: relaunching {}", p.pid, if headed { "in its own window" } else { "headless" });
                    launch::stop(p).await;
                }
                match start(&inner, headed, &mut lock).await {
                    Ok(p) => {
                        proc = Some(p);
                        let _ = reply.send(Ok(()));
                    }
                    Err(e) => {
                        lock = None;
                        set_run(&inner, Run::Error, Some(format!("The browser did not start: {e}")));
                        let _ = reply.send(Err(e));
                    }
                }
            }
            Ev::Exited(st) => {
                let p = proc.take().expect("it ran");
                if let Some(px) = super::proxy_of(&inner) {
                    px.close_all();
                }
                if p.headed && st.success() {
                    // The user closed its window (or quit it): it goes back into the panel.
                    log::info!("browser {}: its window was closed; running headless again", p.pid);
                    match start(&inner, false, &mut lock).await {
                        Ok(p) => proc = Some(p),
                        Err(e) => {
                            lock = None;
                            set_run(&inner, Run::Error, Some(format!("The browser did not start: {e}")));
                        }
                    }
                    continue;
                }
                let tail = p.tail();
                let why = format!("{}{}", launch::describe_exit(&st), if tail.is_empty() { String::new() } else { format!(": {tail}") });
                log::warn!("browser {}: ended after {:?} ({why})", p.pid, p.started.elapsed());
                retry = after_failure(&inner, &mut restarts, &mut lock, p.started.elapsed(), p.headed, &why);
            }
            Ev::Retry => {
                let (_, headed) = retry.take().expect("guarded");
                match start(&inner, headed, &mut lock).await {
                    Ok(p) => proc = Some(p),
                    Err(e) => retry = after_failure(&inner, &mut restarts, &mut lock, Duration::ZERO, headed, &e),
                }
            }
        }
    }
}

/// The browser ended by itself or failed to start again: schedule the next start, or give up.
fn after_failure(inner: &Inner, restarts: &mut Restarts, lock: &mut Option<File>, ran: Duration, headed: bool, why: &str) -> Option<(Instant, bool)> {
    match restarts.on_exit(ran) {
        Some(delay) => {
            set_run(inner, Run::Starting { headed }, Some(format!("The browser stopped ({why}). Starting it again in {} s…", delay.as_secs())));
            Some((Instant::now() + delay, headed))
        }
        None => {
            *lock = None;
            set_run(inner, Run::Error, Some(format!("The browser kept stopping ({why}). Start it to try again.")));
            None
        }
    }
}

/// Launches the browser: the profile lock, the engine, the profile freed from a browser an
/// earlier run left behind, then the process; `running` on success.
async fn start(inner: &Arc<Inner>, headed: bool, lock: &mut Option<File>) -> Result<Proc, String> {
    set_run(inner, Run::Starting { headed }, None);
    let b = &inner.browser;
    if lock.is_none() {
        *lock = Some(profile_lock(&b.dir)?);
    }
    let engine: BrowserEngine = engine_to_run(inner).await?;
    let staged = b.dir.join("staged");
    let _ = tokio::fs::remove_dir_all(&staged).await;
    // The UI points the browser's downloads here (`Browser.setDownloadBehavior`).
    let _ = tokio::fs::create_dir_all(super::files::download_dir(&b.dir)).await;
    let profile = b.profile();
    launch::free_profile(&profile).await;
    let origins = b.origins();
    let args = launch::args(&launch::Flags { profile: &profile, headed, origins: &origins, os: &b.os, root: launch::is_root() });
    log::info!("browser: starting {} {} ({})", engine.name, engine.version.as_deref().unwrap_or("?"), if headed { "own window" } else { "headless" });
    let p = launch::spawn(Path::new(&engine.path), &args, &profile, headed).await?;
    running(inner, &p, engine);
    Ok(p)
}

/// `<dir>/profile.lock`, locked: no other app core runs a browser on this profile meanwhile
/// (the desktop app and a devserver on the same data dir).
fn profile_lock(dir: &Path) -> Result<File, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("can't create {}: {e}", dir.display()))?;
    let path = dir.join("profile.lock");
    let f = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(&path).map_err(|e| format!("can't open {}: {e}", path.display()))?;
    match f.try_lock() {
        Ok(()) => Ok(f),
        Err(std::fs::TryLockError::WouldBlock) => Err("another TeleFlock on this device runs the browser with this profile".into()),
        Err(std::fs::TryLockError::Error(e)) => Err(format!("can't lock {}: {e}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_app_core_per_profile() {
        let td = tempfile::tempdir().unwrap();
        let held = profile_lock(td.path()).unwrap();
        assert!(profile_lock(td.path()).unwrap_err().contains("another TeleFlock"));
        drop(held);
        assert!(profile_lock(td.path()).is_ok(), "free again once released");
    }
}
