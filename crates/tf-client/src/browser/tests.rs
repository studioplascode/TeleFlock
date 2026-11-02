//! The browser manager with a real Chromium: `TF_TEST_CHROME`, else a browser installed here,
//! else a Chrome for Testing in Playwright's or Puppeteer's cache. Without one the tests say so
//! and pass.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tf_proto::{ApiError, AppEvent, BrowserState, BrowserStatus, HostProfile, Notification};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

use crate::engine::{Engine, EngineConfig};

struct NullPlatform;
impl crate::platform::Platform for NullPlatform {
    fn notify(&self, _: Option<&HostProfile>, _: &Notification, _: crate::platform::NotifyStyle) {}
    fn open_external(&self, _: &str) -> Result<(), ApiError> {
        Ok(())
    }
    fn set_keep_alive(&self, _: bool) {}
    fn set_badge(&self, _: crate::platform::BadgeState) {}
    fn device_name(&self) -> String {
        "test-device".into()
    }
}

/// A Chromium to test with, or `None` (the test is skipped).
pub(super) fn test_chrome() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("TF_TEST_CHROME").map(PathBuf::from).filter(|p| super::discover::runnable(p)) {
        return Some(p);
    }
    if let Some((_, p)) = super::discover::found(std::env::consts::OS, &|k| std::env::var_os(k), None).into_iter().next() {
        return Some(p);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    for cache in [home.join(".cache/ms-playwright"), home.join(".cache/puppeteer/chrome")] {
        let Ok(entries) = std::fs::read_dir(&cache) else { continue };
        let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        dirs.sort();
        for d in dirs.iter().rev() {
            for rel in ["chrome-linux64/chrome", "chrome-linux/chrome"] {
                let p = d.join(rel);
                if super::discover::runnable(&p) {
                    return Some(p);
                }
            }
            // Puppeteer: `<platform>-<version>/chrome-linux64/chrome`.
            if let Ok(inner) = std::fs::read_dir(d) {
                for e in inner.flatten() {
                    let p = e.path().join("chrome");
                    if super::discover::runnable(&p) {
                        return Some(p);
                    }
                }
            }
        }
    }
    None
}

async fn engine(dir: &Path) -> (Engine, tokio::sync::broadcast::Receiver<AppEvent>) {
    let cfg = EngineConfig {
        data_dir: dir.to_path_buf(),
        platform_name: std::env::consts::OS.into(),
        client_app: "teleflock-test".into(),
        version: "0.0.0".into(),
        hostd_bins_override: None,
    };
    Engine::start(cfg, Arc::new(NullPlatform)).await
}

async fn call(e: &Engine, method: &str, params: Value) -> Result<Value, ApiError> {
    e.call(None, method, params).await
}

async fn status(e: &Engine) -> BrowserStatus {
    serde_json::from_value(call(e, "browser.status", json!({})).await.unwrap()).unwrap()
}

/// Waits (up to 30 s) for a status that `ok` accepts.
async fn until(e: &Engine, what: &str, ok: impl Fn(&BrowserStatus) -> bool) -> BrowserStatus {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let s = status(e).await;
        if ok(&s) {
            return s;
        }
        assert!(tokio::time::Instant::now() < deadline, "{what}: still {s:?}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// A DevTools connection to the browser target, as a page of `origin` opens it.
struct Cdp {
    ws: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    next: u64,
}

impl Cdp {
    async fn open(ws_url: &str, origin: Option<&str>) -> Result<Cdp, String> {
        let mut req = ws_url.into_client_request().unwrap();
        if let Some(o) = origin {
            req.headers_mut().insert("Origin", o.parse().unwrap());
        }
        let (ws, _) = tokio_tungstenite::connect_async(req).await.map_err(|e| e.to_string())?;
        Ok(Cdp { ws, next: 0 })
    }

    async fn call(&mut self, method: &str, params: Value) -> Value {
        self.next += 1;
        let id = self.next;
        self.ws.send(Message::text(json!({ "id": id, "method": method, "params": params }).to_string())).await.unwrap();
        loop {
            let m = tokio::time::timeout(Duration::from_secs(20), self.ws.next()).await.expect(method).expect(method).unwrap();
            let Message::Text(t) = m else { continue };
            let v: Value = serde_json::from_str(t.as_str()).unwrap();
            if v["id"] == id {
                assert!(v.get("error").is_none(), "{method}: {v}");
                return v["result"].clone();
            }
        }
    }
}

/// An HTTP server that sets a persistent cookie on `/set` and records the `Cookie` header of
/// every request.
async fn cookie_server() -> (u16, Arc<Mutex<Vec<String>>>) {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let log = seen.clone();
    tokio::spawn(async move {
        while let Ok((mut c, _)) = l.accept().await {
            let log = log.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = c.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let cookie = req.lines().find_map(|l| l.strip_prefix("Cookie: ").or_else(|| l.strip_prefix("cookie: "))).unwrap_or("").to_string();
                log.lock().unwrap().push(format!("{} {cookie}", req.split_whitespace().nth(1).unwrap_or("")));
                let set = if req.starts_with("GET /set ") { "Set-Cookie: tf=persisted; Max-Age=86400; Path=/\r\n" } else { "" };
                let body = "ok";
                let _ = c
                    .write_all(format!("HTTP/1.1 200 OK\r\n{set}Content-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes())
                    .await;
            });
        }
    });
    (port, seen)
}

/// The pid that holds the profile (`SingletonLock` → `<host>-<pid>`).
#[cfg(unix)]
fn browser_pid(profile: &Path) -> Option<i32> {
    let t = std::fs::read_link(profile.join("SingletonLock")).ok()?;
    t.to_str()?.rsplit_once('-')?.1.parse().ok()
}

/// Processes whose command line names `profile` (Linux).
fn processes_of(profile: &Path) -> Vec<String> {
    let want = format!("--user-data-dir={}", profile.display());
    let Ok(entries) = std::fs::read_dir("/proc") else { return vec![] };
    entries
        .flatten()
        .filter_map(|e| std::fs::read(e.path().join("cmdline")).ok().map(|c| (e.file_name(), String::from_utf8_lossy(&c).replace('\0', " "))))
        .filter(|(_, c)| c.contains(&want))
        .map(|(pid, c)| format!("{} {c}", pid.to_string_lossy()))
        .collect()
}

/// Start, DevTools for the app's origins only, a page through CDP, a cookie that survives a
/// restart (the persistent profile), a crash restarted with backoff, and nothing left running
/// after the app core shut down.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn real_browser_lifecycle() {
    let Some(chrome) = test_chrome() else {
        eprintln!("browser::tests: no Chromium here (set TF_TEST_CHROME); skipped");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let (e, _rx) = engine(dir.path()).await;
    e.allow_browser_origins(["http://127.0.0.1:7420".to_string()]);
    let set = call(&e, "browser.configSet", json!({ "enginePath": chrome.to_string_lossy() })).await.unwrap();
    assert_eq!(set["enginePath"], json!(chrome.to_string_lossy()));
    assert_eq!(status(&e).await.state, BrowserState::Off);

    let s: BrowserStatus = serde_json::from_value(call(&e, "browser.start", json!({})).await.unwrap()).unwrap();
    assert_eq!(s.state, BrowserState::Running, "{s:?}");
    assert!(!s.headed);
    let profile = dir.path().join("browser/profile");
    assert_eq!(Path::new(&s.profile_dir), profile);
    let (port, ws_url) = (s.cdp_port.unwrap(), s.ws_url.clone().unwrap());
    assert!(ws_url.starts_with(&format!("ws://127.0.0.1:{port}/devtools/browser/")), "{ws_url}");
    let engine = s.engine.clone().unwrap();
    assert!(engine.version.is_some(), "the engine's version was probed: {s:?}");
    eprintln!("browser::tests: {} {} at {} (DevTools on {port})", engine.name, engine.version.unwrap_or_default(), engine.path);

    // The app's own origins (and the embedder's) may open DevTools; other pages may not.
    for origin in ["tauri://localhost", "http://tauri.localhost", "http://127.0.0.1:7420"] {
        assert!(Cdp::open(&ws_url, Some(origin)).await.is_ok(), "{origin} refused");
    }
    let refused = Cdp::open(&ws_url, Some("http://evil.example")).await.err().expect("another origin is refused");
    assert!(refused.contains("403"), "{refused}");

    // A page opened through CDP sets a persistent cookie.
    let (http, seen) = cookie_server().await;
    let mut cdp = Cdp::open(&ws_url, Some("tauri://localhost")).await.unwrap();
    let t = cdp.call("Target.createTarget", json!({ "url": format!("http://127.0.0.1:{http}/set") })).await;
    assert!(t["targetId"].is_string());
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let cookies = cdp.call("Storage.getCookies", json!({})).await;
        if cookies["cookies"].as_array().unwrap().iter().any(|c| c["name"] == "tf") {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "no cookie: {cookies}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    drop(cdp);

    // Stop and start: the cookie is still there, and the page sends it.
    let stopped: BrowserStatus = serde_json::from_value(call(&e, "browser.stop", json!({})).await.unwrap()).unwrap();
    assert_eq!(stopped.state, BrowserState::Off);
    assert!(processes_of(&profile).is_empty(), "{:?}", processes_of(&profile));
    let s: BrowserStatus = serde_json::from_value(call(&e, "browser.start", json!({})).await.unwrap()).unwrap();
    assert_eq!(s.state, BrowserState::Running);
    let mut cdp = Cdp::open(s.ws_url.as_ref().unwrap(), None).await.unwrap();
    cdp.call("Target.createTarget", json!({ "url": format!("http://127.0.0.1:{http}/echo") })).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while !seen.lock().unwrap().iter().any(|r| r.starts_with("/echo") && r.contains("tf=persisted")) {
        assert!(tokio::time::Instant::now() < deadline, "the cookie did not survive the restart: {:?}", seen.lock().unwrap());
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    drop(cdp);

    // A crash: started again on its own.
    #[cfg(unix)]
    {
        let pid = browser_pid(&profile).expect("the profile's lock names the browser");
        // SAFETY: the browser this test started.
        unsafe { libc::kill(pid, libc::SIGKILL) };
        let before = s.cdp_port;
        let back = until(&e, "restarted after the crash", |s| s.state == BrowserState::Running && s.cdp_port != before).await;
        assert!(back.ws_url.is_some());
    }

    // Shutting the app core down stops it: nothing of it is left.
    e.shutdown().await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !processes_of(&profile).is_empty() {
        assert!(tokio::time::Instant::now() < deadline, "left running: {:?}", processes_of(&profile));
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// One app core per profile: a second core on the same data dir cannot start the browser while
/// the first runs it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_core_per_profile() {
    let Some(chrome) = test_chrome() else {
        eprintln!("browser::tests: no Chromium here (set TF_TEST_CHROME); skipped");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let (a, _ra) = engine(dir.path()).await;
    call(&a, "browser.configSet", json!({ "enginePath": chrome.to_string_lossy() })).await.unwrap();
    call(&a, "browser.start", json!({})).await.unwrap();
    let (b, _rb) = engine(dir.path()).await;
    let err = call(&b, "browser.start", json!({})).await.unwrap_err();
    assert!(err.message.contains("another TeleFlock"), "{err:?}");
    assert_eq!(status(&b).await.state, BrowserState::Error);
    a.shutdown().await;
    b.shutdown().await;
    assert!(processes_of(&dir.path().join("browser/profile")).is_empty());
}
