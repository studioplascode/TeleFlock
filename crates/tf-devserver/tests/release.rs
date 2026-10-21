//! A tab that goes away releases the terminals it opened (`term.close` reaches tf-hostd), whether
//! it sent a close frame, dropped the TCP connection, or went silent (keepalive timeout).
//! Runs against the scripted tf-hostd from tf-client's test data over the real Local transport.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tf_client::tf_proto::{AppEvent, ConnPhase, PROTOCOL_VERSION};
use tf_client::{Engine, EngineConfig, HOSTD_VERSION};
use tf_devserver::{Access, DevPlatform, Keepalive, router, serve};
use tokio_tungstenite::tungstenite::Message;

const TOKEN: &str = "test-token-0123456789abcdef0123456789";
const FAKE_HOSTD: &str = include_str!("../../tf-client/src/testdata/fake-tf-hostd.py");

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn host_state() -> Value {
    json!({
        "info": {
            "hostname": "lab", "os": "linux", "arch": "x86_64", "home": "/root", "hostdVersion": "fake",
            "herdrSession": "tf-lab", "herdrSessions": ["tf-lab"], "relayPort": 47999,
            "setup": { "herdrIntegration": true, "globalSharing": false, "globalBridge": false, "relay": true, "issues": [] }
        },
        "workspaces": [], "agents": [],
        "usage": { "costUsd": 0.0, "tokens": 0, "input": 0, "output": 0 }
    })
}

/// `term.close` requests tf-hostd has received so far.
fn closed_terms(home: &Path) -> Vec<String> {
    std::fs::read_to_string(home.join("requests.log"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v["method"] == "term.close")
        .filter_map(|v| v["params"]["termId"].as_str().map(String::from))
        .collect()
}

async fn wait_closed(home: &Path, term: &str, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if closed_terms(home).iter().any(|t| t == term) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    false
}

/// Opens a terminal over `ws` and returns its id (skipping event frames).
async fn open_term(ws: &mut Ws, id: u64) -> String {
    let req = json!({ "id": id, "hostId": "lab", "method": "term.open", "params": {
        "target": { "kind": "pane", "paneId": "w1:p1" }, "cols": 80, "rows": 24, "mode": "control", "takeover": false
    }});
    ws.send(Message::Text(req.to_string().into())).await.unwrap();
    loop {
        let m = tokio::time::timeout(Duration::from_secs(10), ws.next()).await.unwrap().unwrap().unwrap();
        if let Message::Text(t) = m {
            let v: Value = serde_json::from_str(t.as_str()).unwrap();
            if v["id"] == id {
                return v["result"]["termId"].as_str().unwrap_or_else(|| panic!("{v}")).to_string();
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closed_tabs_release_their_terminals() {
    let home = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    // SAFETY: this test binary has a single test; set before the engine reads it.
    unsafe { std::env::set_var("TF_HOSTD_HOME", home.path()) };
    let bin = data.path().join("fake-tf-hostd");
    std::fs::write(&bin, FAKE_HOSTD.replace("@VERSION@", &format!("tf-hostd {HOSTD_VERSION} proto {PROTOCOL_VERSION}"))).unwrap();
    std::fs::write(home.path().join("state.json"), host_state().to_string()).unwrap();

    let (engine, mut rx) = Engine::start(
        EngineConfig {
            data_dir: data.path().to_path_buf(),
            platform_name: "linux".into(),
            client_app: "teleflock-devserver".into(),
            version: "0.0.0".into(),
            hostd_bins_override: Some(bin),
        },
        Arc::new(DevPlatform),
    )
    .await;
    let profile = json!({ "id": "lab", "name": "Lab", "kind": "local", "herdrSession": "tf-lab", "autoConnect": true });
    engine.call(None, "hosts.save", profile).await.unwrap();
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if let Ok(AppEvent::HostStatus { status, .. }) = rx.recv().await
                && status.phase == ConnPhase::Online
            {
                break;
            }
        }
    })
    .await
    .expect("host online");

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let access = Access::new(TOKEN.into(), addr, &[], &[]).unwrap();
    let keepalive = Keepalive { ping_every: Duration::from_millis(100), timeout: Duration::from_millis(500) };
    tokio::spawn(serve(listener, router(engine, None, access, keepalive)));
    let url = format!("ws://{addr}/ws?token={TOKEN}");
    let connect = || async { tokio_tungstenite::connect_async(url.as_str()).await.unwrap().0 };

    // 1. Reload / tab close: the browser sends a close frame.
    let mut a = connect().await;
    let ta = open_term(&mut a, 1).await;
    a.close(None).await.unwrap();
    assert!(wait_closed(home.path(), &ta, Duration::from_secs(5)).await, "close frame releases {ta}");

    // 2. The connection drops without a close frame (process killed, socket reset).
    let mut b = connect().await;
    let tb = open_term(&mut b, 2).await;
    drop(b);
    assert!(wait_closed(home.path(), &tb, Duration::from_secs(5)).await, "TCP drop releases {tb}");

    // 3. A live client that answers pings keeps its terminal past the timeout…
    let mut c = connect().await;
    let tc = open_term(&mut c, 3).await;
    let until = Instant::now() + Duration::from_millis(1200);
    while Instant::now() < until {
        // Reading lets tungstenite answer the server's pings.
        let _ = tokio::time::timeout(Duration::from_millis(50), c.next()).await;
    }
    assert!(!closed_terms(home.path()).contains(&tc), "an active tab keeps {tc}");

    // 4. …but once it goes silent (half-open: no FIN, no pongs) the keepalive releases it.
    let started = Instant::now();
    assert!(wait_closed(home.path(), &tc, Duration::from_secs(5)).await, "silent socket releases {tc}");
    assert!(started.elapsed() >= Duration::from_millis(300), "released by the timeout, not early");
    drop(c);
}
