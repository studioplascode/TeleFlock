//! The proxy against a real headless Chromium (`TF_TEST_CHROME`, else Chrome for Testing under
//! `target/`, Playwright's or Puppeteer's cache, or a system Chromium; skipped with a message
//! when there is none): two agents, each through its own proxied connections with Puppeteer's
//! auto-attach, and the user on the browser's own port.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

use super::filter::TAKEN_OVER;
use super::{AttachKey, CdpProxy};

const WAIT: Duration = Duration::from_secs(10);

fn find_chrome() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("TF_TEST_CHROME") {
        return Some(PathBuf::from(p)).filter(|p| p.is_file());
    }
    let mut dirs: Vec<PathBuf> = Vec::new();
    let target = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target");
    for d in std::fs::read_dir(&target).into_iter().flatten().flatten() {
        dirs.push(d.path());
        dirs.extend(std::fs::read_dir(d.path()).into_iter().flatten().flatten().map(|e| e.path()));
    }
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    for cache in [home.join(".cache/ms-playwright"), home.join(".cache/puppeteer/chrome")] {
        dirs.extend(std::fs::read_dir(cache).into_iter().flatten().flatten().map(|e| e.path()));
    }
    let mut found: Vec<PathBuf> = dirs
        .iter()
        .flat_map(|d| [d.join("chrome-linux64/chrome"), d.join("chrome-linux/chrome")])
        .filter(|p| p.is_file())
        .collect();
    found.sort();
    found.reverse();
    found.extend(
        ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"]
            .iter()
            .map(PathBuf::from)
            .filter(|p| p.is_file()),
    );
    found.into_iter().next()
}

struct Chrome {
    _child: tokio::process::Child,
    port: u16,
    /// The browser target's WebSocket path (`/devtools/browser/<id>`).
    ws_path: String,
    _dir: tempfile::TempDir,
}

/// Headless, with a throwaway profile and HOME (nothing of the user's is touched).
async fn launch(bin: &Path) -> Chrome {
    let dir = tempfile::tempdir().unwrap();
    let child = tokio::process::Command::new(bin)
        .args([
            "--headless=new",
            "--no-sandbox",
            "--remote-debugging-port=0",
            "--remote-debugging-address=127.0.0.1",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--disable-background-networking",
            "--disable-renderer-backgrounding",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
        ])
        .arg(format!("--user-data-dir={}", dir.path().join("profile").display()))
        .arg("about:blank")
        .env("HOME", dir.path())
        .env("XDG_CONFIG_HOME", dir.path().join("config"))
        .env("XDG_CACHE_HOME", dir.path().join("cache"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("start chromium");
    let file = dir.path().join("profile/DevToolsActivePort");
    for _ in 0..300 {
        // "<port>\n/devtools/browser/<id>"
        let written = std::fs::read_to_string(&file).unwrap_or_default();
        let mut lines = written.lines();
        if let (Some(Ok(port)), Some(path)) = (lines.next().map(|l| l.trim().parse::<u16>()), lines.next()) {
            return Chrome { _child: child, port, ws_path: path.trim().to_string(), _dir: dir };
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("chromium wrote no DevToolsActivePort");
}

/// A tiny DevTools client. `puppeteer`: it answers every attach the way Puppeteer does
/// (auto-attach on the new session, then `Runtime.runIfWaitingForDebugger`).
struct Client {
    out: mpsc::UnboundedSender<Message>,
    next: Arc<AtomicI64>,
    waiting: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
    events: Arc<Mutex<Vec<Value>>>,
    closed: Arc<Mutex<Option<String>>>,
}

impl Client {
    async fn open<S>(url: &str, stream: S, puppeteer: bool) -> Client
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let (ws, _) = tokio_tungstenite::client_async(url, stream).await.expect("websocket");
        let (mut tx, mut rx) = ws.split();
        let (out, mut queue) = mpsc::unbounded_channel::<Message>();
        tokio::spawn(async move {
            while let Some(m) = queue.recv().await {
                if tx.send(m).await.is_err() {
                    break;
                }
            }
        });
        let c = Client {
            out,
            next: Arc::new(AtomicI64::new(1000)),
            waiting: Arc::default(),
            events: Arc::default(),
            closed: Arc::default(),
        };
        let (waiting, events, closed, out, next) = (c.waiting.clone(), c.events.clone(), c.closed.clone(), c.out.clone(), c.next.clone());
        tokio::spawn(async move {
            while let Some(m) = rx.next().await {
                let text = match m {
                    Ok(Message::Text(t)) => t.as_str().to_string(),
                    Ok(Message::Close(f)) => {
                        *closed.lock().unwrap() = Some(f.map(|f| f.reason.to_string()).unwrap_or_default());
                        break;
                    }
                    Ok(_) => continue,
                    Err(_) => break,
                };
                let v: Value = serde_json::from_str(&text).unwrap();
                if let Some(id) = v.get("id").and_then(Value::as_i64) {
                    if let Some(w) = waiting.lock().unwrap().remove(&id) {
                        let _ = w.send(v);
                    }
                    continue;
                }
                if puppeteer && v["method"] == "Target.attachedToTarget" {
                    let s = v["params"]["sessionId"].clone();
                    for (method, params) in [
                        ("Target.setAutoAttach", json!({ "waitForDebuggerOnStart": true, "flatten": true, "autoAttach": true, "filter": [{}] })),
                        ("Runtime.runIfWaitingForDebugger", json!({})),
                    ] {
                        let id = next.fetch_add(1, Ordering::Relaxed);
                        let m = json!({ "id": id, "method": method, "params": params, "sessionId": s });
                        let _ = out.send(Message::text(m.to_string()));
                    }
                }
                events.lock().unwrap().push(v);
            }
            closed.lock().unwrap().get_or_insert_with(String::new);
        });
        c
    }

    /// The user: straight to the browser's own port.
    async fn user(chrome: &Chrome) -> Client {
        let url = format!("ws://127.0.0.1:{}{}", chrome.port, chrome.ws_path);
        let tcp = tokio::net::TcpStream::connect(("127.0.0.1", chrome.port)).await.unwrap();
        Client::open(&url, tcp, false).await
    }

    /// An agent: a connection the proxy serves, as tf-hostd streams it.
    async fn agent(px: &Arc<CdpProxy>, who: &AttachKey) -> Client {
        let (ours, theirs) = tokio::io::duplex(1 << 20);
        let (px, w) = (px.clone(), who.clone());
        tokio::spawn(async move { px.serve(theirs, w).await });
        let c = Client::open("ws://127.0.0.1:9222/devtools/browser/whatever", ours, true).await;
        c.ok("Target.setDiscoverTargets", json!({ "discover": true, "filter": [{}] }), None).await;
        c.ok(
            "Target.setAutoAttach",
            json!({ "waitForDebuggerOnStart": true, "flatten": true, "autoAttach": true, "filter": [{ "type": "page", "exclude": true }, {}] }),
            None,
        )
        .await;
        c
    }

    async fn call(&self, method: &str, params: Value, session: Option<&str>) -> Value {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let mut m = json!({ "id": id, "method": method, "params": params });
        if let Some(s) = session {
            m["sessionId"] = json!(s);
        }
        let (tx, rx) = oneshot::channel();
        self.waiting.lock().unwrap().insert(id, tx);
        self.out.send(Message::text(m.to_string())).unwrap();
        tokio::time::timeout(WAIT, rx).await.unwrap_or_else(|_| panic!("{method}: no answer")).unwrap()
    }

    async fn ok(&self, method: &str, params: Value, session: Option<&str>) -> Value {
        let v = self.call(method, params, session).await;
        assert!(v.get("error").is_none(), "{method}: {v}");
        v["result"].clone()
    }

    async fn err(&self, method: &str, params: Value, session: Option<&str>) -> String {
        let v = self.call(method, params, session).await;
        v["error"]["message"].as_str().unwrap_or_else(|| panic!("{method} should fail: {v}")).to_string()
    }

    fn events(&self) -> Vec<Value> {
        self.events.lock().unwrap().clone()
    }

    async fn event(&self, what: &str, pred: impl Fn(&Value) -> bool) -> Value {
        for _ in 0..200 {
            if let Some(e) = self.events().into_iter().find(&pred) {
                return e;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("no event: {what}");
    }

    /// The session the client got for target `id`.
    async fn session_of(&self, id: &str) -> String {
        let e = self.event(id, |e| e["method"] == "Target.attachedToTarget" && e["params"]["targetInfo"]["targetId"] == id).await;
        e["params"]["sessionId"].as_str().unwrap().to_string()
    }

    async fn eval(&self, session: &str, expr: &str) -> Value {
        self.ok("Runtime.evaluate", json!({ "expression": expr, "returnByValue": true }), Some(session)).await["result"]["value"].clone()
    }
}

/// An HTTP request through the proxy (`Connection: close`): status and body.
async fn http(px: &Arc<CdpProxy>, who: &AttachKey, line: &str, host: &str) -> (u16, String) {
    let (mut ours, theirs) = tokio::io::duplex(1 << 20);
    let (px, w) = (px.clone(), who.clone());
    tokio::spawn(async move { px.serve(theirs, w).await });
    ours.write_all(format!("{line} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    tokio::time::timeout(WAIT, ours.read_to_end(&mut raw)).await.unwrap().unwrap();
    let text = String::from_utf8(raw).unwrap();
    let (head, body) = text.split_once("\r\n\r\n").unwrap();
    (head.split(' ').nth(1).unwrap().parse().unwrap(), body.to_string())
}

fn key(agent: &str) -> AttachKey {
    AttachKey { host_id: "lab".into(), agent_id: agent.into() }
}

/// Pages `who` owns now.
fn owned(px: &CdpProxy, who: &AttachKey) -> Vec<String> {
    px.tabs().into_iter().filter(|t| t.agent_id == who.agent_id).map(|t| t.target_id).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_agents_share_one_browser_without_seeing_each_other() {
    let Some(bin) = find_chrome() else {
        eprintln!("skipping two_agents_share_one_browser_without_seeing_each_other: no Chromium found (set TF_TEST_CHROME)");
        return;
    };
    eprintln!("live proxy test with {}", bin.display());
    let chrome = launch(&bin).await;
    let px = CdpProxy::new(chrome.port);
    let (a, b) = (key("a"), key("b"));

    // Not attached: refused.
    let (code, _) = http(&px, &a, "GET /json/version", "127.0.0.1:9222").await;
    assert_eq!(code, 403);
    px.attach(&a);
    px.attach(&b);

    // The user's own tab, on the browser's own port.
    let user = Client::user(&chrome).await;
    let mail = user.ok("Target.createTarget", json!({ "url": "data:text/html,<title>mail</title>inbox" }), None).await["targetId"]
        .as_str()
        .unwrap()
        .to_string();

    // `/json/version` answers with the address the agent used (Puppeteer's browserURL).
    let (code, body) = http(&px, &a, "GET /json/version", "127.0.0.1:41234").await;
    assert_eq!(code, 200, "{body}");
    let v: Value = serde_json::from_str(&body).unwrap();
    assert!(v["webSocketDebuggerUrl"].as_str().unwrap().starts_with("ws://127.0.0.1:41234/devtools/browser/"), "{v}");
    let (code, _) = http(&px, &a, "GET /json/version", "evil.example:41234").await;
    assert_eq!(code, 500, "DNS rebinding is refused");

    // Both agents connect the way Puppeteer does; each gets a first tab of its own.
    let ca = Client::agent(&px, &a).await;
    let cb = Client::agent(&px, &b).await;
    assert_eq!(owned(&px, &a).len(), 1);
    assert_eq!(owned(&px, &b).len(), 1);

    // Each opens a tab and drives it.
    let pa = ca.ok("Target.createTarget", json!({ "url": "data:text/html,<title>A</title>a" }), None).await["targetId"].as_str().unwrap().to_string();
    let pb = cb.ok("Target.createTarget", json!({ "url": "data:text/html,<title>B</title>b" }), None).await["targetId"].as_str().unwrap().to_string();
    let sa = ca.session_of(&pa).await;
    let sb = cb.session_of(&pb).await;
    for _ in 0..100 {
        if ca.eval(&sa, "document.title").await == json!("A") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(ca.eval(&sa, "document.title").await, json!("A"));
    assert_eq!(cb.eval(&sb, "document.title").await, json!("B"));
    assert!(owned(&px, &a).contains(&pa) && owned(&px, &b).contains(&pb));

    // Each sees only its own tabs.
    let list = ca.ok("Target.getTargets", json!({}), None).await;
    let seen: Vec<&str> = list["targetInfos"].as_array().unwrap().iter().filter(|t| t["type"] == "page").map(|t| t["targetId"].as_str().unwrap()).collect();
    let mut mine = owned(&px, &a);
    mine.sort();
    let mut seen_sorted: Vec<String> = seen.iter().map(|s| s.to_string()).collect();
    seen_sorted.sort();
    assert_eq!(seen_sorted, mine);
    let (code, body) = http(&px, &b, "GET /json/list", "127.0.0.1:41235").await;
    assert_eq!(code, 200);
    let listed: Vec<Value> = serde_json::from_str(&body).unwrap();
    let mut listed: Vec<String> = listed.iter().map(|e| e["id"].as_str().unwrap().to_string()).collect();
    listed.sort();
    let mut mine_b = owned(&px, &b);
    mine_b.sort();
    assert_eq!(listed, mine_b);

    // Nobody can drive or close the others' tabs or the user's.
    for (c, target) in [(&ca, &pb), (&ca, &mail), (&cb, &pa), (&cb, &mail)] {
        assert!(c.err("Target.attachToTarget", json!({ "targetId": target, "flatten": true }), None).await.contains("No target with given id"));
        assert!(c.err("Target.closeTarget", json!({ "targetId": target }), None).await.contains("No target with given id"));
        assert!(c.err("Target.activateTarget", json!({ "targetId": target }), None).await.contains("No target with given id"));
    }
    let (code, _) = http(&px, &a, &format!("GET /json/close/{mail}"), "127.0.0.1:1").await;
    assert_eq!(code, 404);
    assert!(ca.err("Browser.close", json!({}), None).await.contains("TeleFlock refused `Browser.close`"));
    assert!(ca.err("Storage.clearCookies", json!({}), None).await.contains("TeleFlock refused"));

    // A tab the user opens now loads although both agents auto-attach waiting for a debugger.
    let later = user.ok("Target.createTarget", json!({ "url": "data:text/html,<title>later</title>x" }), None).await["targetId"]
        .as_str()
        .unwrap()
        .to_string();
    let us = user.ok("Target.attachToTarget", json!({ "targetId": later, "flatten": true }), None).await["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    let mut loaded = Value::Null;
    for _ in 0..100 {
        let r = user.call("Runtime.evaluate", json!({ "expression": "document.readyState + '|' + document.title", "returnByValue": true }), Some(&us)).await;
        loaded = r["result"]["result"]["value"].clone();
        if loaded == json!("complete|later") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(loaded, json!("complete|later"), "the user's new tab must not hang");
    // Neither agent ever saw the user's tabs or the other agent's.
    tokio::time::sleep(Duration::from_millis(300)).await;
    for (c, others) in [(&ca, ["mail", "later", "<title>B"]), (&cb, ["mail", "later", "<title>A"])] {
        for e in c.events() {
            let s = e.to_string();
            assert!(!others.iter().any(|o| s.contains(o)), "leaked: {s}");
        }
    }

    // A popup of A's page is A's.
    ca.ok("Runtime.evaluate", json!({ "expression": "window.open('data:text/html,<title>popup</title>p'); 1", "userGesture": true }), Some(&sa)).await;
    let popup = ca.event("popup attached", |e| e["method"] == "Target.attachedToTarget" && e["params"]["targetInfo"]["openerId"] == json!(pa)).await;
    let popup = popup["params"]["targetInfo"]["targetId"].as_str().unwrap().to_string();
    assert!(owned(&px, &a).contains(&popup), "{popup} is A's");

    // Take over: A's next command on that tab fails (on the page and on its tab session).
    let first = ca.events().into_iter().find(|e| e["method"] == "Target.attachedToTarget" && e["params"]["targetInfo"]["targetId"] == json!(pa));
    let ta = first.and_then(|e| e["sessionId"].as_str().map(String::from)).expect("A's page hangs under its tab session");
    px.take_over(&pa).unwrap();
    assert_eq!(ca.err("Runtime.evaluate", json!({ "expression": "1" }), Some(&sa)).await, TAKEN_OVER);
    assert_eq!(ca.err("Target.getTargetInfo", json!({}), Some(&ta)).await, TAKEN_OVER);
    assert!(px.tabs().iter().any(|t| t.target_id == pa && t.taken_over));
    // Hand back: the page comes back on a new session under the same tab session, the way
    // Puppeteer moves a live page to another session (a prerendered page activated).
    let before = ca.events().len();
    px.hand_back(&pa).unwrap();
    let is_pa = |e: &Value| e["params"]["targetInfo"]["targetId"] == json!(pa);
    let mut swapped = None;
    for _ in 0..200 {
        let evs: Vec<Value> = ca.events()[before..].to_vec();
        if let Some(i) = evs.iter().position(|e| e["method"] == "Target.attachedToTarget" && is_pa(e))
            && evs[i + 1..].iter().any(|e| e["method"] == "Target.targetInfoChanged" && is_pa(e))
        {
            swapped = Some((i, evs));
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let (i, evs) = swapped.expect("the page attached again and activated");
    assert_eq!(evs[i]["sessionId"], json!(ta), "under the same tab session");
    assert_eq!(evs[i]["params"]["targetInfo"]["subtype"], "prerender");
    let activated = evs[i + 1..].iter().find(|e| e["method"] == "Target.targetInfoChanged" && is_pa(e)).unwrap();
    assert!(activated["params"]["targetInfo"].get("subtype").is_none(), "{activated}");
    assert_eq!(activated["params"]["targetInfo"]["attached"], json!(true));
    let old_ended = evs.iter().position(|e| e["method"] == "Target.detachedFromTarget" && e["params"]["sessionId"] == json!(sa));
    assert!(old_ended.is_some_and(|d| d < i), "the old page session ends first: {evs:?}");
    assert!(!evs.iter().any(|e| e["method"] == "Target.detachedFromTarget" && e["params"]["sessionId"] == json!(ta)), "the tab session lives on");
    let fresh = evs[i]["params"]["sessionId"].as_str().unwrap().to_string();
    assert_eq!(ca.eval(&fresh, "document.title").await, json!("A"));
    ca.ok("Target.getTargetInfo", json!({}), Some(&ta)).await;

    // Lend the user's tab to B: B can drive it, A still cannot see it.
    px.lend_tab(&mail, &b).unwrap();
    let lent = cb.session_of(&mail).await;
    assert_eq!(cb.eval(&lent, "document.title").await, json!("mail"));
    assert!(ca.err("Target.attachToTarget", json!({ "targetId": mail, "flatten": true }), None).await.contains("No target"));

    // Detach A: its connection closes, its tabs stay (detached).
    px.detach(&a);
    for _ in 0..100 {
        if ca.closed.lock().unwrap().is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(ca.closed.lock().unwrap().is_some(), "A's connection closed");
    assert!(px.tabs().iter().filter(|t| t.agent_id == "a").all(|t| t.detached));
    assert!(px.tabs().iter().any(|t| t.target_id == pa));
    let (code, _) = http(&px, &a, "GET /json/list", "127.0.0.1:1").await;
    assert_eq!(code, 403);
    // B carries on.
    assert_eq!(cb.eval(&sb, "document.title").await, json!("B"));
}
