//! Embedded artifacts (tf-hostd per target triple, companion extension, omp overlay) and
//! deployment to a host: detect the arch, compare versions/content stamps, upload what
//! differs. Remote hosts (SSH, WSL) are driven with `sh` over `exec` (+stdin); local hosts
//! are written directly. A host shared by several devices only moves forward: an app never
//! replaces a newer tf-hostd (see [`host_is_newer`]).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tf_proto::{ApiError, HostKind, PROTOCOL_VERSION};
use tf_transport::{Cmd, Transport};

use crate::util::{io_err, sh_quote, write_atomic};

mod embedded {
    /// One embedded tf-hostd (see `build.rs`).
    pub struct EmbeddedHostd {
        pub triple: &'static str,
        /// SHA-256 of the uncompressed binary (the deploy stamp).
        pub sha256: &'static str,
        /// Uncompressed size in bytes.
        pub len: usize,
        pub zstd: &'static [u8],
    }
    include!(concat!(env!("OUT_DIR"), "/embedded.rs"));
}

/// tf-hostd version deployed by this build (the workspace version).
pub const HOSTD_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Exact `tf-hostd --version` line this build expects.
pub fn expected_version_line() -> String {
    format!("tf-hostd {HOSTD_VERSION} proto {PROTOCOL_VERSION}")
}

/// The installed tf-hostd (`--version` line) is newer than this build: a newer app on another
/// device deployed it. This app uses it as is and touches none of the host's files; replacing
/// it would drop that device, whose app would reinstall its build and drop this one in turn.
pub fn host_is_newer(installed: &str) -> bool {
    tf_proto::version::cmp_lines(installed, &expected_version_line()) == Some(std::cmp::Ordering::Greater)
}

/// Candidate target triples for an OS/arch pair, best first.
pub fn triples_for(os: &str, arch: &str) -> &'static [&'static str] {
    let os = os.to_ascii_lowercase();
    let arch = arch.to_ascii_lowercase();
    let x64 = matches!(arch.as_str(), "x86_64" | "amd64" | "x64");
    let arm = matches!(arch.as_str(), "aarch64" | "arm64" | "armv8" | "armv8l");
    match (os.as_str(), x64, arm) {
        ("linux", true, _) => &["x86_64-unknown-linux-musl", "x86_64-unknown-linux-gnu"],
        ("linux", _, true) => &["aarch64-unknown-linux-musl", "aarch64-unknown-linux-gnu"],
        ("darwin" | "macos", true, _) => &["x86_64-apple-darwin"],
        ("darwin" | "macos", _, true) => &["aarch64-apple-darwin"],
        ("windows", true, _) => &["x86_64-pc-windows-msvc"],
        ("windows", _, true) => &["aarch64-pc-windows-msvc", "x86_64-pc-windows-msvc"],
        _ => &[],
    }
}

/// Parses `uname -sm` output (`Linux x86_64`).
pub fn parse_uname(s: &str) -> Option<(String, String)> {
    let mut it = s.split_whitespace();
    let os = it.next()?.to_string();
    let arch = it.next()?.to_string();
    Some((os, arch))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let d = Sha256::digest(bytes);
    d.iter().map(|b| format!("{b:02x}")).collect()
}

/// A tf-hostd binary ready to upload.
pub struct HostdBin {
    pub triple: String,
    pub sha: String,
    /// Uncompressed size in bytes.
    pub len: usize,
    payload: Payload,
}

enum Payload {
    /// Embedded, zstd-compressed.
    Zstd(&'static [u8]),
    /// Dev override read from disk.
    Raw(Vec<u8>),
}

impl HostdBin {
    /// The binary itself (decompressed off the async runtime when embedded).
    pub async fn into_bytes(self) -> Result<Vec<u8>, ApiError> {
        match self.payload {
            Payload::Raw(b) => Ok(b),
            Payload::Zstd(z) => {
                let len = self.len;
                tokio::task::spawn_blocking(move || {
                    use std::io::Read;
                    let mut src = z;
                    let mut dec = ruzstd::decoding::StreamingDecoder::new(&mut src)
                        .map_err(|e| ApiError::new("internal", format!("embedded tf-hostd: {e}")))?;
                    let mut out = Vec::with_capacity(len);
                    dec.read_to_end(&mut out)
                        .map_err(|e| ApiError::new("internal", format!("embedded tf-hostd: {e}")))?;
                    Ok(out)
                })
                .await
                .map_err(|e| ApiError::new("internal", e.to_string()))?
            }
        }
    }
}

/// Source of deployable artifacts: the embedded tables, or a dev override.
#[derive(Clone, Debug, Default)]
pub struct Artifacts {
    /// A tf-hostd binary used for every arch, or a dist dir laid out as `<triple>/tf-hostd[.exe]`.
    pub hostd_override: Option<PathBuf>,
}

type FileId = (PathBuf, u64, Option<std::time::SystemTime>);
static OVERRIDE_SHA: LazyLock<Mutex<HashMap<FileId, String>>> = LazyLock::new(Default::default);

impl Artifacts {
    /// Triples embedded in this build.
    #[cfg(test)]
    pub fn embedded_triples() -> Vec<&'static str> {
        embedded::HOSTD_BINS.iter().map(|b| b.triple).collect()
    }

    pub async fn hostd(&self, os: &str, arch: &str) -> Result<HostdBin, ApiError> {
        let candidates = triples_for(os, arch);
        if candidates.is_empty() {
            return Err(ApiError::new("unsupported", format!("unsupported host platform `{os} {arch}`")));
        }
        if let Some(path) = &self.hostd_override {
            let file = if path.is_dir() {
                candidates
                    .iter()
                    .map(|t| path.join(t).join(if t.contains("windows") { "tf-hostd.exe" } else { "tf-hostd" }))
                    .find(|p| p.is_file())
                    .ok_or_else(|| {
                        ApiError::new(
                            "not_found",
                            format!("no tf-hostd for {} under {}", candidates[0], path.display()),
                        )
                    })?
            } else {
                path.clone()
            };
            let bytes = tokio::fs::read(&file).await.map_err(|e| io_err(&format!("read {}", file.display()), e))?;
            // Dev binaries are large; hash once per (path, size, mtime).
            let id = std::fs::metadata(&file).ok().map(|m| (file.clone(), m.len(), m.modified().ok()));
            let cached = id.as_ref().and_then(|id| OVERRIDE_SHA.lock().unwrap().get(id).cloned());
            let (bytes, sha) = match cached {
                Some(sha) => (bytes, sha),
                None => {
                    let (bytes, sha) = tokio::task::spawn_blocking(move || {
                        let sha = sha256_hex(&bytes);
                        (bytes, sha)
                    })
                    .await
                    .map_err(|e| ApiError::new("internal", e.to_string()))?;
                    if let Some(id) = id {
                        OVERRIDE_SHA.lock().unwrap().insert(id, sha.clone());
                    }
                    (bytes, sha)
                }
            };
            return Ok(HostdBin {
                triple: candidates[0].to_string(),
                sha,
                len: bytes.len(),
                payload: Payload::Raw(bytes),
            });
        }
        for t in candidates {
            if let Some(b) = embedded::HOSTD_BINS.iter().find(|b| b.triple == *t) {
                return Ok(HostdBin {
                    triple: b.triple.to_string(),
                    sha: b.sha256.to_string(),
                    len: b.len,
                    payload: Payload::Zstd(b.zstd),
                });
            }
        }
        Err(ApiError::new(
            "unsupported",
            format!("this build has no tf-hostd for {} (host is {os} {arch})", candidates[0]),
        )
        .with_hint(format!(
            "build it with scripts/build-hostd.sh into {}/{}/ and rebuild the app",
            embedded::HOSTD_DIST_DIR,
            candidates[0]
        )))
    }

    pub fn bridge_ext(&self) -> Result<&'static str, ApiError> {
        embedded::BRIDGE_EXT.ok_or_else(|| {
            ApiError::new(
                "unsupported",
                "this build has no companion extension (host/teleflock-bridge/teleflock-bridge.ts was missing at build time)",
            )
        })
    }
}

/// omp settings overlay passed to agents started by TeleFlock (`--config`).
pub fn overlay_yaml(relay_port: u16) -> String {
    format!(
        "# Written by TeleFlock. Per-process omp settings overlay (omp --config); global config untouched.\n\
         collab:\n  autoStart: control\n  relayUrl: ws://127.0.0.1:{relay_port}\n"
    )
}

/// Result of a successful deploy.
#[derive(Debug, Clone)]
pub struct Deployed {
    /// Absolute path of the deployed tf-hostd.
    pub hostd: String,
    /// A new binary was uploaded (attach with `--replace`).
    pub replaced: bool,
    /// The host runs a newer tf-hostd than this build (its `--version` line); nothing was uploaded.
    pub newer: Option<String>,
}

/// What a probe found on the host.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Probe {
    pub os: String,
    pub arch: String,
    pub home: String,
    /// `tf-hostd --version` output (empty when absent/broken).
    pub version: String,
    pub hostd_sha: String,
    pub ext_sha: String,
    pub overlay_sha: String,
}

const PROBE_SCRIPT: &str = r#"H="${TF_HOSTD_HOME:-$HOME/.teleflock}"
echo "tf.uname=$(uname -sm)"
echo "tf.home=$H"
echo "tf.version=$("$H/bin/tf-hostd" --version 2>/dev/null | head -n 1)"
echo "tf.hostd=$(cat "$H/bin/tf-hostd.sha256" 2>/dev/null)"
echo "tf.ext=$(cat "$H/ext/teleflock-bridge.ts.sha256" 2>/dev/null)"
echo "tf.overlay=$(cat "$H/omp-overlay.yml.sha256" 2>/dev/null)"
"#;

/// Parses the tagged probe output (login shells may print noise; only `tf.` lines count).
pub fn parse_probe(out: &str) -> Result<Probe, ApiError> {
    let mut p = Probe::default();
    let mut uname = None;
    for line in out.lines() {
        let Some(rest) = line.trim_end_matches('\r').strip_prefix("tf.") else { continue };
        let Some((k, v)) = rest.split_once('=') else { continue };
        let v = v.trim().to_string();
        match k {
            "uname" => uname = parse_uname(&v),
            "home" => p.home = v,
            "version" => p.version = v,
            "hostd" => p.hostd_sha = v,
            "ext" => p.ext_sha = v,
            "overlay" => p.overlay_sha = v,
            _ => {}
        }
    }
    let (os, arch) = uname.ok_or_else(|| ApiError::new("internal", format!("host probe failed: {}", out.trim())))?;
    if p.home.is_empty() {
        return Err(ApiError::new("internal", "host probe returned no home directory"));
    }
    p.os = os;
    p.arch = arch;
    Ok(p)
}

fn exec_err(what: &str, out: &tf_transport::Output) -> ApiError {
    let stderr = String::from_utf8_lossy(&out.stderr);
    let msg = stderr.trim();
    ApiError::new(
        "io_error",
        format!(
            "{what} failed (exit {}){}",
            out.status.code.map(|c| c.to_string()).unwrap_or_else(|| out.status.signal.clone().unwrap_or_default()),
            if msg.is_empty() { String::new() } else { format!(": {msg}") }
        ),
    )
    .retryable()
}

/// Runs the probe on a remote (SSH/WSL) host.
pub async fn probe_remote(t: &dyn Transport) -> Result<Probe, ApiError> {
    let out = t
        .exec(&Cmd::new(["sh", "-c", PROBE_SCRIPT]).timeout(Duration::from_secs(30)))
        .await?;
    if !out.status.success() {
        return Err(exec_err("host probe", &out));
    }
    parse_probe(&String::from_utf8_lossy(&out.stdout))
}

/// Local tf-hostd home: `$TF_HOSTD_HOME`, else `<home>/.teleflock`.
pub fn local_home() -> Result<PathBuf, ApiError> {
    if let Some(h) = std::env::var_os("TF_HOSTD_HOME").filter(|h| !h.is_empty()) {
        return Ok(PathBuf::from(h));
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .filter(|h| !h.is_empty())
        .ok_or_else(|| ApiError::new("internal", "cannot determine the home directory"))?;
    Ok(PathBuf::from(home).join(".teleflock"))
}

fn local_hostd_name() -> &'static str {
    if cfg!(windows) { "tf-hostd.exe" } else { "tf-hostd" }
}

async fn read_trim(path: &Path) -> String {
    tokio::fs::read_to_string(path).await.map(|s| s.trim().to_string()).unwrap_or_default()
}

async fn version_of(t: &dyn Transport, hostd: &str) -> String {
    match t.exec(&Cmd::new([hostd, "--version"]).timeout(Duration::from_secs(15))).await {
        Ok(out) if out.status.success() => {
            String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or_default().trim().to_string()
        }
        _ => String::new(),
    }
}

/// Probes the local machine (Local kind).
pub async fn probe_local(t: &dyn Transport) -> Result<Probe, ApiError> {
    let home = local_home()?;
    let hostd = home.join("bin").join(local_hostd_name());
    let version = if hostd.is_file() { version_of(t, &hostd.to_string_lossy()).await } else { String::new() };
    Ok(Probe {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        home: home.to_string_lossy().into_owned(),
        version,
        hostd_sha: read_trim(&home.join("bin").join(format!("{}.sha256", local_hostd_name()))).await,
        ext_sha: read_trim(&home.join("ext").join("teleflock-bridge.ts.sha256")).await,
        overlay_sha: read_trim(&home.join("omp-overlay.yml.sha256")).await,
    })
}

pub async fn probe(t: &dyn Transport, kind: HostKind) -> Result<Probe, ApiError> {
    if kind == HostKind::Local { probe_local(t).await } else { probe_remote(t).await }
}

/// Deploys tf-hostd, the extension and the overlay; `progress` receives human status lines.
pub async fn deploy(
    t: &dyn Transport,
    kind: HostKind,
    relay_port: u16,
    artifacts: &Artifacts,
    progress: &(dyn Fn(String) + Send + Sync),
) -> Result<Deployed, ApiError> {
    progress("Checking host…".into());
    let p = probe(t, kind).await?;
    let local = kind == HostKind::Local;
    let sep = if local && cfg!(windows) { '\\' } else { '/' };
    let hostd_path = if local {
        format!("{}{sep}bin{sep}{}", p.home, local_hostd_name())
    } else {
        format!("{}/bin/tf-hostd", p.home)
    };
    if host_is_newer(&p.version) {
        // Its extension and overlay belong to that newer build too.
        progress(format!("Using the newer tf-hostd on this host ({})…", p.version));
        return Ok(Deployed { hostd: hostd_path, replaced: false, newer: Some(p.version) });
    }
    let bin = artifacts.hostd(&p.os, &p.arch).await?;
    let ext = artifacts.bridge_ext()?;
    let overlay = overlay_yaml(relay_port);
    let ext_sha = sha256_hex(ext.as_bytes());
    let overlay_sha = sha256_hex(overlay.as_bytes());
    let expected = expected_version_line();
    let need_hostd = p.hostd_sha != bin.sha || p.version != expected;

    if need_hostd {
        let mb = bin.len as f64 / 1_048_576.0;
        progress(format!("Uploading tf-hostd {HOSTD_VERSION} ({mb:.1} MB, {})…", bin.triple));
        let sha = bin.sha.clone();
        let bytes = bin.into_bytes().await?;
        if local {
            install_local(t, Path::new(&hostd_path), &bytes, &sha).await?;
        } else {
            upload_remote(t, &p.home, "bin/tf-hostd", bytes, &sha, true).await?;
        }
        let v = version_of(t, &hostd_path).await;
        if v != expected {
            return Err(ApiError::new(
                "version_mismatch",
                format!("deployed tf-hostd reports `{v}`, this app expects `{expected}`"),
            )
            .with_hint("rebuild tf-hostd and the app from the same source tree"));
        }
    }
    if p.ext_sha != ext_sha {
        progress("Uploading companion extension…".into());
        put_file(t, local, &p.home, "ext/teleflock-bridge.ts", ext.as_bytes(), &ext_sha).await?;
    }
    if p.overlay_sha != overlay_sha {
        put_file(t, local, &p.home, "omp-overlay.yml", overlay.as_bytes(), &overlay_sha).await?;
    }
    Ok(Deployed { hostd: hostd_path, replaced: need_hostd && !p.version.is_empty(), newer: None })
}

async fn put_file(
    t: &dyn Transport,
    local: bool,
    home: &str,
    rel: &str,
    bytes: &[u8],
    sha: &str,
) -> Result<(), ApiError> {
    if local {
        let path = rel.split('/').fold(PathBuf::from(home), |p, c| p.join(c));
        write_atomic(&path, bytes).await.map_err(|e| io_err(&format!("write {}", path.display()), e))?;
        let stamp = path.with_file_name(format!("{}.sha256", path.file_name().unwrap().to_string_lossy()));
        write_atomic(&stamp, sha.as_bytes()).await.map_err(|e| io_err(&format!("write {}", stamp.display()), e))
    } else {
        upload_remote(t, home, rel, bytes.to_vec(), sha, false).await
    }
}

/// `exec` with the payload on stdin: write to a temp file, verify its sha256 against `sha`
/// (a truncated or corrupted upload never replaces the installed file), chmod, rename,
/// then stamp. `rel` is a fixed relative path made of safe characters (`bin/tf-hostd`).
pub fn upload_script(home: &str, rel: &str, sha: &str, executable: bool) -> String {
    let dir = rel.rsplit_once('/').map(|(d, _)| format!("/{d}")).unwrap_or_default();
    format!(
        "set -e\numask 077\nH={h}\nmkdir -p \"$H{dir}\"\nt=\"$H/{rel}.tmp.$$\"\ntrap 'rm -f \"$t\"' EXIT\ncat > \"$t\"\n\
         if command -v sha256sum >/dev/null 2>&1; then a=$(sha256sum \"$t\")\n\
         elif command -v shasum >/dev/null 2>&1; then a=$(shasum -a 256 \"$t\")\n\
         else echo 'neither sha256sum nor shasum is installed on the host' >&2; exit 3; fi\n\
         a=${{a%% *}}\n\
         if [ \"$a\" != {sha} ]; then echo \"checksum mismatch for {rel}: got $a, expected \"{sha} >&2; exit 4; fi\n\
         chmod {mode} \"$t\"\nmv -f \"$t\" \"$H/{rel}\"\nprintf '%s' {sha} > \"$H/{rel}.sha256\"\n",
        h = sh_quote(home),
        mode = if executable { "755" } else { "644" },
        sha = sh_quote(sha),
    )
}

async fn upload_remote(
    t: &dyn Transport,
    home: &str,
    rel: &str,
    bytes: Vec<u8>,
    sha: &str,
    executable: bool,
) -> Result<(), ApiError> {
    let script = upload_script(home, rel, sha, executable);
    let out = t
        .exec(
            &Cmd::new(["sh".to_string(), "-c".to_string(), script])
                .stdin(bytes)
                .timeout(Duration::from_secs(600)),
        )
        .await?;
    if !out.status.success() {
        return Err(exec_err(&format!("upload {rel}"), &out));
    }
    Ok(())
}

/// Local install of the hostd binary. On Windows a running daemon locks its exe, so stop it
/// with the old binary and retry once.
async fn install_local(t: &dyn Transport, dst: &Path, bytes: &[u8], sha: &str) -> Result<(), ApiError> {
    let dir = dst.parent().unwrap();
    tokio::fs::create_dir_all(dir).await.map_err(|e| io_err(&format!("create {}", dir.display()), e))?;
    let tmp = dir.join(format!(".tf-hostd.{}.tmp", std::process::id()));
    tokio::fs::write(&tmp, bytes).await.map_err(|e| io_err(&format!("write {}", tmp.display()), e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
            .await
            .map_err(|e| io_err("chmod tf-hostd", e))?;
    }
    if let Err(first) = tokio::fs::rename(&tmp, dst).await {
        if dst.is_file() {
            let _ = t
                .exec(&Cmd::new([dst.to_string_lossy().into_owned(), "stop".into()]).timeout(Duration::from_secs(15)))
                .await;
        }
        if let Err(e) = tokio::fs::rename(&tmp, dst).await {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(io_err(&format!("install {} ({first})", dst.display()), e));
        }
    }
    let stamp = dst.with_file_name(format!("{}.sha256", local_hostd_name()));
    write_atomic(&stamp, sha.as_bytes()).await.map_err(|e| io_err("write tf-hostd stamp", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn triples() {
        assert_eq!(triples_for("Linux", "x86_64")[0], "x86_64-unknown-linux-musl");
        assert_eq!(triples_for("Linux", "aarch64")[0], "aarch64-unknown-linux-musl");
        assert_eq!(triples_for("Darwin", "arm64")[0], "aarch64-apple-darwin");
        assert_eq!(triples_for("windows", "x86_64")[0], "x86_64-pc-windows-msvc");
        assert!(triples_for("Linux", "riscv64").is_empty());
    }

    #[test]
    fn probe_parsing() {
        let out = "Welcome to host!\ntf.uname=Linux x86_64\ntf.home=/home/a/.teleflock\ntf.version=tf-hostd 0.1.0 proto 1\ntf.hostd=abc\ntf.ext=\ntf.overlay=def\n";
        let p = parse_probe(out).unwrap();
        assert_eq!((p.os.as_str(), p.arch.as_str()), ("Linux", "x86_64"));
        assert_eq!(p.home, "/home/a/.teleflock");
        assert_eq!(p.version, "tf-hostd 0.1.0 proto 1");
        assert_eq!(p.hostd_sha, "abc");
        assert_eq!(p.ext_sha, "");
        assert_eq!(p.overlay_sha, "def");
        assert!(parse_probe("garbage").is_err());
    }

    #[test]
    fn overlay() {
        let y = overlay_yaml(47591);
        assert!(y.contains("autoStart: control"));
        assert!(y.contains("relayUrl: ws://127.0.0.1:47591"));
    }

    async fn run_upload(home: &str, sha: &str, payload: &[u8]) -> std::process::Output {
        let script = upload_script(home, "ext/teleflock-bridge.ts", sha, false);
        let mut child = tokio::process::Command::new("sh")
            .args(["-c", &script])
            .stdin(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use tokio::io::AsyncWriteExt;
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(payload).await.unwrap();
        drop(stdin);
        child.wait_with_output().await.unwrap()
    }

    #[tokio::test]
    async fn upload_script_runs() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home with space").to_string_lossy().into_owned();
        let payload = b"export default 1;\n";
        let sha = sha256_hex(payload);
        assert!(run_upload(&home, &sha, payload).await.status.success());
        let base = Path::new(&home).join("ext");
        assert_eq!(std::fs::read_to_string(base.join("teleflock-bridge.ts")).unwrap(), "export default 1;\n");
        assert_eq!(std::fs::read_to_string(base.join("teleflock-bridge.ts.sha256")).unwrap(), sha);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&home).unwrap().permissions().mode() & 0o777, 0o700, "umask 077 home");
            assert_eq!(std::fs::metadata(base.join("teleflock-bridge.ts")).unwrap().permissions().mode() & 0o777, 0o644);
        }

        // A payload that doesn't hash to the expected sha never replaces the file.
        let out = run_upload(&home, &sha, b"export default 2;\n").await;
        assert!(!out.status.success());
        assert!(String::from_utf8_lossy(&out.stderr).contains("checksum mismatch"), "{out:?}");
        assert_eq!(std::fs::read_to_string(base.join("teleflock-bridge.ts")).unwrap(), "export default 1;\n");
        assert_eq!(std::fs::read_to_string(base.join("teleflock-bridge.ts.sha256")).unwrap(), sha);
        let leftovers: Vec<_> = std::fs::read_dir(&base).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().contains(".tmp.")).collect();
        assert!(leftovers.is_empty(), "temp file removed");
    }

    /// Every embedded binary decompresses to exactly the bytes its stamp describes.
    #[tokio::test]
    async fn embedded_bins_roundtrip() {
        for b in embedded::HOSTD_BINS {
            let bin = HostdBin {
                triple: b.triple.into(),
                sha: b.sha256.into(),
                len: b.len,
                payload: Payload::Zstd(b.zstd),
            };
            let bytes = bin.into_bytes().await.unwrap();
            assert_eq!(bytes.len(), b.len, "{}", b.triple);
            assert_eq!(sha256_hex(&bytes), b.sha256, "{}", b.triple);
            assert!(b.zstd.len() < b.len, "{} is compressed", b.triple);
        }
    }

    /// `(raw, zstd(raw))`, static like the embedded tables.
    static SAMPLE: LazyLock<(Vec<u8>, Vec<u8>)> = LazyLock::new(|| {
        let raw: Vec<u8> = (0..200_000u32).flat_map(|i| (i % 251).to_le_bytes()).collect();
        let z = ruzstd::encoding::compress_to_vec(raw.as_slice(), ruzstd::encoding::CompressionLevel::Fastest);
        (raw, z)
    });

    #[tokio::test]
    async fn zstd_payload_decodes() {
        let (raw, z) = &*SAMPLE;
        let bin = HostdBin { triple: "t".into(), sha: sha256_hex(raw), len: raw.len(), payload: Payload::Zstd(z) };
        assert_eq!(&bin.into_bytes().await.unwrap(), raw);
    }

    #[tokio::test]
    async fn missing_triple_is_named() {
        let a = Artifacts::default();
        if Artifacts::embedded_triples().contains(&"aarch64-apple-darwin") {
            return;
        }
        let e = a.hostd("Darwin", "arm64").await.err().unwrap();
        assert!(e.message.contains("aarch64-apple-darwin"), "{}", e.message);
    }
}
