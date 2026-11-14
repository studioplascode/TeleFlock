//! Agents' work tf-hostd starts itself: the commands other hosts forward here (`forward/exec.rs`).
//! While tf-hostd's own unit carries raised weights ([`super`]) such a command must not share its
//! cgroup, so it starts held: a `/bin/sh` trampoline waits on a pipe before it execs the program;
//! tf-hostd moves the waiting process into a transient scope of its own (systemd's
//! `StartTransientUnit` with its pid), sees it arrive there, then lets it go.
//!
//! The program runs exactly once or not at all, never twice: a failed move still lets it go (it
//! then runs in tf-hostd's unit: degraded, never failed, and the next check probes again), and
//! tf-hostd ending before the release closes the pipe, so the trampoline exits [`ABANDONED`]
//! without running anything.
//!
//! The child gets the pipe as descriptor [`GATE_FD`] (3): `sh` takes only one-digit descriptors
//! in redirections (dash, Debian's `/bin/sh`), and tf-hostd's own descriptors are mostly higher.

use std::io::Write as _;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use tracing::{debug, warn};

use super::Fail;

/// Moves a process (its pid) into its scope and waits until it is there.
pub(crate) type Place = Arc<dyn Fn(u32) -> Result<(), Fail> + Send + Sync>;

/// Exit status of a held program whose release never came (tf-hostd went away first).
pub const ABANDONED: i32 = 125;

/// The descriptor the held child reads its release from.
const GATE_FD: RawFd = 3;

/// `sh -c TRAMPOLINE sh <program> <args…>`: waits for a line on [`GATE_FD`], closes it, execs the
/// program with its arguments as they are. End of file instead: exits [`ABANDONED`].
const TRAMPOLINE: &str = r#"read -r _ <&3 || exit 125; exec 3<&-; exec "$@""#;

/// A process started held: what tf-hostd keeps of it until [`Gate::go`].
pub(crate) struct Gate {
    /// The pipe's read end; the child takes it over as [`GATE_FD`].
    theirs: OwnedFd,
    ours: OwnedFd,
    place: Place,
}

impl Gate {
    pub(crate) fn new(place: Place) -> std::io::Result<Gate> {
        let (theirs, ours) = pipe()?;
        Ok(Gate { theirs, ours, place })
    }

    /// `cmd` behind the trampoline, with the same environment changes and working directory.
    /// stdio and `pre_exec` are set on the result, as for `cmd`; its `pre_exec` must call [`keep`]
    /// with [`Gate::child_fd`].
    pub(crate) fn wrap(&self, cmd: &std::process::Command) -> std::process::Command {
        let mut held = std::process::Command::new("/bin/sh");
        held.arg("-c").arg(TRAMPOLINE).arg("sh").arg(cmd.get_program()).args(cmd.get_args());
        for (key, value) in cmd.get_envs() {
            match value {
                Some(v) => held.env(key, v),
                None => held.env_remove(key),
            };
        }
        if let Some(dir) = cmd.get_current_dir() {
            held.current_dir(dir);
        }
        held
    }

    /// The descriptor [`keep`] hands to the child.
    pub(crate) fn child_fd(&self) -> RawFd {
        self.theirs.as_raw_fd()
    }

    /// After the spawn: moves the child (`pid`) into its scope, then lets it run, also when the
    /// move failed. Blocks for as long as the move takes (seconds at most).
    pub(crate) fn go(self, pid: Option<u32>) -> Result<(), Fail> {
        let Gate { theirs, ours, place } = self;
        drop(theirs);
        let moved = pid.map_or_else(|| Err(Fail::Gone), |pid| place(pid));
        // A program that is gone already (a stream closed early) takes nothing: EPIPE, ignored.
        let _ = std::fs::File::from(ours).write_all(b"\n");
        moved
    }

    /// [`Gate::go`] on the runtime's blocking threads. A failed move is logged (once at warning
    /// level) and makes tf-hostd check again; a program that ended meanwhile is no failure.
    pub(crate) fn release(self, pid: Option<u32>) {
        tokio::task::spawn_blocking(move || match self.go(pid) {
            Ok(()) | Err(Fail::Gone) => {}
            Err(e) => {
                static WARNED: AtomicBool = AtomicBool::new(false);
                if WARNED.swap(true, Ordering::Relaxed) {
                    debug!("a forwarded command runs in tf-hostd's own unit: {e:?}");
                } else {
                    warn!("a forwarded command runs in tf-hostd's own unit, above the agents: {e:?} (logged once)");
                }
                super::move_failed();
            }
        });
    }
}

/// In the child between fork and exec: the gate's pipe (`fd`) becomes [`GATE_FD`] and stays open
/// across exec. Both pipe ends are close-on-exec, so tf-hostd's other children never hold them,
/// and `fd` itself still closes at the exec.
pub(crate) fn keep(fd: RawFd) -> std::io::Result<()> {
    // SAFETY: dup2 and fcntl on descriptors the child inherited; both async-signal-safe. dup2 onto
    // the same descriptor does nothing, so that one has its flag cleared instead.
    let r = unsafe { if fd == GATE_FD { libc::fcntl(GATE_FD, libc::F_SETFD, 0) } else { libc::dup2(fd, GATE_FD) } };
    if r < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// A fresh transient scope name `<prefix>-<n>-<pid>-<ms>.scope` (`n` counts up: two commands in
/// the same millisecond get two names).
pub(crate) fn unit_name(prefix: &str) -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    tf_herdr::durable::unit_name(&format!("{prefix}-{n}"), std::process::id(), crate::util::now_ms().max(0) as u64)
}

/// A pipe whose ends are close-on-exec: (read, write).
fn pipe() -> std::io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0 as libc::c_int; 2];
    #[cfg(target_os = "linux")]
    // SAFETY: `fds` holds two ints for the descriptors.
    let r = unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) };
    #[cfg(not(target_os = "linux"))]
    // SAFETY: as above; the flags are set right after (gates are only made on Linux).
    let r = unsafe { libc::pipe(fds.as_mut_ptr()) };
    if r != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: two fresh descriptors we now own.
    let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    #[cfg(not(target_os = "linux"))]
    for fd in [&read, &write] {
        // SAFETY: fcntl on a descriptor we own.
        if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok((read, write))
}

#[cfg(all(test, target_os = "linux"))]
pub(crate) mod tests {
    use std::os::unix::process::CommandExt;
    use std::process::Command;
    use std::sync::Mutex;

    use super::*;

    /// Puts the gate's pipe on a descriptor ≥ `min`, as in tf-hostd, where most are taken.
    pub(crate) fn high(gate: Gate, min: RawFd) -> Gate {
        // SAFETY: F_DUPFD_CLOEXEC on a descriptor we own; the result is a fresh one we own.
        let fd = unsafe { libc::fcntl(gate.theirs.as_raw_fd(), libc::F_DUPFD_CLOEXEC, min) };
        assert!(fd >= min, "{}", std::io::Error::last_os_error());
        // SAFETY: as above.
        Gate { theirs: unsafe { OwnedFd::from_raw_fd(fd) }, ..gate }
    }

    /// Starts `script` held by `gate`, as `forward/exec.rs` does (own session, the pipe kept).
    fn spawn_held(gate: &Gate, script: &str, out: &std::path::Path) -> std::process::Child {
        spawn_held_as(gate, script, out, false)
    }

    /// [`spawn_held`]; `on_three`: the child has the pipe on descriptor 3 already (close-on-exec,
    /// as when tf-hostd's own copy is 3), where `dup2` onto itself would do nothing.
    fn spawn_held_as(gate: &Gate, script: &str, out: &std::path::Path, on_three: bool) -> std::process::Child {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(script).env("OUT", out);
        let mut held = gate.wrap(&cmd);
        held.stdout(std::process::Stdio::piped());
        let fd = gate.child_fd();
        // SAFETY: setsid, dup3, dup2 and fcntl are async-signal-safe; the descriptors are the
        // child's own.
        unsafe {
            held.pre_exec(move || {
                libc::setsid();
                if on_three {
                    if libc::dup3(fd, GATE_FD, libc::O_CLOEXEC) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    return keep(GATE_FD);
                }
                keep(fd)
            });
        }
        held.spawn().unwrap()
    }

    /// The program runs once, after it was moved: the move's mark is there when it starts.
    #[test]
    fn a_held_command_runs_once_after_its_move() {
        let td = tempfile::tempdir().unwrap();
        let (out, mark) = (td.path().join("out"), td.path().join("moved"));
        let moved = Arc::new(Mutex::new(Vec::new()));
        let place: Place = {
            let (moved, mark) = (moved.clone(), mark.clone());
            Arc::new(move |pid| {
                moved.lock().unwrap().push(pid);
                std::fs::write(&mark, "").unwrap();
                Ok(())
            })
        };
        let gate = Gate::new(place).unwrap();
        let mut child = spawn_held(&gate, &format!("test -e '{}' && echo after-move >> \"$OUT\"; echo ran >> \"$OUT\"", mark.display()), &out);
        let pid = child.id();
        assert_eq!(gate.go(Some(pid)), Ok(()));
        assert!(child.wait().unwrap().success());
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "after-move\nran\n");
        assert_eq!(*moved.lock().unwrap(), vec![pid], "the waiting process itself is moved");
    }

    /// A move that fails (the scope could not be made) still lets the program run, once.
    #[test]
    fn a_failed_move_still_runs_the_command_once() {
        let td = tempfile::tempdir().unwrap();
        let out = td.path().join("out");
        let gate = Gate::new(Arc::new(|_| Err(Fail::Other("Failed to start transient scope unit".into())))).unwrap();
        let mut child = spawn_held(&gate, "echo ran >> \"$OUT\"; exit 3", &out);
        assert!(gate.go(Some(child.id())).is_err());
        assert_eq!(child.wait().unwrap().code(), Some(3), "the program's own exit status");
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "ran\n");
    }

    /// tf-hostd gone before the release (its end of the pipe closed): nothing runs.
    #[test]
    fn a_command_never_released_runs_nothing() {
        let td = tempfile::tempdir().unwrap();
        let out = td.path().join("out");
        let gate = Gate::new(Arc::new(|_| Ok(()))).unwrap();
        let mut child = spawn_held(&gate, "echo ran >> \"$OUT\"", &out);
        drop(gate);
        assert_eq!(child.wait().unwrap().code(), Some(ABANDONED));
        assert!(!out.exists(), "the program never started");
    }

    /// The pipe on a two-digit descriptor (`sh` reads one digit only) and on 3 itself: released,
    /// the program runs once and its output arrives; never released, it exits 125 unrun.
    #[test]
    fn the_gate_works_from_any_descriptor() {
        let td = tempfile::tempdir().unwrap();
        for on_three in [false, true] {
            let out = td.path().join(format!("out-{on_three}"));
            let gate = high(Gate::new(Arc::new(|_| Ok(()))).unwrap(), 40);
            assert!(gate.child_fd() >= 40);
            let child = spawn_held_as(&gate, "echo ran >> \"$OUT\"; echo hello", &out, on_three);
            gate.go(Some(child.id())).unwrap();
            let done = child.wait_with_output().unwrap();
            assert_eq!((done.status.code(), String::from_utf8_lossy(&done.stdout).into_owned()), (Some(0), "hello\n".to_string()), "on 3: {on_three}");
            assert_eq!(std::fs::read_to_string(&out).unwrap(), "ran\n");

            let out = td.path().join(format!("abandoned-{on_three}"));
            let gate = high(Gate::new(Arc::new(|_| Ok(()))).unwrap(), 40);
            let child = spawn_held_as(&gate, "echo ran >> \"$OUT\"", &out, on_three);
            drop(gate);
            assert_eq!(child.wait_with_output().unwrap().status.code(), Some(ABANDONED), "on 3: {on_three}");
            assert!(!out.exists());
        }
    }

    /// Arguments, environment changes and the working directory reach the program as they are,
    /// and the pipe does not.
    #[test]
    fn the_program_gets_its_arguments_environment_and_directory() {
        let td = tempfile::tempdir().unwrap();
        let gate = high(Gate::new(Arc::new(|_| Ok(()))).unwrap(), 40);
        let fd = gate.child_fd();
        // Whether the program still has descriptor 3 (the trampoline's) or tf-hostd's copy open.
        let open = format!("for n in 3 {fd}; do [ -e /proc/$$/fd/$n ] && printf 'open:%s ' $n || printf 'closed:%s ' $n; done");
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", &format!("printf '%s|' \"$@\" \"$TF_X\" \"${{HOME-unset}}\" \"$PWD\"; {open}"), "sh", "a b", "$HOME", "'q'"])
            .env("TF_X", "x y")
            .env_remove("HOME")
            .current_dir(td.path());
        let mut held = gate.wrap(&cmd);
        held.stdout(std::process::Stdio::piped()).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        // SAFETY: dup2 and fcntl are async-signal-safe.
        unsafe { held.pre_exec(move || keep(fd)) };
        let child = held.spawn().unwrap();
        let pid = child.id();
        gate.go(Some(pid)).unwrap();
        let out = String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap();
        let dir = td.path().canonicalize().unwrap();
        let (fields, fds) = out.rsplit_once('|').unwrap();
        assert_eq!(fields, format!("a b|$HOME|'q'|x y|unset|{}", dir.display()));
        assert_eq!(fds.trim(), format!("closed:3 closed:{fd}"), "the pipe is closed before the exec");
    }
}
