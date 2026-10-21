//! HTTP for the self-updater: the GitHub releases API and verified downloads.
// The checksum/download half serves the Android install path only.
#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use std::{path::Path, sync::Arc, time::Duration};

use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use super::release::{self, Release};

const API_TIMEOUT: Duration = Duration::from_secs(20);

/// rustls on ring with the Mozilla roots (webpki-roots): identical on Windows and Android, where
/// the platform verifier would need JNI initialisation first.
pub fn client(user_agent: &str) -> Result<reqwest::Client, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
    let tls = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS setup failed: {e}"))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .user_agent(user_agent)
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client setup failed: {e}"))
}

fn describe(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "GitHub did not answer in time".into()
    } else if e.is_connect() {
        "couldn't reach GitHub (offline?)".into()
    } else {
        // Drop the URL: it is long and says nothing the message doesn't.
        e.without_url().to_string()
    }
}

/// Non-draft and draft releases as GitHub lists them (newest first).
pub async fn releases(client: &reqwest::Client) -> Result<Vec<Release>, String> {
    let res = client
        .get(release::releases_url())
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(describe)?;
    let status = res.status();
    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("GitHub rate limit reached; try again later".into());
    }
    if !status.is_success() {
        return Err(format!("GitHub answered {status}"));
    }
    let body = res.bytes().await.map_err(describe)?;
    serde_json::from_slice(&body).map_err(|e| format!("unexpected GitHub response: {e}"))
}

/// Expected SHA-256 (lowercase hex) from a release's `<asset>.sha256` file.
pub async fn sha256_of(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let res = client.get(url).timeout(API_TIMEOUT).send().await.map_err(describe)?;
    if !res.status().is_success() {
        return Err(format!("checksum download failed: {}", res.status()));
    }
    let text = res.text().await.map_err(describe)?;
    release::parse_sha256(&text).ok_or_else(|| "the release's checksum file is malformed".into())
}

/// SHA-256 of a file (lowercase hex), or `None` when it can't be read.
pub async fn file_sha256(path: &Path) -> Option<String> {
    let path = path.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let mut f = std::fs::File::open(path).ok()?;
        let mut h = Sha256::new();
        std::io::copy(&mut f, &mut h).ok()?;
        Some(hex(&h.finalize()))
    })
    .await
    .ok()
    .flatten()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Downloads `url` to `dest` and checks it against `sha256`. A file already at `dest` with the
/// right hash is kept (no second download after a permission round trip or an app restart);
/// every other file in `dest`'s directory is removed (older or partial updates).
/// `progress(done, total)` follows the download.
pub async fn download_verified(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    sha256: &str,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<(), String> {
    let dir = dest.parent().ok_or("bad download path")?;
    tokio::fs::create_dir_all(dir).await.map_err(|e| format!("can't create {}: {e}", dir.display()))?;
    if file_sha256(dest).await.as_deref() == Some(sha256) {
        log::info!("update: reusing verified {}", dest.display());
        return Ok(());
    }
    if let Ok(mut entries) = tokio::fs::read_dir(dir).await {
        while let Ok(Some(e)) = entries.next_entry().await {
            let _ = tokio::fs::remove_file(e.path()).await;
        }
    }

    let mut res = client.get(url).send().await.map_err(describe)?;
    if !res.status().is_success() {
        return Err(format!("download failed: {}", res.status()));
    }
    let total = res.content_length();
    let part = dest.with_extension("part");
    let mut file = tokio::fs::File::create(&part).await.map_err(|e| format!("can't write {}: {e}", part.display()))?;
    let mut hasher = Sha256::new();
    let mut done = 0u64;
    progress(0, total);
    while let Some(chunk) = res.chunk().await.map_err(describe)? {
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| format!("can't write the download: {e}"))?;
        done += chunk.len() as u64;
        progress(done, total);
    }
    file.flush().await.map_err(|e| format!("can't write the download: {e}"))?;
    drop(file);
    let got = hex(&hasher.finalize());
    if got != sha256 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(format!("the download is corrupt (SHA-256 {got}, expected {sha256})"));
    }
    tokio::fs::rename(&part, dest).await.map_err(|e| format!("can't store the download: {e}"))?;
    Ok(())
}
