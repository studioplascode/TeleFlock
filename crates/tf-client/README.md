# tf-client (owner: AppCore)

App core shared by `src-tauri` and `tf-devserver` (architecture §5.2).

```rust
use tf_client::{Engine, EngineConfig, Platform, NotifyStyle, BadgeState};

pub struct EngineConfig {
    pub data_dir: PathBuf,                    // hosts.json, settings.json, known_hosts, cache/<hostId>.json
    pub platform_name: String,                // "windows" | "android" | "linux" | "macos" | "web"
    pub client_app: String,                   // "teleflock-desktop" | "teleflock-android" | "teleflock-devserver"
    pub version: String,                      // app version (ClientInfo.version)
    pub hostd_bins_override: Option<PathBuf>, // dev: a tf-hostd binary (all arches) or a dist dir <triple>/tf-hostd[.exe]
}

// Requires a tokio runtime (Tauri: tauri::async_runtime::block_on(Engine::start(..))).
impl Engine {                                 // Clone (Arc inside)
    pub async fn start(cfg: EngineConfig, platform: Arc<dyn Platform>) -> (Engine, broadcast::Receiver<AppEvent>);
    pub fn subscribe_with_replay(&self) -> (Vec<AppEvent>, broadcast::Receiver<AppEvent>); // per UI subscriber
    pub fn subscribe(&self) -> broadcast::Receiver<AppEvent>;
    pub async fn call(&self, host_id: Option<&str>, method: &str, params: Value) -> Result<Value, ApiError>;
    pub fn term_input(&self, host_id: &str, term_id: &str, data: String);   // non-blocking fast path
    pub fn emit(&self, ev: AppEvent);                                         // inject (OpenAgent, AnswerNext)
    pub async fn notification_action(&self, host_id: &str, notification_id: &str,
                                     action_id: Option<&str>, reply: Option<String>) -> Result<(), ApiError>;
    pub fn resume(&self);                     // foreground / network change
    pub async fn shutdown(&self);
}

pub trait Platform: Send + Sync + 'static {
    fn notify(&self, host: Option<&HostProfile>, n: &Notification, style: NotifyStyle); // None = app.notifyTest
    fn open_external(&self, url: &str) -> Result<(), ApiError>;
    fn set_keep_alive(&self, on: bool);              // settings.keepAlive && any host wanted
    fn set_badge(&self, badge: BadgeState);          // { needs, running } over live hosts
    fn device_name(&self) -> String;
    fn supports_notifications(&self) -> bool { true }
}
pub struct NotifyStyle { pub sound: bool, pub silent: bool /* quiet hours */, pub reply: bool /* offer inline reply */ }
```

## Behaviour
* `call(None, "app.*" | "hosts.*" | "wsl.*" | "settings.*" | "tunnel.*", …)` is handled locally;
  any other method needs `Some(host_id)` and is forwarded to that host's `tf-hostd`
  (30 s timeout, `term.open` 15 s). Errors are `tf_proto::ApiError` (`not_connected` is retryable).
* `subscribe_with_replay` returns, atomically with the event stream: `Profiles`, `Settings`,
  `Tunnels`, then per host `HostStatus` + `HostSnapshot` (cached state with a non-online status
  = stale). On `RecvError::Lagged`, call it again and resend the replay.
* Connection phases: `connecting → authenticating → (authRequired) → deploying → starting → online`;
  failures go to `reconnecting` (backoff 1, 2, 4 … 30 s + jitter, `attempt`, `nextRetryAt`; reset after
  60 s online) or `error` for permanent failures (unsupported arch, version mismatch, host key).
  `hosts.connect` / `resume()` retry immediately; `hosts.disconnect` → `offline`.
* On reconnect, sessions that were open get a `Session{ev: reset}` (or `ended` if gone); open
  terminals get `Term{ev: closed}` when the link drops.
* `notification_action`: `action_id` with an `answer` → `agent.answer`; `reply` text → free-text
  answer if the pending request accepts it, else `agent.prompt`; otherwise emits `OpenAgent`.
  Reconnects (≤ 30 s) when the host is offline.
* Notifications: every hostd `notify` is emitted as `AppEvent::Notify`; the OS gets it when the kind
  is enabled (`needs`→notifyNeeds, `finished`→notifyFinished, `error`/`quiet`→notifyErrors); during
  quiet hours `style.silent = true`, `style.sound = false`.
* Deploy: `uname -sm` → triple; upload `<home>/bin/tf-hostd`, `<home>/ext/teleflock-bridge.ts`,
  `<home>/omp-overlay.yml` (+ `.sha256` stamps) when the version line or content differ;
  `<home>` = `$TF_HOSTD_HOME` or `~/.teleflock`. Attach: `tf-hostd attach --session S
  [--relay-port P] [--replace]`.

## Embedded artifacts
`build.rs` embeds `$TF_HOSTD_DIST/<triple>/tf-hostd[.exe]` (default `<workspace>/target/hostd-dist`)
for each triple present (`x86_64|aarch64-unknown-linux-musl`, `…-linux-gnu`, `x86_64|aarch64-pc-windows-msvc`,
`…-apple-darwin`), **zstd -19 compressed** (≈ 8.6 → 3.3 MB) with the SHA-256 and size of the raw binary
computed at build time; deploy decompresses only when it actually uploads. Android builds skip the
Windows triples. It also embeds `host/teleflock-bridge/teleflock-bridge.ts`. Missing ones fail at
deploy time with an error naming the triple / file.

# tf-devserver
`tf-devserver --bind 127.0.0.1:7420 --data-dir <dir> [--static dist] [--hostd-bin <path>]`
* `GET /ws`: client → `{id, hostId?, method, params}` and `{termIn: {hostId, termId, data}}`;
  server → `{id, result}` | `{id, error}` | `{event: AppEvent}`. Each connection starts with the replay.
* Everything else: static files from `--static` with `index.html` fallback.
