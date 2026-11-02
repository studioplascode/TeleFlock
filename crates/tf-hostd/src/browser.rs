//! The TeleFlock Browser, this host's side (architecture §3.33; wire `tf_proto::browser`).
//!
//! An app with the TeleFlock Browser (wire feature `browser`) lends it to an agent of this herdr
//! session: `agent.browserAttach` listens on `127.0.0.1:<port>` (Linux: this user's processes only),
//! points the agent's omp at it (the bridge's runtime override of omp's `browser.cdpUrl`, never
//! written to a config file), and streams every connection to that port to the app as a forwarding
//! stream of kind `browser` (`crate::forward`: flow control, caps), which the app's DevTools proxy
//! serves. One attachment per agent. It ends on `agent.browserDetach` (from any app), when the app
//! that made it disconnects, when the bridge drops the override itself (a turn-scoped one at the
//! end of the turn), or when the agent's omp session ends; the app that made it is told
//! (`browserDetached`) unless it asked for it.
//!
//! The bridge tool `use_user_browser` asks the user: the request sits on the agent's bridge session
//! ([`crate::bridge::BridgeSession::browser_request`]) and on its card (`Agent.browser`, a
//! needs-you question). With no app that has the browser connected to this session the tool is
//! told at once that none is available. An attach answers it as allowed; `agent.browserAnswer`
//! and `agent.answer` (any app, choice `deny`) deny it.

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tf_proto::host::ServerMsg;
use tf_proto::model::ActivityKind;
use tf_proto::{Answer, ApiError, BrowserAnswerHostParams, BrowserAttachParams, BrowserAttached, BrowserLent, BrowserScope, Millis};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::bridge::{BridgeEvent, BridgeHandle, BrowserVerdict};
use crate::clients::ClientHandle;
use crate::forward::Forwarder;
use crate::state::StateHandle;
use crate::util::now_ms;

/// `NeedsYou.options` ids of a browser request (`crate::state::build::browser_needs`).
pub const CHOICE_SESSION: &str = "session";
pub const CHOICE_TURN: &str = "turn";
pub const CHOICE_DENY: &str = "deny";

/// The agents of one herdr session attached to an app's browser. Cheap to clone.
#[derive(Clone)]
pub struct Browsers {
    inner: Arc<Inner>,
}

struct Inner {
    forward: Forwarder,
    bridge: BridgeHandle,
    state: StateHandle,
    cancel: CancellationToken,
    /// agent id → its attachment.
    attached: Mutex<HashMap<String, Attachment>>,
}

struct Attachment {
    /// The app that lent its browser.
    client: ClientHandle,
    port: u16,
    scope: BrowserScope,
    since: Millis,
    /// The omp session whose bridge holds the override.
    session_id: String,
    listener: tokio::task::JoinHandle<()>,
}

impl Drop for Attachment {
    fn drop(&mut self) {
        self.listener.abort();
    }
}

fn cdp_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// What the agent hears when the user says no.
fn denied() -> BrowserVerdict {
    BrowserVerdict { allow: false, scope: None, cdp_url: None, unavailable: false, message: None }
}

fn unavailable() -> BrowserVerdict {
    BrowserVerdict {
        allow: false,
        scope: None,
        cdp_url: None,
        unavailable: true,
        message: Some("No TeleFlock app with a browser is connected to this host right now.".into()),
    }
}

/// `127.0.0.1:<port>`, else a free port (absent, 0 or taken).
fn bind(port: Option<u16>) -> Result<tokio::net::TcpListener, ApiError> {
    let listen = |p: u16| {
        std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, p))
            .and_then(|l| l.set_nonblocking(true).map(|()| l))
            .and_then(tokio::net::TcpListener::from_std)
    };
    if let Some(p) = port.filter(|p| *p != 0) {
        match listen(p) {
            Ok(l) => return Ok(l),
            Err(e) => debug!(port = p, "browser port: {e}; taking a free one"),
        }
    }
    listen(0).map_err(|e| ApiError::new("io_error", format!("cannot listen on 127.0.0.1: {e}")))
}

fn scope_words(scope: BrowserScope) -> &'static str {
    match scope {
        BrowserScope::Session => "for this session",
        BrowserScope::Turn => "for this turn",
    }
}

impl Browsers {
    pub fn new(forward: Forwarder, bridge: BridgeHandle, state: StateHandle, cancel: CancellationToken) -> Browsers {
        Browsers { inner: Arc::new(Inner { forward, bridge, state, cancel, attached: Mutex::default() }) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Attachment>> {
        self.inner.attached.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Ends a taken attachment: the agent's connections close, the listener stops, its card
    /// forgets it, and the app that made it hears `reason` (when given).
    fn end(&self, agent_id: &str, a: Attachment, why: &str, reason: Option<String>) {
        info!(agent = %agent_id, port = a.port, client = %a.client.id(), "browser attachment ended: {why}");
        self.inner.forward.close_browser(&a.client, agent_id, why);
        if let Some(reason) = reason {
            a.client.send(ServerMsg::BrowserDetached { agent_id: agent_id.to_string(), reason });
        }
        drop(a);
        if !self.lock().contains_key(agent_id) {
            self.inner.state.set_browser_lent(agent_id, None);
        }
    }

    /// `agent.browserAttach` from `client`.
    pub async fn attach(&self, client: &ClientHandle, p: BrowserAttachParams) -> Result<BrowserAttached, ApiError> {
        if !client.features().browser {
            return Err(ApiError::new("unsupported", "this TeleFlock app has no browser to lend").with_hint("Update TeleFlock on this device"));
        }
        let state = &self.inner.state;
        let agent = state.agent(&p.agent_id).ok_or_else(|| ApiError::new("not_found", format!("unknown agent `{}`", p.agent_id)))?;
        if agent.parked.is_some() {
            return Err(ApiError::new("invalid_params", format!("{} is not running", agent.name)));
        }
        let sid = crate::ops::agent::bridge_session(state, &self.inner.bridge, &p.agent_id).ok_or_else(|| {
            ApiError::new("not_connected", format!("{}'s omp has no TeleFlock bridge", agent.name)).with_hint("Start the agent from TeleFlock")
        })?;
        let session = self.inner.bridge.by_session(&sid).ok_or_else(|| ApiError::new("not_connected", "the agent's TeleFlock bridge went away").retryable())?;
        if !session.caps.browser {
            return Err(ApiError::new("unsupported", format!("{} runs a TeleFlock bridge older than 2.3.0, without the browser", agent.name))
                .with_hint("Restart the agent to update its bridge"));
        }
        let scope = p.scope.unwrap_or(BrowserScope::Session);
        // The same app attaching again on the same port keeps its listener (and the agent's URL).
        let reuse = self.lock().get(&p.agent_id).filter(|a| a.client.id() == client.id() && p.port.is_none_or(|q| q == 0 || q == a.port)).map(|a| a.port);
        let fresh = match reuse {
            Some(_) => None,
            None => {
                let l = bind(p.port)?;
                let port = l.local_addr().map_err(|e| ApiError::new("io_error", e.to_string()))?.port();
                let (fwd, c, agent_id, cancel) = (self.inner.forward.clone(), client.clone(), p.agent_id.clone(), self.inner.cancel.clone());
                Some((port, tokio::spawn(accept_loop(fwd, c, agent_id, port, l, cancel))))
            }
        };
        let port = reuse.or(fresh.as_ref().map(|(p, _)| *p)).expect("one of them");
        let url = cdp_url(port);
        if let Err(e) = self.inner.bridge.browser_override(&sid, Some(&url), Some(scope)).await {
            if let Some((_, task)) = fresh {
                task.abort();
            }
            return Err(e.into());
        }
        let now = now_ms();
        enum Registered {
            /// A new listener, and the attachment it replaced.
            Fresh(Option<Attachment>),
            /// The same listener, attached since then.
            Kept(Millis),
            /// It ended while the bridge answered.
            Gone,
        }
        let registered = {
            let mut st = self.lock();
            match fresh {
                Some((port, listener)) => {
                    let a = Attachment { client: client.clone(), port, scope, since: now, session_id: sid.clone(), listener };
                    Registered::Fresh(st.insert(p.agent_id.clone(), a))
                }
                None => match st.get_mut(&p.agent_id) {
                    Some(a) => {
                        a.scope = scope;
                        a.session_id = sid.clone();
                        Registered::Kept(a.since)
                    }
                    None => Registered::Gone,
                },
            }
        };
        let (previous, since) = match registered {
            Registered::Fresh(previous) => (previous, now),
            Registered::Kept(since) => (None, since),
            Registered::Gone => return Box::pin(self.attach(client, BrowserAttachParams { port: Some(port), ..p })).await,
        };
        if let Some(prev) = previous {
            let reason = (prev.client.id() != client.id()).then(|| format!("TeleFlock on {} took it over", client.info().device));
            self.end(&p.agent_id, prev, "attached again", reason);
        }
        info!(agent = %p.agent_id, port, ?scope, client = %client.id(), "browser attached");
        self.inner.state.set_browser_lent(&p.agent_id, Some(BrowserLent { device: client.info().device.clone(), since, scope }));
        // A pending request is answered by this attach: the agent may go on.
        if let Some(req) = self.inner.bridge.by_session(&sid).and_then(|s| s.browser_request) {
            let verdict = BrowserVerdict { allow: true, scope: Some(scope), cdp_url: Some(url.clone()), unavailable: false, message: None };
            match self.inner.bridge.browser_answer(&sid, &req.id, &verdict).await {
                Ok(()) => state.record_activity(&p.agent_id, ActivityKind::Approved, format!("Browser allowed {}", scope_words(scope)), Some(req.reason)),
                Err(e) => warn!(agent = %p.agent_id, "answering the browser request: {e}"),
            }
        }
        Ok(BrowserAttached { port, cdp_url: url })
    }

    /// `agent.browserDetach` (from any app).
    pub async fn detach(&self, client: &ClientHandle, agent_id: &str) -> Result<(), ApiError> {
        let Some(a) = self.lock().remove(agent_id) else { return Ok(()) };
        if let Err(e) = self.inner.bridge.browser_override(&a.session_id, None, None).await {
            debug!(agent = %agent_id, "dropping the browser override: {e}");
        }
        let reason = (a.client.id() != client.id()).then(|| format!("detached in TeleFlock on {}", client.info().device));
        self.end(agent_id, a, "detached", reason);
        self.inner.state.record_activity(agent_id, ActivityKind::Stopped, "Browser detached".into(), None);
        Ok(())
    }

    /// The agent and omp session whose pending request is `request_id`.
    fn request_of(&self, request_id: &str) -> Option<(String, String, String)> {
        let state = &self.inner.state;
        state.snapshot().agents.iter().find_map(|a| {
            let req = a.browser.as_ref()?.request.as_ref().filter(|r| r.id == request_id)?;
            let sid = crate::ops::agent::bridge_session(state, &self.inner.bridge, &a.id)?;
            Some((a.id.clone(), sid, req.reason.clone()))
        })
    }

    /// `agent.browserAnswer`: a deny, or (`allow`) the attachment this app already made.
    pub async fn answer(&self, client: &ClientHandle, p: BrowserAnswerHostParams) -> Result<(), ApiError> {
        let (agent_id, sid, reason) =
            self.request_of(&p.request_id).ok_or_else(|| ApiError::new("not_found", format!("no pending browser request {}", p.request_id)))?;
        let verdict = if p.allow {
            let st = self.lock();
            let a = st.get(&agent_id).filter(|a| a.client.id() == client.id()).ok_or_else(|| {
                ApiError::new("invalid_params", "this app has not lent the agent its browser").with_hint("Attach it (agent.browserAttach) to allow the request")
            })?;
            BrowserVerdict { allow: true, scope: Some(a.scope), cdp_url: Some(cdp_url(a.port)), unavailable: false, message: None }
        } else {
            denied()
        };
        self.inner.bridge.browser_answer(&sid, &p.request_id, &verdict).await?;
        let (kind, title) = if p.allow { (ActivityKind::Approved, "Browser allowed") } else { (ActivityKind::Denied, "Browser denied") };
        self.inner.state.record_activity(&agent_id, kind, title.into(), Some(reason));
        Ok(())
    }

    /// `agent.answer` of a browser request: only a deny (choice `deny`, or a dismissal) works here;
    /// allowing takes an app with the browser, which attaches.
    pub async fn answer_choice(&self, agent_id: &str, sid: &str, request_id: &str, reason: &str, answer: &Answer) -> Result<(), ApiError> {
        if !(answer.cancel || answer.choices.iter().any(|c| c == CHOICE_DENY)) {
            return Err(ApiError::new("unsupported", "Allow it in TeleFlock on the computer whose browser the agent should use")
                .with_hint("This device has no TeleFlock Browser"));
        }
        self.inner.bridge.browser_answer(sid, request_id, &denied()).await?;
        self.inner.state.record_activity(agent_id, ActivityKind::Denied, "Browser denied".into(), Some(reason.to_string()));
        Ok(())
    }

    /// The app `client_id` disconnected: its attachments end (the bridge drops the overrides).
    pub fn client_gone(&self, client_id: &str) {
        let gone: Vec<(String, Attachment)> = {
            let mut st = self.lock();
            let ids: Vec<String> = st.iter().filter(|(_, a)| a.client.id() == client_id).map(|(k, _)| k.clone()).collect();
            ids.into_iter().filter_map(|id| st.remove(&id).map(|a| (id, a))).collect()
        };
        for (agent_id, a) in gone {
            let (bridge, sid) = (self.inner.bridge.clone(), a.session_id.clone());
            tokio::spawn(async move {
                if let Err(e) = bridge.browser_override(&sid, None, None).await {
                    debug!(session = %sid, "dropping the browser override: {e}");
                }
            });
            self.end(&agent_id, a, "the app disconnected", None);
        }
    }

    /// Bridge events of this session's agents (`crate::state`'s bridge consumer).
    pub fn on_bridge_event(&self, ev: &BridgeEvent) {
        match ev {
            BridgeEvent::BrowserRequest { session_id, request } => {
                if self.inner.state.agent_of_session(session_id).is_none() {
                    return;
                }
                // Nobody here could answer it: the agent hears so at once.
                if !self.inner.state.has_browser_client() {
                    info!(session = %session_id, "browser request: no app with a browser is connected");
                    let (bridge, sid, id) = (self.inner.bridge.clone(), session_id.clone(), request.id.clone());
                    tokio::spawn(async move {
                        if let Err(e) = bridge.browser_answer(&sid, &id, &unavailable()).await {
                            warn!(session = %sid, "answering the browser request: {e}");
                        }
                    });
                }
            }
            BridgeEvent::BrowserReleased { session_id, reason } => {
                let why = match reason.as_str() {
                    "turnEnded" => "the agent's turn ended (allowed once)".to_string(),
                    other => other.to_string(),
                };
                self.end_session(session_id, &why);
            }
            BridgeEvent::Disconnected { session_id, .. } => self.end_session(session_id, "the agent's omp session ended"),
            BridgeEvent::SessionSwitch { previous_session_id, session, .. } => {
                // The override lives in the omp process, which goes on with the new session.
                for a in self.lock().values_mut().filter(|a| a.session_id == *previous_session_id) {
                    a.session_id = session.session_id.clone();
                }
            }
            _ => {}
        }
    }

    /// Ends the attachments whose override lived in omp session `session_id`.
    fn end_session(&self, session_id: &str, why: &str) {
        let gone: Vec<(String, Attachment)> = {
            let mut st = self.lock();
            let ids: Vec<String> = st.iter().filter(|(_, a)| a.session_id == session_id).map(|(k, _)| k.clone()).collect();
            ids.into_iter().filter_map(|id| st.remove(&id).map(|a| (id, a))).collect()
        };
        for (agent_id, a) in gone {
            self.end(&agent_id, a, why, Some(why.to_string()));
        }
    }

    /// The port an agent's browser listens on (tests, logs).
    pub fn port_of(&self, agent_id: &str) -> Option<u16> {
        self.lock().get(agent_id).map(|a| a.port)
    }
}

async fn accept_loop(forward: Forwarder, client: ClientHandle, agent_id: String, port: u16, l: tokio::net::TcpListener, cancel: CancellationToken) {
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return,
            accepted = l.accept() => match accepted {
                Ok((tcp, _)) => forward.open_browser(&client, &agent_id, port, tcp),
                Err(e) => {
                    debug!(port, "browser port accept: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            },
        }
    }
}

/// The host's side of the TeleFlock Browser in-process: a scripted bridge (`bridge::fake`), the
/// board, the forwarding machinery and apps as client handles. The proxy that serves the streams
/// is the app's (`tf-client`); the whole chain runs in `scripts/lab/browser`.
#[cfg(all(test, unix))]
mod tests {
    use serde_json::{Value, json};
    use tf_herdr::{AgentInfo, AgentSession, AgentSessionKind, Snapshot};
    use tf_proto::model::{NeedsKind, OptionTone};
    use tf_proto::{ClientInfo, ForwardKind, FwdEv};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::broadcast;

    use super::*;
    use crate::bridge::fake::{FakeExt, handle};
    use crate::clients::Features;

    const AGENT: &str = "term_1";
    const SID: &str = "s1";

    fn app(name: &str, browser: bool) -> ClientHandle {
        let info = ClientInfo { app: "test".into(), version: "0".into(), platform: "linux".into(), device: format!("{name}-device"), features: None };
        ClientHandle::with_features(name.into(), info, Features { browser, ..Features::default() })
    }

    /// What arrived at `c` until `f` holds for it (everything since the last call is kept).
    async fn until(c: &ClientHandle, got: &mut Vec<ServerMsg>, what: &str, f: impl Fn(&[ServerMsg]) -> bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let mut batch = Vec::new();
            c.take_batch(&mut batch);
            got.extend(batch.iter().map(|l| serde_json::from_str::<ServerMsg>(l).unwrap()));
            if f(got) {
                return;
            }
            assert!(tokio::time::Instant::now() < deadline, "timed out waiting for {what}: {got:?}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn detached(got: &[ServerMsg]) -> Vec<String> {
        got.iter().filter_map(|m| match m { ServerMsg::BrowserDetached { agent_id, reason } if agent_id == AGENT => Some(reason.clone()), _ => None }).collect()
    }

    fn opened(got: &[ServerMsg]) -> Vec<u64> {
        got.iter()
            .filter_map(|m| match m { ServerMsg::Fwd { sid, ev: FwdEv::Open { kind: ForwardKind::Browser, name, .. } } if name == AGENT => Some(*sid), _ => None })
            .collect()
    }

    async fn port_closed(port: u16) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            assert!(std::time::Instant::now() < deadline, "port {port} still listens");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// One omp agent on the board whose bridge (2.3.0, `caps.browser`) is a scripted extension.
    struct Lab {
        browsers: Browsers,
        state: StateHandle,
        events: broadcast::Receiver<BridgeEvent>,
        ext: FakeExt,
        _dirs: (tempfile::TempDir, std::path::PathBuf),
    }

    impl Lab {
        async fn new() -> Lab {
            Lab::with_bridge("2.3.0", json!({ "live": 1, "browser": true })).await
        }

        /// The agent's bridge is `version`, announcing `caps`.
        async fn with_bridge(version: &str, caps: Value) -> Lab {
            let (bridge, bridge_dir) = handle();
            let td = tempfile::tempdir().unwrap();
            let persist = crate::state::persist::Persist::load(td.path().join("state.json"));
            let stopped = CancellationToken::new();
            stopped.cancel();
            let omp = crate::omp::OmpHandle::start(0, persist.clone(), stopped, bridge.clone()).await;
            let state = StateHandle::new("lab", persist, omp, bridge.clone());
            let forward = Forwarder::start(&crate::paths::Paths::new(td.path().join("tf"), true), CancellationToken::new());
            let browsers = Browsers::new(forward, bridge.clone(), state.clone(), CancellationToken::new());
            let events = bridge.subscribe();
            let mut ext = FakeExt::connect(&bridge).await;
            ext.hello_caps(4242, SID, version, Some(caps)).await;
            let session = AgentSession { kind: AgentSessionKind::Id, value: SID.into(), ..Default::default() };
            let agent = AgentInfo { pane_id: "w1:p1".into(), terminal_id: AGENT.into(), workspace_id: "w1".into(), tab_id: "w1:t1".into(), agent: Some("omp".into()), agent_session: Some(session), ..Default::default() };
            state.rebuild_with(Some(Snapshot { agents: vec![agent], ..Default::default() }));
            Lab { browsers, state, events, ext, _dirs: (td, bridge_dir) }
        }

        /// The next bridge event, handed to the browser service as the state store's consumer does.
        async fn event(&mut self, f: impl Fn(&BridgeEvent) -> bool) -> BridgeEvent {
            loop {
                let ev = tokio::time::timeout(Duration::from_secs(5), self.events.recv()).await.expect("a bridge event").unwrap();
                self.browsers.on_bridge_event(&ev);
                self.state.rebuild_with(None);
                if f(&ev) {
                    return ev;
                }
            }
        }

        /// The extension's next requests, answered `{}`: their ops must be `ops`.
        async fn serve(&mut self, ops: &[&str]) -> Vec<Value> {
            let mut reqs = Vec::new();
            for op in ops {
                let req = self.ext.recv_req().await;
                assert_eq!(req["op"], *op, "{req}");
                self.ext.ok(&req, json!({})).await;
                reqs.push(req);
            }
            reqs
        }

        fn spawn_attach(&self, client: &ClientHandle, port: Option<u16>, scope: Option<BrowserScope>) -> tokio::task::JoinHandle<Result<BrowserAttached, ApiError>> {
            let (b, c) = (self.browsers.clone(), client.clone());
            tokio::spawn(async move { b.attach(&c, BrowserAttachParams { agent_id: AGENT.into(), port, scope }).await })
        }

        /// `agent.browserAttach` the extension's override answers; returns the attachment and the
        /// override's params.
        async fn attach(&mut self, client: &ClientHandle, port: Option<u16>, scope: Option<BrowserScope>) -> (BrowserAttached, Value) {
            let call = self.spawn_attach(client, port, scope);
            let req = self.serve(&["browserOverride"]).await.remove(0);
            (call.await.unwrap().unwrap(), req["params"].clone())
        }

        /// `agent.browserAnswer` (a deny) from `client`; the params of the bridge's `browserAnswer`.
        async fn deny(&mut self, client: &ClientHandle, request_id: &str) -> Value {
            let (b, c, id) = (self.browsers.clone(), client.clone(), request_id.to_string());
            let call = tokio::spawn(async move { b.answer(&c, BrowserAnswerHostParams { request_id: id, allow: false }).await });
            let req = self.serve(&["browserAnswer"]).await.remove(0);
            call.await.unwrap().unwrap();
            req["params"].clone()
        }

        async fn request(&mut self, id: &str, reason: &str) {
            self.ext.send(json!({ "t": "event", "event": "browser_request", "sessionId": SID, "data": { "id": id, "reason": reason, "at": 1_000 } })).await;
            self.event(|e| matches!(e, BridgeEvent::BrowserRequest { request, .. } if request.id == id)).await;
        }

        async fn request_end(&mut self, id: &str) {
            self.ext.send(json!({ "t": "event", "event": "browser_request_end", "sessionId": SID, "data": { "id": id } })).await;
            self.event(|e| matches!(e, BridgeEvent::BrowserRequestEnd { .. })).await;
        }

        fn card(&self) -> tf_proto::model::Agent {
            self.state.agent(AGENT).expect("the agent on the board")
        }

        fn activity(&self) -> Vec<(ActivityKind, String)> {
            self.state.activity_page(None, 50, Some(AGENT)).0.into_iter().map(|e| (e.kind, e.title)).rev().collect()
        }
    }

    /// `agent.browserAttach` listens on loopback and streams each connection to the app that lent
    /// its browser; attaching again keeps the listener for that app and moves it for another;
    /// `agent.browserDetach` from any app ends it.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_listener_streams_to_the_lending_app_until_detached() {
        let mut lab = Lab::new().await;
        let (a, b) = (app("a", true), app("b", true));
        let (mut got_a, mut got_b) = (Vec::new(), Vec::new());

        // Refused: an app without the browser, an agent not on the board.
        let err = lab.browsers.attach(&app("phone", false), BrowserAttachParams { agent_id: AGENT.into(), port: None, scope: None }).await.unwrap_err();
        assert_eq!(err.code, "unsupported");
        let err = lab.browsers.attach(&a, BrowserAttachParams { agent_id: "nobody".into(), port: None, scope: None }).await.unwrap_err();
        assert_eq!(err.code, "not_found");

        // A port that is taken gives a free one.
        let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let (att, params) = lab.attach(&a, Some(taken.local_addr().unwrap().port()), None).await;
        assert_ne!(att.port, taken.local_addr().unwrap().port());
        assert_eq!(att.cdp_url, format!("http://127.0.0.1:{}", att.port));
        assert_eq!(params, json!({ "cdpUrl": att.cdp_url, "scope": "session" }));
        lab.state.rebuild_with(None);
        let lent = lab.card().browser.and_then(|b| b.attached).expect("the card says whose browser");
        assert_eq!((lent.device.as_str(), lent.scope), ("a-device", BrowserScope::Session));

        // A connection is a `browser` stream to the app; bytes flow once the app opened it.
        let mut tcp = tokio::net::TcpStream::connect(("127.0.0.1", att.port)).await.unwrap();
        until(&a, &mut got_a, "the stream", |g| !opened(g).is_empty()).await;
        let sid = opened(&got_a)[0];
        assert!(got_a.iter().any(|m| matches!(m, ServerMsg::Fwd { ev: FwdEv::Open { port: Some(p), .. }, .. } if *p == att.port)));
        let forward = lab.browsers.inner.forward.clone();
        forward.fwd(&a, sid, FwdEv::Opened { pty: false });
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD;
        forward.fwd(&a, sid, FwdEv::Data { data: b64.encode(b"HTTP/1.1 200 OK\r\n\r\n"), fd: 1 });
        let mut buf = [0u8; 19];
        tcp.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"HTTP/1.1 200 OK\r\n\r\n");
        tcp.write_all(b"GET /json/version").await.unwrap();
        let sent = |g: &[ServerMsg]| -> Vec<u8> {
            g.iter().filter_map(|m| match m { ServerMsg::Fwd { sid: s, ev: FwdEv::Data { data, .. } } if *s == sid => Some(b64.decode(data).unwrap()), _ => None }).flatten().collect()
        };
        until(&a, &mut got_a, "the request", |g| sent(g) == b"GET /json/version").await;

        // The same app again: the same listener and URL.
        let (again, _) = lab.attach(&a, None, None).await;
        assert_eq!(again.port, att.port);
        assert!(detached(&got_a).is_empty());

        // Another app takes it over: a new listener; the first app hears why and loses its streams.
        let (moved, params) = lab.attach(&b, None, Some(BrowserScope::Turn)).await;
        assert_ne!(moved.port, att.port);
        assert_eq!(params["scope"], "turn");
        until(&a, &mut got_a, "the takeover", |g| !detached(g).is_empty()).await;
        assert_eq!(detached(&got_a), vec!["TeleFlock on b-device took it over".to_string()]);
        assert!(got_a.iter().any(|m| matches!(m, ServerMsg::Fwd { sid: s, ev: FwdEv::Close { error: Some(_) } } if *s == sid)));
        assert!(matches!(tcp.read(&mut buf).await, Ok(0) | Err(_)), "the agent's connection closed");
        port_closed(att.port).await;

        // Detached from the other app: the bridge drops the override, the lender hears who.
        let (bb, c) = (lab.browsers.clone(), a.clone());
        let call = tokio::spawn(async move { bb.detach(&c, AGENT).await });
        let req = lab.serve(&["browserOverride"]).await.remove(0);
        assert_eq!(req["params"], json!({ "cdpUrl": null, "scope": null }));
        call.await.unwrap().unwrap();
        until(&b, &mut got_b, "the detach", |g| !detached(g).is_empty()).await;
        assert_eq!(detached(&got_b), vec!["detached in TeleFlock on a-device".to_string()]);
        port_closed(moved.port).await;
        assert_eq!(lab.browsers.port_of(AGENT), None);
        lab.state.rebuild_with(None);
        assert!(lab.card().browser.is_none());
        assert!(lab.activity().contains(&(ActivityKind::Stopped, "Browser detached".to_string())));
        // Detaching again is a no-op.
        lab.browsers.detach(&a, AGENT).await.unwrap();
    }

    /// Linux: the port is this user's. Another user's process connecting gets closed at once and
    /// never reaches the app (needs root to make one).
    #[cfg(target_os = "linux")]
    #[tokio::test(flavor = "multi_thread")]
    async fn only_this_users_processes_reach_the_browser() {
        let mut lab = Lab::new().await;
        let a = app("a", true);
        let mut got = Vec::new();
        let (att, _) = lab.attach(&a, None, None).await;
        // SAFETY: geteuid cannot fail.
        if unsafe { libc::geteuid() } == 0 {
            let port = att.port;
            let closed_at_once = tokio::task::spawn_blocking(move || connect_as(65534, port)).await.unwrap();
            assert!(closed_at_once, "another user's connection was not closed");
            let mut batch = Vec::new();
            a.take_batch(&mut batch);
            got.extend(batch.iter().map(|l| serde_json::from_str::<ServerMsg>(l).unwrap()));
            assert!(opened(&got).is_empty(), "another user's connection reached the app: {got:?}");
        } else {
            eprintln!("not root: only this user's connection is checked");
        }
        let _mine = tokio::net::TcpStream::connect(("127.0.0.1", att.port)).await.unwrap();
        until(&a, &mut got, "this user's stream", |g| opened(g).len() == 1).await;
    }

    /// A child process of `uid` connects to `port` on loopback: whether the server closed the
    /// connection without a byte (within 5 s). Only async-signal-safe calls after the fork.
    #[cfg(target_os = "linux")]
    fn connect_as(uid: u32, port: u16) -> bool {
        // SAFETY: the child only makes raw system calls and leaves with `_exit`.
        unsafe {
            let pid = libc::fork();
            assert!(pid >= 0, "fork");
            if pid == 0 {
                if libc::setgid(uid) != 0 || libc::setuid(uid) != 0 {
                    libc::_exit(2);
                }
                let fd = libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0);
                let wait = libc::timeval { tv_sec: 5, tv_usec: 0 };
                libc::setsockopt(fd, libc::SOL_SOCKET, libc::SO_RCVTIMEO, (&raw const wait).cast(), size_of::<libc::timeval>() as libc::socklen_t);
                let addr = libc::sockaddr_in {
                    sin_family: libc::AF_INET as libc::sa_family_t,
                    sin_port: port.to_be(),
                    sin_addr: libc::in_addr { s_addr: u32::from_ne_bytes([127, 0, 0, 1]) },
                    sin_zero: [0; 8],
                };
                if libc::connect(fd, (&raw const addr).cast(), size_of::<libc::sockaddr_in>() as libc::socklen_t) != 0 {
                    libc::_exit(3);
                }
                let mut byte = 0u8;
                let n = libc::read(fd, (&raw mut byte).cast(), 1);
                libc::_exit(if n == 0 { 0 } else { 4 });
            }
            let mut status = 0;
            libc::waitpid(pid, &mut status, 0);
            libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0
        }
    }

    /// It ends when the app disconnects (the bridge drops the override), when the bridge drops a
    /// turn's override itself, and when the agent's omp session ends; a session switch keeps it.
    #[tokio::test(flavor = "multi_thread")]
    async fn it_ends_with_the_app_the_turn_or_the_omp_session() {
        let mut lab = Lab::new().await;
        let a = app("a", true);
        let mut got = Vec::new();

        let (att, _) = lab.attach(&a, None, None).await;
        lab.browsers.client_gone(a.id());
        let req = lab.serve(&["browserOverride"]).await.remove(0);
        assert_eq!(req["params"]["cdpUrl"], Value::Null);
        port_closed(att.port).await;
        lab.state.rebuild_with(None);
        assert!(lab.card().browser.is_none());

        // Allow once: the bridge ends it with the turn and says so; hostd asks it nothing more.
        let (att, params) = lab.attach(&a, None, Some(BrowserScope::Turn)).await;
        assert_eq!(params["scope"], "turn");
        lab.ext.send(json!({ "t": "event", "event": "browser_released", "sessionId": SID, "data": { "reason": "turnEnded" } })).await;
        lab.event(|e| matches!(e, BridgeEvent::BrowserReleased { .. })).await;
        until(&a, &mut got, "the turn's end", |g| !detached(g).is_empty()).await;
        assert_eq!(detached(&got), vec!["the agent's turn ended (allowed once)".to_string()]);
        port_closed(att.port).await;

        // omp moves to another session: the attachment follows; then omp's session ends.
        let (att, _) = lab.attach(&a, None, None).await;
        lab.ext.hello_caps(4242, "s2", "2.3.0", Some(json!({ "live": 1, "browser": true }))).await;
        lab.event(|e| matches!(e, BridgeEvent::SessionSwitch { .. })).await;
        assert_eq!(lab.browsers.port_of(AGENT), Some(att.port));
        assert!(tokio::net::TcpStream::connect(("127.0.0.1", att.port)).await.is_ok());
        // omp exits: the extension's connection closes.
        lab.ext.w.shutdown().await.unwrap();
        lab.event(|e| matches!(e, BridgeEvent::Disconnected { session_id, .. } if session_id == "s2")).await;
        until(&a, &mut got, "the session's end", |g| detached(g).len() == 2).await;
        assert_eq!(detached(&got)[1], "the agent's omp session ended");
        port_closed(att.port).await;
        assert_eq!(lab.browsers.port_of(AGENT), None);
    }

    /// `use_user_browser`: with no app that has the browser the agent hears so at once; else the
    /// request is the agent's needs-you card until an attach allows it or an app denies it.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_request_waits_for_an_attach_or_a_deny() {
        let mut lab = Lab::new().await;
        let (a, b) = (app("a", true), app("b", true));

        // No app with the browser is connected: unavailable at once.
        lab.request("r1", "to read my invoices").await;
        let req = lab.serve(&["browserAnswer"]).await.remove(0);
        assert_eq!(req["params"]["id"], "r1");
        assert_eq!((&req["params"]["allow"], &req["params"]["unavailable"]), (&json!(false), &json!(true)));
        assert!(req["params"]["message"].as_str().unwrap().contains("No TeleFlock app with a browser"));
        lab.request_end("r1").await;

        // An app with the browser is connected: the card asks.
        lab.state.attach_client(&a);
        lab.state.attach_client(&b);
        lab.request("r2", "to read my invoices").await;
        let card = lab.card();
        assert_eq!(card.browser.as_ref().and_then(|b| b.request.as_ref()).map(|r| r.id.as_str()), Some("r2"));
        let needs = card.needs.expect("a needs-you question");
        assert_eq!((needs.kind, needs.browser, needs.request_id.as_deref(), needs.question.as_str()), (NeedsKind::Confirm, true, Some("r2"), "to read my invoices"));
        let options: Vec<(&str, OptionTone)> = needs.options.iter().map(|o| (o.id.as_str(), o.tone)).collect();
        assert_eq!(options, vec![(CHOICE_SESSION, OptionTone::Primary), (CHOICE_TURN, OptionTone::Neutral), (CHOICE_DENY, OptionTone::Danger)]);

        // Allow once: the attach answers it with the turn scope and the agent's URL.
        let call = lab.spawn_attach(&a, None, Some(BrowserScope::Turn));
        let reqs = lab.serve(&["browserOverride", "browserAnswer"]).await;
        let att = call.await.unwrap().unwrap();
        assert_eq!(reqs[1]["params"], json!({ "id": "r2", "allow": true, "scope": "turn", "cdpUrl": att.cdp_url }));
        assert!(lab.activity().contains(&(ActivityKind::Approved, "Browser allowed for this turn".to_string())));
        lab.request_end("r2").await;

        // `agent.browserAnswer`: allowing takes this app's attachment; another app can deny.
        lab.request("r3", "one more page").await;
        let err = lab.browsers.answer(&b, BrowserAnswerHostParams { request_id: "r3".into(), allow: true }).await.unwrap_err();
        assert_eq!(err.code, "invalid_params");
        let (bb, c) = (lab.browsers.clone(), a.clone());
        let call = tokio::spawn(async move { bb.answer(&c, BrowserAnswerHostParams { request_id: "r3".into(), allow: true }).await });
        let req = lab.serve(&["browserAnswer"]).await.remove(0);
        call.await.unwrap().unwrap();
        assert_eq!(req["params"], json!({ "id": "r3", "allow": true, "scope": "turn", "cdpUrl": att.cdp_url }));
        lab.request_end("r3").await;

        // `agent.answer` (any app, the board or a notification): only a deny works there.
        lab.request("r4", "to change my DNS").await;
        let allow = Answer { choices: vec![CHOICE_SESSION.into()], text: None, cancel: false, chat: false, back: false };
        let err = lab.browsers.answer_choice(AGENT, SID, "r4", "to change my DNS", &allow).await.unwrap_err();
        assert_eq!(err.code, "unsupported");
        let deny = Answer { choices: vec![CHOICE_DENY.into()], ..allow };
        let (bb, reason) = (lab.browsers.clone(), "to change my DNS".to_string());
        let call = tokio::spawn(async move { bb.answer_choice(AGENT, SID, "r4", &reason, &deny).await });
        let req = lab.serve(&["browserAnswer"]).await.remove(0);
        call.await.unwrap().unwrap();
        assert_eq!(req["params"], json!({ "id": "r4", "allow": false }));
        assert!(lab.activity().contains(&(ActivityKind::Denied, "Browser denied".to_string())));
        lab.request_end("r4").await;
        assert!(lab.card().browser.and_then(|b| b.request).is_none());
        let err = lab.browsers.answer(&a, BrowserAnswerHostParams { request_id: "r4".into(), allow: false }).await.unwrap_err();
        assert_eq!(err.code, "not_found");
    }

    /// Anyone can say no; only the app that lent its browser can say yes. A request is denied by
    /// an app that never lent one, by an app other than the lender, by the lender and by a
    /// dismissal on the board; an allow from anyone but the lender has nothing to allow with.
    #[tokio::test(flavor = "multi_thread")]
    async fn any_app_can_deny_but_only_the_lending_app_can_allow() {
        let mut lab = Lab::new().await;
        let (a, b) = (app("a", true), app("b", true));
        lab.state.attach_client(&a);
        lab.state.attach_client(&b);
        let allow = |id: &str| BrowserAnswerHostParams { request_id: id.into(), allow: true };

        // Nobody lent the browser: an app's Deny works, its Allow does not, and nothing is lent.
        lab.request("r1", "to read my invoices").await;
        assert_eq!(lab.browsers.answer(&b, allow("r1")).await.unwrap_err().code, "invalid_params");
        assert_eq!(lab.deny(&b, "r1").await, json!({ "id": "r1", "allow": false }));
        assert_eq!(lab.browsers.port_of(AGENT), None);
        lab.request_end("r1").await;

        // `a` lends its browser (which allows the request pending then); from there on a request is
        // `a`'s to allow, and `b` can only deny it.
        lab.request("r2", "to read my invoices").await;
        let call = lab.spawn_attach(&a, None, None);
        let reqs = lab.serve(&["browserOverride", "browserAnswer"]).await;
        call.await.unwrap().unwrap();
        assert_eq!(reqs[1]["params"]["allow"], json!(true));
        lab.request_end("r2").await;
        lab.request("r3", "one more page").await;
        assert_eq!(lab.browsers.answer(&b, allow("r3")).await.unwrap_err().code, "invalid_params");
        assert_eq!(lab.deny(&b, "r3").await, json!({ "id": "r3", "allow": false }));
        lab.request_end("r3").await;
        lab.request("r4", "one more page").await;
        assert_eq!(lab.deny(&a, "r4").await, json!({ "id": "r4", "allow": false }), "the lender denies too");
        lab.request_end("r4").await;

        // A dismissal on the board (`agent.answer` with cancel) is a deny.
        lab.request("r5", "to change my DNS").await;
        let dismissed = Answer { choices: vec![], text: None, cancel: true, chat: false, back: false };
        let (bb, reason) = (lab.browsers.clone(), "to change my DNS".to_string());
        let call = tokio::spawn(async move { bb.answer_choice(AGENT, SID, "r5", &reason, &dismissed).await });
        let req = lab.serve(&["browserAnswer"]).await.remove(0);
        call.await.unwrap().unwrap();
        assert_eq!(req["params"], json!({ "id": "r5", "allow": false }));
        lab.request_end("r5").await;
        let denied = lab.activity().into_iter().filter(|e| *e == (ActivityKind::Denied, "Browser denied".to_string())).count();
        assert_eq!(denied, 4, "each deny is on the agent's activity");
    }

    /// Only an app that has the browser can answer a request, so only one counts: with just a
    /// phone connected the agent hears at once that none is available; with a computer that has
    /// the browser the request is asked; when it leaves the agent is told again.
    #[tokio::test(flavor = "multi_thread")]
    async fn only_an_app_with_a_browser_counts_as_one_that_can_answer() {
        let mut lab = Lab::new().await;
        let (phone, computer) = (app("phone", false), app("computer", true));
        lab.state.attach_client(&phone);
        lab.request("r1", "to read my invoices").await;
        let req = lab.serve(&["browserAnswer"]).await.remove(0);
        assert_eq!(req["params"]["id"], "r1");
        assert_eq!((&req["params"]["allow"], &req["params"]["unavailable"]), (&json!(false), &json!(true)));
        lab.request_end("r1").await;

        lab.state.attach_client(&computer);
        lab.request("r2", "to read my invoices").await;
        assert_eq!(lab.card().browser.and_then(|b| b.request).map(|r| r.id), Some("r2".to_string()), "asked, not answered");
        lab.request_end("r2").await;

        lab.state.detach_client(computer.id());
        lab.request("r3", "to read my invoices").await;
        let req = lab.serve(&["browserAnswer"]).await.remove(0);
        assert_eq!((&req["params"]["id"], &req["params"]["unavailable"]), (&json!("r3"), &json!(true)), "nothing was answered for r2");
        lab.request_end("r3").await;
    }

    /// The app that lent the browser and detaches the agent itself is not told (it asked for it);
    /// the agent's connections close all the same.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_app_detaching_its_own_attachment_is_not_told() {
        let mut lab = Lab::new().await;
        let a = app("a", true);
        let mut got = Vec::new();
        let (att, _) = lab.attach(&a, None, None).await;
        let mut tcp = tokio::net::TcpStream::connect(("127.0.0.1", att.port)).await.unwrap();
        until(&a, &mut got, "the stream", |g| !opened(g).is_empty()).await;
        let sid = opened(&got)[0];
        let (bb, c) = (lab.browsers.clone(), a.clone());
        let call = tokio::spawn(async move { bb.detach(&c, AGENT).await });
        let req = lab.serve(&["browserOverride"]).await.remove(0);
        assert_eq!(req["params"], json!({ "cdpUrl": null, "scope": null }));
        call.await.unwrap().unwrap();
        until(&a, &mut got, "the stream's end", |g| g.iter().any(|m| matches!(m, ServerMsg::Fwd { sid: s, ev: FwdEv::Close { .. } } if *s == sid))).await;
        assert!(detached(&got).is_empty(), "the app asked for it: {got:?}");
        let mut buf = [0u8; 1];
        assert!(matches!(tcp.read(&mut buf).await, Ok(0) | Err(_)), "the agent's connection closed");
        port_closed(att.port).await;
    }

    /// A bridge older than 2.3.0 has no browser tool or override to point at the browser: the
    /// attach is refused, and nothing listens.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_agent_whose_bridge_has_no_browser_cannot_be_lent_one() {
        let lab = Lab::with_bridge("2.2.0", json!({ "live": 1 })).await;
        let err = lab.browsers.attach(&app("a", true), BrowserAttachParams { agent_id: AGENT.into(), port: None, scope: None }).await.unwrap_err();
        assert_eq!(err.code, "unsupported");
        assert!(err.message.contains("2.3.0"), "{}", err.message);
        assert_eq!(lab.browsers.port_of(AGENT), None);
    }

    /// The bridge refuses the override (it has no browser settings to point): the attach fails and
    /// leaves nothing behind, neither a listener nor an attachment nor a line on the card.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_attach_the_bridge_refuses_leaves_nothing_behind() {
        let mut lab = Lab::new().await;
        let a = app("a", true);
        let call = lab.spawn_attach(&a, None, None);
        let req = lab.ext.recv_req().await;
        assert_eq!(req["op"], "browserOverride");
        let port: u16 = req["params"]["cdpUrl"].as_str().unwrap().rsplit(':').next().unwrap().parse().unwrap();
        lab.ext.send(json!({ "t": "res", "id": req["id"], "ok": false, "error": { "code": "unsupported", "message": "omp has no browser settings" } })).await;
        let err = call.await.unwrap().unwrap_err();
        assert_eq!((err.code.as_str(), err.message.as_str()), ("unsupported", "omp has no browser settings"));
        assert_eq!(lab.browsers.port_of(AGENT), None);
        port_closed(port).await;
        lab.state.rebuild_with(None);
        assert!(lab.card().browser.is_none());
    }
}
