//! Local-endpoint hardening against other users on the same machine.
//!
//! * The bridge handshake secret: random, written owner-only to `<home>/run/bridge.secret`, and
//!   presented by hostd as the first frame of every bridge connection. The Node extension cannot
//!   inspect a pipe's owner, so this is how it knows it is talking to the real hostd
//!   (`docs/bridge-protocol.md`).
//! * Windows: an owner-only security descriptor for the named pipes and the secret file (DACL:
//!   current user + SYSTEM), and a check that a pipe we connect to is served by a process running
//!   as the current user.

use std::io::{self, Write};
use std::path::Path;

/// Length of the secret in bytes (256 bits; 64 hex characters on disk and on the wire).
const SECRET_BYTES: usize = 32;

/// A fresh random secret as lowercase hex.
pub fn new_secret() -> io::Result<String> {
    let mut bytes = [0u8; SECRET_BYTES];
    getrandom::fill(&mut bytes).map_err(|e| io::Error::other(format!("OS random source: {e}")))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Writes `secret` to `path` readable by the current user only (unix: mode 0600; windows: DACL
/// current user + SYSTEM). Atomic: a reader sees the old or the new secret, never a partial one.
pub fn write_secret_file(path: &Path, secret: &str) -> io::Result<()> {
    let tmp = path.with_extension("secret.tmp");
    match std::fs::remove_file(&tmp) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let mut file = create_private_new(&tmp)?;
    file.write_all(secret.as_bytes())?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, path)
}

#[cfg(unix)]
fn create_private_new(path: &Path) -> io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)
}

#[cfg(windows)]
fn create_private_new(path: &Path) -> io::Result<std::fs::File> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::{GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL};

    let sd = win::PrivateSd::new()?;
    let sa = sd.attributes();
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    // SAFETY: `wide` is NUL-terminated, `sa` points at a descriptor that outlives the call.
    let handle = unsafe {
        CreateFileW(wide.as_ptr(), GENERIC_WRITE, 0, &sa, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, std::ptr::null_mut())
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `handle` is a freshly opened, owned file handle.
    Ok(unsafe { std::fs::File::from_raw_handle(handle) })
}

#[cfg(windows)]
pub use win::{create_pipe_server, verify_pipe_server, PrivateSd};

#[cfg(windows)]
mod win {
    use std::io;
    use std::os::windows::io::AsRawHandle;

    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        EqualSid, GetLengthSid, GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
        TOKEN_USER,
    };
    use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// A self-relative security descriptor whose protected DACL grants `GENERIC_ALL` to the current
    /// user and SYSTEM only (no Everyone, Anonymous or inherited entries).
    pub struct PrivateSd(PSECURITY_DESCRIPTOR);

    // SAFETY: the descriptor is immutable after creation and only read by the kernel.
    unsafe impl Send for PrivateSd {}
    unsafe impl Sync for PrivateSd {}

    impl PrivateSd {
        pub fn new() -> io::Result<Self> {
            let sid = current_user_sid()?;
            let sddl = format!("D:P(A;;GA;;;{})(A;;GA;;;SY)", sid_string(&sid)?);
            let wide: Vec<u16> = sddl.encode_utf16().chain(std::iter::once(0)).collect();
            let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            // SAFETY: `wide` is NUL-terminated; on success `sd` is a LocalAlloc'd descriptor we own.
            let ok = unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    wide.as_ptr(),
                    SDDL_REVISION_1,
                    &mut sd,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Self(sd))
        }

        /// Non-inheritable attributes pointing at this descriptor (valid while `self` lives).
        pub fn attributes(&self) -> SECURITY_ATTRIBUTES {
            SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: self.0,
                bInheritHandle: 0,
            }
        }
    }

    impl Drop for PrivateSd {
        fn drop(&mut self) {
            // SAFETY: allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW.
            unsafe { LocalFree(self.0) };
        }
    }

    /// Creates one pipe instance with the owner-only descriptor.
    pub fn create_pipe_server(opts: &ServerOptions, name: &str, sd: &PrivateSd) -> io::Result<NamedPipeServer> {
        let mut sa = sd.attributes();
        // SAFETY: `sa` and the descriptor it points at outlive the call.
        unsafe { opts.create_with_security_attributes_raw(name, (&mut sa as *mut SECURITY_ATTRIBUTES).cast()) }
    }

    /// Refuses (`PermissionDenied`) a pipe whose server process does not run as the current user:
    /// another local user may have created the pipe name first.
    pub fn verify_pipe_server(pipe: &impl AsRawHandle) -> io::Result<()> {
        let mut pid = 0u32;
        // SAFETY: valid pipe handle, valid out pointer.
        if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle() as HANDLE, &mut pid) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let denied = |why: String| {
            io::Error::new(io::ErrorKind::PermissionDenied, format!("pipe server pid {pid} {why}; refusing to connect"))
        };
        // SAFETY: plain query-only open; the handle is closed by `Owned`.
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return Err(denied(format!("cannot be inspected ({})", io::Error::last_os_error())));
        }
        let process = Owned(process);
        let server = token_user_sid(process.0).map_err(|e| denied(format!("has an unreadable token ({e})")))?;
        let me = current_user_sid()?;
        // SAFETY: both buffers hold valid SIDs (copied from TOKEN_USER).
        if unsafe { EqualSid(server.as_ptr() as _, me.as_ptr() as _) } == 0 {
            let who = sid_string(&server).unwrap_or_else(|_| "?".into());
            return Err(denied(format!("runs as another user ({who})")));
        }
        Ok(())
    }

    struct Owned(HANDLE);

    impl Drop for Owned {
        fn drop(&mut self) {
            // SAFETY: owned handle from OpenProcess / OpenProcessToken.
            unsafe { CloseHandle(self.0) };
        }
    }

    fn current_user_sid() -> io::Result<Vec<u8>> {
        // SAFETY: the pseudo-handle needs no closing.
        token_user_sid(unsafe { GetCurrentProcess() })
    }

    /// The `TokenUser` SID of `process`, copied out as bytes.
    fn token_user_sid(process: HANDLE) -> io::Result<Vec<u8>> {
        let mut token: HANDLE = std::ptr::null_mut();
        // SAFETY: valid process handle, valid out pointer.
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let token = Owned(token);
        let mut len = 0u32;
        // SAFETY: size query with a null buffer.
        unsafe { GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut len) };
        if len == 0 {
            return Err(io::Error::last_os_error());
        }
        // u64 backing keeps TOKEN_USER (pointer-aligned) correctly aligned.
        let mut buf = vec![0u64; (len as usize).div_ceil(8)];
        // SAFETY: `buf` holds at least `len` bytes.
        if unsafe { GetTokenInformation(token.0, TokenUser, buf.as_mut_ptr().cast(), len, &mut len) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: GetTokenInformation(TokenUser) filled `buf` with a TOKEN_USER whose SID points into `buf`.
        unsafe {
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            let sid = user.User.Sid;
            let n = GetLengthSid(sid) as usize;
            Ok(std::slice::from_raw_parts(sid as *const u8, n).to_vec())
        }
    }

    /// `S-1-5-21-…` form of a SID.
    fn sid_string(sid: &[u8]) -> io::Result<String> {
        let mut out: windows_sys::core::PWSTR = std::ptr::null_mut();
        // SAFETY: `sid` is a valid SID; on success `out` is a LocalAlloc'd NUL-terminated string.
        if unsafe { ConvertSidToStringSidW(sid.as_ptr() as _, &mut out) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `out` is NUL-terminated and freed exactly once below.
        unsafe {
            let len = (0..).take_while(|&i| *out.add(i) != 0).count();
            let s = String::from_utf16_lossy(std::slice::from_raw_parts(out, len));
            LocalFree(out.cast());
            Ok(s)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_is_256_bit_hex_and_fresh() {
        let a = new_secret().unwrap();
        let b = new_secret().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a, b);
    }

    #[test]
    fn secret_file_is_replaced_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bridge.secret");
        write_secret_file(&path, "first").unwrap();
        write_secret_file(&path, "second").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
        assert!(!path.with_extension("secret.tmp").exists());
    }

    #[cfg(unix)]
    #[test]
    fn secret_file_is_owner_only_even_over_a_loose_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bridge.secret");
        std::fs::write(&path, "old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        // A pre-planted loose tmp file must not be reused either.
        std::fs::write(path.with_extension("secret.tmp"), "planted").unwrap();
        std::fs::set_permissions(path.with_extension("secret.tmp"), std::fs::Permissions::from_mode(0o666)).unwrap();
        write_secret_file(&path, "s3cret").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "s3cret");
    }
}
