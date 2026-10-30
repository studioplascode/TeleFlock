//! The images of a first turn omp has not saved yet. Until omp writes the session file (with the
//! first reply) the prompt an agent was given, images included, lives only in hostd's replica and
//! in omp's memory; an agent that ends in that turn comes back as a new session with its prompt
//! given again, and the images are part of that prompt. omp's own copy of them (a blob in its
//! content-addressed store nothing references yet) may be collected before then, so the ledger
//! keeps its own: `<home>/ledger-images/<sha256>.img`, owner-only, content-addressed, bounded
//! ([`MAX_IMAGES`], [`MAX_IMAGE_BYTES`], [`MAX_TOTAL_BYTES`]) and swept when no ledger entry
//! names the file any more ([`sweep`]).
//!
//! A first turn whose images cannot be kept in full (too many, too big, unreadable) is never
//! replayed as text alone by itself: the entry says so (`images_lost`) and its card waits for
//! Continue.

use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::Digest as _;

use tf_proto::methods::ImageInput;
use tf_proto::session::ImageRef;

pub const DIR: &str = "ledger-images";
/// Most images of one first turn.
pub const MAX_IMAGES: usize = 16;
/// Largest single image.
pub const MAX_IMAGE_BYTES: usize = 16 << 20;
/// Most bytes of one first turn.
pub const MAX_TOTAL_BYTES: u64 = 64 << 20;
/// A file no entry names is removed once it is this old (an entry that will name it may not be
/// written yet).
const SWEEP_AGE: Duration = Duration::from_secs(10 * 60);

/// One image the ledger keeps: its mime type and the file under [`DIR`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Kept {
    pub mime: String,
    /// `<sha256 hex>.img`.
    pub file: String,
}

/// `<home>/ledger-images`.
pub fn dir(home: &Path) -> PathBuf {
    home.join(DIR)
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

/// The file name of `bytes` under [`DIR`].
fn name_of(bytes: &[u8]) -> String {
    format!("{}.img", hex(&sha2::Sha256::digest(bytes)))
}

/// A name [`name_of`] made (nothing else is ever read or removed through a ledger entry).
fn is_kept_name(name: &str) -> bool {
    name.strip_suffix(".img").is_some_and(|h| h.len() == 64 && h.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')))
}

/// Keeps `bytes` (a file already there is kept and made young again). The mime type kept is the
/// one the bytes themselves say (`originals::sniff_mime`); `mime` (what the row that carried them
/// said: often the resized copy's, which is not always the original's format) only stands when the
/// bytes are of no known image format. Blocking I/O.
pub fn keep(home: &Path, mime: &str, bytes: &[u8]) -> io::Result<Kept> {
    if bytes.is_empty() {
        return Err(io::Error::other("the image is empty"));
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(io::Error::other(format!("an image of {} MiB is over the {} MiB kept", bytes.len() >> 20, MAX_IMAGE_BYTES >> 20)));
    }
    let dir = dir(home);
    let file = name_of(bytes);
    let path = dir.join(&file);
    let same = std::fs::metadata(&path).is_ok_and(|m| m.len() == bytes.len() as u64);
    if same {
        // Young again, so a sweep never takes it from under the entry that names it now.
        if let Ok(f) = std::fs::File::options().append(true).open(&path) {
            let _ = f.set_modified(SystemTime::now());
        }
    } else {
        crate::paths::create_private_dir(&dir)?;
        crate::paths::write_atomic(&path, bytes)?;
    }
    let mime = crate::originals::sniff_mime(bytes).unwrap_or(mime);
    Ok(Kept { mime: mime.to_string(), file })
}

/// Reads a kept image back as a prompt image. The file must be the one named: a truncated or
/// altered file is an error, never sent.
pub fn load(home: &Path, k: &Kept) -> Result<ImageInput, String> {
    if !is_kept_name(&k.file) {
        return Err(format!("`{}` is not a kept image", k.file));
    }
    let bytes = std::fs::read(dir(home).join(&k.file)).map_err(|e| format!("reading kept image {}: {e}", k.file))?;
    if name_of(&bytes) != k.file {
        return Err(format!("kept image {} is damaged", k.file));
    }
    Ok(ImageInput { mime: k.mime.clone(), data: base64::engine::general_purpose::STANDARD.encode(bytes) })
}

/// Every image of `kept` as prompt images; the first that cannot be read fails the lot (never a
/// partial set).
pub fn load_all(home: &Path, kept: &[Kept]) -> Result<Vec<ImageInput>, String> {
    kept.iter().map(|k| load(home, k)).collect()
}

/// Whether `kept` fits one first turn's bounds.
pub fn check_total(home: &Path, kept: &[Kept]) -> Result<(), String> {
    if kept.len() > MAX_IMAGES {
        return Err(format!("{} images are more than the {MAX_IMAGES} kept for a first prompt", kept.len()));
    }
    let mut total = 0u64;
    for k in kept {
        if !is_kept_name(&k.file) {
            return Err(format!("`{}` is not a kept image", k.file));
        }
        total += std::fs::metadata(dir(home).join(&k.file)).map_err(|e| format!("kept image {} is gone: {e}", k.file))?.len();
    }
    if total > MAX_TOTAL_BYTES {
        return Err(format!("the images of the first prompt are {} MiB, over the {} MiB kept", total >> 20, MAX_TOTAL_BYTES >> 20));
    }
    Ok(())
}

/// Keeps images a launch was given (base64), all or an error. Blocking I/O.
pub fn keep_inputs(home: &Path, images: &[ImageInput]) -> Result<Vec<Kept>, String> {
    let kept = images
        .iter()
        .map(|i| {
            let bytes = base64::engine::general_purpose::STANDARD.decode(i.data.trim()).map_err(|e| format!("an image is not valid base64: {e}"))?;
            keep(home, &i.mime, &bytes).map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<_>, String>>()?;
    check_total(home, &kept)?;
    Ok(kept)
}

/// The bytes behind a transcript image: its full-resolution original, else the payload it
/// carries, else omp's blob. Blocking I/O.
fn bytes_of(r: &ImageRef, omp_session: Option<&str>) -> Result<Vec<u8>, String> {
    let mut why = Vec::new();
    if let Some(original) = &r.original {
        match crate::originals::resolve(original, omp_session).map_err(|e| e.message).and_then(|p| std::fs::read(&p).map_err(|e| format!("{}: {e}", p.display()))) {
            Ok(b) => return Ok(b),
            Err(e) => why.push(format!("original: {e}")),
        }
    }
    if let Some(data) = &r.data {
        match base64::engine::general_purpose::STANDARD.decode(data.trim()) {
            Ok(b) => return Ok(b),
            Err(e) => why.push(format!("inline data: {e}")),
        }
    }
    if let Some(blob) = r.blob.as_deref().filter(|b| b.len() == 64 && b.bytes().all(|c| c.is_ascii_hexdigit())) {
        let path = crate::ops::host::omp_agent_dir().join("blobs").join(blob.to_ascii_lowercase());
        match std::fs::read(&path) {
            Ok(b) => return Ok(b),
            Err(e) => why.push(format!("blob: {e}")),
        }
    }
    Err(if why.is_empty() { "the image has no payload yet".to_string() } else { why.join("; ") })
}

/// Keeps the images of transcript rows. All or an error: a first turn is never kept with some of
/// its images missing. Blocking I/O.
pub fn keep_refs(home: &Path, refs: &[ImageRef], omp_session: Option<&str>) -> Result<Vec<Kept>, String> {
    if refs.len() > MAX_IMAGES {
        return Err(format!("{} images are more than the {MAX_IMAGES} kept for a first prompt", refs.len()));
    }
    let kept = refs
        .iter()
        .map(|r| {
            let bytes = bytes_of(r, omp_session)?;
            keep(home, &r.mime, &bytes).map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<_>, String>>()?;
    check_total(home, &kept)?;
    Ok(kept)
}

/// Removes the files no entry names (`referenced`: file names) that are older than [`SWEEP_AGE`].
/// Blocking I/O; returns how many went.
pub fn sweep(home: &Path, referenced: &HashSet<String>) -> usize {
    sweep_older_than(home, referenced, SWEEP_AGE)
}

fn sweep_older_than(home: &Path, referenced: &HashSet<String>, min_age: Duration) -> usize {
    let Ok(rd) = std::fs::read_dir(dir(home)) else { return 0 };
    let mut removed = 0;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !is_kept_name(&name) || referenced.contains(&name) {
            continue;
        }
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age >= min_age);
        if old && std::fs::remove_file(e.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(n: u8) -> Vec<u8> {
        let mut b = vec![0x89, b'P', b'N', b'G'];
        b.extend(std::iter::repeat_n(n, 64));
        b
    }

    fn iref(data: Option<String>) -> ImageRef {
        ImageRef { mime: "image/png".into(), data, url: None, blob: None, original: None, width: None, height: None }
    }

    #[test]
    fn an_image_is_kept_owner_only_and_comes_back_whole() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = png(1);
        let k = keep(dir.path(), "image/png", &bytes).unwrap();
        assert!(is_kept_name(&k.file), "{k:?}");
        assert_eq!(keep(dir.path(), "image/png", &bytes).unwrap(), k, "content-addressed: the same image is one file");
        let back = load(dir.path(), &k).unwrap();
        assert_eq!(back.mime, "image/png");
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(back.data).unwrap(), bytes);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&super::dir(dir.path())), 0o700);
            assert_eq!(mode(&super::dir(dir.path()).join(&k.file)), 0o600);
        }
    }

    #[test]
    fn the_mime_kept_is_the_one_of_the_bytes_not_of_the_row_that_carried_them() {
        let dir = tempfile::tempdir().unwrap();
        let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
        // A row shows omp's downscaled JPEG; its original (what is kept) is a PNG.
        let original = tmp_png(dir.path());
        let row = ImageRef { mime: "image/jpeg".into(), data: Some(b64(b"\xFF\xD8\xFFthumb")), url: None, blob: None, original: Some(original.display().to_string()), width: None, height: None };
        let k = keep_refs(dir.path(), &[row], None).unwrap();
        assert_eq!(k[0].mime, "image/png", "the original's bytes are PNG");
        assert_eq!(load(dir.path(), &k[0]).unwrap().mime, "image/png");
        // Inline JPEG bytes labelled PNG; bytes of no known format keep the row's label.
        let jpeg = ImageRef { mime: "image/png".into(), data: Some(b64(b"\xFF\xD8\xFFdata")), url: None, blob: None, original: None, width: None, height: None };
        assert_eq!(keep_refs(dir.path(), &[jpeg], None).unwrap()[0].mime, "image/jpeg");
        let unknown = ImageRef { mime: "image/x-odd".into(), data: Some(b64(b"???? odd")), url: None, blob: None, original: None, width: None, height: None };
        assert_eq!(keep_refs(dir.path(), &[unknown], None).unwrap()[0].mime, "image/x-odd");
    }

    fn tmp_png(dir: &Path) -> PathBuf {
        let p = dir.join("original.png");
        std::fs::write(&p, png(9)).unwrap();
        p
    }

    #[test]
    fn a_damaged_or_foreign_file_is_never_sent() {
        let dir = tempfile::tempdir().unwrap();
        let k = keep(dir.path(), "image/png", &png(2)).unwrap();
        std::fs::write(super::dir(dir.path()).join(&k.file), b"torn").unwrap();
        assert!(load(dir.path(), &k).unwrap_err().contains("damaged"));
        let other = Kept { mime: "image/png".into(), file: "../../etc/passwd".into() };
        assert!(load(dir.path(), &other).unwrap_err().contains("not a kept image"));
        assert!(load_all(dir.path(), &[k.clone(), other]).is_err(), "all or nothing");
        let gone = Kept { mime: "image/png".into(), file: format!("{}.img", "0".repeat(64)) };
        assert!(load(dir.path(), &gone).is_err());
    }

    #[test]
    fn what_cannot_be_kept_in_full_fails_instead_of_keeping_a_part() {
        let dir = tempfile::tempdir().unwrap();
        assert!(keep(dir.path(), "image/png", &[]).is_err());
        assert!(keep(dir.path(), "image/png", &vec![7u8; MAX_IMAGE_BYTES + 1]).is_err());
        let many: Vec<ImageRef> = (0..=MAX_IMAGES as u8).map(|n| iref(Some(base64::engine::general_purpose::STANDARD.encode(png(n))))).collect();
        assert!(keep_refs(dir.path(), &many, None).unwrap_err().contains("more than"));
        let given: Vec<ImageInput> = (0..=MAX_IMAGES as u8).map(|n| ImageInput { mime: "image/png".into(), data: base64::engine::general_purpose::STANDARD.encode(png(n)) }).collect();
        assert!(keep_inputs(dir.path(), &given).unwrap_err().contains("more than"));
        let one = keep_inputs(dir.path(), &given[..1]).unwrap();
        assert_eq!(load(dir.path(), &one[0]).unwrap().mime, "image/png");
        assert!(keep_inputs(dir.path(), &[ImageInput { mime: "image/png".into(), data: "!!".into() }]).is_err());
        // A transcript image with no payload (cut from a frame, its blob not written yet).
        let empty = iref(None);
        assert!(keep_refs(dir.path(), &[empty], None).unwrap_err().contains("no payload"));
        // One that has its bytes inline is kept.
        let inline = iref(Some(base64::engine::general_purpose::STANDARD.encode(png(3))));
        let k = keep_refs(dir.path(), &[inline], None).unwrap();
        assert_eq!(load(dir.path(), &k[0]).unwrap().mime, "image/png");
    }

    #[test]
    fn only_files_no_entry_names_and_old_enough_are_swept() {
        let dir = tempfile::tempdir().unwrap();
        let named = keep(dir.path(), "image/png", &png(4)).unwrap();
        let orphan = keep(dir.path(), "image/png", &png(5)).unwrap();
        let stranger = super::dir(dir.path()).join("notes.txt");
        std::fs::write(&stranger, "mine").unwrap();
        let refs: HashSet<String> = [named.file.clone()].into();
        assert_eq!(sweep(dir.path(), &refs), 0, "a young orphan may belong to an entry not written yet");
        assert_eq!(sweep_older_than(dir.path(), &refs, Duration::ZERO), 1);
        assert!(super::dir(dir.path()).join(&named.file).exists());
        assert!(!super::dir(dir.path()).join(&orphan.file).exists());
        assert!(stranger.exists(), "only files the ledger made");
    }
}
