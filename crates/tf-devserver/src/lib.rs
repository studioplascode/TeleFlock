//! `tf-devserver`: exposes a [`tf_client::Engine`] to browsers over WebSocket (`/ws`,
//! architecture §5.3) and serves the built UI with an SPA fallback.
//!
//! Wire format (JSON text frames):
//! * client → server: `{id, hostId?, method, params}` requests, and the terminal fast path
//!   `{termIn: {hostId, termId, data}}` (no response).
//! * server → client: `{id, result}` | `{id, error}` responses and `{event: AppEvent}`.
//!   Each connection first receives a replay of the current state as events.
//! * Every tab shares the engine's single hostd client per host, so session subscriptions are
//!   reference-counted across tabs ([`Subs`]): a tab closing a session (or going away) only
//!   unsubscribes once no other tab has it open, and a tab's terminals close with it.
//!
//! Access control lives in [`access`]: allow-listed `Host` on every route, and a per-launch token
//! plus same-origin `Origin` on `/ws`. The served `index.html` carries the token as
//! `<meta name="tf-token">` for loopback requests (or when the page URL has the right `?token=`).

pub mod access;

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade, rejection::WebSocketUpgradeRejection};
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tf_client::tf_proto::{ApiError, AppEvent};
use tf_client::{BadgeState, Engine, NotifyStyle, Platform};
use tokio::sync::{broadcast, mpsc};
use tower_http::services::ServeDir;

pub use access::Access;

/// Platform for the devserver: OS integration happens in the browser, so notifications are
/// left to the UI (`AppEvent::Notify`) and logged here.
pub struct DevPlatform;

impl Platform for DevPlatform {
    fn notify(&self, host: Option<&tf_client::tf_proto::HostProfile>, n: &tf_client::tf_proto::Notification, _: NotifyStyle) {
        log::info!("notify [{}] {}: {}", host.map(|h| h.name.as_str()).unwrap_or("-"), n.title, n.body);
    }
    fn open_external(&self, url: &str) -> Result<(), ApiError> {
        Err(ApiError::new("unsupported", format!("the devserver cannot open `{url}`"))
            .with_hint("open the link from the browser"))
    }
    fn set_keep_alive(&self, on: bool) {
        log::debug!("keep-alive {on}");
    }
    fn set_badge(&self, b: BadgeState) {
        log::debug!("badge needs={} running={}", b.needs, b.running);
    }
    fn device_name(&self) -> String {
        hostname()
    }
    fn supports_notifications(&self) -> bool {
        false
    }
}

pub fn hostname() -> String {
    for var in ["HOSTNAME", "COMPUTERNAME"] {
        if let Ok(h) = std::env::var(var)
            && !h.trim().is_empty()
        {
            return h.trim().to_string();
        }
    }
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "devserver".into())
}

#[derive(Clone)]
struct AppState {
    engine: Engine,
    access: Arc<Access>,
    static_dir: Option<Arc<PathBuf>>,
    subs: Arc<Mutex<Subs>>,
    keepalive: Keepalive,
}

/// `(hostId, agentId)` of an open session, or `(hostId, termId)` of an open terminal.
type SubKey = (String, String);

/// Session subscriptions across tabs: how many tabs have each session open.
#[derive(Default)]
struct Subs {
    sessions: HashMap<SubKey, usize>,
}

/// What one tab holds open.
#[derive(Default)]
struct ConnSubs {
    sessions: HashSet<SubKey>,
    terms: HashSet<SubKey>,
    /// The tab is gone: anything opened from now on (in-flight requests) is released at once.
    closed: bool,
}

/// Per-connection context for [`handle_frame`].
#[derive(Clone)]
struct Conn {
    engine: Engine,
    subs: Arc<Mutex<Subs>>,
    mine: Arc<Mutex<ConnSubs>>,
}

impl Conn {
    /// Records a successful `session.open` / `term.open`. Lock order: `subs` before `mine`.
    /// When the tab already went away (the open was in flight), the result is released at once.
    fn opened(&self, method: &str, host: &str, params: &Value, result: &Value) {
        let release = match method {
            "session.open" => {
                let Some(agent) = params.get("agentId").and_then(Value::as_str) else { return };
                let key = (host.to_string(), agent.to_string());
                let mut subs = self.subs.lock().unwrap();
                let mut mine = self.mine.lock().unwrap();
                if mine.closed {
                    // Only unsubscribe when no other tab shows it.
                    (!subs.sessions.contains_key(&key)).then(|| ("session.close", json!({ "agentId": agent })))
                } else {
                    if mine.sessions.insert(key.clone()) {
                        *subs.sessions.entry(key).or_default() += 1;
                    }
                    None
                }
            }
            "term.open" => {
                let Some(term) = result.get("termId").and_then(Value::as_str) else { return };
                let mut mine = self.mine.lock().unwrap();
                if mine.closed {
                    Some(("term.close", json!({ "termId": term })))
                } else {
                    mine.terms.insert((host.to_string(), term.to_string()));
                    None
                }
            }
            _ => None,
        };
        if let Some((method, params)) = release {
            spawn_release(self.engine.clone(), host.to_string(), method, params);
        }
    }

    /// This tab drops `key`; true when no tab holds it any more (forward the close to hostd).
    fn release_session(&self, key: &SubKey) -> bool {
        let mut subs = self.subs.lock().unwrap();
        if self.mine.lock().unwrap().sessions.remove(key)
            && let Some(n) = subs.sessions.get_mut(key)
        {
            *n = n.saturating_sub(1);
        }
        match subs.sessions.get(key) {
            Some(0) | None => {
                subs.sessions.remove(key);
                true
            }
            Some(_) => false,
        }
    }

    /// The tab went away: close its terminals and the sessions only it had open.
    fn release_all(&self) {
        let (sessions, terms) = {
            let mut mine = self.mine.lock().unwrap();
            mine.closed = true;
            (std::mem::take(&mut mine.sessions), std::mem::take(&mut mine.terms))
        };
        let mut calls: Vec<(String, &'static str, Value)> =
            terms.into_iter().map(|(h, t)| (h, "term.close", json!({ "termId": t }))).collect();
        {
            let mut subs = self.subs.lock().unwrap();
            for key in sessions {
                let last = subs.sessions.get_mut(&key).is_none_or(|n| {
                    *n = n.saturating_sub(1);
                    *n == 0
                });
                if last {
                    subs.sessions.remove(&key);
                    calls.push((key.0, "session.close", json!({ "agentId": key.1 })));
                }
            }
        }
        for (host, method, params) in calls {
            spawn_release(self.engine.clone(), host, method, params);
        }
    }
}

fn spawn_release(engine: Engine, host: String, method: &'static str, params: Value) {
    tokio::spawn(async move {
        if let Err(e) = engine.call(Some(&host), method, params).await {
            log::debug!("{method} on tab close: {}", e.message);
        }
    });
}

/// WebSocket liveness: the server pings every `ping_every`; a socket that sends nothing (not even
/// the browser's automatic pong) for `timeout` is treated as gone, which releases its terminals
/// and sessions even when the peer vanished without a close frame or FIN (sleep, network loss).
#[derive(Debug, Clone, Copy)]
pub struct Keepalive {
    pub ping_every: std::time::Duration,
    pub timeout: std::time::Duration,
}

impl Default for Keepalive {
    fn default() -> Self {
        Self { ping_every: std::time::Duration::from_secs(15), timeout: std::time::Duration::from_secs(45) }
    }
}

/// Builds the HTTP app: `/ws` plus optional static files with an `index.html` SPA fallback (the
/// index gets the token meta injected). Every route enforces `access`'s Host allow-list.
pub fn router(engine: Engine, static_dir: Option<PathBuf>, access: Access, keepalive: Keepalive) -> Router {
    let access = Arc::new(access);
    let state = AppState {
        engine,
        access: access.clone(),
        static_dir: static_dir.clone().map(Arc::new),
        subs: Arc::default(),
        keepalive,
    };
    let mut app = Router::new().route("/ws", get(ws_handler));
    if let Some(dir) = static_dir {
        let index = get(index_html).with_state(state.clone());
        app = app
            .route("/index.html", get(index_html))
            .fallback_service(ServeDir::new(dir).append_index_html_on_directories(false).fallback(index));
    }
    app.with_state(state).layer(middleware::from_fn_with_state(access, check_host))
}

pub async fn serve(listener: tokio::net::TcpListener, app: Router) -> std::io::Result<()> {
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await
}

/// Host allow-list for every route (DNS rebinding).
async fn check_host(State(access): State<Arc<Access>>, req: Request, next: Next) -> Response {
    match access::request_authority(req.headers(), req.uri()) {
        Some(host) if access.host_allowed(host) => next.run(req).await,
        _ => (StatusCode::MISDIRECTED_REQUEST, "unexpected Host header").into_response(),
    }
}

/// `index.html` (also for `/` and SPA routes), uncached. The token meta is injected when the
/// request is a loopback client addressing a loopback name, or the page URL has the right
/// `?token=`, so neither remote peers nor reverse-proxied clients can read the token from it.
async fn index_html(State(st): State<AppState>, req: Request) -> Response {
    let Some(dir) = &st.static_dir else { return StatusCode::NOT_FOUND.into_response() };
    let html = match tokio::fs::read_to_string(dir.join("index.html")).await {
        Ok(html) => html,
        Err(e) => {
            log::warn!("{}: {e}", dir.join("index.html").display());
            return (StatusCode::NOT_FOUND, "index.html not found (build the UI with `bun run build`)").into_response();
        }
    };
    let loopback_peer = req.extensions().get::<ConnectInfo<SocketAddr>>().is_some_and(|c| c.0.ip().to_canonical().is_loopback());
    let loopback_host = access::request_authority(req.headers(), req.uri()).is_some_and(Access::is_loopback_host);
    let body = if (loopback_peer && loopback_host) || st.access.query_token_ok(req.uri().query()) {
        access::inject_token_meta(&html, st.access.token())
    } else {
        html
    };
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8"), (header::CACHE_CONTROL, "no-store")], body).into_response()
}

/// `/ws`: authorized (Host, Origin, token) before the upgrade is accepted.
async fn ws_handler(
    State(st): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let protocol = match st.access.authorize_ws(&headers, &uri) {
        Ok(p) => p,
        Err((status, why)) => {
            log::warn!("rejected /ws request: {why}");
            return (status, why).into_response();
        }
    };
    let ws = match ws {
        Ok(ws) => ws,
        Err(e) => return e.into_response(),
    };
    let ws = match protocol {
        Some(p) => ws.protocols([p]),
        None => ws,
    };
    let conn = Conn { engine: st.engine, subs: st.subs, mine: Arc::default() };
    let keepalive = st.keepalive;
    ws.max_message_size(64 << 20).on_upgrade(move |socket| client(socket, conn, keepalive))
}

fn event_frame(ev: &AppEvent) -> Message {
    Message::Text(json!({ "event": ev }).to_string().into())
}

async fn client(socket: WebSocket, conn: Conn, keepalive: Keepalive) {
    let engine = conn.engine.clone();
    let (mut sink, mut stream) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let (replay, mut events) = engine.subscribe_with_replay();

    let writer_engine = engine.clone();
    let writer = tokio::spawn(async move {
        for ev in &replay {
            if sink.send(event_frame(ev)).await.is_err() {
                return;
            }
        }
        let mut ping = tokio::time::interval(keepalive.ping_every);
        ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = ping.tick() => {
                    if sink.send(Message::Ping(Default::default())).await.is_err() {
                        break;
                    }
                }
                out = out_rx.recv() => {
                    let Some(out) = out else { break };
                    if sink.send(Message::Text(out.into())).await.is_err() {
                        break;
                    }
                }
                ev = events.recv() => match ev {
                    Ok(ev) => {
                        if sink.send(event_frame(&ev)).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        log::warn!("ws client lagged by {n} events; resending state");
                        let (replay, rx) = writer_engine.subscribe_with_replay();
                        events = rx;
                        for ev in &replay {
                            if sink.send(event_frame(ev)).await.is_err() {
                                return;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                },
            }
        }
        let _ = sink.close().await;
    });

    // Any frame (including the browser's automatic pong) proves the peer is alive.
    loop {
        let msg = match tokio::time::timeout(keepalive.timeout, stream.next()).await {
            Ok(Some(Ok(msg))) => msg,
            Ok(Some(Err(e))) => {
                log::debug!("ws read error: {e}");
                break;
            }
            Ok(None) => break,
            Err(_) => {
                log::info!("ws client silent for {}s; dropping it", keepalive.timeout.as_secs());
                break;
            }
        };
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };
        handle_frame(&conn, &out_tx, text.as_str());
    }
    writer.abort();
    conn.release_all();
}

fn handle_frame(conn: &Conn, out: &mpsc::UnboundedSender<String>, text: &str) {
    let engine = &conn.engine;
    let v: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            let _ = out.send(json!({ "id": null, "error": ApiError::new("invalid_params", format!("bad frame: {e}")) }).to_string());
            return;
        }
    };
    if let Some(t) = v.get("termIn") {
        let (Some(h), Some(term), Some(data)) = (
            t.get("hostId").and_then(Value::as_str),
            t.get("termId").and_then(Value::as_str),
            t.get("data").and_then(Value::as_str),
        ) else {
            return;
        };
        engine.term_input(h, term, data.to_string());
        return;
    }
    let id = v.get("id").cloned().unwrap_or(Value::Null);
    let Some(method) = v.get("method").and_then(Value::as_str).map(String::from) else {
        let _ = out.send(json!({ "id": id, "error": ApiError::new("invalid_params", "missing `method`") }).to_string());
        return;
    };
    let host = v.get("hostId").and_then(Value::as_str).map(String::from);
    let params = match v.get("params") {
        None | Some(Value::Null) => json!({}),
        Some(p) => p.clone(),
    };
    // Another tab still shows this session: only this tab lets go.
    if method == "session.close"
        && let (Some(h), Some(agent)) = (&host, params.get("agentId").and_then(Value::as_str))
        && !conn.release_session(&(h.clone(), agent.to_string()))
    {
        let _ = out.send(json!({ "id": id, "result": {} }).to_string());
        return;
    }
    if method == "term.close"
        && let (Some(h), Some(term)) = (&host, params.get("termId").and_then(Value::as_str))
    {
        conn.mine.lock().unwrap().terms.remove(&(h.clone(), term.to_string()));
    }
    let conn = conn.clone();
    let out = out.clone();
    tokio::spawn(async move {
        let frame = match conn.engine.call(host.as_deref(), &method, params.clone()).await {
            Ok(result) => {
                if let Some(h) = &host {
                    conn.opened(&method, h, &params, &result);
                }
                json!({ "id": id, "result": result })
            }
            Err(error) => json!({ "id": id, "error": error }),
        };
        let _ = out.send(frame.to_string());
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sessions_are_shared_across_tabs() {
        let data = tempfile::tempdir().unwrap();
        let cfg = tf_client::EngineConfig {
            data_dir: data.path().to_path_buf(),
            platform_name: "linux".into(),
            client_app: "teleflock-devserver".into(),
            version: "0.0.0".into(),
            hostd_bins_override: None,
        };
        let (engine, _rx) = Engine::start(cfg, Arc::new(DevPlatform)).await;
        let subs: Arc<Mutex<Subs>> = Arc::default();
        let tab = || Conn { engine: engine.clone(), subs: subs.clone(), mine: Arc::default() };
        let (a, b) = (tab(), tab());
        let key = ("lab".to_string(), "term_1".to_string());
        let open = json!({ "agentId": "term_1" });
        a.opened("session.open", "lab", &open, &json!({}));
        a.opened("session.open", "lab", &open, &json!({})); // re-open after reconnect: still one
        b.opened("session.open", "lab", &open, &json!({}));
        b.opened("term.open", "lab", &json!({}), &json!({ "termId": "t1" }));
        assert_eq!(subs.lock().unwrap().sessions[&key], 2);
        assert!(!a.release_session(&key), "b still shows it");
        assert!(!a.release_session(&key), "a's second close is a no-op");
        b.release_all();
        assert!(subs.lock().unwrap().sessions.is_empty());
        assert!(b.mine.lock().unwrap().terms.is_empty());
        assert!(a.release_session(&key), "nobody holds it: forward");
        // Opens that were in flight when the tab went away are released, not tracked.
        b.opened("term.open", "lab", &json!({}), &json!({ "termId": "t2" }));
        assert!(b.mine.lock().unwrap().terms.is_empty());
        b.opened("session.open", "lab", &json!({ "agentId": "term_9" }), &json!({}));
        assert!(subs.lock().unwrap().sessions.is_empty(), "late session.open is not counted");
    }
}
