//! `upload.*`: files sent to the host in chunks for a prompt (videos; architecture §3.12).
//!
//! A video is far larger than one request may carry, so it travels in chunks and lands as a file
//! the agent reads with its own tools (omp's `read` makes a contact sheet of a video, or one frame
//! with a `:412` / `:1m30s` selector). Files go to `<home>/uploads/<yyyy-mm-dd>/<name>`: owner-only,
//! never inside a repo or worktree. The name is the client's, [`sanitize`]d and made unique within
//! the day; `upload.begin` reserves it and answers the absolute path.
//!
//! While an upload runs its bytes go to `<home>/uploads/.partial/<uploadId>.part`. Chunks must
//! arrive in order (each `offset` = the bytes received so far; out-of-order, repeated and
//! overflowing chunks are refused), so the SHA-256 is computed as they arrive and `upload.finish`
//! only checks and renames. `upload.status` tells a client where to resume after a lost response
//! or a reconnect. Limits: [`MAX_FILE`] per file, [`MAX_CHUNK`] per chunk, [`MAX_ACTIVE`] uploads at
//! once. An upload without a chunk for [`IDLE`] is dropped with its partial file; partial files of an
//! earlier daemon run are deleted at start ([`start`]). Finished uploads are pruned like image
//! originals: after [`MAX_AGE`], then the oldest above [`MAX_TOTAL`] (the newest always stays).

use std::collections::HashMap;
use std::fs::File;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError, TryLockError};
use std::time::{Duration, Instant, SystemTime};

use serde_json::Value;
use sha2::{Digest as _, Sha256};
use tf_proto::{ApiError, Empty, HostMethod, UploadBegun, UploadFinished, UploadProgress};
use tokio_util::sync::CancellationToken;

use crate::clients::ClientHandle;
use crate::ops::fs::io_error;
use crate::ops::{to_value, Ctx};
use crate::paths::{create_private_dir, create_private_new, Paths};

/// Largest file: 2 GiB.
pub const MAX_FILE: u64 = 2 << 30;
/// Largest chunk (raw bytes): small enough to cross a slow phone link well inside the app's 30 s
/// request timeout, and to let other requests through between chunks.
pub const MAX_CHUNK: usize = 1 << 20;
/// Uploads running at once (each holds a partial file of up to [`MAX_FILE`]).
pub const MAX_ACTIVE: usize = 8;
/// An upload without a chunk for this long is abandoned.
pub const IDLE: Duration = Duration::from_secs(60 * 60);
/// Finished uploads older than this are deleted.
pub const MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// Finished uploads are kept under this total (oldest first out; the newest file always stays).
pub const MAX_TOTAL: u64 = 10 << 30;
/// How long a finished upload's id still answers (a retried `finish`, a late `cancel`).
const FINISHED_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const SWEEP_EVERY: Duration = Duration::from_secs(5 * 60);
/// Partial files, under the uploads root (dot dirs are never pruned as day folders).
const PARTIAL: &str = ".partial";
/// Characters kept of a name before its extension.
const MAX_STEM: usize = 64;

pub async fn handle(ctx: &Ctx, req: HostMethod, _client: &ClientHandle) -> Result<Value, ApiError> {
    use HostMethod as M;
    let uploads = registry(&ctx.paths).clone();
    match req {
        M::UploadBegin(p) => to_value(blocking(move || uploads.begin(&p.name, p.size, p.mime.as_deref())).await?),
        M::UploadChunk(p) => to_value(blocking(move || uploads.chunk(&p.upload_id, p.offset, &decode(&p.data)?)).await?),
        M::UploadStatus(r) => to_value(blocking(move || uploads.status(&r.upload_id)).await?),
        M::UploadFinish(p) => to_value(blocking(move || uploads.finish(&p.upload_id, p.sha256.as_deref())).await?),
        M::UploadCancel(r) => {
            blocking(move || {
                uploads.cancel(&r.upload_id);
                Ok(())
            })
            .await?;
            to_value(Empty {})
        }
        other => Err(ApiError::new("unknown_method", format!("{} is not an upload method", other.name()))),
    }
}

static REGISTRY: OnceLock<Uploads> = OnceLock::new();

/// The daemon's uploads (one per process: its home never changes).
fn registry(paths: &Paths) -> &'static Uploads {
    REGISTRY.get_or_init(|| Uploads::new(paths.uploads.clone()))
}

/// Called by the first session context ([`Ctx::create`]): deletes the partial files an earlier
/// daemon run left, prunes old uploads, then drops idle uploads every 5 min until `cancel`.
pub fn start(paths: &Paths, cancel: CancellationToken) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let uploads = registry(paths).clone();
    tokio::spawn(async move {
        let u = uploads.clone();
        let _ = tokio::task::spawn_blocking(move || u.clean_start()).await;
        let mut tick = tokio::time::interval(SWEEP_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await;
        loop {
            tokio::select! {
                () = cancel.cancelled() => break,
                _ = tick.tick() => {
                    let u = uploads.clone();
                    let _ = tokio::task::spawn_blocking(move || u.sweep(Instant::now())).await;
                }
            }
        }
    });
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, ApiError> + Send + 'static) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(f).await.map_err(|e| ApiError::new("internal", format!("upload task: {e}")))?
}

/// A chunk's base64 payload; longer than a [`MAX_CHUNK`] could encode to is refused undecoded.
fn decode(data: &str) -> Result<Vec<u8>, ApiError> {
    use base64::Engine as _;
    if data.len() > MAX_CHUNK.div_ceil(3) * 4 {
        return Err(too_big_chunk(data.len() / 4 * 3));
    }
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| ApiError::new("invalid_params", format!("chunk data is not base64: {e}")))
}

/// Uploads under one root (`<home>/uploads`). Blocking I/O: call from `spawn_blocking`.
///
/// Locks: the registry briefly; one upload's lock for the whole of a chunk write, so chunks, status,
/// finish and cancel of one upload run one at a time. Order: an upload's lock before the registry's.
#[derive(Clone)]
pub struct Uploads(Arc<Inner>);

struct Inner {
    root: PathBuf,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    active: HashMap<String, Slot>,
    finished: HashMap<String, Done>,
}

struct Slot {
    /// Where the file goes once finished (reserved: no other upload picks the name).
    path: PathBuf,
    upload: Arc<Mutex<Active>>,
}

struct Active {
    part: PathBuf,
    size: u64,
    received: u64,
    /// `None` once the upload ended (finished, cancelled, failed or abandoned).
    file: Option<File>,
    hasher: Sha256,
    touched: Instant,
}

struct Done {
    result: UploadFinished,
    at: Instant,
}

impl Uploads {
    pub fn new(root: PathBuf) -> Self {
        let root = std::path::absolute(&root).unwrap_or(root);
        Self(Arc::new(Inner { root, state: Mutex::default() }))
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.0.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn slot(&self, id: &str) -> Result<(PathBuf, Arc<Mutex<Active>>), ApiError> {
        let st = self.state();
        st.active.get(id).map(|s| (s.path.clone(), s.upload.clone())).ok_or_else(|| gone(id))
    }

    fn finished(&self, id: &str) -> Option<UploadFinished> {
        self.state().finished.get(id).map(|d| d.result.clone())
    }

    /// Reserves `<root>/<today>/<sanitized name>` and opens the partial file.
    pub fn begin(&self, name: &str, size: u64, mime: Option<&str>) -> Result<UploadBegun, ApiError> {
        let shown = crate::util::clip(name, 80);
        if size == 0 {
            return Err(ApiError::new("invalid_params", format!("{shown} is empty")));
        }
        if size > MAX_FILE {
            return Err(ApiError::new(
                "invalid_params",
                format!("{shown} is {:.1} GiB; a file can be at most {} GiB", size as f64 / f64::from(1u32 << 30), MAX_FILE >> 30),
            ));
        }
        let file_name = sanitize(name, mime);
        let day = self.0.root.join(crate::util::local_day(crate::util::now_ms()));
        let partials = self.0.root.join(PARTIAL);
        for dir in [&self.0.root, &day, &partials] {
            create_private_dir(dir).map_err(|e| io_error(e, dir))?;
        }
        let mut st = self.state();
        if st.active.len() >= MAX_ACTIVE {
            return Err(ApiError::new("busy", format!("{MAX_ACTIVE} uploads are already running on this host"))
                .with_hint("Wait for one to finish")
                .retryable());
        }
        let path = unique_path(&day, &file_name, |p| st.active.values().any(|s| s.path == p));
        let id = new_upload_id();
        let part = partials.join(format!("{id}.part"));
        let file = create_private_new(&part).map_err(|e| io_error(e, &part))?;
        let upload = Active { part, size, received: 0, file: Some(file), hasher: Sha256::new(), touched: Instant::now() };
        st.active.insert(id.clone(), Slot { path: path.clone(), upload: Arc::new(Mutex::new(upload)) });
        tracing::info!(upload = %id, path = %path.display(), size, "upload started");
        Ok(UploadBegun { upload_id: id, path: path.to_string_lossy().into_owned(), max_chunk: MAX_CHUNK as u32 })
    }

    /// Appends `bytes` at `offset`, which must be the bytes received so far. A failed write ends the
    /// upload (its partial file is deleted).
    pub fn chunk(&self, id: &str, offset: u64, bytes: &[u8]) -> Result<UploadProgress, ApiError> {
        if bytes.is_empty() || bytes.len() > MAX_CHUNK {
            return Err(too_big_chunk(bytes.len()));
        }
        let (_, slot) = self.slot(id)?;
        let mut up = lock(&slot);
        if up.file.is_none() {
            return Err(gone(id));
        }
        if offset != up.received {
            return Err(ApiError::new("upload_offset", format!("upload {id} is at byte {}, not {offset}", up.received))
                .with_hint("Ask upload.status where it stands and continue from there"));
        }
        let end = offset + bytes.len() as u64;
        if end > up.size {
            return Err(ApiError::new("invalid_params", format!("the chunk ends at byte {end}, past the file's {} bytes", up.size)));
        }
        let written = up.file.as_mut().map_or(Ok(()), |f| f.write_all(bytes));
        if let Err(e) = written {
            let err = io_error(e, &up.part);
            self.end(id, &mut up);
            tracing::warn!(upload = %id, "upload failed: {}", err.message);
            return Err(err);
        }
        up.hasher.update(bytes);
        up.received = end;
        up.touched = Instant::now();
        Ok(UploadProgress { upload_id: id.to_string(), received: end, size: up.size })
    }

    pub fn status(&self, id: &str) -> Result<UploadProgress, ApiError> {
        let complete = |done: UploadFinished| UploadProgress { upload_id: id.to_string(), received: done.size, size: done.size };
        if let Some(done) = self.finished(id) {
            return Ok(complete(done));
        }
        let (_, slot) = self.slot(id)?;
        let up = lock(&slot);
        if up.file.is_none() {
            // It ended while this waited for it: finished, or gone.
            return self.finished(id).map(complete).ok_or_else(|| gone(id));
        }
        Ok(UploadProgress { upload_id: id.to_string(), received: up.received, size: up.size })
    }

    /// Checks the size (and `sha256` when given) and moves the file into place. A retried finish
    /// answers the same result.
    pub fn finish(&self, id: &str, sha256: Option<&str>) -> Result<UploadFinished, ApiError> {
        if let Some(done) = self.finished(id) {
            return Ok(done);
        }
        let (reserved, slot) = self.slot(id)?;
        let mut up = lock(&slot);
        if up.file.is_none() {
            return self.finished(id).ok_or_else(|| gone(id));
        }
        if up.received != up.size {
            return Err(ApiError::new("invalid_params", format!("upload {id} has {} of its {} bytes", up.received, up.size)));
        }
        let digest = hex(&up.hasher.clone().finalize());
        if let Some(want) = sha256.filter(|w| !w.eq_ignore_ascii_case(&digest)) {
            self.end(id, &mut up);
            return Err(ApiError::new("checksum_mismatch", format!("upload {id}: the host received bytes with SHA-256 {digest}, not {want}"))
                .with_hint("Upload the file again"));
        }
        // Closed before the rename (Windows can't move an open file).
        up.file = None;
        let mut st = self.state();
        // The reserved name, unless a file appeared there meanwhile; its day folder may have been
        // pruned while it was empty.
        let dir = reserved.parent().map(Path::to_path_buf).unwrap_or_else(|| self.0.root.clone());
        let path = match reserved.file_name() {
            Some(name) if std::fs::symlink_metadata(&reserved).is_ok() => {
                unique_path(&dir, &name.to_string_lossy(), |p| st.active.values().any(|s| s.path == p))
            }
            _ => reserved,
        };
        let moved = create_private_dir(&dir).and_then(|()| std::fs::rename(&up.part, &path));
        if let Err(e) = moved {
            drop(st);
            let err = io_error(e, &path);
            self.end(id, &mut up);
            tracing::warn!(upload = %id, "upload failed: {}", err.message);
            return Err(err);
        }
        st.active.remove(id);
        let result = UploadFinished { path: path.to_string_lossy().into_owned(), size: up.size, sha256: digest };
        st.finished.insert(id.to_string(), Done { result: result.clone(), at: Instant::now() });
        drop(st);
        drop(up);
        tracing::info!(upload = %id, path = %result.path, size = result.size, "upload finished");
        self.prune();
        Ok(result)
    }

    /// Drops an upload: a running one with its partial file, a finished one with its file (its
    /// prompt was never sent). Unknown ids are fine (already gone).
    pub fn cancel(&self, id: &str) {
        let forget_finished = || {
            if let Some(done) = self.state().finished.remove(id) {
                remove_quietly(Path::new(&done.result.path));
                tracing::info!(upload = %id, "finished upload deleted");
            }
        };
        let Ok((_, slot)) = self.slot(id) else {
            forget_finished();
            return;
        };
        let mut up = lock(&slot);
        if up.file.is_some() {
            self.end(id, &mut up);
            tracing::info!(upload = %id, "upload cancelled");
        } else {
            // A finish that won the race still goes: the client no longer wants the file.
            forget_finished();
        }
    }

    /// Ends an upload that will not finish: closes and deletes its partial file, frees its name.
    fn end(&self, id: &str, up: &mut Active) {
        up.file = None;
        remove_quietly(&up.part);
        self.state().active.remove(id);
    }

    /// Drops uploads without a chunk for [`IDLE`] as of `now` (busy ones are not idle) and forgets
    /// finished ones after a day.
    pub fn sweep(&self, now: Instant) {
        let mut st = self.state();
        let idle: Vec<String> = st
            .active
            .iter()
            .filter(|(_, s)| try_lock(&s.upload).is_some_and(|up| now.saturating_duration_since(up.touched) > IDLE))
            .map(|(id, _)| id.clone())
            .collect();
        for id in idle {
            let Some(slot) = st.active.remove(&id) else { continue };
            let ended = match try_lock(&slot.upload) {
                Some(mut up) => {
                    up.file = None;
                    remove_quietly(&up.part);
                    true
                }
                None => false,
            };
            if ended {
                tracing::info!(upload = %id, "upload abandoned: no data for {} min", IDLE.as_secs() / 60);
            } else {
                st.active.insert(id, slot);
            }
        }
        st.finished.retain(|_, d| now.saturating_duration_since(d.at) < FINISHED_TTL);
    }

    /// Daemon start: deletes partial files no running upload owns (an earlier run's), then prunes.
    pub fn clean_start(&self) {
        let partials = self.0.root.join(PARTIAL);
        if let Ok(read) = std::fs::read_dir(&partials) {
            // Held throughout: `begin` creates partial files under this lock.
            let st = self.state();
            for e in read.flatten() {
                let name = e.file_name();
                let owned = name.to_string_lossy().strip_suffix(".part").is_some_and(|id| st.active.contains_key(id));
                if !owned {
                    remove_quietly(&e.path());
                }
            }
        }
        self.prune();
    }

    /// Finished uploads older than [`MAX_AGE`] go, then the oldest above [`MAX_TOTAL`]; day folders
    /// left empty go too.
    pub fn prune(&self) {
        self.prune_with(SystemTime::now(), MAX_AGE, MAX_TOTAL);
    }

    fn prune_with(&self, now: SystemTime, max_age: Duration, cap: u64) {
        let Ok(days) = std::fs::read_dir(&self.0.root) else { return };
        let mut files = Vec::new();
        let mut dirs = Vec::new();
        for day in days.flatten() {
            if day.file_name().to_string_lossy().starts_with('.') || !day.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            for e in std::fs::read_dir(day.path()).into_iter().flatten().flatten() {
                let Ok(meta) = e.metadata() else { continue };
                if let (true, Ok(modified)) = (meta.is_file(), meta.modified()) {
                    files.push((e.path(), modified, meta.len()));
                }
            }
            dirs.push(day.path());
        }
        for path in crate::originals::prune_plan(files, now, max_age, cap) {
            remove_quietly(&path);
            tracing::info!(path = %path.display(), "old upload pruned");
        }
        for dir in dirs {
            // Only empty folders: `remove_dir` refuses the rest.
            let _ = std::fs::remove_dir(&dir);
        }
    }
}

fn lock(m: &Mutex<Active>) -> MutexGuard<'_, Active> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn try_lock(m: &Mutex<Active>) -> Option<MutexGuard<'_, Active>> {
    match m.try_lock() {
        Ok(g) => Some(g),
        Err(TryLockError::Poisoned(p)) => Some(p.into_inner()),
        Err(TryLockError::WouldBlock) => None,
    }
}

fn gone(id: &str) -> ApiError {
    ApiError::new("not_found", format!("upload {id} is gone (cancelled, failed, or idle for over {} min)", IDLE.as_secs() / 60))
        .with_hint("Start the upload again")
}

fn too_big_chunk(len: usize) -> ApiError {
    ApiError::new("invalid_params", format!("a chunk carries 1 B to {} KiB, not {len} B", MAX_CHUNK >> 10))
}

fn remove_quietly(path: &Path) {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(path = %path.display(), "remove upload file: {e}");
        }
    }
}

fn new_upload_id() -> String {
    let mut b = [0u8; 8];
    match getrandom::fill(&mut b) {
        Ok(()) => format!("up_{}", hex(&b)),
        Err(_) => crate::util::new_id("up_"),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `dir/file_name`, else `dir/<stem>-2.<ext>`, `-3`, … : the first that neither exists nor is
/// `reserved` by a running upload.
fn unique_path(dir: &Path, file_name: &str, reserved: impl Fn(&Path) -> bool) -> PathBuf {
    let (stem, ext) = match file_name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, format!(".{ext}")),
        _ => (file_name, String::new()),
    };
    let free = |p: &Path| !reserved(p) && std::fs::symlink_metadata(p).is_err();
    (1..=9999)
        .map(|n| dir.join(if n == 1 { file_name.to_string() } else { format!("{stem}-{n}{ext}") }))
        .find(|p| free(p))
        .unwrap_or_else(|| dir.join(format!("{stem}-{}{ext}", new_upload_id())))
}

/// The file name an upload gets: the client's name (its last path component) reduced to letters,
/// digits, `-`, `_` and `.` (anything else becomes `-`), without leading or trailing dots and
/// dashes (no hidden files, nothing a command line reads as an option), at most 64 characters before
/// the extension. The extension is kept, lowercased (omp's read tool tells videos by it), or taken
/// from `mime` when the name has none. Windows device names (`CON`, `COM1`, …) get `-file`.
pub fn sanitize(name: &str, mime: Option<&str>) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default().trim();
    let (stem, ext) = match base.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && (1..=8).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphanumeric()) => {
            (stem, ext.to_ascii_lowercase())
        }
        _ => (base, String::new()),
    };
    let ext = if ext.is_empty() { mime.and_then(ext_for_mime).unwrap_or_default().to_string() } else { ext };
    let edge = |c: char| matches!(c, '-' | '.' | '_');
    let mut clean = String::with_capacity(stem.len());
    for c in stem.chars() {
        let c = if c.is_alphanumeric() || edge(c) { c } else { '-' };
        if !(c == '-' && clean.ends_with('-')) {
            clean.push(c);
        }
    }
    let clipped: String = clean.trim_matches(edge).chars().take(MAX_STEM).collect();
    let mut stem = clipped.trim_end_matches(edge).to_string();
    if stem.is_empty() {
        stem = match mime.and_then(|m| m.split('/').next()) {
            Some("video") => "video",
            Some("image") => "image",
            _ => "upload",
        }
        .to_string();
    }
    if is_windows_device(&stem) {
        stem.push_str("-file");
    }
    if ext.is_empty() { stem } else { format!("{stem}.{ext}") }
}

fn is_windows_device(stem: &str) -> bool {
    let first = stem.split('.').next().unwrap_or_default().to_ascii_uppercase();
    match first.as_bytes() {
        b"CON" | b"PRN" | b"AUX" | b"NUL" => true,
        [b'C', b'O', b'M', d] | [b'L', b'P', b'T', d] => (b'1'..=b'9').contains(d),
        _ => false,
    }
}

/// Extension for a name without one.
fn ext_for_mime(mime: &str) -> Option<&'static str> {
    let essence = mime.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
    Some(match essence.as_str() {
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        "video/x-matroska" | "video/matroska" => "mkv",
        "video/x-m4v" => "m4v",
        "video/x-msvideo" | "video/avi" => "avi",
        "video/x-ms-wmv" => "wmv",
        "video/3gpp" => "3gp",
        "video/mpeg" => "mpg",
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha(bytes: &[u8]) -> String {
        hex(&Sha256::digest(bytes))
    }

    fn uploads() -> (tempfile::TempDir, Uploads) {
        let td = tempfile::tempdir().unwrap();
        let u = Uploads::new(td.path().join("uploads"));
        (td, u)
    }

    fn partials(u: &Uploads) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(u.0.root.join(PARTIAL)).into_iter().flatten().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    fn name_of(path: &str) -> String {
        Path::new(path).file_name().unwrap().to_string_lossy().into_owned()
    }

    #[test]
    fn chunks_arrive_in_order_or_are_refused() {
        let (_td, u) = uploads();
        let body = b"0123456789";
        let b = u.begin("clip.mp4", 10, Some("video/mp4")).unwrap();
        assert_eq!(b.max_chunk as usize, MAX_CHUNK);
        assert!(name_of(&b.path) == "clip.mp4" && Path::new(&b.path).is_absolute(), "{}", b.path);
        let id = b.upload_id.as_str();
        assert_eq!(u.chunk(id, 0, &body[..4]).unwrap().received, 4);
        // A repeat of the chunk that landed (its answer got lost) and one that skips ahead.
        assert_eq!(u.chunk(id, 0, &body[..4]).unwrap_err().code, "upload_offset");
        assert_eq!(u.chunk(id, 8, &body[8..]).unwrap_err().code, "upload_offset");
        // Past the declared size, and empty or oversized chunks.
        assert_eq!(u.chunk(id, 4, b"4567890123").unwrap_err().code, "invalid_params");
        assert_eq!(u.chunk(id, 4, b"").unwrap_err().code, "invalid_params");
        assert_eq!(u.chunk(id, 4, &vec![0; MAX_CHUNK + 1]).unwrap_err().code, "invalid_params");
        // None of that moved it: it resumes where status says.
        assert_eq!(u.status(id).unwrap().received, 4);
        assert_eq!(u.finish(id, None).unwrap_err().code, "invalid_params", "incomplete");
        assert_eq!(u.chunk(id, 4, &body[4..]).unwrap().received, 10);
        let done = u.finish(id, Some(&sha(body).to_uppercase())).unwrap();
        assert_eq!((done.path.as_str(), done.size, done.sha256.as_str()), (b.path.as_str(), 10, sha(body).as_str()));
        assert_eq!(std::fs::read(&done.path).unwrap(), body);
        assert!(partials(&u).is_empty(), "the partial file was moved into place");
        // A retried finish (its answer got lost) answers the same; status says complete.
        assert_eq!(u.finish(id, None).unwrap(), done);
        assert_eq!(u.status(id).unwrap().received, 10);
        assert_eq!(u.chunk(id, 10, b"x").unwrap_err().code, "not_found");
        assert_eq!(u.chunk("up_nope", 0, b"x").unwrap_err().code, "not_found");
    }

    #[test]
    fn racing_duplicates_land_once() {
        let (_td, u) = uploads();
        let id = u.begin("a.webm", 4, None).unwrap().upload_id;
        let results: Vec<_> = (0..8)
            .map(|_| {
                let (u, id) = (u.clone(), id.clone());
                std::thread::spawn(move || u.chunk(&id, 0, b"abcd").is_ok())
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|t| t.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|ok| **ok).count(), 1);
        assert_eq!(std::fs::read(u.finish(&id, Some(&sha(b"abcd"))).unwrap().path).unwrap(), b"abcd");
    }

    #[test]
    fn a_wrong_checksum_drops_the_upload() {
        let (_td, u) = uploads();
        let b = u.begin("a.mp4", 3, None).unwrap();
        u.chunk(&b.upload_id, 0, b"abc").unwrap();
        assert_eq!(u.finish(&b.upload_id, Some(&sha(b"abd"))).unwrap_err().code, "checksum_mismatch");
        assert_eq!(u.status(&b.upload_id).unwrap_err().code, "not_found");
        assert!(partials(&u).is_empty() && !Path::new(&b.path).exists());
    }

    #[test]
    fn sizes_and_counts_are_capped() {
        let (_td, u) = uploads();
        assert_eq!(u.begin("empty.mp4", 0, None).unwrap_err().code, "invalid_params");
        let err = u.begin("huge.mp4", MAX_FILE + 1, None).unwrap_err();
        assert!(err.code == "invalid_params" && err.message.contains("at most 2 GiB"), "{err:?}");
        // The cap itself is fine (nothing is allocated up front).
        let ids: Vec<String> = (0..MAX_ACTIVE).map(|_| u.begin("big.mp4", MAX_FILE, None).unwrap().upload_id).collect();
        let busy = u.begin("one-more.mp4", 1, None).unwrap_err();
        assert!(busy.code == "busy" && busy.retryable);
        u.cancel(&ids[0]);
        assert!(u.begin("one-more.mp4", 1, None).is_ok());
        assert!(decode(&"A".repeat(MAX_CHUNK.div_ceil(3) * 4 + 4)).is_err());
        assert_eq!(decode("AAECAw==").unwrap(), [0, 1, 2, 3]);
        assert_eq!(decode("not base64!").unwrap_err().code, "invalid_params");
    }

    #[test]
    fn names_are_sanitized() {
        let cases = [
            ("My Video (1).MP4", None, "My-Video-1.mp4"),
            ("../../etc/passwd", None, "passwd"),
            (r"C:\Users\me\clip.mkv", None, "clip.mkv"),
            (".hidden.mov", None, "hidden.mov"),
            ("-rf --no-preserve-root.mp4", None, "rf-no-preserve-root.mp4"),
            ("clip", Some("video/webm"), "clip.webm"),
            ("clip", Some("video/quicktime; codecs=avc1"), "clip.mov"),
            ("", Some("video/mp4"), "video.mp4"),
            ("..", None, "upload"),
            ("CON.mp4", None, "CON-file.mp4"),
            ("com7", Some("video/mp4"), "com7-file.mp4"),
            ("com0.mp4", None, "com0.mp4"),
            ("動画 2026.mp4", None, "動画-2026.mp4"),
            ("a\u{202e}4pm.exe.mp4", None, "a-4pm.exe.mp4"),
            ("name.with.dots.MOV", None, "name.with.dots.mov"),
            ("weird.ext-with-dash", Some("video/mp4"), "weird.ext-with-dash.mp4"),
            ("spaces   and\ttabs .webm", None, "spaces-and-tabs.webm"),
        ];
        for (name, mime, want) in cases {
            assert_eq!(sanitize(name, mime), want, "{name:?}");
        }
        let long = sanitize(&format!("{}.mp4", "x".repeat(300)), None);
        assert_eq!(long, format!("{}.mp4", "x".repeat(MAX_STEM)));
    }

    #[test]
    fn names_are_unique_within_a_day() {
        let (_td, u) = uploads();
        let a = u.begin("clip.mp4", 1, None).unwrap();
        let b = u.begin("clip.mp4", 1, None).unwrap();
        assert_eq!(name_of(&b.path), "clip-2.mp4");
        // A file already there (finished earlier, or put there by hand) is never overwritten.
        std::fs::write(Path::new(&a.path).with_file_name("clip-3.mp4"), b"keep").unwrap();
        let c = u.begin("clip.mp4", 1, None).unwrap();
        assert_eq!(name_of(&c.path), "clip-4.mp4");
        // A file that appeared under the reserved name meanwhile: finish picks the next free one.
        std::fs::write(&a.path, b"squatter").unwrap();
        u.chunk(&a.upload_id, 0, b"v").unwrap();
        let done = u.finish(&a.upload_id, None).unwrap();
        assert_eq!(name_of(&done.path), "clip-5.mp4");
        assert_eq!(std::fs::read(&a.path).unwrap(), b"squatter");
    }

    #[cfg(unix)]
    #[test]
    fn files_and_folders_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        let (_td, u) = uploads();
        let b = u.begin("clip.mp4", 2, None).unwrap();
        let day = Path::new(&b.path).parent().unwrap().to_path_buf();
        assert_eq!((mode(&u.0.root), mode(&day), mode(&u.0.root.join(PARTIAL))), (0o700, 0o700, 0o700));
        assert_eq!(mode(&u.0.root.join(PARTIAL).join(format!("{}.part", b.upload_id))), 0o600);
        u.chunk(&b.upload_id, 0, b"ok").unwrap();
        assert_eq!(mode(Path::new(&u.finish(&b.upload_id, None).unwrap().path)), 0o600);
    }

    #[test]
    fn cancel_drops_partial_and_unsent_files() {
        let (_td, u) = uploads();
        let running = u.begin("a.mp4", 4, None).unwrap();
        u.chunk(&running.upload_id, 0, b"ab").unwrap();
        u.cancel(&running.upload_id);
        assert!(partials(&u).is_empty());
        assert_eq!(u.status(&running.upload_id).unwrap_err().code, "not_found");
        // Finished, but its chip was removed before the prompt went out.
        let done = u.begin("b.mp4", 1, None).unwrap();
        u.chunk(&done.upload_id, 0, b"b").unwrap();
        let path = u.finish(&done.upload_id, None).unwrap().path;
        u.cancel(&done.upload_id);
        assert!(!Path::new(&path).exists());
        u.cancel("up_unknown");
    }

    #[test]
    fn idle_uploads_are_abandoned() {
        let (_td, u) = uploads();
        let idle = u.begin("idle.mp4", 4, None).unwrap().upload_id;
        let fresh = u.begin("fresh.mp4", 4, None).unwrap().upload_id;
        let finished = u.begin("done.mp4", 1, None).unwrap().upload_id;
        u.chunk(&finished, 0, b"d").unwrap();
        u.finish(&finished, None).unwrap();
        let later = Instant::now() + IDLE + Duration::from_secs(1);
        // `fresh` is busy writing a chunk while the sweep runs: busy uploads are never idle.
        let (_, slot) = u.slot(&fresh).unwrap();
        let held = lock(&slot);
        u.sweep(later);
        drop(held);
        assert_eq!(u.status(&idle).unwrap_err().code, "not_found");
        assert_eq!(partials(&u), [format!("{fresh}.part")]);
        assert!(u.status(&fresh).is_ok());
        // Finished ids answer for a day, then they are forgotten (the file stays).
        assert!(u.status(&finished).is_ok());
        u.sweep(Instant::now() + FINISHED_TTL + Duration::from_secs(1));
        assert_eq!(u.status(&finished).unwrap_err().code, "not_found");
    }

    #[test]
    fn start_deletes_an_earlier_runs_partials_and_prunes() {
        let (_td, u) = uploads();
        let live = u.begin("live.mp4", 4, None).unwrap().upload_id;
        std::fs::write(u.0.root.join(PARTIAL).join("up_crashed.part"), b"half").unwrap();
        // A day folder from long ago with one old upload, and an empty one.
        let old_day = u.0.root.join("2026-01-02");
        std::fs::create_dir_all(&old_day).unwrap();
        let old = old_day.join("old.mp4");
        std::fs::write(&old, b"old").unwrap();
        File::options().write(true).open(&old).unwrap().set_modified(SystemTime::now() - MAX_AGE - Duration::from_secs(60)).unwrap();
        std::fs::create_dir_all(u.0.root.join("2026-01-03")).unwrap();
        u.clean_start();
        assert_eq!(partials(&u), [format!("{live}.part")]);
        assert!(!old.exists() && !old_day.exists() && !u.0.root.join("2026-01-03").exists());
        assert!(u.chunk(&live, 0, b"live").is_ok());
    }

    #[test]
    fn old_and_excess_uploads_are_pruned() {
        let (_td, u) = uploads();
        let day = u.0.root.join("2026-10-01");
        std::fs::create_dir_all(&day).unwrap();
        let now = SystemTime::now();
        let file = |name: &str, age_s: u64, len: usize| {
            let p = day.join(name);
            std::fs::write(&p, vec![0; len]).unwrap();
            File::options().write(true).open(&p).unwrap().set_modified(now - Duration::from_secs(age_s)).unwrap();
            p
        };
        let newest = file("newest.mp4", 10, 60);
        let middle = file("middle.mp4", 20, 30);
        let oldest = file("oldest.mp4", 30, 30);
        let expired = file("expired.mp4", MAX_AGE.as_secs() + 60, 1);
        u.prune_with(now, MAX_AGE, 100);
        assert!(newest.exists() && middle.exists());
        assert!(!oldest.exists(), "over the total cap");
        assert!(!expired.exists(), "too old");
    }
}
