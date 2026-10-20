//! `tf-devserver`: exposes a [`tf_client::Engine`] to browsers over WebSocket (`/ws`,
//! architecture §5.3) and serves the built UI with an SPA fallback.
//!
//! Wire format (JSON text frames):
//! * client → server: `{id, hostId?, method, params}` requests, and the terminal fast path
//!   `{termIn: {hostId, termId, data}}` (no response).
//! * server → client: `{id, result}` | `{id, error}` responses and `{event: AppEvent}`.
//!   Each connection first receives a replay of the current state as events.

use std::net::SocketAddr;
use std::path::PathBuf;

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::IntoResponse;
use axum::routing::get;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tf_client::tf_proto::{ApiError, AppEvent};
use tf_client::{BadgeState, Engine, NotifyStyle, Platform};
use tokio::sync::{broadcast, mpsc};
use tower_http::services::{ServeDir, ServeFile};

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

/// Builds the HTTP app: `/ws` plus optional static files with `index.html` fallback.
pub fn router(engine: Engine, static_dir: Option<PathBuf>) -> Router {
    let app = Router::new().route("/ws", get(ws_handler)).with_state(engine);
    match static_dir {
        Some(dir) => {
            let index = dir.join("index.html");
            app.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index)))
        }
        None => app,
    }
}

pub async fn serve(listener: tokio::net::TcpListener, app: Router) -> std::io::Result<()> {
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await
}

async fn ws_handler(ws: WebSocketUpgrade, State(engine): State<Engine>) -> impl IntoResponse {
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
