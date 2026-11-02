//! The browser's files on this device: where downloads go, files staged for a page's file chooser
//! (`browser.stageFile`), showing a download in the file manager (`browser.revealDownload`), and
//! clearing cookies or the cache while the browser is not running.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use tf_proto::{ApiError, b64_len};

use crate::util::{invalid, io_err, rand_id};

/// Largest staged file (decoded).
pub(super) const STAGE_MAX: u64 = 32 * 1024 * 1024;

/// Where downloads go: the user's downloads folder, like any browser's (`~/Downloads` when the
/// system names none), else `<data_dir>/browser/downloads`.
pub(super) fn download_dir(browser_dir: &Path) -> PathBuf {
    #[cfg(not(target_os = "android"))]
    if let Some(d) = dirs::download_dir().or_else(|| dirs::home_dir().map(|h| h.join("Downloads"))) {
        return d;
    }
    browser_dir.join("downloads")
}

/// A file name the user's file system takes: the last path component, without control and
/// reserved characters, at most 120 characters; `file` when nothing is left.
pub(super) fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = base.chars().filter(|c| !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')).take(120).collect();
    let cleaned = cleaned.trim().trim_end_matches('.').to_string();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." || tf_proto::is_windows_device_name(&cleaned) { "file".into() } else { cleaned }
}

/// `browser.stageFile`: writes the file to `<staged>/<random>/<name>` (owner-only on Unix) and
/// returns its path.
pub(super) async fn stage(staged: &Path, name: &str, data: &str) -> Result<PathBuf, ApiError> {
    if b64_len(data) > STAGE_MAX {
        return Err(invalid(format!("{name} is larger than {} MiB", STAGE_MAX / (1024 * 1024))));
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(|_| invalid("the file is not base64"))?;
    let dir = staged.join(rand_id("f"));
    tokio::fs::create_dir_all(&dir).await.map_err(|e| io_err("staging the file", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(staged, std::fs::Permissions::from_mode(0o700));
    }
    let path = dir.join(safe_name(name));
    tokio::fs::write(&path, bytes).await.map_err(|e| io_err("staging the file", e))?;
    Ok(path)
}

/// The path of a download the UI names, when it is under `download_dir`.
pub(super) fn download_path(download_dir: &Path, path: &str) -> Result<PathBuf, ApiError> {
    let not_download = || invalid("that is not a download of the TeleFlock Browser");
    let dir = std::fs::canonicalize(download_dir).map_err(|_| not_download())?;
    let p = std::fs::canonicalize(path).map_err(|_| ApiError::new("not_found", "the file is not there any more"))?;
    if p.starts_with(&dir) && p != dir { Ok(p) } else { Err(not_download()) }
}

/// Shows `path` in the system's file manager (selected where the file manager can do that).
pub(super) fn reveal(path: &Path) -> Result<(), ApiError> {
    let spawned = {
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open").arg("-R").arg(path).spawn()
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("explorer").raw_arg(format!("/select,\"{}\"", path.display())).spawn()
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            std::process::Command::new("xdg-open").arg(path.parent().unwrap_or(path)).spawn()
        }
    };
    spawned.map(drop).map_err(|e| ApiError::new("unsupported", format!("can't open the file manager: {e}")))
}

/// Removes files of a profile that is not in use: cookies, or the caches.
pub(super) fn remove_profile_files(profile: &Path, cookies: bool) {
    let default = profile.join("Default");
    let names: &[&str] = if cookies {
        &["Network/Cookies", "Network/Cookies-journal", "Cookies", "Cookies-journal"]
    } else {
        &["Cache", "Code Cache", "GPUCache", "Service Worker/CacheStorage", "Service Worker/ScriptCache"]
    };
    for n in names {
        let p = default.join(n);
        let _ = if p.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staged_names() {
        assert_eq!(safe_name("report.pdf"), "report.pdf");
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name(r"C:\Users\ada\cv.docx"), "cv.docx");
        assert_eq!(safe_name("a<b>c:d\"e|f?g*h\u{7}.txt"), "abcdefgh.txt");
        assert_eq!(safe_name(".."), "file");
        assert_eq!(safe_name("CON.txt"), "file");
        assert_eq!(safe_name("   "), "file");
    }

    #[tokio::test]
    async fn stage_and_downloads() {
        let td = tempfile::tempdir().unwrap();
        let staged = td.path().join("staged");
        let p = stage(&staged, "../hello.txt", "aGVsbG8=").await.unwrap();
        assert!(p.starts_with(&staged) && p.ends_with("hello.txt"), "{}", p.display());
        assert_eq!(std::fs::read(&p).unwrap(), b"hello");
        assert_eq!(stage(&staged, "x", "%%%").await.unwrap_err().code, "invalid_params");
        let big = "A".repeat(((STAGE_MAX + 3) / 3 * 4 + 8) as usize);
        assert!(stage(&staged, "big", &big).await.unwrap_err().message.contains("larger than 32 MiB"));

        let downloads = td.path().join("Downloads");
        std::fs::create_dir_all(&downloads).unwrap();
        std::fs::write(downloads.join("a.zip"), "").unwrap();
        assert!(download_path(&downloads, downloads.join("a.zip").to_str().unwrap()).is_ok());
        assert_eq!(download_path(&downloads, p.to_str().unwrap()).unwrap_err().code, "invalid_params", "only downloads");
        let sneaky = downloads.join("../staged");
        assert_eq!(download_path(&downloads, sneaky.to_str().unwrap()).unwrap_err().code, "invalid_params");
        assert_eq!(download_path(&downloads, downloads.join("gone.zip").to_str().unwrap()).unwrap_err().code, "not_found");
    }
}
