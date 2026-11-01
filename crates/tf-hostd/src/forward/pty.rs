//! Terminals for forwarded commands (Unix): the to-host's pseudo-terminal (`openpty`, the child
//! as session leader with the terminal as its controlling one) and the caller's raw mode.

use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::task::{Context, Poll, ready};

use tokio::io::unix::AsyncFd;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// A pseudo-terminal pair of `cols` × `rows`, both ends close-on-exec.
pub(crate) fn open(cols: u16, rows: u16) -> io::Result<(OwnedFd, OwnedFd)> {
    let (mut master, mut slave): (libc::c_int, libc::c_int) = (-1, -1);
    let mut size = libc::winsize { ws_row: rows.max(1), ws_col: cols.max(1), ws_xpixel: 0, ws_ypixel: 0 };
    // SAFETY: out-pointers to two ints; no name buffer, default termios, a valid winsize. The
    // pointers are `*mut` (macOS declares them mutable; Linux takes `*const`, which they coerce to).
    let r = unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null_mut(), &mut size) };
    if r != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openpty returned two fresh descriptors we now own.
    let (master, slave) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
    for fd in [&master, &slave] {
        set_flag(fd.as_raw_fd(), libc::F_GETFD, libc::F_SETFD, libc::FD_CLOEXEC)?;
    }
    Ok((master, slave))
}

fn set_flag(fd: RawFd, get: libc::c_int, set: libc::c_int, flag: libc::c_int) -> io::Result<()> {
    // SAFETY: fcntl on a descriptor we own.
    unsafe {
        let old = libc::fcntl(fd, get);
        if old < 0 || libc::fcntl(fd, set, old | flag) < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

/// Runs `cmd` on the terminal `slave`: stdin, stdout and stderr, and (in the child) a new session
/// whose controlling terminal it is, so the shell gets job control and the terminal's signals.
pub(crate) fn attach(cmd: &mut tokio::process::Command, slave: &OwnedFd) -> io::Result<()> {
    cmd.stdin(slave.try_clone()?).stdout(slave.try_clone()?).stderr(slave.try_clone()?);
    // SAFETY: only async-signal-safe calls (setsid, ioctl) between fork and exec; stdin is the
    // slave by then (std sets up stdio before running pre_exec hooks).
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(io::Error::last_os_error());
            }
            if libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Ok(())
}

/// The master side, readable and writable from tasks (`&PtyMaster` implements both traits).
pub(crate) struct PtyMaster {
    fd: AsyncFd<OwnedFd>,
}

impl PtyMaster {
    pub fn new(master: OwnedFd) -> io::Result<Self> {
        set_flag(master.as_raw_fd(), libc::F_GETFL, libc::F_SETFL, libc::O_NONBLOCK)?;
        // SAFETY: the descriptor is owned by the AsyncFd and stays open as long as it is registered.
        let fd = unsafe { AsyncFd::register(master) }?;
        Ok(Self { fd })
    }

    /// The caller's terminal changed size (the kernel tells the foreground job, SIGWINCH).
    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        set_size(self.fd.as_raw_fd(), cols, rows)
    }
}

pub(crate) fn set_size(fd: RawFd, cols: u16, rows: u16) -> io::Result<()> {
    let size = libc::winsize { ws_row: rows.max(1), ws_col: cols.max(1), ws_xpixel: 0, ws_ypixel: 0 };
    // SAFETY: TIOCSWINSZ with a valid winsize.
    if unsafe { libc::ioctl(fd, libc::TIOCSWINSZ as _, &size) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

impl AsyncRead for &PtyMaster {
    fn poll_read(self: std::pin::Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        loop {
            let mut guard = ready!(self.fd.poll_read_ready(cx))?;
            let unfilled = buf.initialize_unfilled();
            // SAFETY: reading into the initialized, unfilled part of the buffer.
            let r = guard.try_io(|fd| {
                let n = unsafe { libc::read(fd.as_raw_fd(), unfilled.as_mut_ptr().cast(), unfilled.len()) };
                if n < 0 { Err(io::Error::last_os_error()) } else { Ok(n as usize) }
            });
            match r {
                Ok(Ok(n)) => {
                    buf.advance(n);
                    return Poll::Ready(Ok(()));
                }
                // Linux: every slave descriptor closed (the program and all it started exited).
                Ok(Err(e)) if e.raw_os_error() == Some(libc::EIO) => return Poll::Ready(Ok(())),
                Ok(Err(e)) => return Poll::Ready(Err(e)),
                Err(_would_block) => continue,
            }
        }
    }
}

impl AsyncWrite for &PtyMaster {
    fn poll_write(self: std::pin::Pin<&mut Self>, cx: &mut Context<'_>, data: &[u8]) -> Poll<io::Result<usize>> {
        loop {
            let mut guard = ready!(self.fd.poll_write_ready(cx))?;
            // SAFETY: writing from a valid slice.
            match guard.try_io(|fd| {
                let n = unsafe { libc::write(fd.as_raw_fd(), data.as_ptr().cast(), data.len()) };
                if n < 0 { Err(io::Error::last_os_error()) } else { Ok(n as usize) }
            }) {
                Ok(r) => return Poll::Ready(r),
                Err(_would_block) => continue,
            }
        }
    }

    fn poll_flush(self: std::pin::Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: std::pin::Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

// ───────────────────────────── the caller's terminal ─────────────────────────────

/// Whether `fd` is a terminal.
pub(crate) fn is_tty(fd: RawFd) -> bool {
    // SAFETY: isatty only inspects the descriptor.
    unsafe { libc::isatty(fd) == 1 }
}

/// `(cols, rows)` of the terminal on `fd`.
pub(crate) fn size(fd: RawFd) -> Option<(u16, u16)> {
    let mut ws = libc::winsize { ws_row: 0, ws_col: 0, ws_xpixel: 0, ws_ypixel: 0 };
    // SAFETY: TIOCGWINSZ into a valid winsize.
    let r = unsafe { libc::ioctl(fd, libc::TIOCGWINSZ as _, &mut ws) };
    (r == 0 && ws.ws_col > 0 && ws.ws_row > 0).then_some((ws.ws_col, ws.ws_row))
}

/// The caller's terminal in raw mode until dropped (keys go to the remote program as they are,
/// ^C included; its output is shown as it comes).
pub(crate) struct RawMode {
    fd: RawFd,
    saved: libc::termios,
}

impl RawMode {
    pub fn enable(fd: RawFd) -> io::Result<RawMode> {
        // SAFETY: tcgetattr/tcsetattr with a valid termios on a terminal descriptor.
        unsafe {
            let mut saved: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(fd, &mut saved) != 0 {
                return Err(io::Error::last_os_error());
            }
            let mut raw = saved;
            libc::cfmakeraw(&mut raw);
            if libc::tcsetattr(fd, libc::TCSANOW, &raw) != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(RawMode { fd, saved })
        }
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        // SAFETY: restores the attributes saved from the same descriptor.
        unsafe {
            libc::tcsetattr(self.fd, libc::TCSANOW, &self.saved);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A program on the terminal sees it as its controlling terminal, at the size it was given and
    /// after a resize; the master reads end (not fail) once the program is gone.
    #[tokio::test]
    async fn a_program_runs_on_the_terminal_with_its_size() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (master, slave) = open(91, 27).unwrap();
        let mut cmd = tokio::process::Command::new("/bin/sh");
        cmd.args(["-c", "stty size; read line; stty size; test -t 0 && echo tty:$line"]);
        attach(&mut cmd, &slave).unwrap();
        let mut child = cmd.spawn().unwrap();
        // The command keeps copies of the slave for the child's stdio until dropped.
        drop(cmd);
        drop(slave);
        let master = PtyMaster::new(master).unwrap();
        let mut out = Vec::new();
        let mut buf = [0u8; 1024];
        while !String::from_utf8_lossy(&out).contains("27 91") {
            let n = (&master).read(&mut buf).await.unwrap();
            assert!(n > 0, "{}", String::from_utf8_lossy(&out));
            out.extend_from_slice(&buf[..n]);
        }
        master.resize(100, 40).unwrap();
        (&master).write_all(b"hi\n").await.unwrap();
        loop {
            let n = tokio::time::timeout(std::time::Duration::from_secs(10), (&master).read(&mut buf)).await.unwrap().unwrap();
            if n == 0 {
                break;
            }
            out.extend_from_slice(&buf[..n]);
        }
        let text = String::from_utf8_lossy(&out);
        assert!(text.contains("40 100") && text.contains("tty:hi"), "{text}");
        assert!(child.wait().await.unwrap().success());
    }
}
