//! Full-resolution originals of transcript images (`ImageRef.original`).
//!
//! omp downscales images it queues for the model (a prompt sent while it streams: ≤ 1568 px,
//! ~500 KB, often WebP) and persists only that copy. TeleFlock's prompts carry the original, so
//! tf-hostd keeps it under `<home>/originals/<sha256>.<ext>` (content-addressed, owner-only) and
//! the replica links it to the echoed row ([`tf_collab::replica::KeptOriginal`]). TUI pastes need
//! no copy: omp records the pasted file itself (absolute path or the session's `local://` root).
//!
//! The store is bounded ([`prune`], at daemon start and after each save): originals older than
//! [`MAX_AGE`] go, then the oldest until the rest fit [`MAX_BYTES`]. A link whose file was pruned
//! makes `session.image` fail with `not_found`; the viewer keeps omp's copy.
//!
//! `session.image` reads either kind back ([`resolve`], [`sniff_mime`]).

use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

use sha2::Digest as _;
use tf_collab::replica::KeptOriginal;
use tf_proto::methods::ImageInput;
use tf_proto::ApiError;

/// `<home>/originals`.
pub fn dir(home: &Path) -> PathBuf {
    home.join("originals")
}

/// Originals not sent (or re-sent) for this long are dropped.
pub const MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// Total size the store is kept under (the newest file always stays, even when bigger).
pub const MAX_BYTES: u64 = 1 << 30;

/// Stores each base64 image under its digest (kept if already there, its age reset), then prunes
/// the store. Blocking I/O. `None` when any image can't be decoded or written: then nothing is
/// linked (all slots or none line up).
pub fn store(dir: &Path, images: &[ImageInput]) -> Option<Vec<KeptOriginal>> {
    use base64::Engine as _;
    let mut kept = Vec::with_capacity(images.len());
    for ImageInput { mime, data } in images {
        let bytes = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
        let sha256 = hex(&sha2::Sha256::digest(&bytes));
        let ext = sniff_mime(&bytes).or(Some(mime.as_str())).and_then(extension).unwrap_or("img");
        let path = dir.join(format!("{sha256}.{ext}"));
        let written = match std::fs::File::options().append(true).open(&path) {
            // Sent again: young again, so pruning doesn't take it from under its new link.
            Ok(file) => file.set_modified(SystemTime::now()),
            Err(_) => std::fs::create_dir_all(dir).and_then(|()| crate::paths::write_atomic(&path, &bytes)),
        };
        if let Err(e) = written {
            tracing::warn!(path = %path.display(), "keep image original: {e}");
            return None;
        }
        kept.push(KeptOriginal { sha256, path: path.to_string_lossy().into_owned() });
    }
    prune(dir);
    Some(kept)
}

/// Applies [`prune_plan`] to the files in `dir`. Blocking I/O; errors are logged and skipped.
pub fn prune(dir: &Path) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    let entries = read
        .flatten()
        .filter_map(|e| {
            let meta = e.metadata().ok().filter(std::fs::Metadata::is_file)?;
            Some((e.path(), meta.modified().ok()?, meta.len()))
        })
        .collect();
    for path in prune_plan(entries, SystemTime::now(), MAX_AGE, MAX_BYTES) {
        if let Err(e) = std::fs::remove_file(&path) {
            tracing::warn!(path = %path.display(), "prune image original: {e}");
        }
    }
}

/// Which of `(path, mtime, size)` to delete: those older than `max_age`, then, newest first, every
/// file past the point where the total exceeds `cap`. The newest file is always kept (the one just
/// saved, even if alone bigger than `cap`: it goes at the next save).
pub fn prune_plan(mut entries: Vec<(PathBuf, SystemTime, u64)>, now: SystemTime, max_age: Duration, cap: u64) -> Vec<PathBuf> {
    entries.sort_by(|a, b| b.1.cmp(&a.1));
    let mut total = 0u64;
    let mut doomed = Vec::new();
    for (i, (path, mtime, size)) in entries.into_iter().enumerate() {
        let expired = now.duration_since(mtime).is_ok_and(|age| age > max_age);
        total = total.saturating_add(size);
        if expired || (i > 0 && total > cap) {
            doomed.push(path);
        }
    }
    doomed
}

/// The file behind an `ImageRef.original`: an absolute path, or `local://<rel>` inside the
/// session's local root (`<artifacts dir>/local/`, see omp's local protocol). Blocking I/O.
pub fn resolve(original: &str, omp_session: Option<&str>) -> Result<PathBuf, ApiError> {
    let Some(rel) = original.strip_prefix("local://") else {
        let path = PathBuf::from(original);
        return if path.is_absolute() { Ok(path) } else { Err(ApiError::new("invalid_params", "original must be an absolute path or a local:// URL")) };
    };
    let rel = Path::new(rel);
    if rel.as_os_str().is_empty() || !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(ApiError::new("invalid_params", "local:// original escapes the session's local root"));
    }
    let sid = omp_session.ok_or_else(|| ApiError::new("invalid_params", "a local:// original needs the agent's omp session"))?;
    let root = crate::ops::host::omp_agent_dir().join("sessions");
    let file = crate::artifacts::find_session_file(&root, sid)
        .ok_or_else(|| ApiError::new("not_found", format!("no session file for omp session {sid}")))?;
    Ok(crate::artifacts::artifacts_dir(&file).join("local").join(rel))
}

/// Image mime type from magic bytes; `None` for anything else (`session.image` serves images only).
pub fn sniff_mime(b: &[u8]) -> Option<&'static str> {
    Some(match b {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [0xFF, 0xD8, 0xFF, ..] => "image/jpeg",
        [b'G', b'I', b'F', b'8', ..] => "image/gif",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        [b'B', b'M', ..] => "image/bmp",
        [_, _, _, _, b'f', b't', b'y', b'p', b'a', b'v', b'i', b'f', ..] => "image/avif",
        _ => return None,
    })
}

fn extension(mime: &str) -> Option<&'static str> {
    Some(match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/avif" => "avif",
        _ => return None,
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_is_content_addressed() {
        use base64::Engine as _;
        let dir = tempfile::tempdir().unwrap();
        let png = [0x89, b'P', b'N', b'G', 1, 2, 3];
        let data = base64::engine::general_purpose::STANDARD.encode(png);
        let input = |mime: &str, data: &str| ImageInput { mime: mime.into(), data: data.into() };
        let kept = store(dir.path(), &[input("image/webp", &data), input("image/png", &data)]).unwrap();
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0], kept[1]);
        assert_eq!(kept[0].sha256, hex(&sha2::Sha256::digest(png)));
        // The sniffed format names the file, not the claimed mime.
        assert!(kept[0].path.ends_with(&format!("{}.png", kept[0].sha256)), "{}", kept[0].path);
        assert_eq!(std::fs::read(&kept[0].path).unwrap(), png);
        assert!(store(dir.path(), &[input("image/png", "not base64!")]).is_none());
    }

    #[test]
    fn resolve_paths() {
        assert_eq!(resolve("/tmp/a.png", None).unwrap(), PathBuf::from("/tmp/a.png"));
        assert_eq!(resolve("a.png", None).unwrap_err().code, "invalid_params");
        for bad in ["local://", "local://../x.png", "local:///etc/passwd", "local://a/../../x"] {
            assert_eq!(resolve(bad, Some("s")).unwrap_err().code, "invalid_params", "{bad}");
        }
        assert_eq!(resolve("local://pasted.png", None).unwrap_err().code, "invalid_params");
    }

    #[test]
    fn prune_plan_drops_old_then_oldest_over_cap() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(100 * 24 * 3600);
        let day = Duration::from_secs(24 * 3600);
        let e = |name: &str, days_old: u32, size: u64| (PathBuf::from(name), now - day * days_old, size);
        let plan = |entries, cap| {
            let mut p: Vec<String> = prune_plan(entries, now, MAX_AGE, cap).iter().map(|p| p.display().to_string()).collect();
            p.sort();
            p
        };
        // Age: 31 days goes, 29 stays.
        assert_eq!(plan(vec![e("new", 0, 1), e("29d", 29, 1), e("31d", 31, 1)], 100), ["31d"]);
        // Size: newest first until the cap is passed; everything older goes.
        assert_eq!(plan(vec![e("a", 1, 40), e("b", 2, 40), e("c", 3, 40), e("d", 4, 10)], 100), ["c", "d"]);
        // The newest stays even alone over the cap…
        assert_eq!(plan(vec![e("huge", 0, 500), e("old", 1, 1)], 100), ["old"]);
        // …until a newer save makes it one of the older ones.
        assert_eq!(plan(vec![e("next", 0, 1), e("huge", 1, 500)], 100), ["huge"]);
        assert!(plan(vec![], 100).is_empty());
    }

    #[test]
    fn prune_removes_planned_files() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.png");
        let kept = dir.path().join("new.png");
        std::fs::write(&old, b"x").unwrap();
        std::fs::write(&kept, b"y").unwrap();
        let file = std::fs::File::options().append(true).open(&old).unwrap();
        file.set_modified(SystemTime::now() - MAX_AGE - Duration::from_secs(60)).unwrap();
        prune(dir.path());
        assert!(!old.exists() && kept.exists());
    }

    #[test]
    fn sniffs_images_only() {
        assert_eq!(sniff_mime(b"\x89PNG\r\n\x1a\n"), Some("image/png"));
        assert_eq!(sniff_mime(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_mime(b"\xff\xd8\xff\xe0"), Some("image/jpeg"));
        assert_eq!(sniff_mime(b"#!/bin/sh"), None);
    }
}
