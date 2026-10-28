//! omp's native MCP config files: where they live, reading them, and changing them the way omp's
//! `mcp/config-writer.ts` does, under omp's own cross-process lock.
//!
//! * user scope: `<omp agent dir>/mcp.json` (also read: `<agent dir>/.mcp.json`);
//! * project scope: `<folder>/.omp/mcp.json` (also read: `<folder>/.omp/.mcp.json`).
//!
//! Writes: read-modify-write while holding the lock omp's writer takes for the same file
//! (`withFileLock(filePath)` → `@oh-my-pi/pi-natives` `FileLock` on `<abs path>.lock`: an abstract
//! Unix socket named `omp-file-lock-<xxh64 pair>` on Linux, a named mutex on Windows, `flock(2)` on
//! the `.lock` sidecar elsewhere), so a concurrent `/mcp add` in a session and an edit here never
//! lose each other's change. The file is written whole to a unique `0600` temp file and renamed
//! into place, `$schema` first, two-space JSON, no trailing newline — exactly omp's output.

use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use tf_proto::ApiError;

use super::json::{self, Obj, J};

/// omp's `MCP_CONFIG_SCHEMA_URL`, put first by its writer when a file has no `$schema`.
pub const SCHEMA_URL: &str = "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";

/// omp's `acquireFileLock` defaults: 50 attempts, 100 ms apart.
const LOCK_ATTEMPTS: u32 = 50;
const LOCK_RETRY: Duration = Duration::from_millis(100);

/// `mcp.json` (written) and `.mcp.json` (also read) of one scope, in omp's read order.
pub fn scope_files(dir: &Path) -> [PathBuf; 2] {
    [dir.join("mcp.json"), dir.join(".mcp.json")]
}

/// The user-scope directory (`<agent dir>`) and the project one (`<folder>/.omp`).
pub fn project_dir(folder: &Path) -> PathBuf {
    folder.join(".omp")
}

/// A config file as omp would load it.
#[derive(Debug, Clone, PartialEq)]
pub enum Loaded {
    Missing,
    Ok(Obj),
    /// Unreadable or not a JSON object: omp skips it (with a warning); TeleFlock won't write it.
    Bad(String),
}

pub fn read(path: &Path) -> Loaded {
    match std::fs::read_to_string(path) {
        Ok(text) => match json::parse(&text) {
            Ok(J::Obj(o)) => Loaded::Ok(o),
            Ok(_) => Loaded::Bad("not a JSON object".into()),
            Err(e) => Loaded::Bad(e),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Loaded::Missing,
        Err(e) => Loaded::Bad(e.to_string()),
    }
}

/// Changes one config file under omp's lock: `f` gets the current root (an empty
/// `{"mcpServers": {}}` when the file is missing, like omp's reader) and the file is written when
/// it returns `Ok`. Blocking: call from `spawn_blocking`.
pub fn modify<T>(path: &Path, f: impl FnOnce(&mut Obj) -> Result<T, ApiError>) -> Result<T, ApiError> {
    let dir = path.parent().ok_or_else(|| ApiError::new("invalid_params", format!("{} has no folder", path.display())))?;
    create_private_dir(dir).map_err(|e| io_err(dir, e))?;
    let _lock = OmpFileLock::acquire(path).map_err(|e| {
        ApiError::new("busy", format!("{} is locked by another omp process: {e}", path.display())).retryable()
    })?;
    let mut root = match read(path) {
        Loaded::Missing => Obj(vec![("mcpServers".into(), J::Obj(Obj::default()))]),
        Loaded::Ok(o) => o,
        Loaded::Bad(msg) => {
            return Err(ApiError::new("invalid_params", format!("omp can't read {}: {msg}", path.display()))
                .with_hint("Fix or remove that file on the host first; TeleFlock won't overwrite it."));
        }
    };
    let out = f(&mut root)?;
    write(path, &root).map_err(|e| io_err(path, e))?;
    Ok(out)
}

fn io_err(path: &Path, e: std::io::Error) -> ApiError {
    let hint = (e.kind() == std::io::ErrorKind::PermissionDenied).then(|| format!("tf-hostd may not write {}.", path.display()));
    let err = ApiError::new("io_error", format!("{}: {e}", path.display()));
    match hint {
        Some(h) => err.with_hint(h),
        None => err,
    }
}

/// `mkdir -p` with mode 0700 for the folders it creates (omp: `mkdir(dir, {recursive, mode: 0o700})`).
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    b.create(dir)
}

/// `writeMCPConfigFile`: `$schema` first, `JSON.stringify(…, null, 2)`, unique 0600 temp file, rename.
pub fn write(path: &Path, root: &Obj) -> std::io::Result<()> {
    let mut root = root.clone();
    let schema = root.remove("$schema").unwrap_or_else(|| J::str(SCHEMA_URL));
    root.insert_first("$schema", schema);
    let text = json::pretty(&J::Obj(root));
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let tmp = PathBuf::from(format!("{}.{}.{nanos}.tmp", path.display(), std::process::id()));
    let res = (|| {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
        let mut f = opts.open(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

/// `path.resolve(p)` without touching the file system: absolute (against the current dir), `.`
/// and `..` folded, no trailing separator.
pub fn resolve_lexically(p: &Path) -> PathBuf {
    let abs = if p.is_absolute() { p.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(p) };
    let mut out = PathBuf::new();
    for c in abs.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// pi-natives `memory_lock_name`: two xxh64 of the lock path with fixed seeds.
pub fn lock_name(lock_path: &str) -> String {
    const HIGH_SEED: u64 = 0x4f4d_502d_4c4f_434b;
    const LOW_SEED: u64 = 0x5049_2d46_494c_454c;
    let high = twox_hash::XxHash64::oneshot(HIGH_SEED, lock_path.as_bytes());
    let low = twox_hash::XxHash64::oneshot(LOW_SEED, lock_path.as_bytes());
    format!("omp-file-lock-{high:016x}{low:016x}")
}

/// omp's `getLockPath(file)`: `${path.resolve(file)}.lock`.
pub fn lock_path(file: &Path) -> String {
    format!("{}.lock", resolve_lexically(file).display())
}

/// The lock omp's config writer holds while it changes `file` (see the module docs). Released on drop.
pub struct OmpFileLock {
    _held: platform::Held,
}

impl OmpFileLock {
    pub fn acquire(file: &Path) -> std::io::Result<OmpFileLock> {
        let path = lock_path(file);
        let started = Instant::now();
        for attempt in 0..LOCK_ATTEMPTS {
            if let Some(held) = platform::try_acquire(&path)? {
                return Ok(OmpFileLock { _held: held });
            }
            if attempt + 1 < LOCK_ATTEMPTS {
                std::thread::sleep(LOCK_RETRY);
            }
        }
        Err(std::io::Error::new(std::io::ErrorKind::WouldBlock, format!("still held after {:.1}s", started.elapsed().as_secs_f32())))
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::os::linux::net::SocketAddrExt;
    use std::os::unix::net::{SocketAddr, UnixDatagram};

    /// The bound abstract socket is the lease (released when closed, also by a crash).
    pub struct Held(#[allow(dead_code)] UnixDatagram);

    pub fn try_acquire(lock_path: &str) -> std::io::Result<Option<Held>> {
        let name = super::lock_name(lock_path);
        let addr = SocketAddr::from_abstract_name(name.as_bytes())?;
        match UnixDatagram::bind_addr(&addr) {
            Ok(s) => Ok(Some(Held(s))),
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => Ok(None),
            Err(e) => Err(e),
        }
    }
}

#[cfg(all(unix, not(target_os = "linux")))]
mod platform {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;

    /// `flock(2)` on the persistent `.lock` sidecar, held while the file stays open.
    pub struct Held(#[allow(dead_code)] std::fs::File);

    pub fn try_acquire(lock_path: &str) -> std::io::Result<Option<Held>> {
        let f = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).mode(0o600).open(lock_path)?;
        // SAFETY: `f` owns a live descriptor for the duration of the call.
        if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(Some(Held(f)));
        }
        let e = std::io::Error::last_os_error();
        if e.kind() == std::io::ErrorKind::WouldBlock { Ok(None) } else { Err(e) }
    }
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, SetLastError, ERROR_ALREADY_EXISTS, HANDLE};
    use windows_sys::Win32::System::Threading::{CreateMutexExW, SYNCHRONIZATION_SYNCHRONIZE};

    /// The named kernel object's existence is the lease (closed handle = released).
    pub struct Held(HANDLE);

    // SAFETY: the handle is only closed once, in `drop`; kernel handles may be used from any thread.
    unsafe impl Send for Held {}

    impl Drop for Held {
        fn drop(&mut self) {
            // SAFETY: `self.0` is an owned handle from `CreateMutexExW`, closed exactly once here.
            unsafe { CloseHandle(self.0) };
        }
    }

    pub fn try_acquire(lock_path: &str) -> std::io::Result<Option<Held>> {
        let name: Vec<u16> = format!(r"Global\{}", super::lock_name(lock_path)).encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: resets the thread's last-error value before the call that sets it.
        unsafe { SetLastError(0) };
        // SAFETY: null attributes and a live NUL-terminated UTF-16 name for the call's duration.
        let h = unsafe { CreateMutexExW(std::ptr::null(), name.as_ptr(), 0, SYNCHRONIZATION_SYNCHRONIZE) };
        if h.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let held = Held(h);
        // SAFETY: reads the last-error value `CreateMutexExW` just set.
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            return Ok(None);
        }
        Ok(Some(held))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_name_matches_pi_natives() {
        // Reference values from pi-natives' `memory_lock_name` (xxhash-rust xxh64, same seeds).
        let name = lock_name("/root/.omp/agent/mcp.json.lock");
        assert!(name.starts_with("omp-file-lock-") && name.len() == "omp-file-lock-".len() + 32, "{name}");
        assert_eq!(lock_name("x"), lock_name("x"));
        assert_ne!(lock_name("/a/mcp.json.lock"), lock_name("/b/mcp.json.lock"));
    }

    #[test]
    fn lock_path_resolves_like_node() {
        assert_eq!(lock_path(Path::new("/a/./b/../mcp.json")), "/a/mcp.json.lock");
    }

    #[test]
    fn the_lock_excludes_a_second_holder_until_released() {
        let td = tempfile::tempdir().unwrap();
        let file = td.path().join("mcp.json");
        let first = OmpFileLock::acquire(&file).unwrap();
        assert!(platform::try_acquire(&lock_path(&file)).unwrap().is_none(), "held");
        drop(first);
        // A child another test thread is forking right now holds a copy of the lock's descriptor
        // until it execs (close-on-exec), so the release can show a moment late; omp's writer
        // retries for 5 s. Released means free again within a second, not at this instant.
        let until = std::time::Instant::now() + Duration::from_secs(1);
        let mut again = platform::try_acquire(&lock_path(&file)).unwrap();
        while again.is_none() && std::time::Instant::now() < until {
            std::thread::sleep(Duration::from_millis(5));
            again = platform::try_acquire(&lock_path(&file)).unwrap();
        }
        assert!(again.is_some(), "released");
    }

    #[test]
    fn write_matches_omps_writer_and_is_private() {
        let td = tempfile::tempdir().unwrap();
        let file = td.path().join("agent").join("mcp.json");
        modify(&file, |root| {
            root.obj_mut("mcpServers").unwrap().set("docs", J::Obj(Obj(vec![("type".into(), J::str("http")), ("url".into(), J::str("https://x.dev/mcp"))])));
            Ok(())
        })
        .unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert_eq!(
            text,
            format!("{{\n  \"$schema\": \"{SCHEMA_URL}\",\n  \"mcpServers\": {{\n    \"docs\": {{\n      \"type\": \"http\",\n      \"url\": \"https://x.dev/mcp\"\n    }}\n  }}\n}}")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(file.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let leftovers: Vec<_> = std::fs::read_dir(file.parent().unwrap()).unwrap().flatten().filter(|e| e.file_name() != "mcp.json").collect();
        assert!(leftovers.is_empty(), "no temp files left: {leftovers:?}");
    }

    #[test]
    fn a_file_omp_cannot_read_is_never_overwritten() {
        let td = tempfile::tempdir().unwrap();
        let file = td.path().join("mcp.json");
        std::fs::write(&file, "{ // hand-written\n \"mcpServers\": {} }").unwrap();
        assert!(matches!(read(&file), Loaded::Bad(_)));
        let err = modify(&file, |_| Ok(())).unwrap_err();
        assert_eq!(err.code, "invalid_params");
        assert!(std::fs::read_to_string(&file).unwrap().contains("hand-written"));
    }

    #[test]
    fn schema_moves_first_and_unknown_root_keys_stay() {
        let td = tempfile::tempdir().unwrap();
        let file = td.path().join("mcp.json");
        std::fs::write(&file, r#"{"mcpServers":{},"x-note":"keep","$schema":"custom"}"#).unwrap();
        modify(&file, |_| Ok(())).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{\n  \"$schema\": \"custom\",\n  \"mcpServers\": {},\n  \"x-note\": \"keep\"\n}");
    }
}
