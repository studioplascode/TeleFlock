//! `tf-devserver`: exposes a [`tf_client::Engine`] to browsers over WebSocket (`/ws`,
//! architecture §5.3) and serves the built UI with an SPA fallback.
//!
//! Wire format (JSON text frames):
//! * client → server: `{id, hostId?, method, params}` requests, and the terminal fast path
//!   `{termIn: {hostId, termId, data}}` (no response).
//! * server → client: `{id, result}` | `{id, error}` responses and `{event: AppEvent}`.
//!   Each connection first receives a replay of the current state as events.
//!
//! Access control lives in [`access`]: allow-listed `Host` on every route, and a per-launch token
//! plus same-origin `Origin` on `/ws`. The served `index.html` carries the token as
//! `<meta name="tf-token">` for loopback requests (or when the page URL has the right `?token=`).

pub mod access;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

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
}

/// Builds the HTTP app: `/ws` plus optional static files with an `index.html` SPA fallback (the
/// index gets the token meta injected). Every route enforces `access`'s Host allow-list.
pub fn router(engine: Engine, static_dir: Option<PathBuf>, access: Access) -> Router {
    let access = Arc::new(access);
    let state = AppState { engine, access: access.clone(), static_dir: static_dir.clone().map(Arc::new) };
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
    let engine = st.engine;
    ws.max_message_size(64 << 20).on_upgrade(move |socket| client(socket, engine))
}

fn event_frame(ev: &AppEvent) -> Message {
    Message::Text(json!({ "event": ev }).to_string().into())
}

async fn client(socket: WebSocket, engine: Engine) {
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
        loop {
            tokio::select! {
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

    while let Some(Ok(msg)) = stream.next().await {
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };
        handle_frame(&engine, &out_tx, text.as_str());
    }
    writer.abort();
}

fn handle_frame(engine: &Engine, out: &mpsc::UnboundedSender<String>, text: &str) {
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
    let engine = engine.clone();
    let out = out.clone();
    tokio::spawn(async move {
        let frame = match engine.call(host.as_deref(), &method, params).await {
            Ok(result) => json!({ "id": id, "result": result }),
            Err(error) => json!({ "id": id, "error": error }),
        };
        let _ = out.send(frame.to_string());
    });
}
