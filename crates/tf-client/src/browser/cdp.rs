//! A DevTools client for the app core's own few calls to the browser (`Browser.close`,
//! `Storage.clearCookies`, `Network.clearBrowserCache`): one WebSocket to the browser target per
//! errand, sent without an `Origin` header (the browser only checks origins that are sent).

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const CALL_TIMEOUT: Duration = Duration::from_secs(15);

pub(super) struct Cdp {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    next: u64,
}

impl Cdp {
    /// Connects to the browser target (`ws://127.0.0.1:<port>/devtools/browser/<id>`).
    pub async fn connect(ws_url: &str) -> Result<Cdp, String> {
        let (ws, _) = tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(ws_url))
            .await
            .map_err(|_| "the browser's DevTools did not answer".to_string())?
            .map_err(|e| format!("can't reach the browser's DevTools: {e}"))?;
        Ok(Cdp { ws, next: 0 })
    }

    /// Sends one command (to a flat session's target with `session`) and waits for its answer;
    /// events in between are skipped.
    pub async fn call(&mut self, method: &str, params: Value, session: Option<&str>) -> Result<Value, String> {
        self.next += 1;
        let id = self.next;
        let mut msg = json!({ "id": id, "method": method, "params": params });
        if let Some(s) = session {
            msg["sessionId"] = s.into();
        }
        self.ws.send(Message::text(msg.to_string())).await.map_err(|e| format!("{method}: {e}"))?;
        let answer = async {
            while let Some(m) = self.ws.next().await {
                let text = match m.map_err(|e| format!("{method}: {e}"))? {
                    Message::Text(t) => t,
                    Message::Close(_) => break,
                    _ => continue,
                };
                let Ok(v) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                if v.get("id").and_then(Value::as_u64) != Some(id) {
                    continue;
                }
                return match v.get("error") {
                    Some(e) => Err(format!("{method}: {}", e.get("message").and_then(Value::as_str).unwrap_or("failed"))),
                    None => Ok(v.get("result").cloned().unwrap_or(Value::Null)),
                };
            }
            Err(format!("{method}: the browser closed the connection"))
        };
        tokio::time::timeout(CALL_TIMEOUT, answer).await.map_err(|_| format!("{method}: the browser did not answer"))?
    }
}

/// Asks the browser to quit (`Browser.close`): it closes its windows and profile cleanly. It may
/// close the connection before it answers, which counts as done.
pub(super) async fn close_browser(ws_url: &str) -> Result<(), String> {
    let mut c = Cdp::connect(ws_url).await?;
    match c.call("Browser.close", json!({}), None).await {
        Ok(_) => Ok(()),
        Err(e) if e.ends_with("closed the connection") => Ok(()),
        Err(e) => Err(e),
    }
}

/// Deletes every cookie of the profile (the user is signed out everywhere).
pub(super) async fn clear_cookies(ws_url: &str) -> Result<(), String> {
    Cdp::connect(ws_url).await?.call("Storage.clearCookies", json!({}), None).await.map(drop)
}

/// Empties the HTTP cache. `Network.clearBrowserCache` is a page's command (it clears the whole
/// profile's cache): it goes to a page that exists, or to a blank one opened for it.
pub(super) async fn clear_cache(ws_url: &str) -> Result<(), String> {
    let mut c = Cdp::connect(ws_url).await?;
    let targets = c.call("Target.getTargets", json!({}), None).await?;
    let page = targets
        .get("targetInfos")
        .and_then(Value::as_array)
        .and_then(|all| all.iter().find(|t| t.get("type").and_then(Value::as_str) == Some("page")))
        .and_then(|t| t.get("targetId").and_then(Value::as_str).map(String::from));
    let (target, opened) = match page {
        Some(t) => (t, false),
        None => {
            let made = c.call("Target.createTarget", json!({ "url": "about:blank", "background": true }), None).await?;
            (made.get("targetId").and_then(Value::as_str).unwrap_or_default().to_string(), true)
        }
    };
    let attached = c.call("Target.attachToTarget", json!({ "targetId": target, "flatten": true }), None).await?;
    let session = attached.get("sessionId").and_then(Value::as_str).unwrap_or_default().to_string();
    let cleared = c.call("Network.clearBrowserCache", json!({}), Some(&session)).await;
    let _ = c.call("Target.detachFromTarget", json!({ "sessionId": session }), None).await;
    if opened {
        let _ = c.call("Target.closeTarget", json!({ "targetId": target }), None).await;
    }
    cleared.map(drop)
}
