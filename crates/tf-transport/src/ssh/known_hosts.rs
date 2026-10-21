//! Host key pinning in an OpenSSH-format known_hosts file (`<host> <alg> <base64>`,
//! `[host]:port` for non-22 ports). A key seen for the first time is pinned only when the
//! caller's decision allows it. Hashed (`|1|`) and marker (`@cert-authority`, `@revoked`)
//! lines written by other tools are ignored.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use russh::keys::{HashAlg, PublicKey};

use crate::TransportError;

/// Serializes check-then-append across connections in this process.
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    /// The key matches a pinned entry.
    Known,
    /// No entry existed and the caller trusted the key; it has been pinned now.
    Learned,
    /// No entry existed and the caller did not trust the key; nothing was pinned.
    Unconfirmed,
    /// Entries exist for this host but none matches; fingerprints of the pinned keys.
    Mismatch(Vec<String>),
}

pub struct KnownHosts {
    path: PathBuf,
}

/// The known_hosts host field for `addr:port`.
pub fn host_pattern(addr: &str, port: u16) -> String {
    let addr = addr.trim_end_matches('.').to_ascii_lowercase();
    if port == 22 { addr } else { format!("[{addr}]:{port}") }
}

pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

fn store_err(path: &Path, e: impl std::fmt::Display) -> TransportError {
    TransportError::HostKeyStore(format!("{}: {e}", path.display()))
}

impl KnownHosts {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Keys pinned for `pattern`.
    fn pinned(&self, pattern: &str) -> Result<Vec<PublicKey>, TransportError> {
        let text = match std::fs::read_to_string(&self.path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(store_err(&self.path, e)),
        };
        let mut keys = Vec::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') || line.starts_with('@') || line.starts_with('|') {
                continue;
            }
            let mut parts = line.split_whitespace();
            let (Some(hosts), Some(alg), Some(b64)) = (parts.next(), parts.next(), parts.next()) else { continue };
            if !hosts.split(',').any(|h| h.eq_ignore_ascii_case(pattern)) {
                continue;
            }
            if let Ok(k) = PublicKey::from_openssh(&format!("{alg} {b64}")) {
                keys.push(k);
            }
        }
        Ok(keys)
    }

    /// Check `key` for `pattern`. For an unknown host, `trust()` decides whether the key
    /// is pinned now; a key differing from a pinned one never reaches it.
    pub fn verify(&self, pattern: &str, key: &PublicKey, trust: impl FnOnce() -> bool) -> Result<Verdict, TransportError> {
        let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let pinned = self.pinned(pattern)?;
        if pinned.iter().any(|k| k.key_data() == key.key_data()) {
            return Ok(Verdict::Known);
        }
        if !pinned.is_empty() {
            return Ok(Verdict::Mismatch(pinned.iter().map(fingerprint).collect()));
        }
        if !trust() {
            return Ok(Verdict::Unconfirmed);
        }
        let mut openssh = key.to_openssh().map_err(|e| store_err(&self.path, e))?;
        // Drop the comment: "<alg> <base64>".
        if let Some(i) = openssh.match_indices(' ').nth(1).map(|(i, _)| i) {
            openssh.truncate(i);
        }
        if let Some(dir) = self.path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir).map_err(|e| store_err(dir, e))?;
        }
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&self.path).map_err(|e| store_err(&self.path, e))?;
        writeln!(f, "{pattern} {openssh}").map_err(|e| store_err(&self.path, e))?;
        Ok(Verdict::Learned)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_A: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBCpq7hNsGh7iW9ZlUr7VsKEBSIzRifaa97MZnjo4cKh tf-test-a";
    const KEY_B: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJkHtd9p0d+q3Jv5uiExNwhT/1t/uSDYEnny2+8455XV tf-test-b";

    #[test]
    fn tofu_then_known_then_mismatch() {
        let dir = std::env::temp_dir().join(format!("tf-kh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let kh = KnownHosts::new(dir.join("sub/known_hosts"));
        let a = PublicKey::from_openssh(KEY_A).unwrap();
        let b = PublicKey::from_openssh(KEY_B).unwrap();
        let pat = host_pattern("Aron-Dev.", 2222);
        assert_eq!(pat, "[aron-dev]:2222");
        assert_eq!(kh.verify(&pat, &a, || true).unwrap(), Verdict::Learned);
        assert_eq!(kh.verify(&pat, &a, || panic!("known key must not ask")).unwrap(), Verdict::Known);
        // A changed key is a mismatch, whatever the policy would say.
        assert_eq!(kh.verify(&pat, &b, || panic!("mismatch must not ask")).unwrap(), Verdict::Mismatch(vec![fingerprint(&a)]));
        // Other hosts are independent; an untrusted key is not pinned.
        let other = host_pattern("203.0.113.7", 22);
        assert_eq!(kh.verify(&other, &b, || false).unwrap(), Verdict::Unconfirmed);
        assert_eq!(kh.verify(&other, &b, || false).unwrap(), Verdict::Unconfirmed);
        assert_eq!(kh.verify(&other, &b, || true).unwrap(), Verdict::Learned);
        let text = std::fs::read_to_string(kh.path()).unwrap();
        assert!(text.starts_with("[aron-dev]:2222 ssh-ed25519 AAAA"), "{text}");
        assert!(!text.contains("tf-test-a"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
