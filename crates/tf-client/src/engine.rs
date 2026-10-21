//! The app core: profiles, settings, per-host connections, app methods, forwarding of host
//! methods, notification policy, badge and keep-alive.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tf_proto::{
    Answer, ApiError, AppCapabilities, AppEvent, AppInfo, AppMethod, ConnPhase, ConnStatus, Delivery, Empty,
    HostKind, HostMethod, HostProfile, HostStatusEntry, HostsListResult, NeedsKind, Notification, NotifyKind,
    Settings, TunnelListResult, WslDistrosResult,
};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::conn::{self, ConnCmd, HostRt};
use crate::deploy::{Artifacts, HOSTD_VERSION};
use crate::link::timeout_for;
use crate::platform::{BadgeState, NotifyStyle, Platform};
use crate::settings::{default_settings, in_quiet_hours, is_muted, local_minutes_now, validate, wants};
use crate::state::{CacheRecord, counts};
use crate::tunnel::Tunnels;
use crate::util::{invalid, now_ms, rand_id, read_json, to_value, write_json};

/// Engine configuration supplied by the embedder.
#[derive(Debug, Clone)]
pub struct EngineConfig {
    /// `hosts.json`, `settings.json`, `known_hosts`, `cache/<hostId>.json`.
    pub data_dir: PathBuf,
    /// `windows` | `android` | `linux` | `macos` | `web`.
    pub platform_name: String,
    /// `teleflock-desktop` | `teleflock-android` | `teleflock-devserver`.
    pub client_app: String,
    /// App version (sent to tf-hostd in `hello`).
    pub version: String,
    /// Dev: a tf-hostd binary used for every host, or a dist dir `<triple>/tf-hostd[.exe]`.
    pub hostd_bins_override: Option<PathBuf>,
}

const EVENT_CAPACITY: usize = 8192;
const CACHE_FLUSH_EVERY: Duration = Duration::from_secs(5);

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct HostsFile {
    profiles: Vec<HostProfile>,
}

pub(crate) struct Inner {
    pub cfg: EngineConfig,
    platform: Arc<dyn Platform>,
    tx: broadcast::Sender<AppEvent>,
    /// Serializes stateful event emission with `subscribe_with_replay`.
    pub emit_lock: Mutex<()>,
    artifacts: Artifacts,
    profiles: Mutex<Vec<HostProfile>>,
    settings: Mutex<Settings>,
    hosts: Mutex<HashMap<String, Arc<HostRt>>>,
    tasks: Mutex<HashMap<String, JoinHandle<()>>>,
    pub tunnels: Tunnels,
    badge: Mutex<Option<BadgeState>>,
    keep_alive: Mutex<Option<bool>>,
    /// Serializes `hosts.json` / `settings.json` writes.
    io: tokio::sync::Mutex<()>,
    /// Bumped by [`Engine::page_closed`]; opens that complete under an older epoch are released.
    page_epoch: std::sync::atomic::AtomicU64,
    /// For work started from sync entry points the embedder may call off the runtime
    /// (`resume`, `page_closed` from Tauri window/page callbacks).
    runtime: tokio::runtime::Handle,
}

/// Handle to the app core. Cheap to clone.
#[derive(Clone)]
pub struct Engine {
    inner: Arc<Inner>,
}

fn not_found_host(id: &str) -> ApiError {
    ApiError::new("not_found", format!("unknown host `{id}`"))
}

fn safe_file_name(id: &str) -> String {
    id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

fn valid_ident(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

impl Inner {
    pub fn send(&self, ev: AppEvent) {
        let _ = self.tx.send(ev);
    }

    pub fn data_dir(&self) -> &Path {
        &self.cfg.data_dir
    }

    pub fn artifacts(&self) -> &Artifacts {
        &self.artifacts
    }

    pub fn profile(&self, id: &str) -> Option<HostProfile> {
        self.profiles.lock().unwrap().iter().find(|p| p.id == id).cloned()
    }

    fn host(&self, id: &str) -> Option<Arc<HostRt>> {
        self.hosts.lock().unwrap().get(id).cloned()
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    pub fn device_name(&self) -> String {
        let s = self.settings.lock().unwrap().device_name.clone();
        if s.trim().is_empty() { self.platform.device_name() } else { s }
    }

    /// Mutates a host's status and emits `HostStatus` when it changed.
    pub fn update_status(&self, rt: &HostRt, f: impl FnOnce(&mut ConnStatus)) {
        let _g = self.emit_lock.lock().unwrap();
        let mut v = rt.view.lock().unwrap();
        let before = v.status.clone();
        f(&mut v.status);
        if v.status.phase != before.phase {
            v.status.since = now_ms();
        }
        if v.status != before {
            self.send(AppEvent::HostStatus { host_id: rt.id.clone(), status: v.status.clone() });
        }
    }

    pub fn set_phase(&self, rt: &HostRt, phase: ConnPhase, message: Option<String>) {
        self.update_status(rt, |s| {
            s.phase = phase;
            s.message = message;
            if !matches!(phase, ConnPhase::Reconnecting | ConnPhase::Error) {
                s.error = None;
                s.next_retry_at = None;
            }
            if phase != ConnPhase::AuthRequired {
                s.auth_url = None;
            }
            if phase != ConnPhase::HostKey {
                s.host_key = None;
            }
        });
    }

    /// Recomputes the needs/running totals over live hosts and informs the platform.
    pub fn refresh_badge(&self) {
        let hosts: Vec<Arc<HostRt>> = self.hosts.lock().unwrap().values().cloned().collect();
        let mut b = BadgeState::default();
        for rt in hosts {
            let v = rt.view.lock().unwrap();
            if let (true, Some((_, s))) = (v.live, v.state.as_ref()) {
                let (n, r) = counts(s);
                b.needs += n;
                b.running += r;
            }
        }
        let changed = {
            let mut last = self.badge.lock().unwrap();
            let changed = *last != Some(b);
            *last = Some(b);
            changed
        };
        if changed {
            self.platform.set_badge(b);
        }
    }

    pub fn refresh_keep_alive(&self) {
        let on = self.settings.lock().unwrap().keep_alive
            && self.hosts.lock().unwrap().values().any(|rt| rt.wanted.load(Ordering::SeqCst));
        let changed = {
            let mut last = self.keep_alive.lock().unwrap();
            let changed = *last != Some(on);
            *last = Some(on);
            changed
        };
        if changed {
            self.platform.set_keep_alive(on);
        }
    }

    fn cache_path(&self, host_id: &str) -> PathBuf {
        self.cfg.data_dir.join("cache").join(format!("{}.json", safe_file_name(host_id)))
    }

    /// Writes the host's state to the cache when it changed since the last write.
    pub async fn flush_cache(&self, rt: &HostRt) {
        let rec = {
            let mut v = rt.view.lock().unwrap();
            if !v.dirty {
                return;
            }
            v.dirty = false;
            v.state.as_ref().map(|(rev, state)| CacheRecord { rev: *rev, saved_at: now_ms(), state: state.clone() })
        };
        if let Some(rec) = rec
            && let Err(e) = write_json(&self.cache_path(&rt.id), &rec).await
        {
            log::warn!("cache {}: {e}", rt.id);
        }
    }

    /// Notification policy: always forward to the UI; reach the OS per settings, per-agent
    /// mute and quiet hours.
    pub fn on_notify(&self, rt: &HostRt, n: Notification) {
        self.send(AppEvent::Notify { host_id: rt.id.clone(), notification: n.clone() });
        rt.remember_notification(n.clone());
        if !self.platform.supports_notifications() {
            return;
        }
        let settings = self.settings();
        if !wants(&settings, n.kind) || is_muted(&settings, &rt.id, &n.agent_id) {
            return;
        }
        let quiet = in_quiet_hours(&settings, local_minutes_now());
        let style = NotifyStyle { sound: settings.notify_sound && !quiet, silent: quiet, reply: reply_allowed(rt, &n) };
        let profile = self.profile(&rt.id);
        self.platform.notify(profile.as_ref(), &n, style);
    }

    fn capabilities(&self) -> AppCapabilities {
        let p = self.cfg.platform_name.as_str();
        AppCapabilities {
            local: matches!(p, "windows" | "linux" | "macos"),
            wsl: p == "windows",
            tunnels: true,
            notifications: self.platform.supports_notifications(),
            keep_alive: p == "android",
        }
    }

    fn emit_profiles(&self) {
        let _g = self.emit_lock.lock().unwrap();
        let profiles = self.profiles.lock().unwrap().clone();
        self.send(AppEvent::Profiles { profiles });
    }

    fn emit_tunnels(&self) {
        let _g = self.emit_lock.lock().unwrap();
        self.send(AppEvent::Tunnels { tunnels: self.tunnels.list() });
    }

    async fn save_profiles(&self) -> Result<(), ApiError> {
        let _io = self.io.lock().await;
        let file = HostsFile { profiles: self.profiles.lock().unwrap().clone() };
        write_json(&self.cfg.data_dir.join("hosts.json"), &file).await
    }
}

/// Free text can answer this notification's pending request (else replies become prompts).
fn reply_allowed(rt: &HostRt, n: &Notification) -> bool {
    match n.kind {
        NotifyKind::Finished | NotifyKind::Error | NotifyKind::Quiet => true,
        NotifyKind::Info => false,
        NotifyKind::Needs => {
            let v = rt.view.lock().unwrap();
            let needs = v
                .state
                .as_ref()
                .and_then(|(_, s)| s.agents.iter().find(|a| a.id == n.agent_id))
                .and_then(|a| a.needs.as_ref());
            match needs {
                Some(needs) => needs.answerable && (needs.allow_other || needs.kind == NeedsKind::Input),
                None => false,
            }
        }
    }
}

/// Free-text answer for the pending request, if the request is still the one notified.
fn pending_text_answer(rt: &HostRt, agent_id: &str, request_id: &str) -> bool {
    let v = rt.view.lock().unwrap();
    v.state
        .as_ref()
        .and_then(|(_, s)| s.agents.iter().find(|a| a.id == agent_id))
        .and_then(|a| a.needs.as_ref())
        .is_some_and(|n| {
            n.request_id.as_deref() == Some(request_id) && n.answerable && (n.allow_other || n.kind == NeedsKind::Input)
        })
}

fn validate_profile(mut p: HostProfile, platform: &str) -> Result<HostProfile, ApiError> {
    p.id = p.id.trim().to_string();
    if p.id.is_empty() {
        p.id = rand_id("h_");
    } else if !valid_ident(&p.id, 64) {
        return Err(invalid("id may only contain letters, digits, `-`, `_` and `.`"));
    }
    p.name = p.name.trim().to_string();
    if p.name.is_empty() {
        return Err(invalid("name is required"));
    }
    p.herdr_session = p.herdr_session.trim().to_string();
    if p.herdr_session.is_empty() {
        p.herdr_session = "default".into();
    }
    if !valid_ident(&p.herdr_session, 64) {
        return Err(invalid("herdrSession may only contain letters, digits, `-`, `_` and `.`"));
    }
    let trim = |o: Option<String>| o.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    p.address = trim(p.address);
    p.user = trim(p.user);
    p.distro = trim(p.distro);
    p.color = trim(p.color);
    if p.port == Some(0) {
        return Err(invalid("port must be 1-65535"));
    }
    if p.relay_port.is_some_and(|r| r < 1024) {
        return Err(invalid("relayPort must be 1024-65535"));
    }
    match p.kind {
        HostKind::TailscaleSsh => {
            if p.address.is_none() {
                return Err(invalid("address is required for Tailscale SSH hosts"));
            }
        }
        HostKind::Local => {
            if !matches!(platform, "windows" | "linux" | "macos") {
                return Err(ApiError::new("unsupported", "local hosts are only available in the desktop app"));
            }
        }
        HostKind::Wsl => {
            if platform != "windows" {
                return Err(ApiError::new("unsupported", "WSL hosts are only available in the Windows app"));
            }
            if p.distro.is_none() {
                return Err(invalid("distro is required for WSL hosts"));
            }
        }
        HostKind::Demo => {}
    }
    Ok(p)
}

/// Connection-relevant fields: a change forces a reconnect.
fn conn_key(p: &HostProfile) -> impl PartialEq + use<> {
    (p.kind, p.address.clone(), p.user.clone(), p.port, p.distro.clone(), p.herdr_session.clone(), p.relay_port)
}

impl Engine {
    /// Starts the engine: loads profiles, settings and cached host states, emits them, and
    /// connects auto-connect hosts. Must run inside a tokio runtime.
    pub async fn start(cfg: EngineConfig, platform: Arc<dyn Platform>) -> (Engine, broadcast::Receiver<AppEvent>) {
        let (tx, rx) = broadcast::channel(EVENT_CAPACITY);
        if let Err(e) = tokio::fs::create_dir_all(cfg.data_dir.join("cache")).await {
            log::error!("data dir {}: {e}", cfg.data_dir.display());
        }
        let mut settings = match read_json::<Settings>(&cfg.data_dir.join("settings.json")).await {
            Ok(Some(s)) => s,
            Ok(None) => default_settings(String::new()),
            Err(e) => {
                log::error!("{e}; using default settings");
                default_settings(String::new())
            }
        };
        if settings.device_name.trim().is_empty() {
            settings.device_name = platform.device_name();
        }
        let profiles = match read_json::<HostsFile>(&cfg.data_dir.join("hosts.json")).await {
            Ok(f) => f.unwrap_or_default().profiles,
            Err(e) => {
                log::error!("{e}; starting with no hosts");
                Vec::new()
            }
        };
        let artifacts = Artifacts { hostd_override: cfg.hostd_bins_override.clone() };
        let inner = Arc::new(Inner {
            cfg,
            platform,
            tx,
            emit_lock: Mutex::new(()),
            artifacts,
            profiles: Mutex::new(profiles.clone()),
            settings: Mutex::new(settings.clone()),
            hosts: Mutex::new(HashMap::new()),
            tasks: Mutex::new(HashMap::new()),
            tunnels: Tunnels::default(),
            badge: Mutex::new(None),
            keep_alive: Mutex::new(None),
            io: tokio::sync::Mutex::new(()),
            page_epoch: std::sync::atomic::AtomicU64::new(0),
            runtime: tokio::runtime::Handle::current(),
        });
        let engine = Engine { inner: inner.clone() };

        for p in &profiles {
            let cached = match read_json::<CacheRecord>(&inner.cache_path(&p.id)).await {
                Ok(c) => c.map(|c| (c.rev, c.state)),
                Err(e) => {
                    log::warn!("{e}");
                    None
                }
            };
            engine.spawn_host(&p.id, cached);
        }
        // Initial events (buffered in `rx` until the embedder reads them).
        for ev in engine.replay_locked() {
            inner.send(ev);
        }
        for p in &profiles {
            if p.auto_connect && p.kind != HostKind::Demo {
                engine.send_cmd(&p.id, ConnCmd::Connect);
            }
        }
        inner.refresh_keep_alive();

        // Periodic cache flush.
        let weak = Arc::downgrade(&inner);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(CACHE_FLUSH_EVERY);
            loop {
                tick.tick().await;
                let Some(inner) = weak.upgrade() else { break };
                let hosts: Vec<Arc<HostRt>> = inner.hosts.lock().unwrap().values().cloned().collect();
                for rt in hosts {
                    inner.flush_cache(&rt).await;
                }
            }
        });
        (engine, rx)
    }

    fn spawn_host(&self, id: &str, cached: Option<(u64, tf_proto::HostState)>) -> Arc<HostRt> {
        let (rt, rx) = HostRt::new(id.to_string(), cached);
        let task = tokio::spawn(conn::run(Arc::downgrade(&self.inner), rt.clone(), rx));
        self.inner.hosts.lock().unwrap().insert(id.to_string(), rt.clone());
        self.inner.tasks.lock().unwrap().insert(id.to_string(), task);
        rt
    }

    fn send_cmd(&self, id: &str, cmd: ConnCmd) {
        if let Some(rt) = self.inner.host(id) {
            if matches!(cmd, ConnCmd::Connect | ConnCmd::Reconnect) {
                rt.wanted.store(true, Ordering::SeqCst);
            }
            let _ = rt.cmd.send(cmd);
        }
    }

    /// Current state as events. Caller holds `emit_lock`… or not (start-up only).
    fn replay_locked(&self) -> Vec<AppEvent> {
        let i = &self.inner;
        let profiles = i.profiles.lock().unwrap().clone();
        let mut out = vec![
            AppEvent::Profiles { profiles: profiles.clone() },
            AppEvent::Settings { settings: i.settings() },
            AppEvent::Tunnels { tunnels: i.tunnels.list() },
        ];
        for p in profiles {
            let Some(rt) = i.host(&p.id) else { continue };
            let v = rt.view.lock().unwrap();
            out.push(AppEvent::HostStatus { host_id: p.id.clone(), status: v.status.clone() });
            if let Some((rev, state)) = &v.state {
                out.push(AppEvent::HostSnapshot { host_id: p.id.clone(), rev: *rev, state: state.clone() });
            }
        }
        out
    }

    /// Subscribes to events. Prefer [`Engine::subscribe_with_replay`] for new UI subscribers.
    pub fn subscribe(&self) -> broadcast::Receiver<AppEvent> {
        self.inner.tx.subscribe()
    }

    /// Atomically: the current state as events (profiles, settings, tunnels, and per host its
    /// status + latest snapshot, cached or live) plus a receiver for everything after it.
    /// On `RecvError::Lagged`, call again and resend the replay.
    pub fn subscribe_with_replay(&self) -> (Vec<AppEvent>, broadcast::Receiver<AppEvent>) {
        let _g = self.inner.emit_lock.lock().unwrap();
        let rx = self.inner.tx.subscribe();
        (self.replay_locked(), rx)
    }

    /// Injects an event into the stream (e.g. `OpenAgent` from a deep link, `AnswerNext`).
    pub fn emit(&self, ev: AppEvent) {
        self.inner.send(ev);
    }

    /// Terminal keystrokes (fast path; dropped when the host is offline).
    pub fn term_input(&self, host_id: &str, term_id: &str, data: String) {
        if let Some(link) = self.inner.host(host_id).and_then(|rt| rt.link()) {
            let _ = link.term_input(term_id, data);
        }
    }

    /// Foreground / network change: verify live links now and retry waiting hosts.
    pub fn resume(&self) {
        let hosts: Vec<Arc<HostRt>> = self.inner.hosts.lock().unwrap().values().cloned().collect();
        for rt in hosts {
            if !rt.wanted.load(Ordering::SeqCst) {
                continue;
            }
            match rt.link() {
                Some(link) => {
                    self.inner.runtime.spawn(async move { link.check(Duration::from_secs(5)).await });
                }
                None => {
                    let _ = rt.cmd.send(ConnCmd::Connect);
                }
            }
        }
    }

    /// The (single) UI that opened terminals and sessions is gone — webview reload or navigation
    /// in the Tauri shell. Closes every open terminal (releasing its control lease) and
    /// unsubscribes every session on every host; opens still in flight are released when they
    /// complete. Multi-client embedders (the devserver) track ownership per client instead.
    pub fn page_closed(&self) {
        self.inner.page_epoch.fetch_add(1, Ordering::SeqCst);
        let hosts: Vec<Arc<HostRt>> = self.inner.hosts.lock().unwrap().values().cloned().collect();
        for rt in hosts {
            let (terms, sessions): (Vec<String>, Vec<String>) = {
                let mut v = rt.view.lock().unwrap();
                (v.terms.drain().collect(), v.sessions.drain().map(|(k, _)| k).collect())
            };
            let Some(link) = rt.link() else { continue };
            if terms.is_empty() && sessions.is_empty() {
                continue;
            }
            log::info!("host {}: page closed; releasing {} terminal(s), {} session(s)", rt.id, terms.len(), sessions.len());
            self.inner.runtime.spawn(async move {
                let calls = terms
                    .into_iter()
                    .map(|t| ("term.close", serde_json::json!({ "termId": t })))
                    .chain(sessions.into_iter().map(|a| ("session.close", serde_json::json!({ "agentId": a }))));
                for (method, params) in calls {
                    if let Err(e) = link.request(method, params, timeout_for(method)).await {
                        log::debug!("{method} on page close: {}", e.message);
                    }
                }
            });
        }
    }

    /// Stops all host connections and flushes caches.
    pub async fn shutdown(&self) {
        let tasks: Vec<JoinHandle<()>> = {
            for rt in self.inner.hosts.lock().unwrap().values() {
                let _ = rt.cmd.send(ConnCmd::Shutdown);
            }
            self.inner.tasks.lock().unwrap().drain().map(|(_, t)| t).collect()
        };
        for t in tasks {
            let _ = tokio::time::timeout(Duration::from_secs(5), t).await;
        }
    }

    /// Calls an app method (`host_id` ignored) or forwards a host method to `host_id`.
    pub async fn call(&self, host_id: Option<&str>, method: &str, params: Value) -> Result<Value, ApiError> {
        if AppMethod::NAMES.contains(&method) {
            return self.app_call(AppMethod::parse(method, params)?).await;
        }
        if !HostMethod::NAMES.contains(&method) {
            return Err(ApiError::new("unknown_method", format!("unknown method `{method}`")));
        }
        let host_id = host_id.ok_or_else(|| invalid(format!("{method} requires a hostId")))?;
        self.host_call(host_id, method, params).await
    }

    async fn host_call(&self, host_id: &str, method: &str, params: Value) -> Result<Value, ApiError> {
        let rt = self.inner.host(host_id).ok_or_else(|| not_found_host(host_id))?;
        let req = HostMethod::parse(method, params.clone())?;
        let link = match rt.link() {
            Some(l) => l,
            None => {
                let st = rt.status();
                let near = matches!(st.phase, ConnPhase::Deploying | ConnPhase::Starting);
                if near && rt.wanted.load(Ordering::SeqCst) && rt.wait_online(Duration::from_secs(15)).await {
                    rt.link().ok_or_else(|| self.offline_error(host_id, &rt))?
                } else {
                    return Err(self.offline_error(host_id, &rt));
                }
            }
        };
        let epoch = self.inner.page_epoch.load(Ordering::SeqCst);
        let result = link.request(method, params, timeout_for(method)).await?;
        // Record what the page opened (checked under the view lock, like `page_closed`'s drain);
        // if the page went away while the request was in flight, release it at once.
        let stale = || self.inner.page_epoch.load(Ordering::SeqCst) != epoch;
        let release = match req {
            HostMethod::SessionOpen(p) => {
                let params = to_value(&p)?;
                let mut v = rt.view.lock().unwrap();
                if stale() {
                    Some(("session.close", serde_json::json!({ "agentId": p.agent_id })))
                } else {
                    v.sessions.insert(p.agent_id, params);
                    None
                }
            }
            HostMethod::SessionClose(p) => {
                rt.view.lock().unwrap().sessions.remove(&p.agent_id);
                None
            }
            HostMethod::TermOpen(_) => match result.get("termId").and_then(Value::as_str) {
                Some(id) => {
                    let mut v = rt.view.lock().unwrap();
                    if stale() {
                        Some(("term.close", serde_json::json!({ "termId": id })))
                    } else {
                        v.terms.insert(id.to_string());
                        None
                    }
                }
                None => None,
            },
            HostMethod::TermClose(p) => {
                rt.view.lock().unwrap().terms.remove(&p.term_id);
                None
            }
            _ => None,
        };
        if let Some((method, params)) = release {
            tokio::spawn(async move {
                let _ = link.request(method, params, timeout_for(method)).await;
            });
        }
        Ok(result)
    }

    fn offline_error(&self, host_id: &str, rt: &HostRt) -> ApiError {
        let name = self.inner.profile(host_id).map(|p| p.name).unwrap_or_else(|| host_id.to_string());
        let st = rt.status();
        let phase = serde_json::to_value(st.phase).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
        ApiError::new("not_connected", format!("{name} is not connected ({phase})"))
            .with_hint("Connect the host and try again")
            .retryable()
    }

    /// Routes an OS notification interaction: an action with an answer → `agent.answer`;
    /// `reply` text → free-text answer when the request accepts it, else `agent.prompt`;
    /// anything else → `AppEvent::OpenAgent`.
    pub async fn notification_action(
        &self,
        host_id: &str,
        notification_id: &str,
        action_id: Option<&str>,
        reply: Option<String>,
    ) -> Result<(), ApiError> {
        let rt = self.inner.host(host_id).ok_or_else(|| not_found_host(host_id))?;
        let n = rt
            .find_notification(notification_id)
            .ok_or_else(|| ApiError::new("not_found", format!("unknown notification `{notification_id}`")))?;
        let open = || self.emit(AppEvent::OpenAgent { host_id: host_id.to_string(), agent_id: n.agent_id.clone() });

        let call = match (reply, action_id) {
            (Some(text), _) if !text.trim().is_empty() => {
                match n.request_id.as_deref().filter(|r| pending_text_answer(&rt, &n.agent_id, r)) {
                    Some(req) => (
                        "agent.answer",
                        serde_json::json!({
                            "agentId": n.agent_id, "requestId": req,
                            "answer": Answer { choices: vec![], text: Some(text), cancel: false, chat: false },
                        }),
                    ),
                    None => (
                        "agent.prompt",
                        serde_json::json!({ "agentId": n.agent_id, "text": text, "images": [], "delivery": Delivery::Auto }),
                    ),
                }
            }
            (_, Some(aid)) => {
                let action = n
                    .actions
                    .iter()
                    .find(|a| a.id == aid)
                    .ok_or_else(|| ApiError::new("not_found", format!("unknown action `{aid}`")))?;
                match (&action.answer, &n.request_id) {
                    (Some(answer), Some(req)) => (
                        "agent.answer",
                        serde_json::json!({ "agentId": n.agent_id, "requestId": req, "answer": answer }),
                    ),
                    _ => {
                        open();
                        return Ok(());
                    }
                }
            }
            _ => {
                open();
                return Ok(());
            }
        };
        if rt.link().is_none() {
            self.send_cmd(host_id, ConnCmd::Connect);
            if !rt.wait_online(Duration::from_secs(30)).await {
                return Err(self.offline_error(host_id, &rt));
            }
        }
        self.host_call(host_id, call.0, call.1).await.map(|_| ())
    }

    async fn app_call(&self, m: AppMethod) -> Result<Value, ApiError> {
        let i = &self.inner;
        match m {
            AppMethod::AppInfoReq(_) => to_value(&AppInfo {
                version: i.cfg.version.clone(),
                platform: i.cfg.platform_name.clone(),
                hostd_version: HOSTD_VERSION.to_string(),
                data_dir: i.cfg.data_dir.to_string_lossy().into_owned(),
                capabilities: i.capabilities(),
            }),
            AppMethod::AppOpenExternal(p) => {
                let url = p.url.trim();
                if !(url.starts_with("https://") || url.starts_with("http://")) {
                    return Err(invalid("only http(s) URLs can be opened"));
                }
                i.platform.open_external(url)?;
                to_value(&Empty {})
            }
            AppMethod::AppNotifyTest(_) => {
                if !i.platform.supports_notifications() {
                    return Err(ApiError::new("unsupported", "this app build cannot show OS notifications"));
                }
                let s = i.settings();
                let n = Notification {
                    id: rand_id("n_"),
                    at: now_ms(),
                    kind: NotifyKind::Info,
                    agent_id: String::new(),
                    title: "TeleFlock".into(),
                    body: "Notifications are working.".into(),
                    request_id: None,
                    actions: vec![],
                };
                i.platform.notify(None, &n, NotifyStyle { sound: s.notify_sound, silent: false, reply: false });
                to_value(&Empty {})
            }
            AppMethod::HostsList(_) => {
                let profiles = i.profiles.lock().unwrap().clone();
                let statuses = profiles
                    .iter()
                    .filter_map(|p| i.host(&p.id).map(|rt| HostStatusEntry { host_id: p.id.clone(), status: rt.status() }))
                    .collect();
                to_value(&HostsListResult { profiles, statuses })
            }
            AppMethod::HostsSave(p) => {
                let p = validate_profile(p, &i.cfg.platform_name)?;
                let previous = {
                    let mut profiles = i.profiles.lock().unwrap();
                    match profiles.iter_mut().find(|x| x.id == p.id) {
                        Some(x) => Some(std::mem::replace(x, p.clone())),
                        None => {
                            profiles.push(p.clone());
                            None
                        }
                    }
                };
                if let Err(e) = i.save_profiles().await {
                    // Roll back the in-memory change.
                    let mut profiles = i.profiles.lock().unwrap();
                    match &previous {
                        Some(old) => {
                            if let Some(x) = profiles.iter_mut().find(|x| x.id == p.id) {
                                *x = old.clone();
                            }
                        }
                        None => profiles.retain(|x| x.id != p.id),
                    }
                    return Err(e);
                }
                i.emit_profiles();
                match previous {
                    None => {
                        let rt = self.spawn_host(&p.id, None);
                        {
                            let _g = i.emit_lock.lock().unwrap();
                            i.send(AppEvent::HostStatus { host_id: p.id.clone(), status: rt.status() });
                        }
                        if p.auto_connect && p.kind != HostKind::Demo {
                            self.send_cmd(&p.id, ConnCmd::Connect);
                            i.refresh_keep_alive();
                        }
                    }
                    Some(old) => {
                        let rt = i.host(&p.id);
                        if conn_key(&old) != conn_key(&p) && rt.is_some_and(|rt| rt.wanted.load(Ordering::SeqCst)) {
                            if p.kind == HostKind::Demo {
                                self.send_cmd(&p.id, ConnCmd::Disconnect);
                            } else {
                                self.send_cmd(&p.id, ConnCmd::Reconnect);
                            }
                        }
                    }
                }
                to_value(&p)
            }
            AppMethod::HostsRemove(r) => {
                let existed = {
                    let mut profiles = i.profiles.lock().unwrap();
                    let n = profiles.len();
                    profiles.retain(|p| p.id != r.host_id);
                    profiles.len() != n
                };
                if !existed {
                    return Err(not_found_host(&r.host_id));
                }
                i.save_profiles().await?;
                let rt = i.hosts.lock().unwrap().remove(&r.host_id);
                let task = i.tasks.lock().unwrap().remove(&r.host_id);
                if let Some(rt) = rt {
                    let _ = rt.cmd.send(ConnCmd::Shutdown);
                }
                if let Some(t) = task {
                    let _ = tokio::time::timeout(Duration::from_secs(5), t).await;
                }
                let _ = tokio::fs::remove_file(i.cache_path(&r.host_id)).await;
                if i.tunnels.close_host(&r.host_id) {
                    i.emit_tunnels();
                }
                i.emit_profiles();
                i.refresh_badge();
                i.refresh_keep_alive();
                to_value(&Empty {})
            }
            AppMethod::HostsConnect(r) => {
                let p = i.profile(&r.host_id).ok_or_else(|| not_found_host(&r.host_id))?;
                if p.kind == HostKind::Demo {
                    return Err(ApiError::new("unsupported", "demo hosts are simulated by the frontend"));
                }
                self.send_cmd(&r.host_id, ConnCmd::Connect);
                i.refresh_keep_alive();
                to_value(&Empty {})
            }
            AppMethod::HostsDisconnect(r) => {
                let rt = i.host(&r.host_id).ok_or_else(|| not_found_host(&r.host_id))?;
                let _ = rt.cmd.send(ConnCmd::Disconnect);
                if i.tunnels.close_host(&r.host_id) {
                    i.emit_tunnels();
                }
                to_value(&Empty {})
            }
            AppMethod::HostsTrustKey(r) => {
                let rt = i.host(&r.host_id).ok_or_else(|| not_found_host(&r.host_id))?;
                rt.approve_host_key(&r.fingerprint)?;
                self.send_cmd(&r.host_id, ConnCmd::Connect);
                i.refresh_keep_alive();
                to_value(&Empty {})
            }
            AppMethod::HostsTest(p) => {
                let p = validate_profile(p, &i.cfg.platform_name)?;
                to_value(&crate::diag::run(i, p).await)
            }
            AppMethod::WslDistros(_) => {
                let distros = tf_transport::list_distros().await.map_err(ApiError::from)?;
                to_value(&WslDistrosResult { distros })
            }
            AppMethod::SettingsGet(_) => to_value(&i.settings()),
            AppMethod::SettingsSet(s) => {
                let mut s = validate(s)?;
                if s.device_name.is_empty() {
                    s.device_name = i.platform.device_name();
                }
                {
                    let _io = i.io.lock().await;
                    write_json(&i.cfg.data_dir.join("settings.json"), &s).await?;
                }
                {
                    let _g = i.emit_lock.lock().unwrap();
                    *i.settings.lock().unwrap() = s.clone();
                    i.send(AppEvent::Settings { settings: s.clone() });
                }
                i.refresh_keep_alive();
                to_value(&s)
            }
            AppMethod::TunnelOpen(p) => {
                let rt = i.host(&p.host_id).ok_or_else(|| not_found_host(&p.host_id))?;
                let info = i.tunnels.open(&rt, p).await?;
                i.emit_tunnels();
                to_value(&info)
            }
            AppMethod::TunnelClose(r) => {
                if !i.tunnels.close(&r.tunnel_id) {
                    return Err(ApiError::new("not_found", format!("unknown tunnel `{}`", r.tunnel_id)));
                }
                i.emit_tunnels();
                to_value(&Empty {})
            }
            AppMethod::TunnelList(_) => to_value(&TunnelListResult { tunnels: i.tunnels.list() }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::fixtures::*;

    #[derive(Default)]
    pub(crate) struct TestPlatform {
        pub notified: Mutex<Vec<(Option<String>, Notification, NotifyStyle)>>,
        pub badges: Mutex<Vec<BadgeState>>,
        pub keep_alive: Mutex<Vec<bool>>,
    }
    impl Platform for TestPlatform {
        fn notify(&self, host: Option<&HostProfile>, n: &Notification, style: NotifyStyle) {
            self.notified.lock().unwrap().push((host.map(|h| h.id.clone()), n.clone(), style));
        }
        fn open_external(&self, _: &str) -> Result<(), ApiError> {
            Ok(())
        }
        fn set_keep_alive(&self, on: bool) {
            self.keep_alive.lock().unwrap().push(on);
        }
        fn set_badge(&self, b: BadgeState) {
            self.badges.lock().unwrap().push(b);
        }
        fn device_name(&self) -> String {
            "test-device".into()
        }
    }

    fn cfg(dir: &Path) -> EngineConfig {
        EngineConfig {
            data_dir: dir.to_path_buf(),
            platform_name: "linux".into(),
            client_app: "teleflock-test".into(),
            version: "0.0.0".into(),
            hostd_bins_override: None,
        }
    }

    fn profile(kind: HostKind) -> HostProfile {
        HostProfile {
            id: String::new(),
            name: " Lab ".into(),
            kind,
            address: None,
            user: None,
            port: None,
            distro: None,
            herdr_session: "".into(),
            color: None,
            auto_connect: false,
            relay_port: None,
        }
    }

    #[test]
    fn profile_validation() {
        let p = validate_profile(profile(HostKind::Local), "linux").unwrap();
        assert!(p.id.starts_with("h_"));
        assert_eq!(p.name, "Lab");
        assert_eq!(p.herdr_session, "default");
        assert_eq!(validate_profile(profile(HostKind::TailscaleSsh), "android").unwrap_err().code, "invalid_params");
        assert_eq!(validate_profile(profile(HostKind::Local), "android").unwrap_err().code, "unsupported");
        assert_eq!(validate_profile(profile(HostKind::Wsl), "linux").unwrap_err().code, "unsupported");
        let mut w = profile(HostKind::Wsl);
        w.distro = Some("Ubuntu".into());
        assert!(validate_profile(w, "windows").is_ok());
        let mut bad = profile(HostKind::Local);
        bad.herdr_session = "a b".into();
        assert!(validate_profile(bad, "linux").is_err());
    }

    #[tokio::test]
    async fn app_methods_persist_and_replay() {
        let dir = tempfile::tempdir().unwrap();
        let platform = Arc::new(TestPlatform::default());
        let (engine, mut rx) = Engine::start(cfg(dir.path()), platform.clone()).await;
        assert!(matches!(rx.recv().await.unwrap(), AppEvent::Profiles { ref profiles } if profiles.is_empty()));
        assert!(matches!(rx.recv().await.unwrap(), AppEvent::Settings { ref settings } if settings.device_name == "test-device"));

        let info = engine.call(None, "app.info", serde_json::json!({})).await.unwrap();
        assert_eq!(info["capabilities"]["local"], true);
        assert_eq!(info["capabilities"]["wsl"], false);

        let saved = engine.call(None, "hosts.save", to_value(&profile(HostKind::Local)).unwrap()).await.unwrap();
        let id = saved["id"].as_str().unwrap().to_string();
        let list = engine.call(None, "hosts.list", serde_json::json!({})).await.unwrap();
        assert_eq!(list["profiles"][0]["name"], "Lab");
        assert_eq!(list["statuses"][0]["status"]["phase"], "idle");

        let mut s = default_settings("me".into());
        s.quiet_start = Some("22:00".into());
        s.quiet_end = Some("7:00".into());
        let r = engine.call(None, "settings.set", to_value(&s).unwrap()).await.unwrap();
        assert_eq!(r["quietEnd"], "07:00");
        assert_eq!(engine.call(None, "settings.get", serde_json::json!({})).await.unwrap()["deviceName"], "me");

        // Host methods need a connected host.
        let e = engine.call(Some(&id), "fs.home", serde_json::json!({})).await.unwrap_err();
        assert_eq!(e.code, "not_connected");
        assert_eq!(engine.call(None, "fs.home", serde_json::json!({})).await.unwrap_err().code, "invalid_params");
        assert_eq!(engine.call(None, "nope", serde_json::json!({})).await.unwrap_err().code, "unknown_method");
        assert_eq!(engine.call(Some("x"), "fs.home", serde_json::json!({})).await.unwrap_err().code, "not_found");
        let e = engine.call(None, "tunnel.open", serde_json::json!({"hostId": id, "port": 8080})).await.unwrap_err();
        assert_eq!(e.code, "not_connected");

        // Cached state is replayed as a (stale) snapshot after a restart.
        let mut st = host_state();
        st.agents.push(agent("a1", tf_proto::Column::Needs));
        write_json(
            &dir.path().join("cache").join(format!("{id}.json")),
            &CacheRecord { rev: 42, saved_at: 1, state: st },
        )
        .await
        .unwrap();
        engine.shutdown().await;
        drop(engine);

        let (engine2, _rx2) = Engine::start(cfg(dir.path()), platform.clone()).await;
        let (replay, _rx3) = engine2.subscribe_with_replay();
        let kinds: Vec<String> =
            replay.iter().map(|e| serde_json::to_value(e).unwrap()["type"].as_str().unwrap().to_string()).collect();
        assert_eq!(kinds, ["profiles", "settings", "tunnels", "hostStatus", "hostSnapshot"]);
        assert!(matches!(&replay[1], AppEvent::Settings { settings } if settings.quiet_start.as_deref() == Some("22:00")));
        assert!(matches!(&replay[3], AppEvent::HostStatus { status, .. } if status.phase == ConnPhase::Idle));
        assert!(matches!(&replay[4], AppEvent::HostSnapshot { rev: 42, state, .. } if state.agents.len() == 1));

        engine2.call(None, "hosts.remove", serde_json::json!({"hostId": id})).await.unwrap();
        assert!(!dir.path().join("cache").join(format!("{id}.json")).exists());
        let list = engine2.call(None, "hosts.list", serde_json::json!({})).await.unwrap();
        assert!(list["profiles"].as_array().unwrap().is_empty());
    }

    async fn wait_event(
        rx: &mut broadcast::Receiver<AppEvent>,
        seen: &mut Vec<AppEvent>,
        pred: impl Fn(&AppEvent) -> bool,
    ) -> AppEvent {
        loop {
            let ev = tokio::time::timeout(Duration::from_secs(20), rx.recv())
                .await
                .unwrap_or_else(|_| panic!("timed out; seen: {seen:#?}"))
                .unwrap();
            seen.push(ev.clone());
            if pred(&ev) {
                return ev;
            }
        }
    }

    fn phase_is(ev: &AppEvent, phase: ConnPhase) -> bool {
        matches!(ev, AppEvent::HostStatus { status, .. } if status.phase == phase)
    }

    /// Full connection lifecycle over the real Local transport against a scripted tf-hostd:
    /// deploy, attach args, snapshot/notify passthrough, badge, requests, notification
    /// actions, crash → backoff → reconnect with session re-open, disconnect, cache.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn connection_lifecycle_with_scripted_hostd() {
        let home = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        // SAFETY: the only test that reads TF_HOSTD_HOME; set before any task reads it.
        unsafe { std::env::set_var("TF_HOSTD_HOME", home.path()) };
        let script = include_str!("testdata/fake-tf-hostd.py")
            .replace("@VERSION@", &crate::deploy::expected_version_line());
        let bin = data.path().join("fake-tf-hostd");
        std::fs::write(&bin, script).unwrap();
        let mut st = host_state();
        let mut a = agent("a1", tf_proto::Column::Needs);
        a.needs = Some(tf_proto::NeedsYou {
            kind: NeedsKind::Ask,
            request_id: Some("r1".into()),
            since: 0,
            title: "Question".into(),
            question: "Proceed?".into(),
            detail: None,
            options: vec![],
            multi: false,
            allow_other: true,
            allow_chat: false,
            command: None,
            answerable: true,
        });
        st.agents.push(a);
        st.agents.push(agent("a2", tf_proto::Column::Running));
        std::fs::write(home.path().join("state.json"), serde_json::to_vec(&st).unwrap()).unwrap();

        let platform = Arc::new(TestPlatform::default());
        let mut c = cfg(data.path());
        c.hostd_bins_override = Some(bin);
        let (engine, mut rx) = Engine::start(c, platform.clone()).await;
        let mut p = profile(HostKind::Local);
        p.id = "lab".into();
        p.herdr_session = "tf-lab".into();
        p.relay_port = Some(47999);
        engine.call(None, "hosts.save", to_value(&p).unwrap()).await.unwrap();
        engine.call(None, "hosts.connect", serde_json::json!({"hostId": "lab"})).await.unwrap();

        let mut seen = Vec::new();
        wait_event(&mut rx, &mut seen, |e| phase_is(e, ConnPhase::Online)).await;
        let phases: Vec<ConnPhase> = seen
            .iter()
            .filter_map(|e| match e {
                AppEvent::HostStatus { status, .. } => Some(status.phase),
                _ => None,
            })
            .collect();
        let mut dedup = phases.clone();
        dedup.dedup();
        assert_eq!(
            dedup,
            [ConnPhase::Idle, ConnPhase::Connecting, ConnPhase::Deploying, ConnPhase::Starting, ConnPhase::Online]
        );
        assert!(seen.iter().any(|e| matches!(e, AppEvent::HostSnapshot { rev: 1, state, .. } if state.agents.len() == 2)));
        wait_event(&mut rx, &mut seen, |e| matches!(e, AppEvent::Notify { .. })).await;
        let log = std::fs::read_to_string(home.path().join("attach.log")).unwrap();
        assert_eq!(log.trim(), "attach --session tf-lab --relay-port 47999");
        assert!(std::fs::read_to_string(home.path().join("omp-overlay.yml")).unwrap().contains("127.0.0.1:47999"));
        assert!(home.path().join("ext/teleflock-bridge.ts").is_file());
        for _ in 0..50 {
            if !platform.notified.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        {
            let n = platform.notified.lock().unwrap();
            assert_eq!(n.len(), 1);
            assert_eq!(n[0].0.as_deref(), Some("lab"));
            assert!(n[0].2.reply, "ask with allowOther offers inline reply");
        }
        assert_eq!(platform.badges.lock().unwrap().last(), Some(&BadgeState { needs: 1, running: 1 }));
        assert_eq!(platform.keep_alive.lock().unwrap().last(), Some(&true));

        // Tunnel through the Local transport to a loopback server.
        let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = server.local_addr().unwrap().port();
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            while let Ok((mut s, _)) = server.accept().await {
                let _ = s.write_all(b"HTTP/1.0 200 OK\r\n\r\npreview").await;
            }
        });
        let tun = engine.call(None, "tunnel.open", serde_json::json!({"hostId": "lab", "port": port})).await.unwrap();
        let again = engine.call(None, "tunnel.open", serde_json::json!({"hostId": "lab", "port": port})).await.unwrap();
        assert_eq!(tun["tunnelId"], again["tunnelId"], "same target reuses the tunnel");
        wait_event(&mut rx, &mut seen, |e| matches!(e, AppEvent::Tunnels { tunnels } if tunnels.len() == 1)).await;
        let mut c = tokio::net::TcpStream::connect(("127.0.0.1", tun["localPort"].as_u64().unwrap() as u16)).await.unwrap();
        let mut body = String::new();
        tokio::io::AsyncReadExt::read_to_string(&mut c, &mut body).await.unwrap();
        assert!(body.ends_with("preview"), "{body}");
        engine.call(None, "tunnel.close", serde_json::json!({"tunnelId": tun["tunnelId"]})).await.unwrap();
        let list = engine.call(None, "tunnel.list", serde_json::json!({})).await.unwrap();
        assert!(list["tunnels"].as_array().unwrap().is_empty());

        // Requests.
        let home_dir = engine.call(Some("lab"), "fs.home", serde_json::json!({})).await.unwrap();
        assert_eq!(home_dir["path"], "/fake");
        engine.call(Some("lab"), "session.open", serde_json::json!({"agentId": "a1"})).await.unwrap();
        let term = serde_json::json!({"target": {"kind": "pane", "paneId": "w1:p1"}, "cols": 80, "rows": 24, "mode": "control", "takeover": false});
        engine.call(Some("lab"), "term.open", term).await.unwrap();
        engine.term_input("lab", "t1", "ls\r".into());

        // Notification action → agent.answer → patch removes the needs agent → badge drops.
        engine.notification_action("lab", "n1", Some("yes"), None).await.unwrap();
        wait_event(&mut rx, &mut seen, |e| matches!(e, AppEvent::HostPatch { rev: 2, .. })).await;
        assert_eq!(platform.badges.lock().unwrap().last(), Some(&BadgeState { needs: 0, running: 1 }));
        engine.notification_action("lab", "n1", None, None).await.unwrap();
        wait_event(&mut rx, &mut seen, |e| matches!(e, AppEvent::OpenAgent { agent_id, .. } if agent_id == "a1")).await;

        // Crash: the request fails, the term closes, backoff, reconnect, session re-open.
        let e = engine.call(Some("lab"), "host.health", serde_json::json!({})).await.unwrap_err();
        assert_eq!(e.code, "not_connected");
        wait_event(&mut rx, &mut seen, |e| matches!(e, AppEvent::Term { term_id, ev: tf_proto::TermEvent::Closed { .. }, .. } if term_id == "t1")).await;
        let ev = wait_event(&mut rx, &mut seen, |e| phase_is(e, ConnPhase::Reconnecting)).await;
        let AppEvent::HostStatus { status, .. } = ev else { unreachable!() };
        assert_eq!(status.attempt, 1);
        assert!(status.next_retry_at.is_some());
        assert!(status.message.unwrap().contains("exiting on request"));
        wait_event(&mut rx, &mut seen, |e| phase_is(e, ConnPhase::Online)).await;
        wait_event(&mut rx, &mut seen, |e| {
            matches!(e, AppEvent::Session { agent_id, ev: tf_proto::SessionEvent::Ended { .. }, .. } if agent_id == "a1")
        })
        .await;
        let log = std::fs::read_to_string(home.path().join("attach.log")).unwrap();
        assert_eq!(log.lines().count(), 2, "second attach without re-upload");

        // Webview reload (Tauri): page_closed releases the page's terminals at tf-hostd.
        let term = serde_json::json!({"target": {"kind": "pane", "paneId": "w1:p1"}, "cols": 80, "rows": 24, "mode": "control", "takeover": false});
        let opened = engine.call(Some("lab"), "term.open", term).await.unwrap();
        let tid = opened["termId"].as_str().unwrap().to_string();
        engine.page_closed();
        let closed = |home: &Path| {
            std::fs::read_to_string(home.join("requests.log")).unwrap_or_default().lines().any(|l| {
                let v: Value = serde_json::from_str(l).unwrap();
                v["method"] == "term.close" && v["params"]["termId"] == tid.as_str()
            })
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !closed(home.path()) && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(closed(home.path()), "page_closed sends term.close for {tid}");
        assert!(engine.inner.host("lab").unwrap().view.lock().unwrap().terms.is_empty());

        engine.call(None, "hosts.disconnect", serde_json::json!({"hostId": "lab"})).await.unwrap();
        wait_event(&mut rx, &mut seen, |e| phase_is(e, ConnPhase::Offline)).await;
        assert!(engine.call(Some("lab"), "fs.home", serde_json::json!({})).await.is_err());
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(data.path().join("cache/lab.json").is_file());
        assert_eq!(platform.keep_alive.lock().unwrap().last(), Some(&false));
        engine.shutdown().await;
    }

    #[test]
    fn notify_quiet_hours_and_kinds() {
        let mut s = default_settings("d".into());
        let now = local_minutes_now();
        let fmt = |m: u16| format!("{:02}:{:02}", (m % 1440) / 60, (m % 1440) % 60);
        s.quiet_start = Some(fmt(now + 1439));
        s.quiet_end = Some(fmt(now + 2));
        assert!(in_quiet_hours(&s, local_minutes_now()));
        s.notify_errors = false;
        assert!(!wants(&s, NotifyKind::Quiet));
    }

    /// Muted agents still reach the UI (`AppEvent::Notify`) but never the OS (no toast, no sound).
    #[tokio::test]
    async fn muted_agents_skip_os_notifications() {
        let dir = tempfile::tempdir().unwrap();
        let platform = Arc::new(TestPlatform::default());
        let (engine, _rx) = Engine::start(cfg(dir.path()), platform.clone()).await;
        let mut s = default_settings("d".into());
        s.muted_agents = vec!["lab::a1".into()];
        engine.call(None, "settings.set", to_value(&s).unwrap()).await.unwrap();
        let mut rx = engine.subscribe();
        let (rt, _cmd) = HostRt::new("lab".into(), None);
        let note = |agent: &str| Notification {
            id: format!("n-{agent}"),
            at: 1,
            kind: NotifyKind::Finished,
            agent_id: agent.into(),
            title: "t".into(),
            body: "b".into(),
            request_id: None,
            actions: vec![],
        };
        engine.inner.on_notify(&rt, note("a1"));
        engine.inner.on_notify(&rt, note("a2"));
        let ids: Vec<String> = (0..2)
            .map(|_| match rx.try_recv().unwrap() {
                AppEvent::Notify { host_id, notification } if host_id == "lab" => notification.agent_id,
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(ids, ["a1", "a2"]);
        let os = platform.notified.lock().unwrap();
        assert_eq!(os.len(), 1);
        assert_eq!(os[0].1.agent_id, "a2");
        assert!(rt.find_notification("n-a1").is_some(), "muted notifications stay actionable");
    }
}
