//! Chrome for Testing, TeleFlock's own browser, downloaded with the user's consent
//! (`browser.installEngine`; `browser.cancelInstall` stops it) for a device without a
//! Chromium-family browser or whose organization blocks remote control of the one it has: the build
//! this app pins (version, SHA-256 and size per platform) from Google's Chrome for Testing bucket,
//! checked, then unpacked to `<data_dir>/browser/engine/<version>/chrome-<platform>/`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

pub(super) const VERSION: &str = "156.0.8078.80";

struct Pin {
    /// Chrome for Testing's platform name.
    platform: &'static str,
    sha256: &'static str,
    size: u64,
}

/// `(std::env::consts::OS, ARCH)` → the build for it.
const PINS: [(&str, &str, Pin); 5] = [
    ("linux", "x86_64", Pin { platform: "linux64", sha256: "b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7", size: 201_329_937 }),
    ("linux", "aarch64", Pin { platform: "linux-arm64", sha256: "1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724", size: 200_722_708 }),
    ("macos", "aarch64", Pin { platform: "mac-arm64", sha256: "8bc590d1b1acac042a000234c768f31830f25a3983a83ed5e067114c87c4cad1", size: 195_027_080 }),
    ("macos", "x86_64", Pin { platform: "mac-x64", sha256: "672b79dc79fdf28bb2ec9787b7fa33810c2b3cfd946a0fb4d3b72775f4e6fd9a", size: 205_782_188 }),
    ("windows", "x86_64", Pin { platform: "win64", sha256: "16edb57d6107bf1c48a7c149b8d78b155fe614410093796dd72441fd6640540f", size: 208_152_768 }),
];

fn pin() -> Option<&'static Pin> {
    PINS.iter().find(|(os, arch, _)| *os == std::env::consts::OS && *arch == std::env::consts::ARCH).map(|(_, _, p)| p)
}

/// A build exists for this device's OS and CPU.
pub(super) fn available() -> bool {
    pin().is_some()
}

/// The download's size in bytes.
pub(super) fn size() -> Option<u64> {
    pin().map(|p| p.size)
}

/// The program inside an unpacked build, relative to the version directory.
fn exe(platform: &str) -> PathBuf {
    let dir = PathBuf::from(format!("chrome-{platform}"));
    match platform {
        "win64" => dir.join("chrome.exe"),
        p if p.starts_with("mac") => dir.join("Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
        _ => dir.join("chrome"),
    }
}

/// Where the pinned build's program is once it is unpacked under `engine_dir`.
pub(super) fn program(engine_dir: &Path) -> Option<PathBuf> {
    Some(engine_dir.join(VERSION).join(exe(pin()?.platform)))
}

/// The pinned build, when it is unpacked under `engine_dir`.
pub(super) fn installed(engine_dir: &Path) -> Option<PathBuf> {
    program(engine_dir).filter(|p| p.is_file())
}

/// rustls on ring with the webpki roots, like the app's updater.
fn client() -> Result<reqwest::Client, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
    let tls = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS setup failed: {e}"))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .user_agent(concat!("TeleFlock/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("HTTP client setup failed: {e}"))
}

fn describe(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "the download stalled".into()
    } else if e.is_connect() {
        "can't reach storage.googleapis.com (offline?)".into()
    } else {
        e.without_url().to_string()
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Resolves once `cancel` is set (checked every 100 ms).
async fn canceled(cancel: &AtomicBool) {
    while !cancel.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Downloads, checks and unpacks the pinned build; `progress` gets 0–100 (the download is 0–95,
/// unpacking the rest). Returns the program's path. Earlier versions and leftovers go. Setting
/// `cancel` stops it (a stalled download too), and nothing of it is kept.
pub(super) async fn install(engine_dir: &Path, cancel: &AtomicBool, mut progress: impl FnMut(u8)) -> Result<PathBuf, String> {
    const CANCELED: &str = "the download was canceled";
    let pin = pin().ok_or("Chrome for Testing has no build for this device")?;
    if let Some(exe) = installed(engine_dir) {
        return Ok(exe);
    }
    tokio::fs::create_dir_all(engine_dir).await.map_err(|e| format!("can't create {}: {e}", engine_dir.display()))?;
    let url = format!("https://storage.googleapis.com/chrome-for-testing-public/{VERSION}/{p}/chrome-{p}.zip", p = pin.platform);
    let zip = engine_dir.join(format!("chrome-{}-{VERSION}.zip", pin.platform));
    let part = zip.with_extension("part");
    let client = client()?;
    let mut res = tokio::select! {
        r = client.get(&url).send() => r.map_err(describe)?,
        () = canceled(cancel) => return Err(CANCELED.into()),
    };
    if !res.status().is_success() {
        return Err(format!("the download failed: {}", res.status()));
    }
    let mut file = tokio::fs::File::create(&part).await.map_err(|e| format!("can't write {}: {e}", part.display()))?;
    let (mut hasher, mut done, mut shown) = (Sha256::new(), 0u64, 0u8);
    progress(0);
    let written: Result<(), String> = async {
        loop {
            let chunk = tokio::select! {
                c = res.chunk() => c.map_err(describe)?,
                () = canceled(cancel) => return Err(CANCELED.into()),
            };
            let Some(chunk) = chunk else { break };
            done += chunk.len() as u64;
            if done > pin.size {
                return Err("the download is larger than the pinned build".into());
            }
            hasher.update(&chunk);
            file.write_all(&chunk).await.map_err(|e| format!("can't write the download: {e}"))?;
            let pct = (done * 95 / pin.size) as u8;
            if pct != shown {
                shown = pct;
                progress(pct);
            }
        }
        file.flush().await.map_err(|e| format!("can't write the download: {e}"))
    }
    .await;
    drop(file);
    let got = hex(&hasher.finalize());
    let checked = written.and_then(|()| match (done == pin.size, got == pin.sha256) {
        (true, true) => Ok(()),
        (false, _) => Err(format!("the download is incomplete ({done} of {} bytes)", pin.size)),
        (true, false) => Err(format!("the download is corrupt (SHA-256 {got}, expected {})", pin.sha256)),
    });
    if let Err(e) = checked {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(e);
    }
    if cancel.load(Ordering::Acquire) {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(CANCELED.into());
    }
    tokio::fs::rename(&part, &zip).await.map_err(|e| format!("can't store the download: {e}"))?;
    let unpack = engine_dir.join(format!(".unpack-{VERSION}"));
    let (z, u) = (zip.clone(), unpack.clone());
    let unpacked = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let _ = std::fs::remove_dir_all(&u);
        let f = std::fs::File::open(&z).map_err(|e| format!("can't open the download: {e}"))?;
        let mut archive = zip::ZipArchive::new(f).map_err(|e| format!("the download is not a zip: {e}"))?;
        archive.extract(&u).map_err(|e| format!("can't unpack the download: {e}"))
    })
    .await
    .map_err(|e| format!("unpacking failed: {e}"))?;
    let _ = tokio::fs::remove_file(&zip).await;
    if let Err(e) = unpacked {
        let _ = tokio::fs::remove_dir_all(&unpack).await;
        return Err(e);
    }
    if cancel.load(Ordering::Acquire) {
        let _ = tokio::fs::remove_dir_all(&unpack).await;
        return Err(CANCELED.into());
    }
    let dest = engine_dir.join(VERSION);
    let _ = tokio::fs::remove_dir_all(&dest).await;
    tokio::fs::rename(&unpack, &dest).await.map_err(|e| format!("can't store the browser: {e}"))?;
    // Earlier pinned versions and leftovers of interrupted downloads.
    if let Ok(mut entries) = tokio::fs::read_dir(engine_dir).await {
        while let Ok(Some(e)) = entries.next_entry().await {
            if e.file_name() != VERSION {
                let p = e.path();
                let _ = if p.is_dir() { tokio::fs::remove_dir_all(&p).await } else { tokio::fs::remove_file(&p).await };
            }
        }
    }
    progress(100);
    installed(engine_dir).ok_or_else(|| format!("the download has no {}", exe(pin.platform).display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_builds() {
        for (_, _, p) in &PINS {
            assert_eq!(p.sha256.len(), 64, "{}", p.platform);
            assert!(p.size > 100_000_000, "{}", p.platform);
        }
        assert_eq!(exe("linux64"), PathBuf::from("chrome-linux64/chrome"));
        assert_eq!(exe("win64"), PathBuf::from("chrome-win64/chrome.exe"));
        assert_eq!(exe("mac-arm64"), PathBuf::from("chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"));
        let td = tempfile::tempdir().unwrap();
        assert_eq!(installed(td.path()), None);
        if let Some(p) = pin() {
            let e = td.path().join(VERSION).join(exe(p.platform));
            std::fs::create_dir_all(e.parent().unwrap()).unwrap();
            std::fs::write(&e, "").unwrap();
            assert_eq!(installed(td.path()), Some(e));
        }
    }
}
