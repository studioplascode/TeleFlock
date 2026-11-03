//! The TeleFlock Browser, this device's side (architecture §5.2 "TeleFlock Browser"; wire
//! `tf_proto::browser`): one Chromium-family browser per desktop device, with a persistent
//! profile (`<data_dir>/browser/profile`) the user browses with, that agents drive only with the
//! user's consent.
//!
//! * **Engine** (`discover`, `install`): a configured path, else Google Chrome, Chromium, Microsoft
//!   Edge or Brave, else the Chrome for Testing the user let the app download (TeleFlock's own
//!   browser). An engine the organization's policy refuses remote control (`RemoteDebuggingAllowed`)
//!   is marked blocked here and passed over by Automatic; TeleFlock's own browser takes over when it
//!   is downloaded, else it is offered ([`Fallback`]).
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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{Value, json};
use tf_proto::{
    AnswerParams, ApiError, AppEvent, AppMethod, BrowserAnswerParams, BrowserAttached, BrowserAttachment, BrowserBlocked, BrowserClearWhat,
    BrowserConfig, BrowserConfigSetParams, BrowserDownload, BrowserEngine, BrowserFallback, BrowserInstall, BrowserRequest, BrowserScope,
    BrowserStaged, BrowserState, BrowserStatus, Empty, ForwardKind, FwdEv, HostState, Millis, Notification, NotifyKind,
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

/// `<data_dir>/browser/config.json` (`browser.configSet`; `blocked` is the app core's).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Config {
    engine_path: Option<String>,
    headed: bool,
    cap: u32,
    /// Engines (paths) the organization's policy refused remote control when they were started
    /// here, until one starts fine again.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    blocked: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Config { engine_path: None, headed: false, cap: CAP_DEFAULT, blocked: Vec::new() }
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
    /// One write of `config.json` at a time (the supervisor writes it too: never under `ops`).
    saving: tokio::sync::Mutex<()>,
    versions: Mutex<discover::Versions>,
    /// The status last sent: `AppEvent::Browser` goes out on changes only.
    sent: Mutex<Option<BrowserStatus>>,
    actor: OnceLock<mpsc::UnboundedSender<Cmd>>,
}

/// A Chrome for Testing download running now (`St::install` shows it).
struct Downloading {
    /// `browser.cancelInstall`.
    cancel: Arc<AtomicBool>,
    /// Choose it and start the browser once it is there (`browser.installEngine {start}`).
    start: bool,
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
    /// The last start found an engine blocked (until the next start or stop).
    blocked: Option<BrowserBlocked>,
    install: Option<BrowserInstall>,
    downloading: Option<Downloading>,
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
            saving: tokio::sync::Mutex::new(()),
            versions: Mutex::default(),
            sent: Mutex::new(None),
            actor: OnceLock::new(),
        };
        if available {
            let found = b.found();
            b.st.lock().unwrap().engines = found.into_iter().map(|(n, p)| discover::engine(n, &p, None)).collect();
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

    /// TeleFlock's own browser here: its program (where it is, or will be once downloaded) and
    /// whether it is downloaded; `None`: no build for this computer.
    fn own(&self) -> Option<(PathBuf, bool)> {
        #[cfg(not(target_os = "android"))]
        let own = install::program(&self.engine_dir()).map(|p| {
            let there = p.is_file();
            (p, there)
        });
        #[cfg(target_os = "android")]
        let own = None;
        own
    }

    /// TeleFlock's own browser as `browser.installEngine` downloads it.
    fn download(&self) -> BrowserDownload {
        #[cfg(not(target_os = "android"))]
        let d = BrowserDownload { version: install::VERSION.into(), available: install::available(), installed: install::installed(&self.engine_dir()).is_some(), size: install::size() };
        #[cfg(target_os = "android")]
        let d = BrowserDownload { version: String::new(), available: false, installed: false, size: None };
        d
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

/// `engine` with its `blocked` mark as this device has it.
fn marked(mut engine: BrowserEngine, blocked: &[String]) -> BrowserEngine {
    engine.blocked = blocked.contains(&engine.path);
    engine
}

/// The engine Automatic picks among those found (in the order they are preferred): the first one
/// the organization's policy did not block here, else (every one blocked: policies change) the
/// first.
fn automatic<'a, T>(found: &'a [T], path: impl Fn(&T) -> String, blocked: &[String]) -> Option<&'a T> {
    found.iter().find(|e| !blocked.contains(&path(e))).or_else(|| found.first())
}

/// The engine `browser.start` would run: the configured one, else Automatic's.
fn preferred(st: &St) -> Option<BrowserEngine> {
    let blocked = &st.config.blocked;
    let engine = match &st.config.engine_path {
        Some(p) => {
            let path = Path::new(p);
            if !discover::runnable(path) {
                return None;
            }
            let known = st.engines.iter().chain(&st.chosen).find(|e| e.path == *p).cloned();
            known.unwrap_or_else(|| BrowserEngine {
                name: path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_else(|| p.clone()),
                path: p.clone(),
                version: None,
                builtin: false,
                blocked: false,
            })
        }
        None => automatic(&st.engines, |e| e.path.clone(), blocked)?.clone(),
    };
    Some(marked(engine, blocked))
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
            blocked: st.blocked.clone(),
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

/// Sets the process state (and its message); a start or a stop forgets the last block.
fn set_run(inner: &Inner, run: Run, message: Option<String>) {
    {
        let mut st = inner.browser.st.lock().unwrap();
        if matches!(run, Run::Starting { .. } | Run::Off) {
            st.blocked = None;
        }
        st.run = run;
        st.message = message;
    }
    emit(inner);
}

/// A start failed: the browser stays down, saying why (and, when the organization's policy
/// blocked it, what is left).
fn start_failed(inner: &Inner, e: &StartError) {
    {
        let mut st = inner.browser.st.lock().unwrap();
        st.run = Run::Error;
        st.message = Some(e.message());
        st.blocked = match e {
            StartError::Blocked { blocked, .. } => Some(blocked.clone()),
            StartError::Failed(_) => None,
        };
    }
    emit(inner);
}

fn proxy_of(inner: &Inner) -> Option<Arc<CdpProxy>> {
    inner.browser.st.lock().unwrap().proxy.clone()
}

/// The browser runs (`p`): the proxy serves agents from its DevTools port. `switched`: it runs
/// TeleFlock's own browser because the organization's policy blocked the engine it was to run
/// (the notice and why, said once).
fn running(inner: &Arc<Inner>, p: &launch::Proc, engine: BrowserEngine, switched: Option<(BrowserBlocked, String)>) {
    let (px, fresh) = {
        let mut st = inner.browser.st.lock().unwrap();
        st.run = Run::Running { headed: p.headed, port: p.port, ws_url: p.ws_url.clone(), engine };
        let (blocked, why) = switched.map_or((None, None), |(blocked, why)| (Some(blocked), Some(why)));
        st.blocked = blocked;
        st.message = why;
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

/// The engine to launch: the configured one, else Automatic's.
async fn engine_to_run(inner: &Arc<Inner>) -> Result<BrowserEngine, String> {
    let b = &inner.browser;
    let found = b.found();
    let (configured, blocked) = {
        let st = b.st.lock().unwrap();
        (st.config.engine_path.clone(), st.config.blocked.clone())
    };
    let path = match configured {
        Some(p) => {
            let path = PathBuf::from(&p);
            if !discover::runnable(&path) {
                return Err(format!("{p}, the browser chosen in Settings → Browser, is not there any more"));
            }
            path
        }
        None => match automatic(&found, |(_, p)| p.to_string_lossy().into_owned(), &blocked) {
            Some((_, p)) => p.clone(),
            None => return Err(no_engine_message()),
        },
    };
    Ok(engine_at(inner, path, &found).await)
}

/// The engine at `path`: named as `found` names it (else by what it reports), with its version.
async fn engine_at(inner: &Inner, path: PathBuf, found: &[(&'static str, PathBuf)]) -> BrowserEngine {
    let b = &inner.browser;
    let name = discover::name_of(&path, found);
    discover::with_versions(&b.os, vec![(name, path)], &b.versions).await.remove(0)
}

// ───────────────────────────── the organization's policy ─────────────────────────────

/// What a start does about an engine the organization's policy blocked.
#[derive(Debug, PartialEq)]
enum Fallback {
    /// Run TeleFlock's own browser (this program) instead.
    Switch(PathBuf),
    /// Offer to download TeleFlock's own browser.
    Offer,
    /// Nothing is left: its own browser is blocked too, or has no build for this computer.
    Nothing,
}

/// `engine` (a path) refused remote control. TeleFlock's own browser (`own`: its program and
/// whether it is downloaded; `None`: no build here) takes over when it is downloaded, else it is
/// offered; unless it is the engine that refused, or is blocked too (`blocked`: the paths marked on
/// this device).
fn fallback(engine: &str, own: Option<(&Path, bool)>, blocked: &[String]) -> Fallback {
    let Some((program, there)) = own else { return Fallback::Nothing };
    let p = program.to_string_lossy();
    if p == engine || blocked.iter().any(|b| *b == p) {
        Fallback::Nothing
    } else if there {
        Fallback::Switch(program.to_path_buf())
    } else {
        Fallback::Offer
    }
}

/// `engine` refused remote control: it is marked blocked on this device (saved), and what is left
/// is decided.
async fn on_blocked(inner: &Inner, engine: &BrowserEngine) -> Fallback {
    let b = &inner.browser;
    let own = b.own();
    let f = {
        let mut st = b.st.lock().unwrap();
        if !st.config.blocked.contains(&engine.path) {
            st.config.blocked.push(engine.path.clone());
        }
        fallback(&engine.path, own.as_ref().map(|(p, there)| (p.as_path(), *there)), &st.config.blocked)
    };
    log::warn!("browser: the organization's policy blocks remote control of {} ({}); fallback: {f:?}", engine.name, engine.path);
    save_config(inner).await;
    f
}

/// `path` started: a block marked on it is lifted (the policy changed).
async fn unblock(inner: &Inner, path: &str) {
    let lifted = {
        let mut st = inner.browser.st.lock().unwrap();
        let before = st.config.blocked.len();
        st.config.blocked.retain(|p| p != path);
        st.config.blocked.len() != before
    };
    if lifted {
        log::info!("browser: {path} started: the organization's policy no longer blocks it");
        save_config(inner).await;
    }
}

/// TeleFlock's own browser (`own`) started instead of `refused`: it is the chosen engine from now
/// on (later starts go straight to it). Returns the notice the status shows once.
async fn switched(inner: &Inner, refused: &BrowserEngine, own: &BrowserEngine) -> (BrowserBlocked, String) {
    inner.browser.st.lock().unwrap().config.engine_path = Some(own.path.clone());
    save_config(inner).await;
    notice(inner, refused, BrowserFallback::Switched)
}

/// The start failed on the organization's policy; `refused` is the engine it was to run.
fn blocked(inner: &Inner, refused: &BrowserEngine, fallback: BrowserFallback) -> StartError {
    let (blocked, message) = notice(inner, refused, fallback);
    StartError::Blocked { blocked, message }
}

/// What the status says about a block: the engine that refused, what is left, and the message.
fn notice(inner: &Inner, refused: &BrowserEngine, fallback: BrowserFallback) -> (BrowserBlocked, String) {
    let b = &inner.browser;
    let download = (fallback == BrowserFallback::Offer).then(|| b.download());
    let name = &refused.name;
    let message = match fallback {
        BrowserFallback::Switched => format!("{name} is blocked for remote control by your organization; TeleFlock uses its own browser."),
        BrowserFallback::Offer => {
            let size = download.as_ref().and_then(|d| d.size).map_or_else(|| "about 200 MB".to_string(), megabytes);
            format!("{name} is blocked for remote control by your organization. TeleFlock can use its own browser instead (Chrome for Testing, {size}).")
        }
        BrowserFallback::Unavailable => {
            let st = b.st.lock().unwrap();
            let known: Vec<&BrowserEngine> = st.engines.iter().chain(&st.chosen).chain([refused]).collect();
            let mut names: Vec<&str> = Vec::new();
            for e in known.iter().filter(|e| e.path == refused.path || st.config.blocked.contains(&e.path)) {
                if !names.contains(&e.name.as_str()) {
                    names.push(&e.name);
                }
            }
            let every = st.engines.iter().all(|e| st.config.blocked.contains(&e.path));
            let it = "Your IT department can allow it with the RemoteDebuggingAllowed policy";
            if every {
                format!("This computer's policy blocks remote control of every browser TeleFlock can use ({}). {it}.", and_list(&names))
            } else {
                format!("This computer's policy blocks remote control of {}. {it}, or you can choose another browser in Settings → Browser.", and_list(&names))
            }
        }
    };
    let engine = BrowserEngine { blocked: true, ..refused.clone() };
    (BrowserBlocked { engine, fallback, download, at: now_ms() }, message)
}

/// `192 MB` (binary megabytes, as the UI shows sizes).
fn megabytes(bytes: u64) -> String {
    format!("{} MB", (bytes as f64 / 1_048_576.0).round() as u64)
}

/// `A`, `A and B`, `A, B and C`.
fn and_list(names: &[&str]) -> String {
    match names {
        [] => String::new(),
        [one] => one.to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// Writes `config.json` as the config is now (one write at a time); a failure is logged.
async fn save_config(inner: &Inner) {
    let b = &inner.browser;
    let _w = b.saving.lock().await;
    let c = b.st.lock().unwrap().config.clone();
    if let Err(e) = write_json(&b.dir.join("config.json"), &c).await {
        log::warn!("browser: {}", e.message);
    }
}

/// Why a start failed.
#[derive(Debug)]
enum StartError {
    /// The organization's policy blocks remote control of the engine (and of TeleFlock's own
    /// browser when it was tried): what is left, and the message.
    Blocked { blocked: BrowserBlocked, message: String },
    /// Anything else: what happened.
    Failed(String),
}

impl StartError {
    /// What the status says (`BrowserStatus::message`).
    fn message(&self) -> String {
        match self {
            StartError::Blocked { message, .. } => message.clone(),
            StartError::Failed(e) => format!("The browser did not start: {e}"),
        }
    }

    /// What a call that needs the browser answers: `browser_blocked` while TeleFlock's own browser
    /// is on offer (`browser.installEngine {start: true}`), else `browser_failed`.
    fn api_error(&self) -> ApiError {
        match self {
            StartError::Blocked { blocked, message } if blocked.fallback == BrowserFallback::Offer => ApiError::new("browser_blocked", message.clone()),
            _ => ApiError::new("browser_failed", self.message()),
        }
    }
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
        Ok(Ok(Err(e))) => Err(e.api_error()),
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
    let download = b.download();
    let st = b.st.lock().unwrap();
    let engines = st.engines.iter().map(|e| marked(e.clone(), &st.config.blocked)).collect();
    BrowserConfig { engine_path: st.config.engine_path.clone(), headed: st.config.headed, cap: st.config.cap, engines, download }
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
    let headed = p.headed.unwrap_or(false);
    {
        let b = &inner.browser;
        let _ops = b.ops.lock().await;
        let _w = b.saving.lock().await;
        // The blocked marks are the app core's: they stay.
        let blocked = b.st.lock().unwrap().config.blocked.clone();
        let c = Config { engine_path, headed, cap, blocked };
        write_json(&b.dir.join("config.json"), &c).await?;
        let mut st = b.st.lock().unwrap();
        st.config.engine_path = c.engine_path;
        st.config.headed = c.headed;
        st.config.cap = c.cap;
    }
    admit_waiting(inner);
    Ok(config(inner).await)
}

/// `browser.installEngine`: downloads TeleFlock's own browser (one download at a time; asking
/// again while one runs only adds `start`). `start`: once it is there, it becomes the chosen
/// engine and the browser starts with it.
#[cfg(not(target_os = "android"))]
fn install_engine(inner: &Arc<Inner>, start: bool) -> Result<(), ApiError> {
    if !install::available() {
        return Err(ApiError::new("unsupported", "Chrome for Testing has no build for this computer"));
    }
    let cancel = {
        let mut st = inner.browser.st.lock().unwrap();
        if let Some(d) = st.downloading.as_mut() {
            d.start |= start;
            return Ok(());
        }
        let cancel = Arc::new(AtomicBool::new(false));
        st.downloading = Some(Downloading { cancel: cancel.clone(), start });
        st.install = Some(BrowserInstall { version: install::VERSION.into(), progress: None, error: None });
        cancel
    };
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
        let result = install::install(&dir, &cancel, progress).await;
        let start = {
            let mut st = inner.browser.st.lock().unwrap();
            st.install = None;
            st.downloading.take().is_some_and(|d| d.start)
        };
        let canceled = cancel.load(Ordering::Acquire);
        match result {
            Ok(exe) => {
                log::info!("browser: Chrome for Testing {} installed at {}", install::VERSION, exe.display());
                refresh_engines(&inner).await;
                if start && !canceled {
                    use_own(&inner, exe).await;
                }
            }
            Err(_) if canceled => {
                log::info!("browser: the Chrome for Testing download was canceled");
                emit(&inner);
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
fn install_engine(_: &Arc<Inner>, _: bool) -> Result<(), ApiError> {
    Err(unsupported())
}

/// "Use TeleFlock's browser": its own browser (`exe`) becomes the chosen engine and the browser
/// starts with it (when it is not running).
async fn use_own(inner: &Arc<Inner>, exe: PathBuf) {
    inner.browser.st.lock().unwrap().config.engine_path = Some(exe.to_string_lossy().into_owned());
    save_config(inner).await;
    let _ops = inner.browser.ops.lock().await;
    if let Err(e) = start_browser(inner, None).await {
        log::info!("browser: TeleFlock's own browser did not start: {}", e.message);
    }
}

/// `browser.cancelInstall`: the download stops at its next piece; nothing of it is kept.
fn cancel_install(inner: &Inner) {
    if let Some(d) = &inner.browser.st.lock().unwrap().downloading {
        d.cancel.store(true, Ordering::Release);
    }
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
        AppMethod::BrowserInstallEngine(p) => install_engine(inner, p.start)?,
        AppMethod::BrowserCancelInstall(_) => cancel_install(inner),
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
