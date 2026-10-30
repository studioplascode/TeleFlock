//! Test support: executable scripts that can be started right after they were written.
//!
//! `std::fs::write` + `chmod` + spawn races with every other thread of the process that spawns
//! a child meanwhile: the child inherits the still-open write descriptor between `fork` and
//! `exec`, and for as long as it holds it, executing the script fails with `ETXTBSY` ("Text
//! file busy"). Test binaries run their tests on many threads, most of them spawning. Here the
//! script is written under a temporary name, and renamed into place once nothing holds it open
//! for writing any more, so a later spawn finds it ready (and so does one that replaces a
//! script an earlier spawn of the same test used).

use std::path::Path;

/// Writes `body` to `path` with `mode` (`0o755`: executable), creating its directory.
pub fn write(path: &Path, body: impl AsRef<[u8]>, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).unwrap();
    let tmp = dir.join(format!(".{}.writing", path.file_name().unwrap().to_string_lossy()));
    std::fs::write(&tmp, body).unwrap();
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(mode)).unwrap();
    until_unwritten(&tmp);
    std::fs::rename(&tmp, path).unwrap();
}

/// [`write`] with mode `0o755`.
pub fn write_exe(path: &Path, body: impl AsRef<[u8]>) {
    write(path, body, 0o755);
}

/// Waits until no process holds `path` open for writing (a forked child that has not reached
/// its `exec` yet does): taking a read lease fails while one does, and it is the very check
/// `execve` makes. Where leases are unavailable there is nothing to wait for.
#[cfg(target_os = "linux")]
fn until_unwritten(path: &Path) {
    use std::os::fd::AsRawFd;
    let file = std::fs::File::open(path).unwrap();
    let fd = file.as_raw_fd();
    for _ in 0..10_000 {
        // SAFETY: `fd` is open for the whole loop; these calls only set and clear a lease on it.
        if unsafe { libc::fcntl(fd, libc::F_SETLEASE, libc::F_RDLCK) } == 0 {
            unsafe { libc::fcntl(fd, libc::F_SETLEASE, libc::F_UNLCK) };
            return;
        }
        if std::io::Error::last_os_error().raw_os_error() != Some(libc::EAGAIN) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    panic!("{} is still open for writing after 10 s", path.display());
}

#[cfg(not(target_os = "linux"))]
fn until_unwritten(_: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_script_is_ready_when_written() {
        let td = tempfile::tempdir().unwrap();
        let path = td.path().join("bin/tool");
        write_exe(&path, "#!/bin/sh\necho one\n");
        assert_eq!(std::process::Command::new(&path).output().unwrap().stdout, b"one\n");
        // Replaced under the name a spawn used before, with nothing left behind.
        write_exe(&path, "#!/bin/sh\necho two\n");
        assert_eq!(std::process::Command::new(&path).output().unwrap().stdout, b"two\n");
        assert_eq!(std::fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }

    /// Other threads that spawn all the time (every test binary has them) do not make a script
    /// busy right after it was written: with a plain `std::fs::write`, some of these 400 spawns
    /// fail with `ETXTBSY` (os error 26).
    #[test]
    fn spawning_threads_do_not_make_a_fresh_script_busy() {
        use std::sync::atomic::{AtomicBool, Ordering};
        /// Stops the spawning threads however the test ends (the scope waits for them).
        struct Stop<'a>(&'a AtomicBool);
        impl Drop for Stop<'_> {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Relaxed);
            }
        }
        let stop = AtomicBool::new(false);
        let td = tempfile::tempdir().unwrap();
        std::thread::scope(|s| {
            let _stop = Stop(&stop);
            for _ in 0..6 {
                s.spawn(|| {
                    while !stop.load(Ordering::Relaxed) {
                        let _ = std::process::Command::new("true").status();
                    }
                });
            }
            for i in 0..400 {
                let path = td.path().join(format!("script{i}"));
                write_exe(&path, "#!/bin/sh\nexit 0\n");
                let status = std::process::Command::new(&path).status().unwrap_or_else(|e| panic!("run {i}: {e}"));
                assert!(status.success());
            }
        });
    }
}
