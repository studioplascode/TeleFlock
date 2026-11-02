//! The HTTP side of an agent's connection, as Chrome's DevTools server answers it: `/json/version`
//! (its `webSocketDebuggerUrl` built from the request's `Host`, so a plain port relay works),
//! `/json/list` with the agent's pages only, `/json/new` (an agent's tab), `/json/close/<id>` and
//! `/json/activate/<id>` on its pages only, `/json/protocol`, and the WebSocket upgrade to
//! `/devtools/browser/…` (the agent's filtered view of the browser) or `/devtools/page/<id>` (one
//! of its pages). Like Chrome, requests with a `Host` that is not an IP address or `localhost`
//! (DNS rebinding) and WebSocket upgrades that carry an `Origin` (web pages) are refused.

use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;

use super::filter::{Root, url_allowed};
use super::registry::Vis;
use super::{AttachKey, CdpProxy, session};

/// The longest request head accepted.
const MAX_HEAD: usize = 16 * 1024;
/// The largest request body read (and ignored).
const MAX_BODY: usize = 1 << 20;
/// How long the browser's own HTTP answers may take.
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(10);

/// A request head.
#[derive(Debug, PartialEq)]
pub(super) struct Request {
    pub method: String,
    pub path: String,
    pub host: Option<String>,
    pub origin: Option<String>,
    pub ws_key: Option<String>,
    pub upgrade: bool,
    pub close: bool,
    pub body: usize,
}

/// Parses a request head at the start of `buf`: `Ok(None)` while it is incomplete, else the
/// request and the head's length.
pub(super) fn parse(buf: &[u8]) -> Result<Option<(Request, usize)>, ()> {
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut req = httparse::Request::new(&mut headers);
    let n = match req.parse(buf) {
        Ok(httparse::Status::Complete(n)) => n,
        Ok(httparse::Status::Partial) => return Ok(None),
        Err(_) => return Err(()),
    };
    let header = |name: &str| {
        req.headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case(name))
            .and_then(|h| std::str::from_utf8(h.value).ok())
            .map(|v| v.trim().to_string())
    };
    let has = |name: &str, token: &str| {
        header(name).is_some_and(|v| v.split(',').any(|t| t.trim().eq_ignore_ascii_case(token)))
    };
    let close = has("Connection", "close") || (req.version == Some(0) && !has("Connection", "keep-alive"));
    let r = Request {
        method: req.method.unwrap_or_default().to_string(),
        path: req.path.unwrap_or_default().to_string(),
        host: header("Host"),
        origin: header("Origin"),
        ws_key: header("Sec-WebSocket-Key"),
        upgrade: has("Upgrade", "websocket") && has("Connection", "upgrade"),
        close,
        body: header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0),
    };
    Ok(Some((r, n)))
}

/// Chrome's rule against DNS rebinding: a `Host` must be an IP address or `localhost`.
pub(super) fn host_ok(host: Option<&str>) -> bool {
    let Some(h) = host else { return true };
    let name = match h.strip_prefix('[') {
        Some(v6) => return v6.split(']').next().is_some_and(|a| a.parse::<IpAddr>().is_ok()),
        None => h.rsplit_once(':').map_or(h, |(n, _)| n),
    };
    name.eq_ignore_ascii_case("localhost") || name.parse::<IpAddr>().is_ok()
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Ok(v) = u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("zz"), 16)
        {
            out.push(v);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn respond<IO: AsyncWrite + Unpin>(io: &mut IO, code: u16, body: &str, close: bool) -> std::io::Result<()> {
    let reason = match code {
        200 => "OK",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: application/json; charset=UTF-8\r\nContent-Length: {}\r\n{}\r\n",
        body.len(),
        if close { "Connection: close\r\n" } else { "" }
    );
    io.write_all(head.as_bytes()).await?;
    io.write_all(body.as_bytes()).await?;
    io.flush().await
}

/// Serves one agent connection (`conn`) until it closes or `stop` carries a reason.
pub(super) async fn serve<IO>(px: Arc<CdpProxy>, mut io: IO, who: AttachKey, conn: u64, mut stop: watch::Receiver<Option<String>>)
where
    IO: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let mut buf: Vec<u8> = Vec::with_capacity(2048);
    loop {
        let (req, head) = loop {
            match parse(&buf) {
                Ok(Some(r)) => break r,
                Ok(None) if buf.len() > MAX_HEAD => {
                    let _ = respond(&mut io, 431, "Request header too large", true).await;
                    return;
                }
                Ok(None) => {}
                Err(()) => {
                    let _ = respond(&mut io, 500, "Malformed request", true).await;
                    return;
                }
            }
            let mut chunk = [0u8; 4096];
            let n = tokio::select! {
                r = io.read(&mut chunk) => r,
                _ = stop.changed() => return,
            };
            match n {
                Ok(n) if n > 0 => buf.extend_from_slice(&chunk[..n]),
                _ => return,
            }
            if stop.borrow().is_some() {
                return;
            }
        };
        if req.body > MAX_BODY {
            let _ = respond(&mut io, 500, "Request body too large", true).await;
            return;
        }
        while buf.len() < head + req.body {
            let mut chunk = [0u8; 4096];
            match io.read(&mut chunk).await {
                Ok(n) if n > 0 => buf.extend_from_slice(&chunk[..n]),
                _ => return,
            }
        }
        let rest = buf.split_off(head + req.body);
        buf = rest;
        if !px.with_reg(|r| r.is_attached(&who)) || stop.borrow().is_some() {
            let _ = respond(&mut io, 403, "This agent is not attached to the browser.", true).await;
            return;
        }
        if !host_ok(req.host.as_deref()) {
            let _ = respond(&mut io, 500, "Host header is specified and is not an IP address or localhost.", true).await;
            return;
        }
        if req.upgrade {
            upgrade(px, io, buf, who, conn, stop, req).await;
            return;
        }
        let (code, body) = json_command(&px, &who, &req).await;
        if respond(&mut io, code, &body, req.close).await.is_err() || req.close {
            return;
        }
    }
}

/// The WebSocket upgrade: the agent's filtered DevTools session.
async fn upgrade<IO>(
    px: Arc<CdpProxy>,
    mut io: IO,
    leftover: Vec<u8>,
    who: AttachKey,
    conn: u64,
    stop: watch::Receiver<Option<String>>,
    req: Request,
) where
    IO: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    if let Some(origin) = &req.origin {
        let msg = format!("Rejected an incoming WebSocket connection from the {origin} origin.");
        let _ = respond(&mut io, 403, &msg, true).await;
        return;
    }
    let path = req.path.split('?').next().unwrap_or_default();
    let root = if path == "/devtools/browser" || path.starts_with("/devtools/browser/") {
        Root::Browser
    } else if let Some(id) = path.strip_prefix("/devtools/page/")
        && px.with_reg(|r| r.id_vis(&who, id) == Vis::Mine)
    {
        Root::Page(id.to_string())
    } else {
        let _ = respond(&mut io, 404, &format!("No such target id: {}", path.rsplit('/').next().unwrap_or_default()), true).await;
        return;
    };
    let (Some(key), true) = (req.ws_key.as_deref(), req.method == "GET") else {
        let _ = respond(&mut io, 500, "Bad WebSocket upgrade request", true).await;
        return;
    };
    let accept = derive_accept_key(key.as_bytes());
    let head = format!(
        "HTTP/1.1 101 WebSocket Protocol Handshake\r\nUpgrade: WebSocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
    );
    if io.write_all(head.as_bytes()).await.is_err() || io.flush().await.is_err() {
        return;
    }
    session::run(px, io, leftover, who, root, conn, stop).await;
}

/// A `/json/…` request: status and body.
async fn json_command(px: &Arc<CdpProxy>, who: &AttachKey, req: &Request) -> (u16, String) {
    let host = req.host.clone().unwrap_or_else(|| "localhost".into());
    let (path, query) = req.path.split_once('?').unwrap_or((req.path.as_str(), ""));
    let path = path.trim_end_matches('/');
    let port = px.port();
    let (cmd, arg) = match path.strip_prefix("/json") {
        Some("") | Some("/list") => ("list", ""),
        Some(rest) => {
            let rest = rest.trim_start_matches('/');
            rest.split_once('/').unwrap_or((rest, ""))
        }
        None => return (404, "Not found".into()),
    };
    match cmd {
        "version" => match get(port, "/json/version").await {
            Ok((200, body)) => match serde_json::from_str::<Value>(&body) {
                Ok(mut v) => {
                    let id = v.get("webSocketDebuggerUrl").and_then(Value::as_str).and_then(|u| u.rsplit('/').next()).unwrap_or("browser");
                    v["webSocketDebuggerUrl"] = json!(format!("ws://{host}/devtools/browser/{id}"));
                    (200, pretty(&v))
                }
                Err(_) => (502, "The browser answered nonsense.".into()),
            },
            other => upstream_failed(other),
        },
        "list" => match px.list(who, &host).await {
            Ok(v) => (200, pretty(&Value::Array(v))),
            Err(e) => (502, e),
        },
        "new" if req.method != "PUT" => {
            (405, format!("Using unsafe HTTP verb {} to invoke /json/new. This action supports only PUT verb.", req.method))
        }
        "new" => {
            let url = if query.is_empty() { "about:blank".to_string() } else { percent_decode(query) };
            if !url_allowed(&url) {
                return (403, "TeleFlock refused /json/new: agents may only open web pages (http, https, data, blob, about:blank)".into());
            }
            match px.open_tab(who, &url).await {
                Ok(page) => {
                    let entry = px.list(who, &host).await.ok().and_then(|l| l.into_iter().find(|e| e["id"] == json!(page)));
                    let entry = entry.unwrap_or_else(|| {
                        json!({
                            "description": "",
                            "id": page,
                            "title": "",
                            "type": "page",
                            "url": url,
                            "webSocketDebuggerUrl": format!("ws://{host}/devtools/page/{page}"),
                        })
                    });
                    (200, pretty(&entry))
                }
                Err(e) => (500, e),
            }
        }
        "close" | "activate" => {
            let vis = px.with_reg(|r| r.id_vis(who, arg));
            if vis == Vis::TakenOver {
                return (403, super::filter::TAKEN_OVER.into());
            }
            if arg.is_empty() || vis != Vis::Mine {
                return (404, format!("No such target id: {arg}"));
            }
            let method = if cmd == "close" { "Target.closeTarget" } else { "Target.activateTarget" };
            match px.call(method, json!({ "targetId": arg })).await {
                Ok(_) if cmd == "close" => (200, "Target is closing".into()),
                Ok(_) => (200, "Target activated".into()),
                Err(e) => (404, format!("No such target id: {arg} ({e})")),
            }
        }
        "protocol" => match get(port, "/json/protocol").await {
            Ok((200, body)) => (200, body),
            other => upstream_failed(other),
        },
        other => (404, format!("Unknown command: {other}")),
    }
}

fn upstream_failed(r: Result<(u16, String), String>) -> (u16, String) {
    match r {
        Ok((code, body)) => (code, body),
        Err(e) => (502, format!("The browser does not answer: {e}")),
    }
}

fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

/// The browser's own `/json/list` entries of `who`'s pages, their URLs pointing at `host`.
pub(super) fn list_for(entries: Vec<Value>, port: u16, host: &str, mine: impl Fn(&str) -> bool) -> Vec<Value> {
    let ours = format!("127.0.0.1:{port}");
    entries
        .into_iter()
        .filter(|e| e.get("type").and_then(Value::as_str) == Some("page"))
        .filter(|e| e.get("id").and_then(Value::as_str).is_some_and(&mine))
        .map(|mut e| {
            let id = e.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
            e["webSocketDebuggerUrl"] = json!(format!("ws://{host}/devtools/page/{id}"));
            if let Some(f) = e.get("devtoolsFrontendUrl").and_then(Value::as_str) {
                let f = f.replace(&ours, host);
                e["devtoolsFrontendUrl"] = json!(f);
            }
            e
        })
        .collect()
}

/// A GET to the browser's own DevTools HTTP server: status and body. Chrome keeps the connection
/// open after answering (whatever `Connection` says): the answer ends at its `Content-Length`.
pub(super) async fn get(port: u16, path: &str) -> Result<(u16, String), String> {
    let fetch = async {
        let mut tcp = TcpStream::connect(("127.0.0.1", port)).await.map_err(|e| e.to_string())?;
        let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
        tcp.write_all(req.as_bytes()).await.map_err(|e| e.to_string())?;
        let mut raw = Vec::new();
        loop {
            let mut chunk = [0u8; 8192];
            let n = tcp.read(&mut chunk).await.map_err(|e| e.to_string())?;
            raw.extend_from_slice(&chunk[..n]);
            let mut headers = [httparse::EMPTY_HEADER; 32];
            let mut resp = httparse::Response::new(&mut headers);
            let head = match resp.parse(&raw) {
                Ok(httparse::Status::Complete(head)) => head,
                Ok(httparse::Status::Partial) if n > 0 => continue,
                _ => return Err("malformed answer".to_string()),
            };
            let len = resp
                .headers
                .iter()
                .find(|h| h.name.eq_ignore_ascii_case("Content-Length"))
                .and_then(|h| std::str::from_utf8(h.value).ok()?.trim().parse::<usize>().ok());
            let body = &raw[head..];
            match len {
                Some(l) if body.len() >= l => {
                    return Ok((resp.code.unwrap_or(0), String::from_utf8_lossy(&body[..l]).into_owned()));
                }
                // Without a length the answer ends with the connection.
                None if n == 0 => return Ok((resp.code.unwrap_or(0), String::from_utf8_lossy(body).into_owned())),
                _ if n == 0 => return Err("the answer was cut short".to_string()),
                _ => {}
            }
        }
    };
    tokio::time::timeout(UPSTREAM_TIMEOUT, fetch).await.map_err(|_| "timed out".to_string())?
}

/// The browser target's WebSocket URL (`/json/version`).
pub(super) async fn browser_ws_url(port: u16) -> Result<String, String> {
    let (code, body) = get(port, "/json/version").await?;
    if code != 200 {
        return Err(format!("/json/version answered {code}"));
    }
    let v: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    v.get("webSocketDebuggerUrl").and_then(Value::as_str).map(String::from).ok_or_else(|| "no webSocketDebuggerUrl".into())
}
