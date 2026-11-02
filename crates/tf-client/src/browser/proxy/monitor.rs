//! The proxy's own DevTools connection to the browser: it reports every target to the
//! [`Registry`] (`Target.setDiscoverTargets`), learns which page each tab shows (it auto-attaches
//! tabs, then each tab's page, and detaches the page at once; it never waits for a debugger, so
//! it never pauses anything), adopts agents' popups, and runs the proxy's own commands
//! (`/json/new`, `/json/close`, `/json/activate`, an agent's first tab).

use std::collections::{HashMap, HashSet};
use std::sync::Weak;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::Message;

use super::registry::Registry;
use super::{CdpProxy, ws_config};

/// The proxy's own commands: method, params, and where the answer goes (`Err`: the browser's
/// error message, or that the connection is gone).
pub(super) struct Call {
    pub method: String,
    pub params: Value,
    pub reply: oneshot::Sender<Result<Value, String>>,
}

/// What the monitor's connection does with the browser's messages (pure).
#[derive(Default)]
pub(super) struct Monitor {
    next_id: i64,
    /// Root-level sessions to tab targets, with the tab.
    tab_sessions: HashMap<String, String>,
    /// Commands the first report waits for.
    awaiting: HashSet<i64>,
    discover_id: Option<i64>,
    /// `Target.setDiscoverTargets` answered: later `targetCreated` are new targets.
    started: bool,
}

impl Monitor {
    pub fn next_id(&mut self) -> i64 {
        self.next_id += 1;
        self.next_id
    }

    fn cmd(&mut self, method: &str, params: Value, session: Option<&str>) -> (i64, String) {
        let id = self.next_id();
        let mut m = json!({ "id": id, "method": method, "params": params });
        if let Some(s) = session {
            m["sessionId"] = json!(s);
        }
        (id, m.to_string())
    }

    /// Discovery of every target, and auto-attach of tabs (never waiting).
    pub fn start(&mut self) -> Vec<String> {
        let (d, discover) = self.cmd("Target.setDiscoverTargets", json!({ "discover": true, "filter": [{}] }), None);
        let (a, auto) = self.cmd(
            "Target.setAutoAttach",
            json!({
                "autoAttach": true,
                "waitForDebuggerOnStart": false,
                "flatten": true,
                "filter": [{ "type": "tab" }, { "exclude": true }],
            }),
            None,
        );
        self.discover_id = Some(d);
        self.awaiting.extend([d, a]);
        vec![discover, auto]
    }

    /// A message from the browser (not an answer to a `Call`); returns commands to send.
    pub fn on_message(&mut self, reg: &mut Registry, msg: &Value) -> Vec<String> {
        if let Some(id) = msg.get("id").and_then(Value::as_i64) {
            if self.awaiting.remove(&id) {
                if Some(id) == self.discover_id {
                    self.started = true;
                }
                if self.started && self.awaiting.is_empty() && !reg.synced {
                    reg.synced_now();
                }
            }
            return Vec::new();
        }
        let Some(method) = msg.get("method").and_then(Value::as_str) else { return Vec::new() };
        let empty = json!({});
        let params = msg.get("params").unwrap_or(&empty);
        let info = params.get("targetInfo").unwrap_or(&empty);
        let session = msg.get("sessionId").and_then(Value::as_str);
        match method {
            "Target.targetCreated" => reg.target_seen(info, self.started),
            "Target.targetInfoChanged" => reg.target_seen(info, false),
            "Target.targetDestroyed" => {
                if let Some(id) = params.get("targetId").and_then(Value::as_str) {
                    reg.target_gone(id);
                }
            }
            "Target.attachedToTarget" => {
                let Some(sid) = params.get("sessionId").and_then(Value::as_str) else { return Vec::new() };
                match session {
                    None => {
                        let tab = info.get("targetId").and_then(Value::as_str).unwrap_or_default();
                        if info.get("type").and_then(Value::as_str) != Some("tab") {
                            return vec![self.cmd("Target.detachFromTarget", json!({ "sessionId": sid }), None).1];
                        }
                        self.tab_sessions.insert(sid.to_string(), tab.to_string());
                        reg.target_seen(info, false);
                        let (id, cmd) = self.cmd(
                            "Target.setAutoAttach",
                            json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true }),
                            Some(sid),
                        );
                        if !reg.synced {
                            self.awaiting.insert(id);
                        }
                        return vec![cmd];
                    }
                    Some(parent) => {
                        if let Some(tab) = self.tab_sessions.get(parent) {
                            reg.tab_shows(tab, info);
                        }
                        // Knowing the page is enough: no session on it.
                        return vec![self.cmd("Target.detachFromTarget", json!({ "sessionId": sid }), Some(parent)).1];
                    }
                }
            }
            "Target.detachedFromTarget" if session.is_none() => {
                if let Some(sid) = params.get("sessionId").and_then(Value::as_str) {
                    self.tab_sessions.remove(sid);
                }
            }
            _ => {}
        }
        Vec::new()
    }
}

/// Runs the monitor's connection to the browser on `port` until it ends, `stop` turns true or the
/// proxy is gone; answers `calls` meanwhile.
pub(super) async fn run(
    px: Weak<CdpProxy>,
    port: u16,
    mut calls: mpsc::UnboundedReceiver<Call>,
    mut stop: watch::Receiver<bool>,
) {
    let ws = match super::http::browser_ws_url(port).await {
        Ok(url) => connect(&url).await,
        Err(e) => Err(e),
    };
    let mut ws = match ws {
        Ok(ws) => ws,
        Err(e) => {
            log::warn!("browser proxy: monitor cannot reach the browser on port {port}: {e}");
            while let Ok(c) = calls.try_recv() {
                let _ = c.reply.send(Err(e.clone()));
            }
            return;
        }
    };
    let mut mon = Monitor::default();
    let mut waiting: HashMap<i64, oneshot::Sender<Result<Value, String>>> = HashMap::new();
    let mut failed = false;
    for m in mon.start() {
        failed |= ws.send(Message::text(m)).await.is_err();
    }
    while !failed && !*stop.borrow() {
        tokio::select! {
            msg = ws.next() => {
                let text = match msg {
                    Some(Ok(Message::Text(t))) => t,
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => continue,
                };
                let Ok(v) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                if let Some(reply) = v.get("id").and_then(Value::as_i64).and_then(|id| waiting.remove(&id)) {
                    let r = match v.get("error") {
                        Some(e) => Err(e.get("message").and_then(Value::as_str).unwrap_or("error").to_string()),
                        None => Ok(v.get("result").cloned().unwrap_or_default()),
                    };
                    let _ = reply.send(r);
                    continue;
                }
                let Some(px) = px.upgrade() else { break };
                // Checked under the registry's lock: a monitor told to stop (a restarted or
                // stopped browser) must not report its old targets after the registry was reset.
                let cmds = px.with_reg(|reg| if *stop.borrow() { Vec::new() } else { mon.on_message(reg, &v) });
                drop(px);
                for c in cmds {
                    failed |= ws.send(Message::text(c)).await.is_err();
                }
            }
            call = calls.recv() => {
                let Some(call) = call else { break };
                let id = mon.next_id();
                let m = json!({ "id": id, "method": call.method, "params": call.params });
                if ws.send(Message::text(m.to_string())).await.is_err() {
                    let _ = call.reply.send(Err("the browser connection closed".into()));
                    break;
                }
                waiting.insert(id, call.reply);
            }
            _ = stop.changed() => {}
        }
    }
    for (_, reply) in waiting {
        let _ = reply.send(Err("the browser connection closed".into()));
    }
    let _ = ws.close(None).await;
}

type Ws = tokio_tungstenite::WebSocketStream<TcpStream>;

/// A WebSocket to the browser (without an `Origin` header: the browser checks only origins that
/// are sent).
pub(super) async fn connect(url: &str) -> Result<Ws, String> {
    let rest = url.strip_prefix("ws://").ok_or_else(|| format!("not a ws:// URL: {url}"))?;
    let host = rest.split('/').next().unwrap_or_default();
    let tcp = TcpStream::connect(host).await.map_err(|e| format!("connect {host}: {e}"))?;
    let _ = tcp.set_nodelay(true);
    let (ws, _) = tokio_tungstenite::client_async_with_config(url, tcp, Some(ws_config()))
        .await
        .map_err(|e| format!("WebSocket {url}: {e}"))?;
    Ok(ws)
}
