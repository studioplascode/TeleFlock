//! The proxy as a server: agents' connections (in-memory streams, as tf-hostd hands them over)
//! against a stand-in for the browser's DevTools endpoint on loopback. It answers `/json/version`
//! and `/json/list` the way Chrome 156 does, and its browser WebSocket answers the proxy's own
//! commands (it reports its pages before it answers `Target.setDiscoverTargets`, announces the
//! pages it creates before it answers `Target.createTarget`). What that WebSocket was asked is
//! recorded, so a test can tell what reached the browser and what did not. No real browser runs
//! here (`live.rs` has one).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;

use super::filter::TAKEN_OVER;
use super::registry::Vis;
use super::{AttachKey, CdpProxy};

const WAIT: Duration = Duration::from_secs(10);
/// The address agents use (tf-hostd's listener on their host); the proxy answers with it.
const HOST: &str = "127.0.0.1:9333";
/// The user's tab, open from the start.
const USER_PAGE: &str = "98E69140FA4475559BE9D8990B49D2D4";
/// The browser target's id: in its WebSocket's path and in its `TargetInfo`.
const BROWSER_ID: &str = "0c1d6c5e-8a7f-4b8e-9d1c-2f3a4b5c6d7e";

#[derive(Default)]
struct State {
    /// The pages, `(id, url)`, as `/json/list` shows them.
    pages: Vec<(String, String)>,
    /// What the browser WebSocket was asked: `{ method, params }`, in order.
    asked: Vec<Value>,
    created: u32,
}

struct Browser {
    port: u16,
    state: Arc<Mutex<State>>,
}

impl Browser {
    /// Listens on loopback with the user's tab open.
    async fn start() -> Browser {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = Arc::new(Mutex::new(State { pages: vec![(USER_PAGE.into(), "https://mail.example/".into())], ..State::default() }));
        let shared = state.clone();
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                tokio::spawn(serve_one(tcp, port, shared.clone()));
            }
        });
        Browser { port, state }
    }

    /// The params of every `method` the browser was asked.
    fn asked(&self, method: &str) -> Vec<Value> {
        self.state.lock().unwrap().asked.iter().filter(|c| c["method"] == method).map(|c| c["params"].clone()).collect()
    }
}

/// Chrome serves `/json/*` over HTTP and the DevTools WebSockets on the same port.
async fn serve_one(mut tcp: TcpStream, port: u16, state: Arc<Mutex<State>>) {
    let mut start = [0u8; 9];
    let n = tcp.peek(&mut start).await.unwrap_or(0);
    if start[..n].starts_with(b"GET /json") {
        json_over_http(&mut tcp, port, &state).await;
    } else if let Ok(ws) = tokio_tungstenite::accept_async(tcp).await {
        devtools(ws, &state).await;
    }
}

async fn json_over_http(tcp: &mut TcpStream, port: u16, state: &Mutex<State>) {
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        let mut chunk = [0u8; 512];
        match tcp.read(&mut chunk).await {
            Ok(n) if n > 0 => head.extend_from_slice(&chunk[..n]),
            _ => return,
        }
    }
    let head = String::from_utf8_lossy(&head).into_owned();
    let body = match head.split_whitespace().nth(1).unwrap_or_default() {
        "/json/version" => json!({
            "Browser": "Chrome/156.0.7803.0",
            "Protocol-Version": "1.3",
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
            "V8-Version": "15.6.0",
            "WebKit-Version": "537.36 (@2a1b3c4d5e6f)",
            "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/browser/{BROWSER_ID}"),
        }),
        "/json/list" => {
            let pages = state.lock().unwrap().pages.clone();
            let mut list: Vec<Value> = pages
                .iter()
                .map(|(id, url)| {
                    json!({
                        "description": "",
                        "devtoolsFrontendUrl": format!("https://chrome-devtools-frontend.appspot.com/serve_rev/@2a1b3c/inspector.html?ws=127.0.0.1:{port}/devtools/page/{id}"),
                        "id": id,
                        "title": url,
                        "type": "page",
                        "url": url,
                        "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/page/{id}"),
                    })
                })
                .collect();
            // Not a page: never in an agent's list.
            let worker = "861453E03A0FB2F0B095934225282883";
            list.push(json!({
                "description": "", "id": worker, "title": "", "type": "service_worker", "url": "chrome-extension://x/thunk.js",
                "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/page/{worker}"),
            }));
            Value::Array(list)
        }
        _ => json!({ "error": "not here" }),
    }
    .to_string();
    let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=UTF-8\r\nContent-Length: {}\r\n\r\n{body}", body.len());
    let _ = tcp.write_all(reply.as_bytes()).await;
}

fn target_created(id: &str, url: &str) -> Value {
    json!({ "method": "Target.targetCreated", "params": { "targetInfo": {
        "targetId": id, "type": "page", "title": url, "url": url, "attached": false, "canAccessOpener": false,
    } } })
}

/// A DevTools WebSocket: records every command and answers it (`{}` unless it is one of the few
/// the proxy depends on).
async fn devtools(mut ws: WebSocketStream<TcpStream>, state: &Mutex<State>) {
    while let Some(Ok(msg)) = ws.next().await {
        let Message::Text(text) = msg else { continue };
        let Ok(cmd) = serde_json::from_str::<Value>(text.as_str()) else { continue };
        let method = cmd["method"].as_str().unwrap_or_default().to_string();
        state.lock().unwrap().asked.push(json!({ "method": method, "params": cmd["params"] }));
        let mut events: Vec<Value> = Vec::new();
        let result = match method.as_str() {
            "Target.getTargetInfo" => json!({ "targetInfo": {
                "targetId": BROWSER_ID, "type": "browser", "title": "", "url": "", "attached": true, "canAccessOpener": false,
            } }),
            // Chrome reports every target there is before it answers.
            "Target.setDiscoverTargets" => {
                events = state.lock().unwrap().pages.iter().map(|(id, url)| target_created(id, url)).collect();
                json!({})
            }
            "Target.createTarget" => {
                let (id, url) = {
                    let mut st = state.lock().unwrap();
                    st.created += 1;
                    let (id, url) = (format!("NEWPAGE{}", st.created), cmd["params"]["url"].as_str().unwrap_or_default().to_string());
                    st.pages.push((id.clone(), url.clone()));
                    (id, url)
                };
                events = vec![target_created(&id, &url)];
                json!({ "targetId": id })
            }
            "Target.closeTarget" => json!({ "success": true }),
            _ => json!({}),
        };
        for e in events {
            if ws.send(Message::text(e.to_string())).await.is_err() {
                return;
            }
        }
        if ws.send(Message::text(json!({ "id": cmd["id"], "result": result }).to_string())).await.is_err() {
            return;
        }
    }
}

fn key(agent: &str) -> AttachKey {
    AttachKey { host_id: "lab".into(), agent_id: agent.into() }
}

/// A proxy for a stand-in browser, agents `a` and `b` attached, its monitor in sync.
async fn setup() -> (Browser, Arc<CdpProxy>) {
    let browser = Browser::start().await;
    let px = CdpProxy::new(browser.port);
    px.attach(&key("a"));
    px.attach(&key("b"));
    px.wait_synced(WAIT).await;
    assert!(px.with_reg(|r| r.synced), "the monitor reported the stand-in's targets");
    (browser, px)
}

/// An agent's connection, as tf-hostd streams it: the proxy serves one end.
fn connection(px: &Arc<CdpProxy>, who: &AttachKey) -> DuplexStream {
    let (ours, theirs) = tokio::io::duplex(1 << 20);
    let (px, who) = (px.clone(), who.clone());
    tokio::spawn(async move { px.serve(theirs, who).await });
    ours
}

/// Everything the proxy answers before it closes the connection: status and body.
async fn read_response(io: &mut DuplexStream) -> (u16, String) {
    let mut raw = Vec::new();
    tokio::time::timeout(WAIT, io.read_to_end(&mut raw)).await.expect("the proxy answers").unwrap();
    let text = String::from_utf8(raw).unwrap();
    let (head, body) = text.split_once("\r\n\r\n").expect("a response");
    (head.split(' ').nth(1).unwrap().parse().unwrap(), body.to_string())
}

/// An HTTP request through the proxy as `who` (`Connection: close`).
async fn http(px: &Arc<CdpProxy>, who: &AttachKey, method: &str, path: &str, host: &str) -> (u16, String) {
    let mut io = connection(px, who);
    io.write_all(format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    read_response(&mut io).await
}

/// A WebSocket upgrade request, as far as a refusal goes (an accepted one would not end).
async fn refused_upgrade(px: &Arc<CdpProxy>, who: &AttachKey, path: &str, origin: Option<&str>) -> (u16, String) {
    let mut io = connection(px, who);
    let origin = origin.map(|o| format!("Origin: {o}\r\n")).unwrap_or_default();
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n{origin}Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    io.write_all(request.as_bytes()).await.unwrap();
    read_response(&mut io).await
}

/// One response off a connection that stays open: status and body, by `Content-Length`.
async fn one_response(io: &mut DuplexStream) -> (u16, String) {
    let mut raw = Vec::new();
    while !raw.ends_with(b"\r\n\r\n") {
        let mut byte = [0u8; 1];
        tokio::time::timeout(WAIT, io.read_exact(&mut byte)).await.expect("the proxy answers").unwrap();
        raw.push(byte[0]);
    }
    let head = String::from_utf8(raw).unwrap();
    let len: usize = head.lines().find_map(|l| l.strip_prefix("Content-Length: ")).expect("a length").trim().parse().unwrap();
    let mut body = vec![0u8; len];
    tokio::time::timeout(WAIT, io.read_exact(&mut body)).await.expect("the body").unwrap();
    (head.split(' ').nth(1).unwrap().parse().unwrap(), String::from_utf8(body).unwrap())
}

/// Opens a tab as an agent's HTTP client does (`PUT /json/new`): its page id.
async fn new_tab(px: &Arc<CdpProxy>, who: &AttachKey, url: &str) -> String {
    let (code, body) = http(px, who, "PUT", &format!("/json/new?{url}"), HOST).await;
    assert_eq!(code, 200, "{body}");
    serde_json::from_str::<Value>(&body).unwrap()["id"].as_str().unwrap().to_string()
}

fn page_ids(body: &str) -> Vec<String> {
    serde_json::from_str::<Vec<Value>>(body).unwrap().iter().map(|e| e["id"].as_str().unwrap().to_string()).collect()
}

type Ws = WebSocketStream<DuplexStream>;

/// An agent's WebSocket to `path` (`/devtools/browser/…` or `/devtools/page/<id>`).
async fn websocket(px: &Arc<CdpProxy>, who: &AttachKey, path: &str) -> Ws {
    let (ws, _) = tokio_tungstenite::client_async(format!("ws://{HOST}{path}"), connection(px, who)).await.expect("the upgrade");
    ws
}

/// Sends a command and waits for its answer.
async fn ask(ws: &mut Ws, id: i64, method: &str, params: Value) -> Value {
    ws.send(Message::text(json!({ "id": id, "method": method, "params": params }).to_string())).await.unwrap();
    loop {
        let m = tokio::time::timeout(WAIT, ws.next()).await.unwrap_or_else(|_| panic!("{method}: no answer")).expect("open").expect("a message");
        if let Message::Text(t) = m {
            let v: Value = serde_json::from_str(t.as_str()).unwrap();
            if v["id"] == json!(id) {
                return v;
            }
        }
    }
}

/// The reason the proxy closed the WebSocket with.
async fn closed_with(ws: &mut Ws) -> String {
    loop {
        match tokio::time::timeout(WAIT, ws.next()).await.expect("the proxy closes it") {
            Some(Ok(Message::Close(Some(frame)))) => return frame.reason.to_string(),
            Some(Ok(Message::Close(None))) | Some(Err(_)) | None => return String::new(),
            Some(Ok(_)) => {}
        }
    }
}

#[tokio::test]
async fn json_endpoints_show_an_agent_its_own_tabs_through_the_address_it_used() {
    let browser = Browser::start().await;
    let px = CdpProxy::new(browser.port);
    let (a, b) = (key("a"), key("b"));
    // Not attached: refused.
    assert_eq!(http(&px, &a, "GET", "/json/version", HOST).await.0, 403);
    px.attach(&a);
    px.attach(&b);
    px.wait_synced(WAIT).await;
    let (own_a, own_b) = (new_tab(&px, &a, "https://a.example/").await, new_tab(&px, &b, "https://b.example/").await);
    let raw = format!("127.0.0.1:{}", browser.port);

    // `/json/version` answers with the address the agent used (Puppeteer's browserURL), never the
    // browser's own.
    let (code, body) = http(&px, &a, "GET", "/json/version", HOST).await;
    assert_eq!(code, 200, "{body}");
    let version: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(version["webSocketDebuggerUrl"], format!("ws://{HOST}/devtools/browser/{BROWSER_ID}"));
    assert_eq!(version["Browser"], "Chrome/156.0.7803.0", "the rest is the browser's own");
    assert!(!body.contains(&raw), "{body}");
    assert_eq!(http(&px, &a, "GET", "/json/version", "evil.example:9333").await.0, 500, "DNS rebinding is refused");

    // `/json/list`: its own pages (not the user's, not the other agent's, not workers), each
    // reachable through the address it used.
    for path in ["/json/list", "/json", "/json/"] {
        let (code, body) = http(&px, &a, "GET", path, HOST).await;
        assert_eq!(code, 200, "{path}");
        assert_eq!(page_ids(&body), [own_a.clone()], "{path}");
        assert!(!body.contains(&raw), "{body}");
    }
    let (_, body) = http(&px, &a, "GET", "/json/list", HOST).await;
    let entry = &serde_json::from_str::<Vec<Value>>(&body).unwrap()[0];
    assert_eq!(entry["webSocketDebuggerUrl"], format!("ws://{HOST}/devtools/page/{own_a}"));
    assert!(entry["devtoolsFrontendUrl"].as_str().unwrap().contains(&format!("ws={HOST}/devtools/page/{own_a}")));
    let (_, body) = http(&px, &b, "GET", "/json/list", HOST).await;
    assert_eq!(page_ids(&body), [own_b]);
}

#[tokio::test]
async fn json_new_opens_a_tab_in_a_window_of_its_own_that_belongs_to_the_agent() {
    let (browser, px) = setup().await;
    let (a, b) = (key("a"), key("b"));
    let (code, body) = http(&px, &a, "PUT", "/json/new?https://example.com/page", HOST).await;
    assert_eq!(code, 200, "{body}");
    let entry: Value = serde_json::from_str(&body).unwrap();
    let page = entry["id"].as_str().unwrap().to_string();
    assert_eq!(entry["url"], "https://example.com/page");
    assert_eq!(entry["webSocketDebuggerUrl"], format!("ws://{HOST}/devtools/page/{page}"));
    assert_eq!(browser.asked("Target.createTarget"), vec![json!({ "url": "https://example.com/page", "newWindow": true })]);
    // Its tab: the agent's alone.
    assert_eq!(px.with_reg(|r| (r.id_vis(&a, &page), r.id_vis(&b, &page))), (Vis::Mine, Vis::Foreign));
    let tabs = px.tabs();
    assert!(tabs.iter().any(|t| t.target_id == page && t.agent_id == "a" && t.host_id == "lab" && !t.lent && !t.detached), "{tabs:?}");
    // Chrome takes only PUT; the browser's own pages and the device's files are not for agents.
    assert_eq!(http(&px, &a, "GET", "/json/new?https://example.com/", HOST).await.0, 405);
    for url in ["chrome://settings/", "about:settings", "file:///etc/passwd"] {
        let (code, body) = http(&px, &a, "PUT", &format!("/json/new?{url}"), HOST).await;
        assert_eq!(code, 403, "{url}: {body}");
    }
    // No address: a blank tab.
    let (code, body) = http(&px, &a, "PUT", "/json/new", HOST).await;
    assert_eq!((code, serde_json::from_str::<Value>(&body).unwrap()["url"].clone()), (200, json!("about:blank")));
    assert_eq!(browser.asked("Target.createTarget").len(), 2, "the refused ones never reached the browser");
}

#[tokio::test]
async fn json_close_and_activate_act_only_on_the_agents_own_tabs() {
    let (browser, px) = setup().await;
    let (a, b) = (key("a"), key("b"));
    let (own, theirs) = (new_tab(&px, &a, "https://a.example/").await, new_tab(&px, &b, "https://b.example/").await);
    // Its own: the browser is asked.
    assert_eq!(http(&px, &a, "GET", &format!("/json/activate/{own}"), HOST).await, (200, "Target activated".to_string()));
    assert_eq!(http(&px, &a, "GET", &format!("/json/close/{own}"), HOST).await, (200, "Target is closing".to_string()));
    // The user's tab, another agent's and one that does not exist are not its: the browser is not asked.
    for id in [USER_PAGE, theirs.as_str(), "NOSUCHPAGE"] {
        for command in ["activate", "close"] {
            assert_eq!(http(&px, &a, "GET", &format!("/json/{command}/{id}"), HOST).await, (404, format!("No such target id: {id}")), "{command} {id}");
        }
    }
    assert_eq!(browser.asked("Target.activateTarget"), vec![json!({ "targetId": own })]);
    assert_eq!(browser.asked("Target.closeTarget"), vec![json!({ "targetId": own })]);
    // A tab the user took over answers with the reason, not with the browser, until handed back.
    let kept = new_tab(&px, &a, "https://a.example/2").await;
    px.take_over(&kept).unwrap();
    for command in ["activate", "close"] {
        assert_eq!(http(&px, &a, "GET", &format!("/json/{command}/{kept}"), HOST).await, (403, TAKEN_OVER.to_string()), "{command}");
    }
    assert_eq!(browser.asked("Target.closeTarget").len(), 1);
    px.hand_back(&kept).unwrap();
    assert_eq!(http(&px, &a, "GET", &format!("/json/activate/{kept}"), HOST).await.0, 200);
}

#[tokio::test]
async fn an_agents_connection_gets_a_first_tab_and_ends_with_its_attachment_keeping_its_tabs() {
    let browser = Browser::start().await;
    let px = CdpProxy::new(browser.port);
    let (a, b) = (key("a"), key("b"));
    px.attach(&a);
    px.attach(&b);
    // It connects like omp's browser tool: a WebSocket to the browser target.
    let mut ws = websocket(&px, &a, "/devtools/browser/whatever").await;
    ask(&mut ws, 1, "Browser.getVersion", json!({})).await;
    // It had no tab: it gets a blank one, in a window of its own, which is its alone.
    assert_eq!(browser.asked("Target.createTarget"), vec![json!({ "url": "about:blank", "newWindow": true })]);
    let tabs = px.tabs();
    assert_eq!(tabs.len(), 1, "{tabs:?}");
    assert_eq!((tabs[0].agent_id.as_str(), tabs[0].detached, tabs[0].lent), ("a", false, false));
    let first = tabs[0].target_id.clone();
    assert_eq!(px.with_reg(|r| r.id_vis(&b, &first)), Vis::Foreign);
    // What would hurt the user or the others is refused here and never reaches the browser.
    let refused = ask(&mut ws, 2, "Browser.close", json!({})).await;
    assert_eq!(refused["error"]["code"], json!(-32000));
    assert!(refused["error"]["message"].as_str().unwrap().contains("TeleFlock refused `Browser.close`"), "{refused}");
    assert!(browser.asked("Browser.close").is_empty());
    // One first tab per agent, not per connection.
    let mut second = websocket(&px, &a, "/devtools/browser/whatever").await;
    ask(&mut second, 1, "Browser.getVersion", json!({})).await;
    assert_eq!((px.tabs().len(), browser.asked("Target.createTarget").len()), (1, 1));

    // Detached: its connections end with the reason, its tab stays (labelled detached), and it is
    // refused until it attaches again.
    px.detach(&a);
    for w in [&mut ws, &mut second] {
        assert_eq!(closed_with(w).await, "detached from the browser");
    }
    let tabs = px.tabs();
    assert_eq!((tabs.len(), tabs[0].target_id.as_str(), tabs[0].detached), (1, first.as_str(), true));
    assert_eq!(http(&px, &a, "GET", "/json/version", HOST).await.0, 403);
    // The other agent carries on, with a tab of its own.
    let mut theirs = websocket(&px, &b, "/devtools/browser/whatever").await;
    ask(&mut theirs, 1, "Browser.getVersion", json!({})).await;
    assert_eq!(px.tabs().iter().filter(|t| t.agent_id == "b" && !t.detached).count(), 1);
    // Attached again, the agent has its tab back and gets no new one.
    px.attach(&a);
    let mut back = websocket(&px, &a, "/devtools/browser/whatever").await;
    ask(&mut back, 1, "Browser.getVersion", json!({})).await;
    let mine: Vec<(String, bool)> = px.tabs().into_iter().filter(|t| t.agent_id == "a").map(|t| (t.target_id, t.detached)).collect();
    assert_eq!(mine, [(first, false)]);
}

#[tokio::test]
async fn detaching_ends_an_agents_idle_http_connection_too() {
    let (_browser, px) = setup().await;
    let a = key("a");
    let mut io = connection(&px, &a);
    // Keep-alive: the connection stays open after the answer.
    io.write_all(format!("GET /json/version HTTP/1.1\r\nHost: {HOST}\r\n\r\n").as_bytes()).await.unwrap();
    assert_eq!(one_response(&mut io).await.0, 200);
    px.detach(&a);
    let mut rest = Vec::new();
    tokio::time::timeout(WAIT, io.read_to_end(&mut rest)).await.expect("the proxy closes it").unwrap();
    assert!(rest.is_empty(), "{rest:?}");
}

#[tokio::test]
async fn a_page_connection_is_for_the_agents_own_pages_only_and_never_for_a_web_page() {
    let (_browser, px) = setup().await;
    let (a, b) = (key("a"), key("b"));
    let (own, theirs) = (new_tab(&px, &a, "https://a.example/").await, new_tab(&px, &b, "https://b.example/").await);
    // The user's page, another agent's and one that does not exist: no such target.
    for id in [USER_PAGE, theirs.as_str(), "NOSUCHPAGE"] {
        assert_eq!(refused_upgrade(&px, &a, &format!("/devtools/page/{id}"), None).await, (404, format!("No such target id: {id}")));
    }
    // A web page (its connection carries an `Origin`) may not connect, as with Chrome.
    let (code, body) = refused_upgrade(&px, &a, &format!("/devtools/page/{own}"), Some("https://evil.example")).await;
    assert_eq!(code, 403, "{body}");
    assert!(body.contains("https://evil.example"), "{body}");
    // Its own page connects, until the user takes it over; then the connection ends with the
    // reason and the page is not offered to it until it is handed back.
    let path = format!("/devtools/page/{own}");
    let mut ws = websocket(&px, &a, &path).await;
    ask(&mut ws, 1, "Runtime.evaluate", json!({ "expression": "1" })).await;
    px.take_over(&own).unwrap();
    assert_eq!(closed_with(&mut ws).await, TAKEN_OVER);
    assert_eq!(refused_upgrade(&px, &a, &path, None).await.0, 404);
    px.hand_back(&own).unwrap();
    let mut again = websocket(&px, &a, &path).await;
    ask(&mut again, 1, "Runtime.evaluate", json!({ "expression": "1" })).await;
}
