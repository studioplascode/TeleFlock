//! `HerdrClient`: discovery, server lifecycle and the raw request primitive.

use crate::error::{HerdrError, Result, code};
use crate::model::{Pong, SessionEntry, Status};
use crate::transport::{self, Endpoint};
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

/// Default end-to-end timeout for one request (connect + write + response).
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Extra slack added on top of herdr-side timeouts for wait-style methods.
pub(crate) const WAIT_SLACK: Duration = Duration::from_secs(5);
/// How long `ensure_server` waits for a freshly spawned server to answer `ping`.
pub const SERVER_START_TIMEOUT: Duration = Duration::from_secs(15);
/// Oldest server version TeleFlock's feature set is built against.
pub const MIN_SERVER_VERSION: (u32, u32, u32) = (0, 9, 0);

/// Environment inherited from a herdr pane that would silently redirect the CLI to
/// another session. Stripped from every child we spawn; we always pass the target explicitly.
const PANE_ENV: &[&str] = &["HERDR_SOCKET_PATH", "HERDR_SESSION", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"];

/// Overrides for [`HerdrClient::discover_with`].
#[derive(Debug, Clone)]
pub struct DiscoverOptions {
    /// Use this herdr binary instead of searching for one.
    pub bin: Option<PathBuf>,
    /// Use this API socket path (unix) / marker path (Windows) instead of resolving it.
    pub socket: Option<PathBuf>,
    /// End-to-end timeout for ordinary requests.
    pub request_timeout: Duration,
}

impl Default for DiscoverOptions {
    fn default() -> Self {
        Self { bin: None, socket: None, request_timeout: DEFAULT_REQUEST_TIMEOUT }
    }
}

/// Client for one herdr session on this host. Cheap to clone.
#[derive(Clone)]
pub struct HerdrClient {
    pub(crate) inner: Arc<Inner>,
}

pub(crate) struct Inner {
    pub(crate) session: Option<String>,
    pub(crate) bin: PathBuf,
    pub(crate) endpoint: Endpoint,
    pub(crate) timeout: Duration,
    next_id: AtomicU64,
    server: RwLock<Option<Pong>>,
}

impl std::fmt::Debug for HerdrClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HerdrClient")
            .field("session", &self.inner.session)
            .field("bin", &self.inner.bin)
            .field("socket", &self.inner.endpoint.socket)
            .finish()
    }
}

impl HerdrClient {
    /// Discover herdr for `session` (`None` = the default session): locate the binary,
    /// resolve the API socket (via `status --json`, falling back to the standard layout)
    /// and `ping` the server if it runs. A stopped server is not an error; call
    /// [`ensure_server`](Self::ensure_server) to start it.
    pub async fn discover(session: Option<&str>) -> Result<Self> {
        Self::discover_with(session, DiscoverOptions::default()).await
    }

    pub async fn discover_with(session: Option<&str>, opts: DiscoverOptions) -> Result<Self> {
        let session = match session {
            Some(s) => Some(validate_session(s)?.to_owned()),
            None => None,
        };
        let bin = match opts.bin {
            Some(b) => b,
            None => locate_binary().ok_or_else(|| {
                HerdrError::new(code::BINARY_NOT_FOUND, "herdr binary not found on PATH or in the known install locations")
            })?,
        };
        let mut client = Self {
            inner: Arc::new(Inner {
                session,
                bin,
                endpoint: Endpoint::new(PathBuf::new()),
                timeout: opts.request_timeout,
                next_id: AtomicU64::new(1),
                server: RwLock::new(None),
            }),
        };
        let socket = match opts.socket {
            Some(s) => s,
            None => match client.status().await {
                Ok(st) => st
                    .server
                    .socket
                    .filter(|s| !s.is_empty())
                    .map(PathBuf::from)
                    .unwrap_or_else(|| default_socket_path(client.session())),
                Err(e) => {
                    log::warn!("herdr status --json failed ({e}); using the default socket layout");
                    default_socket_path(client.session())
                }
            },
        };
        Arc::get_mut(&mut client.inner).expect("unshared during discovery").endpoint = Endpoint::new(socket);
        match client.ping().await {
            Ok(p) => log::info!("herdr {} (protocol {}) at {}", p.version, p.protocol, client.endpoint().socket.display()),
            Err(e) if e.is_server_not_running() => log::info!("herdr server not running at {}", client.endpoint().socket.display()),
            Err(e) => return Err(e),
        }
        Ok(client)
    }

    /// The herdr session name, `None` for the default session.
    pub fn session(&self) -> Option<&str> {
        self.inner.session.as_deref()
    }

    pub fn binary(&self) -> &Path {
        &self.inner.bin
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.inner.endpoint
    }

    /// The last `ping` result (server version, protocol, capabilities), if the server answered.
    pub fn server(&self) -> Option<Pong> {
        self.inner.server.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Ping the running server and cache its version.
    pub async fn ping(&self) -> Result<Pong> {
        let res = self.request::<Pong>("ping", serde_json::json!({})).await;
        let mut slot = self.inner.server.write().unwrap_or_else(|e| e.into_inner());
        match &res {
            Ok(p) => *slot = Some(p.clone()),
            Err(e) if e.is_server_not_running() => *slot = None,
            Err(_) => {}
        }
        res
    }

    /// True when the server version is at least `(major, minor, patch)`.
    pub fn server_at_least(&self, min: (u32, u32, u32)) -> bool {
        self.server().and_then(|p| parse_version(&p.version)).is_some_and(|v| v >= min)
    }

    /// `herdr [--session S] status --json` (client + server + update info).
    pub async fn status(&self) -> Result<Status> {
        let out = self.run_cli(&["status", "--json"], self.inner.timeout).await?;
        serde_json::from_slice(&out).map_err(|e| HerdrError::protocol("status --json", e))
    }

    /// `herdr session list --json`.
    pub async fn list_sessions(&self) -> Result<Vec<SessionEntry>> {
        #[derive(serde::Deserialize)]
        struct L {
            #[serde(default)]
            sessions: Vec<SessionEntry>,
        }
        let out = self.run_cli(&["session", "list", "--json"], self.inner.timeout).await?;
        serde_json::from_slice::<L>(&out).map(|l| l.sessions).map_err(|e| HerdrError::protocol("session list --json", e))
    }

    /// Make sure the session server runs: ping, else spawn it detached
    /// (`setsid`, stdin from `/dev/null`) and wait until it answers.
    pub async fn ensure_server(&self) -> Result<Pong> {
        match self.ping().await {
            Ok(p) => return Ok(p),
            Err(e) if e.is_server_not_running() => {}
            Err(e) => return Err(e),
        }
        log::info!("starting herdr server for session {:?}", self.session().unwrap_or("default"));
        self.spawn_server()?;
        let deadline = tokio::time::Instant::now() + SERVER_START_TIMEOUT;
        let mut last = None;
        while tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
            match self.ping().await {
                Ok(p) => return Ok(p),
                Err(e) => last = Some(e),
            }
        }
        Err(HerdrError::new(
            code::SERVER_NOT_RUNNING,
            format!(
                "herdr server did not come up within {}s{}",
                SERVER_START_TIMEOUT.as_secs(),
                last.map(|e| format!(" (last error: {e})")).unwrap_or_default()
            ),
        ))
    }

    fn spawn_server(&self) -> Result<()> {
        let mut cmd = std::process::Command::new(&self.inner.bin);
        cmd.args(self.session_args()).arg("server");
        for k in PANE_ENV {
            cmd.env_remove(k);
        }
        cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        if let Some(home) = home_dir() {
            cmd.current_dir(home);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // SAFETY: setsid is async-signal-safe; it detaches the server from our session
            // and controlling terminal so it survives us (herdr.md §2: setsid + </dev/null).
            unsafe {
                cmd.pre_exec(|| {
                    libc::setsid();
                    Ok(())
                });
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const DETACHED_PROCESS: u32 = 0x0000_0008;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
        }
        let mut child = cmd.spawn().map_err(|e| HerdrError::transport(&format!("spawn {} server", self.inner.bin.display()), e))?;
        // Reap it if it ever exits while we live; it is otherwise fully detached.
        std::thread::Builder::new()
            .name("herdr-server-reaper".into())
            .spawn(move || {
                let _ = child.wait();
            })
            .map_err(|e| HerdrError::transport("spawn reaper thread", e))?;
        Ok(())
    }

    /// Raw request: `{"id","method","params"}` on a fresh connection. `T = serde_json::Value`
    /// yields the `result` object as is.
    pub async fn request<T: DeserializeOwned>(&self, method: &str, params: impl Serialize) -> Result<T> {
        self.request_with_timeout(method, params, self.inner.timeout).await
    }

    /// Like [`request`](Self::request) with an explicit end-to-end timeout.
    pub async fn request_with_timeout<T: DeserializeOwned>(
        &self,
        method: &str,
        params: impl Serialize,
        timeout: Duration,
    ) -> Result<T> {
        let params = serde_json::to_value(params).map_err(|e| HerdrError::protocol("encode params", e))?;
        let id = self.next_id(method);
        let value = transport::one_shot(&self.inner.endpoint, &id, method, &params, timeout).await?;
        serde_json::from_value(value).map_err(|e| HerdrError::protocol(&format!("decode {method} result"), e))
    }

    pub(crate) fn next_id(&self, method: &str) -> String {
        format!("tf:{}:{}", method, self.inner.next_id.fetch_add(1, Ordering::Relaxed))
    }

    pub(crate) fn session_args(&self) -> Vec<String> {
        match &self.inner.session {
            Some(s) => vec!["--session".into(), s.clone()],
            None => Vec::new(),
        }
    }

    /// A `herdr [--session S]` command with pane env stripped and stdio piped.
    pub(crate) fn cli_command(&self) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new(&self.inner.bin);
        cmd.args(self.session_args());
        for k in PANE_ENV {
            cmd.env_remove(k);
        }
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        cmd
    }

    /// Run a CLI command to completion; returns stdout. A JSON error envelope on stderr
    /// becomes a typed error.
    pub(crate) async fn run_cli(&self, args: &[&str], timeout: Duration) -> Result<Vec<u8>> {
        let mut cmd = self.cli_command();
        cmd.args(args);
        let what = format!("herdr {}", args.join(" "));
        let out = tokio::time::timeout(timeout, cmd.output())
            .await
            .map_err(|_| HerdrError::timeout(&what))?
            .map_err(|e| HerdrError::transport(&what, e))?;
        if out.status.success() {
            return Ok(out.stdout);
        }
        let stderr = String::from_utf8_lossy(&out.stderr);
        if let Some(line) = stderr.lines().find(|l| l.trim_start().starts_with('{'))
            && let Err(e) = transport::parse_response(line.trim())
        {
            return Err(e);
        }
        Err(HerdrError::transport(&what, format!("exit {}: {}", out.status, stderr.trim())))
    }
}

fn validate_session(s: &str) -> Result<&str> {
    if s.is_empty() || s == "." || s == ".." || s.contains(['/', '\\']) || s.chars().any(char::is_control) {
        return Err(HerdrError::new(code::INVALID_PARAMS, format!("invalid herdr session name {s:?}")));
    }
    Ok(s)
}

/// Parse `0.9.0` / `v0.9.2-beta` into a comparable tuple.
pub fn parse_version(v: &str) -> Option<(u32, u32, u32)> {
    let v = v.trim().trim_start_matches('v');
    let core = v.split(['-', '+', ' ']).next()?;
    let mut it = core.split('.').map(|p| p.parse::<u32>().ok());
    Some((it.next()??, it.next().flatten().unwrap_or(0), it.next().flatten().unwrap_or(0)))
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    if let Some(p) = std::env::var_os("USERPROFILE") {
        return Some(PathBuf::from(p));
    }
    std::env::var_os("HOME").map(PathBuf::from)
}

/// herdr's config dir: `$XDG_CONFIG_HOME/herdr`, else `~/.config/herdr` (unix) or
/// `%APPDATA%\herdr` → `%USERPROFILE%\AppData\Roaming\herdr` (Windows).
pub fn config_dir() -> PathBuf {
    if let Some(x) = std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(x).join("herdr");
    }
    #[cfg(windows)]
    {
        if let Some(a) = std::env::var_os("APPDATA").filter(|v| !v.is_empty()) {
            return PathBuf::from(a).join("herdr");
        }
        if let Some(p) = std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()) {
            return PathBuf::from(p).join("AppData").join("Roaming").join("herdr");
        }
    }
    match std::env::var_os("HOME").filter(|v| !v.is_empty()) {
        Some(h) => PathBuf::from(h).join(".config").join("herdr"),
        None => std::env::temp_dir().join("herdr"),
    }
}

/// The API socket for `session` under the standard layout:
/// default `<config>/herdr.sock`, named `<config>/sessions/<s>/herdr.sock`.
pub fn default_socket_path(session: Option<&str>) -> PathBuf {
    let base = config_dir();
    match session {
        Some(s) => base.join("sessions").join(s).join("herdr.sock"),
        None => base.join("herdr.sock"),
    }
}

fn is_executable(p: &Path) -> bool {
    let Ok(md) = std::fs::metadata(p) else { return false };
    if !md.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        md.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

const EXE: &str = if cfg!(windows) { "herdr.exe" } else { "herdr" };

/// Candidate binaries in search order (herdr.md §1, mirroring herdr's own remote probe):
/// `$TF_HERDR_BIN`, `$HERDR_BIN_PATH`, `PATH`, then the known install locations.
/// mise shims are skipped.
pub fn binary_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for var in ["TF_HERDR_BIN", "HERDR_BIN_PATH"] {
        if let Some(v) = std::env::var_os(var).filter(|v| !v.is_empty()) {
            out.push(PathBuf::from(v));
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        out.extend(std::env::split_paths(&path).map(|d| d.join(EXE)));
    }
    let home = home_dir();
    #[cfg(unix)]
    {
        if let Some(h) = &home {
            out.push(h.join(".local/bin/herdr"));
        }
        out.push("/opt/homebrew/bin/herdr".into());
        out.push("/usr/local/bin/herdr".into());
        out.push("/home/linuxbrew/.linuxbrew/bin/herdr".into());
        if let Some(h) = &home {
            let mise = h.join(".local/share/mise/installs/herdr");
            if let Ok(rd) = std::fs::read_dir(&mise) {
                let mut versions: Vec<_> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
                versions.sort_by_key(|v| std::cmp::Reverse(parse_version(v).unwrap_or_default()));
                out.extend(versions.into_iter().map(|v| mise.join(v).join("bin/herdr")));
            }
            out.push(h.join(".nix-profile/bin/herdr"));
        }
        if let Some(user) = std::env::var_os("USER") {
            out.push(PathBuf::from("/etc/profiles/per-user").join(user).join("bin/herdr"));
        }
        out.push("/run/current-system/sw/bin/herdr".into());
    }
    #[cfg(windows)]
    {
        if let Some(l) = std::env::var_os("LOCALAPPDATA") {
            out.push(PathBuf::from(l).join("Programs").join("Herdr").join("bin").join(EXE));
        }
        if let Some(h) = &home {
            out.push(h.join("AppData").join("Local").join("Programs").join("Herdr").join("bin").join(EXE));
        }
    }
    out.retain(|p| !p.to_string_lossy().replace('\\', "/").contains("/mise/shims/"));
    out
}

/// First existing, executable herdr binary.
pub fn locate_binary() -> Option<PathBuf> {
    binary_candidates().into_iter().find(|p| is_executable(p))
}
