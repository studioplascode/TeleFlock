//! Filesystem layout of a tf-hostd instance (architecture §3.1).
//!
//! `TF_HOSTD_HOME` overrides the default `~/.teleflock` (lab instances use `/tmp/...`).

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
}

impl Paths {
    /// Resolves the home from `TF_HOSTD_HOME`, else `~/.teleflock`.
    pub fn from_env() -> Self {
        match std::env::var_os("TF_HOSTD_HOME").filter(|v| !v.is_empty()) {
            Some(h) => Self::new(PathBuf::from(h), true),
            None => Self::new(home_dir().join(".teleflock"), false),
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
            lock: run.join("hostd.lock"),
            pipe: format!(r"\\.\pipe\teleflock-hostd-{user}{suffix}"),
            bridge_pipe: format!(r"\\.\pipe\teleflock-bridge-{user}{suffix}"),
            state_file: home.join("state.json"),
            log: home.join("hostd.log"),
            ext: home.join("ext").join("teleflock-bridge.ts"),
            overlay: home.join("omp-overlay.yml"),
            bin: home.join("bin"),
            run,
            home,
        }
    }

    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.run)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.run, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    /// Display form of the client endpoint (socket path or pipe name).
    pub fn endpoint(&self) -> String {
        if cfg!(windows) { self.pipe.clone() } else { self.sock.display().to_string() }
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

/// Writes `bytes` to `path` atomically (tmp file + rename).
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout() {
        let p = Paths::new(PathBuf::from("/tmp/x"), true);
        assert_eq!(p.sock, PathBuf::from("/tmp/x/run/hostd.sock"));
        assert_eq!(p.ext, PathBuf::from("/tmp/x/ext/teleflock-bridge.ts"));
        assert!(p.pipe.starts_with(r"\\.\pipe\teleflock-hostd-"));
        assert_ne!(p.pipe, Paths::new(PathBuf::from("/tmp/y"), true).pipe);
    }
}
