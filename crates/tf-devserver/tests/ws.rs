use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tf_client::{Engine, EngineConfig};
use tf_devserver::{DevPlatform, router, serve};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message;

async fn start(static_dir: Option<std::path::PathBuf>) -> (std::net::SocketAddr, tempfile::TempDir) {
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
    tokio::spawn(serve(listener, router(engine, static_dir)));
    (addr, data)
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
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws")).await.unwrap();

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
    let (mut ws2, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws")).await.unwrap();
    let first = next_json(&mut ws2).await;
    assert_eq!(first["event"]["profiles"][0]["name"], "Lab");
}

async fn http_get(addr: std::net::SocketAddr, path: &str) -> String {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    s.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).await.unwrap();
    out
}

#[tokio::test]
async fn static_with_spa_fallback() {
    let dist = tempfile::tempdir().unwrap();
    std::fs::write(dist.path().join("index.html"), "<html>teleflock</html>").unwrap();
    std::fs::create_dir(dist.path().join("assets")).unwrap();
    std::fs::write(dist.path().join("assets/app.js"), "console.log(1)").unwrap();
    let (addr, _data) = start(Some(dist.path().to_path_buf())).await;
    let js = http_get(addr, "/assets/app.js").await;
    assert!(js.starts_with("HTTP/1.1 200"), "{js}");
    assert!(js.contains("console.log(1)"));
    let spa = http_get(addr, "/board/whatever").await;
    assert!(spa.starts_with("HTTP/1.1 200"), "{spa}");
    assert!(spa.contains("teleflock"));
    let root = http_get(addr, "/").await;
    assert!(root.contains("teleflock"));
}
