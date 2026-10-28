//! Sign-in secrets of SSH hosts using password or key sign-in ([`HostProfile::auth`]).
//!
//! One file, `data_dir/secrets.json`, keyed by host id: owner-only (0600 on Unix, written that
//! way from the start; on Windows and Android the app data dir is already per user / per app).
//! Secrets never go into `hosts.json`, results, events, logs or the state cache; `hosts.save`
//! writes them, `hosts.secretStatus` reports which exist, `hosts.remove` deletes them.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use tf_proto::{ApiError, HostKind, HostProfile, HostSecrets, SecretStatus, SshAuth};

use crate::util::{io_err, write_private};

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct SecretsFile {
    hosts: BTreeMap<String, HostSecrets>,
}

pub(crate) struct SecretStore {
    path: PathBuf,
    /// Serializes read-modify-write cycles.
    lock: tokio::sync::Mutex<()>,
}

impl SecretStore {
    pub fn new(data_dir: &Path) -> Self {
        Self { path: data_dir.join("secrets.json"), lock: tokio::sync::Mutex::new(()) }
    }

    async fn read(&self) -> Result<SecretsFile, ApiError> {
        match tokio::fs::read(&self.path).await {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| ApiError::new("io_error", format!("parse {}: {e}", self.path.display()))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SecretsFile::default()),
            Err(e) => Err(io_err(&format!("read {}", self.path.display()), e)),
        }
    }

    /// The host's saved secrets (empty when there are none).
    pub async fn get(&self, host_id: &str) -> Result<HostSecrets, ApiError> {
        Ok(self.read().await?.hosts.remove(host_id).unwrap_or_default())
    }

    /// Replaces the host's saved secrets; empty secrets forget the host (and the file goes once
    /// no host has any).
    pub async fn put(&self, host_id: &str, secrets: HostSecrets) -> Result<(), ApiError> {
        let _g = self.lock.lock().await;
        let mut file = self.read().await?;
        let before = file.hosts.get(host_id).cloned().unwrap_or_default();
        if before == secrets {
            return Ok(());
        }
        if secrets == HostSecrets::default() {
            file.hosts.remove(host_id);
        } else {
            file.hosts.insert(host_id.to_string(), secrets);
        }
        let what = |verb: &str| format!("{verb} {}", self.path.display());
        if file.hosts.is_empty() {
            return match tokio::fs::remove_file(&self.path).await {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(io_err(&what("remove"), e)),
                _ => Ok(()),
            };
        }
        let bytes = serde_json::to_vec(&file).map_err(|e| ApiError::new("internal", e.to_string()))?;
        let path = self.path.clone();
        tokio::task::spawn_blocking(move || write_private(&path, &bytes))
            .await
            .map_err(|e| ApiError::new("internal", e.to_string()))?
            .map_err(|e| io_err(&what("write"), e))
    }
}

/// How `profile` signs in (`tailscale` for every kind but `tailscaleSsh`).
pub(crate) fn method(profile: &HostProfile) -> SshAuth {
    match profile.kind {
        HostKind::TailscaleSsh => profile.auth.unwrap_or(SshAuth::Tailscale),
        _ => SshAuth::Tailscale,
    }
}

/// `update` applied over `saved` (per field: absent = keep, empty = delete, text = replace), then
/// only what `profile`'s sign-in uses: the password, or the saved key (when no key file is
/// named) and its passphrase.
pub(crate) fn merged(saved: HostSecrets, update: Option<HostSecrets>, profile: &HostProfile) -> HostSecrets {
    let pick = |old: Option<String>, new: Option<String>| match new {
        None => old,
        Some(s) if s.is_empty() => None,
        Some(s) => Some(s),
    };
    let mut s = match update {
        None => saved,
        Some(u) => HostSecrets {
            password: pick(saved.password, u.password),
            private_key: pick(saved.private_key, u.private_key),
            passphrase: pick(saved.passphrase, u.passphrase),
        },
    };
    match method(profile) {
        SshAuth::Tailscale => s = HostSecrets::default(),
        SshAuth::Password => {
            s.private_key = None;
            s.passphrase = None;
        }
        SshAuth::Key => {
            s.password = None;
            if profile.key_path.is_some() {
                s.private_key = None;
            }
        }
    }
    s
}

pub(crate) fn status(s: &HostSecrets) -> SecretStatus {
    SecretStatus { password: s.password.is_some(), private_key: s.private_key.is_some(), passphrase: s.passphrase.is_some() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(auth: Option<SshAuth>, key_path: Option<&str>) -> HostProfile {
        serde_json::from_value(serde_json::json!({
            "id": "h1", "name": "box", "kind": "tailscaleSsh", "address": "box", "user": "me",
            "auth": auth, "keyPath": key_path, "herdrSession": "default", "autoConnect": false
        }))
        .unwrap()
    }

    fn secrets(password: Option<&str>, private_key: Option<&str>, passphrase: Option<&str>) -> HostSecrets {
        HostSecrets { password: password.map(Into::into), private_key: private_key.map(Into::into), passphrase: passphrase.map(Into::into) }
    }

    #[test]
    fn updates_keep_replace_or_delete_and_follow_the_method() {
        let saved = secrets(Some("pw"), None, None);
        let password = profile(Some(SshAuth::Password), None);
        // Absent keeps, text replaces, empty deletes.
        assert_eq!(merged(saved.clone(), None, &password), saved);
        assert_eq!(merged(saved.clone(), Some(HostSecrets::default()), &password), saved);
        assert_eq!(merged(saved.clone(), Some(secrets(Some("new"), None, None)), &password), secrets(Some("new"), None, None));
        assert_eq!(merged(saved.clone(), Some(secrets(Some(""), None, None)), &password), HostSecrets::default());

        // Only what the method uses is kept.
        let both = secrets(Some("pw"), Some("KEY"), Some("pass"));
        assert_eq!(merged(both.clone(), None, &password), secrets(Some("pw"), None, None));
        assert_eq!(merged(both.clone(), None, &profile(Some(SshAuth::Key), None)), secrets(None, Some("KEY"), Some("pass")));
        assert_eq!(merged(both.clone(), None, &profile(Some(SshAuth::Key), Some("~/.ssh/id_ed25519"))), secrets(None, None, Some("pass")));
        assert_eq!(merged(both.clone(), None, &profile(None, None)), HostSecrets::default());
        let mut local = profile(Some(SshAuth::Password), None);
        local.kind = HostKind::Local;
        assert_eq!(merged(both, None, &local), HostSecrets::default());
    }

    #[test]
    fn redacted_in_debug_output() {
        let s = format!("{:?}", secrets(Some("hunter2"), Some("-----BEGIN"), None));
        assert!(!s.contains("hunter2") && !s.contains("BEGIN"), "{s}");
        assert!(s.contains("<redacted>"));
    }

    #[tokio::test]
    async fn store_is_owner_only_and_forgets_hosts() {
        let dir = tempfile::tempdir().unwrap();
        let store = SecretStore::new(dir.path());
        let path = dir.path().join("secrets.json");
        assert_eq!(store.get("h1").await.unwrap(), HostSecrets::default());

        store.put("h1", secrets(Some("pw"), None, None)).await.unwrap();
        store.put("h2", secrets(None, Some("KEY"), Some("pass"))).await.unwrap();
        assert_eq!(store.get("h1").await.unwrap(), secrets(Some("pw"), None, None));
        assert_eq!(status(&store.get("h2").await.unwrap()), SecretStatus { password: false, private_key: true, passphrase: true });
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }

        store.put("h1", HostSecrets::default()).await.unwrap();
        assert_eq!(store.get("h1").await.unwrap(), HostSecrets::default());
        assert!(path.exists());
        store.put("h2", HostSecrets::default()).await.unwrap();
        assert!(!path.exists(), "the file goes with the last host");
    }
}
