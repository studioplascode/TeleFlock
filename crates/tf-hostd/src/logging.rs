//! `hostd.log`: tracing to a size-rolled file (`hostd.log` → `hostd.log.1` at 8 MiB), owner-only
//! (0600 on unix).

use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const MAX_BYTES: u64 = 8 * 1024 * 1024;

struct Rolling {
    path: PathBuf,
    file: File,
    size: u64,
}

impl Rolling {
    fn open(path: &Path) -> io::Result<Self> {
        let file = crate::paths::open_private_append(path)?;
        crate::paths::restrict_file(&rolled(path))?;
        let size = file.metadata()?.len();
        Ok(Self { path: path.to_path_buf(), file, size })
    }

    fn roll(&mut self) -> io::Result<()> {
        let old = rolled(&self.path);
        let _ = std::fs::remove_file(&old);
        std::fs::rename(&self.path, &old)?;
        self.file = crate::paths::open_private_append(&self.path)?;
        self.size = 0;
        Ok(())
    }
}

fn rolled(path: &Path) -> PathBuf {
    path.with_extension("log.1")
}

#[derive(Clone)]
struct Writer(Arc<Mutex<Rolling>>);

impl Write for Writer {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut r = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if r.size + buf.len() as u64 > MAX_BYTES {
            let _ = r.roll();
        }
        let n = r.file.write(buf)?;
        r.size += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).file.flush()
    }
}

/// Logs to `path` (daemon). Level from `TF_HOSTD_LOG` (default `info`).
pub fn init_file(path: &Path) -> io::Result<()> {
    let rolling = Arc::new(Mutex::new(Rolling::open(path)?));
    let writer = Writer(rolling);
    let filter = tracing_subscriber::EnvFilter::try_from_env("TF_HOSTD_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(false)
        .with_target(true)
        .with_writer(move || writer.clone())
        .try_init();
    Ok(())
}

/// Logs to stderr (foreground commands; `attach` must keep stdout clean).
pub fn init_stderr() {
    let filter = tracing_subscriber::EnvFilter::try_from_env("TF_HOSTD_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).with_writer(io::stderr).try_init();
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn mode(p: &Path) -> u32 {
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn log_files_are_owner_only() {
        let td = tempfile::tempdir().unwrap();
        let log = td.path().join("hostd.log");
        // A pre-existing world-readable log and rolled log are tightened on open.
        std::fs::write(&log, b"old\n").unwrap();
        std::fs::write(rolled(&log), b"older\n").unwrap();
        for p in [&log, &rolled(&log)] {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        let mut r = Rolling::open(&log).unwrap();
        assert_eq!((mode(&log), mode(&rolled(&log)), r.size), (0o600, 0o600, 4));
        r.roll().unwrap();
        assert_eq!((mode(&log), mode(&rolled(&log))), (0o600, 0o600));
        assert_eq!(std::fs::read(rolled(&log)).unwrap(), b"old\n");
    }
}
