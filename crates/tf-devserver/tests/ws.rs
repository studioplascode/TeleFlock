use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tf_client::{Engine, EngineConfig};
use tf_devserver::{Access, DevPlatform, Keepalive, router, serve};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

const TOKEN: &str = "test-token-0123456789abcdef0123456789";

async fn start(static_dir: Option<std::path::PathBuf>) -> (std::net::SocketAddr, tempfile::TempDir) {
    start_with(static_dir, &[]).await
}

async fn start_with(static_dir: Option<std::path::PathBuf>, allow_hosts: &[&str]) -> (std::net::SocketAddr, tempfile::TempDir) {
    let data = tempfile::tempdir().unwrap();
    let (engine, _rx) = Engine::start(
        EngineConfig {
            data_dir: data.path().to_path_buf(),
            platform_name: "linux".into(),
            client_app: "teleflock-devserver".into(),
            version: "0.0.0".into(),
            hostd_bins_override: None,
        },
        Arc::new(DevPlatform),
    )
    .await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let hosts: Vec<String> = allow_hosts.iter().map(|h| h.to_string()).collect();
    let access = Access::new(TOKEN.into(), addr, &hosts, &[]).unwrap();
    tokio::spawn(serve(listener, router(engine, static_dir, access, Keepalive::default())));
    (addr, data)
}

/// Opens `/ws` with optional overrides; returns the HTTP status of a rejected handshake.
async fn ws_connect(
    url: &str,
    host: Option<&str>,
    origin: Option<&str>,
    protocol: Option<&str>,
) -> Result<
    (
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        tokio_tungstenite::tungstenite::handshake::client::Response,
    ),
    StatusCode,
> {
    let mut req = url.into_client_request().unwrap();
    let h = req.headers_mut();
    if let Some(v) = host {
        h.insert("Host", HeaderValue::from_str(v).unwrap());
    }
    if let Some(v) = origin {
        h.insert("Origin", HeaderValue::from_str(v).unwrap());
    }
    if let Some(v) = protocol {
        h.insert("Sec-WebSocket-Protocol", HeaderValue::from_str(v).unwrap());
    }
    match tokio_tungstenite::connect_async(req).await {
        Ok(ok) => Ok(ok),
        Err(WsError::Http(resp)) => Err(resp.status()),
        Err(e) => panic!("unexpected ws error: {e}"),
    }
}

async fn next_json<S>(ws: &mut S) -> Value
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        let m = tokio::time::timeout(Duration::from_secs(10), ws.next()).await.unwrap().unwrap().unwrap();
        if let Message::Text(t) = m {
            return serde_json::from_str(t.as_str()).unwrap();
        }
    }
}

#[tokio::test]
async fn websocket_protocol() {
    let (addr, _data) = start(None).await;
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws?token={TOKEN}")).await.unwrap();

    // Replay first.
    let types: Vec<String> = {
        let mut v = Vec::new();
        for _ in 0..3 {
            v.push(next_json(&mut ws).await["event"]["type"].as_str().unwrap().to_string());
        }
        v
    };
    assert_eq!(types, ["profiles", "settings", "tunnels"]);

    ws.send(Message::Text(json!({"id": 1, "method": "app.info"}).to_string().into())).await.unwrap();
    let r = next_json(&mut ws).await;
    assert_eq!(r["id"], 1);
    assert_eq!(r["result"]["platform"], "linux");
    assert_eq!(r["result"]["capabilities"]["notifications"], false);

    // Fast path frames never get a response; the next frame is the reply to id 2.
    ws.send(Message::Text(json!({"termIn": {"hostId": "x", "termId": "t", "data": "a"}}).to_string().into()))
        .await
        .unwrap();
    ws.send(Message::Text(
        json!({"id": "two", "method": "hosts.save", "params": {
            "id": "lab", "name": "Lab", "kind": "local", "herdrSession": "tf-lab", "autoConnect": false
        }})
        .to_string()
        .into(),
    ))
    .await
    .unwrap();
    let mut got_profiles = false;
    let mut got_result = false;
    while !(got_profiles && got_result) {
        let v = next_json(&mut ws).await;
        if v["event"]["type"] == "profiles" {
            assert_eq!(v["event"]["profiles"][0]["id"], "lab");
            got_profiles = true;
        } else if v["id"] == "two" {
            assert_eq!(v["result"]["herdrSession"], "tf-lab");
            got_result = true;
        }
    }

    ws.send(Message::Text(json!({"id": 3, "hostId": "lab", "method": "fs.home"}).to_string().into())).await.unwrap();
    loop {
        let v = next_json(&mut ws).await;
        if v["id"] == 3 {
            assert_eq!(v["error"]["code"], "not_connected");
            break;
        }
    }
    ws.send(Message::Text(json!({"id": 4, "method": "bogus"}).to_string().into())).await.unwrap();
    loop {
        let v = next_json(&mut ws).await;
        if v["id"] == 4 {
            assert_eq!(v["error"]["code"], "unknown_method");
            break;
        }
    }

    // A second client gets the saved host in its replay.
    let (mut ws2, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws?token={TOKEN}")).await.unwrap();
    let first = next_json(&mut ws2).await;
    assert_eq!(first["event"]["profiles"][0]["name"], "Lab");
}

#[tokio::test]
async fn cswsh_foreign_origin_rejected_even_with_token() {
    let (addr, _data) = start(None).await;
    let url = format!("ws://{addr}/ws?token={TOKEN}");
    for origin in ["http://evil.example", "null", &format!("http://localhost:{}", addr.port())] {
        assert_eq!(ws_connect(&url, None, Some(origin), None).await.err(), Some(StatusCode::FORBIDDEN), "{origin}");
    }
    let proto = format!("teleflock.{TOKEN}");
    let r = ws_connect(&format!("ws://{addr}/ws"), None, Some("https://evil.example"), Some(&proto)).await;
    assert_eq!(r.err(), Some(StatusCode::FORBIDDEN));
}

#[tokio::test]
async fn cswsh_missing_token_rejected() {
    let (addr, _data) = start(None).await;
    let same = format!("http://{addr}");
    assert_eq!(ws_connect(&format!("ws://{addr}/ws"), None, Some(&same), None).await.err(), Some(StatusCode::UNAUTHORIZED));
    assert_eq!(ws_connect(&format!("ws://{addr}/ws"), None, None, None).await.err(), Some(StatusCode::UNAUTHORIZED));
    assert_eq!(ws_connect(&format!("ws://{addr}/ws?token="), None, None, None).await.err(), Some(StatusCode::UNAUTHORIZED));
}

#[tokio::test]
async fn cswsh_wrong_token_rejected() {
    let (addr, _data) = start(None).await;
    let same = format!("http://{addr}");
    let wrong = "test-token-0123456789abcdef0123456788";
    let r = ws_connect(&format!("ws://{addr}/ws?token={wrong}"), None, Some(&same), None).await;
    assert_eq!(r.err(), Some(StatusCode::UNAUTHORIZED));
    let r = ws_connect(&format!("ws://{addr}/ws"), None, Some(&same), Some(&format!("teleflock.{wrong}"))).await;
    assert_eq!(r.err(), Some(StatusCode::UNAUTHORIZED));
    let r = ws_connect(&format!("ws://{addr}/ws"), None, Some(&same), Some(TOKEN)).await;
    assert_eq!(r.err(), Some(StatusCode::UNAUTHORIZED));
}

#[tokio::test]
async fn dns_rebinding_bad_host_rejected() {
    let dist = tempfile::tempdir().unwrap();
    std::fs::write(dist.path().join("index.html"), "<html><head></head>teleflock</html>").unwrap();
    let (addr, _data) = start(Some(dist.path().to_path_buf())).await;
    let evil = format!("rebind.evil.example:{}", addr.port());
    let url = format!("ws://{addr}/ws?token={TOKEN}");
    let r = ws_connect(&url, Some(&evil), Some(&format!("http://{evil}")), None).await;
    assert_eq!(r.err(), Some(StatusCode::MISDIRECTED_REQUEST));
    let r = ws_connect(&url, Some(&evil), None, None).await;
    assert_eq!(r.err(), Some(StatusCode::MISDIRECTED_REQUEST));
    // Static routes too: the index (and its token) never reaches a rebound origin.
    for path in ["/", "/index.html", "/board/x"] {
        let resp = http_get(addr, path, &evil).await;
        assert!(resp.starts_with("HTTP/1.1 421"), "{path}: {resp}");
        assert!(!resp.contains(TOKEN));
    }
}

#[tokio::test]
async fn same_origin_with_token_accepted() {
    let (addr, _data) = start(None).await;
    let same = format!("http://{addr}");
    // Query token.
    let (mut ws, resp) = ws_connect(&format!("ws://{addr}/ws?token={TOKEN}"), None, Some(&same), None).await.unwrap();
    assert!(resp.headers().get("sec-websocket-protocol").is_none());
    assert_eq!(next_json(&mut ws).await["event"]["type"], "profiles");
    // Subprotocol token, echoed back (tungstenite fails the handshake otherwise).
    let proto = format!("teleflock.{TOKEN}");
    let (mut ws, resp) = ws_connect(&format!("ws://{addr}/ws"), None, Some(&same), Some(&proto)).await.unwrap();
    assert_eq!(resp.headers().get("sec-websocket-protocol").unwrap(), proto.as_str());
    assert_eq!(next_json(&mut ws).await["event"]["type"], "profiles");
    // `localhost` is an allowed name for the bound port.
    let local = format!("localhost:{}", addr.port());
    let r = ws_connect(&format!("ws://{addr}/ws?token={TOKEN}"), Some(&local), Some(&format!("http://{local}")), None).await;
    assert!(r.is_ok());
}

async fn http_get(addr: std::net::SocketAddr, path: &str, host: &str) -> String {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    s.write_all(format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).await.unwrap();
    out
}

#[tokio::test]
async fn static_with_spa_fallback_and_token_meta() {
    let dist = tempfile::tempdir().unwrap();
    std::fs::write(dist.path().join("index.html"), "<!doctype html><html><head><title>teleflock</title></head></html>").unwrap();
    std::fs::create_dir(dist.path().join("assets")).unwrap();
    std::fs::write(dist.path().join("assets/app.js"), "console.log(1)").unwrap();
    let (addr, _data) = start_with(Some(dist.path().to_path_buf()), &["dev.example"]).await;
    let host = addr.to_string();
    let meta = format!(r#"<head><meta name="tf-token" content="{TOKEN}"><title>teleflock</title>"#);
    let js = http_get(addr, "/assets/app.js", &host).await;
    assert!(js.starts_with("HTTP/1.1 200"), "{js}");
    assert!(js.contains("console.log(1)"));
    assert!(!js.contains(TOKEN));
    for path in ["/", "/index.html", "/board/whatever", "/assets/"] {
        let page = http_get(addr, path, &host).await;
        assert!(page.starts_with("HTTP/1.1 200"), "{path}: {page}");
        assert!(page.contains(&meta), "{path}: {page}");
        assert!(page.to_ascii_lowercase().contains("cache-control: no-store"), "{path}: {page}");
    }
    let local = http_get(addr, "/", &format!("localhost:{}", addr.port())).await;
    assert!(local.contains(&meta), "{local}");
    // An `--allow-host` name may be a reverse proxy for remote clients: no token unless the page
    // URL already carries it.
    let proxied = http_get(addr, "/board/x", "dev.example").await;
    assert!(proxied.starts_with("HTTP/1.1 200"), "{proxied}");
    assert!(proxied.contains("<title>teleflock</title>") && !proxied.contains(TOKEN), "{proxied}");
    let wrong = http_get(addr, "/?token=nope", "dev.example").await;
    assert!(!wrong.contains(TOKEN), "{wrong}");
    let with_token = http_get(addr, &format!("/board/x?token={TOKEN}"), "dev.example").await;
    assert!(with_token.contains(&meta), "{with_token}");
}
