# tf-client (owner: AppCore)

App core shared by `src-tauri` and `tf-devserver` (architecture §5.2).

```rust
use tf_client::{Engine, EngineConfig, Platform, NotifyStyle, BadgeState, Resume};

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
    pub fn resume(&self, why: Resume);        // Focus (desktop) | Foreground | Network (Android)
    pub fn page_closed(&self);                // Tauri: webview reload/navigation → close the page's terminals + sessions
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
  60 s online) or `error` for permanent failures (unsupported arch, version mismatch, host key mismatch).
  `hosts.connect` / `resume()` retry immediately; `hosts.disconnect` → `offline` and closes the host's tunnels.
* Liveness: a ping every 15 s; the link closes once nothing at all arrived since a ping sent 30 s ago.
  A ping tick that comes a whole period late (system sleep, a stopped app) pings first and judges
  nothing sent before it, so waking from sleep keeps a healthy link. `resume(Resume::Focus)` checks
  only links the host has been quiet on for 20 s (15 s to answer); `Foreground` / `Network` check
  every live link (5 s).
* WSL hosts: from the first connect attempt until the host is no longer wanted (disconnect, permanent
  error, removal, quit), `wsl.exe -d <distro> --exec sleep 2147483647` keeps the distro running, so
  reconnects and backoff never let WSL stop it (and tf-hostd, herdr and the agents with it).
* Cache: `cache/<hostId>.json` (compact JSON) is written at most every 60 s and on every disconnect
  and shutdown, only when the state changed; health samples alone don't count.
* Host keys: a new SSH host key from a tailnet address (100.64.0.0/10, fd7a:115c:a1e0::/48, checked on
  the resolved peer) is pinned silently. Any other address stops in `hostKey` with
  `status.hostKey {address, algorithm, fingerprint}` and pins nothing; `hosts.trustKey {hostId,
  fingerprint}` (must equal the shown fingerprint) reconnects and pins it, `hosts.disconnect` cancels
  (→ `offline`). A key that differs from the pinned one is always `error` (`transport.hostKeyMismatch`).
* Tunnels (`tunnel.open`) only target the host's loopback: `remoteHost` ∈ `127.0.0.1` (default), `::1`,
  `localhost`; anything else is `invalid_params`. A sign-in tunnel (`localPort`) closes once the host
  lists no running sign-in on that callback port (`auth.list`, every 5 s), else 10 min after it was
  last opened (architecture §3.14).
* `timeout_for`: 30 s by default; 15 s `term.open`; 180 s for methods that may launch an omp agent
  and for `accounts.unlink` / `accounts.prefer` (omp's logout and a fresh quota report on the host).
* On reconnect, sessions that were open get a `Session{ev: reset}` (or `ended` if gone; one hostd
  has no answer or no session for yet is tried again after 1 s, doubling up to 30 s, while it stays
  open); open terminals get `Term{ev: closed}` when the link drops.
* `notification_action`: `action_id` with an `answer` → `agent.answer`; `reply` text → free-text
  answer if the pending request accepts it, else `agent.prompt`; otherwise emits `OpenAgent`.
  Reconnects (≤ 30 s) when the host is offline.
* Notifications: every hostd `notify` is emitted as `AppEvent::Notify`; the OS gets it when the kind
  is enabled (`needs`→notifyNeeds, `finished`→notifyFinished, `error`/`quiet`→notifyErrors); during
  quiet hours `style.silent = true`, `style.sound = false`.
* Deploy: `uname -sm` → triple; upload `<home>/bin/tf-hostd`, `<home>/ext/teleflock-bridge.ts`,
  `<home>/omp-overlay.yml` (+ `.sha256` stamps) when the version line or content differ. Remote uploads
  land in a temp file whose sha256 (`sha256sum`/`shasum -a 256`) must match before the `mv`, and an
  uploaded tf-hostd must report the expected `--version` line first (else `version_mismatch`, the
  installed one stays); the extension and the overlay share one exec;
  `TF_HOSTD_BIN` (the embedder's `hostd_bins_override`) is honoured by debug app builds only;
  `<home>` = `$TF_HOSTD_HOME` or `~/.teleflock`. Attach: `tf-hostd attach --session S
  [--relay-port P] [--replace]` (`--replace` after an upload).
* Shared hosts never downgrade: when the installed tf-hostd is newer than this build
  (`deploy::host_is_newer`; another device runs a newer app), nothing is uploaded and the app attaches
  to it as is (`Deployed.newer`). A protocol it doesn't speak fails with `version_mismatch` and an
  "update TeleFlock on this device" hint instead of a redeploy.

## Embedded artifacts
`build.rs` embeds `$TF_HOSTD_DIST/<triple>/tf-hostd[.exe]` (default `<workspace>/target/hostd-dist`)
for each triple present (`x86_64|aarch64-unknown-linux-musl`, `…-linux-gnu`, `x86_64|aarch64-pc-windows-msvc`,
`…-apple-darwin`), **zstd -19 compressed** (≈ 8.6 → 3.3 MB) with the SHA-256 and size of the raw binary
computed at build time; deploy decompresses only when it actually uploads. Android builds skip the
Windows triples. It also embeds `host/teleflock-bridge/teleflock-bridge.ts`. Missing ones fail at
deploy time with an error naming the triple / file.

# tf-devserver
`tf-devserver --bind 127.0.0.1:7420 --data-dir <dir> [--static dist] [--hostd-bin <path>] [--token <t>]
[--allow-host <name[:port]>]… [--allow-origin <origin>]… [--allow-remote]`
* `GET /ws?token=<t>` (or subprotocol `teleflock.<t>`, echoed): client → `{id, hostId?, method, params}`
  and `{termIn: {hostId, termId, data}}`; server → `{id, result}` | `{id, error}` | `{event: AppEvent}`.
  Each connection starts with the replay. Missing/wrong token → 401, foreign `Origin` → 403.
* A tab that goes away (close frame, dropped TCP, or silent for 45 s: the server pings every 15 s)
  gets `term.close` for every terminal it opened and `session.close` for sessions no other tab has open.
* Every route: `Host` must be allow-listed (bind IP, `localhost`/loopback on the bound port, `--allow-host`) → else 421.
* Everything else: static files from `--static` with `index.html` fallback; the index gets
  `<meta name="tf-token">` for loopback clients or a page URL with the right `?token=`.
* Non-loopback `--bind` needs `--allow-remote`. Startup prints `http://<bind>/?token=<t>`.
  Details: architecture §5.3.
