//! Running the browser: its command line ([`args`]), its DevTools port (`DevToolsActivePort`,
//! [`parse_active_port`]), its process ([`spawn`], [`stop`]), freeing the profile from a browser
//! an earlier app run left behind ([`free_profile`]), and the restart schedule after crashes
//! ([`Restarts`]).

use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, BufReader};

use super::cdp;

/// A browser that has not opened its DevTools port by then is given up.
const START_TIMEOUT: Duration = Duration::from_secs(30);
/// After `Browser.close`, then after SIGTERM: how long it may take to exit.
const CLOSE_GRACE: Duration = Duration::from_secs(5);
const TERM_GRACE: Duration = Duration::from_secs(3);
/// Lines of the browser's stderr kept for error messages.
const TAIL_LINES: usize = 30;

/// The browser's command line.
pub(super) struct Flags<'a> {
    pub profile: &'a Path,
    /// In its own window; else headless (the app's panel shows it).
    pub headed: bool,
    /// Web origins allowed on its DevTools WebSockets: the app's own.
    pub origins: &'a [String],
    /// `linux`, `macos`, `windows`.
    pub os: &'a str,
    /// The app runs as root (Linux): Chromium refuses to start its sandbox then.
    pub root: bool,
}

/// The arguments the browser runs with. The profile's secrets are kept the same way in both
/// modes, so cookies and logins stay readable when it switches between headless and its own
/// window: Linux headless mode defaults to the `basic` password store and macOS headless mode to
/// a mock keychain, so the windowed mode uses them too.
pub(super) fn args(f: &Flags) -> Vec<String> {
    let mut a = vec![
        format!("--user-data-dir={}", f.profile.display()),
        "--remote-debugging-port=0".into(),
        "--remote-debugging-address=127.0.0.1".into(),
        format!("--remote-allow-origins={}", f.origins.join(",")),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-search-engine-choice-screen".into(),
        "--hide-crash-restore-bubble".into(),
        // Agents' tabs run in windows nobody looks at (and headless, nobody looks at any).
        "--disable-background-timer-throttling".into(),
        "--disable-backgrounding-occluded-windows".into(),
        "--disable-renderer-backgrounding".into(),
    ];
    match f.os {
        "linux" => a.push("--password-store=basic".into()),
        "macos" => a.push("--use-mock-keychain".into()),
        _ => {}
    }
    if f.root {
        a.push("--no-sandbox".into());
    }
    if !f.headed {
        a.push("--headless=new".into());
        a.push("--window-size=1280,800".into());
    }
    a
}

/// `DevToolsActivePort` (written into the profile with `--remote-debugging-port=0`): the port on
/// its first line, the browser target's path (`/devtools/browser/<id>`) on the second.
pub(super) fn parse_active_port(text: &str) -> Option<(u16, String)> {
    let mut lines = text.lines();
    let port = lines.next()?.trim().parse::<u16>().ok().filter(|p| *p != 0)?;
    let path = lines.next()?.trim();
    (path.starts_with("/devtools/browser/") && path.len() > "/devtools/browser/".len()).then(|| (port, path.to_string()))
}

/// A running browser.
pub(super) struct Proc {
    child: tokio::process::Child,
    pub pid: u32,
    pub port: u16,
    /// The browser target's DevTools WebSocket.
    pub ws_url: String,
    pub headed: bool,
    pub started: Instant,
    tail: Arc<Mutex<VecDeque<String>>>,
}

impl Proc {
    /// Waits for the process to end.
    pub async fn wait(&mut self) -> std::process::ExitStatus {
        match self.child.wait().await {
            Ok(st) => st,
            Err(e) => {
                log::warn!("browser {}: waiting for it failed: {e}", self.pid);
                std::future::pending().await
            }
        }
    }

    /// The last lines it wrote to stderr.
    pub fn tail(&self) -> String {
        tail_text(&self.tail)
    }
}

fn tail_text(tail: &Mutex<VecDeque<String>>) -> String {
    let t = tail.lock().unwrap();
    // Chromium's own log lines (`[1234:5678:…:ERROR:…]`) say little to a user; keep the rest.
    let plain: Vec<&str> = t.iter().map(String::as_str).filter(|l| !l.starts_with('[')).collect();
    let lines = if plain.is_empty() { t.iter().map(String::as_str).collect() } else { plain };
    lines.iter().rev().take(3).rev().copied().collect::<Vec<_>>().join(" / ")
}

/// Why an exited browser ended, for messages: the exit code or signal.
pub(super) fn describe_exit(st: &std::process::ExitStatus) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = st.signal() {
            return format!("signal {sig}");
        }
    }
    match st.code() {
        Some(c) => format!("exit code {c}"),
        None => "an unknown status".into(),
    }
}

/// Starts the browser and waits until it opened its DevTools port.
pub(super) async fn spawn(exe: &Path, args: &[String], profile: &Path, headed: bool) -> Result<Proc, String> {
    let port_file = profile.join("DevToolsActivePort");
    let _ = std::fs::remove_file(&port_file);
    std::fs::create_dir_all(profile).map_err(|e| format!("can't create the profile {}: {e}", profile.display()))?;
    let mut cmd = tokio::process::Command::new(exe);
    cmd.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped());
    // Its own process group: stopping it reaches every process it started, and a terminal's
    // Ctrl+C meant for the app does not hit it.
    #[cfg(unix)]
    cmd.process_group(0);
    // Linux: it gets SIGTERM if the app core dies without stopping it (the runtime's worker
    // thread that started it lives as long as the app).
    #[cfg(target_os = "linux")]
    // SAFETY: prctl is async-signal-safe; nothing else runs between fork and exec.
    unsafe {
        cmd.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
            Ok(())
        });
    }
    let mut child = cmd.spawn().map_err(|e| format!("can't run {}: {e}", exe.display()))?;
    let pid = child.id().unwrap_or_default();
    let tail = Arc::new(Mutex::new(VecDeque::with_capacity(TAIL_LINES)));
    if let Some(err) = child.stderr.take() {
        let tail = tail.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::debug!("browser {pid}: {line}");
                let mut t = tail.lock().unwrap();
                if t.len() == TAIL_LINES {
                    t.pop_front();
                }
                t.push_back(line);
            }
        });
    }
    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        if let Ok(Some(st)) = child.try_wait() {
            // Give the stderr reader a moment to take the last lines.
            tokio::time::sleep(Duration::from_millis(100)).await;
            let said = tail_text(&tail);
            if said.contains("Opening in existing browser session") {
                return Err("another browser process uses the TeleFlock profile".into());
            }
            return Err(format!("it ended at once ({}){}", describe_exit(&st), if said.is_empty() { String::new() } else { format!(": {said}") }));
        }
        if let Some((port, path)) = std::fs::read_to_string(&port_file).ok().as_deref().and_then(parse_active_port) {
            log::info!("browser {pid}: DevTools on 127.0.0.1:{port} ({})", if headed { "own window" } else { "headless" });
            return Ok(Proc { child, pid, port, ws_url: format!("ws://127.0.0.1:{port}{path}"), headed, started: Instant::now(), tail });
        }
        if Instant::now() >= deadline {
            let mut p = Proc { child, pid, port: 0, ws_url: String::new(), headed, started: Instant::now(), tail };
            let said = p.tail();
            kill(&mut p).await;
            return Err(format!("it did not open its DevTools port within {} s{}", START_TIMEOUT.as_secs(), if said.is_empty() { String::new() } else { format!(": {said}") }));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Stops the browser: `Browser.close` (a clean exit: no "restore pages?" next time), then
/// SIGTERM, then a kill; then whatever is left of its process group.
pub(super) async fn stop(mut p: Proc) {
    if cdp::close_browser(&p.ws_url).await.is_ok() && tokio::time::timeout(CLOSE_GRACE, p.child.wait()).await.is_ok() {
        reap_group(p.pid);
        return;
    }
    kill(&mut p).await;
}

async fn kill(p: &mut Proc) {
    #[cfg(unix)]
    if let Ok(pid) = i32::try_from(p.pid)
        && pid > 0
    {
        // SAFETY: plain syscall on our own child.
        unsafe { libc::kill(pid, libc::SIGTERM) };
        if tokio::time::timeout(TERM_GRACE, p.child.wait()).await.is_ok() {
            reap_group(p.pid);
            return;
        }
    }
    let _ = p.child.start_kill();
    let _ = tokio::time::timeout(CLOSE_GRACE, p.child.wait()).await;
    reap_group(p.pid);
}

/// Kills what is left of the browser's process group (its helpers end with it, normally).
fn reap_group(pid: u32) {
    #[cfg(unix)]
    if let Ok(pid) = i32::try_from(pid)
        && pid > 0
    {
        // SAFETY: plain syscall; the group is the one the browser led.
        unsafe { libc::killpg(pid, libc::SIGKILL) };
    }
    #[cfg(not(unix))]
    let _ = pid;
}

/// A browser of an earlier app run still has the profile (the app ended without stopping it):
/// it is asked to quit over its DevTools port, else (Unix) ended by signal when its command line
/// names this profile. Chromium would hand a new launch over to it and exit otherwise.
pub(super) async fn free_profile(profile: &Path) {
    if let Some((port, path)) = std::fs::read_to_string(profile.join("DevToolsActivePort")).ok().as_deref().and_then(parse_active_port)
        && cdp::close_browser(&format!("ws://127.0.0.1:{port}{path}")).await.is_ok()
    {
        log::info!("browser: an earlier run's browser on port {port} was asked to quit");
        let deadline = Instant::now() + Duration::from_secs(10);
        while profile_in_use(profile) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    #[cfg(unix)]
    if let Some(pid) = singleton_pid(profile)
        && alive(pid)
        && runs_profile(pid, profile)
    {
        log::info!("browser: ending process {pid} of an earlier run, which still has the profile");
        // SAFETY: plain syscalls on a process whose command line names our profile.
        unsafe { libc::kill(pid, libc::SIGTERM) };
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive(pid) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if alive(pid) {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    }
}

/// Unix: a live process holds the profile's `SingletonLock` (`<host>-<pid>`).
fn profile_in_use(profile: &Path) -> bool {
    #[cfg(unix)]
    {
        singleton_pid(profile).is_some_and(alive)
    }
    #[cfg(not(unix))]
    {
        // Windows: the profile's `lockfile` cannot be removed while a browser has it open.
        let lock = profile.join("lockfile");
        lock.exists() && std::fs::remove_file(&lock).is_err()
    }
}

#[cfg(unix)]
fn singleton_pid(profile: &Path) -> Option<i32> {
    let target = std::fs::read_link(profile.join("SingletonLock")).ok()?;
    target.to_str()?.rsplit_once('-')?.1.parse().ok().filter(|p| *p > 0)
}

#[cfg(unix)]
fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

/// The process's command line names `profile` as its user data dir.
#[cfg(unix)]
fn runs_profile(pid: i32, profile: &Path) -> bool {
    let want = format!("--user-data-dir={}", profile.display());
    #[cfg(target_os = "linux")]
    let cmdline = std::fs::read(format!("/proc/{pid}/cmdline")).map(|b| String::from_utf8_lossy(&b).replace('\0', "\n")).unwrap_or_default();
    #[cfg(not(target_os = "linux"))]
    let cmdline = std::process::Command::new("ps")
        .args(["-ww", "-o", "command=", "-p", &pid.to_string()])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    cmdline.contains(&want)
}

/// Running as root: Chromium needs `--no-sandbox` then.
pub(super) fn is_root() -> bool {
    #[cfg(unix)]
    {
        // SAFETY: geteuid never fails.
        unsafe { libc::geteuid() == 0 }
    }
    #[cfg(not(unix))]
    false
}

/// When the browser crashed (or quit by itself) and how long to wait before starting it again:
/// 1, 2, 4, 8, 16 s for consecutive crashes, then it stays down (`error`). A run of at least
/// [`Restarts::STABLE`] starts the count again.
#[derive(Debug, Default)]
pub(super) struct Restarts {
    streak: u32,
}

impl Restarts {
    pub const STABLE: Duration = Duration::from_secs(60);
    pub const MAX: u32 = 5;

    /// The browser ended by itself after running `ran`: start it again after the returned delay,
    /// or (`None`) give up.
    pub fn on_exit(&mut self, ran: Duration) -> Option<Duration> {
        if ran >= Self::STABLE {
            self.streak = 0;
        }
        self.streak += 1;
        (self.streak <= Self::MAX).then(|| Duration::from_secs(1 << (self.streak - 1)))
    }

    /// The user started it: a fresh count.
    pub fn reset(&mut self) {
        self.streak = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags() {
        let origins = vec!["tauri://localhost".to_string(), "http://tauri.localhost".to_string(), "http://127.0.0.1:7420".to_string()];
        let base = Flags { profile: Path::new("/d/browser/profile"), headed: false, origins: &origins, os: "linux", root: false };
        let a = args(&base);
        for f in [
            "--user-data-dir=/d/browser/profile",
            "--remote-debugging-port=0",
            "--remote-debugging-address=127.0.0.1",
            "--remote-allow-origins=tauri://localhost,http://tauri.localhost,http://127.0.0.1:7420",
            "--no-first-run",
            "--no-default-browser-check",
            "--headless=new",
            "--password-store=basic",
        ] {
            assert!(a.iter().any(|x| x == f), "{f} missing from {a:?}");
        }
        assert!(!a.iter().any(|x| x == "--no-sandbox" || x == "--enable-automation"), "{a:?}");
        let headed = args(&Flags { headed: true, ..base });
        assert!(!headed.iter().any(|x| x.starts_with("--headless") || x.starts_with("--window-size")), "{headed:?}");
        assert!(headed.iter().any(|x| x == "--password-store=basic"), "the same secrets store in both modes");
        let mac = args(&Flags { os: "macos", ..base });
        assert!(mac.iter().any(|x| x == "--use-mock-keychain") && !mac.iter().any(|x| x.starts_with("--password-store")));
        let win = args(&Flags { os: "windows", ..base });
        assert!(!win.iter().any(|x| x.starts_with("--password-store") || x == "--use-mock-keychain"));
        assert!(args(&Flags { root: true, ..base }).iter().any(|x| x == "--no-sandbox"));
    }

    #[test]
    fn active_port_file() {
        assert_eq!(parse_active_port("41239\n/devtools/browser/0c1d6c5e-8a7f-4b8e-9d1c-2f3a4b5c6d7e\n"), Some((41239, "/devtools/browser/0c1d6c5e-8a7f-4b8e-9d1c-2f3a4b5c6d7e".into())));
        assert_eq!(parse_active_port("41239\r\n/devtools/browser/abc\r\n"), Some((41239, "/devtools/browser/abc".into())));
        // Being written (one line so far), garbage, a zero port, a page instead of the browser.
        assert_eq!(parse_active_port("41239\n"), None);
        assert_eq!(parse_active_port(""), None);
        assert_eq!(parse_active_port("0\n/devtools/browser/abc\n"), None);
        assert_eq!(parse_active_port("70000\n/devtools/browser/abc\n"), None);
        assert_eq!(parse_active_port("41239\n/devtools/page/abc\n"), None);
        assert_eq!(parse_active_port("41239\n/devtools/browser/\n"), None);
    }

    #[test]
    fn restart_schedule() {
        let mut r = Restarts::default();
        let quick = Duration::from_secs(5);
        let delays: Vec<Option<u64>> = (0..6).map(|_| r.on_exit(quick).map(|d| d.as_secs())).collect();
        assert_eq!(delays, vec![Some(1), Some(2), Some(4), Some(8), Some(16), None], "consecutive crashes back off, then it stays down");
        // A run that lasted starts the count again.
        let mut r = Restarts::default();
        for _ in 0..4 {
            r.on_exit(quick);
        }
        assert_eq!(r.on_exit(Restarts::STABLE), Some(Duration::from_secs(1)));
        assert_eq!(r.on_exit(quick), Some(Duration::from_secs(2)));
        // The user starting it again is a fresh count, even after giving up.
        let mut r = Restarts::default();
        while r.on_exit(quick).is_some() {}
        r.reset();
        assert_eq!(r.on_exit(quick), Some(Duration::from_secs(1)));
    }
}
