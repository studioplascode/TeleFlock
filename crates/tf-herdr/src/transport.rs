//! Socket / named-pipe transport. herdr answers **one request per connection**; only
//! `events.subscribe` and the wait-style methods keep their connection open.

use crate::error::{HerdrError, Result, code};
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

/// Where the herdr API listens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    /// Socket path (unix) or marker-file path (Windows; the pipe is `\\.\pipe\` + this path).
    pub socket: PathBuf,
}

impl Endpoint {
    pub fn new(socket: impl Into<PathBuf>) -> Self {
        Self { socket: socket.into() }
    }

    /// The Windows pipe name derived from the socket path (herdr uses the full path string).
    pub fn pipe_name(&self) -> String {
        format!(r"\\.\pipe\{}", self.socket.to_string_lossy())
    }
}

pub(crate) trait Conn: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Conn for T {}

pub(crate) type BoxConn = Box<dyn Conn>;

fn not_running(path: &Path, err: impl std::fmt::Display) -> HerdrError {
    HerdrError::new(
        code::SERVER_NOT_RUNNING,
        format!("no herdr server is reachable at {}: {err}", path.display()),
    )
}

#[cfg(unix)]
pub(crate) async fn connect(ep: &Endpoint) -> Result<BoxConn> {
    use std::io::ErrorKind;
    match tokio::net::UnixStream::connect(&ep.socket).await {
        Ok(s) => Ok(Box::new(s)),
        Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::ConnectionRefused) => {
            Err(not_running(&ep.socket, e))
        }
        Err(e) => Err(HerdrError::transport(&format!("connect {}", ep.socket.display()), e)),
    }
}

#[cfg(windows)]
pub(crate) async fn connect(ep: &Endpoint) -> Result<BoxConn> {
    use tokio::net::windows::named_pipe::ClientOptions;
    const ERROR_FILE_NOT_FOUND: i32 = 2;
    const ERROR_PIPE_BUSY: i32 = 231;
    let name = ep.pipe_name();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        match ClientOptions::new().open(&name) {
            Ok(p) => return Ok(Box::new(p)),
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) && tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(e) if e.raw_os_error() == Some(ERROR_FILE_NOT_FOUND) => return Err(not_running(&ep.socket, e)),
            Err(e) => return Err(HerdrError::transport(&format!("open pipe {name}"), e)),
        }
    }
}

/// `{"id","result"}` / `{"id","error"}` envelope (both 0.9.0 and 0.9.2+ shapes).
#[derive(Deserialize)]
struct Envelope {
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<ErrorBody>,
}

#[derive(Deserialize)]
struct ErrorBody {
    #[serde(default)]
    code: String,
    #[serde(default)]
    message: String,
}

/// Parse one response line into the `result` object or a typed error.
pub fn parse_response(line: &str) -> Result<Value> {
    let env: Envelope =
        serde_json::from_str(line).map_err(|e| HerdrError::protocol("invalid herdr response", e))?;
    if let Some(err) = env.error {
        return Err(HerdrError::from_server(err.code, err.message));
    }
    env.result.ok_or_else(|| HerdrError::protocol("invalid herdr response", "neither result nor error"))
}

pub(crate) fn request_line(id: &str, method: &str, params: &Value) -> Result<Vec<u8>> {
    let params = if params.is_null() { Value::Object(Default::default()) } else { params.clone() };
    let mut line = serde_json::to_vec(&serde_json::json!({ "id": id, "method": method, "params": params }))
        .map_err(|e| HerdrError::protocol("encode request", e))?;
    line.push(b'\n');
    Ok(line)
}

/// Read one newline-terminated line. EOF before a full line is a transport error.
pub(crate) async fn read_line<R: AsyncRead + Unpin>(r: &mut BufReader<R>, buf: &mut String) -> Result<()> {
    buf.clear();
    let n = r.read_line(buf).await.map_err(|e| HerdrError::transport("read", e))?;
    if n == 0 {
        return Err(HerdrError::transport("read", "connection closed by herdr"));
    }
    Ok(())
}

/// One request on a fresh connection, bounded by `timeout` end to end.
pub(crate) async fn one_shot(ep: &Endpoint, id: &str, method: &str, params: &Value, timeout: Duration) -> Result<Value> {
    let line = request_line(id, method, params)?;
    let fut = async {
        let mut conn = connect(ep).await?;
        conn.write_all(&line).await.map_err(|e| HerdrError::transport("write", e))?;
        conn.flush().await.map_err(|e| HerdrError::transport("flush", e))?;
        let mut reader = BufReader::new(conn);
        let mut buf = String::new();
        read_line(&mut reader, &mut buf).await?;
        parse_response(buf.trim_end())
    };
    match tokio::time::timeout(timeout, fut).await {
        Ok(r) => r,
        Err(_) => Err(HerdrError::timeout(method)),
    }
}
