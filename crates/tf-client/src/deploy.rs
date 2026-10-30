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
                    zstd::bulk::decompress(z, len).map_err(|e| ApiError::new("internal", format!("embedded tf-hostd: {e}")))
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

/// A host command that failed: `io_error` (retryable), or `deploy_failed` when its output shows
/// that every attempt will fail the same way ([`deterministic`]); that code is fatal, so the
/// connection stops retrying and shows the error (conn.rs `FATAL_CODES`).
fn exec_err(what: &str, out: &tf_transport::Output) -> ApiError {
    let stderr = String::from_utf8_lossy(&out.stderr);
    let msg = stderr.trim();
    let message = format!(
        "{what} failed (exit {}){}",
        out.status.code.map(|c| c.to_string()).unwrap_or_else(|| out.status.signal.clone().unwrap_or_default()),
        if msg.is_empty() { String::new() } else { format!(": {msg}") }
    );
    match deterministic(out.status.code, msg) {
        Some(hint) => ApiError::new("deploy_failed", message).with_hint(hint),
        None => ApiError::new("io_error", message).retryable(),
    }
}

/// Why a failed host command will fail the same way on every attempt (as the hint to show), or
/// `None` when another attempt can succeed: a cold or busy WSL VM (wsl.exe's own errors exit
/// with -1), a dropped link, a corrupted transfer (checksum mismatch), a full disk, and
/// whatever a broken profile file prints on every login (it is at the top of stderr, and a
/// shell that couldn't run our script exits 2, 126 or 127, not 1). The fatal code stops all
/// retries, so it needs the exit code and the *last* lines of stderr to agree.
fn deterministic(code: Option<i32>, stderr: &str) -> Option<&'static str> {
    // What dash, bash, busybox, zsh, tcsh, fish and nushell print for a script they can't parse.
    const SYNTAX: [&str; 7] = [
        "syntax error",
        "parse error",
        "unterminated quoted string",
        "unexpected eof while looking for matching",
        "unmatched '",
        "quotes are not balanced",
        "nu::parser::",
    ];
    /// Lines of stderr that count: the shell's complaint about the script comes last.
    const TAIL_LINES: usize = 3;
    let code = code.filter(|c| matches!(c, 2 | 3 | 126 | 127))?;
    let mut tail: Vec<&str> = stderr.lines().rev().filter(|l| !l.trim().is_empty()).take(TAIL_LINES).collect();
    tail.reverse();
    let e = tail.join("\n").to_ascii_lowercase();
    if code != 3 && SYNTAX.iter().any(|p| e.contains(p)) {
        return Some(
            "The host's shell rejected TeleFlock's setup script, so retrying can't help. Copy the diagnostics and report them; the host's login shell (`echo $SHELL`) and its profile files are the usual suspects.",
        );
    }
    let missing = match code {
        3 => e.contains("neither sha256sum nor shasum"),
        126 => e.contains("permission denied"),
        127 => e.contains("not found") || e.contains("no base64 decoder"),
        _ => false,
    };
    missing.then_some("A program TeleFlock's setup needs can't run on the host (see the message). Install or fix it there, then try again.")
}

/// Runs the probe on a remote (SSH/WSL) host. 60 s: every WSL `exec` starts `wsl.exe` and a
/// login shell, which a slow laptop needs seconds for; a timeout is retryable.
pub async fn probe_remote(t: &dyn Transport) -> Result<Probe, ApiError> {
    let out = t
        .exec(&Cmd::new(["sh", "-c", PROBE_SCRIPT]).timeout(Duration::from_secs(60)))
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

/// `tf-hostd --version` (first line; empty when it exits non-zero). An error only when it could
/// not run at all (timeout, transport): retryable, unlike a binary that reports another version.
async fn run_version(t: &dyn Transport, hostd: &str) -> Result<String, ApiError> {
    let out = t.exec(&Cmd::new([hostd, "--version"]).timeout(Duration::from_secs(30))).await?;
    if !out.status.success() {
        return Ok(String::new());
    }
    Ok(String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or_default().trim().to_string())
}

async fn version_of(t: &dyn Transport, hostd: &str) -> String {
    run_version(t, hostd).await.unwrap_or_default()
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
            // Could not run it (slow host, transport hiccup): retry the connect, not a dead end.
            let v = run_version(t, &hostd_path).await?;
            if v != expected {
                return Err(version_mismatch("the deployed tf-hostd", &v, &expected, false));
            }
        } else {
            // The upload script runs its `--version` before replacing anything: no extra spawn,
            // and a binary that cannot run on the host never replaces the installed one.
            let hostd = Upload { rel: "bin/tf-hostd", sha: &sha, inline: None, hostd_version: Some(&expected) };
            upload_remote(t, &p.home, &[hostd], Some(bytes)).await?;
        }
    }
    let (put_ext, put_overlay) = (p.ext_sha != ext_sha, p.overlay_sha != overlay_sha);
    if put_ext {
        progress("Uploading the TeleFlock bridge…".into());
    }
    if local {
        if put_ext {
            put_local(&p.home, "ext/teleflock-bridge.ts", ext.as_bytes(), &ext_sha).await?;
        }
        if put_overlay {
            put_local(&p.home, "omp-overlay.yml", overlay.as_bytes(), &overlay_sha).await?;
        }
    } else if put_ext || put_overlay {
        // One exec for both: the extension on stdin, the few lines of overlay inline.
        let mut files = Vec::with_capacity(2);
        if put_ext {
            files.push(Upload { rel: "ext/teleflock-bridge.ts", sha: &ext_sha, inline: None, hostd_version: None });
        }
        if put_overlay {
            files.push(Upload { rel: "omp-overlay.yml", sha: &overlay_sha, inline: Some(&overlay), hostd_version: None });
        }
        upload_remote(t, &p.home, &files, put_ext.then(|| ext.as_bytes().to_vec())).await?;
    }
    Ok(Deployed { hostd: hostd_path, replaced: need_hostd && !p.version.is_empty(), newer: None })
}

/// The tf-hostd this app deployed does not report the version the app expects (`reported`: the
/// first line of its `--version`, empty when it did not run). Fatal: the same binary reports the
/// same on every attempt.
fn version_mismatch(what: &str, reported: &str, expected: &str, kept: bool) -> ApiError {
    let kept = if kept { " (the installed one is kept)" } else { "" };
    if reported.is_empty() {
        ApiError::new("version_mismatch", format!("{what} did not run on the host: it printed no version{kept}"))
            .with_hint("The host can't execute it: built for another CPU, a noexec mount under ~/.teleflock, or a missing loader. Copy the diagnostics and report them.")
    } else {
        ApiError::new("version_mismatch", format!("{what} reports `{reported}`, this app expects `{expected}`{kept}"))
            .with_hint("The app's bundled tf-hostd is another build: rebuild tf-hostd and the app from the same source tree.")
    }
}

async fn put_local(home: &str, rel: &str, bytes: &[u8], sha: &str) -> Result<(), ApiError> {
    let path = rel.split('/').fold(PathBuf::from(home), |p, c| p.join(c));
    write_atomic(&path, bytes).await.map_err(|e| io_err(&format!("write {}", path.display()), e))?;
    let stamp = path.with_file_name(format!("{}.sha256", path.file_name().unwrap().to_string_lossy()));
    write_atomic(&stamp, sha.as_bytes()).await.map_err(|e| io_err(&format!("write {}", stamp.display()), e))
}

/// One file [`upload_script`] installs under the tf-hostd home.
pub struct Upload<'a> {
    /// Relative path made of safe characters (`bin/tf-hostd`).
    pub rel: &'a str,
    pub sha: &'a str,
    /// Small text the script writes itself (it travels on the command line); `None`: the
    /// script's stdin, for one file at most.
    pub inline: Option<&'a str>,
    /// The file is tf-hostd: executable, and it must print this `--version` line on the host
    /// before it may replace the installed one.
    pub hostd_version: Option<&'a str>,
}

/// Script for one `exec` (one `wsl.exe` or SSH channel) that installs `files`: each is written to
/// a temp file and its sha256 verified, so a truncated or corrupted upload never replaces the
/// installed file; a tf-hostd must also report the expected version (else exit 5, with
/// `tf.version=<what it printed>` on stdout). Only once all passed is each renamed into place
/// and stamped.
pub fn upload_script(home: &str, files: &[Upload]) -> String {
    let mut lines = vec![
        "set -e".to_string(),
        "umask 077".into(),
        format!("H={}", sh_quote(home)),
        "sum() { if command -v sha256sum >/dev/null 2>&1; then a=$(sha256sum \"$1\"); \
         elif command -v shasum >/dev/null 2>&1; then a=$(shasum -a 256 \"$1\"); \
         else echo 'neither sha256sum nor shasum is installed on the host' >&2; exit 3; fi; a=${a%% *}; }"
            .into(),
    ];
    for (i, f) in files.iter().enumerate() {
        let dir = f.rel.rsplit_once('/').map(|(d, _)| format!("/{d}")).unwrap_or_default();
        lines.push(format!("mkdir -p \"$H{dir}\""));
        lines.push(format!("t{i}=\"$H/{}.tmp.$$\"", f.rel));
    }
    let temps: Vec<String> = (0..files.len()).map(|i| format!("\"$t{i}\"")).collect();
    lines.push(format!("trap 'rm -f {}' EXIT", temps.join(" ")));
    for (i, f) in files.iter().enumerate() {
        let (rel, sha) = (f.rel, sh_quote(f.sha));
        lines.push(match f.inline {
            Some(text) => format!("printf '%s' {} > \"$t{i}\"", sh_quote(text)),
            None => format!("cat > \"$t{i}\""),
        });
        lines.push(format!("sum \"$t{i}\""));
        lines.push(format!(
            "if [ \"$a\" != {sha} ]; then echo \"checksum mismatch for {rel}: got $a, expected \"{sha} >&2; exit 4; fi"
        ));
        match f.hostd_version {
            Some(v) => {
                let v = sh_quote(v);
                lines.push(format!("chmod 755 \"$t{i}\""));
                lines.push(format!("v=$(\"$t{i}\" --version 2>/dev/null | head -n 1) || true"));
                lines.push("echo \"tf.version=$v\"".into());
                lines.push(format!(
                    "if [ \"$v\" != {v} ]; then echo \"the uploaded {rel} reports '$v', expected \"{v} >&2; exit 5; fi"
                ));
            }
            None => lines.push(format!("chmod 644 \"$t{i}\"")),
        }
    }
    for (i, f) in files.iter().enumerate() {
        lines.push(format!("mv -f \"$t{i}\" \"$H/{}\"", f.rel));
        lines.push(format!("printf '%s' {} > \"$H/{}.sha256\"", sh_quote(f.sha), f.rel));
    }
    lines.join("\n") + "\n"
}

/// Runs [`upload_script`] for `files` (`stdin`: the content of the one without `inline`).
async fn upload_remote(t: &dyn Transport, home: &str, files: &[Upload<'_>], stdin: Option<Vec<u8>>) -> Result<(), ApiError> {
    let mut cmd = Cmd::new(["sh".to_string(), "-c".to_string(), upload_script(home, files)]).timeout(Duration::from_secs(600));
    cmd.stdin = stdin;
    let out = t.exec(&cmd).await?;
    if out.status.success() {
        return Ok(());
    }
    if out.status.code == Some(5)
        && let Some(expected) = files.iter().find_map(|f| f.hostd_version)
    {
        let stdout = String::from_utf8_lossy(&out.stdout);
        let v = stdout.lines().find_map(|l| l.trim_end_matches('\r').strip_prefix("tf.version=")).unwrap_or_default();
        return Err(version_mismatch("the uploaded tf-hostd", v, expected, true));
    }
    let names: Vec<&str> = files.iter().map(|f| f.rel).collect();
    Err(exec_err(&format!("upload {}", names.join(", ")), &out))
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

    fn local() -> tf_transport::LocalTransport {
        tf_transport::LocalTransport::new(tokio::sync::mpsc::channel(4).0)
    }

    /// The overlay (inline) and the extension (stdin) travel in one exec; a payload that does
    /// not hash to its sha replaces nothing, not even the file that did.
    #[tokio::test]
    async fn upload_script_runs() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home with space").to_string_lossy().into_owned();
        let read = |rel: &str| std::fs::read_to_string(Path::new(&home).join(rel)).unwrap();
        let put = |ext: &'static [u8], ext_sha: String, overlay: String| {
            let home = home.clone();
            async move {
                let overlay_sha = sha256_hex(overlay.as_bytes());
                let files = [
                    Upload { rel: "omp-overlay.yml", sha: &overlay_sha, inline: Some(&overlay), hostd_version: None },
                    Upload { rel: "ext/teleflock-bridge.ts", sha: &ext_sha, inline: None, hostd_version: None },
                ];
                upload_remote(&local(), &home, &files, Some(ext.to_vec())).await
            }
        };
        let sha = sha256_hex(b"export default 1;\n");
        put(b"export default 1;\n", sha.clone(), overlay_yaml(47591)).await.unwrap();
        assert_eq!(read("ext/teleflock-bridge.ts"), "export default 1;\n");
        assert_eq!(read("ext/teleflock-bridge.ts.sha256"), sha);
        assert_eq!(read("omp-overlay.yml"), overlay_yaml(47591));
        assert_eq!(read("omp-overlay.yml.sha256"), sha256_hex(overlay_yaml(47591).as_bytes()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |rel: &str| std::fs::metadata(Path::new(&home).join(rel)).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(""), 0o700, "umask 077 home");
            assert_eq!(mode("ext/teleflock-bridge.ts"), 0o644);
        }

        let e = put(b"export default 2;\n", sha.clone(), overlay_yaml(47592)).await.unwrap_err();
        assert!(e.message.contains("checksum mismatch for ext/teleflock-bridge.ts"), "{e:?}");
        assert!(e.retryable);
        assert_eq!(read("ext/teleflock-bridge.ts"), "export default 1;\n");
        assert_eq!(read("omp-overlay.yml"), overlay_yaml(47591));
        for d in ["", "ext"] {
            let tmp = std::fs::read_dir(Path::new(&home).join(d)).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().contains(".tmp."));
            assert_eq!(tmp.count(), 0, "temp files removed");
        }
    }

    /// An uploaded tf-hostd replaces the installed one only when it runs on the host and reports
    /// the expected version, checked by the upload itself.
    #[cfg(unix)]
    #[tokio::test]
    async fn hostd_upload_checks_the_version_before_replacing() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_string_lossy().into_owned();
        let expected = "tf-hostd 9.9.9 proto 1";
        let upload = |payload: Vec<u8>| {
            let home = home.clone();
            async move {
                let sha = sha256_hex(&payload);
                let hostd = Upload { rel: "bin/tf-hostd", sha: &sha, inline: None, hostd_version: Some(expected) };
                upload_remote(&local(), &home, &[hostd], Some(payload)).await
            }
        };
        let script = |v: &str| format!("#!/bin/sh\necho '{v}'\n").into_bytes();
        let installed = || std::fs::read(dir.path().join("bin/tf-hostd")).unwrap();
        upload(script(expected)).await.unwrap();
        assert_eq!(installed(), script(expected));
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(dir.path().join("bin/tf-hostd")).unwrap().permissions().mode() & 0o777, 0o755);

        let e = upload(script("tf-hostd 0.0.1 proto 1")).await.unwrap_err();
        assert_eq!(e.code, "version_mismatch");
        assert!(e.message.contains("reports `tf-hostd 0.0.1 proto 1`"), "{}", e.message);
        // Built for another architecture: it does not run at all.
        let e = upload(b"\x7fELF\x02\x01\x01\0\0\0\0\0\0\0\0\0".to_vec()).await.unwrap_err();
        assert_eq!(e.code, "version_mismatch");
        assert!(e.message.contains("did not run on the host") && e.hint.is_some(), "{e:?}");
        assert_eq!(installed(), script(expected), "the installed tf-hostd is kept");
        assert_eq!(std::fs::read_to_string(dir.path().join("bin/tf-hostd.sha256")).unwrap(), sha256_hex(&script(expected)));
    }

    /// A script the host's shell can't parse, or a program the setup needs that can't run, fails
    /// the same way on every attempt: fatal, with a hint. A cold WSL VM, a corrupted transfer or
    /// a full disk may pass next time.
    #[test]
    fn deterministic_failures_are_not_retried() {
        let out = |code: Option<i32>, stderr: &str| tf_transport::Output {
            status: tf_transport::ExitStatus { code, signal: code.is_none().then(|| "KILL".to_string()) },
            stdout: vec![],
            stderr: stderr.as_bytes().to_vec(),
        };
        for (code, stderr) in [
            (2, "sha256sum: 4: Syntax error: Unterminated quoted string"),
            (2, "bash: -c: line 4: syntax error near unexpected token `fi'"),
            (2, "bash: -c: line 1: unexpected EOF while looking for matching `''"),
            (2, "sh: syntax error: unterminated quoted string"),
            (2, "~/.profile: line 3: warning\nzsh:1: unmatched '"),
            (127, "teleflock bootstrap: no base64 decoder (base64, openssl, python3 or perl) found on the host"),
            (127, "fish: Unexpected end of string, quotes are not balanced"),
            (3, "neither sha256sum nor shasum is installed on the host"),
            (127, "sh: 1: base64: not found"),
            (126, "sh: 1: exec: /usr/bin/nu: Permission denied"),
        ] {
            let e = exec_err("upload bin/tf-hostd", &out(Some(code), stderr));
            assert_eq!((e.code.as_str(), e.retryable), ("deploy_failed", false), "{stderr}");
            assert!(e.message.ends_with(stderr) && e.hint.is_some(), "{e:?}");
            assert!(crate::conn::is_fatal(&e), "{e:?}");
        }
        for (code, stderr) in [
            (Some(-1), "The operation timed out because a response was not received from the virtual machine or container. Error code: Wsl/Service/CreateInstance/HCS_E_CONNECTION_TIMEOUT"),
            (Some(4), "checksum mismatch for bin/tf-hostd: got 0f, expected 1a"),
            (Some(1), "cat: write error: No space left on device"),
            (Some(127), "sh: 1: cannot open /tmp/x: No such file"),
            // Profile noise on every login must not turn a later transient failure fatal.
            (Some(1), "zsh:1: unmatched '"),
            (Some(1), "Error: nu::parser::unclosed_delimiter"),
            (Some(2), "bash: /home/u/.bashrc: line 9: syntax error: unexpected end of file\nsh: 1: base64: not found\nx\ny\nz"),
            (Some(127), "/home/u/.profile: foo: not found\ncat: write error: No space left on device\nupload failed\nretry later"),
            // wsl.exe's own failures exit with -1; a signal leaves no code.
            (Some(-1), "syntax error"),
            (None, "syntax error"),
        ] {
            let e = exec_err("upload bin/tf-hostd", &out(code, stderr));
            assert_eq!((e.code.as_str(), e.retryable), ("io_error", true), "{stderr}");
            assert!(!crate::conn::is_fatal(&e), "{e:?}");
        }
    }

    /// The report: `upload bin/tf-hostd failed (exit 2): sha256sum: 4: Syntax error: Unterminated
    /// quoted string` on every attempt, from a WSL host whose login shell was nushell. The upload
    /// runs the way WSL runs it (the bootstrap words, all plain) through a login shell that runs
    /// nothing but TeleFlock's fixed login command, so no login shell parses the script.
    #[cfg(unix)]
    #[test]
    fn reported_upload_runs_through_any_login_shell() {
        use std::io::Write;
        use std::process::Stdio;
        use tf_transport::quote;
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        // Named like a shell TeleFlock runs as a login shell (others fall back to `sh -l`); it
        // leaves a mark, so the test proves it ran.
        let shell = dir.path().join("nu");
        let strict = format!(
            "#!/bin/sh\n[ \"$1\" = -lc ] && [ \"$2\" = {} ] || {{ echo \"refused: $2\" >&2; exit 2; }}\ntouch \"$HOME/.login-shell-ran\"\nexec sh -c \"$2\"\n",
            quote::shell_quote(quote::LOGIN_COMMAND)
        );
        tf_hostd::test_exe::write_exe(&shell, strict);
        let expected = expected_version_line();
        let hostd = format!("#!/bin/sh\necho '{expected}'\n").into_bytes();
        let sha = sha256_hex(&hostd);
        let tf = home.join(".teleflock");
        let script = upload_script(&tf.to_string_lossy(), &[Upload { rel: "bin/tf-hostd", sha: &sha, inline: None, hostd_version: Some(&expected) }]);
        let words = quote::bootstrap_argv(&Cmd::new(["sh", "-c", &script]));
        assert!(words.iter().all(|w| quote::is_plain(w)), "{words:?}");
        let mut child = std::process::Command::new(&words[0])
            .args(&words[1..])
            .env_clear()
            .env("HOME", &home)
            .env("SHELL", &shell)
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(&hostd).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(std::fs::read(tf.join("bin/tf-hostd")).unwrap(), hostd);
        assert_eq!(std::fs::read_to_string(tf.join("bin/tf-hostd.sha256")).unwrap(), sha);
        assert!(home.join(".login-shell-ran").exists(), "the login shell ran");
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
        let z = zstd::bulk::compress(raw.as_slice(), 3).unwrap();
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
