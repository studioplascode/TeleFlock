//! The TeleFlock Browser, this device's side (architecture §5.2 "TeleFlock Browser"; wire
//! `tf_proto::browser`): one Chromium-family browser per desktop device, with a persistent
//! profile (`<data_dir>/browser/profile`) the user browses with, that agents drive only with the
//! user's consent.
//!
//! * **Engine** (`discover`, `install`): a configured path, else Google Chrome, Chromium, Microsoft
//!   Edge or Brave, else the Chrome for Testing the user let the app download.
//! * **Process** (`run`, `launch`): headless for the app's panel or in its own window, DevTools on
//!   a free loopback port open to the app's own origins only; restarted after crashes, stopped on
//!   `browser.stop` and when the app core shuts down. Android has no browser (`unavailable`).
//! * **Agents** (`agents`, `streams`, `proxy`): `browser.attach` (or an allowed request) makes
//!   the agent's host listen for it (`agent.browserAttach`); every connection the agent opens
//!   there arrives as a `fwd` stream of kind `browser`, served by the DevTools proxy, which shows
//!   the agent only its own tabs and the ones the user lent it. At most `cap` agents at once;
//!   further allowed requests wait for a slot.
//! * **Requests**: agents' `use_user_browser` requests come from host state (`Agent.browser`);
//!   `browser.answer` (or an `agent.answer` of such a request, routed here) allows or denies.
//! * `AppEvent::Browser` carries the status after every change.

mod agents;
mod cdp;
mod discover;
mod files;
#[cfg(not(target_os = "android"))]
mod install;
mod launch;
pub(crate) mod proxy;
mod run;
mod streams;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{Value, json};
use tf_proto::{
    AnswerParams, ApiError, AppEvent, AppMethod, BrowserAnswerParams, BrowserAttached, BrowserAttachment, BrowserClearWhat, BrowserConfig,
    BrowserConfigSetParams, BrowserDownload, BrowserEngine, BrowserInstall, BrowserRequest, BrowserScope, BrowserStaged, BrowserState,
    BrowserStatus, Empty, ForwardKind, FwdEv, HostState, Millis, Notification, NotifyKind,
};
use tokio::sync::{mpsc, oneshot};

use self::agents::{Agents, Attached, Waiting};
use self::proxy::{AttachKey, CdpProxy};
use self::run::Cmd;
use self::streams::{Fed, Stream};
use crate::engine::{EngineConfig, Inner};
use crate::link::{Link, timeout_for};
use crate::util::{invalid, now_ms, read_json, to_value, write_json};

/// The app's own web origins: the Tauri webview's (`tauri://localhost` on macOS and Linux,
/// `http://tauri.localhost` on Windows).
const APP_ORIGINS: [&str; 3] = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];
const CAP_DEFAULT: u32 = 4;
const CAP_MAX: u32 = 16;
/// How long a call waits for the browser to start.
const START_WAIT: Duration = Duration::from_secs(60);
/// Proxy changes (tab owners, activity) reach the UI at most this often.
const CHANGES_EVERY: Duration = Duration::from_millis(250);

/// `<data_dir>/browser/config.json` (`browser.configSet`).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Config {
    engine_path: Option<String>,
    headed: bool,
    cap: u32,
}

impl Default for Config {
    fn default() -> Self {
        Config { engine_path: None, headed: false, cap: CAP_DEFAULT }
    }
}

/// The browser's process state (`run` owns the process).
#[derive(Debug, Clone, Default)]
enum Run {
    #[default]
    Off,
    Starting {
        headed: bool,
    },
    Running {
        headed: bool,
        port: u16,
        ws_url: String,
        engine: BrowserEngine,
    },
    Error,
}

/// A pending `use_user_browser` request on a host's board.
#[derive(Debug, Clone, PartialEq)]
struct Ask {
    id: String,
    agent_id: String,
    agent_name: String,
    reason: String,
    at: Millis,
}

/// The browser of this app core (`Inner::browser`).
pub(crate) struct Browser {
    /// This app core runs a browser: desktop systems, not Android.
    available: bool,
    /// `linux`, `macos`, `windows`.
    os: String,
    /// `<data_dir>/browser`.
    dir: PathBuf,
    st: Mutex<St>,
    /// One lifecycle change at a time: start, stop, clearing everything.
    ops: tokio::sync::Mutex<()>,
    versions: Mutex<discover::Versions>,
    /// The status last sent: `AppEvent::Browser` goes out on changes only.
    sent: Mutex<Option<BrowserStatus>>,
    actor: OnceLock<mpsc::UnboundedSender<Cmd>>,
}

#[derive(Default)]
struct St {
    config: Config,
    /// Web origins of the embedder besides the app's own (`Engine::allow_browser_origins`).
    origins: Vec<String>,
    /// Engines found here, in the order they are preferred.
    engines: Vec<BrowserEngine>,
    /// The configured engine when it is not one of `engines`, as probed.
    chosen: Option<BrowserEngine>,
    run: Run,
    message: Option<String>,
    install: Option<BrowserInstall>,
    agents: Agents,
    /// Pending requests on each live host's board.
    asks: HashMap<String, Vec<Ask>>,
    /// Agents' connections by (link id, stream id).
    streams: HashMap<(u64, u64), Stream>,
    proxy: Option<Arc<CdpProxy>>,
}

impl Browser {
    /// Reads the saved config and finds the engines (versions come later).
    pub async fn load(cfg: &EngineConfig) -> Browser {
        let available = cfg!(not(target_os = "android")) && matches!(cfg.platform_name.as_str(), "linux" | "macos" | "windows");
        let dir = cfg.data_dir.join("browser");
        let config = match read_json::<Config>(&dir.join("config.json")).await {
            Ok(c) => c.unwrap_or_default(),
            Err(e) => {
                log::error!("{e}; using the default browser config");
                Config::default()
            }
        };
        let b = Browser {
            available,
            os: cfg.platform_name.clone(),
            dir,
            st: Mutex::new(St { config, ..St::default() }),
            ops: tokio::sync::Mutex::new(()),
            versions: Mutex::default(),
            sent: Mutex::new(None),
            actor: OnceLock::new(),
        };
        if available {
            let found = b.found();
            b.st.lock().unwrap().engines = found.into_iter().map(|(n, p)| BrowserEngine { name: n.into(), path: p.to_string_lossy().into_owned(), version: None }).collect();
        }
        b
    }

    /// Whether this app core has a browser (wire feature `browser`).
    pub fn available(&self) -> bool {
        self.available
    }

    fn profile(&self) -> PathBuf {
        self.dir.join("profile")
    }

    fn engine_dir(&self) -> PathBuf {
        self.dir.join("engine")
    }

    /// Origins allowed on the browser's DevTools WebSockets.
    fn origins(&self) -> Vec<String> {
        let extra = self.st.lock().unwrap().origins.clone();
        let mut all: Vec<String> = APP_ORIGINS.iter().map(|s| s.to_string()).collect();
        for o in extra {
            if !all.contains(&o) {
                all.push(o);
            }
        }
        all
    }

    /// The engines installed here, in the order they are preferred.
    fn found(&self) -> Vec<(&'static str, PathBuf)> {
        #[cfg(not(target_os = "android"))]
        let cft = install::installed(&self.engine_dir());
        #[cfg(target_os = "android")]
        let cft = None;
        discover::found(&self.os, &|k| std::env::var_os(k), cft)
    }

    fn cmd(&self, c: Cmd) -> Result<(), ApiError> {
        self.actor.get().and_then(|a| a.send(c).ok()).ok_or_else(|| ApiError::new("internal", "the browser's supervisor is not running"))
    }
}

/// Starts the browser's supervisor and the version probes. Called once by `Engine::start`.
pub(crate) fn start(inner: &Arc<Inner>) {
    let b = &inner.browser;
    if !b.available {
        return;
    }
    let (tx, rx) = mpsc::unbounded_channel();
    let _ = b.actor.set(tx);
    tokio::spawn(run::actor(Arc::downgrade(inner), rx));
    let i = inner.clone();
    tokio::spawn(async move { refresh_engines(&i).await });
}

/// Web origins (besides the app's own) whose pages may open the browser's DevTools: the
/// devserver's, a dev build's. Takes effect when the browser starts next.
pub(crate) fn allow_origins(inner: &Inner, origins: impl IntoIterator<Item = String>) {
    let mut st = inner.browser.st.lock().unwrap();
    for o in origins {
        let o = o.trim().trim_end_matches('/').to_string();
        if !o.is_empty() && !st.origins.contains(&o) {
            st.origins.push(o);
        }
    }
}

// ───────────────────────────── status and events ─────────────────────────────

fn no_engine_message() -> String {
    #[cfg(not(target_os = "android"))]
    if install::available() {
        return "No Chrome, Chromium, Edge or Brave on this computer. TeleFlock can download Chrome for Testing (about 200 MB).".into();
    }
    "No Chrome, Chromium, Edge or Brave on this computer: install one of them to use the TeleFlock Browser.".into()
}

/// The engine `browser.start` would run: the configured one, else the first found.
fn preferred(st: &St) -> Option<BrowserEngine> {
    match &st.config.engine_path {
        Some(p) => {
            let path = Path::new(p);
            if !discover::runnable(path) {
                return None;
            }
            let known = st.engines.iter().chain(&st.chosen).find(|e| e.path == *p).cloned();
            Some(known.unwrap_or_else(|| BrowserEngine {
                name: path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_else(|| p.clone()),
                path: p.clone(),
                version: None,
            }))
        }
        None => st.engines.first().cloned(),
    }
}

/// The status as `browser.status` and `AppEvent::Browser` carry it.
pub(crate) fn status(inner: &Inner) -> BrowserStatus {
    let b = &inner.browser;
    let (mut s, proxy, names, conns) = {
        let st = b.st.lock().unwrap();
        let wanted = preferred(&st);
        let missing = || match &st.config.engine_path {
            Some(p) => format!("{p}, the browser chosen in Settings → Browser, is not there any more."),
            None => no_engine_message(),
        };
        let (state, engine, headed, cdp_port, ws_url, message) = match &st.run {
            _ if !b.available => (BrowserState::Unavailable, None, false, None, None, Some("The TeleFlock Browser is part of TeleFlock for Windows, macOS and Linux.".into())),
            Run::Running { headed, port, ws_url, engine } => (BrowserState::Running, Some(engine.clone()), *headed, Some(*port), Some(ws_url.clone()), st.message.clone()),
            Run::Starting { headed } => (BrowserState::Starting, wanted, *headed, None, None, st.message.clone()),
            Run::Error => (BrowserState::Error, wanted, st.config.headed, None, None, st.message.clone()),
            Run::Off if wanted.is_none() => (BrowserState::Unavailable, None, st.config.headed, None, None, Some(missing())),
            Run::Off => (BrowserState::Off, wanted, st.config.headed, None, None, st.message.clone()),
        };
        let attachments = st
            .agents
            .attached
            .iter()
            .map(|a| BrowserAttachment {
                host_id: a.key.host_id.clone(),
                agent_id: a.key.agent_id.clone(),
                agent_name: a.name.clone(),
                since: a.since,
                host_port: a.host_port,
                scope: a.scope,
                connections: 0,
                active_at: None,
            })
            .collect();
        let mut requests: Vec<BrowserRequest> = st
            .asks
            .iter()
            .flat_map(|(host, asks)| {
                asks.iter().map(|q| {
                    let waiting = st.agents.waiting.iter().find(|w| w.request_id == q.id);
                    BrowserRequest {
                        id: q.id.clone(),
                        host_id: host.clone(),
                        agent_id: q.agent_id.clone(),
                        agent_name: q.agent_name.clone(),
                        reason: q.reason.clone(),
                        at: q.at,
                        waiting: waiting.is_some(),
                        scope: waiting.map(|w| w.scope),
                    }
                })
            })
            .collect();
        requests.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.id.cmp(&b.id)));
        let mut conns: HashMap<AttachKey, u32> = HashMap::new();
        for s in st.streams.values() {
            *conns.entry(s.who.clone()).or_default() += 1;
        }
        let status = BrowserStatus {
            state,
            engine,
            headed,
            cdp_port,
            ws_url,
            profile_dir: b.profile().to_string_lossy().into_owned(),
            download_dir: b.available.then(|| files::download_dir(&b.dir).to_string_lossy().into_owned()),
            message,
            install: st.install.clone(),
            cap: st.config.cap,
            attachments,
            requests,
            tabs: Vec::new(),
        };
        (status, st.proxy.clone(), st.agents.names.clone(), conns)
    };
    for a in &mut s.attachments {
        let key = AttachKey { host_id: a.host_id.clone(), agent_id: a.agent_id.clone() };
        a.connections = conns.get(&key).copied().unwrap_or_default();
        a.active_at = proxy.as_ref().and_then(|p| p.active_at(&key));
    }
    if let Some(p) = proxy {
        s.tabs = p.tabs();
        for t in &mut s.tabs {
            let key = AttachKey { host_id: t.host_id.clone(), agent_id: t.agent_id.clone() };
            t.agent_name = names.get(&key).cloned().unwrap_or_else(|| t.agent_id.clone());
        }
    }
    s
}

/// `AppEvent::Browser` when the status changed since the last one sent.
pub(crate) fn emit(inner: &Inner) {
    let _g = inner.emit_lock.lock().unwrap();
    let status = status(inner);
    let mut sent = inner.browser.sent.lock().unwrap();
    if sent.as_ref() != Some(&status) {
        *sent = Some(status.clone());
        inner.send(AppEvent::Browser { status });
    }
}

/// Sets the process state (and its message).
fn set_run(inner: &Inner, run: Run, message: Option<String>) {
    {
        let mut st = inner.browser.st.lock().unwrap();
        st.run = run;
        st.message = message;
    }
    emit(inner);
}

fn proxy_of(inner: &Inner) -> Option<Arc<CdpProxy>> {
    inner.browser.st.lock().unwrap().proxy.clone()
}

/// The browser runs (`p`): the proxy serves agents from its DevTools port.
fn running(inner: &Arc<Inner>, p: &launch::Proc, engine: BrowserEngine) {
    let (px, fresh) = {
        let mut st = inner.browser.st.lock().unwrap();
        st.run = Run::Running { headed: p.headed, port: p.port, ws_url: p.ws_url.clone(), engine };
        st.message = None;
        match &st.proxy {
            Some(px) => (px.clone(), false),
            None => {
                let px = CdpProxy::new(p.port);
                st.proxy = Some(px.clone());
                (px, true)
            }
        }
    };
    if fresh {
        // Tab owners and agents' activity reach the UI.
        let mut changes = px.changes();
        let weak = Arc::downgrade(inner);
        tokio::spawn(async move {
            while changes.changed().await.is_ok() {
                let Some(inner) = weak.upgrade() else { break };
                emit(&inner);
                drop(inner);
                tokio::time::sleep(CHANGES_EVERY).await;
            }
        });
    } else {
        // A new browser process: new DevTools port, new targets.
        px.set_upstream(p.port);
    }
    emit(inner);
}

// ───────────────────────────── engines ─────────────────────────────

/// Finds the engines again, with their versions; a configured path that is not one of them is
/// probed too.
async fn refresh_engines(inner: &Arc<Inner>) {
    let b = &inner.browser;
    let found: Vec<(Option<String>, PathBuf)> = b.found().into_iter().map(|(n, p)| (Some(n.to_string()), p)).collect();
    let configured = b.st.lock().unwrap().config.engine_path.clone().map(PathBuf::from).filter(|p| discover::runnable(p) && !found.iter().any(|(_, f)| f == p));
    let engines = discover::with_versions(&b.os, found, &b.versions).await;
    let chosen = match configured {
        Some(p) => discover::with_versions(&b.os, vec![(None, p)], &b.versions).await.pop(),
        None => None,
    };
    {
        let mut st = b.st.lock().unwrap();
        st.engines = engines;
        st.chosen = chosen;
    }
    emit(inner);
}

/// The engine to launch: the configured one, else the first found.
async fn engine_to_run(inner: &Arc<Inner>) -> Result<BrowserEngine, String> {
    let b = &inner.browser;
    let found = b.found();
    let configured = b.st.lock().unwrap().config.engine_path.clone();
    let (name, path) = match configured {
        Some(p) => {
            let path = PathBuf::from(&p);
            if !discover::runnable(&path) {
                return Err(format!("{p}, the browser chosen in Settings → Browser, is not there any more"));
            }
            (discover::name_of(&path, &found), path)
        }
        None => match found.first() {
            Some((n, p)) => (Some(n.to_string()), p.clone()),
            None => return Err(no_engine_message()),
        },
    };
    let mut e = discover::with_versions(&b.os, vec![(name, path)], &b.versions).await;
    Ok(e.remove(0))
}

// ───────────────────────────── lifecycle ─────────────────────────────

fn unsupported() -> ApiError {
    ApiError::new("unsupported", "The TeleFlock Browser is part of TeleFlock for Windows, macOS and Linux")
}

/// Starts the browser (`headed`: its mode; absent: the configured one), or relaunches it in the
/// other mode, and waits until it runs.
async fn start_browser(inner: &Arc<Inner>, headed: Option<bool>) -> Result<(), ApiError> {
    let b = &inner.browser;
    let headed = headed.unwrap_or_else(|| b.st.lock().unwrap().config.headed);
    let (reply, rx) = oneshot::channel();
    b.cmd(Cmd::Start { headed, reply })?;
    match tokio::time::timeout(START_WAIT, rx).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(e))) => Err(ApiError::new("browser_failed", format!("The browser did not start: {e}"))),
        Ok(Err(_)) => Err(ApiError::new("internal", "the browser's supervisor went away")),
        Err(_) => Err(ApiError::new("timeout", "the browser did not start in time").retryable()),
    }
}

/// The running browser's proxy, starting the browser (in the configured mode) when it is not
/// running.
async fn ensure_running(inner: &Arc<Inner>) -> Result<Arc<CdpProxy>, ApiError> {
    let running = |inner: &Inner| {
        let st = inner.browser.st.lock().unwrap();
        matches!(st.run, Run::Running { .. }).then(|| st.proxy.clone()).flatten()
    };
    if let Some(p) = running(inner) {
        return Ok(p);
    }
    start_browser(inner, None).await?;
    running(inner).ok_or_else(|| ApiError::new("browser_failed", "the browser stopped again"))
}

async fn stop_browser(inner: &Arc<Inner>) -> Result<(), ApiError> {
    let b = &inner.browser;
    let (reply, rx) = oneshot::channel();
    b.cmd(Cmd::Stop { reply })?;
    let _ = rx.await;
    if let Some(px) = proxy_of(inner) {
        px.close_all();
    }
    let _ = tokio::fs::remove_dir_all(b.dir.join("staged")).await;
    Ok(())
}

/// The app core shuts down: the browser stops.
pub(crate) async fn shutdown(inner: &Arc<Inner>) {
    if !inner.browser.available {
        return;
    }
    if tokio::time::timeout(Duration::from_secs(20), stop_browser(inner)).await.is_err() {
        log::warn!("browser: it did not stop within 20 s");
    }
}

// ───────────────────────────── agents ─────────────────────────────

fn busy(n: usize) -> ApiError {
    ApiError::new("browser_busy", format!("{n} agent{} use the browser", if n == 1 { "" } else { "s" }))
        .with_hint("Detach one of them, or attach anyway")
}

/// `agent_id`'s name on its host's board.
fn agent_name(inner: &Inner, host_id: &str, agent_id: &str) -> Option<String> {
    let rt = inner.host(host_id)?;
    let v = rt.view.lock().unwrap();
    v.state.as_ref()?.1.agents.iter().find(|a| a.id == agent_id).map(|a| a.name.clone())
}

/// The host's link, when it speaks the browser's wire feature.
fn browser_link(inner: &Inner, host_id: &str) -> Result<Arc<Link>, ApiError> {
    let name = || inner.profile(host_id).map(|p| p.name).unwrap_or_else(|| host_id.to_string());
    let rt = inner.host(host_id).ok_or_else(|| ApiError::new("not_found", format!("unknown host `{host_id}`")))?;
    let link = rt.link().filter(|l| !l.is_closed()).ok_or_else(|| {
        ApiError::new("not_connected", format!("{} is not connected", name())).with_hint("Connect the host and try again").retryable()
    })?;
    if !link.features.browser {
        return Err(ApiError::new("unsupported", format!("{} runs a tf-hostd older than 0.9.0, without the TeleFlock Browser", name()))
            .with_hint("TeleFlock updates it when it connects to the host again"));
    }
    Ok(link)
}

/// Attaches `key` with `scope`: claims a slot under the cap (unless `over_cap`), starts the
/// browser when needed, tells the proxy, then the agent's host.
async fn attach(inner: &Arc<Inner>, key: AttachKey, scope: BrowserScope, over_cap: bool) -> Result<(), ApiError> {
    let link = browser_link(inner, &key.host_id)?;
    let name = agent_name(inner, &key.host_id, &key.agent_id).ok_or_else(|| ApiError::new("not_found", format!("unknown agent `{}`", key.agent_id)))?;
    {
        let mut st = inner.browser.st.lock().unwrap();
        let cap = st.config.cap;
        if !st.agents.begin(&key, cap, over_cap) {
            return Err(busy(st.agents.attached.len()));
        }
    }
    attach_claimed(inner, key, link, name, scope).await
}

/// [`attach`] once the slot is claimed (`Agents::begin`).
async fn attach_claimed(inner: &Arc<Inner>, key: AttachKey, link: Arc<Link>, name: String, scope: BrowserScope) -> Result<(), ApiError> {
    let before = inner.browser.st.lock().unwrap().agents.get(&key).cloned();
    let attached = async {
        let proxy = ensure_running(inner).await?;
        proxy.attach(&key);
        let params = json!({ "agentId": key.agent_id, "port": before.as_ref().map(|a| a.host_port), "scope": scope });
        let r = link.request("agent.browserAttach", params, timeout_for("agent.browserAttach")).await?;
        let r: BrowserAttached = serde_json::from_value(r).map_err(|e| ApiError::new("internal", format!("agent.browserAttach: {e}")))?;
        Ok::<_, ApiError>(r.port)
    }
    .await;
    let result = match attached {
        Ok(port) => {
            log::info!("browser: {} on {} attached ({scope:?}, port {port})", key.agent_id, key.host_id);
            let since = before.as_ref().map_or_else(now_ms, |a| a.since);
            let a = Attached { key: key.clone(), name, since, host_port: port, scope, link: link.id };
            inner.browser.st.lock().unwrap().agents.finish(&key, Some(a));
            Ok(())
        }
        Err(e) => {
            log::info!("browser: attaching {} on {} failed: {}", key.agent_id, key.host_id, e.message);
            inner.browser.st.lock().unwrap().agents.finish(&key, None);
            if before.is_none()
                && let Some(px) = proxy_of(inner)
            {
                px.detach(&key);
            }
            Err(e)
        }
    };
    emit(inner);
    result
}

/// Ends `key`'s attachment here (`from_host`: tf-hostd ended it already) and gives its slot to
/// the oldest waiting request.
async fn detach(inner: &Arc<Inner>, key: &AttachKey, from_host: bool) {
    let removed = inner.browser.st.lock().unwrap().agents.remove(key);
    if let Some(px) = proxy_of(inner) {
        px.detach(key);
    }
    if !from_host && let Ok(link) = browser_link(inner, &key.host_id) {
        let params = json!({ "agentId": key.agent_id });
        if let Err(e) = link.request("agent.browserDetach", params, timeout_for("agent.browserDetach")).await {
            log::info!("browser: detaching {} on {}: {}", key.agent_id, key.host_id, e.message);
        }
    }
    if removed.is_some() {
        log::info!("browser: {} on {} detached", key.agent_id, key.host_id);
    }
    inner.browser.st.lock().unwrap().agents.prune(|w| w.key != *key);
    admit_waiting(inner);
    emit(inner);
}

/// `browser.stop`: allowed requests stop waiting (they are pending again) and every agent is
/// detached, its host told.
async fn detach_all(inner: &Arc<Inner>) {
    let keys: Vec<AttachKey> = {
        let mut st = inner.browser.st.lock().unwrap();
        st.agents.waiting.clear();
        st.agents.attached.iter().map(|a| a.key.clone()).collect()
    };
    for key in keys {
        detach(inner, &key, false).await;
    }
}

/// Waiting requests that fit under the cap now attach, oldest first.
fn admit_waiting(inner: &Arc<Inner>) {
    let next: Vec<Waiting> = {
        let mut st = inner.browser.st.lock().unwrap();
        let cap = st.config.cap;
        let next = st.agents.admissible(cap);
        for w in &next {
            st.agents.begin(&w.key, cap, true);
        }
        next
    };
    for w in next {
        let inner = inner.clone();
        tokio::spawn(async move {
            let ready = browser_link(&inner, &w.key.host_id).and_then(|l| {
                agent_name(&inner, &w.key.host_id, &w.key.agent_id).map(|n| (l, n)).ok_or_else(|| ApiError::new("not_found", "the agent is gone"))
            });
            let done = match ready {
                Ok((link, name)) => attach_claimed(&inner, w.key.clone(), link, name, w.scope).await,
                Err(e) => {
                    inner.browser.st.lock().unwrap().agents.finish(&w.key, None);
                    emit(&inner);
                    Err(e)
                }
            };
            if let Err(e) = done {
                log::info!("browser: the waiting request of {} could not attach: {}", w.key.agent_id, e.message);
            }
        });
    }
}

/// The request `request_id` on some live host's board: `(host id, request)`.
fn find_ask(inner: &Inner, request_id: &str) -> Option<(String, Ask)> {
    let st = inner.browser.st.lock().unwrap();
    st.asks.iter().find_map(|(h, asks)| asks.iter().find(|a| a.id == request_id).map(|a| (h.clone(), a.clone())))
}

/// `browser.answer`: deny, or allow (attach now, or wait for a slot at the cap).
async fn answer(inner: &Arc<Inner>, p: BrowserAnswerParams) -> Result<(), ApiError> {
    let (host_id, ask) = find_ask(inner, &p.request_id)
        .ok_or_else(|| ApiError::new("stale", "this request was already answered").with_hint("The agent may have stopped asking"))?;
    let key = AttachKey { host_id: host_id.clone(), agent_id: ask.agent_id.clone() };
    if !p.allow {
        inner.browser.st.lock().unwrap().agents.prune(|w| w.request_id != p.request_id);
        let link = browser_link(inner, &host_id)?;
        link.request("agent.browserAnswer", json!({ "requestId": p.request_id, "allow": false }), timeout_for("agent.browserAnswer")).await?;
        emit(inner);
        return Ok(());
    }
    let scope = p.scope.unwrap_or(BrowserScope::Session);
    let over_cap = p.over_cap.unwrap_or(false);
    let queued = {
        let mut st = inner.browser.st.lock().unwrap();
        let cap = st.config.cap;
        let full = !st.agents.admits(&key, cap, over_cap);
        if full {
            st.agents.wait(Waiting { request_id: p.request_id.clone(), key: key.clone(), scope });
        }
        full
    };
    if queued {
        log::info!("browser: {}'s request waits for a free slot", ask.agent_name);
        emit(inner);
        return Ok(());
    }
    attach(inner, key, scope, over_cap).await
}

/// The request `request_id` of `agent_id` on `host_id`'s board is a browser request.
fn is_browser_request(inner: &Inner, host_id: &str, agent_id: &str, request_id: &str) -> bool {
    let Some(rt) = inner.host(host_id) else { return false };
    let v = rt.view.lock().unwrap();
    let Some((_, state)) = v.state.as_ref() else { return false };
    state.agents.iter().find(|a| a.id == agent_id).and_then(|a| a.needs.as_ref()).is_some_and(|n| n.browser && n.request_id.as_deref() == Some(request_id))
}

/// An `agent.answer` of a browser request goes to `browser.answer` here, when this app core has
/// the browser; `None`: not one (or no browser here), for the host to answer.
pub(crate) async fn route_answer(inner: &Arc<Inner>, host_id: &str, p: &AnswerParams) -> Option<Result<Value, ApiError>> {
    if !inner.browser.available || !is_browser_request(inner, host_id, &p.agent_id, &p.request_id) {
        return None;
    }
    let scope = agents::answer_scope(&p.answer)?;
    let params = BrowserAnswerParams { request_id: p.request_id.clone(), allow: scope.is_some(), scope, over_cap: None };
    Some(answer(inner, params).await.map(|()| json!({})))
}

/// A browser request's notification on an app core without the browser (Android): Deny only, and
/// the actions that just open the agent. Allowing belongs to a computer with the browser; tf-hostd
/// refuses an Allow through `agent.answer`.
pub(crate) fn notification_for_device(inner: &Inner, host_id: &str, n: &mut Notification) {
    if inner.browser.available || n.kind != NotifyKind::Needs {
        return;
    }
    if n.request_id.as_deref().is_some_and(|r| is_browser_request(inner, host_id, &n.agent_id, r)) {
        agents::deny_only(&mut n.actions);
    }
}

// ───────────────────────────── hosts ─────────────────────────────

/// The pending requests on a board.
fn asks_in(state: &HostState) -> Vec<Ask> {
    state
        .agents
        .iter()
        .filter_map(|a| {
            let q = a.browser.as_ref()?.request.as_ref()?;
            Some(Ask { id: q.id.clone(), agent_id: a.id.clone(), agent_name: a.name.clone(), reason: q.reason.clone(), at: q.at })
        })
        .collect()
}

/// A host's state changed: its pending requests and the names of attached agents are read
/// again (a cached state, while the host is offline, has no requests anyone could answer).
pub(crate) fn host_changed(inner: &Inner, host_id: &str) {
    if !inner.browser.available {
        return;
    }
    let Some(rt) = inner.host(host_id) else { return };
    let changed = {
        let v = rt.view.lock().unwrap();
        let state = v.state.as_ref().filter(|_| v.live).map(|(_, s)| s);
        let asks = state.map(asks_in).unwrap_or_default();
        let mut st = inner.browser.st.lock().unwrap();
        let mut changed = false;
        if let Some(s) = state {
            for a in st.agents.attached.iter_mut().filter(|a| a.key.host_id == host_id) {
                if let Some(x) = s.agents.iter().find(|x| x.id == a.key.agent_id && x.name != a.name) {
                    a.name = x.name.clone();
                    changed = true;
                }
            }
        }
        if st.asks.get(host_id).map_or(asks.is_empty(), |old| *old == asks) {
            changed
        } else {
            let ids: Vec<String> = asks.iter().map(|a| a.id.clone()).collect();
            if asks.is_empty() {
                st.asks.remove(host_id);
            } else {
                st.asks.insert(host_id.to_string(), asks);
            }
            st.agents.prune(|w| w.key.host_id != host_id || ids.contains(&w.request_id));
            true
        }
    };
    if changed {
        emit(inner);
    }
}

/// A link to `host_id` came up: requests show, session-scoped attachments attach again (the
/// host forgot them with the old connection), and the link's streams end with it.
pub(crate) fn link_up(inner: &Arc<Inner>, host_id: &str, link: &Arc<Link>) {
    if !inner.browser.available {
        return;
    }
    let (weak, host, l) = (Arc::downgrade(inner), host_id.to_string(), link.clone());
    tokio::spawn(async move {
        l.closed().await;
        if let Some(inner) = weak.upgrade() {
            link_down(&inner, &host, l.id);
        }
    });
    let (ended, again) = inner.browser.st.lock().unwrap().agents.relink(host_id, link.id);
    end_attachments(inner, &ended);
    host_changed(inner, host_id);
    if again.is_empty() {
        return;
    }
    let (inner, link) = (inner.clone(), link.clone());
    tokio::spawn(async move {
        for a in again {
            let params = json!({ "agentId": a.key.agent_id, "port": a.host_port, "scope": a.scope });
            let attached = match link.features.browser {
                true => link.request("agent.browserAttach", params, timeout_for("agent.browserAttach")).await,
                false => Err(ApiError::new("unsupported", "the host's tf-hostd has no TeleFlock Browser any more")),
            };
            match attached.and_then(|r| serde_json::from_value::<BrowserAttached>(r).map_err(|e| ApiError::new("internal", e.to_string()))) {
                Ok(r) => {
                    if let Some(x) = inner.browser.st.lock().unwrap().agents.attached.iter_mut().find(|x| x.key == a.key) {
                        x.host_port = r.port;
                        x.link = link.id;
                    }
                    log::info!("browser: {} on {} attached again", a.key.agent_id, a.key.host_id);
                }
                Err(e) => {
                    log::info!("browser: {} on {} could not attach again: {}", a.key.agent_id, a.key.host_id, e.message);
                    inner.browser.st.lock().unwrap().agents.remove(&a.key);
                    end_attachments(&inner, std::slice::from_ref(&a));
                }
            }
        }
        admit_waiting(&inner);
        emit(&inner);
    });
}

/// The proxy forgets ended attachments (their connections close, their tabs stay).
fn end_attachments(inner: &Inner, ended: &[Attached]) {
    if ended.is_empty() {
        return;
    }
    if let Some(px) = proxy_of(inner) {
        for a in ended {
            px.detach(&a.key);
        }
    }
}

fn link_down(inner: &Arc<Inner>, host_id: &str, link_id: u64) {
    let current = inner.host(host_id).and_then(|rt| rt.link()).is_none_or(|l| l.id == link_id || l.is_closed());
    let ended = {
        let mut st = inner.browser.st.lock().unwrap();
        let gone: Vec<(u64, u64)> = st.streams.keys().filter(|(l, _)| *l == link_id).copied().collect();
        for k in gone {
            if let Some(s) = st.streams.remove(&k) {
                s.end();
            }
        }
        if current {
            st.asks.remove(host_id);
            st.agents.prune(|w| w.key.host_id != host_id);
        }
        st.agents.link_lost(host_id, link_id)
    };
    end_attachments(inner, &ended);
    admit_waiting(inner);
    emit(inner);
}

/// `browserDetached` from a host: the attachment ended there (its turn ended, its omp session
/// ended, another device detached it).
pub(crate) fn on_detached(inner: &Arc<Inner>, host_id: &str, agent_id: &str, reason: &str) {
    log::info!("browser: {agent_id} on {host_id} detached by the host: {reason}");
    let key = AttachKey { host_id: host_id.to_string(), agent_id: agent_id.to_string() };
    let inner = inner.clone();
    tokio::spawn(async move { detach(&inner, &key, true).await });
}

/// A `fwd` event from `host_id`'s link: browser streams are handled here; anything else is
/// returned for the forwarding relay.
pub(crate) fn on_fwd(inner: &Arc<Inner>, host_id: &str, link: &Arc<Link>, sid: u64, ev: FwdEv) -> Option<FwdEv> {
    if sid.is_multiple_of(2)
        && let FwdEv::Open { kind: ForwardKind::Browser, name, .. } = &ev
    {
        open_stream(inner, host_id, link, sid, name.clone());
        return None;
    }
    let fed = {
        let mut st = inner.browser.st.lock().unwrap();
        let Some(s) = st.streams.get(&(link.id, sid)) else { return Some(ev) };
        match s.on_event(ev) {
            Fed::Ok => return None,
            Fed::Closed => {
                st.streams.remove(&(link.id, sid));
                None
            }
            Fed::Broken(why) => {
                if let Some(s) = st.streams.remove(&(link.id, sid)) {
                    s.end();
                }
                Some(why)
            }
        }
    };
    if let Some(why) = fed {
        log::warn!("browser: stream {sid} from {host_id} cut: {why}");
        let _ = link.fwd(sid, FwdEv::Close { error: Some(why.to_string()) });
    }
    emit(inner);
    None
}

/// An agent's new connection: served once the browser runs, refused when the agent is not
/// attached from this app.
fn open_stream(inner: &Arc<Inner>, host_id: &str, link: &Arc<Link>, sid: u64, agent_id: String) {
    let device = inner.device_name();
    let who = AttachKey { host_id: host_id.to_string(), agent_id };
    let refused = {
        let mut st = inner.browser.st.lock().unwrap();
        if !inner.browser.available {
            Some(format!("TeleFlock on {device} has no browser"))
        } else if !st.agents.serves(&who) {
            Some(format!("this agent is not attached to the TeleFlock Browser on {device}"))
        } else if st.streams.contains_key(&(link.id, sid)) {
            return;
        } else {
            let (stream, runner) = streams::new(who.clone());
            st.streams.insert((link.id, sid), stream);
            let (weak, link) = (Arc::downgrade(inner), link.clone());
            tokio::spawn(async move {
                let Some(inner) = weak.upgrade() else { return };
                match ensure_running(&inner).await {
                    Ok(proxy) => runner.run(proxy, who, link.clone(), sid).await,
                    Err(e) => {
                        let _ = link.fwd(sid, FwdEv::Close { error: Some(format!("the TeleFlock Browser on {device} did not start: {}", e.message)) });
                    }
                }
                if let Some(s) = inner.browser.st.lock().unwrap().streams.remove(&(link.id, sid)) {
                    s.end();
                }
                emit(&inner);
            });
            None
        }
    };
    match refused {
        Some(why) => {
            log::info!("browser: connection {sid} from {host_id} refused: {why}");
            let _ = link.fwd(sid, FwdEv::Close { error: Some(why) });
        }
        None => emit(inner),
    }
}

// ───────────────────────────── app methods ─────────────────────────────

async fn config(inner: &Arc<Inner>) -> BrowserConfig {
    refresh_engines(inner).await;
    let b = &inner.browser;
    let st = b.st.lock().unwrap();
    #[cfg(not(target_os = "android"))]
    let download = BrowserDownload { version: install::VERSION.into(), available: install::available(), installed: install::installed(&b.engine_dir()).is_some() };
    #[cfg(target_os = "android")]
    let download = BrowserDownload { version: String::new(), available: false, installed: false };
    BrowserConfig { engine_path: st.config.engine_path.clone(), headed: st.config.headed, cap: st.config.cap, engines: st.engines.clone(), download }
}

async fn config_set(inner: &Arc<Inner>, p: BrowserConfigSetParams) -> Result<BrowserConfig, ApiError> {
    let engine_path = p.engine_path.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Some(e) = &engine_path
        && !discover::runnable(Path::new(e))
    {
        return Err(invalid(format!("{e} is not a program on this computer")));
    }
    let cap = p.cap.unwrap_or(CAP_DEFAULT);
    if !(1..=CAP_MAX).contains(&cap) {
        return Err(invalid(format!("cap: 1 to {CAP_MAX} agents")));
    }
    let c = Config { engine_path, headed: p.headed.unwrap_or(false), cap };
    {
        let _ops = inner.browser.ops.lock().await;
        write_json(&inner.browser.dir.join("config.json"), &c).await?;
        inner.browser.st.lock().unwrap().config = c;
    }
    admit_waiting(inner);
    Ok(config(inner).await)
}

#[cfg(not(target_os = "android"))]
fn install_engine(inner: &Arc<Inner>) -> Result<(), ApiError> {
    if !install::available() {
        return Err(ApiError::new("unsupported", "Chrome for Testing has no build for this computer"));
    }
    {
        let mut st = inner.browser.st.lock().unwrap();
        if st.install.as_ref().is_some_and(|i| i.error.is_none()) {
            return Ok(());
        }
        st.install = Some(BrowserInstall { version: install::VERSION.into(), progress: None, error: None });
    }
    emit(inner);
    let inner = inner.clone();
    tokio::spawn(async move {
        let dir = inner.browser.engine_dir();
        let progress = |pct: u8| {
            if let Some(i) = inner.browser.st.lock().unwrap().install.as_mut() {
                i.progress = Some(pct);
            }
            emit(&inner);
        };
        match install::install(&dir, progress).await {
            Ok(exe) => {
                log::info!("browser: Chrome for Testing {} installed at {}", install::VERSION, exe.display());
                inner.browser.st.lock().unwrap().install = None;
                refresh_engines(&inner).await;
            }
            Err(e) => {
                log::warn!("browser: Chrome for Testing download failed: {e}");
                inner.browser.st.lock().unwrap().install = Some(BrowserInstall { version: install::VERSION.into(), progress: None, error: Some(e) });
                emit(&inner);
            }
        }
    });
    Ok(())
}

#[cfg(target_os = "android")]
fn install_engine(_: &Arc<Inner>) -> Result<(), ApiError> {
    Err(unsupported())
}

/// `browser.clearData`.
async fn clear(inner: &Arc<Inner>, what: BrowserClearWhat) -> Result<(), ApiError> {
    let b = &inner.browser;
    let _ops = b.ops.lock().await;
    let (ws_url, headed) = match &b.st.lock().unwrap().run {
        Run::Running { ws_url, headed, .. } => (Some(ws_url.clone()), Some(*headed)),
        Run::Starting { headed } => (None, Some(*headed)),
        _ => (None, None),
    };
    let failed = |e: String| ApiError::new("browser_failed", e);
    match (what, ws_url) {
        (BrowserClearWhat::Cookies, Some(ws)) => cdp::clear_cookies(&ws).await.map_err(failed),
        (BrowserClearWhat::Cache, Some(ws)) => cdp::clear_cache(&ws).await.map_err(failed),
        (BrowserClearWhat::Cookies | BrowserClearWhat::Cache, None) => {
            files::remove_profile_files(&b.profile(), what == BrowserClearWhat::Cookies);
            Ok(())
        }
        (BrowserClearWhat::Everything, _) => {
            stop_browser(inner).await?;
            let profile = b.profile();
            if let Err(e) = tokio::fs::remove_dir_all(&profile).await
                && e.kind() != std::io::ErrorKind::NotFound
            {
                return Err(ApiError::new("io_error", format!("can't remove {}: {e}", profile.display())));
            }
            log::info!("browser: the profile was cleared");
            match headed {
                Some(h) => start_browser(inner, Some(h)).await,
                None => Ok(()),
            }
        }
    }
}

/// `browser.*` app methods.
pub(crate) async fn call(inner: &Arc<Inner>, m: AppMethod) -> Result<Value, ApiError> {
    let b = &inner.browser;
    if !b.available && !matches!(m, AppMethod::BrowserStatusReq(_)) {
        return Err(unsupported());
    }
    let key = |host_id: String, agent_id: String| AttachKey { host_id, agent_id };
    match m {
        AppMethod::BrowserStatusReq(_) => {}
        AppMethod::BrowserStart(p) => {
            let _ops = b.ops.lock().await;
            start_browser(inner, p.headed).await?;
        }
        AppMethod::BrowserStop(_) => {
            detach_all(inner).await;
            let _ops = b.ops.lock().await;
            stop_browser(inner).await?;
        }
        AppMethod::BrowserAttach(p) => attach(inner, key(p.host_id, p.agent_id), BrowserScope::Session, p.over_cap.unwrap_or(false)).await?,
        AppMethod::BrowserDetach(p) => detach(inner, &key(p.host_id, p.agent_id), false).await,
        AppMethod::BrowserAnswer(p) => answer(inner, p).await?,
        AppMethod::BrowserConfigReq(_) => return to_value(&config(inner).await),
        AppMethod::BrowserConfigSet(p) => return to_value(&config_set(inner, p).await?),
        AppMethod::BrowserInstallEngine(_) => install_engine(inner)?,
        AppMethod::BrowserClearData(p) => clear(inner, p.what).await?,
        AppMethod::BrowserStageFile(p) => {
            let path = files::stage(&b.dir.join("staged"), &p.name, &p.data).await?;
            return to_value(&BrowserStaged { path: path.to_string_lossy().into_owned() });
        }
        AppMethod::BrowserRevealDownload(p) => {
            files::reveal(&files::download_path(&files::download_dir(&b.dir), &p.path)?)?;
            return to_value(&Empty {});
        }
        AppMethod::BrowserRevealProfile(_) => {
            // It exists from the browser's first start; shown even before that.
            let profile = b.profile();
            tokio::fs::create_dir_all(&profile).await.map_err(|e| ApiError::new("io_error", format!("can't create {}: {e}", profile.display())))?;
            files::reveal(&profile)?;
            return to_value(&Empty {});
        }
        AppMethod::BrowserTakeOver(p) => running_proxy(inner)?.take_over(&p.target_id)?,
        AppMethod::BrowserHandBack(p) => running_proxy(inner)?.hand_back(&p.target_id)?,
        AppMethod::BrowserLendTab(p) => {
            let who = key(p.host_id, p.agent_id);
            if b.st.lock().unwrap().agents.get(&who).is_none() {
                return Err(ApiError::new("not_found", "that agent is not attached to the browser"));
            }
            running_proxy(inner)?.lend_tab(&p.target_id, &who)?;
        }
        other => return Err(ApiError::new("internal", format!("not a browser method: {:?}", other.name()))),
    }
    emit(inner);
    to_value(&status(inner))
}

fn running_proxy(inner: &Inner) -> Result<Arc<CdpProxy>, ApiError> {
    let st = inner.browser.st.lock().unwrap();
    match (&st.run, &st.proxy) {
        (Run::Running { .. }, Some(p)) => Ok(p.clone()),
        _ => Err(ApiError::new("not_running", "the browser is not running")),
    }
}
