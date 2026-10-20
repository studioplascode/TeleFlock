//! The bridge between the webview and the embedded `tf_client::Engine`.
//!
//! Commands (camelCase args from JS):
//! * `core_call({ hostId, method, params })` → result JSON, rejects with a tf-proto `ApiError`.
//! * `core_term_input({ hostId, termId, data })` → fire-and-forget terminal input.
//! * `core_events({ channel })` → subscribes the page: first a replay of the current state
//!   (profiles, statuses, snapshots, settings, tunnels), then live `AppEvent`s.
//!
//! UI-intent events (`OpenAgent`, `AnswerNext`) that fire while no page is subscribed (cold start
//! from a toast / deep link, webview reload) are held and delivered to the next subscriber.

use std::sync::{
    Mutex,
    atomic::{AtomicU64, AtomicUsize, Ordering},
};

use serde_json::Value;
use tauri::{State, ipc::Channel};
use tf_client::Engine;
use tf_proto::{ApiError, AppEvent};
use tokio::sync::broadcast::error::RecvError;

/// UI intents kept for a late subscriber (bounded; the newest win).
const MAX_PENDING: usize = 8;

pub struct Core {
    pub engine: Engine,
    /// Bumped on every page (re)load: forwarding tasks of an older generation stop.
    generation: AtomicU64,
    /// Live page subscriptions of the current generation.
    live: AtomicUsize,
    pending: Mutex<Vec<AppEvent>>,
}

fn is_ui_intent(ev: &AppEvent) -> bool {
    matches!(ev, AppEvent::OpenAgent { .. } | AppEvent::AnswerNext)
}

impl Core {
    /// `initial` is the receiver returned by `Engine::start`; it is used to catch UI intents
    /// emitted while no page listens.
    pub fn new(engine: Engine, initial: tokio::sync::broadcast::Receiver<AppEvent>) -> std::sync::Arc<Self> {
        let core = std::sync::Arc::new(Self {
            engine,
            generation: AtomicU64::new(0),
            live: AtomicUsize::new(0),
            pending: Mutex::new(Vec::new()),
        });
        let watcher = std::sync::Arc::clone(&core);
        tauri::async_runtime::spawn(async move {
            let mut rx = initial;
            loop {
                match rx.recv().await {
                    Ok(ev) if is_ui_intent(&ev) && watcher.live.load(Ordering::Acquire) == 0 => {
                        watcher.hold(ev);
                    }
                    Ok(_) | Err(RecvError::Lagged(_)) => {}
                    Err(RecvError::Closed) => break,
                }
            }
        });
        core
    }

    fn hold(&self, ev: AppEvent) {
        let mut p = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if p.len() == MAX_PENDING {
            p.remove(0);
        }
        p.push(ev);
    }

    /// The page is navigating / reloading: its channels are dead.
    pub fn page_reset(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.live.store(0, Ordering::Release);
    }

    /// Emits a UI intent (deep link, tray, toast). Reaches the page now or on its next subscribe.
    pub fn ui_intent(&self, ev: AppEvent) {
        if self.live.load(Ordering::Acquire) == 0 {
            self.hold(ev);
        } else {
            self.engine.emit(ev);
        }
    }

    /// Notification body tap / button / inline reply → engine routing (answer, prompt, open).
    pub fn notification_action(
        self: &std::sync::Arc<Self>,
        host_id: String,
        notification_id: String,
        action_id: Option<String>,
        reply: Option<String>,
    ) {
        let core = std::sync::Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            if let Err(e) = core
                .engine
                .notification_action(&host_id, &notification_id, action_id.as_deref(), reply)
                .await
            {
                log::warn!("notification action {notification_id}/{action_id:?} on {host_id} failed: {e}");
            }
        });
    }

    fn subscribe_page(self: std::sync::Arc<Self>, channel: Channel<AppEvent>) {
        let generation = self.generation.load(Ordering::Acquire);
        // Subscribe before counting as live, so an intent emitted in between is not lost.
        let (replay, mut rx) = self.engine.subscribe_with_replay();
        self.live.fetch_add(1, Ordering::AcqRel);
        tauri::async_runtime::spawn(async move {
            let alive = || self.generation.load(Ordering::Acquire) == generation;
            let mut ok = replay.into_iter().all(|ev| channel.send(ev).is_ok());
            if ok {
                let held = std::mem::take(&mut *self.pending.lock().unwrap_or_else(|e| e.into_inner()));
                ok = held.into_iter().all(|ev| channel.send(ev).is_ok());
            }
            while ok && alive() {
                match rx.recv().await {
                    Ok(ev) => ok = channel.send(ev).is_ok(),
                    Err(RecvError::Lagged(n)) => {
                        log::warn!("webview lagged {n} events; resending state");
                        let (replay, fresh) = self.engine.subscribe_with_replay();
                        rx = fresh;
                        ok = replay.into_iter().all(|ev| channel.send(ev).is_ok());
                    }
                    Err(RecvError::Closed) => break,
                }
            }
            if alive() {
                self.live.fetch_sub(1, Ordering::AcqRel);
            }
        });
    }
}

pub type CoreState = std::sync::Arc<Core>;

#[tauri::command]
pub async fn core_call(
    core: State<'_, CoreState>,
    host_id: Option<String>,
    method: String,
    params: Option<Value>,
) -> Result<Value, ApiError> {
    // Omitted params (`invoke("core_call", { method })`) mean `{}` (methods taking `Empty`).
    let params = params.unwrap_or_else(|| Value::Object(Default::default()));
    core.engine.call(host_id.as_deref(), &method, params).await
}

#[tauri::command]
pub async fn core_term_input(
    core: State<'_, CoreState>,
    host_id: String,
    term_id: String,
    data: String,
) -> Result<(), ApiError> {
    core.engine.term_input(&host_id, &term_id, data);
    Ok(())
}

#[tauri::command]
pub fn core_events(core: State<'_, CoreState>, channel: Channel<AppEvent>) {
    std::sync::Arc::clone(&core).subscribe_page(channel);
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use serde_json::{Value, json};
    use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
    use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder, mock_context, noop_assets};
    use tauri::webview::InvokeRequest;
    use tf_client::{BadgeState, EngineConfig, NotifyStyle, Platform};
    use tf_proto::{ApiError, AppEvent, HostProfile, Notification};

    use super::*;

    struct NullPlatform;
    impl Platform for NullPlatform {
        fn notify(&self, _: Option<&HostProfile>, _: &Notification, _: NotifyStyle) {}
        fn open_external(&self, _: &str) -> Result<(), ApiError> {
            Ok(())
        }
        fn set_keep_alive(&self, _: bool) {}
        fn set_badge(&self, _: BadgeState) {}
        fn device_name(&self) -> String {
            "test-box".into()
        }
    }

    fn start(dir: &std::path::Path) -> CoreState {
        let cfg = EngineConfig {
            data_dir: dir.to_path_buf(),
            platform_name: "linux".into(),
            client_app: "teleflock-test".into(),
            version: "0.1.0".into(),
            hostd_bins_override: None,
        };
        let (engine, rx) = tauri::async_runtime::block_on(Engine::start(cfg, Arc::new(NullPlatform)));
        Core::new(engine, rx)
    }

    fn recorder() -> (Channel<AppEvent>, Arc<Mutex<Vec<Value>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let ch = Channel::new(move |body| {
            if let InvokeResponseBody::Json(s) = body {
                sink.lock().unwrap().push(serde_json::from_str::<Value>(&s).unwrap());
            }
            Ok(())
        });
        (ch, seen)
    }

    fn wait_for(seen: &Mutex<Vec<Value>>, pred: impl Fn(&[Value]) -> bool) -> Vec<Value> {
        let t0 = Instant::now();
        loop {
            let v = seen.lock().unwrap().clone();
            if pred(&v) || t0.elapsed() > Duration::from_secs(5) {
                return v;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn types(v: &[Value]) -> Vec<&str> {
        v.iter().filter_map(|e| e["type"].as_str()).collect()
    }

    fn invoke(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>, cmd: &str, body: Value) -> Result<Value, Value> {
        get_ipc_response(
            webview,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                // The app's own (local) origin on Linux; remote origins need a capability.
                url: "tauri://localhost".parse().unwrap(),
                body: InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|b| b.deserialize::<Value>().unwrap())
    }

    #[test]
    fn commands_reach_the_engine() {
        let dir = tempfile::tempdir().unwrap();
        let core = start(dir.path());
        let app = mock_builder()
            .manage(Arc::clone(&core))
            .invoke_handler(tauri::generate_handler![core_call, core_term_input, core_events])
            .build(mock_context(noop_assets()))
            .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();

        let info = invoke(&webview, "core_call", json!({ "hostId": null, "method": "app.info", "params": {} })).unwrap();
        assert_eq!(info["version"], "0.1.0");
        assert_eq!(info["platform"], "linux");

        let hosts = invoke(&webview, "core_call", json!({ "hostId": null, "method": "hosts.list" })).unwrap();
        assert!(hosts["profiles"].is_array());

        let err = invoke(&webview, "core_call", json!({ "hostId": null, "method": "no.such", "params": {} })).unwrap_err();
        assert_eq!(err["code"], "unknown_method", "{err}");

        // Unknown host: the fast path never fails the caller.
        invoke(&webview, "core_term_input", json!({ "hostId": "nope", "termId": "t", "data": "ls\r" })).unwrap();
    }

    #[test]
    fn replay_then_held_intents_then_live() {
        let dir = tempfile::tempdir().unwrap();
        let core = start(dir.path());

        // Cold start: an intent before any page subscribed is held.
        core.ui_intent(AppEvent::OpenAgent { host_id: "h".into(), agent_id: "w1:p2".into() });
        let (ch, seen) = recorder();
        Arc::clone(&core).subscribe_page(ch);
        let got = wait_for(&seen, |v| types(v).contains(&"openAgent"));
        let t = types(&got);
        assert!(t.contains(&"profiles") && t.contains(&"settings"), "replay missing: {t:?}");
        let open = t.iter().position(|x| *x == "openAgent").expect("held intent delivered");
        assert!(t[..open].contains(&"settings"), "held intents follow the replay: {t:?}");
        assert_eq!(got[open]["agentId"], "w1:p2");

        // Live: delivered through the engine broadcast.
        core.ui_intent(AppEvent::AnswerNext);
        let got = wait_for(&seen, |v| types(v).contains(&"answerNext"));
        assert!(types(&got).contains(&"answerNext"));

        // Reload: the old page is gone, intents are held for the next one.
        core.page_reset();
        core.ui_intent(AppEvent::AnswerNext);
        let (ch2, seen2) = recorder();
        Arc::clone(&core).subscribe_page(ch2);
        let got2 = wait_for(&seen2, |v| types(v).contains(&"answerNext"));
        assert!(types(&got2).contains(&"answerNext"), "{:?}", types(&got2));
    }

    /// Real run against a lab herdr session through the Local transport and a real tf-hostd.
    /// `scripts`-free recipe (isolated HOME so ~/.teleflock and herdr state are private):
    /// ```sh
    /// export HOME=/tmp/tf-lab-tauri-home; mkdir -p $HOME
    /// setsid -f herdr --session tf-lab-tauri server </dev/null >/tmp/tf-lab-tauri.out 2>&1
    /// TF_LAB_SESSION=tf-lab-tauri TF_HOSTD_BIN=$PWD/target/<dir>/debug/tf-hostd \
    ///   cargo test -p teleflock lab_local_host -- --ignored --nocapture
    /// herdr session stop tf-lab-tauri
    /// ```
    #[test]
    #[ignore = "needs a lab herdr session + tf-hostd binary (see doc comment)"]
    fn lab_local_host() {
        let session = std::env::var("TF_LAB_SESSION").expect("TF_LAB_SESSION");
        let hostd = std::env::var("TF_HOSTD_BIN").expect("TF_HOSTD_BIN");
        let dir = tempfile::tempdir().unwrap();
        let cfg = EngineConfig {
            data_dir: dir.path().to_path_buf(),
            platform_name: "linux".into(),
            client_app: "teleflock-test".into(),
            version: "0.1.0".into(),
            hostd_bins_override: Some(hostd.into()),
        };
        let (engine, rx) = tauri::async_runtime::block_on(Engine::start(cfg, Arc::new(NullPlatform)));
        let core = Core::new(engine, rx);
        let (ch, seen) = recorder();
        Arc::clone(&core).subscribe_page(ch);

        let call = |host: Option<&str>, m: &str, p: Value| tauri::async_runtime::block_on(core.engine.call(host, m, p));
        let profile = json!({
            "id": "lab", "name": "lab", "kind": "local", "herdrSession": session,
            "autoConnect": false, "relayPort": 47498
        });
        call(None, "hosts.save", profile).unwrap();
        call(None, "hosts.connect", json!({ "hostId": "lab" })).unwrap();

        let t0 = Instant::now();
        let got = loop {
            let v = seen.lock().unwrap().clone();
            let online = v.iter().any(|e| e["type"] == "hostStatus" && e["status"]["phase"] == "online");
            let snap = v.iter().any(|e| e["type"] == "hostSnapshot" && e["hostId"] == "lab");
            if (online && snap) || t0.elapsed() > Duration::from_secs(60) {
                break v;
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        let phases: Vec<&str> = got
            .iter()
            .filter(|e| e["type"] == "hostStatus")
            .filter_map(|e| e["status"]["phase"].as_str())
            .collect();
        println!("phases via core_events: {phases:?}");
        let snap = got.iter().rev().find(|e| e["type"] == "hostSnapshot").expect("hostSnapshot via core_events");
        println!(
            "snapshot rev {} · {} workspaces · {} agents",
            snap["rev"],
            snap["state"]["workspaces"].as_array().map_or(0, |a| a.len()),
            snap["state"]["agents"].as_array().map_or(0, |a| a.len())
        );
        assert!(phases.contains(&"online"), "{phases:?}");

        let health = call(Some("lab"), "host.health", json!({})).unwrap();
        println!("host.health via core_call: {health}");
        call(None, "hosts.disconnect", json!({ "hostId": "lab" })).unwrap();
        tauri::async_runtime::block_on(core.engine.shutdown());
    }
}
