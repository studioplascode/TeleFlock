//! `hostd.log`: tracing to a size-rolled file (`hostd.log` → `hostd.log.1` at 8 MiB).

use std::fs::{File, OpenOptions};
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
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        let size = file.metadata()?.len();
        Ok(Self { path: path.to_path_buf(), file, size })
    }

    fn roll(&mut self) -> io::Result<()> {
        let old = self.path.with_extension("log.1");
        let _ = std::fs::remove_file(&old);
        std::fs::rename(&self.path, &old)?;
        self.file = OpenOptions::new().create(true).append(true).open(&self.path)?;
        self.size = 0;
        Ok(())
    }
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
