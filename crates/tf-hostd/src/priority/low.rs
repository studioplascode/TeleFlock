//! tf-hostd's own background work below the agents' (architecture §3.36, the Cleanup page's
//! background scans of §3.17): the opposite of what [`super`] does for TeleFlock's connection.
//!
//! A background scan runs its tasks under a flag ([`scope`]) that a Rescan clears midway: the scan
//! then goes on as the page's own, at normal priority, from its next step. While the flag is set:
//!
//! - **Children** (git, gh: `ops::git::run_cmd`) start in a session of their own (`setsid`, so on
//!   Linux in a new autogroup, which they set to nice 19 too), at nice 19, and on Linux in the idle
//!   I/O class ([`lower_child`]); Windows starts them `BELOW_NORMAL_PRIORITY_CLASS`. Children share
//!   tf-hostd's cgroup, so where its own unit carries raised weights (systemd with cgroup v2,
//!   [`super`]) a nice value would not take them below the agents: they start held and are moved
//!   into a transient scope of their own with `CPUWeight` and `IOWeight` 1 first
//!   ([`super::background_gate`], the way [`super::work`] moves forwarded commands out).
//! - **Work in tf-hostd itself** (size walks, reading omp's session files) runs on a thread of its
//!   own ([`blocking`]): `SCHED_IDLE` and the idle I/O class on Linux (both per thread there), the
//!   background QoS class on macOS, `THREAD_MODE_BACKGROUND_BEGIN` on Windows. That puts it below
//!   whatever shares tf-hostd's CPU group; a group as a whole (a raised unit, an autogroup) still
//!   competes as one, which is why these scans recompute only what changed, bound their size
//!   checks per scan and wait while the host is busy (`ops::cleanup::schedule`).
//!
//! I/O classes count only where the disk's scheduler honours them (BFQ, mq-deadline from Linux
//! 5.14); `none` ignores them.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// The name of the threads [`blocking`] starts (Linux shows it in `/proc/<pid>/task/*/comm`).
pub const THREAD: &str = "tf-background";

tokio::task_local! {
    /// The background flag of the task (see [`scope`]).
    static LOW: Arc<AtomicBool>;
}

/// Runs `f` as background work while `flag` is set; tasks `f` spawns are wrapped in their own
/// [`scope`] with the same flag.
pub(crate) async fn scope<F: Future>(flag: Arc<AtomicBool>, f: F) -> F::Output {
    LOW.scope(flag, f).await
}

/// The current task runs background work now.
pub(crate) fn active() -> bool {
    LOW.try_with(|f| f.load(Ordering::Relaxed)).unwrap_or(false)
}

/// `IOPRIO_PRIO_VALUE(IOPRIO_CLASS_IDLE, 0)`.
#[cfg(target_os = "linux")]
const IOPRIO_IDLE: libc::c_long = 3 << 13;
/// `IOPRIO_WHO_PROCESS`: with 0, the calling thread.
#[cfg(target_os = "linux")]
const IOPRIO_WHO_PROCESS: libc::c_long = 1;

/// In a background child between fork and exec: a session of its own (Linux: a new autogroup, set
/// to nice 19), nice 19, the idle I/O class (Linux). Only async-signal-safe calls; failures leave
/// the child as it was (it still runs).
#[cfg(unix)]
pub(crate) fn lower_child() -> std::io::Result<()> {
    // SAFETY: setsid, setpriority, syscall, open, write and close are async-signal-safe; the path
    // is a static C string, nothing is allocated.
    unsafe {
        libc::setsid();
        libc::setpriority(libc::PRIO_PROCESS, 0, 19);
        #[cfg(target_os = "linux")]
        {
            libc::syscall(libc::SYS_ioprio_set, IOPRIO_WHO_PROCESS, 0 as libc::c_long, IOPRIO_IDLE);
            let fd = libc::open(c"/proc/self/autogroup".as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC);
            if fd >= 0 {
                libc::write(fd, b"19".as_ptr().cast(), 2);
                libc::close(fd);
            }
        }
    }
    Ok(())
}

/// The priority class Windows starts a background child in.
#[cfg(windows)]
pub(crate) const CHILD_CLASS: u32 = windows_sys::Win32::System::Threading::BELOW_NORMAL_PRIORITY_CLASS;

/// The calling thread below the agents' work, for good (its own thread: [`blocking`]).
fn lower_thread() {
    #[cfg(target_os = "linux")]
    // SAFETY: plain system calls on the calling thread (pid 0); `param` outlives the call. An
    // all-zero `sched_param` is valid (priority 0, the only one SCHED_IDLE takes); a struct literal
    // would not build on musl, whose `sched_param` has more fields than glibc's.
    unsafe {
        let param: libc::sched_param = std::mem::zeroed();
        libc::sched_setscheduler(0, libc::SCHED_IDLE, &param);
        libc::syscall(libc::SYS_ioprio_set, IOPRIO_WHO_PROCESS, 0 as libc::c_long, IOPRIO_IDLE);
    }
    #[cfg(target_os = "macos")]
    // SAFETY: sets the calling thread's QoS class; no memory is passed.
    unsafe {
        libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_BACKGROUND, 0);
    }
    #[cfg(windows)]
    // SAFETY: the pseudo handle of the calling thread needs no closing.
    unsafe {
        use windows_sys::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN};
        SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN);
    }
}

/// Runs `f` on a thread of its own below the agents' work (blocking work of a background scan);
/// `None` when no thread could be started or `f` panicked.
pub(crate) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name(THREAD.into())
        .spawn(move || {
            lower_thread();
            let _ = tx.send(f());
        })
        .ok()?;
    rx.await.ok()
}

/// [`blocking`] while the current task runs background work, else the runtime's blocking pool.
pub(crate) async fn blocking_if_low<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    if active() { blocking(f).await } else { tokio::task::spawn_blocking(f).await.ok() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_flag_follows_the_task_and_can_be_cleared_midway() {
        assert!(!active(), "outside a scope: normal priority");
        let flag = Arc::new(AtomicBool::new(true));
        scope(flag.clone(), async {
            assert!(active());
            flag.store(false, Ordering::Relaxed);
            assert!(!active(), "a Rescan took the scan over");
            let inner = tokio::spawn(scope(flag.clone(), async { active() })).await.unwrap();
            assert!(!inner, "a task it spawned with the same flag follows it");
        })
        .await;
        assert!(!active());
    }

    /// The walk thread runs at the lowest priority the OS has for it (Linux: SCHED_IDLE and the idle
    /// I/O class), and the caller's thread is left as it was.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn background_threads_are_lowered_and_named() {
        let policy = || unsafe { libc::sched_getscheduler(0) };
        let ioprio = || unsafe { libc::syscall(libc::SYS_ioprio_get, IOPRIO_WHO_PROCESS, 0 as libc::c_long) };
        let (before, io_before) = (policy(), ioprio());
        let (p, io, name) = blocking(move || (policy(), ioprio(), std::thread::current().name().map(str::to_string))).await.unwrap();
        assert_eq!((p, io, name.as_deref()), (libc::SCHED_IDLE, IOPRIO_IDLE, Some(THREAD)));
        assert_eq!((policy(), ioprio()), (before, io_before), "the caller's thread is unchanged");
    }

    /// A background child runs at nice 19 in a session of its own; the parent keeps its own.
    #[cfg(unix)]
    #[tokio::test]
    async fn background_children_start_low() {
        use std::os::unix::process::CommandExt;
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.args(["-c", "ps -o ni= -p $$; ps -o sid= -p $$"]);
        // SAFETY: lower_child only makes async-signal-safe calls.
        unsafe { cmd.pre_exec(lower_child) };
        let out = cmd.output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        let mut lines = text.lines().map(str::trim);
        let (nice, sid) = (lines.next(), lines.next());
        assert_eq!(nice, Some("19"), "{text}");
        assert_ne!(sid.and_then(|s| s.parse::<i32>().ok()), Some(unsafe { libc::getsid(0) }), "a session of its own");
    }
}
