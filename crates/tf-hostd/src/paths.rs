//! Filesystem layout of a tf-hostd instance (architecture §3.1).
//!
//! `TF_HOSTD_HOME` overrides the default `~/.teleflock` (lab instances use `/tmp/...`).

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Paths {
    /// `~/.teleflock` (or `$TF_HOSTD_HOME`).
    pub home: PathBuf,
    /// `<home>/run`.
    pub run: PathBuf,
    /// Client socket `<home>/run/hostd.sock` (unix).
    pub sock: PathBuf,
    /// Client named pipe `\\.\pipe\teleflock-hostd-<user>[-<hash>]` (windows).
    pub pipe: String,
    /// Companion-extension socket `<home>/run/bridge.sock` (unix).
    pub bridge_sock: PathBuf,
    /// Companion-extension named pipe (windows).
    pub bridge_pipe: String,
    /// Bridge handshake secret `<home>/run/bridge.secret` (owner-only; rewritten at every start).
    pub bridge_secret: PathBuf,
    /// Single-instance lock `<home>/run/hostd.lock` (holds the pid).
    pub lock: PathBuf,
    /// Persistent state `<home>/state.json`.
    pub state_file: PathBuf,
    /// Log `<home>/hostd.log`.
    pub log: PathBuf,
    /// Companion extension `<home>/ext/teleflock-bridge.ts`.
    pub ext: PathBuf,
    /// Per-process collab overlay `<home>/omp-overlay.yml`.
    pub overlay: PathBuf,
    /// `<home>/bin`.
    pub bin: PathBuf,
    /// Automations and their run history `<home>/automations.json`.
    pub automations: PathBuf,
    /// Files uploaded for prompts (videos) `<home>/uploads/<yyyy-mm-dd>/<name>` (`ops::upload`).
    pub uploads: PathBuf,
    /// A home other than the default `~/.teleflock` (lab / dev instance). Derived from the path,
    /// not from whether `TF_HOSTD_HOME` is set: `attach` (run by the app without it) starts the
    /// daemon with `TF_HOSTD_HOME` = its home, and both must derive the same endpoints.
    pub custom: bool,
}

impl Paths {
    /// Resolves the home from `TF_HOSTD_HOME`, else `~/.teleflock`.
    pub fn from_env() -> Self {
        Self::resolve(std::env::var_os("TF_HOSTD_HOME").filter(|v| !v.is_empty()).map(PathBuf::from))
    }

    /// [`Paths::from_env`] for a given `TF_HOSTD_HOME` value.
    fn resolve(env_home: Option<PathBuf>) -> Self {
        let default = home_dir().join(".teleflock");
        match env_home {
            Some(home) => {
                let custom = !same_dir(&home, &default);
                Self::new(home, custom)
            }
            None => Self::new(default, false),
        }
    }

    /// `custom` homes get pipe names suffixed with a hash of the home so that lab
    /// instances never collide with the real daemon on Windows.
    pub fn new(home: PathBuf, custom: bool) -> Self {
        let run = home.join("run");
        let user = user_name();
        let suffix = if custom { format!("-{:08x}", fnv1a(home.to_string_lossy().as_bytes())) } else { String::new() };
        Self {
            sock: run.join("hostd.sock"),
            bridge_sock: run.join("bridge.sock"),
            bridge_secret: run.join("bridge.secret"),
            lock: run.join("hostd.lock"),
            pipe: format!(r"\\.\pipe\teleflock-hostd-{user}{suffix}"),
            bridge_pipe: format!(r"\\.\pipe\teleflock-bridge-{user}{suffix}"),
            state_file: home.join("state.json"),
            log: home.join("hostd.log"),
            ext: home.join("ext").join("teleflock-bridge.ts"),
            overlay: home.join("omp-overlay.yml"),
            bin: home.join("bin"),
            automations: home.join("automations.json"),
            uploads: home.join("uploads"),
            custom,
            run,
            home,
        }
    }

    /// Creates the home and `run/`. Unix: both are owner-only (0700), also when they already
    /// existed with looser modes (the state, log and sockets inside are private).
    pub fn ensure_dirs(&self) -> io::Result<()> {
        std::fs::create_dir_all(&self.run)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for dir in [&self.home, &self.run] {
                std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
            }
        }
        Ok(())
    }

    /// Display form of the client endpoint (socket path or pipe name).
    pub fn endpoint(&self) -> String {
        if cfg!(windows) { self.pipe.clone() } else { self.sock.display().to_string() }
    }

    /// Stem of this instance's systemd keepalive units: `teleflock-hostd-<hash of home>`
    /// (one pair per home, so lab instances never touch the real daemon's units).
    pub fn unit_stem(&self) -> String {
        format!("teleflock-hostd-{:08x}", fnv1a(self.home.to_string_lossy().as_bytes()))
    }

    /// The user's real daemon home (`~/.teleflock`), as opposed to a lab / dev home.
    pub fn is_default_home(&self) -> bool {
        same_dir(&self.home, &home_dir().join(".teleflock"))
    }
}

/// Whether two paths name the same directory (canonical when both exist, else literal).
fn same_dir(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// The user's home directory (`$HOME`, `%USERPROFILE%`).
pub fn home_dir() -> PathBuf {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

/// Expands a leading `~` / `~/`.
pub fn expand_tilde(p: &str) -> PathBuf {
    if p == "~" {
        home_dir()
    } else if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        home_dir().join(rest)
    } else {
        PathBuf::from(p)
    }
}

fn user_name() -> String {
    let raw = std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_else(|_| "user".into());
    raw.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

fn fnv1a(bytes: &[u8]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in bytes {
        h ^= u32::from(*b);
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// `OpenOptions` whose newly created files are owner-only (0600 on unix).
fn private_options() -> OpenOptions {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut o = OpenOptions::new();
        o.mode(0o600);
        o
    }
    #[cfg(not(unix))]
    {
        OpenOptions::new()
    }
}

/// Tightens an open file to owner-only (unix): the creation mode does not apply to files
/// that already existed.
fn restrict_open(file: &File) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = file;
    Ok(())
}

/// Tightens an existing file to owner-only (0600 on unix). Missing files are fine.
pub fn restrict_file(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Opens `path` for appending; owner-only (0600 on unix) whether created or pre-existing.
pub fn open_private_append(path: &Path) -> io::Result<File> {
    let file = private_options().create(true).append(true).open(path)?;
    restrict_open(&file)?;
    Ok(file)
}

/// Creates `path` (and missing parents) as owner-only directories (0700 on unix); an existing
/// `path` is tightened to 0700 too.
pub fn create_private_dir(path: &Path) -> io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Creates a new owner-only file (0600 on unix) for writing; fails if `path` exists.
pub fn create_private_new(path: &Path) -> io::Result<File> {
    let file = private_options().write(true).create_new(true).open(path)?;
    restrict_open(&file)?;
    Ok(file)
}

/// Writes `bytes` to `path` atomically (tmp file + rename); the result is owner-only (0600
/// on unix). Every call writes its own temp file (`.<name>.<pid>.<n>.tmp`), so concurrent
/// writers never interleave in one file; the last rename wins (callers that need ordering
/// serialize snapshot + write themselves).
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.{}.{n}.tmp", std::process::id()));
    let result = (|| {
        let mut file = private_options().write(true).create_new(true).open(&tmp)?;
        restrict_open(&file)?;
        file.write_all(bytes)?;
        drop(file);
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout() {
        let p = Paths::new(PathBuf::from("/tmp/x"), true);
        assert_eq!(p.sock, PathBuf::from("/tmp/x/run/hostd.sock"));
        assert_eq!(p.ext, PathBuf::from("/tmp/x/ext/teleflock-bridge.ts"));
        assert_eq!(p.uploads, PathBuf::from("/tmp/x/uploads"));
        assert!(p.pipe.starts_with(r"\\.\pipe\teleflock-hostd-"));
        assert_ne!(p.pipe, Paths::new(PathBuf::from("/tmp/y"), true).pipe);
    }

    #[test]
    fn attach_and_its_daemon_derive_the_same_endpoints() {
        // The app runs `tf-hostd attach` without TF_HOSTD_HOME; attach starts the daemon with
        // TF_HOSTD_HOME = its own home. Both must listen/connect on the same pipe and socket, or
        // attach never reaches the daemon (Windows Local hosts).
        let attach = Paths::resolve(None);
        let daemon = Paths::resolve(Some(attach.home.clone()));
        assert_eq!((&attach.pipe, &attach.bridge_pipe, &attach.sock), (&daemon.pipe, &daemon.bridge_pipe, &daemon.sock));
        assert!(!attach.custom && !daemon.custom && daemon.is_default_home());

        // A lab home: attach and daemon both see TF_HOSTD_HOME, both get the suffixed pipe.
        let lab_attach = Paths::resolve(Some(PathBuf::from("/tmp/tf-lab-x")));
        let lab_daemon = Paths::resolve(Some(lab_attach.home.clone()));
        assert_eq!(lab_attach.pipe, lab_daemon.pipe);
        assert!(lab_daemon.custom && !lab_daemon.is_default_home());
        assert_ne!(lab_daemon.pipe, daemon.pipe);
    }

    #[cfg(unix)]
    fn mode(p: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[cfg(unix)]
    fn chmod(p: &Path, m: u32) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn home_and_run_are_owner_only() {
        let td = tempfile::tempdir().unwrap();
        let fresh = Paths::new(td.path().join("fresh"), true);
        fresh.ensure_dirs().unwrap();
        assert_eq!((mode(&fresh.home), mode(&fresh.run)), (0o700, 0o700));
        // Pre-existing loose dirs are tightened.
        let old = Paths::new(td.path().join("old"), true);
        std::fs::create_dir_all(&old.run).unwrap();
        chmod(&old.home, 0o755);
        chmod(&old.run, 0o755);
        old.ensure_dirs().unwrap();
        assert_eq!((mode(&old.home), mode(&old.run)), (0o700, 0o700));
    }

    #[cfg(unix)]
    #[test]
    fn private_files_are_0600() {
        let td = tempfile::tempdir().unwrap();
        let state = td.path().join("state.json");
        write_atomic(&state, b"{}").unwrap();
        assert_eq!(mode(&state), 0o600);
        // Loose target and a stale loose tmp file: the replacement is still 0600.
        chmod(&state, 0o644);
        std::fs::write(state.with_extension("tmp"), b"stale").unwrap();
        chmod(&state.with_extension("tmp"), 0o666);
        write_atomic(&state, b"{\"v\":1}").unwrap();
        assert_eq!(mode(&state), 0o600);
        assert_eq!(std::fs::read(&state).unwrap(), b"{\"v\":1}");
        // Concurrent writers: each renames in a complete file of its own, no temp file left.
        let writers: Vec<_> = (0..8u8)
            .map(|i| {
                let state = state.clone();
                std::thread::spawn(move || {
                    for _ in 0..50 {
                        write_atomic(&state, &vec![b'a' + i; 4096]).unwrap();
                    }
                })
            })
            .collect();
        writers.into_iter().for_each(|w| w.join().unwrap());
        let body = std::fs::read(&state).unwrap();
        assert!(body.len() == 4096 && body.iter().all(|b| *b == body[0]), "a mixed file was renamed in");
        let leftovers: Vec<_> = std::fs::read_dir(td.path()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".tmp") && e.file_name() != "state.tmp").collect();
        assert!(leftovers.is_empty());

        let log = td.path().join("hostd.log");
        drop(open_private_append(&log).unwrap());
        assert_eq!(mode(&log), 0o600);
        chmod(&log, 0o644);
        drop(open_private_append(&log).unwrap());
        assert_eq!(mode(&log), 0o600);

        let loose = td.path().join("loose");
        std::fs::write(&loose, b"x").unwrap();
        chmod(&loose, 0o644);
        restrict_file(&loose).unwrap();
        assert_eq!(mode(&loose), 0o600);
        restrict_file(&td.path().join("missing")).unwrap();
    }
}
