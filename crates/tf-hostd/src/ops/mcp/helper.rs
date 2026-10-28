//! Runs the MCP helper extension (`host/teleflock-mcp/teleflock-mcp.ts`, embedded here) in a
//! throwaway headless omp, so status, tools, sign-in and registry search use omp's own code
//! (architecture §3.15 "Helper"). One request per process:
//!
//! ```text
//! omp --mode rpc --no-session --no-skills --no-rules --no-lsp --no-tools --no-extensions -e <home>/ext/teleflock-mcp.ts
//!     # cwd = the folder the request is about; env TF_MCP_IN / TF_MCP_OUT [/ TF_MCP_INPUT], NO_COLOR=1
//! ```
//!
//! The request goes through an owner-only file the helper deletes on read (it may hold a draft's
//! secrets); answers come back as JSON lines appended to the output file: `hello`, events
//! (`auth`, `progress`), then one `result` or `error` line. Nothing travels on argv.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde_json::Value;
use tf_proto::ApiError;
use tokio::io::AsyncReadExt;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// The helper, embedded so it always matches this tf-hostd.
pub const SOURCE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../host/teleflock-mcp/teleflock-mcp.ts"));
const FILE_NAME: &str = "teleflock-mcp.ts";
/// Helper processes at once (each starts omp and maybe several MCP servers).
const MAX_RUNNING: usize = 4;
const POLL: Duration = Duration::from_millis(100);
/// Kept from the helper's stderr for error messages.
const STDERR_TAIL: usize = 2048;

static SLOTS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(MAX_RUNNING)));
/// Serializes writing the helper file (concurrent first runs).
static WRITE: Mutex<()> = Mutex::new(());

/// Where and with what the helper runs.
#[derive(Debug, Clone)]
pub struct HelperEnv {
    pub omp: Option<PathBuf>,
    /// `<home>/ext` (the helper is written there).
    pub ext_dir: PathBuf,
    /// `<home>/run` (owner-only request / answer files).
    pub run_dir: PathBuf,
    /// Tests and labs: the omp agent dir for the child (`PI_CODING_AGENT_DIR`).
    pub agent_dir: Option<PathBuf>,
}

impl HelperEnv {
    fn omp(&self) -> Result<&Path, ApiError> {
        self.omp.as_deref().ok_or_else(|| {
            ApiError::new("omp_error", "omp is not installed on this host").with_hint("Install omp (Host setup) to check MCP servers and sign in.")
        })
    }

    /// Writes the embedded helper when the file is missing or differs (an older tf-hostd's copy).
    fn ensure_file(&self) -> Result<PathBuf, ApiError> {
        let path = self.ext_dir.join(FILE_NAME);
        let _g = WRITE.lock().unwrap_or_else(|p| p.into_inner());
        if std::fs::read(&path).is_ok_and(|b| b == SOURCE.as_bytes()) {
            return Ok(path);
        }
        let io = |e: std::io::Error| ApiError::new("io_error", format!("{}: {e}", path.display()));
        std::fs::create_dir_all(&self.ext_dir).map_err(io)?;
        let tmp = self.ext_dir.join(format!(".{FILE_NAME}.{}.tmp", std::process::id()));
        std::fs::write(&tmp, SOURCE).map_err(io)?;
        std::fs::rename(&tmp, &path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            io(e)
        })?;
        Ok(path)
    }

    fn scratch(&self, stem: &str) -> Result<PathBuf, ApiError> {
        create_private_dir(&self.run_dir).map_err(|e| ApiError::new("io_error", format!("{}: {e}", self.run_dir.display())))?;
        let nanos = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        Ok(self.run_dir.join(format!("mcp-{stem}-{}-{nanos}", std::process::id())))
    }
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    b.create(dir)
}

/// Writes `bytes` to a new owner-only file (`O_EXCL`), then renames it to `path`.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let tmp = PathBuf::from(format!("{}.tmp", path.display()));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    let res = opts.open(&tmp).and_then(|mut f| f.write_all(bytes)).and_then(|()| std::fs::rename(&tmp, path));
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

/// One running helper. Dropping it kills the process and removes its files.
pub struct Running {
    child: tokio::process::Child,
    req: PathBuf,
    out: PathBuf,
    input: PathBuf,
    offset: usize,
    pending: Vec<u8>,
    stderr: Arc<Mutex<Vec<u8>>>,
    exited: bool,
    _slot: OwnedSemaphorePermit,
}

impl Running {
    /// Starts the helper for `req` (`{op, …}`) with `cwd` as omp's folder.
    pub async fn start(env: &HelperEnv, cwd: &Path, mut req: Value) -> Result<Running, ApiError> {
        let omp = env.omp()?.to_path_buf();
        let slot = SLOTS.clone().acquire_owned().await.map_err(|_| ApiError::new("internal", "helper slots closed"))?;
        let ext = env.ensure_file()?;
        let stem = req.get("op").and_then(Value::as_str).unwrap_or("op").to_string();
        let base = env.scratch(&stem)?;
        let (req_path, out, input) = (base.with_extension("in.json"), base.with_extension("out.jsonl"), base.with_extension("input"));
        if let Some(o) = req.as_object_mut() {
            o.insert("v".into(), 1.into());
        }
        write_private(&req_path, req.to_string().as_bytes()).map_err(|e| ApiError::new("io_error", format!("helper request: {e}")))?;
        let mut cmd = tokio::process::Command::new(&omp);
        cmd.args(["--mode", "rpc", "--no-session", "--no-skills", "--no-rules", "--no-lsp", "--no-tools", "--no-extensions", "-e"])
            .arg(&ext)
            .current_dir(cwd)
            .env("TF_MCP_IN", &req_path)
            .env("TF_MCP_OUT", &out)
            .env("TF_MCP_INPUT", &input)
            .env("NO_COLOR", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(dir) = &env.agent_dir {
            cmd.env("PI_CODING_AGENT_DIR", dir);
        }
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = cmd.spawn().map_err(|e| {
            let _ = std::fs::remove_file(&req_path);
            ApiError::new("omp_error", format!("start omp: {e}"))
        })?;
        let stderr = Arc::new(Mutex::new(Vec::new()));
        if let Some(mut pipe) = child.stderr.take() {
            let tail = stderr.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                while let Ok(n) = pipe.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    let mut t = tail.lock().unwrap_or_else(|p| p.into_inner());
                    t.extend_from_slice(&buf[..n]);
                    let over = t.len().saturating_sub(STDERR_TAIL);
                    t.drain(..over);
                }
            });
        }
        Ok(Running { child, req: req_path, out, input, offset: 0, pending: Vec::new(), stderr, exited: false, _slot: slot })
    }

    /// The next answer line; `None` once the process exited and every line was read.
    pub async fn next(&mut self) -> Option<Value> {
        loop {
            if let Some(v) = self.take_line() {
                return Some(v);
            }
            if self.exited {
                return None;
            }
            // Read after checking the exit status: the helper writes, then exits.
            self.exited = matches!(self.child.try_wait(), Ok(Some(_)) | Err(_));
            if self.read_more() {
                continue;
            }
            if !self.exited {
                tokio::time::sleep(POLL).await;
            }
        }
    }

    fn take_line(&mut self) -> Option<Value> {
        while let Some(nl) = self.pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=nl).collect();
            if let Ok(v) = serde_json::from_slice::<Value>(&line) {
                return Some(v);
            }
        }
        None
    }

    /// Appends new bytes of the output file to `pending`; whether there were any.
    fn read_more(&mut self) -> bool {
        let Ok(bytes) = std::fs::read(&self.out) else { return false };
        if bytes.len() <= self.offset {
            return false;
        }
        self.pending.extend_from_slice(&bytes[self.offset..]);
        self.offset = bytes.len();
        true
    }

    /// Hands pasted text to the helper (omp's `onManualCodeInput`).
    pub fn send_input(&self, text: &str) -> Result<(), ApiError> {
        let _ = std::fs::remove_file(&self.input);
        write_private(&self.input, text.as_bytes()).map_err(|e| ApiError::new("io_error", format!("hand the sign-in input to omp: {e}")))
    }

    pub async fn kill(&mut self) {
        let _ = self.child.kill().await;
        self.exited = true;
    }

    /// The end of the helper's stderr (omp's own message when it failed before answering).
    pub fn stderr_tail(&self) -> String {
        let t = self.stderr.lock().unwrap_or_else(|p| p.into_inner());
        String::from_utf8_lossy(&t).trim().lines().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" ")
    }

    /// Waits for the `result` (Ok) or `error` (Err) line, giving up after `timeout`. Events
    /// before it go to `on_event`.
    pub async fn finish(&mut self, timeout: Duration, mut on_event: impl FnMut(&Value)) -> Result<Value, ApiError> {
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(left, self.next()).await {
                Ok(Some(line)) => match line.get("t").and_then(Value::as_str) {
                    Some("result") => return Ok(line),
                    Some("error") => return Err(helper_error(&line)),
                    _ => on_event(&line),
                },
                Ok(None) => {
                    let tail = self.stderr_tail();
                    let detail = if tail.is_empty() { String::new() } else { format!(": {}", crate::util::clip(&tail, 300)) };
                    return Err(ApiError::new("omp_error", format!("omp exited without an answer{detail}")));
                }
                Err(_) => {
                    self.kill().await;
                    return Err(ApiError::new("timeout", format!("omp did not answer within {}s", timeout.as_secs())).retryable());
                }
            }
        }
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
        for p in [&self.req, &self.out, &self.input] {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// The helper's `error` line as an [`ApiError`].
pub fn helper_error(line: &Value) -> ApiError {
    let code = line.get("code").and_then(Value::as_str).unwrap_or("omp_error");
    let msg = line.get("message").and_then(Value::as_str).unwrap_or("failed").to_string();
    match code {
        "unsupported" => ApiError::new("unsupported", msg).with_hint("Update omp on the host (Host setup → Tools)."),
        "not_found" => ApiError::new("not_found", msg),
        "invalid_params" | "refused" => ApiError::new("invalid_params", msg),
        "cancelled" => ApiError::new("cancelled", msg),
        _ => ApiError::new("omp_error", msg),
    }
}

/// One request, start to answer.
pub async fn call(env: &HelperEnv, cwd: &Path, req: Value, timeout: Duration) -> Result<Value, ApiError> {
    let mut run = Running::start(env, cwd, req).await?;
    run.finish(timeout, |_| {}).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in omp (a shell script) that follows the helper protocol.
    #[cfg(unix)]
    fn fake_omp(dir: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let p = dir.join("omp");
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[cfg(unix)]
    fn env(dir: &Path, omp: PathBuf) -> HelperEnv {
        HelperEnv { omp: Some(omp), ext_dir: dir.join("ext"), run_dir: dir.join("run"), agent_dir: None }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn request_travels_in_a_private_file_and_events_come_before_the_result() {
        let td = tempfile::tempdir().unwrap();
        let omp = fake_omp(
            td.path(),
            r#"stat -c %a "$TF_MCP_IN" > "$TF_MCP_OUT.mode"; cp "$TF_MCP_IN" "$TF_MCP_OUT.req"; rm -f "$TF_MCP_IN"
case "$*" in *--no-extensions*-e*teleflock-mcp.ts*) ;; *) exit 9;; esac
printf '{"t":"hello","ompVersion":"18.13.2"}\n{"t":"progress","message":"half' >> "$TF_MCP_OUT"; sleep 0.3
printf 'way"}\n{"t":"result","ok":true}\n' >> "$TF_MCP_OUT""#,
        );
        let e = env(td.path(), omp);
        let mut run = Running::start(&e, td.path(), serde_json::json!({"op": "test", "config": {"env": {"API_KEY": "sk-secret"}}})).await.unwrap();
        let out = run.out.clone();
        let mut events = Vec::new();
        let res = run.finish(Duration::from_secs(10), |l| events.push(l.clone())).await.unwrap();
        assert_eq!(res["ok"], true);
        assert_eq!(events.iter().filter_map(|l| l["message"].as_str()).collect::<Vec<_>>(), ["halfway"], "a line split across writes is read whole");
        assert_eq!(std::fs::read_to_string(format!("{}.mode", out.display())).unwrap().trim(), "600");
        let req: Value = serde_json::from_str(&std::fs::read_to_string(format!("{}.req", out.display())).unwrap()).unwrap();
        assert_eq!((req["v"].as_u64(), req["op"].as_str()), (Some(1), Some("test")));
        assert_eq!(std::fs::read_to_string(e.ext_dir.join(FILE_NAME)).unwrap(), SOURCE, "helper written next to the bridge");
        drop(run);
        assert!(!out.exists(), "answer file removed");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn errors_exits_and_timeouts_are_reported() {
        let td = tempfile::tempdir().unwrap();
        let e = env(td.path(), fake_omp(td.path(), r#"printf '{"t":"error","code":"unsupported","message":"omp 18.0.0 lacks mcp/manager"}\n' >> "$TF_MCP_OUT""#));
        let err = call(&e, td.path(), serde_json::json!({"op": "probe"}), Duration::from_secs(10)).await.unwrap_err();
        assert_eq!(err.code, "unsupported");
        assert!(err.hint.is_some());

        let e = env(td.path(), fake_omp(td.path(), "echo 'No default model selected.' >&2; exit 1"));
        let err = call(&e, td.path(), serde_json::json!({"op": "probe"}), Duration::from_secs(10)).await.unwrap_err();
        assert_eq!(err.code, "omp_error");
        assert!(err.message.contains("No default model selected"), "{}", err.message);

        let e = env(td.path(), fake_omp(td.path(), "sleep 30"));
        let started = Instant::now();
        let err = call(&e, td.path(), serde_json::json!({"op": "probe"}), Duration::from_millis(500)).await.unwrap_err();
        assert_eq!(err.code, "timeout");
        assert!(started.elapsed() < Duration::from_secs(5), "killed, not waited for");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pasted_input_reaches_the_helper() {
        let td = tempfile::tempdir().unwrap();
        let e = env(
            td.path(),
            fake_omp(
                td.path(),
                r#"printf '{"t":"auth","url":"https://idp/authorize"}\n' >> "$TF_MCP_OUT"
while [ ! -f "$TF_MCP_INPUT" ]; do sleep 0.05; done
v=$(cat "$TF_MCP_INPUT"); rm -f "$TF_MCP_INPUT"
printf '{"t":"result","got":"%s"}\n' "$v" >> "$TF_MCP_OUT""#,
            ),
        );
        let mut run = Running::start(&e, td.path(), serde_json::json!({"op": "auth"})).await.unwrap();
        let first = run.next().await.unwrap();
        assert_eq!(first["t"], "auth");
        run.send_input("http://localhost:3000/callback?code=c&state=s").unwrap();
        let res = run.finish(Duration::from_secs(10), |_| {}).await.unwrap();
        assert_eq!(res["got"], "http://localhost:3000/callback?code=c&state=s");
    }
}
