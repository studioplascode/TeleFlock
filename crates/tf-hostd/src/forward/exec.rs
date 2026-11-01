//! The running end of a stream: on the to-host, a command through the user's shell, a login
//! shell or a tool (on a terminal on Unix when asked, else with pipes), or a TCP connection to
//! 127.0.0.1:<port>; on the from-host, the accepted connection of a forwarded port. Bytes move
//! with flow control (`flow`); a program's exit status ends the stream; a stream closed early
//! (the caller went away, the app disconnected, `forward.stop`) kills everything the program
//! started, also what it left running after it exited.
//!
//! The program runs with the daemon's environment (the user's PATH, `userenv.rs`), on Linux with
//! the variables of the user's current graphical session instead of the daemon's (`desktop.rs`),
//! in the user's home unless the caller named a directory. Unix: commands are `$SHELL -c
//! <line>`, the shell is `$SHELL -l`, each in a session of its own (`setsid`; with a terminal,
//! the terminal is its controlling one), and an early close sends the group SIGHUP, then SIGKILL
//! once it had a second.
//! Windows: `cmd.exe /d /s /c <line>` and an interactive `cmd.exe`, always with pipes (no
//! terminal), tools found on PATH with PATHEXT, each in a job object of its own that an early
//! close ends (`taskkill /T` of its tree when Windows refused the job).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use tf_proto::{FWD_CHUNK, ForwardKind, FwdEv, FwdPty};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

use super::flow::{Inflight, Window};

/// Sends an event of this stream to the app; `false` once the app is gone.
pub(crate) type Send = Arc<dyn Fn(FwdEv) -> bool + std::marker::Send + Sync>;

/// One end of a stream.
pub(crate) struct Stream {
    pub send: Send,
    /// The app's events for this stream (acks are applied to `window` before they get here).
    pub rx: mpsc::UnboundedReceiver<FwdEv>,
    /// Credit for what this end sends.
    pub window: Arc<Window>,
    /// App data towards this end not yet acknowledged.
    pub inflight: Arc<Inflight>,
}

/// Once the program exited, its output is read until it pauses this long: a background job that
/// keeps stdout open does not hold the stream.
const DRAIN_IDLE: Duration = Duration::from_millis(200);
/// How long a hung-up process group gets before SIGKILL.
#[cfg(unix)]
const KILL_GRACE: Duration = Duration::from_secs(1);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Runs a stream the app opened here until it ends. `shims`: this host's own tool shims
/// (`<home>/forward/bin`), which a forwarded tool never resolves to.
pub(crate) async fn run(open: FwdEv, mut s: Stream, cancel: CancellationToken, shims: &Path) {
    let FwdEv::Open { kind, command, argv, pty, cwd, port, .. } = open else { return };
    if kind == ForwardKind::Port {
        return connect(port.unwrap_or(0), s, &cancel).await;
    }
    match command_for(kind, command, argv, cwd, shims) {
        Ok(mut prepared) => {
            in_session(&mut prepared.cmd).await;
            process(prepared, pty, &mut s, cancel).await
        }
        Err(why) => {
            (s.send)(FwdEv::Close { error: Some(why) });
        }
    }
}

/// What to start, and what to call it in errors.
struct Prepared {
    cmd: std::process::Command,
    what: String,
}

fn command_for(kind: ForwardKind, command: Option<String>, argv: Option<Vec<String>>, cwd: Option<String>, shims: &Path) -> Result<Prepared, String> {
    let dir = match cwd.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        Some(c) => {
            let p = crate::paths::expand_tilde(c);
            if !on_this_computer(&p) || !p.is_dir() {
                return Err(format!("no such directory: {c}"));
            }
            p
        }
        None => crate::paths::home_dir(),
    };
    let (mut cmd, what) = match kind {
        ForwardKind::Command => {
            let line = command.filter(|c| !c.trim().is_empty()).ok_or("there is no command to run")?;
            (shell_command(&line), line)
        }
        ForwardKind::Shell => (login_shell(), "the login shell".to_string()),
        ForwardKind::Tool => {
            let argv = argv.filter(|a| !a.is_empty()).ok_or("there is no tool to run")?;
            if !super::valid_tool(&argv[0]) {
                return Err(format!("\"{}\" is not a command name", argv[0]));
            }
            let mut c = std::process::Command::new(resolve(&argv[0], &std::env::var_os("PATH").unwrap_or_default(), shims)?);
            c.args(&argv[1..]);
            (c, argv[0].clone())
        }
        ForwardKind::Port => return Err("a port is not a command".into()),
    };
    cmd.current_dir(dir);
    Ok(Prepared { cmd, what })
}

/// Puts a program in the user's current graphical session (Linux: `desktop.rs`); elsewhere it
/// keeps the daemon's environment.
async fn in_session(cmd: &mut std::process::Command) {
    #[cfg(target_os = "linux")]
    if let Some(session) = super::desktop::current().await {
        session.apply(cmd);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = cmd;
}

/// Whether a working directory can be looked at without asking another computer: on Windows a
/// drive path; a UNC or device path would contact a server (and offer it the user's credentials)
/// before anything runs.
fn on_this_computer(p: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        matches!(p.components().next(), Some(Component::Prefix(pre)) if matches!(pre.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
    }
    #[cfg(not(windows))]
    {
        let _ = p;
        true
    }
}

/// The tool's program on `path` (the daemon's PATH, the user's: `userenv.rs`), with PATHEXT on
/// Windows (`agent-browser` → `agent-browser.cmd`). This host's own shims are skipped (a profile
/// may put their directory on PATH): a tool forwarded here runs the real program, never a shim
/// that forwards it on again (in circles between two hosts that forward it to each other).
fn resolve(tool: &str, path: &std::ffi::OsStr, shims: &Path) -> Result<PathBuf, String> {
    let shims = std::fs::canonicalize(shims).unwrap_or_else(|_| shims.to_path_buf());
    std::env::split_paths(path)
        .filter(|dir| dir.is_absolute() && std::fs::canonicalize(dir).unwrap_or_else(|_| dir.clone()) != shims)
        .find_map(|dir| program_in(&dir, tool))
        .ok_or_else(|| format!("{tool}: command not found"))
}

#[cfg(unix)]
fn program_in(dir: &Path, tool: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let p = dir.join(tool);
    std::fs::metadata(&p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).then_some(p)
}

#[cfg(windows)]
fn program_in(dir: &Path, tool: &str) -> Option<PathBuf> {
    let plain = dir.join(tool);
    if Path::new(tool).extension().is_some() && plain.is_file() {
        return Some(plain);
    }
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    exts.split(';').filter(|e| !e.is_empty()).map(|e| dir.join(format!("{tool}{e}"))).find(|p| p.is_file())
}

#[cfg(unix)]
fn user_shell() -> std::path::PathBuf {
    crate::userenv::login_shell().unwrap_or_else(|| "/bin/sh".into())
}

#[cfg(unix)]
fn shell_command(line: &str) -> std::process::Command {
    let mut c = std::process::Command::new(user_shell());
    c.arg("-c").arg(line);
    c
}

#[cfg(unix)]
fn login_shell() -> std::process::Command {
    let mut c = std::process::Command::new(user_shell());
    c.arg("-l");
    c
}

#[cfg(windows)]
fn comspec() -> std::path::PathBuf {
    std::env::var_os("ComSpec").filter(|v| !v.is_empty()).map(Into::into).unwrap_or_else(|| "cmd.exe".into())
}

#[cfg(windows)]
fn shell_command(line: &str) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut c = std::process::Command::new(comspec());
    // `/s`: cmd strips the outer quotes and runs the line exactly as typed.
    c.args(["/d", "/s", "/c"]).raw_arg(format!("\"{line}\""));
    c
}

#[cfg(windows)]
fn login_shell() -> std::process::Command {
    std::process::Command::new(comspec())
}

fn spawn_error(what: &str, e: &std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound { format!("{what}: command not found") } else { format!("could not start {what}: {e}") }
}

enum Input {
    Data(Vec<u8>),
    Eof,
}

/// Writes the app's data to the program (or connection) and acknowledges it once written; data
/// a program no longer reads is dropped and still acknowledged. `eof`: what end of input is for a
/// terminal (^D); without it, end of input closes the writer.
async fn feed<W: AsyncWrite + Unpin>(mut w: Option<W>, mut rx: mpsc::UnboundedReceiver<Input>, send: Send, inflight: Arc<Inflight>, eof: Option<&'static [u8]>) {
    while let Some(input) = rx.recv().await {
        match input {
            Input::Data(b) => {
                if let Some(wr) = w.as_mut()
                    && wr.write_all(&b).await.is_err()
                {
                    w = None;
                }
                let n = b.len() as u64;
                inflight.acked(n);
                if !send(FwdEv::Ack { n }) {
                    return;
                }
            }
            Input::Eof => {
                match (eof, w.as_mut()) {
                    (Some(bytes), Some(wr)) => {
                        let _ = wr.write_all(bytes).await;
                    }
                    (None, Some(wr)) => {
                        // TCP: a FIN; pipes close when the writer is dropped right after.
                        let _ = wr.shutdown().await;
                    }
                    _ => {}
                }
                return;
            }
        }
    }
}

/// Sends what `r` yields as `data` frames on `fd`, within the window. After `exited` turns true,
/// a pause of [`DRAIN_IDLE`] counts as the end. Returns `true` at the end of the output, `false`
/// when the stream or the app went away.
async fn drain<R: AsyncRead + Unpin>(mut r: R, fd: u8, window: Arc<Window>, send: Send, mut exited: Option<watch::Receiver<bool>>) -> bool {
    let mut buf = vec![0u8; FWD_CHUNK];
    loop {
        let Some(room) = window.reserve().await else { return false };
        let n = loop {
            let Some(ex) = exited.as_mut() else { break r.read(&mut buf[..room]).await.unwrap_or(0) };
            if *ex.borrow() {
                break match tokio::time::timeout(DRAIN_IDLE, r.read(&mut buf[..room])).await {
                    Ok(Ok(n)) => n,
                    _ => 0,
                };
            }
            tokio::select! {
                res = r.read(&mut buf[..room]) => break res.unwrap_or(0),
                changed = ex.changed() => if changed.is_err() {
                    break 0;
                },
            }
        };
        if n == 0 {
            window.release(room);
            return true;
        }
        window.release(room - n);
        if !send(FwdEv::Data { data: B64.encode(&buf[..n]), fd }) {
            return false;
        }
    }
}

async fn process(p: Prepared, pty: Option<FwdPty>, s: &mut Stream, cancel: CancellationToken) {
    #[cfg(unix)]
    if let Some(size) = pty {
        return on_terminal(p, size, s, cancel).await;
    }
    #[cfg(not(unix))]
    let _ = pty;
    with_pipes(p, s, cancel).await
}

async fn with_pipes(p: Prepared, s: &mut Stream, cancel: CancellationToken) {
    use std::process::Stdio;
    let Prepared { cmd, what } = p;
    let mut cmd = tokio::process::Command::from(cmd);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    // Like ssh without a terminal: no TERM.
    cmd.env_remove("TERM");
    #[cfg(unix)]
    // SAFETY: setsid is async-signal-safe.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    #[cfg(windows)]
    {
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            (s.send)(FwdEv::Close { error: Some(spawn_error(&what, &e)) });
            return;
        }
    };
    let tree = Tree::of(&child);
    let (stdin, stdout, stderr) = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    if !(s.send)(FwdEv::Opened { pty: false }) {
        return tree.kill(&mut child).await;
    }
    let outputs: Vec<(Box<dyn AsyncRead + Unpin + std::marker::Send>, u8)> = [stdout.map(|o| (Box::new(o) as _, 1)), stderr.map(|e| (Box::new(e) as _, 2))].into_iter().flatten().collect();
    supervise(child, tree, stdin, None, outputs, None, s, cancel).await;
}

#[cfg(unix)]
async fn on_terminal(p: Prepared, size: FwdPty, s: &mut Stream, cancel: CancellationToken) {
    use super::pty;
    let Prepared { cmd, what } = p;
    let mut cmd = tokio::process::Command::from(cmd);
    cmd.kill_on_drop(true).env("TERM", size.term.as_deref().filter(|t| !t.is_empty()).unwrap_or("xterm-256color"));
    let started = pty::open(size.cols, size.rows).and_then(move |(master, slave)| {
        pty::attach(&mut cmd, &slave)?;
        let child = cmd.spawn()?;
        // The command holds copies of the slave for the child's stdio: only the program may keep
        // it open, so the master reads the end once the program and its jobs are gone.
        drop(cmd);
        drop(slave);
        Ok((child, Arc::new(pty::PtyMaster::new(master)?)))
    });
    let (mut child, master) = match started {
        Ok(c) => c,
        Err(e) => {
            (s.send)(FwdEv::Close { error: Some(spawn_error(&what, &e)) });
            return;
        }
    };
    let tree = Tree::of(&child);
    if !(s.send)(FwdEv::Opened { pty: true }) {
        return tree.kill(&mut child).await;
    }
    let outputs: Vec<(Box<dyn AsyncRead + Unpin + std::marker::Send>, u8)> = vec![(Box::new(Shared(master.clone())), 1)];
    supervise(child, tree, Some(Shared(master.clone())), Some(b"\x04"), outputs, Some(master), s, cancel).await;
}

/// The terminal's master side for the reader and the writer task at once.
#[cfg(unix)]
struct Shared(Arc<super::pty::PtyMaster>);

#[cfg(unix)]
impl AsyncRead for Shared {
    fn poll_read(self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &mut tokio::io::ReadBuf<'_>) -> std::task::Poll<std::io::Result<()>> {
        let mut m: &super::pty::PtyMaster = &self.0;
        std::pin::Pin::new(&mut m).poll_read(cx, buf)
    }
}

#[cfg(unix)]
impl AsyncWrite for Shared {
    fn poll_write(self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, data: &[u8]) -> std::task::Poll<std::io::Result<usize>> {
        let mut m: &super::pty::PtyMaster = &self.0;
        std::pin::Pin::new(&mut m).poll_write(cx, data)
    }
    fn poll_flush(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }
}

/// The terminal a program runs on, for resizes (Unix), else nothing.
#[cfg(unix)]
type Terminal = Option<Arc<super::pty::PtyMaster>>;
#[cfg(not(unix))]
type Terminal = Option<()>;

/// Applies the app's event to a running program: input, end of input, a resize. `false` once the
/// stream is over (closed, the app gone, data that is not base64).
fn apply(ev: Option<FwdEv>, input: &mpsc::UnboundedSender<Input>, terminal: &Terminal, send: &Send) -> bool {
    match ev {
        Some(FwdEv::Data { data, .. }) => match B64.decode(data.as_bytes()) {
            Ok(b) => {
                let _ = input.send(Input::Data(b));
                true
            }
            Err(_) => {
                send(FwdEv::Close { error: Some("the TeleFlock app sent data that is not base64".into()) });
                false
            }
        },
        Some(FwdEv::Eof) => {
            let _ = input.send(Input::Eof);
            true
        }
        Some(FwdEv::Resize { cols, rows }) => {
            #[cfg(unix)]
            if let Some(t) = terminal {
                let _ = t.resize(cols, rows);
            }
            #[cfg(not(unix))]
            let _ = (cols, rows, terminal);
            true
        }
        Some(FwdEv::Close { .. }) | None => false,
        Some(_) => true,
    }
}

/// Moves a running program's bytes until it exits, then its output until that pauses, and ends
/// the stream with its exit status. A stream that closes before that (also while a job the
/// program left running still writes, or waits for credit the caller no longer gives) kills
/// everything the program started.
#[allow(clippy::too_many_arguments)]
async fn supervise<W: AsyncWrite + Unpin + std::marker::Send + 'static>(
    mut child: tokio::process::Child,
    tree: Tree,
    input: Option<W>,
    eof: Option<&'static [u8]>,
    outputs: Vec<(Box<dyn AsyncRead + Unpin + std::marker::Send>, u8)>,
    terminal: Terminal,
    s: &mut Stream,
    cancel: CancellationToken,
) {
    let (in_tx, in_rx) = mpsc::unbounded_channel();
    let feeder = tokio::spawn(feed(input, in_rx, s.send.clone(), s.inflight.clone(), eof));
    let (exited_tx, exited_rx) = watch::channel(false);
    let mut readers: Vec<_> = outputs.into_iter().map(|(r, fd)| tokio::spawn(drain(r, fd, s.window.clone(), s.send.clone(), Some(exited_rx.clone())))).collect();
    let mut status = loop {
        tokio::select! {
            st = child.wait() => break Some(st),
            ev = s.rx.recv() => if !apply(ev, &in_tx, &terminal, &s.send) {
                break None;
            },
            _ = cancel.cancelled() => break None,
        }
    };
    if let Some(Ok(_)) = status {
        let _ = exited_tx.send(true);
        'output: for r in readers.iter_mut() {
            loop {
                tokio::select! {
                    _ = &mut *r => break,
                    ev = s.rx.recv() => if !apply(ev, &in_tx, &terminal, &s.send) {
                        status = None;
                        break 'output;
                    },
                    _ = cancel.cancelled() => {
                        status = None;
                        break 'output;
                    }
                }
            }
        }
    }
    feeder.abort();
    match status {
        Some(Ok(st)) => {
            #[cfg(unix)]
            let signal = std::os::unix::process::ExitStatusExt::signal(&st);
            #[cfg(not(unix))]
            let signal = None;
            (s.send)(FwdEv::Exit { code: st.code(), signal });
        }
        Some(Err(e)) => {
            (s.send)(FwdEv::Close { error: Some(format!("lost track of the program: {e}")) });
            s.window.close();
            readers.iter().for_each(|r| r.abort());
        }
        None => {
            s.window.close();
            readers.iter().for_each(|r| r.abort());
            tree.kill(&mut child).await;
        }
    }
}

/// Everything a program started, taken right after its spawn: on Unix its process group (it
/// called setsid, so the group's id is its pid, and stays the group's while the program is
/// unreaped or a process of the group lives); on Windows its job object, else its process tree
/// (`taskkill /T` finds that only through a running program).
struct Tree {
    pid: Option<u32>,
    #[cfg(windows)]
    job: Option<job::Job>,
}

impl Tree {
    fn of(child: &tokio::process::Child) -> Tree {
        Tree {
            pid: child.id(),
            #[cfg(windows)]
            job: job::Job::of(child),
        }
    }

    /// Ends the program and everything it started (also after the program itself exited), and
    /// reaps the program.
    async fn kill(&self, child: &mut tokio::process::Child) {
        if let Some(pid) = self.pid {
            #[cfg(unix)]
            {
                let group = pid as libc::pid_t;
                // SAFETY: signals the program's own process group (see `Tree`).
                unsafe { libc::killpg(group, libc::SIGHUP) };
                // The program (at once if it exited already), then the rest of its group, within
                // the grace.
                let grace = tokio::time::Instant::now() + KILL_GRACE;
                let _ = tokio::time::timeout_at(grace, child.wait()).await;
                // SAFETY: signal 0 only checks whether a process of the group is left.
                while tokio::time::Instant::now() < grace && unsafe { libc::killpg(group, 0) } == 0 {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                // Whatever ignored the hangup goes too.
                // SAFETY: as above.
                unsafe { libc::killpg(group, libc::SIGKILL) };
            }
            #[cfg(windows)]
            match &self.job {
                Some(job) => job.terminate(),
                None => {
                    let mut tk = tokio::process::Command::new("taskkill");
                    tk.args(["/T", "/F", "/PID", &pid.to_string()]).creation_flags(CREATE_NO_WINDOW).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
                    let _ = tokio::time::timeout(Duration::from_secs(5), tk.status()).await;
                }
            }
        }
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
}

/// A job object for a forwarded program on Windows: the processes it starts join it, so ending
/// the job ends them all, whether the program still runs or not. Closing the handle leaves them
/// running (a stream that ended normally kills nothing).
#[cfg(windows)]
mod job {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW, TerminateJobObject};

    pub(super) struct Job(HANDLE);

    // SAFETY: a job object handle may be used and closed from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        /// Puts a program that was just spawned in a job of its own; `None` when Windows refuses.
        pub fn of(child: &tokio::process::Child) -> Option<Job> {
            let process = child.raw_handle()? as HANDLE;
            // SAFETY: an anonymous job with default security.
            let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if job.is_null() {
                return None;
            }
            let job = Job(job);
            // SAFETY: both handles are valid; the child's lives as long as `child`.
            (unsafe { AssignProcessToJobObject(job.0, process) } != 0).then_some(job)
        }

        /// Ends every process in the job.
        pub fn terminate(&self) {
            // SAFETY: a valid job handle.
            unsafe { TerminateJobObject(self.0, 1) };
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: the handle is ours and closed once.
            unsafe { CloseHandle(self.0) };
        }
    }
}

/// A connection to 127.0.0.1:`port` on this host for the app's stream, else to [::1]:`port` (a
/// server listening on `localhost` may have only that: Vite on macOS); loopback only.
async fn connect(port: u16, mut s: Stream, cancel: &CancellationToken) {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
    let attempt = |ip: IpAddr| tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::TcpStream::connect((ip, port)));
    let connected = match attempt(Ipv4Addr::LOCALHOST.into()).await {
        Ok(Ok(conn)) => Ok(conn),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionRefused => match attempt(Ipv6Addr::LOCALHOST.into()).await {
            Ok(Ok(conn)) => Ok(conn),
            _ => Err(format!("nothing accepts connections on 127.0.0.1:{port} or [::1]:{port} there ({e})")),
        },
        Ok(Err(e)) => Err(format!("nothing accepts connections on 127.0.0.1:{port} there ({e})")),
        Err(_) => Err(format!("connecting to 127.0.0.1:{port} there timed out")),
    };
    match connected {
        Ok(conn) => {
            let _ = conn.set_nodelay(true);
            if (s.send)(FwdEv::Opened { pty: false }) {
                tcp(conn, &mut s, 1, cancel).await;
            }
        }
        Err(why) => {
            (s.send)(FwdEv::Close { error: Some(why) });
        }
    }
}

/// Moves a TCP connection's bytes (`out_fd`: 0 from the from-host, 1 from the to-host) until both
/// directions ended (`eof` each way), the stream closed or the daemon stops.
pub(crate) async fn tcp(conn: tokio::net::TcpStream, s: &mut Stream, out_fd: u8, cancel: &CancellationToken) {
    let (r, w) = conn.into_split();
    let (in_tx, in_rx) = mpsc::unbounded_channel();
    let mut feeder = tokio::spawn(feed(Some(w), in_rx, s.send.clone(), s.inflight.clone(), None));
    let (send, window) = (s.send.clone(), s.window.clone());
    let mut reader = tokio::spawn(async move {
        if drain(r, out_fd, window, send.clone(), None).await {
            send(FwdEv::Eof);
        }
    });
    let (mut read_done, mut write_done) = (false, false);
    while !(read_done && write_done) {
        tokio::select! {
            _ = &mut reader, if !read_done => read_done = true,
            _ = &mut feeder, if !write_done => write_done = true,
            _ = cancel.cancelled() => break,
            ev = s.rx.recv() => match ev {
                Some(FwdEv::Data { data, .. }) => match B64.decode(data.as_bytes()) {
                    Ok(b) => {
                        let _ = in_tx.send(Input::Data(b));
                    }
                    Err(_) => {
                        (s.send)(FwdEv::Close { error: Some("the TeleFlock app sent data that is not base64".into()) });
                        break;
                    }
                },
                Some(FwdEv::Eof) => {
                    let _ = in_tx.send(Input::Eof);
                }
                Some(FwdEv::Close { .. }) | None => break,
                Some(_) => {}
            },
        }
    }
    s.window.close();
    reader.abort();
    feeder.abort();
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// A tool forwarded here runs the real program: this host's own shim directory on PATH (as a
    /// profile may put it, also through a symlink) is skipped; files that are not programs are not
    /// found.
    #[test]
    fn a_tool_resolves_past_this_hosts_own_shims() {
        let td = tempfile::tempdir().unwrap();
        let (shims, real) = (td.path().join("forward/bin"), td.path().join("bin"));
        crate::test_exe::write_exe(&shims.join("tool"), "#!/bin/sh\necho shim\n");
        crate::test_exe::write_exe(&real.join("tool"), "#!/bin/sh\necho real\n");
        std::os::unix::fs::symlink(&shims, td.path().join("link")).unwrap();
        std::fs::write(real.join("plain"), "not a program").unwrap();
        let path = std::env::join_paths([td.path().join("link"), shims.clone(), real.clone()]).unwrap();
        assert_eq!(resolve("tool", &path, &shims), Ok(real.join("tool")));
        assert_eq!(resolve("plain", &path, &shims), Err("plain: command not found".to_string()));
    }
}
