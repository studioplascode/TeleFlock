//! The agents' DevTools proxy: every agent attached to the browser gets its own scoped DevTools
//! endpoint (tf-hostd streams each connection to the agent's `127.0.0.1:<hostPort>` here, and
//! [`CdpProxy::serve`] serves it), never the browser's own port.
//!
//! * An agent sees and drives its own tabs: the ones it opened, popups of its pages, and the user's
//!   tabs lent to it ([`CdpProxy::lend_tab`]); while the user lets agents use their tabs
//!   ([`CdpProxy::set_share`]) also every tab of the user's showing a web page, listed after its
//!   own: it reads them, clicks and types in them and browses in them, but may not close them. A
//!   tab the user locked ([`CdpProxy::lock_tab`], one of theirs or one they lent) stays on its
//!   page: agents may not navigate, reload or close it. Other agents' tabs do not exist for it;
//!   commands that would hurt the user or the other agents (`Browser.close`, cookie and cache
//!   wipes, downloads settings, the device's files, …) are refused (`filter.rs`).
//! * Where its tabs open: headless, each in a window of its own (a background tab of a headless
//!   window paints no frames, and the app's panel shows them); in its own window (headed) as the
//!   agent asks, its first one as a tab of the user's window in the foreground. Before a clean
//!   stop or relaunch they close ([`CdpProxy::close_agents_tabs`]): the browser restores the
//!   user's session, not theirs.
//! * The user stays in charge: [`CdpProxy::take_over`] detaches the agent from a tab (its next
//!   command there fails with "the user took over this tab") until [`CdpProxy::hand_back`];
//!   [`CdpProxy::detach`] ends an agent's connections, its tabs stay (detached).
//! * Who owns what: [`CdpProxy::tabs`], with [`CdpProxy::changes`] on every change.
//!
//! Parts: `registry` (targets and owners), `monitor` (the proxy's own connection to the browser:
//! targets, which page each tab shows, popups), `filter` (one connection's JSON-RPC filter),
//! `http` (`/json/*` and the upgrade), `session` (one WebSocket).

mod filter;
mod http;
mod monitor;
mod registry;
mod session;

#[cfg(test)]
mod live;
#[cfg(test)]
mod served;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde_json::{Value, json};
use tf_proto::{ApiError, BrowserTabOwner, Millis};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

use self::registry::Registry;

/// How long the proxy's own commands to the browser may take.
const CALL_TIMEOUT: Duration = Duration::from_secs(10);

/// An attachment: an agent on a host.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct AttachKey {
    pub host_id: String,
    pub agent_id: String,
}

/// WebSockets carry whole screenshots and PDFs.
pub(super) fn ws_config() -> WebSocketConfig {
    WebSocketConfig::default().max_message_size(Some(256 << 20)).max_frame_size(Some(256 << 20))
}

struct Monitor {
    calls: mpsc::UnboundedSender<monitor::Call>,
    stop: watch::Sender<bool>,
}

struct Upstream {
    port: u16,
    monitor: Option<Monitor>,
    /// The browser target's WebSocket URL, once known.
    ws_url: Option<String>,
}

/// One connection served (`serve`): whose, and how to end it (the reason it ends with).
struct Conn {
    who: AttachKey,
    stop: watch::Sender<Option<String>>,
}

pub(crate) struct CdpProxy {
    me: Weak<CdpProxy>,
    reg: Mutex<Registry>,
    /// Bumped when `tabs()`, `locked_tabs()` or `active_at` changed.
    changes: watch::Sender<u64>,
    /// Bumped on every registry change (connections re-check what they hold back).
    internal: watch::Sender<u64>,
    up: Mutex<Upstream>,
    conns: Mutex<HashMap<u64, Conn>>,
    next_conn: AtomicU64,
    /// Serializes "does this agent have a tab yet" with opening its first one.
    first_tab: tokio::sync::Mutex<()>,
}

impl CdpProxy {
    /// A proxy for the browser whose DevTools listen on `127.0.0.1:<upstream_port>`, running in
    /// its own window (`headed`) or headless; `share`: agents may use the user's tabs.
    pub(crate) fn new(upstream_port: u16, headed: bool, share: bool) -> Arc<CdpProxy> {
        let mut reg = Registry::default();
        reg.headed = headed;
        reg.share = share;
        Arc::new_cyclic(|me| CdpProxy {
            me: me.clone(),
            reg: Mutex::new(reg),
            changes: watch::channel(0).0,
            internal: watch::channel(0).0,
            up: Mutex::new(Upstream { port: upstream_port, monitor: None, ws_url: None }),
            conns: Mutex::new(HashMap::new()),
            next_conn: AtomicU64::new(0),
            first_tab: tokio::sync::Mutex::new(()),
        })
    }

    /// The browser restarted on `port` (in its own window or headless, `headed`): every agent
    /// connection ends and the targets (new ids) are forgotten; attachments stay.
    pub(crate) fn set_upstream(&self, port: u16, headed: bool) {
        {
            let mut up = self.up.lock().unwrap();
            up.port = port;
            up.ws_url = None;
            if let Some(m) = up.monitor.take() {
                let _ = m.stop.send(true);
            }
        }
        self.end_conns(|_| true, "the browser restarted");
        self.with_reg(|r| {
            r.reset();
            r.headed = headed;
        });
    }

    /// `browser.configSet` `shareTabs`: agents see and drive the user's tabs from now on, or (off)
    /// lose them (their sessions there end).
    pub(crate) fn set_share(&self, on: bool) {
        self.with_reg(|r| {
            if r.share != on {
                r.share = on;
                r.changed = true;
            }
        });
    }

    /// The browser stopped: every agent connection ends; attachments stay.
    pub(crate) fn close_all(&self) {
        {
            let mut up = self.up.lock().unwrap();
            up.ws_url = None;
            if let Some(m) = up.monitor.take() {
                let _ = m.stop.send(true);
            }
        }
        self.end_conns(|_| true, "the browser stopped");
        self.with_reg(Registry::reset);
    }

    /// `who` may connect (`serve`); a re-attached agent gets its tabs back. Call it before telling
    /// the agent's host.
    pub(crate) fn attach(&self, who: &AttachKey) {
        self.with_reg(|r| r.attach(who));
        self.ensure_monitor();
    }

    /// `who`'s attachment ended: its connections close; the tabs it opened stay open (detached),
    /// the tabs lent to it go back to the user.
    pub(crate) fn detach(&self, who: &AttachKey) {
        self.with_reg(|r| r.detach(who));
        self.end_conns(|w| w == who, "detached from the browser");
    }

    /// Serves one connection of agent `who` (as tf-hostd streams it) until it closes: plain HTTP
    /// (`/json/*`) or a WebSocket upgrade. Refused unless `who` is attached.
    pub(crate) async fn serve<IO>(self: &Arc<Self>, io: IO, who: AttachKey)
    where
        IO: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let conn = self.next_conn.fetch_add(1, Ordering::Relaxed) + 1;
        let (stop, stopped) = watch::channel(None);
        self.conns.lock().unwrap().insert(conn, Conn { who: who.clone(), stop });
        self.ensure_monitor();
        http::serve(self.clone(), io, who, conn, stopped).await;
        self.conns.lock().unwrap().remove(&conn);
        self.with_reg(|r| r.conn_gone(conn));
    }

    /// Agents' tabs (`agent_name` empty: the caller knows the names).
    pub(crate) fn tabs(&self) -> Vec<BrowserTabOwner> {
        self.reg.lock().unwrap().tabs()
    }

    /// The pages of the tabs the user locked (`BrowserStatus::locked_tabs`), sorted.
    pub(crate) fn locked_tabs(&self) -> Vec<String> {
        self.reg.lock().unwrap().locked_tabs()
    }

    /// `browser.takeOver`: the agent cannot see or drive the tab until `hand_back` (a lent tab
    /// is the user's again for good).
    pub(crate) fn take_over(&self, target_id: &str) -> Result<(), ApiError> {
        self.with_reg(|r| r.take_over(target_id))
    }

    /// `browser.handBack`: the agent drives its tab again.
    pub(crate) fn hand_back(&self, target_id: &str) -> Result<(), ApiError> {
        self.with_reg(|r| r.hand_back(target_id))
    }

    /// `browser.lendTab`: the user's tab becomes `who`'s to see and drive.
    pub(crate) fn lend_tab(&self, target_id: &str, who: &AttachKey) -> Result<(), ApiError> {
        self.ensure_monitor();
        self.with_reg(|r| r.lend(target_id, who))
    }

    /// `browser.lockTab`: a tab no agent opened stays on its page for agents (`locked`), or no
    /// longer.
    pub(crate) fn lock_tab(&self, target_id: &str, locked: bool) -> Result<(), ApiError> {
        self.ensure_monitor();
        self.with_reg(|r| r.lock(target_id, locked))
    }

    /// Bumped whenever `tabs()`, `locked_tabs()` or an `active_at` changed (activity at most every
    /// ~2 s).
    pub(crate) fn changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    /// When `who` last sent the browser a command (at most every ~2 s).
    pub(crate) fn active_at(&self, who: &AttachKey) -> Option<Millis> {
        self.reg.lock().unwrap().active_at(who)
    }

    // ───────────────────────────── inside ─────────────────────────────

    /// Runs `f` on the registry, then tells whoever waits for its changes.
    fn with_reg<R>(&self, f: impl FnOnce(&mut Registry) -> R) -> R {
        let (r, shown, changed) = {
            let mut reg = self.reg.lock().unwrap();
            let r = f(&mut reg);
            (r, std::mem::take(&mut reg.shown_changed), std::mem::take(&mut reg.changed))
        };
        if changed {
            self.internal.send_modify(|n| *n += 1);
        }
        if shown {
            self.changes.send_modify(|n| *n += 1);
        }
        r
    }

    fn internal_changes(&self) -> watch::Receiver<u64> {
        self.internal.subscribe()
    }

    fn port(&self) -> u16 {
        self.up.lock().unwrap().port
    }

    fn end_conns(&self, which: impl Fn(&AttachKey) -> bool, reason: &str) {
        for c in self.conns.lock().unwrap().values().filter(|c| which(&c.who)) {
            let _ = c.stop.send(Some(reason.to_string()));
        }
    }

    /// Starts the monitor when it does not run (it needs a Tokio runtime).
    fn ensure_monitor(&self) -> Option<mpsc::UnboundedSender<monitor::Call>> {
        let mut up = self.up.lock().unwrap();
        if let Some(m) = &up.monitor
            && !m.calls.is_closed()
        {
            return Some(m.calls.clone());
        }
        let rt = tokio::runtime::Handle::try_current().ok()?;
        // Its reports start from nothing (targets may have gone while none ran).
        self.with_reg(Registry::resync);
        let (calls, rx) = mpsc::unbounded_channel();
        let (stop, stopped) = watch::channel(false);
        rt.spawn(monitor::run(self.me.clone(), up.port, rx, stopped));
        up.monitor = Some(Monitor { calls: calls.clone(), stop });
        Some(calls)
    }

    /// Waits (at most `limit`) until the monitor reported every target there is.
    async fn wait_synced(&self, limit: Duration) {
        let mut rx = self.internal.subscribe();
        let until = tokio::time::Instant::now() + limit;
        while !self.reg.lock().unwrap().synced {
            if tokio::time::timeout_at(until, rx.changed()).await.is_err() {
                log::warn!("browser proxy: the browser's targets are not all known yet");
                return;
            }
        }
    }

    /// One of the proxy's own commands to the browser (on the monitor's connection).
    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let calls = self.ensure_monitor().ok_or("no runtime")?;
        let (reply, answer) = oneshot::channel();
        calls
            .send(monitor::Call { method: method.to_string(), params, reply })
            .map_err(|_| "the browser connection closed".to_string())?;
        match tokio::time::timeout(CALL_TIMEOUT, answer).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err("the browser connection closed".into()),
            Err(_) => Err(format!("{method} timed out")),
        }
    }

    /// Opens a tab of `who`'s at `url`, its page target id: headless in a window of its own (a
    /// background tab of a headless window paints no frames), in its own window (headed) as a tab
    /// of the user's window, in the foreground (omp adopts the page it sees shown).
    async fn open_tab(&self, who: &AttachKey, url: &str) -> Result<String, String> {
        let headed = self.with_reg(|r| {
            r.creating(0);
            r.headed
        });
        let params = if headed { json!({ "url": url }) } else { json!({ "url": url, "newWindow": true }) };
        let r = self.call("Target.createTarget", params).await;
        let page = r.as_ref().ok().and_then(|v| v.get("targetId")).and_then(Value::as_str).map(String::from);
        self.with_reg(|reg| {
            reg.created(0);
            if let Some(p) = &page {
                reg.opened(who, p);
            }
        });
        match (r, page) {
            (Ok(_), Some(p)) => Ok(p),
            (Ok(_), None) => Err("the browser opened no tab".into()),
            (Err(e), _) => Err(e),
        }
    }

    /// An agent connecting with no tab of its own gets a blank one: omp drives a tab the browser
    /// already has (`browser.cdpUrl`) and fails when it sees none.
    async fn first_tab(&self, who: &AttachKey) {
        let _one = self.first_tab.lock().await;
        if !self.with_reg(|r| r.has_live_tab(who))
            && let Err(e) = self.open_tab(who, "about:blank").await
        {
            log::warn!("browser proxy: no first tab for {}/{}: {e}", who.host_id, who.agent_id);
        }
    }

    /// Closes the tabs agents opened (not the ones lent to them, nor the ones the user took
    /// over: those are the user's to keep) before a clean stop or relaunch, so the session the
    /// browser restores is the user's alone and no blank first tabs pile up. A crash, or the
    /// user closing the browser's window, cannot be covered: the agents' tabs open then come
    /// back as the user's.
    pub(crate) async fn close_agents_tabs(&self) {
        let pages = self.reg.lock().unwrap().agents_tabs();
        let closing = pages.iter().map(|p| self.call("Target.closeTarget", json!({ "targetId": p })));
        for (p, r) in pages.iter().zip(futures_util::future::join_all(closing).await) {
            if let Err(e) = r {
                log::info!("browser proxy: agent tab {p} did not close before the stop: {e}");
            }
        }
    }

    /// The browser target's WebSocket URL.
    async fn browser_ws_url(&self) -> Result<String, String> {
        let (port, known) = {
            let up = self.up.lock().unwrap();
            (up.port, up.ws_url.clone())
        };
        if let Some(u) = known {
            return Ok(u);
        }
        let u = http::browser_ws_url(port).await?;
        let mut up = self.up.lock().unwrap();
        if up.port == port {
            up.ws_url = Some(u.clone());
        }
        Ok(u)
    }

    /// `/json/list` as `who` sees it (its own pages first, then the user's it may use), URLs
    /// pointing at `host`.
    async fn list(&self, who: &AttachKey, host: &str) -> Result<Vec<Value>, String> {
        let port = self.port();
        let (code, body) = http::get(port, "/json/list").await?;
        if code != 200 {
            return Err(format!("/json/list answered {code}"));
        }
        let entries: Vec<Value> = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        let reg = self.reg.lock().unwrap();
        Ok(http::list_for(entries, port, host, |id| reg.id_vis(who, id).rank()))
    }
}
