# TeleFlock platform research (Tauri 2 on Windows and Android)

Research date: 2026-10-20. Evidence tags: `[observed]` means it was run on this box, `[source]` means it was read in code or docs (file:line or URL), and `[inferred]` means it was not verified.

This file merges three research tracks run by the Toolchain agent and its sub-agents:
- **Part A**, Android: Kotlin plugins, the foreground service, notifications, the official notification plugin on Android and Windows (plus Windows toasts), Tailscale on Android, and xterm.js WebGL.
- **Part B**, Windows: titlebar and Snap Layouts, Mica, tray and taskbar, single-instance and deep links, Local mode (herdr named pipe, ConPTY), and WSL mode.
- **Part C**, russh and Tailscale SSH: an observed russh 0.64.1 probe, check mode from source, crypto backends, and the recommended crate versions table.

The build and toolchain setup is in `docs/build.md`.

Scratch code these notes refer to is kept at:
- `.research/tauri-hello/research-scratch/fgs-test/`: the Kotlin plugin crate `tauri-plugin-teleflock-android` with the foreground service, notifications with RemoteInput, the BroadcastReceiver and the JNI bridge. It compiled into a release APK.
- `.research/tauri-hello/research-scratch/russh-probe/`: the russh probe, the fake check-mode server, and the cross-build script.

Build outputs were excluded from both copies.

**Not verified on real hardware.** No Windows machine, Android device, or other tailnet peer was used. Every claim about runtime behaviour on those platforms is `[source]` or `[inferred]`, and the Tailscale SSH items are explicitly marked "verify on a real peer later". Per Main's directive, nothing connected to tailnet peers or exercised Tailscale SSH auth.

## Key decisions and findings (cross-cutting)

| # | Topic | Decision / finding | Where |
|---|---|---|---|
| 1 | Android keep-alive | One plugin crate `crates/tauri-plugin-teleflock-android` (Kotlin package `dev.teleflock.android`). The foreground service type is **`remoteMessaging`**, which has no time limit; `dataSync` is capped at 6 h on Android 15+ (ConnectBot uses the same type). The service only raises the process priority, while the Rust tokio/russh runtime keeps running in-process. On Android, call `prevent_exit()` on `ExitRequested{code:None}`. | A §1–§2, §7 |
| 2 | Notifications | **Android:** use our own Kotlin notifications (actions plus RemoteInput with `FLAG_MUTABLE` and an explicit intent, delivered to a BroadcastReceiver, then to Rust over JNI) instead of `tauri-plugin-notification` 2.7.0, whose actions always open the Activity. **Windows:** use our own toast code on `windows` 0.62 with an HKCU AUMID and a COM `INotificationActivationCallback`. The official plugin gives buttons only while the banner is visible, no reply text, and no Action Center activation. | A §3–§4 |
| 3 | Snap Layouts | Tauri/tao cannot return `HTMAXBUTTON`, so use **`tauri-plugin-snap-layout` 1.0.9** (an invisible child HWND over the HTML maximize button). **The current `minWidth: 1100` in `src-tauri/tauri.conf.json` breaks snapping** (Microsoft wants ≤ 500 epx). | B §1.5 |
| 4 | Mica | Opt-in and Windows 11 only. The window must be created `transparent: true`, and `backgroundColor` needs alpha 0 (`#0b0b1000`). **The current opaque `#0b0b10` hides Mica.** Keep the terminal surface opaque, and never use acrylic on Win10 or build 22000 (it lags while resizing). | B §2 |
| 5 | Badges | `set_badge_count` is unsupported on Windows and Android. On Windows, use a swapped tray icon plus `set_overlay_icon` (16×16), `request_user_attention(Critical)` and `set_progress_bar`. On Android, the badge comes from notifications. | B §3 |
| 6 | Local mode | herdr runs natively on Windows (GA). Its API is the same NDJSON protocol over a **named pipe** `\\.\pipe\<full .sock path>`. `herdr terminal attach` is unsupported on Windows; `herdr terminal session control` streams a pane over plain pipes, so verify it on Windows first. The fallback is herdr's full UI in ConPTY via `portable-pty` 0.9.0. | B §5 |
| 7 | WSL mode | Set `WSL_UTF8=1`, otherwise `wsl.exe -l -q` prints UTF-16LE. The registry `Lxss` key is an alternative way to list distros. Windows cannot reach unix sockets inside WSL2, so use long-lived `wsl.exe --exec` stdio processes (one relay plus one per terminal). Keep one running: an idle distro shuts down after ~15 s, which kills herdr. | B §6 |
| 8 | Tailscale SSH auth | Auth is the SSH **`none`** method; keyboard-interactive is never offered. Check mode sends a **`USERAUTH_BANNER` containing the login URL**, then holds the `none` request for up to 30 min. TeleFlock should show the `auth_banner` text and URL, leave `authenticate_none` pending, offer Cancel, and use a timeout of at least 31 min. When the server closes the connection during auth, the result is `Ok(Failure{remaining_methods: []})`, not `Err`. (`[source]` tailscale v1.104.1; verify on a real peer later.) | C §0, §3 |
| 9 | russh keepalive | **Bug in russh 0.64.1** `[observed]`: setting `keepalive_interval` while auth is pending (as in a check-mode hold) makes the client busy-loop at ~100% CPU, and `inactivity_timeout` never fires. **Leave keepalive off in `client::Config` and run our own `send_ping()` timer (~30 s) after auth succeeds.** This overrides Part A §7's "set russh keepalive to 30 s". | C §2.3–§2.4 |
| 10 | Host keys | Tailscale SSH reuses `/etc/ssh` host keys and publishes them as `Peer.sshHostKeys` in `tailscale status --json`. Desktop matches against that list; Android uses TOFU pinning. | C §3.5 |
| 11 | Crypto backend | **Use `ring`** for russh (`default-features = false, features = ["flate2","rsa","ring"]`). It cross-builds for Android (NDK r29) and for Windows via cargo-xwin with no extra tools. `aws-lc-rs` needs NASM for the Windows cross-build unless `AWS_LC_SYS_PREBUILT_NASM=1` is set. | C §4 |
| 12 | Tailscale on Android | App sockets go through the Tailscale VpnService automatically, unless the user excludes TeleFlock via app split tunneling. Resolve names with the system resolver (`tokio::net::lookup_host`, i.e. bionic `getaddrinfo`), **not hickory**, which has no search domains on Android, so short MagicDNS names fail. Cache the 100.x IP as a fallback. MagicDNS is off on this tailnet, so dial 100.x IPs. | A §5, C §1.2 |
| 13 | xterm.js | `@xterm/xterm` 6.0.0 + `@xterm/addon-webgl` 0.19.0. The canvas renderer was removed in v6, so the fallback is the DOM renderer, used on WebGL2 failure or `onContextLoss`. Attach WebGL only to **visible** terminals: Chromium caps live WebGL contexts and `dispose()` does not release them (xterm#6068). | A §6 |
| 14 | Crate pins | tauri 2.12.4, russh 0.64.1, portable-pty 0.9.0, `windows` 0.62.x (matches tauri), `jni` **0.21** (matches tauri, not 0.22). The full table is in Part C §5. | C §5 |

---

# Part A: Android, notifications, Tailscale on Android, xterm.js

## TeleFlock platform notes: Android (Tauri 2 Kotlin plugins, FGS, notifications, Tailscale, xterm WebGL) and Windows toasts

Date: 2026-10-20. Evidence tags: `[observed]` = I ran it, `[source]` = file:line or URL, `[inferred]` = my reasoning, not verified.

**Versions checked today** `[observed]` (crates.io API / `npm view`):

| Package | Version | Notes |
|---|---|---|
| `tauri` | 2.12.4 | uses `jni = "0.21"` on Android, `windows = "0.62"` on Windows `[source]` tauri-2.12.4/Cargo.toml:365,421 |
| `tauri-plugin` (build) | 2.7.2 | |
| `tauri-build` | 2.7.3 | |
| `@tauri-apps/cli` / `@tauri-apps/api` | 2.12.3 / 2.12.4 | |
| `tauri-plugin-notification` / `@tauri-apps/plugin-notification` | 2.7.0 / 2.7.0 (`next` = 3.0.0-alpha.3) | |
| `notify-rust` | 4.18.2 | the desktop backend of the notification plugin |
| `tauri-winrt-notification` | 0.8.1 | the Windows backend of notify-rust |
| `winrt-toast-reborn` | 0.3.8 | has `<input>` support, uses windows 0.61 |
| `win-toast-notify` | 0.1.6 (2024-08) | only supports protocol activation, generates XML; stale |
| `windows` | 0.62.2 | same major as tauri, so no duplicate crate |
| `jni` | 0.22.4 latest; **use 0.21** to match tauri | |
| `russh` | 0.64.1 | |
| `hickory-resolver` | 0.26.3 | |
| `androidx.core:core-ktx` | 1.19.1 | Google Maven |
| `@xterm/xterm` | 6.0.0 (latest, 2025-12-22); beta 6.1.0-beta.315 | |
| `@xterm/addon-webgl` | 0.19.0; beta 0.20.0-beta.309 | |
| `@xterm/addon-fit` 0.11.0 · `addon-unicode11` 0.9.0 · `addon-web-links` 0.12.0 · `addon-search` 0.16.0 · `addon-serialize` 0.14.0 · `addon-image` 0.9.0 · `addon-clipboard` 0.2.0 · `addon-ligatures` 0.10.0 · `addon-progress` 0.2.0 · `addon-unicode-graphemes` 0.4.0 · `addon-attach` 0.12.0 · `@xterm/headless` 6.0.0 | | |
| `@xterm/addon-canvas` | 0.7.0 (2024-07), **removed in xterm 6** | see §6 |

Local toolchain (used for the compile test) `[observed]`: `/opt/android-sdk` (build-tools 36.0.0/37.0.0, platforms android-36/android-37.0, NDK 29.0.14206865), `/opt/jdk/jdk-17.0.20.1+1`. The generated Android project in `.research/tauri-hello` uses AGP 9.3.1, Kotlin 2.2.10, Gradle 9.6.1, `compileSdk = 37`, `targetSdk = 37`, `minSdk = 24`.

---

### 0. Compile proof (what was actually built)

I built a throwaway copy of `.research/tauri-hello` (at `.research/tauri-hello/research-scratch/fgs-test`) plus a plugin crate `tauri-plugin-teleflock-android` that contains the Kotlin foreground service, the notification and RemoteInput code, the BroadcastReceiver and the JNI bridge from §1–§3:

```
ANDROID_HOME=/opt/android-sdk NDK_HOME=/opt/android-sdk/ndk/29.0.14206865 JAVA_HOME=/opt/jdk/jdk-17.0.20.1+1 \
CARGO_TARGET_DIR=/root/TeleFlock/target/PlatAndroid \
./node_modules/.bin/tauri android build --apk --target aarch64 --ci --config '{"build":{"beforeBuildCommand":""}}'
→ Finished 1 APK at .../app-universal-release-unsigned.apk
```
`[observed]` Results:
- The Kotlin code compiled against `:tauri-android` (Tauri 2.12.4). R8 kept every `dev.teleflock.android.*` class, including `RustBridge.onNotificationAction (PRIVATE STATIC FINAL NATIVE)` (checked with `dexdump`).
- The merged manifest (`aapt2 dump xmltree`) contains the plugin's `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_REMOTE_MESSAGING`, `POST_NOTIFICATIONS`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` and `ACCESS_NETWORK_STATE` permissions, plus `<service KeepAliveService foregroundServiceType=0x200 (remoteMessaging)>` and `<receiver ActionReceiver exported=false>`. **This shows that plugin manifests are merged into the app.**
- `llvm-nm -D` on `libtauri_hello_lib.so` (release build, LTO, strip) shows `T Java_dev_teleflock_android_RustBridge_onNotificationAction`. So a `#[unsafe(no_mangle)] extern "system"` fn defined in a **dependency crate** is exported from the app cdylib.
- Gotcha hit while building: the Gradle `rust` task runs `<pkg-manager> tauri android android-studio-script`, so `node_modules/.bin/tauri` must exist in the app root. Otherwise the build fails with `tauri: command not found` / exit 127 `[observed]`.
- **No runtime test was done.** No emulator or device is available. Behaviour claims below are `[source]`/`[inferred]`.

Windows toast code (§4) was compiled with `cargo check --target x86_64-pc-windows-msvc` using `windows = 0.62.2` → `Finished` `[observed]`.

---

### 1. Tauri 2 mobile plugin authoring (Kotlin)

#### 1.1 Scaffolding
- `tauri plugin new <name> --android [--no-example] [--no-api] [-d DIR]` creates a new plugin. `tauri plugin android init [PLUGIN_NAME] [-o OUT_DIR]` adds `android/` to an existing plugin `[observed]` CLI 2.12.3 `--help`. Both commands prompt for the Android package ID, so they need a TTY (`failed to prompt input: IO error: not a terminal` otherwise). I ran it under `script -qc` `[observed]`.
- Generated layout `[observed]`:
```
tauri-plugin-keepalive/
  Cargo.toml            # links = "tauri-plugin-keepalive"  (REQUIRED, must equal package name)
  build.rs              # tauri_plugin::Builder::new(COMMANDS).android_path("android").ios_path("ios").build()
  src/{lib.rs,mobile.rs,desktop.rs,commands.rs,models.rs,error.rs}
  permissions/default.toml   (+ permissions/autogenerated/ written by build.rs)
  guest-js/index.ts, package.json, rollup.config.js
  android/build.gradle.kts   # com.android.library + org.jetbrains.kotlin.android, namespace = pkg, compileSdk 37, minSdk 21
  android/settings.gradle    # include ':tauri-android' → ./.tauri/tauri-api (copied by build.rs)
  android/src/main/AndroidManifest.xml
  android/src/main/java/ExamplePlugin.kt
```
- Template `Cargo.toml` deps: `tauri = "2.12.4"`, build-dep `tauri-plugin = { version = "2.7.2", features = ["build"] }`, `edition = "2024"`, `rust-version = "1.90"` `[observed]`.

#### 1.2 How the Android library reaches the app's Gradle build
- `tauri_plugin::Builder::try_build` fails if `CARGO_MANIFEST_LINKS` is missing (`Error::LinksMissing`). Plugin names must not contain `_` `[source]` tauri-plugin-2.7.2/src/build/mod.rs:150-162.
- For `target_os == "android"` it copies `$DEP_TAURI_ANDROID_LIBRARY_PATH` into `android/.tauri/tauri-api` and prints `cargo:android_library_path=<abs android dir>` `[source]` tauri-plugin-2.7.2/src/build/mobile.rs:119-136. Add `android/.tauri` to `.gitignore`.
- The app's `tauri-build` reads every `DEP_*_ANDROID_LIBRARY_PATH` and writes two files: `gen/android/tauri.settings.gradle` (`include ':<links-name>'` + `projectDir`) and `gen/android/app/tauri.build.gradle.kts` (`implementation(project(":<links-name>"))`, plus `androidx.lifecycle:lifecycle-process:2.10.0`) `[source]` tauri-build-2.7.3/src/mobile.rs:147-195. In the test build this produced `include ':tauri-plugin-teleflock-android'` `[observed]`.
- **Manifest merging**: AGP's normal library-manifest merge. Whatever is in the plugin's `android/src/main/AndroidManifest.xml` (`<uses-permission>`, `<service>`, `<receiver>`) ends up in the APK `[observed]` §0. The official notification plugin uses the same mechanism: its receivers and `POST_NOTIFICATIONS`/`WAKE_LOCK`/`RECEIVE_BOOT_COMPLETED` are declared in the plugin manifest `[source]` plugins-workspace `plugins/notification/android/src/main/AndroidManifest.xml`.
- To inject into the **app's** manifest from a build script (for example `<intent-filter>` in the main activity), use `tauri_plugin::mobile::update_android_manifest(block_identifier, parent, insert)` `[source]` tauri-plugin-2.7.2/src/build/mobile.rs:99.

#### 1.3 Kotlin API surface (`app.tauri.*`, from tauri-2.12.4/mobile/android)
- `abstract class Plugin(private val activity: Activity)`: `open fun load(webView: WebView)`, `onNewIntent(intent)`, `onPause/onResume/onStop/onDestroy/onRestart` (both with and without an activity argument), `onConfigurationChanged`, `trigger(event: String, payload: JSObject)`, `triggerObject(event, Any)` (Jackson), `hasListener(event)`, `startActivityForResult(invoke, intent, callbackName)` + `@ActivityCallback`, `getConfig(Class)`, `jsonMapper()` `[source]` …/app/tauri/plugin/Plugin.kt:45-487.
- Built-in `@Command`s on every plugin: `registerListener` (args `{event, handler: Channel}`), `removeListener`, `checkPermissions`, `requestPermissions` (args `{permissions: [alias…]}`) `[source]` Plugin.kt:233-300.
- `Invoke`: `parseArgs(Class)`, `getArgs(): JSObject`, `getRawArgs()`, `resolve()`, `resolve(JSObject)`, `resolveObject(Any)`, `reject(msg, code?, ex?, data?)` `[source]` Invoke.kt:20-90.
- Annotations: `@TauriPlugin(permissions = [Permission(strings = [...], alias = "...")])`, `@Command`, `@InvokeArg` (on argument classes; nested classes need it too), `@PermissionCallback`, `@ActivityCallback` `[source]` app/tauri/annotation/*.kt.
- `trigger()` sends only to registered `Channel`s (JS `addPluginListener` or a Rust `ipc::Channel`). With no listener, the event is dropped `[source]` Plugin.kt:209-231.
- Plugin construction: Rust `register_android_plugin(pkg, Class)` resolves `"pkg/Class"` through `activity.getAppClass(name)` → `Class.forName`, then `new Class(Activity)` and `PluginManager.load(webView, name, plugin, configJson)` on the Android context thread `[source]` tauri-2.12.4/src/plugin/mobile.rs:208-288; wry-0.57.0/src/android/mod.rs:518-533. `PluginManager` is a Kotlin `object`, i.e. one per process `[source]` generated TauriActivity.kt.

#### 1.4 Rust side
```rust
// src/lib.rs of the plugin
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("teleflock-android")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = _api.register_android_plugin("dev.teleflock.android", "TeleFlockPlugin")?;
                _app.manage(TeleFlockAndroid(handle));
            }
            Ok(())
        })
        .build()
}
// calling Kotlin from Rust (sync; there is also `run_mobile_plugin_async`)
impl<R: Runtime> TeleFlockAndroid<R> {
    pub fn start_keep_alive(&self, title: &str, text: &str) -> Result<(), PluginInvokeError> {
        self.0.run_mobile_plugin("startKeepAlive", KeepAlive { title, text })
    }
    pub fn check_permissions(&self) -> Result<Permissions, PluginInvokeError> {
        self.0.run_mobile_plugin("checkPermissions", ())   // auto-implemented from @TauriPlugin(permissions)
    }
    pub fn request_permissions(&self) -> Result<Permissions, PluginInvokeError> {
        self.0.run_mobile_plugin("requestPermissions", serde_json::json!({ "permissions": ["postNotification"] }))
    }
}
#[derive(serde::Deserialize)] #[serde(rename_all = "camelCase")]
pub struct Permissions { pub post_notification: tauri::plugin::PermissionState } // "granted"|"denied"|"prompt"|"prompt-with-rationale"
```
`[observed]` This compiled in the test build. `PluginHandle::run_mobile_plugin<T: DeserializeOwned>(&self, command, payload: impl Serialize) -> Result<T, PluginInvokeError>` and `run_mobile_plugin_async` (oneshot-based; it drops late or duplicate responses instead of panicking inside JNI) `[source]` tauri-2.12.4/src/plugin/mobile.rs:290-344.

- **Receiving Kotlin events in Rust without JS**: create an `ipc::Channel` and pass it to `registerListener`. The official notification plugin does exactly this for `on_action` `[source]` plugins/notification/src/mobile.rs:115-140:
```rust
let channel = tauri::ipc::Channel::new(move |body| {
    if let tauri::ipc::InvokeResponseBody::Json(p) = body { /* serde_json::from_str(&p) */ }
    Ok(())
});
handle.run_mobile_plugin::<()>("registerListener", serde_json::json!({ "event": "notificationAction", "handler": channel }))?;
```
- **JS → Kotlin**: `invoke('plugin:teleflock-android|startKeepAlive', {...})`. Each JS-callable command must be listed in `build.rs` `COMMANDS` and allowed in a capability. `run_mobile_plugin` from Rust bypasses the ACL, so a Rust-driven plugin can use `const COMMANDS: &[&str] = &[];` `[observed]` (built fine) / `[source]` Tauri ACL design.
- **Kotlin → Rust directly (JNI)**: the official docs describe this pattern ("even when the application WebView is suspended") `[source]` https://v2.tauri.app/develop/plugins/develop-mobile/#calling-rust-from-mobile-plugins. Tauri's generated `object Rust { init { System.loadLibrary("<lib_name>") } }` already loads the app library (`teleflock_lib` for TeleFlock), so the plugin does not need its own `loadLibrary` while the app is running `[observed]` generated Rust.kt:16-19. If a BroadcastReceiver cold-starts the process, the lib is **not** loaded (no Activity has touched `Rust`). Catch `UnsatisfiedLinkError` (see §3.4).

#### 1.5 Plugin inside the app vs separate crate
- **Separate crate (recommended)**: put it at `crates/tauri-plugin-teleflock-android/` (the workspace already globs `crates/*`). This is the only way to get a Gradle **library** module, its manifest merge and its resources wired in automatically through `links` + `DEP_…_ANDROID_LIBRARY_PATH` `[observed]`. Kotlin package `dev.teleflock.android`.
- **In-app alternative**: put the Kotlin files directly in `src-tauri/gen/android/app/src/main/java/dev/teleflock/app/` (not under `generated/`, which is overwritten every build `[observed]` "THIS FILE IS AUTO-GENERATED"). Then register with an inline plugin in `lib.rs` (`tauri::plugin::Builder::new("android-glue").setup(|app, api| api.register_android_plugin("dev.teleflock.app", "KeepAlivePlugin"))`). This works because class lookup is `Class.forName` on the activity's class loader `[source]` wry find_class. Manifest entries then go into `gen/android/app/src/main/AndroidManifest.xml` by hand. Downside: logic lives in the semi-generated `gen/android` tree, and JS-callable commands need `tauri_build::InlinedPlugin` in the app build.rs `[source]` tauri-build-2.7.3/src/lib.rs:122,523. `[inferred]` Use this only for trivial glue.

#### 1.6 Gradle deps for the plugin module
```kotlin
// android/build.gradle.kts (as built)
android { namespace = "dev.teleflock.android"; compileSdk = 37; defaultConfig { minSdk = 24; consumerProguardFiles("consumer-rules.pro") } }
dependencies {
    implementation("androidx.core:core-ktx:1.19.1")      // ServiceCompat.startForeground(…, type), NotificationCompat, RemoteInput
    implementation("androidx.appcompat:appcompat:1.6.0")
    implementation(project(":tauri-android"))
}
```
`consumer-rules.pro`: `-keep class dev.teleflock.android.** { *; }` keeps the JNI target, the service and the receiver referenced by name. It survived R8 `[observed]`. The root `buildscript` of the app project (AGP 9.3.1 / Kotlin 2.2.10) wins over the plugin's `settings.gradle` versions when the plugin is included as a subproject `[observed]`. AGP 9 prints deprecation warnings for `android {}` in the library; they are harmless `[observed]`.

---

### 2. Foreground service for the SSH connection

#### 2.1 Why it works (process model)
- The Rust core runs **in the app process**. Tao calls the app's `main` exactly once per process, from `ProcessLifecycleOwner.onCreate` → `Rust.onFirstActivityCreate` `[source]` wry WryActivity.kt:23-30, tao ndk_glue.rs:331. The tokio runtime (`tauri::async_runtime`) and the russh session are ordinary threads and sockets in that process. **The service does no work. It only raises the process to foreground-service priority so it is not cached, frozen or killed while the Activity is in the background** `[inferred]`.
- Activity destruction: tao and wry tear down window/webview state only when `!isChangingConfigurations` `[source]` tao ndk_glue.rs:727-745, wry main_pipe.rs:514-524. If the last window is destroyed (back button / swipe away), tauri-runtime-wry emits `RunEvent::ExitRequested { code: None }`, and unless you call `prevent_exit()` it sets `ControlFlow::Exit` `[source]` tauri-runtime-wry-2.12.2/src/lib.rs:4255-4269. **Keep the core alive while the FGS runs** `[observed compiles]`:
```rust
.build(tauri::generate_context!())?
.run(|_app, e| {
    #[cfg(target_os = "android")]
    if let tauri::RunEvent::ExitRequested { code: None, api, .. } = e { api.prevent_exit(); }
});
```
`[inferred]` On relaunch a new Activity and WebView are created while Rust state persists. The UI must rebuild its state from Rust (snapshot command) and must not assume a fresh process. **This needs a device test** (multi-activity support exists: `activity_name`, `created_by_activity_name`, `startActivity` in wry 0.57).
- Task Manager "Stop" (Android 13+) kills the whole process with no callback. Check `ApplicationExitInfo` `REASON_USER_REQUESTED` on the next start `[source]` https://developer.android.com/develop/background-work/services/fgs/handle-user-stopping.

#### 2.2 Choosing the FGS type (targetSdk ≥ 34 requires a type) `[source]` https://developer.android.com/develop/background-work/services/fgs/service-types
| Type | Manifest permission | Runtime prerequisite | Time limit | Fit for "keep SSH to herdr alive" |
|---|---|---|---|---|
| `dataSync` | `FOREGROUND_SERVICE_DATA_SYNC` | none | **6 h per 24 h for targetSdk ≥ 35**, then `onTimeout(int,int)`; you must `stopSelf()` within seconds or get `RemoteServiceException`. The timer resets when the user brings the app to the foreground. A new start after exhaustion throws `ForegroundServiceStartNotAllowedException` `[source]` …/fgs/timeout | Poor: semantically "transfer/backup", and the 6 h cap breaks overnight sessions |
| `remoteMessaging` | `FOREGROUND_SERVICE_REMOTE_MESSAGING` | none | none | **Recommended.** Play describes it as "Relay text communication to another device … Not limited to SMS" `[source]` https://support.google.com/googleplay/android-developer/answer/13392821. ConnectBot (a Play SSH client) declares `foregroundServiceType="remoteMessaging"` for its TerminalManager `[source]` github.com/connectbot/connectbot app/src/main/AndroidManifest.xml:29,99-103 |
| `connectedDevice` | `FOREGROUND_SERVICE_CONNECTED_DEVICE` | must declare `CHANGE_NETWORK_STATE`/`CHANGE_WIFI_STATE`/… or hold a BT/UWB/USB grant | none | Play wants "pairing and connecting to an external device" (wearables, cars); weak fit |
| `specialUse` | `FOREGROUND_SERVICE_SPECIAL_USE` | none | none | Fallback. Needs `<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="Maintains the user-initiated SSH session to their dev machine so agent terminals keep streaming"/>` and gets manual Play review |
| `shortService` | none | none | ~3 min | no |

Play Console (targetSdk ≥ 34): declare each type under *Policy → App content*, with a description, the user impact if deferred or interrupted, and **a video link** showing how the user triggers it `[source]` Play answer 13392821. If Play distribution is not planned (sideload APK), the policy is moot, but the platform rules still apply.

#### 2.3 Manifest (plugin) — as built `[observed]`
```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<application>
  <service android:name="dev.teleflock.android.KeepAliveService" android:exported="false"
           android:foregroundServiceType="remoteMessaging" />
  <receiver android:name="dev.teleflock.android.ActionReceiver" android:exported="false" />
</application>
```
`WAKE_LOCK` is only needed if you take a `PARTIAL_WAKE_LOCK` (not recommended by default, see §2.6). `INTERNET` is already in the Tauri app manifest `[observed]`.

#### 2.4 Service code (compiled `[observed]`)
```kotlin
class KeepAliveService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Notifications.ensureChannels(this)
        val n = NotificationCompat.Builder(this, Notifications.CHANNEL_KEEPALIVE)
            .setSmallIcon(R.drawable.ic_stat_teleflock)
            .setContentTitle(intent?.getStringExtra(EXTRA_TITLE) ?: "TeleFlock")
            .setContentText(intent?.getStringExtra(EXTRA_TEXT) ?: "Connected")
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(Notifications.openAppIntent(this))
            .build()
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, n, type)   // id must be > 0
        return START_NOT_STICKY   // a restarted service in a fresh process would have no Rust core
    }
    override fun onTimeout(startId: Int, fgsType: Int) { stopSelf() }  // API 35; only for dataSync/mediaProcessing
    companion object {
        const val NOTIFICATION_ID = 1; const val EXTRA_TITLE = "title"; const val EXTRA_TEXT = "text"
        fun start(ctx: Context, title: String, text: String) =
            ContextCompat.startForegroundService(ctx, Intent(ctx, KeepAliveService::class.java)
                .putExtra(EXTRA_TITLE, title).putExtra(EXTRA_TEXT, text))
        fun stop(ctx: Context) { ctx.stopService(Intent(ctx, KeepAliveService::class.java)) }
    }
}
```
Plugin command (Rust calls `startKeepAlive` when the SSH session reaches *connected*):
```kotlin
@Command fun startKeepAlive(invoke: Invoke) {
    val a = invoke.parseArgs(KeepAliveArgs::class.java)
    try { KeepAliveService.start(activity, a.title, a.text); invoke.resolve() }
    catch (e: Exception) { invoke.reject(e.message ?: "failed to start foreground service", "FGS_START", e) } // ForegroundServiceStartNotAllowedException (31+), SecurityException (34+ missing type perm)
}
```

#### 2.5 Timing and start rules
- Two steps: `startForegroundService()`, then `ServiceCompat.startForeground()` "ordinarily in `onStartCommand()`" `[source]` https://developer.android.com/develop/background-work/services/fgs/launch. Passing a type that the manifest does not declare → `IllegalArgumentException`. Missing `FOREGROUND_SERVICE_<TYPE>` on targetSdk ≥ 34 → `SecurityException` `[source]` same page / …/fgs/changes.
- Calling `startForeground` late → ANR / crash ("did not then call Service.startForeground()"). Call it first thing. `[inferred]` The window is ~5–10 s depending on version; I did not find the exact number in the current docs.
- targetSdk ≥ 31: **no FGS start while the app is in the background**. Exemptions include: the user acts on a notification, widget or activity of the app; **the user has turned off battery optimizations for the app**; the app transitions from a visible state `[source]` https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start. ⇒ Start it on connect while the UI is visible. A "Reconnect" action on our own notification is allowed to restart it.
- Android 13+: if `POST_NOTIFICATIONS` is denied, the FGS still runs but its notice only appears in the Task Manager, not the drawer `[source]` https://developer.android.com/develop/ui/views/notifications/notification-permission.
- Android 16: jobs started from an FGS now obey job quotas (irrelevant: we use no WorkManager) `[source]` …/fgs/changes.
- FGS notification priority must be ≥ `PRIORITY_LOW` (an IMPORTANCE_LOW channel is fine) `[source]` …/fgs/launch.

#### 2.6 Doze, App Standby, battery optimization
- **Network in Doze**: NetworkPolicyManager allows network while idle or in power save when `procState <= PROCESS_STATE_BOUND_FOREGROUND_SERVICE` or the uid has `PROCESS_CAPABILITY_POWER_RESTRICTED_NETWORK` `[source]` AOSP `core/java/android/net/NetworkPolicyManager.java:188-189,831-838`. `PROCESS_STATE_FOREGROUND_SERVICE` is declared before (i.e. is more important than) `BOUND_FOREGROUND_SERVICE` `[source]` ActivityManager.java:772-790. ⇒ **With the FGS running, the socket keeps network access in Doze.** App Standby also does not apply while a foreground service exists `[source]` https://developer.android.com/training/monitoring-device-state/doze-standby.
- **CPU in Doze / screen off**: an FGS holds no wakelock. The CPU can suspend, so tokio timers (russh `keepalive_interval`) fire late, while inbound packets wake the device `[inferred]`. Recommendation: russh `Config { keepalive_interval: Some(30s), keepalive_max: 3, .. }` (fields at russh-0.64.1/src/client/mod.rs:2659-2686 `[source]`). On resume, treat a missed keepalive as "probe and reconnect fast", not as a failure. A `PARTIAL_WAKE_LOCK` costs battery; offer it only as an opt-in "stay awake while agents run" setting `[inferred]`.
- **Battery optimization exemption**: `PowerManager.isIgnoringBatteryOptimizations(pkg)`. Request it with `Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$pkg"))`, which needs the `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` permission (lint `BatteryLife`, suppressed in the code). The alternative without that permission is `ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS` (opens the list) `[source]` doze-standby page. **Play policy**: direct requests are prohibited "unless the core function of the app is adversely affected" `[source]` same page. With an FGS it is mostly unnecessary for network, but it helps OEM killers (Xiaomi/Samsung "sleeping apps") and lets us restart the FGS from the background `[inferred]`. Make it an explicit user setting.
- The WebView renderer is a separate sandboxed process. Wry calls `WebView.onPause()` in `onPause` `[source]` WryActivity.kt:146-152. That pauses animations and geolocation, **not JS**. Wry never calls `pauseTimers()` `[observed]` (grep). Wry also does **not** override `onRenderProcessGone` `[observed]` (grep in wry-0.57.0/src/android/kotlin). Per the Android docs, an unhandled renderer death kills the app, and that would take the Rust core with it `[inferred]` (from the WebViewClient contract; test with `adb shell am crash`/`kill` on the renderer pid).

#### 2.7 WebView JS while backgrounded
- A hidden page gets `visibilitychange → hidden`, `requestAnimationFrame` stops, and Chromium throttles timers (≥1 s; long-hidden pages are throttled harder) `[inferred]` (Chromium behaviour). IPC from Rust into the WebView still runs, but there is no point in feeding PTY bytes to a hidden xterm.
- Design: **Rust owns all streams and buffers.** On `hidden`, JS tells Rust to stop forwarding terminal output for that view (keep the russh channel). On `visible`, it asks for a fresh snapshot (herdr pane read / scrollback) and resumes the live stream. Notifications for agent events are raised **from Rust** through the Kotlin plugin, never from JS timers.

---

### 3. Notifications with actions and inline reply (custom Kotlin)

#### 3.1 Channels and permission
- Channels (API 26+), created in `load()` and in the service: `agents` (`IMPORTANCE_HIGH`, heads-up) and `keepalive` (`IMPORTANCE_LOW`, no badge) `[observed compiles]`.
- Android 13 (API 33) `POST_NOTIFICATIONS` is a runtime permission. Declare it via `@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "postNotification")])` and call `requestPermissions {permissions:["postNotification"]}` from Rust or JS. Tauri auto-implements `checkPermissions/requestPermissions` `[source]` Plugin.kt:262-300; https://v2.tauri.app/develop/plugins/develop-mobile/ (permissions section). Always guard posting with `SDK_INT < 33 || checkSelfPermission(...) == GRANTED` and `NotificationManagerCompat.areNotificationsEnabled()`, and catch `SecurityException`.

#### 3.2 Posting with buttons + RemoteInput (compiled `[observed]`)
```kotlin
for (act in a.actions) {
    val intent = Intent(ctx, ActionReceiver::class.java)               // EXPLICIT intent
        .setAction(ACTION_NOTIFICATION)
        .putExtra(EXTRA_ID, a.id).putExtra(EXTRA_TAG, a.tag).putExtra(EXTRA_ACTION, act.id)
    val mut = if (act.reply) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE
    val pi = PendingIntent.getBroadcast(ctx, 31 * a.id + act.id.hashCode(), intent, mut or PendingIntent.FLAG_UPDATE_CURRENT)
    val ab = NotificationCompat.Action.Builder(R.drawable.ic_stat_teleflock, act.title, pi).setShowsUserInterface(false)
    if (act.reply) ab.addRemoteInput(RemoteInput.Builder(KEY_REPLY).setLabel(act.placeholder ?: act.title).build())
        .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
        .setAllowGeneratedReplies(false)
    b.addAction(ab.build())
}
NotificationManagerCompat.from(ctx).notify(a.tag, a.id, b.build())   // tag = herdr pane id; (tag,id) is the identity
```
- `FLAG_MUTABLE` (API 31) is **required for inline reply** because the system fills the RemoteInput result into the intent. Otherwise use `FLAG_IMMUTABLE`. From API 31 the mutability must be specified `[source]` https://developer.android.com/reference/android/app/PendingIntent#FLAG_MUTABLE.
- targetSdk ≥ 34: `FLAG_MUTABLE` + **implicit** intent → `IllegalArgumentException`. Always set the component (`Intent(ctx, ActionReceiver::class.java)`) `[source]` same page (FLAG_ALLOW_UNSAFE_IMPLICIT_INTENT note).
- Use distinct `requestCode`s per (notification, action), or `FLAG_UPDATE_CURRENT` overwrites the extras of the other buttons `[inferred]`.
- Notification trampolines: on targetSdk ≥ 31 a receiver or service started from a notification **cannot start an Activity**. Use `getActivity` directly for "Open" `[inferred]` from the platform rule. The content intent uses `getActivity(launchIntent, FLAG_IMMUTABLE|FLAG_UPDATE_CURRENT)`.

#### 3.3 Receiver → Rust (and optionally JS)
```kotlin
class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Notifications.ACTION_NOTIFICATION) return
        val id = intent.getIntExtra(EXTRA_ID, 0); val tag = intent.getStringExtra(EXTRA_TAG)
        val actionId = intent.getStringExtra(EXTRA_ACTION) ?: return
        val reply = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(KEY_REPLY)?.toString()
        val json = JSONObject().put("notificationId", id).put("tag", tag ?: JSONObject.NULL)
            .put("actionId", actionId).put("reply", reply ?: JSONObject.NULL).toString()
        val delivered = RustBridge.deliver(json)                       // works with no Activity / WebView
        TeleFlockPlugin.emit("notificationAction", JSObject(json))     // JS listeners, if a WebView is alive
        if (reply != null) Notifications.markReplied(ctx, id, tag, reply, delivered)  // MUST re-post or cancel, or the reply spinner keeps spinning
        else NotificationManagerCompat.from(ctx).cancel(tag, id)
    }
}
object RustBridge {
    @JvmStatic private external fun onNotificationAction(json: String): Boolean
    fun deliver(json: String): Boolean = try { onNotificationAction(json) } catch (e: UnsatisfiedLinkError) { false }
}
```
```rust
// plugin src/android.rs  (jni 0.21, edition 2024 ⇒ #[unsafe(no_mangle)])
static SINK: OnceLock<Box<dyn Fn(NotificationAction) + Send + Sync>> = OnceLock::new();
pub fn set_action_sink(f: impl Fn(NotificationAction) + Send + Sync + 'static) { let _ = SINK.set(Box::new(f)); }

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_teleflock_android_RustBridge_onNotificationAction(
    mut env: JNIEnv, _class: JClass, json: JString) -> jboolean {
    let Ok(json) = env.get_string(&json) else { return JNI_FALSE };
    let json: String = json.into();
    let (Some(sink), Ok(a)) = (SINK.get(), serde_json::from_str::<NotificationAction>(&json)) else { return JNI_FALSE };
    sink(a);              // e.g. tx.send(a) into the core's tokio mpsc; runs on the Android main thread — never block
    JNI_TRUE
}
```
`[observed]` The symbol is exported in a release/LTO build (§0). Install the sink in `run()` before the `Builder` (e.g. `set_action_sink(move |a| { let _ = tx.send(a); })`).

#### 3.4 Cold-process case
If the process died (Task Manager stop, OOM) but a notification is still shown, tapping a broadcast action starts a bare process: no Activity, `Rust` object not initialized, so `UnsatisfiedLinkError` → `deliver()` returns `false`. `markReplied(..., delivered=false)` then posts "Not sent – open TeleFlock" with an Activity content intent `[observed code path compiles; runtime inferred]`. Optionally save the pending reply in SharedPreferences and send it after reconnect. Calling `System.loadLibrary` from the receiver is pointless: Tauri's main and the SSH session would not exist `[inferred]`.

#### 3.5 Grouping and updates
Use `tag` = herdr pane/agent id and a stable `id` per event kind, so updates replace instead of stack. Add `setGroup("agents")` + a summary notification if more than ~4 appear `[inferred]`.

---

### 4. Official `tauri-plugin-notification` 2.7.0 — what actually works

Source: github.com/tauri-apps/plugins-workspace `plugins/notification` at commit `11211c30` (2026-10-17) `[observed]` (clone).

#### 4.1 Android (Kotlin `app.tauri.notification.NotificationPlugin`)
- `registerActionTypes([{id, actions:[{id,title,input?, …}]}])` + `actionTypeId` on the notification → `NotificationCompat.Action`s. `input: true` → `RemoteInput(KEY "NotificationRemoteInput")`; `inputButtonTitle`/`inputPlaceholder` are **iOS-only** ("On Android only the identifier, the title and the input flag are used") `[source]` TauriNotificationManager.kt:249-275, guest-js/index.ts:390-426.
- **Action PendingIntents are `PendingIntent.getActivity(...)` with an explicit Activity intent (`ACTION_MAIN`, `CATEGORY_LAUNCHER`, `SINGLE_TOP|CLEAR_TOP`) and flags `FLAG_CANCEL_CURRENT|FLAG_MUTABLE` (S+)** `[source]` TauriNotificationManager.kt:236-262,300-315. ⇒ Every button and **every inline reply launches/brings the Activity to the front**. The result is read in `onNewIntent`/`load` → `trigger("actionPerformed", {actionId, inputValue, notification})` `[source]` NotificationPlugin.kt:94-133; TauriNotificationManager.kt:53-86.
- Delivery to Rust: `Notification::on_action(|p: &ActionPerformed| …)` (new in 2.6.0) registers an `ipc::Channel` listener, so it also works on mobile `[source]` src/mobile.rs:115-140; CHANGELOG 2.6.0.
- It is tied to the Activity: the plugin class is constructed with the Activity and only sees intents that reach that Activity `[source]` NotificationPlugin.kt:80-133.
- Verdict: **inline reply works on Android but opens the app.** It has no FGS, and actions cannot be routed to the Rust core without the UI. We need a Kotlin plugin for the FGS anyway, so **use the custom plugin for Android notifications** (§3) `[inferred]`.

#### 4.2 Windows (desktop.rs → `notify-rust` 4.18.2 → `tauri-winrt-notification` 0.8.1)
- Since 2.6.0, `registerActionTypes` / `actionTypeId` / `onAction` / Rust `on_action` work on desktop. Buttons are built from the action type's `(id, title)` only, **and only if a listener or handler exists** ("Otherwise the actions of the notification are not shown") `[source]` desktop.rs:96-169,209-220; CHANGELOG 2.6.0.
- Activation: on Windows/macOS a **dedicated `std::thread` per tracked toast** blocks in `handle.wait_for_response` and maps `Default → "tap"` and `Action(id) → id` `[source]` desktop.rs:473-485,715-730. The payload is always `{"actionId", "inputValue": null, "notification"}` `[source]` desktop.rs:361-368. **No inline reply**: `inputValue` is always null.
- notify-rust Windows backend: `add_button(label, id)` + in-process `on_activated(Option<String>)`. `NotificationResponse::Reply` is emitted only by the macOS `preview-macos-un` backend ("On all other backends this variant is never emitted") `[source]` notify-rust-4.18.2/src/windows.rs:14-46, src/response.rs:75-79.
- tauri-winrt-notification 0.8.1 builds toast XML with text, images, buttons and progress only (no `<input>` API). `on_activated` reads only `ToastActivatedEventArgs.Arguments()` `[source]` src/lib.rs:469-506.
- "a click is only reported while the toast is on screen, not once it moved to the Action Center" `[source]` desktop.rs:110-111. Reason: there is no COM activator and only the in-process `ToastNotification.Activated` event `[inferred]`.
- `removeActive` is a no-op on Windows (notify-rust cannot remove a toast) `[source]` desktop.rs:222-231,711-713.
- AUMID: the plugin sets `app_id = config.identifier` **only when the exe is not under `target\debug` or `target\release`**. In dev, toasts go out under the PowerShell AUMID `{1AC14E77-…}\WindowsPowerShell\v1.0\powershell.exe` `[source]` desktop.rs:506-517; notify-rust windows.rs:98-101.
- Permission APIs always return `Granted` on desktop `[source]` desktop.rs:193-207.

#### 4.3 Windows recommendation: own `windows`-crate toast module (inline reply)
Use `windows = 0.62.2` (same version as tauri/wry, so no second copy `[source]` tauri-2.12.4/Cargo.toml:421, wry-0.57.0/Cargo.toml:309) with features `Data_Xml_Dom, Foundation, Foundation_Collections, UI_Notifications, Win32_Foundation, Win32_System_Com, Win32_UI_Notifications`. The following was **cargo-checked** for `x86_64-pc-windows-msvc` `[observed]` (`/tmp/wintoast/src/lib.rs`):
```rust
let xml = format!(r#"<toast launch="action=open&amp;pane={p}">
  <visual><binding template="ToastGeneric"><text>{t}</text><text>{b}</text></binding></visual>
  <actions>
    <input id="reply" type="text" placeHolderContent="Reply to agent"/>
    <action content="Send" arguments="action=reply&amp;pane={p}" hint-inputId="reply" activationType="foreground"/>
    <action content="Approve" arguments="action=approve&amp;pane={p}" activationType="foreground"/>
  </actions></toast>"#);           // XML-escape p/t/b
let doc = XmlDocument::new()?; doc.LoadXml(&HSTRING::from(xml))?;
let toast = ToastNotification::CreateToastNotification(&doc)?;
toast.SetTag(&HSTRING::from(pane))?; toast.SetGroup(h!("agents"))?;
toast.Activated(&TypedEventHandler::new(move |_s: Ref<ToastNotification>, args: Ref<IInspectable>| {
    if let Some(args) = args.as_ref() {
        let a: ToastActivatedEventArgs = args.cast()?;
        let arguments = a.Arguments()?.to_string();
        let reply = a.UserInput().ok()                       // Win10 1903+ (10.0.18362)
            .and_then(|vs| vs.Lookup(h!("reply")).ok())
            .and_then(|v| v.cast::<IPropertyValue>().ok())
            .and_then(|pv| pv.GetString().ok()).map(|s| s.to_string());
        on_activate(arguments, reply);
    }
    Ok(())
}))?;
ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(aumid))?.Show(&toast)?;
// keep `toast` alive (HashMap<pane, ToastNotification>) so the handler stays registered [inferred]
```
- `ToastActivatedEventArgs.UserInput` needs Windows 10 1903 (10.0.18362) `[source]` https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.toastactivatedeventargs.userinput. `ToastNotificationHistory.Remove(tag, group, aumid)` provides removal (the plugin cannot do this) `[inferred]` (WinRT API).
- **In-process only** (like the official plugin): it works while the banner is up and the process is alive. For **Action Center clicks and activation while the app is closed**, add a COM activator (also cargo-checked `[observed]`):
```rust
#[implement(INotificationActivationCallback)]
struct Activator { sink: Box<dyn Fn(String, Vec<(String, String)>) + Send + Sync> }
impl INotificationActivationCallback_Impl for Activator_Impl {
    fn Activate(&self, _aumid: &PCWSTR, invokedargs: &PCWSTR, data: *const NOTIFICATION_USER_INPUT_DATA, count: u32) -> Result<()> {
        // invokedargs = the <action arguments>; data[i].Key/Value = <input id> → text
        ...; Ok(())
    }
}
#[implement(IClassFactory)] struct Factory { /* CreateInstance → Activator.into().query(riid, ppv) */ }
unsafe { CoRegisterClassObject(&ACTIVATOR_CLSID, &factory, CLSCTX_LOCAL_SERVER, REGCLS_MULTIPLEUSE) }?;
```
  Trait signature `Activate(&self, &PCWSTR, &PCWSTR, *const NOTIFICATION_USER_INPUT_DATA, u32)` and `NOTIFICATION_USER_INPUT_DATA { Key: PCWSTR, Value: PCWSTR }` live in `windows::Win32::UI::Notifications` (feature `Win32_UI_Notifications`) `[source]` windows-0.62.2/src/Windows/Win32/UI/Notifications/mod.rs:1-41.
- **AUMID / registration for an unpackaged NSIS app**:
  - Tauri's NSIS installer creates Start-menu (and optional desktop) shortcuts and stamps `System.AppUserModel.ID = ${BUNDLEID}` (= `identifier`, here `dev.teleflock.app`) on them. It does **not** set `System.AppUserModel.ToastActivatorCLSID` `[source]` tauri `crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi:993-997,1020-1021` + `utils.nsh:78-102` (SetLnkAppUserModelId). So in-process toasts with `CreateToastNotifierWithId("dev.teleflock.app")` work after install `[inferred]`.
  - The shortcut-less path, which also covers dev builds and supports the activator, needs these keys under `HKCU\Software\Classes\AppUserModelId\dev.teleflock.app`: `DisplayName` (REG_SZ), `IconUri` (absolute path), optional `IconBackgroundColor`, and `CustomActivator` = `{CLSID}`. Also `HKCU\Software\Classes\CLSID\{CLSID}\LocalServer32` = `"C:\…\teleflock.exe" -ToastActivated` `[source]` CommunityToolkit `Microsoft.Toolkit.Uwp.Notifications/Toasts/Compat/ToastNotificationManagerCompat.cs:28,159-209,277-305`; winrt-toast-reborn-0.3.8/src/register.rs:13-31 (DisplayName/IconUri only).
  - At startup, register the class factory **before** the Tauri builder runs. If COM launched us with `-ToastActivated`, the callback arrives right after registration. If an instance is already running with the object registered, COM calls into it directly (no second process) `[inferred]` (COM LocalServer semantics). Write the keys from Rust at first run, and remove them with an NSIS `NSIS_HOOK_POSTUNINSTALL` macro via `bundle.windows.nsis.installerHooks` (hooks exist: installer.nsi:686-932 `[source]`).
  - Alternative: Windows App SDK `AppNotificationManager::Register()` does the same for unpackaged apps but requires the WinAppSDK runtime `[source]` https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/app-notifications-quickstart. That is too heavy for a Tauri app `[inferred]`.
- Crate options: `tauri-winrt-notification`/`notify-rust` (no input, in-process), `winrt-toast-reborn` 0.3.8 (`Input` + `on_activated(Some("input_id"), …)` reading `UserInput()`, `register(aumid, display_name, icon)`; in-process only, **windows 0.61** → duplicate windows crate), `win-toast-notify` 0.1.6 (protocol activation only; protocol activation cannot carry input text) `[source]` the respective crate sources. **Recommendation: about 150 lines of our own `windows` 0.62 code (as above). Keep the official plugin out of the Windows path, or use it only for plain toasts** `[inferred]`.

---

### 5. Tailscale on Android

- **Routing**: the Tailscale app is a `VpnService`. Its builder adds only the tailnet routes (`rcfg.Routes`: 100.64.0.0/10, fd7a:115c:a1e0::/48, subnet routes; on API 33+ `excludeRoute` handles local routes), sets DNS servers + search domains via `addDnsServer`/`addSearchDomain`, and does not call `allowBypass()` `[source]` tailscale-android@9832bc58 `libtailscale/net.go` (updateTUN, ~L113-190), `android/src/main/java/com/tailscale/ipn/IPNService.kt:175-215`, `VPNServiceBuilder.kt:18-35`. Every app's sockets, including a Rust `tokio::net::TcpStream` in our process, use the VPN network for those ranges automatically. Nothing is needed in our app `[inferred]` (standard VpnService semantics).
- **Per-app exclusion**: "App-based split tunneling" (Tailscale ≥ 1.70). If the user excludes TeleFlock, "its traffic and DNS queries won't be handled by Tailscale". MDM `IncludedPackageNames`/`ExcludedPackageNames` exist `[source]` https://tailscale.com/docs/features/client/android-app-split-tunneling.md. Only one VPN can be active on Android, so another VPN app disconnects the tailnet `[inferred]`. UX: on connect failure, show "Is Tailscale connected and is TeleFlock not excluded?"
- **DNS / MagicDNS from Rust**:
  - `tokio::net::lookup_host` / `TcpStream::connect("aron-dev:22")` → std `ToSocketAddrs` → **bionic `getaddrinfo`** on the blocking pool → netd DnsResolver, which uses the VPN network's DNS (100.100.100.100) and search domains (`<tailnet>.ts.net`). So both `aron-dev.<tailnet>.ts.net` and, with search domains, the short name `aron-dev` should resolve `[inferred]`. russh `client::connect(config, addrs: impl tokio::net::ToSocketAddrs, handler)` uses that path `[source]` russh-0.64.1/src/client/mod.rs:1146.
  - Android has **no `/etc/resolv.conf`**. `hickory-resolver` 0.26.3 has an Android `read_system_conf()`: through JNI (`ndk_context`) it reads `ConnectivityManager.getActiveNetwork()` → `getLinkProperties().getDnsServers()` and returns `ResolverConfig::from_parts(None, vec![], nameservers)`, i.e. **no search domains**, as a one-time snapshot `[source]` hickory-resolver-0.26.3/src/system_conf/android.rs:9-93. ⇒ Short names fail, and Wi-Fi↔cellular or VPN up/down changes leave it stale. **Do not use hickory (or reqwest's `hickory-dns` feature) for the host connection.**
  - Known Tailscale issue: Android Private DNS ("automatic"/strict) can bypass MagicDNS (tailscale/tailscale#7709, open) `[source]` https://github.com/tailscale/tailscale/issues/7709.
  - **Recommendation**: store the FQDN `aron-dev.<tailnet>.ts.net` and resolve via `getaddrinfo`. After the first success, **cache the 100.x / fd7a: IP** and fall back to it on resolution failure. Let the user paste a Tailscale IP directly. Connect by IP when the name fails `[inferred]`.
- **Android 17 (API 37) local-network permission**: targetSdk 37 enforces `ACCESS_LOCAL_NETWORK` (NEARBY_DEVICES group). The "local network" definition lists 100.64.0.0/10 among the ranges but scopes it to broadcast-capable interfaces and "excludes cellular (WWAN) or VPN connections" `[source]` https://developer.android.com/privacy-and-security/local-network-definition, https://developer.android.com/about/versions/17/behavior-changes-17. ⇒ Tailnet traffic via the VPN should not need it `[inferred]`. **Verify on an API 37 device**, because our template already sets `targetSdk = 37` `[observed]`.
- **Tailscale SSH needs nothing client-side**: the server authenticates by tailnet identity inside its `NoClientAuthCallback` (auth method `none`), and humours `password`/`publickey` attempts by ignoring their content. The username suffix `+password` forces password auth for buggy clients `[source]` tailscale `ssh/tailssh/tailssh.go:66-71,420-466`. With russh: `handle.authenticate_none(user).await` (russh-0.64.1/src/client/mod.rs:329). For ACL "check" mode, the server sends a login URL as an **auth banner** before completing auth. Surface it via `client::Handler::auth_banner` (mod.rs:2711) `[source]`/`[inferred]`. No keys are stored (matches the contract). Host-key policy (TOFU pin) is a separate decision.

---

### 6. xterm.js WebGL on Android System WebView and WebView2

- Versions: `@xterm/xterm` **6.0.0**, `@xterm/addon-webgl` **0.19.0**, `@xterm/addon-fit` 0.11.0, `@xterm/addon-unicode11` 0.9.0 (others in the table above). TeleFlock's `package.json` already pins `^6.0.0 / ^0.19.0 / ^0.11.0` `[observed]`. The addons declare no `peerDependencies` `[observed]` package.json.
- **Canvas renderer**: removed in 6.0.0. Release notes: "#5105 Remove the canvas renderer — this addon no longer exists and we recommend using either the DOM renderer or WebGL". The addons tree at tag 6.0.0 has no `addon-canvas` `[source]` GitHub release 6.0.0 + `/repos/xtermjs/xterm.js/contents/addons?ref=6.0.0` `[observed]`. The fallback is therefore the **built-in DOM renderer**, which is what you get when no WebGL addon is loaded or after it is disposed.
- Other 6.0 breaking changes that matter: new VS Code-based viewport/scrollbar; `overviewRulerWidth` → `overviewRuler: { width }`; the alt→ctrl+arrow hack was removed (add keybindings yourself); `windowsMode`/`fastScrollModifier` were removed. 6.0 also adds DEC 2026 synchronized output, OSC 52 and an ESM build `[source]` release 6.0.0.
- **WebGL2 is required**: the addon throws `"WebGL2 not supported"` when `getContext('webgl2')` fails `[observed]` bundled addon-webgl.js. Android System WebView is Chromium (WebGL2 on GLES 3.0+ GPUs) and WebView2 is Edge Chromium. Both normally have WebGL2, but GPU blocklists, software rendering, RDP or old drivers can disable it `[inferred]`. Always wrap it in try/catch.
- **Context loss**: on `webglcontextlost` the addon calls `preventDefault()` and waits **3 s** for `webglcontextrestored`, then fires `onContextLoss` `[observed]` bundled addon-webgl.js. Android-specific loss reports exist (Chromium "Compositor background cleanup leads to WebGL context loss" 366045334; WebView-only loss 541084049/540886013) `[source]` issues.chromium.org. Assume loss on background/resume on Android.
- **Context cap**: Chromium caps active WebGL contexts per renderer and force-loses the **oldest** ("Too many active WebGL contexts. Oldest context will be lost") `[source]` chromium `webgl_rendering_context_base.cc:499-512` (cap from `webgl_preferences.max_active_webgl_contexts`). `WebglAddon.dispose()` does **not** release its context (xterm #6068, open since 2026-07-24), so pane churn eventually evicts a live terminal `[source]` https://github.com/xtermjs/xterm.js/issues/6068. ⇒ Use WebGL only for the focused or visible terminals, the DOM renderer for previews or tiles. On dispose, also call `loseContext()` (sketch below, `[inferred]` workaround).
```ts
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';

const term = new Terminal({ allowProposedApi: true /* unicode API is proposed */, scrollback: 5000 });
const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new Unicode11Addon());
term.unicode.activeVersion = '11';
term.open(el);

let webgl: WebglAddon | undefined;
function enableWebgl() {
  if (webgl) return;
  try {
    const a = new WebglAddon();
    a.onContextLoss(() => { releaseWebgl(); setTimeout(() => document.visibilityState === 'visible' && enableWebgl(), 1000); });
    term.loadAddon(a);            // throws if no WebGL2 → stays on DOM renderer
    webgl = a;
  } catch (e) { console.warn('xterm: WebGL2 unavailable, DOM renderer', e); }
}
function releaseWebgl() {
  const canvas = el.querySelector<HTMLCanvasElement>('.xterm-screen canvas');
  canvas?.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext(); // work around #6068 [inferred]
  webgl?.dispose(); webgl = undefined;                                             // DOM renderer takes over
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { enableWebgl(); fit.fit(); term.refresh(0, term.rows - 1); /* ask Rust for snapshot + resume */ }
  else { /* tell Rust to pause forwarding for this view; optionally releaseWebgl() on Android */ }
});
```
  `[inferred]` The snippet is not executed. API names (`onContextLoss`, `constructor(preserveDrawingBuffer?)`, `clearTextureAtlas`, `onChangeTextureAtlas`) are checked against `addon-webgl@0.19.0/typings` `[observed]`.
- WebView2 (Windows): WebGL2 is available with hardware acceleration. It can lose the context on GPU driver reset (TDR), sleep/resume or adapter change, so use the same `onContextLoss` path. A minimized window stops rAF; no special handling is needed `[inferred]`.
- Android WebView renderer death (not just context loss): wry does not handle `onRenderProcessGone` (§2.6). If it becomes an issue, subclass/wrap in `MainActivity.onWebViewCreate(webView)`. The `RustWebViewClient` is set by wry, so this needs a careful override `[inferred]`.

---

### 7. Decisions / TL;DR for implementation
1. Create one plugin crate, `crates/tauri-plugin-teleflock-android` (`links = "tauri-plugin-teleflock-android"`, Kotlin pkg `dev.teleflock.android`). It holds `KeepAliveService` (FGS `remoteMessaging`), `Notifications` (channels, actions, RemoteInput with `FLAG_MUTABLE` + explicit intent), `ActionReceiver` → JNI `RustBridge`, and `TeleFlockPlugin` (`startKeepAlive`, `stopKeepAlive`, `showNotification`, `cancel`, `batteryStatus`, `requestIgnoreBatteryOptimizations`, plus auto `checkPermissions/requestPermissions`). The full scratch implementation that compiled is at `.research/tauri-hello/research-scratch/fgs-test/tauri-plugin-teleflock-android/` (copy it in, don't rewrite).
2. Rust core: install `set_action_sink` before `Builder`. Start the FGS on SSH connect while the UI is visible, stop it on disconnect. Add `prevent_exit()` on `ExitRequested{code:None}` for Android. Set russh keepalive to 30 s.
3. Do **not** use `tauri-plugin-notification` on Android (its actions open the Activity; no FGS) or for Windows inline reply (buttons only, `inputValue` null, banner-only). Windows: own `windows` 0.62 toast code + HKCU AUMID/CustomActivator + COM `INotificationActivationCallback`.
4. Resolve the host via getaddrinfo (tokio `lookup_host`), never hickory. Cache the Tailscale IP as fallback. Tailscale SSH: `authenticate_none`, and handle the auth banner.
5. xterm 6 + WebGL 0.19: wrap in try/catch; DOM fallback on loss (3 s restore window); WebGL only for visible terminals; release contexts explicitly.

**Checks for the main agent / Toolchain to run on real hardware (not done here):** install the APK on an API 34/35/36/37 device and verify: FGS starts and survives 1 h+ of screen-off with an SSH keepalive; Doze (`adb shell dumpsys deviceidle force-idle`) keeps the socket; inline reply reaches Rust with the Activity destroyed; MagicDNS short name vs FQDN resolves through `getaddrinfo`; API 37 needs no `ACCESS_LOCAL_NETWORK` for 100.x; WebGL context loss and recovery after backgrounding. On Windows: inline reply from the banner, then from Action Center after the app exits, with the COM activator registered.

---

# Part B: Windows desktop (titlebar, Mica, tray, single-instance and deep links, Local and WSL modes)

## TeleFlock — Windows platform research (Tauri 2 / WebView2)

Researched 2026-10-20. Evidence tags: **[observed]** = I ran it (crates.io/npm/NuGet queries, local source reads of downloaded crates); **[source]** = file:line or URL; **[inferred]** = reasoning, verify on a real Windows box. Nothing here was executed on Windows (no Windows host available), so all runtime behavior is either [source] or [inferred].

Crate sources read from `~/.cargo/registry/src/index.crates.io-*/` (tauri 2.12.4, tauri-runtime-wry 2.12.2, tao 0.37.1, wry 0.57.0, window-vibrancy 0.8.1, tray-icon 0.25.1) and downloaded `.crate` tarballs in `/tmp/pw/` (tauri-utils 2.10.2, tauri-plugin-single-instance 2.5.4, tauri-plugin-deep-link 2.6.2, tauri-plugin-decorum 1.1.1, tauri-plugin-frame 1.1.8, tauri-plugin-snap-layout 1.0.9, portable-pty 0.9.0, interprocess 2.4.2, tauri-bundler 2.10.3).

### 0. Versions (as of 2026-10-20) [observed via crates.io / npm / NuGet API]

| Package | Latest | Notes |
|---|---|---|
| `tauri` | 2.12.4 | uses `tray-icon` 0.25, `muda` 0.20, `window-vibrancy` 0.8.1, `tauri-utils ~2.10.2` [source: tauri-2.12.4/Cargo.toml:237,348,356,417] |
| `tauri-build` | 2.7.3 | |
| `@tauri-apps/api` / `@tauri-apps/cli` | 2.12.4 / 2.12.3 | repo already has api 2.12.4 in node_modules |
| `tauri-utils` | 2.10.2 | |
| `tauri-bundler` | 2.10.3 | NSIS/MSI templates |
| `tao` / `wry` | 0.37.1 / 0.57.0 | |
| `window-vibrancy` | 0.8.1 | already pulled in by tauri on Windows |
| `tray-icon` | 0.26.1 (tauri pins 0.25) | don't add directly; use tauri's `tray-icon` feature |
| `tauri-plugin-single-instance` | 2.5.4 | feature `deep-link` |
| `tauri-plugin-deep-link` / npm `@tauri-apps/plugin-deep-link` | 2.6.2 / 2.6.2 | |
| `tauri-plugin-snap-layout` / npm `tauri-plugin-snap-layout` | 1.0.9 / 1.0.9 (2026-06-14, MIT) | element-tracking HTMAXBUTTON overlay |
| `tauri-plugin-frame` | 1.1.8 (2026-05-17, MIT) | fixed-geometry HTMAXBUTTON overlay |
| `tauri-plugin-decoration` | 3.0.5 (2026-08-14) | same technique |
| `tauri-plugin-window-controls` | 0.2.1 (2026-09-02) | same technique |
| `tauri-plugin-decorum` | 1.1.1 (2024-09-22, stale) | crates.io build fakes Win+Z keystrokes (see §1.5) |
| `portable-pty` | 0.9.0 (2025-02-11) | herdr vendors+patches it |
| `interprocess` | 2.4.6 (herdr locks 2.4.2) | |
| `tokio` | 1.54.0 | has `tokio::net::windows::named_pipe` |
| `windows-sys` / `windows` | 0.61.2 / 0.62.2 | |
| `windows-registry` | 0.100.0 (deep-link uses 0.6) | pick 0.6 to dedupe with deep-link |
| `image` / `tiny-skia` | 0.25.10 / 0.12.0 | badge rendering if not using pre-rendered sprites |
| `which` | 8.0.6 | herdr.exe lookup |
| NuGet `Microsoft.Windows.Console.ConPTY` | 1.25.260930003 stable (1.26.260930004-preview) | herdr pins 1.24.260710001 [source: herdr-src/packaging/windows/conpty.json:4-7] |

---

### 1. Custom titlebar

#### 1.1 Config (current repo already has the basics)
`src-tauri/tauri.conf.json` already sets `"decorations": false, "shadow": true, "minWidth": 1100` [observed]. Relevant `app.windows[]` keys [source: tauri-utils-2.10.2/src/config.rs]:
- `decorations` (2076) — `false` removes caption + borders.
- `shadow` (2148) — Windows: `false` has no effect on decorated windows; `true` on undecorated gives a 1 px white border on Win10 and **rounded corners + DWM shadow on Win11**.
- `transparent` (2067), `noRedirectionBitmap` (2103, Windows-only, sets `WS_EX_NOREDIRECTIONBITMAP`, avoids white flash for transparent windows).
- `titleBarStyle` (2108) — doc comment literally says "The style of the **macOS** title bar"; builder `title_bar_style()` and `hidden_title()` are `#[cfg(target_os = "macos")]` [source: tauri-2.12.4/src/window/mod.rs:776-786]; `Window::set_title_bar_style` is "**macOS only**" [source: window/mod.rs:2439-2440]. **`TitleBarStyle::Overlay` does NOT exist on Windows** in Tauri 2.12 — there is no Windows Controls Overlay (Electron-style `titleBarOverlay`) equivalent.

#### 1.2 Resize borders with `decorations: false`
- tao handles `WM_NCCALCSIZE` (returns 0 → borderless; when maximized clamps to monitor work area keeping 1 px for auto-hide taskbars; with undecorated-shadow insets the client rect) and `WM_NCHITTEST` (top-edge only when undecorated shadow is on, else full 8-direction hit test) [source: tao-0.37.1/src/platform_impl/windows/event_loop.rs:2074-2175].
- Because WebView2's child HWND covers the client area, the parent never sees hit tests there; **tauri-runtime-wry creates a transparent child window `TAURI_DRAG_RESIZE_BORDERS` with a frame-shaped region on top of the webview** that returns the resize hit codes, removed while maximized [source: tauri-runtime-wry-2.12.2/src/undecorated_resizing.rs:113-175, lib.rs:5214-5217]. So resizing works out of the box with `decorations:false` + `resizable:true`. No custom code needed.

#### 1.3 `data-tauri-drag-region` semantics (Tauri 2.12.4) [source: tauri-2.12.4/src/window/scripts/drag.js]
Injected script listens to `mousedown` on `document`:
- Left button, `e.detail === 1` → `invoke('plugin:window|start_dragging')`; `e.detail === 2` → `invoke('plugin:window|internal_toggle_maximize')` (Windows/Linux maximize on mousedown; macOS on mouseup). It calls `preventDefault()` + `stopImmediatePropagation()`.
- Attribute values (walks `composedPath()` upward):
  - bare / `""` / `"true"` → only clicks whose **target is that exact element** drag (children do NOT drag).
  - `"deep"` → any descendant drags.
  - `"false"` → explicitly blocks drag here and for ancestors.
  - Clickable elements (`A, BUTTON, INPUT, SELECT, TEXTAREA, LABEL, SUMMARY`, `contenteditable`, `tabindex != -1`, roles `button/link/menuitem/tab/checkbox/radio/switch/option`) **block** drag unless they themselves carry the attribute.
- Note: the official docs page still says children never inherit [source: tauri-docs window-customization.mdx:210] — outdated vs `"deep"` in 2.12.4 drag.js.
- Alternative: CSS `app-region: drag` / `no-drag` works natively because **wry 0.57 unconditionally calls `ICoreWebView2Settings9::SetIsNonClientRegionSupportEnabled(true)`** [source: wry-0.57.0/src/webview2/mod.rs:667-669]. WebView2 then treats those elements as a real caption: native drag, system menu on right-click, double-click maximize, touch/pen drag [source: https://github.com/MicrosoftEdge/WebView2Feedback/blob/main/specs/IsNonClientRegionSupportEnabled.md]. Tauri docs recommend `*[data-tauri-drag-region]{app-region:drag}` on Windows for touch/pen [source: tauri-docs window-customization.mdx:171-180]. Only `drag`/`no-drag` are implemented; WebView2 has no caption-button (`maximize`) region kind for windowed hosting, so this does **not** give Snap Layouts [source: same spec "draggable regions is the only non-client experience we have implemented"].
- Recommendation: titlebar container `data-tauri-drag-region="deep"` + `style="app-region: drag"`, interactive children (`button`, host pill, search) get `app-region: no-drag` (they already block JS drag by tag). Test that both mechanisms don't double-fire; if they do, keep only `app-region` [inferred].

#### 1.4 Capabilities & JS window controls
`core:window:default` includes only getters plus `allow-internal-toggle-maximize` (so double-click maximize works by default) [source: tauri-2.12.4/permissions/window/autogenerated/reference.md]. Add explicitly (identifiers verified in that file [observed]):
```json
// src-tauri/capabilities/default.json (desktop)
{
  "identifier": "desktop-main",
  "windows": ["main"],
  "platforms": ["windows", "linux", "macOS"],
  "permissions": [
    "core:default",
    "core:window:allow-start-dragging",
    "core:window:allow-start-resize-dragging",
    "core:window:allow-minimize",
    "core:window:allow-maximize",
    "core:window:allow-unmaximize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
    "core:window:allow-hide",
    "core:window:allow-show",
    "core:window:allow-set-focus",
    "core:window:allow-request-user-attention",
    "core:window:allow-set-overlay-icon",
    "core:window:allow-set-progress-bar",
    "core:window:allow-set-effects",
    "snap-layout:default"
  ]
}
```
```ts
import { getCurrentWindow } from '@tauri-apps/api/window';
const win = getCurrentWindow();
minBtn.onclick = () => win.minimize();
maxBtn.onclick = () => win.toggleMaximize();   // not reached when snap overlay covers it, see 1.5
closeBtn.onclick = () => win.close();          // emits CloseRequested → Rust can hide-to-tray
// keep maximize/restore glyph in sync
const sync = async () => maxBtn.dataset.state = (await win.isMaximized()) ? 'restore' : 'max';
await win.onResized(sync); sync();
```
Glyphs (Segoe Fluent Icons on Win11 / Segoe MDL2 Assets on Win10): minimize `\uE921`, maximize `\uE922`, restore `\uE923`, close `\uE8BB` [source: tauri-plugin-decorum-1.1.1/src/js/controls.js]. Caption buttons 46×32 epx is the Win11 standard [inferred].

#### 1.5 Snap Layouts flyout on maximize hover
- Requirement: Windows 11 shows the flyout only if the window answers `WM_NCHITTEST` with `HTMAXBUTTON` over the button; app min width should be ≤ 500 epx (ideally ≤ 330) or the flyout appears but snapping to zones fails [source: https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/ui/apply-snap-layout-menu]. **TeleFlock's current `minWidth: 1100` is too big — drop to ≤ 500 (e.g. 480) and make the layout collapse.**
- Tauri/tao cannot do it: tao's `WM_NCHITTEST` only returns resize codes [source: tao event_loop.rs:2128-2175]; upstream tauri#4531 / winit#3884 open (`status: upstream`) [source: https://github.com/Zbrooklyn/tauri-snap-layouts/blob/main/docs/WINDOWS-FRAMELESS-SNAP-LAYOUTS.md]. `undecorated_shadow` only affects shadow/insets, not caption buttons [source: tao platform/windows.rs:183,314; event_loop.rs:2113-2121].
- Working technique (all current plugins): a small invisible `WS_CHILD` HWND on top of the webview, exactly over the HTML maximize button, whose wndproc returns `HTMAXBUTTON` for `WM_NCHITTEST`; it handles `WM_NCMOUSEMOVE/WM_NCMOUSELEAVE` (`TrackMouseEvent(TME_LEAVE|TME_NONCLIENT)`) and `WM_NCLBUTTONDOWN/UP` and reports hover/click back to the page because the webview no longer sees the mouse there (CSS `:hover` and `onclick` on that button never fire) [source: tauri-plugin-frame-1.1.8/src/snap.rs:124-178, 280-340; tauri-plugin-snap-layout-1.0.9/src/snap.rs:219-260].
- Survey:
  | Option | Mechanism | Verdict |
  |---|---|---|
  | `tauri-plugin-snap-layout` 1.0.9 | overlay tracks a DOM element by id via injected `getBoundingClientRect` + `ResizeObserver` [source: guest-js/inject.ts:93,152]; maximize/restore wired natively via `SC_MAXIMIZE/SC_RESTORE`; mirrors `:hover` CSS into `.is-hovered`; Win11 ≥ 22000 only, no-op elsewhere | **Recommended** — layout-agnostic, React-friendly |
  | `tauri-plugin-frame` 1.1.8 | overlay positioned from right edge by `titlebar_height`, `button_width`, `right_index` (must match CSS exactly); emits `tauri-frame://snap/{mouseenter,mouseleave,mousedown,mouseup,click,mousemove}` | OK if buttons are fixed at the far right |
  | `tauri-plugin-decorum` 1.1.1 (crates.io) | after 620 ms hover invokes `show_snap_overlay` which presses **Win+Z then Alt via `enigo` 0.1.3** [source: decorum-1.1.1/src/commands.rs, src/js/controls.js:65-97] | Not recommended: synthetic input, stale, not the real flyout behavior |
  | Keep native frame (`DwmExtendFrameIntoClientArea` + custom `WM_NCCALCSIZE`) | OS draws real caption buttons | Robust but buttons not themeable; requires subclassing tao — not worth it |
  | In-house (~250 lines `windows-sys`) | copy the overlay approach (both plugins are MIT) | fallback if a plugin breaks on a Tauri upgrade |
- Wiring with `tauri-plugin-snap-layout`:
```toml
# src-tauri/Cargo.toml
[target.'cfg(windows)'.dependencies]
tauri-plugin-snap-layout = "1.0.9"
```
```rust
#[cfg(windows)]
{ builder = builder.plugin(tauri_plugin_snap_layout::init().button_id("tf-max").build()); }
```
```tsx
<button id="tf-max" className="caption-btn" aria-label="Maximize">{glyph}</button>
/* CSS: .caption-btn:hover, .caption-btn.is-hovered { background: var(--hover) } */
```
  JS API: `import { attach, detach, changeTarget, changePadding, isAttached } from 'tauri-plugin-snap-layout'` [source: README]. Capability `snap-layout:default`. Hidden button (`display:none`) shrinks the zone to 0×0 automatically [source: README].
- DPI gotcha: `outerPosition()` on an undecorated Win11 window includes the invisible ~8 px resize border; use `innerPosition()` for any manual geometry [source: Zbrooklyn write-up §2B].

#### 1.6 Shadow
`shadow: true` + `decorations:false` → Win11 rounded corners + shadow; Win10 1 px white border (style it or accept) [source: config.rs:2138-2148]. Runtime toggle `Window::set_shadow(bool)` re-applies the drag-resize child region [source: tauri-runtime-wry lib.rs:3403-3404].

---

### 2. Mica / Acrylic

#### 2.1 Config & API
```json
{ "label": "main", "decorations": false, "shadow": true,
  "transparent": true,
  "windowEffects": { "effects": ["mica"] } }
```
`WindowEffect` serde names are camelCase: `"mica" "micaDark" "micaLight" "tabbed" "tabbedDark" "tabbedLight" "blur" "acrylic"` [source: tauri-utils-2.10.2/src/lib.rs:69-145]. `windowEffects` = `{ effects: [..], state?, radius?, color?, interactive? }`; `color` affects only `blur`/`acrylic` on Win10 1903+, `state`/`radius` are macOS-only [source: config.rs:1872-1896]. "Requires the window to be transparent" [source: config.rs:2149-2158]. Runtime: `window.set_effects(EffectsBuilder::new().effect(Effect::Mica).build())` / `set_effects(None)` (runs on main thread) [source: window/mod.rs:2173-2180]; JS `win.setEffects({ effects: [Effect.Mica] })`, `win.clearEffects()`, perm `core:window:allow-set-effects`.

Tauri maps first matching Windows effect to `window_vibrancy::apply_*` [source: tauri-2.12.4/src/vibrancy/windows.rs:15-45].

#### 2.2 OS support (window-vibrancy 0.8.1) [source: window-vibrancy-0.8.1/src/windows.rs:62-170, 270-292]
| Effect | Win10 | Win11 21H2 (22000) | Win11 ≥ 22523 (22H2+) |
|---|---|---|---|
| `mica*` | Err `UnsupportedPlatformVersion` | undocumented `DWMWA_MICA_EFFECT=1` | `DWMWA_SYSTEMBACKDROP_TYPE = DWMSBT_MAINWINDOW` |
| `tabbed*` | Err | Err | `DWMSBT_TABBEDWINDOW` |
| `acrylic` | `SetWindowCompositionAttribute` (≥17763 / 1809) — **laggy resize/drag on 1903+** | SWCA — laggy on 22000 | `DWMSBT_TRANSIENTWINDOW` (documented API, no lag) |
| `blur` | SWCA (Win7/10) | laggy on 22621 | — |
`micaDark/micaLight` also set `DWMWA_USE_IMMERSIVE_DARK_MODE`. Lag notes [source: lib.rs:84-92 of window-vibrancy; tauri-utils lib.rs:134-145].

#### 2.3 Transparency requirements & caveats
- `transparent: true` → wry sets WebView2 `DefaultBackgroundColor` alpha 0 [source: wry-0.57.0/src/webview2/mod.rs:127,405,464]; tao enables `DwmEnableBlurBehindWindow` with empty region unless `noRedirectionBitmap` [source: tao window.rs:1203-1216]. The page itself must paint transparent: `html, body, #root { background: transparent }` [source: https://github.com/tauri-apps/window-vibrancy/issues/141 (maintainer repro)].
- `backgroundColor`: window-layer alpha ignored; webview-layer alpha only honored if exactly 0 (Win8+) [source: config.rs:2229-2237]. **Current `"backgroundColor": "#0b0b10"` would hide Mica** — must become `#0b0b1000` or be removed when Mica is enabled.
- Transparency is a creation-time attribute; you cannot turn it on later [inferred]. If Mica is a user setting, always create the window `transparent:true` and paint an opaque CSS background when the setting is off.
- Reports of Mica showing white/opaque on undecorated windows; maintainer couldn't repro on 23H2 [source: window-vibrancy#141]. Mica needs DWM frame; tao keeps frame styles when `shadow:true` [inferred] → test `decorations:false + shadow:true + transparent:true + mica` on 22H2/23H2/24H2.
- Transparent windows may flash white until first resize on some Win10 builds [source: tao#72 / tauri#8632]; try `noRedirectionBitmap: true` [source: config.rs:2098-2103].
- Mica falls back to a solid tint when the window is inactive (system behavior) [inferred].
- Performance: keep the xterm.js terminal surface **opaque** (WebGL renderer with `allowTransparency:false`); apply translucency only to chrome (titlebar/sidebar) [inferred]. Avoid `acrylic` on Win10/22000; prefer `mica` with solid fallback on Win10.
- Direct crate use (`window_vibrancy::apply_mica(&window, Some(true))`) is unnecessary — tauri already depends on window-vibrancy 0.8.1 [source: tauri Cargo.toml:417-418].

---

### 3. Tray, taskbar overlay, badge, attention, progress

#### 3.1 Tray (`tauri` feature `tray-icon`) [source: tauri-2.12.4/src/tray/mod.rs]
```toml
tauri = { workspace = true, features = ["tray-icon", "image-png"] }
```
```rust
use tauri::{tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState}, menu::{Menu, MenuItem}, image::Image, Manager};

let show = MenuItem::with_id(app, "show", "Show TeleFlock", true, None::<&str>)?;
let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
let menu = Menu::with_items(app, &[&show, &quit])?;
let tray = TrayIconBuilder::with_id("main")
    .icon(Image::from_bytes(include_bytes!("../icons/tray-idle.png"))?)
    .tooltip("TeleFlock — 3 running · 2 need you")
    .menu(&menu)
    .show_menu_on_left_click(false)          // default true (config.rs TrayIconConfig); we want left-click = show window
    .on_menu_event(|app, e| match e.id.as_ref() {
        "show" => { if let Some(w) = app.get_webview_window("main") { let _ = w.unminimize(); let _ = w.show(); let _ = w.set_focus(); } }
        "quit" => app.exit(0),
        _ => {}
    })
    .on_tray_icon_event(|tray, e| if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
        let app = tray.app_handle();
        if let Some(w) = app.get_webview_window("main") { let _ = w.show(); let _ = w.set_focus(); }
    })
    .build(app)?;
// later, from state updates:
app.tray_by_id("main").unwrap().set_icon(Some(badged_icon))?;   // TrayIcon::set_icon (tray/mod.rs:499)
app.tray_by_id("main").unwrap().set_tooltip(Some("…"))?;        // :523
```
Builder methods available: `new, with_id, menu, icon, tooltip, title, temp_dir_path, icon_as_template, show_menu_on_left_click, on_menu_event, on_tray_icon_event, build` (tray/mod.rs:216-386); events `Click{id,position,rect,button,button_state}`, `DoubleClick`, `Enter`, `Move`, `Leave` (tray/mod.rs:71-115). Hide-to-tray:
```rust
.on_window_event(|w, e| if let tauri::WindowEvent::CloseRequested { api, .. } = e { api.prevent_close(); let _ = w.hide(); })
// and in .run(|app, ev| if let RunEvent::ExitRequested { api, code: None, .. } = ev { api.prevent_exit(); })
```
- **No native tray badge on Windows** → render it into the icon. Simplest: ship pre-rendered RGBA sprites (state color orb × count 1–9, "9+") at 32×32 and swap with `set_icon`; or composite at runtime with `tiny-skia` 0.12 / `image` 0.25 into `Image::new_owned(rgba, 32, 32)` [source: tauri image/mod.rs:193]. Windows tray small-icon size is 16×16 @100% DPI, 32×32 @200% (`SM_CXSMICON`) — supply 32×32 [inferred]. Tooltip is truncated at 127 chars (`NOTIFYICONDATAW.szTip[128]`) [inferred].

#### 3.2 Taskbar overlay icon (Windows-only)
`Window::set_overlay_icon(Option<Image>)` — `#[cfg(target_os = "windows")]`, per window, `None` clears [source: window/mod.rs:2383-2394]; tao calls `ITaskbarList::SetOverlayIcon(hwnd, hicon, None)` and swallows errors [source: tao window.rs:1019-1030]. JS: `win.setOverlayIcon(bytesOrPath)` / `win.setOverlayIcon()` (perm `core:window:allow-set-overlay-icon`). Overlay renders at 16×16 small-icon size in the button corner [source: https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-itaskbarlist3-setoverlayicon]. Overlays are hidden when the user disables "Show badges on taskbar apps" (Win11) and the call is a no-op before the taskbar button exists — call after `show()` [inferred]. Recommended for the "needs-you" count on the taskbar button.

#### 3.3 `set_badge_count`
`Window::set_badge_count(Option<i64>)` — **Windows: unsupported (use overlay icon); Android: unsupported; iOS clamps to i32**; Linux uses `<name>.desktop` Unity launcher; macOS dock [source: window/mod.rs:2396-2407; @tauri-apps/api window.d.ts:1459]. `set_badge_label` is macOS-only [source: :2409-2418]. → TeleFlock: overlay icon on Windows, Android badge via notification channel (Android plugin territory).

#### 3.4 `request_user_attention` (taskbar flash)
`Window::request_user_attention(Some(UserAttentionType::Critical|Informational))`, no effect if already focused [source: window/mod.rs:2028-2047]. tao: `Critical` → `FlashWindowEx(FLASHW_ALL | FLASHW_TIMERNOFG, count=u32::MAX)` (flashes until foreground); `Informational` → `FLASHW_TRAY`, 4 flashes; `None` → `FLASHW_STOP` [source: tao window.rs:905-920]. JS `win.requestUserAttention(UserAttentionType.Critical)`.

#### 3.5 Taskbar progress
`Window::set_progress_bar(ProgressBarState { status: Option<ProgressBarStatus>, progress: Option<u64 /*0-100*/> })` [source: window/mod.rs:2420-2461]; tao maps `None→TBPF_NOPROGRESS, Indeterminate, Normal, Error, Paused` and `SetProgressValue(v,100)` [source: tao window.rs:990-1015]. JS `win.setProgressBar({ status: ProgressBarStatus.Indeterminate })`. Use `Paused` (yellow) for "needs you", `Error` (red) for stuck [inferred design].

---

### 4. Single instance + deep links

#### 4.1 Single instance
```toml
[target.'cfg(any(target_os = "macos", windows, target_os = "linux"))'.dependencies]
tauri-plugin-single-instance = { version = "2.5.4", features = ["deep-link"] }
```
```rust
let mut builder = tauri::Builder::default();
#[cfg(desktop)]
{
    // MUST be the first plugin: plugins run in registration order
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        // deep-link feature: argv already forwarded to deep-link (emits deep-link://new-url) before this runs
        if let Some(w) = app.get_webview_window("main") { let _ = w.unminimize(); let _ = w.show(); let _ = w.set_focus(); }
    }));
}
builder = builder.plugin(tauri_plugin_deep_link::init());
```
- "Register it first among your app's plugins" [source: single-instance-2.5.4/src/lib.rs (Builder::build doc), README]. Android/iOS unsupported [source: README table].
- Windows impl: named mutex `{identifier}-sim` via `CreateMutexW`; if `ERROR_ALREADY_EXISTS`, `FindWindowW("{id}-sic","{id}-siw")` and sends argv+cwd via `WM_COPYDATA` (`SendMessageTimeoutW`), then `cleanup_before_exit(); std::process::exit(0)` — the second instance never reaches `run` [source: platform_impl/windows.rs:62-130, 181]. Identifier = `dev.teleflock.app` → mutex `dev.teleflock.app-sim` (session-local namespace, no `Global\` prefix) [inferred from code]. Feature `semver` appends `_<semver-compat>` so different majors can coexist.
- With `deep-link` feature the callback first calls `deep_link.handle_cli_arguments(args)` [source: lib.rs:79-82,105-108].

#### 4.2 Deep links (`tauri-plugin-deep-link` 2.6.2)
Config:
```json
"plugins": {
  "deep-link": {
    "desktop": { "schemes": ["teleflock"] },
    "mobile":  [ { "scheme": ["teleflock"], "appLink": false } ]
  }
}
```
- `mobile[]` entries: `scheme` (**defaults to `["https","http"]` if omitted**), `host`, `pathPattern`, `pathPrefix`, `pathSuffix`, `appLink` (defaults to `is_web_link && host.is_some()`); web links require a host [source: deep-link-2.6.2/src/config.rs:11-66]. `desktop` is one `{schemes:[…]}` or a list [source: config.rs:84-108].
- Windows/Linux: OS starts a **new process with the URL as the only argument**; `handle_cli_arguments` accepts only `argv == [exe, url]` and only schemes listed in config (runtime-registered schemes are NOT matched — check argv yourself) and emits `deep-link://new-url` [source: lib.rs:196-235]. Without single-instance you get a second app instance.
- Runtime registration (Windows): `app.deep_link().register("teleflock")?` writes `HKCU\Software\Classes\teleflock` (`""="URL:<identifier> protocol"`, `"URL Protocol"=""`, `DefaultIcon="<exe>,0"`, `shell\open\command="\"<exe>\" \"%1\""`); `unregister`, `is_registered`, `register_all` (all config schemes; use in dev since links only work for installed apps) [source: lib.rs:249-300,375-390; https://v2.tauri.app/plugin/deep-linking/]. macOS/Android/iOS: config-only.
- Installers register automatically: NSIS writes the same four values under `SHCTX` (HKCU for `currentUser` install mode, HKLM for perMachine) and deletes them on uninstall [source: tauri-bundler-2.10.3/src/bundle/windows/nsis/installer.nsi:686-692,821-825; nsis/mod.rs:565-571]; MSI too [source: msi/main.wxs:135-137].
- Listen:
```ts
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
const start = await getCurrent();               // cold start
await onOpenUrl(urls => router.open(urls[0]));  // warm (via single-instance on Windows)
```
  Rust: `app.deep_link().get_current()?`, `app.deep_link().on_open_url(|e| e.urls())`. Capabilities: `core:event:default`, `deep-link:default` (= `allow-get-current`); add `deep-link:allow-register|unregister|is-registered` only if called from JS [source: deep-linking docs permission table].
- Test: `start teleflock://agent/host1/w1:p2` [source: deep-linking docs].
- Android: build.rs rewrites AndroidManifest (`DEEP LINK PLUGIN` block in `<activity>`) with `<intent-filter [android:autoVerify="true" only for app links]>` + `VIEW`, `org.chromium.arc.intent.action.VIEW`, `DEFAULT`, `BROWSABLE`, `<data android:scheme/host/path*>` [source: deep-link-2.6.2/build.rs:12-38,100-110]; runtime via `DeepLinkPlugin.kt` `onNewIntent` [source: android/src/main/java/DeepLinkPlugin.kt:52,92]. App Links need `/.well-known/assetlinks.json` (package name = identifier with `-`→`_`, SHA-256 cert fingerprints) — custom scheme needs none [source: plugin README / docs]. Trigger: `adb shell am start -a android.intent.action.VIEW -d teleflock://x dev.teleflock.app`.

---

### 5. Windows Local mode (herdr on Windows)

#### 5.1 Does herdr run natively? — Yes, GA
- "Native Windows support is generally available." Uses ConPTY; install `powershell -ExecutionPolicy Bypass -c "irm https://herdr.dev/install.ps1 | iex"` (or `install.cmd`); releases under `%USERPROFILE%\.herdr\packages\standalone\releases`, active release on PATH, **`%LOCALAPPDATA%\Programs\Herdr\bin` is a junction to the active release** [source: herdr-src/docs/next/website/src/content/docs/windows-beta.mdx:6-24; distribution/install.ps1:599-600,726]. CHANGELOG: "Windows support is now generally available through stable releases" [source: docs/next/CHANGELOG.md:88].
- Not supported on Windows: **direct terminal attach (`herdr terminal attach`)**, Windows as `--remote` target, live handoff, Unix fd handoff, foreground process groups [source: windows-beta.mdx:116-126; src/client/startup.rs:22 "direct terminal attach is not supported on Windows yet"; src/remote.rs:15-19 `remote-client-bridge` errors on Windows].
- Package = `herdr.exe` + app-local ConPTY (`conpty/conpty.dll`, `conpty/x64/OpenConsole.exe`, `conpty/arm64/OpenConsole.exe`, `herdr-conpty.json`), hash-verified; `HERDR_WINDOWS_CONPTY=system` bypasses [source: windows-beta.mdx:108; vendor/portable-pty/src/win/psuedocon.rs:127-203].

#### 5.2 IPC transport: named pipes via `interprocess`
- `interprocess = "2.4.2"`; `LocalListener/LocalStream = interprocess::local_socket::{Listener,Stream}` [source: herdr Cargo.toml:31; src/ipc.rs:10-11].
- Windows: `path.to_string_lossy().to_ns_name::<GenericNamespaced>()` → interprocess prepends `\\.\pipe\` [source: ipc.rs:44-51,66-78; interprocess-2.4.2/src/local_socket/name/type.rs:93-110]. **Pipe name = `\\.\pipe\` + the full filesystem path of the `.sock`**, e.g. `\\.\pipe\C:\Users\alice\AppData\Roaming\herdr\herdr.sock`. herdr also writes a **marker file** at the real path containing `"<pid>:<nanos>"` for ownership/stale detection [source: ipc.rs:76,159,319-326]. Integrations confirm: `process.platform === "win32" ? \`\\\\.\\pipe\\${HERDR_SOCKET_PATH}\`` [source: src/integration/assets/omp/herdr-agent-state.ts:13-14]. Backslashes inside a pipe name are accepted by NPFS in practice (herdr relies on it) [inferred].
- Socket paths [source: src/session.rs:161-185; src/config/io.rs:22-59; docs socket-api.mdx:671-689]:
  - config dir = `%XDG_CONFIG_HOME%\herdr` if set, else `%APPDATA%\herdr` (fallbacks `%USERPROFILE%\AppData\Roaming\herdr`, `$HOME/.config/herdr`, temp). Debug builds of herdr use `herdr-dev`.
  - JSON API: `<config>\herdr.sock`; named session: `<config>\sessions\<name>\herdr.sock`; session `"default"` ≡ root [source: session.rs:11,459-462].
  - Binary client protocol (internal, versioned): `<config>\herdr-client.sock` (same session layout).
  - Overrides: `--session`, then `HERDR_SOCKET_PATH`, then `HERDR_SESSION` [source: socket-api.mdx:682-687; session.rs:173-181].
  - Don't replicate resolution: run `herdr.exe session list --json` → `{"sessions":[{name,default,running,socket_path,session_dir}]}` and prefix `\\.\pipe\` [source: src/cli.rs:454-464; session.rs:21-27].
- API pipe uses the default named-pipe DACL (no SDDL) [source: api/server.rs:86 → ipc.rs:54-79]; private bridge pipes use `D:P(A;;GA;;;SY)(A;;GA;;;OW)` [source: ipc.rs:136-162]. Same user = full access either way.
- Wire: newline-delimited JSON, one request per line `{"id":"req_1","method":"ping","params":{}}` → `{"id":"req_1","result":{"type":"pong",…}}`; event subscriptions keep the connection open [source: socket-api.mdx:652-669]. Identical to the Unix socket protocol, so TeleFlock's herdr client code is transport-agnostic.

#### 5.3 What TeleFlock connects to in Local mode
| Need | Local-mode transport | Notes |
|---|---|---|
| herdr JSON API (lists, events, actions) | **direct named pipe** `\\.\pipe\<socket_path>` from Rust core | no relay, no SSH; same NDJSON code as remote |
| herdr JSON CLI (if core uses CLI exec) | spawn `herdr.exe <args>` with `CREATE_NO_WINDOW`, piped stdio | mirrors SSH exec channels 1:1 |
| Terminal stream for a pane | spawn `herdr.exe terminal session control <pane> --takeover --cols C --rows R` with **plain pipes (no ConPTY)** | stdout NDJSON `{"type":"terminal.frame","seq","encoding":"ansi","width","height","full","bytes":<b64>}` … `{"type":"terminal.closed","reason"}`; stdin NDJSON `{"type":"terminal.input","text"|"bytes":b64}`, `{"type":"terminal.resize","cols","rows","cell_width_px"?,"cell_height_px"?}`, `{"type":"terminal.scroll","direction":"up"|"down","lines","source":"wheel"|"page_key",…}`, `{"type":"terminal.release"}`; read-only variant `terminal session observe` [source: src/client/terminal_sessions.rs:18-70,122-277; docs persistence-remote.mdx:135-157]. Code path is not `cfg(unix)`-gated (uses `interprocess` LocalStream) [source] but **unverified on Windows** — verify early; fall back to full `herdr.exe` TUI inside ConPTY if it fails. |
| Start server if not running | spawn `herdr.exe server` detached | herdr's own daemon launch: stdio null, `DETACHED_PROCESS`, env `HERDR_STARTUP_CWD=<cwd>`; if the current job object kills-on-close it launches through WMI `Win32_Process.Create` to escape the job [source: src/server/autodetect.rs:194-241; src/platform/windows.rs:919-992,1091-1095]. Only the plain `herdr` client auto-starts the server [source: autodetect.rs:295-319]; API CLI calls report `server_not_running` instead [source: CHANGELOG.md:232]. |
| Locate `herdr.exe` | `which::which("herdr")` → fallback `%LOCALAPPDATA%\Programs\Herdr\bin\herdr.exe` | GUI apps launched before install see stale PATH [inferred] |

Named-pipe client (tokio, no extra crate):
```rust
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
use windows_sys::Win32::Foundation::ERROR_PIPE_BUSY; // 231

fn pipe_name(socket_path: &str) -> String { format!(r"\\.\pipe\{socket_path}") }

async fn connect(name: &str) -> std::io::Result<NamedPipeClient> {
    loop {
        match ClientOptions::new().open(name) {
            Ok(c) => return Ok(c),
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) =>
                tokio::time::sleep(std::time::Duration::from_millis(50)).await,
            Err(e) => return Err(e), // NotFound (os 2) => server not running
        }
    }
}
// then: tokio::io::split + BufReader::lines() for NDJSON
```
Closed-pipe errors to treat as disconnect: os 6, 109 (`ERROR_BROKEN_PIPE`), 232, 233 [source: herdr ipc.rs:275-278]. Alternative: `interprocess` 2.4.6 with `tokio` feature and `GenericNamespaced` (exact herdr parity) [inferred].

Spawning console tools from a GUI-subsystem Tauri exe (`windows_subsystem = "windows"` in release) flashes a console window unless `CREATE_NO_WINDOW`:
```rust
use std::os::windows::process::CommandExt;          // std
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
let mut c = tokio::process::Command::new(herdr_exe); // tokio Command has inherent creation_flags on Windows
c.args(["terminal","session","control",pane,"--takeover","--cols","120","--rows","40"])
 .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
 .creation_flags(CREATE_NO_WINDOW).kill_on_drop(true);
```

#### 5.4 ConPTY via `portable-pty` 0.9.0 (only needed for full-TUI attach / raw shells)
API [source: portable-pty-0.9.0/src/lib.rs:63-117,163-166,400; cmdbuilder.rs:215-342]:
```rust
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
let pair = native_pty_system().openpty(PtySize { rows: 40, cols: 120, pixel_width: 0, pixel_height: 0 })?;
let mut cmd = CommandBuilder::new(herdr_exe);   // new_default_prog() = user shell
cmd.cwd(dir); cmd.env("HERDR_SESSION", "work");
let mut child = pair.slave.spawn_command(cmd)?; // Box<dyn Child + Send + Sync>
drop(pair.slave);
let mut reader = pair.master.try_clone_reader()?;   // BLOCKING Read → dedicated std::thread
let mut writer = pair.master.take_writer()?;        // once
std::thread::spawn(move || {
    let mut buf = [0u8; 16 * 1024];
    loop { match reader.read(&mut buf) { Ok(0) | Err(_) => break, Ok(n) => { let _ = tx.blocking_send(buf[..n].to_vec()); } } }
});
pair.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?; // → ResizePseudoConsole(COORD)
writer.write_all(b"\x03")?;                          // Ctrl+C
let killer = child.clone_killer();                   // TerminateProcess(…, 1)
```
Gotchas:
- Requires Windows 10 1809 (build 17763); portable-pty `panic!`s ("this system does not support conpty. Windows 10 October 2018 or newer is required") if `kernel32` lacks the exports [source: psuedocon.rs:45-50].
- Flags used: `PSUEDOCONSOLE_INHERIT_CURSOR | PSEUDOCONSOLE_RESIZE_QUIRK | PSEUDOCONSOLE_WIN32_INPUT_MODE` [source: psuedocon.rs:83-90]. Win32-input-mode makes ConPTY request `CSI ?9001h`; xterm.js ignores it and plain VT input still works [inferred]. Pixel sizes are ignored (COORD only) [source: conpty.rs:54-69].
- **DLL loading**: upstream loads a bare `"conpty.dll"` via DLL search order, preferring it over kernel32 (wezterm's sideload approach: ship `conpty.dll` + `OpenConsole.exe` next to the exe) [source: psuedocon.rs:52-60]. That can pick up another app's conpty.dll from PATH; herdr patched it to hash-verify and `LoadLibraryExW(abs, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|LOAD_LIBRARY_SEARCH_SYSTEM32)` [source: herdr vendor/portable-pty.patches.md:7-42; vendor/.../psuedocon.rs:103-155]. For TeleFlock: either call `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS)` at startup (excludes PATH/CWD) [inferred], or vendor herdr's patch. Bundling a modern ConPTY (NuGet `Microsoft.Windows.Console.ConPTY` 1.25.260930003, MIT; layout `conpty.dll`, `x64/OpenConsole.exe`, `arm64/OpenConsole.exe`) fixes old-Win10 ConPTY dropping Kitty keyboard sequences [source: windows-beta.mdx:108; herdr packaging/windows/conpty.json].
- EOF/teardown: ConPTY may not EOF the output pipe when the child exits until `ClosePseudoConsole`; and `ClosePseudoConsole` can block until output is drained → wait child in a thread, then drop `master` **while the reader thread keeps reading** [source: https://github.com/microsoft/terminal/discussions/17716; https://github.com/andfoy/pywinpty/issues/565].
- ConPTY re-renders output (not byte-transparent): OSC/graphics may be altered unless passthrough mode (newer ConPTY) [inferred]; herdr defaults `host_cursor="auto"` (drawn cursor) because of ConPTY cursor flicker [source: windows-beta.mdx:89-102].
- `0x03` on the input pipe is turned into `CTRL_C_EVENT` for attached console processes with processed input on [inferred].
- Malformed env blocks (REG_MULTI_SZ / empty names) break `CreateProcessW` with error 87 in upstream 0.9.0 — herdr patch 0003 [source: portable-pty.patches.md:88-131]; prefer `env_clear()` + explicit env if you hit it.
- Bytes from the reader can split UTF-8 sequences — pass `Uint8Array` to `term.write()` (xterm.js handles partial sequences) [inferred].

---

### 6. WSL mode

#### 6.1 Listing distros
- `wsl.exe --list --quiet` / `-l -q` / `--list --verbose` write **UTF-16LE** to pipes by default; setting env **`WSL_UTF8=1`** makes wsl.exe emit UTF-8 [source: https://github.com/microsoft/vscode/issues/276253; https://github.com/microsoft/WSL/issues/4607]. Set `WSL_UTF8=1` on the child *and* decode defensively (old inbox wsl.exe may ignore it [inferred]):
```rust
fn decode_wsl(b: &[u8]) -> String {
    let utf16 = b.starts_with(&[0xFF, 0xFE])
        || (b.len() >= 4 && b.iter().skip(1).step_by(2).take(64).all(|&x| x == 0));
    if utf16 {
        let u: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&u).trim_start_matches('\u{FEFF}').to_owned()
    } else { String::from_utf8_lossy(b).into_owned() }
}
let out = std::process::Command::new("wsl.exe").args(["--list", "--quiet"])
    .env("WSL_UTF8", "1").creation_flags(CREATE_NO_WINDOW).output()?;
let distros: Vec<String> = decode_wsl(&out.stdout).lines()
    .map(|l| l.trim_matches(|c: char| c.is_whitespace() || c == '\0').to_owned())
    .filter(|l| !l.is_empty()).collect();
```
  Also decode `stderr` the same way (wsl.exe's own error text). `--list --verbose` columns `NAME STATE VERSION`, default marked `*`; parse tokens from the right [source: https://learn.microsoft.com/windows/wsl/basic-commands]. `--list --running --quiet` for running ones. Consider hiding `docker-desktop*` [inferred].
- Registry (no process spawn, no encoding issue): `HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss` → value `DefaultDistribution` (GUID); subkeys `{GUID}` with `DistributionName` (REG_SZ), `BasePath`, `Version` (DWORD 1/2), `State`, `DefaultUid`, `Flags` [source: https://renenyffenegger.ch/notes/Windows/registry/tree/HKEY_CURRENT_USER/Software/Microsoft/Windows/CurrentVersion/Lxss/index; https://github.com/spatel-DFIR/Everything-DFIR/blob/main/WSL/03%20-%20WSL%20Registry%20&%20Configuration%20Deep-Dive.md]. Running state is not in the registry.
```rust
let lxss = windows_registry::CURRENT_USER.open(r"Software\Microsoft\Windows\CurrentVersion\Lxss")?;
let default_guid = lxss.get_string("DefaultDistribution").ok();
for guid in lxss.keys()? { let k = lxss.open(&guid)?; let name = k.get_string("DistributionName")?; let ver = k.get_u32("Version").unwrap_or(2); /* … */ }
```
  (`windows-registry` 0.6 API names `keys/open/get_string/get_u32` [inferred — check docs.rs]).

#### 6.2 Running commands
- `wsl.exe -d <distro> --exec <prog> <args…>` runs argv directly (no shell); `wsl.exe -d <distro> -- <cmd>` goes through the user's default shell; `--cd <dir>`, `-u <user>` [source: basic-commands docs]. Neither is a login shell → `~/.local/bin` (herdr's install dir) is usually **not on PATH** [inferred]. herdr itself invokes remote herdr as `"$HOME/.local/bin/herdr"` [source: herdr src/remote/attach.rs:191-192]. Resolve once: `wsl.exe -d X --exec sh -lc 'command -v herdr || echo "$HOME/.local/bin/herdr"'`, then use `--exec /home/u/.local/bin/herdr …` (no quoting layer).
- Always `creation_flags(CREATE_NO_WINDOW)`; pipe stdio. Payload bytes from Linux programs pass through wsl.exe pipes unchanged (UTF-8) — only wsl.exe's own messages are UTF-16 [inferred from §6.1 sources]. Send complex data via stdin (NDJSON), not argv (Windows→wsl.exe→Linux argv quoting is lossy for exotic chars) [inferred].
- Windows env vars do not reach Linux unless listed in `WSLENV` (e.g. `WSLENV=HERDR_SESSION/u`) [inferred; documented in MS "Share environment vars between WSL and Windows" blog].
- Process spawn cost: cold VM boot is seconds; prefer **long-lived** wsl.exe children (one per terminal stream + one control channel) over per-request exec [inferred].
- **Distro idle shutdown kills herdr's server**: when the last wsl.exe session ends the distro stops after `instanceIdleTimeout` (default 15000 ms, `[general]` in `%UserProfile%\.wslconfig`, `-1` disables) and the VM after `vmIdleTimeout` (60000 ms) [source: https://github.com/MicrosoftDocs/WSL/blob/main/WSL/wsl-config.md (General settings table, line ~283; wsl2 table ~248)]; background jobs/tmux/systemd services get killed [source: https://github.com/microsoft/WSL/issues/8854, /9667, /8161]. TeleFlock must keep a long-lived `wsl.exe` child alive while connected (e.g. the control bridge), and offer to set `instanceIdleTimeout=-1` (with explanation) for persistence.

#### 6.3 PTY through wsl.exe inside ConPTY
`CommandBuilder::new("wsl.exe")` + `args(["-d", distro, "--cd", "~", "--exec", herdr_path])` spawned in ConPTY: wsl.exe sees a console, allocates a Linux pty and relays VT + resize (same path Windows Terminal uses) [inferred]. Two VT layers (ConPTY re-render + Linux pty) → slight latency/quirks; prefer the pipe-based `terminal session control` (§6.5).

#### 6.4 Networking Windows → WSL2
- NAT (default): `localhostForwarding` default `true` — ports bound to wildcard or localhost in WSL2 reachable from Windows at `localhost:port` (use `127.0.0.1`) [source: wsl-config.md:239]. 
- Mirrored: `[wsl2] networkingMode=mirrored` in `.wslconfig`, Windows 11 22H2+; `127.0.0.1` works both directions, `::1` not supported; `localhostForwarding` ignored; `hostAddressLoopback`, `ignoredPorts`; Hyper-V firewall on by default (WSL 2.0.9+) [source: wsl-config.md:250,300-301,336; https://learn.microsoft.com/en-us/windows/wsl/networking §Mirrored]. Modes: `none|nat|bridged(deprecated)|mirrored|consomme`; NAT falls back to consomme on failure from WSL 2.3.25 [source: wsl-config.md:250].
- Any TCP relay inside WSL is reachable by every local Windows process (and LAN in mirrored mode if bound to 0.0.0.0) → bind `127.0.0.1` and require a per-launch token [inferred].

#### 6.5 Reaching herdr's Unix socket inside WSL
- No direct access: Windows↔Linux AF_UNIX interop works only on WSL1, not WSL2 (it's a VM; `\\wsl.localhost\<distro>\…` 9P paths don't carry sockets) [source: https://github.com/microsoft/WSL/issues/5961; https://devblogs.microsoft.com/commandline/windowswsl-interop-with-af_unix/].
- Options:
  1. **CLI exec via wsl.exe** — `wsl.exe -d X --exec <herdr> <json-cli …>` (simple, same as SSH exec channels; high per-call latency).
  2. **Terminal streams via wsl.exe stdio** — `wsl.exe -d X --exec <herdr> terminal session control <pane> --takeover --cols C --rows R` with pipes; identical NDJSON protocol to Local mode (§5.3). Recommended.
  3. **JSON API / event stream via stdio bridge** — herdr has no JSON-API stdio bridge; its `remote-client-bridge` subcommand bridges stdin/stdout to **`herdr-client.sock` (binary client protocol)** and auto-starts the server [source: src/remote/host_unix.rs:8-74; src/main.rs:541-543] — internal protocol, don't depend on it. Use TeleFlock's own relay binary (already deployed on SSH hosts) in a `--stdio` mode launched via `wsl.exe -d X --exec <relay> --stdio`, which also keeps the distro alive. Fallback without a relay: `socat - UNIX-CONNECT:$HOME/.config/herdr/herdr.sock` (not installed by default) [inferred].
  4. **Localhost TCP relay** — relay in WSL listens on `127.0.0.1:<port>`, Windows connects via forwarding (§6.4). Works, but needs port management + auth token and still needs a wsl.exe keep-alive.
- Recommendation: WSL mode = one long-lived `wsl.exe --exec <relay> --stdio` control channel (JSON API + events + keep-alive) + one `wsl.exe --exec herdr terminal session control …` per open terminal. No TCP, no ConPTY.

---

### 7. Recommended TeleFlock decisions (summary)
1. Titlebar: `decorations:false`, `shadow:true`, drag via `data-tauri-drag-region="deep"` + `app-region: drag/no-drag`; Snap Layouts via `tauri-plugin-snap-layout` 1.0.9 (`button_id("tf-max")`), **lower `minWidth` to ≤ 500**.
2. Mica: opt-in, Win11-only, window created `transparent:true` with CSS-opaque fallback; keep terminal opaque; never acrylic on Win10/22000.
3. Tray: Rust `TrayIconBuilder`, badge = swapped pre-rendered 32×32 icons; taskbar = `set_overlay_icon` (16×16) for needs-you count, `request_user_attention(Critical)` on new needs-you, `set_progress_bar` for aggregate state.
4. `tauri-plugin-single-instance` (feature `deep-link`) first, then `tauri-plugin-deep-link` with scheme `teleflock` (desktop + mobile `appLink:false`).
5. Local mode: JSON API over `\\.\pipe\<socket_path from herdr session list --json>`; terminals via `herdr.exe terminal session control` pipes (verify on Windows first; ConPTY + full TUI as fallback); start server with detached `herdr.exe server`.
6. WSL mode: distro list via registry (+ `wsl.exe -l -q` with `WSL_UTF8=1` + UTF-16 fallback decode); everything over long-lived `wsl.exe --exec` stdio; handle `instanceIdleTimeout`.

Open verification items needing a Windows 11 box: §1.3 double-fire of `app-region` + JS drag; §1.5 plugin with WebView2 + DPI 150%; §2.3 Mica on undecorated; §5.3 `terminal session control` on native Windows; §6.2 env/PATH inside `wsl.exe --exec`.

---

# Part C: russh against Tailscale SSH, crypto backends, and recommended crate versions

## TeleFlock platform notes: russh ↔ Tailscale SSH, and crate versions

Research date 2026-10-20. Host `aron-dev` (100.121.246.107), tailscale 1.104.1, OpenSSH 10.0p2 (Debian 13).
Tags: `[observed]` = I ran it here; `[source]` = file:line or URL; `[inferred]` = my reasoning, not verified.

Scratch probe (throwaway; safe to delete): `.research/tauri-hello/research-scratch/russh-probe` (`src/main.rs` client probe, `src/bin/fakets.rs` fake "Tailscale-like" server, `dead.sh`, `hold.sh`, `xbuild.sh`). Build dir: `/root/TeleFlock/target/PlatRussh`.

---

### 0. TL;DR for implementers

1. **Pin `russh = "0.64.1"`**. `Handler::check_server_key` takes `&PublicKeyOrCertificate` (changed in 0.63), all handler methods are native `async fn` (no `#[async_trait]` since 0.50) [source].
2. **Tailscale SSH auth = SSH `none` method. The server never offers keyboard-interactive.** Check mode = `USERAUTH_BANNER` with the login URL, then the server **keeps the `none` request unanswered for up to 30 minutes** until the user approves in a browser [source]. In TeleFlock: show `auth_banner` text plus the extracted URL, leave `authenticate_none` pending, give the user a Cancel button, and use a ≥31 min timeout.
3. **Do NOT set `client::Config::keepalive_interval` on 0.64.1 when the auth can block.** I measured a **CPU busy-loop (~100 % of a core)** while auth was pending with keepalive set: user 4.13 s over 5.06 s wall. The same run with no keepalive used 0.019 s. Busy-looping for 30 minutes on a phone is a battery problem. Workaround: leave `keepalive_interval: None` and run your own `Handle::send_ping()` / `send_keepalive(true)` timer after auth succeeds (§2.6) [observed].
4. **If the server closes during auth, `authenticate_none` returns `Ok(Failure { remaining_methods: [] })`, not `Err`** [observed]. Tailscale denials show up this way: a `tailscale: …` banner, then EOF. Treat "empty methods + `handle.is_closed()`" as "server ended auth" and show the last banner as the reason.
5. **Connecting to your own Tailscale IP does not reach Tailscale SSH.** On Linux the kernel routes it via `lo` to the system sshd [observed]. Tailscale SSH only answers TCP/22 packets that arrive from the tailnet through netstack interception [source]. A TeleFlock "connect to self" test therefore tests OpenSSH, not Tailscale.
6. Port forwarding (`direct-tcpip`) through Tailscale SSH is allowed only when the policy action sets `allowLocalPortForwarding`. This tailnet's policy does set it [observed: `tailscale debug netmap`]. The host can also turn it off with `TS_SSH_DISABLE_FORWARDING` [source]. A rejection arrives as channel-open failure `AdministrativelyProhibited` ("port forwarding is disabled") [source].
7. Host keys: Tailscale SSH **reuses `/etc/ssh/ssh_host_{rsa,ecdsa,ed25519}_key`** if they exist, otherwise it generates keys in `$VARROOT/ssh/`. It publishes them to peers as `Peer[*].sshHostKeys` in `tailscale status --json` [source + observed]. Recommendation: TOFU pinning keyed by Tailscale node identity, pre-seeded from `tailscale status --json` on Windows.
8. Crypto backend: **`ring` cross-builds for both targets with no extra tools**. `aws-lc-rs` (the russh default) builds for Android with the NDK alone, but for `x86_64-pc-windows-msvc` via cargo-xwin it **fails without NASM** unless `AWS_LC_SYS_PREBUILT_NASM=1` is set [observed].

---

### 1. Probe setup and environment facts

#### 1.1 What I could and could not test
- Directive from Main/Toolchain (overrides the original task): **no connection to any tailnet peer, and no Tailscale SSH auth on 100.121.246.107**, because check mode could trigger a login prompt on the user's side. All Tailscale SSH behaviour below is therefore `[source]` and is marked **"verify on a real peer later"**.
- The only contact with 100.121.246.107:22 was reading the raw SSH identification line, before the directive arrived. It came from **OpenSSH**, not Tailscale:
  ```
  $ bash -c 'exec 3<>/dev/tcp/100.121.246.107/22; IFS= read -r l <&3; printf "%q\n" "$l"'
  $'SSH-2.0-OpenSSH_10.0p2 Debian-7+deb13u4\r'
  $ ip route get 100.121.246.107
  local 100.121.246.107 dev lo table local src 100.121.246.107 uid 0
  $ (sleep 2) | tailscale nc 100.121.246.107 22 | od -c   # also OpenSSH
  S S H - 2 . 0 - O p e n S S H _ 1 0 . 0 p 2 ...
  ```
  `[observed]` Packets to your own Tailscale IP never pass through the TUN, so tailscaled's netstack interception doesn't see them. The interception is `shouldProcessInbound` → `ns.lb.ShouldInterceptTCPPort(dport)` (`wgengine/netstack/netstack.go:1255,1278`) and applies only to inbound tailnet packets [source].
- The russh mechanics were tested against a **throwaway private sshd** (`/usr/sbin/sshd -D -e -f .research/tauri-hello/research-scratch/russh-probe/sshd_config`) on `127.0.0.1:2222`. It used its own host key, `AuthorizedKeysFile .research/tauri-hello/research-scratch/russh-probe/authorized_keys`, `StrictModes no`, `AllowTcpForwarding yes`, `Banner .research/tauri-hello/research-scratch/russh-probe/banner.txt` and `KbdInteractiveAuthentication no`. `/etc/ssh` and `/root/.ssh` were not touched, and the server was killed afterwards [observed].
- Check-mode client behaviour (banner, then a held `none`) was simulated with a **russh-based fake server** (`fakets`, `127.0.0.1:2223`). It sent the id `SSH-2.0-Tailscale`, a banner with a URL, and slept in `auth_none` [observed].

#### 1.2 `tailscale status --json` fields relevant to SSH (read-only) [observed]
| Path | Value on aron-dev | Use in TeleFlock |
|---|---|---|
| `.Version` | `1.104.1-t7f4efe814-g8da26756c` | diagnostics |
| `.BackendState` | `Running` | precondition |
| `.Self.HostName` / `.Self.DNSName` | `aron-dev` / `aron-dev.taile6ffdd.ts.net.` | display / dial name |
| `.Self.TailscaleIPs` | `["100.121.246.107","fd7a:115c:a1e0::23b:f66c"]` | dial target (prefer IPv4 100.x) |
| `.Self.Capabilities` | includes `https://tailscale.com/cap/ssh`, `ssh-behavior-v1`, `ssh-env-vars` | node supports Tailscale SSH features |
| `.Self` | **no `sshHostKeys` key for Self**. Keys of `Self`: ID, NodeID, PublicKey, HostName, DNSName, OS, UserID, TailscaleIPs, AllowedIPs, Addrs, CurAddr, Relay, PeerRelay, …, Capabilities, CapMap, KeyExpiry | read a host's own keys from `/etc/ssh/*.pub`, not from status |
| `.Peer[<nodekey>].sshHostKeys` | e.g. wazuh: `["ssh-rsa AAAA…","ecdsa-sha2-nistp256 AAAA…","ssh-ed25519 AAAA…"]` | **pre-seed host-key pins**. Present ⇔ peer runs Tailscale SSH (`Hostinfo.TailscaleSSHEnabled()` = `len(SSH_HostKeys)>0`, `tailcfg/tailcfg.go:1080-1087`) [source] |
| `.Peer[*].OS`, `.Online`, `.TailscaleIPs`, `.DNSName`, `.Tags` | e.g. `NX809J android … Online:false` | host picker |
| `.CurrentTailnet.MagicDNSEnabled` | **`false`** on this tailnet | **Don't depend on MagicDNS names. Dial the 100.x IP.** |
| `.MagicDNSSuffix` | `taile6ffdd.ts.net` | |

`tailscale debug prefs` → `RunSSH: true` [observed]. `tailscale debug netmap | jq .SSHPolicy` (read-only) shows this host's effective policy [observed]:
```json
{"rules":[{"action":{"accept":true,"allowAgentForwarding":true,"allowLocalPortForwarding":true,"allowRemotePortForwarding":true},
  "principals":[{"nodeIP":"100.109.204.29"} /* NX809J android */, {"nodeIP":"100.64.109.5"} /* Shiina win */, … ],
  "sshUsers":{"*":"=","0":"","root":"root"}}]}
```
So on this host TeleFlock gets **accept** (no check mode), and direct-tcpip is allowed. Note that the **default** Tailscale policy is `"action": "check"` for `autogroup:self`, with `checkPeriod` defaulting to 12h. Other users will hit check mode ([docs](https://tailscale.com/docs/features/tailscale-ssh.md)) [source].

---

### 2. russh 0.64.1 client — observed probe run

#### 2.1 Cargo
```toml
russh = "0.64.1"                 # default features = ["flate2", "aws-lc-rs", "rsa"]
# ring backend instead:
# russh = { version = "0.64.1", default-features = false, features = ["flate2", "rsa", "ring"] }
tokio = { version = "1.54", features = ["full"] }
```
MSRV for russh 0.64.1 is Rust 1.89 (`cargo info russh`). The local toolchain is 1.99.1 [observed]. Without a backend the build fails with `compile_error!("`russh` requires enabling either the `ring` or `aws-lc-rs` feature …")` (`src/lib.rs:90-93`) [source].

#### 2.2 Exact log of the main probe (OpenSSH on 127.0.0.1:2222, `keepalive_interval=2s`) [observed]
```
[  0.000s] connect 127.0.0.1:2222 cfg.keepalive_interval=Some(2s) keepalive_max=3 inactivity_timeout=None
[  0.026s] Handler::kex_done kex=Name("mlkem768x25519-sha256") hostkey_alg=ssh-ed25519 cipher=Name("chacha20-poly1305@openssh.com") mac=Name("hmac-sha2-512-etm@openssh.com") remote_sshid="SSH-2.0-OpenSSH_10.0p2 Debian-7+deb13u4"
[  0.026s] Handler::check_server_key PublicKey algorithm=ssh-ed25519 hash_alg=None fingerprint=SHA256:nsqB/WE2tCqKvE9Wy/NJueXepH/HgVmQNch86AsCfXc openssh=ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMay1+CkjAGtk2sZuLjBUEnZvyaLblAwwWlxynn86ZsM
[  0.027s] Handler::auth_banner("TeleFlock probe banner line 1\nVisit https://login.example/a/abc123 to approve\n") remote_sshid="SSH-2.0-OpenSSH_10.0p2 Debian-7+deb13u4"
[  0.027s] authenticate_none("root") -> Failure { remaining_methods: MethodSet([PublicKey]), partial_success: false }
[  0.027s] keyboard-interactive offered: false
[  0.028s] best_supported_rsa_hash -> Some(Sha512)
[  0.045s] authenticate_publickey("root", .research/tauri-hello/research-scratch/russh-probe/client_ed25519) -> Success
[  0.046s] Handler::openssh_ext_host_keys_announced ["ssh-ed25519"]
[  0.047s] exec channel ChannelId(2) opened, exec("herdr --version")
[  0.047s]   WindowAdjusted { new_size: 2097152 }
[  0.047s]   Success
[  0.049s]   Eof
[  0.049s]   ExitStatus 0
[  0.049s]   Close
[  0.049s]   stdout "herdr 0.9.0\n"
[  0.049s] exec channel ChannelId(3) opened, exec("echo hi")
[  0.050s]   WindowAdjusted { new_size: 2097152 }
[  0.050s]   Success
[  0.051s]   Eof
[  0.051s]   ExitStatus 0
[  0.051s]   Close
[  0.051s]   stdout "hi\n"
[  0.051s] pty channel ChannelId(4): request_pty(xterm-256color 132x43) + exec
[  0.057s]   Success
[  0.057s]   WindowAdjusted { new_size: 2097152 }
[  0.057s]   Success
[  0.062s]   Eof
[  0.062s]   ExitStatus 0
[  0.062s]   Close
[  0.062s]   pty output "/dev/pts/22\r\n43 132\r\n"
[  0.062s] direct-tcpip channel ChannelId(5) to 127.0.0.1:18765 opened
[  0.065s]   direct-tcpip response first line "HTTP/1.0 200 OK" (196 bytes)
[  0.065s] direct-tcpip to closed port 1 -> Err(ChannelOpenFailure(ConnectFailed)) / Failed to open channel (ConnectFailed)
[  0.065s] idling 7s with keepalive_interval=2s
[  7.066s] exec channel ChannelId(7) opened, exec("echo still-alive")
...
[  7.068s]   stdout "still-alive\n"
[  7.068s] Handler::disconnected Error(Disconnect)
[  7.068s] handle future resolved: Err(Disconnect)
```
`herdr --version` was run read-only and returned `herdr 0.9.0`. No herdr pane or session was touched [observed].

Observations:
- **Callback order**: `kex_done` → `check_server_key` → `auth_banner` → auth result. `client::connect()` returns only after KEX and host-key acceptance. If `check_server_key` returns `Ok(false)`, **`connect()` itself returns `Err(russh::Error::UnknownKey)`** ("Unknown server key") [observed with `PROBE_REJECT_KEY=1` against system sshd :22, no auth attempted]. The source is `client/mod.rs:2015,2020`.
- **Server id string**: there is no Handle accessor. Use `Session::remote_sshid() -> &[u8]` (`client/session.rs:621`) inside any handler callback that receives `&mut Session` (`kex_done`, `auth_banner`, …) [source/observed]. For Tailscale SSH expect `SSH-2.0-Tailscale`: gliderssh sets `config.ServerVersion = "SSH-2.0-" + srv.Version` (`gliderssh/server.go:133`) and tailssh sets `Version: "Tailscale"` (`tailssh.go:486`) [source]. **verify on a real peer later**.
- **Host key algorithm**: negotiated `ssh-ed25519`. russh's default key preference is Ed25519, then ECDSA P256/384/521, then RSA sha512/sha256/sha1 (`negotiation.rs:210-235`). Tailscale offers rsa, ecdsa and ed25519 (`hostkeys.go:32`), so russh should pick ed25519 [inferred].
- **KEX**: default `mlkem768x25519-sha256` first, from the pure-Rust `ml-kem` crate, so it is backend-independent (`negotiation.rs:162`) [source/observed]. golang.org/x/crypto v0.57 (Tailscale's dependency) also supports it [inferred].
- PTY: `tty` printed `/dev/pts/22` and `stty size` printed `43 132`, so `request_pty(col_width=132, row_height=43)` works. PTY output has CRLF line endings [observed].
- direct-tcpip: the HTTP GET through `channel.into_stream()` worked. A closed target port gives `Err(ChannelOpenFailure(ConnectFailed))` [observed].
- After you call `disconnect()` yourself, the handle future resolves to **`Err(Disconnect)`** and `Handler::disconnected` receives `DisconnectReason::Error(Disconnect)` [observed]. Don't surface this as an error in the UI.

#### 2.3 Keepalive / inactivity [observed + source]
| Test | Config | Result |
|---|---|---|
| idle 7 s, healthy server | `keepalive_interval=2s, keepalive_max=3` | debug log shows `> msg type 80` (GLOBAL_REQUEST `keepalive@openssh.com`) at 21:57:20, :22 and :24, each answered by `< msg type 82` (REQUEST_FAILURE, normal for OpenSSH); the connection stayed alive |
| server frozen (`kill -STOP` both `sshd-session` procs) | `keepalive_interval=2s, keepalive_max=2` | `[  6.108s] Handler::disconnected Error(KeepaliveTimeout)` / `handle future resolved: Err(KeepaliveTimeout)`. Detection time ≈ `interval × (max+1)` after the last received byte |
| idle, no keepalive | `inactivity_timeout=3s` | `[  3.149s] Handler::disconnected Error(InactivityTimeout)` |
| **auth pending** (fakets holds `none` 5 s) | `keepalive=1s, inactivity=None` | auth Success at 5.06 s; **`cpu: user=4.134s sys=0.070s wall=5.062s` (busy loop)** |
| auth pending | `keepalive=None, inactivity=2s` | `[2.058s] Handler::disconnected Error(InactivityTimeout)` then `authenticate_none -> Failure { remaining_methods: MethodSet([]), partial_success: false }`; cpu 0.018 s |
| auth pending | `keepalive=1s, inactivity=2s` | inactivity **never fires**; Success at 5 s; **cpu user=4.136 s** (busy loop) |
| auth pending | both None | Success at 5.06 s; cpu 0.019 s |

Source explanation (`russh-0.64.1/src/client/mod.rs`):
- Both timers are created once (`1358-1364`, `future_or_pending(config.keepalive_interval, tokio::time::sleep)`).
- The keepalive arm (`1426-1437`) only sends anything if `EncryptedState::Authenticated`. This has been the behaviour since 0.57.1 ("do not send keepalive before authentication (#642)").
- The timer is re-armed only `if (received_data || sent_keepalive)` (`1515-1521`). Before auth, a completed `Sleep` stays `Ready`, so `select!` spins. Each spin also resets the inactivity timer, because `!sent_keepalive` (`1523-1529`), which is why inactivity never fires.
- The reply type isn't checked. Any received data resets `alive_timeouts` (`1507-1513`).

Not reported upstream as far as I can tell. `gh search issues --repo Eugeny/russh keepalive` shows only #316 and #640, which are about other things [observed]. **Candidate upstream bug report.**

**TeleFlock recommendation** [inferred from the above]:
```rust
let cfg = client::Config {
    keepalive_interval: None,            // see busy-loop above (russh 0.64.1)
    keepalive_max: 3,
    inactivity_timeout: None,            // it would kill a check-mode hold; liveness is handled by our own pings
    nodelay: true,                       // interactive PTY latency
    window_size: 2 * 1024 * 1024,        // default 2097152
    maximum_packet_size: 32768,          // default; must be <= 65535
    channel_buffer_size: 100,            // default; per-channel backpressure
    ..Default::default()
};
// after auth succeeds:
tokio::spawn(async move {
    let mut misses = 0;
    loop {
        tokio::time::sleep(Duration::from_secs(15)).await;
        match tokio::time::timeout(Duration::from_secs(10), handle.send_ping()).await {
            Ok(Ok(())) => misses = 0,
            _ => { misses += 1; if misses >= 3 { /* tear down + reconnect */ break; } }
        }
    }
});
```
`Handle::send_ping()` (`client/mod.rs:1047`) sends a want-reply keepalive and waits for any reply. `Handle::send_keepalive(want_reply)` (`:1039`) sends without waiting. Tailscale SSH answers unknown global requests with `Reply(false)` → REQUEST_FAILURE (gliderssh `server.go:334-349`; `DefaultRequestHandlers` is empty, `server.go:24`), so pings get a reply [source; verify on a real peer later]. Tailscale sets no `IdleTimeout`/`MaxTimeout`/`HandshakeTimeout` (the `gliderssh.Server{…}` literal at `tailssh.go:485-509` omits them; fields at `gliderssh/server.go:58-60`), so the server never idles a connection out [source]. **Android**: when Doze suspends the app, the WireGuard path may stall. Expect reconnects after resume [inferred].

#### 2.4 Fake check-mode hold (fakets) [observed]
```
[  0.000s] connect 127.0.0.1:2223 cfg.keepalive_interval=None keepalive_max=3 inactivity_timeout=None
[  0.056s] Handler::check_server_key PublicKey algorithm=ssh-ed25519 ...
[  0.056s] authenticate_none pending...
[  0.056s] Handler::auth_banner("# FAKE check banner\n# To authenticate, visit:\n#\n#   https://login.example.invalid/a/abc123\n#\n") remote_sshid="SSH-2.0-Tailscale"
[  5.056s] authenticate_none -> Success
[  5.057s] exec channel ChannelId(2) opened, exec("whoami")
...
```
Server closes during the hold (fakets `FAKE_REJECT=1`, which mimics Tailscale's `errTerminal` path):
```
[  0.058s] Handler::auth_banner("# FAKE check banner ... https://login.example.invalid/a/abc123 ...")
[  1.059s] Handler::disconnected Error(IO(Custom { kind: UnexpectedEof, error: "early eof" }))
[  1.059s] authenticate_none -> Failure { remaining_methods: MethodSet([]), partial_success: false }
```
So `auth_banner` fires **while `authenticate_none().await` is still pending**. The session task runs independently of the auth future. The UI can therefore show the URL immediately [observed].

#### 2.5 API reference — russh 0.64.1 (exact signatures, `[source]` from `~/.cargo/registry/src/*/russh-0.64.1`)
```rust
// connect (client/mod.rs:1146, 1166)
pub async fn russh::client::connect<H: Handler + Send + 'static, A: tokio::net::ToSocketAddrs>(
    config: Arc<client::Config>, addrs: A, handler: H) -> Result<client::Handle<H>, H::Error>;
pub async fn russh::client::connect_stream<H, R>(config: Arc<Config>, stream: R, handler: H)
    -> Result<Handle<H>, H::Error>
    where H: Handler + Send + 'static, R: AsyncRead + AsyncWrite + Unpin + Send + 'static;
// connect_stream lets you dial yourself (e.g. bind to the Tailscale interface, custom DNS, timeouts).

// Handler (client/mod.rs:2700+) — native async trait (RPITIT), `type Error: From<russh::Error> + Send + Debug`
async fn auth_banner(&mut self, banner: &str, session: &mut client::Session) -> Result<(), Self::Error>;
async fn check_server_key(&mut self, server_public_key: &russh::keys::PublicKeyOrCertificate) -> Result<bool, Self::Error>; // default: reject
async fn kex_done(&mut self, shared_secret: Option<&[u8]>, names: &russh::Names, session: &mut Session) -> Result<(), Self::Error>;
async fn openssh_ext_host_keys_announced(&mut self, keys: Vec<russh::keys::PublicKey>, session: &mut Session) -> Result<(), Self::Error>;
async fn disconnected(&mut self, reason: client::DisconnectReason<Self::Error>) -> Result<(), Self::Error>;
// + channel_open_confirmation/success/failure/close/eof/open_failure, data, extended_data, exit_status,
//   exit_signal, window_adjusted, adjust_window, server_channel_open_forwarded_tcpip(.., reply: ChannelOpenHandle), ...

// PublicKeyOrCertificate (cert.rs:12)
pub enum PublicKeyOrCertificate { PublicKey { key: PublicKey, hash_alg: Option<HashAlg> }, Certificate(Certificate) }

// Handle (client/mod.rs)
pub async fn authenticate_none<U: Into<String>>(&mut self, user: U) -> Result<AuthResult, russh::Error>;            // :329
pub async fn authenticate_keyboard_interactive_start<U: Into<String>, S: Into<Option<String>>>(&mut self, user: U, submethods: S)
    -> Result<KeyboardInteractiveAuthResponse, russh::Error>;                                                          // :366
pub async fn authenticate_keyboard_interactive_respond(&mut self, responses: Vec<String>) -> Result<KeyboardInteractiveAuthResponse, _>; // :392
pub async fn authenticate_publickey<U: Into<String>>(&mut self, user: U, key: keys::PrivateKeyWithHashAlg) -> Result<AuthResult, _>; // :466
pub async fn best_supported_rsa_hash(&self) -> Result<Option<Option<HashAlg>>, russh::Error>;                        // :767
pub async fn channel_open_session(&self) -> Result<Channel<client::Msg>, russh::Error>;                              // :802
pub async fn channel_open_direct_tcpip<A: Into<String>, B: Into<String>>(&self, host_to_connect: A, port_to_connect: u32,
    originator_address: B, originator_port: u32) -> Result<Channel<Msg>, russh::Error>;                              // :845
pub async fn channel_open_direct_streamlocal<S: Into<String>>(&self, socket_path: S) -> Result<Channel<Msg>, _>;      // :870
pub async fn disconnect(&self, reason: russh::Disconnect, description: &str, language_tag: &str) -> Result<(), _>;   // :992
pub async fn send_keepalive(&self, want_reply: bool) -> Result<(), _>;   // :1039
pub async fn send_ping(&self) -> Result<(), _>;                          // :1047 (waits for reply)
pub fn is_closed(&self) -> bool;                                         // :323
impl<H: Handler> Future for Handle<H> { type Output = Result<(), H::Error>; } // resolves when session ends

pub enum AuthResult { Success, Failure { remaining_methods: MethodSet, partial_success: bool } }  // auth.rs:153; .success()
pub enum KeyboardInteractiveAuthResponse { Success, Failure { remaining_methods, partial_success }, InfoRequest { name, instructions, prompts: Vec<Prompt> } }
// MethodSet derefs to [MethodKind]; MethodKind::{None, Password, PublicKey, HostBased, KeyboardInteractive, ...}

// Channel<Msg> (channels/mod.rs)
pub async fn request_pty(&self, want_reply: bool, term: &str, col_width: u32, row_height: u32, pix_width: u32, pix_height: u32,
    terminal_modes: &[(russh::Pty, u32)]) -> Result<(), Error>;          // :509
pub async fn exec<A: Into<Vec<u8>>>(&self, want_reply: bool, command: A) -> Result<(), Error>;   // :540
pub async fn request_shell(&self, want_reply: bool) -> Result<(), Error>;
pub async fn window_change(&self, col_width: u32, row_height: u32, pix_width: u32, pix_height: u32) -> Result<(), Error>;
pub async fn set_env<A: Into<String>, B: Into<String>>(&self, want_reply: bool, variable_name: A, variable_value: B) -> Result<(), Error>;
pub async fn signal(&self, signal: russh::Sig) -> Result<(), Error>;
pub async fn data<R: AsyncRead + Unpin>(&self, data: R) -> Result<(), Error>;  pub async fn data_bytes(&self, data: impl Into<Bytes>) -> Result<(), Error>;
pub async fn eof(&self) -> Result<(), Error>;  pub async fn close(&self) -> Result<(), Error>;
pub async fn wait(&mut self) -> Option<ChannelMsg>;                     // None when closed
pub fn split(self) -> (ChannelReadHalf, ChannelWriteHalf<Msg>);         // reader task + writer handle (PTY attach)
pub fn into_stream(self) -> ChannelStream<Msg>;                         // AsyncRead + AsyncWrite (tunnels)
pub fn make_reader(&mut self) -> impl AsyncRead + '_;  pub fn make_writer(&self) -> impl AsyncWrite + 'static;
// ChannelMsg variants seen: WindowAdjusted{new_size}, Success, Data{data: Bytes}, ExtendedData{data, ext}, Eof, ExitStatus{exit_status}, ExitSignal{..}, Close, OpenFailure(ChannelOpenFailure)

// Keys
russh::keys::load_secret_key(path, password: Option<&str>) -> Result<PrivateKey, Error>;
russh::keys::PrivateKeyWithHashAlg::new(Arc<PrivateKey>, Option<HashAlg>) -> Self;  // infallible since 0.50
key.fingerprint(HashAlg::Sha256)  // "SHA256:…"; key.to_openssh() // "ssh-ed25519 AAAA…"
```
Websocket over a tunnel compiles [observed, compile-only; I did not run it against a live websocket server]:
```rust
let ch = handle.channel_open_direct_tcpip("127.0.0.1", port, "127.0.0.1", 0).await?;
let (ws, resp) = tokio_tungstenite::client_async(format!("ws://127.0.0.1:{port}/"), ch.into_stream()).await?;
```

#### 2.6 russh API changes across versions (release notes via `gh api repositories/456693383/releases`; repo is now `Eugeny/russh`, warp-tech redirects) [source]
| Version | Change that affects TeleFlock code |
|---|---|
| 0.48 → 0.49 | `authenticate_publickey` takes `PrivateKeyWithHashAlg` (was a keypair `Arc<KeyPair>`) |
| 0.50.0-beta.8 | `russh-keys` merged into `russh` → `russh::keys::*` |
| 0.50.0 | **native async traits**: drop `#[async_trait]` (opt-in `async-trait` feature still exists); `PrivateKeyWithHashAlg::new` infallible; DH-GEX on by default; keys are `ssh_key` types (forked) |
| 0.51.1 | <2048-bit RSA host keys no longer refused by the library. Reject them yourself in `check_server_key` |
| 0.52.0 | `Handle::send_keepalive` |
| 0.53.0 | AEAD ciphers via `aws-lc-rs` (default) or `ring` feature |
| 0.57.1 | no keepalive before authentication (root of the §2.3 pre-auth timer quirk) |
| 0.61.0 | migrated to upstream `ssh-key` crate |
| 0.62.0 | server-side `channel_open_*` take a `ChannelOpenHandle` (client `server_channel_open_forwarded_tcpip(.., reply)` too) |
| **0.63.0** | **`Handler::check_server_key(&PublicKeyOrCertificate)`** (was `&PublicKey`) |
| 0.63.3 | inactivity timeout enforced during stalled writes |
| 0.64.0 | dropped `legacy-ed25519-pkcs8-parser`; client-side invalid-channel-ID callback fix (GHSA-47hw-gvq5-r2gm); `Handle::hostkeys_prove`, `Handle::send_global_request` |
Older snippets in blogs/LLM output (`async_trait`, `check_server_key(&mut self, _: &key::PublicKey)`, `russh_keys::…`, `authenticate_publickey(user, Arc<KeyPair>)`) won't compile on 0.64.

---

### 3. Tailscale SSH server behaviour (source: tailscale **v1.104.1**, which matches this host's daemon)
Links are against tag `v1.104.1` (`https://github.com/tailscale/tailscale/blob/v1.104.1/…`). x/crypto is `golang.org/x/crypto v0.57.0` and gliderssh is `github.com/tailscale/gliderssh v0.3.4-0.20260716005906-1a0f895faf28` (from `go.mod:115,139`). **Everything in §3 is to be verified on a real peer later.**

#### 3.1 Auth methods
- [`ssh/tailssh/tailssh.go#L421-L468`](https://github.com/tailscale/tailscale/blob/v1.104.1/ssh/tailssh/tailssh.go#L421-L468) `ServerConfig()`:
  - `PreAuthConnCallback` stores `spac`, used to send banners (L424-426).
  - `NoClientAuth: true` with a `NoClientAuthCallback` that calls `c.clientAuth(cm)` (L427-452). **The `none` method is the real auth.** Identity comes from the WireGuard peer (node key → user), not from SSH credentials.
  - The username suffix `+password` forces a follow-up password step for buggy clients (L437-449, `forcePasswordSuffix`). Not needed for russh, which handles `none` → Success fine [observed with fakets].
  - `PasswordCallback` and `PublicKeyCallback` also just call `clientAuth` and ignore the credential (L453-466). A client that sends a key first still works.
  - **There is no `KeyboardInteractiveCallback`.** keyboard-interactive is never offered. The failure method list can contain only `password` and `publickey` (x/crypto `ssh/server.go:1035-1046`).
- The x/crypto server allows the first `none` attempt without penalty and has a default `MaxAuthTries` of 6 (`server.go:356-357,1005-1008`).

#### 3.2 Check mode = HoldAndDelegate
[`tailssh.go#L325-L419`](https://github.com/tailscale/tailscale/blob/v1.104.1/ssh/tailssh/tailssh.go#L325-L419) `clientAuth`:
1. `evaluatePolicy()` picks an `SSHAction`. Rejected or unmatched users get `errBanner("tailnet policy does not permit you to SSH …")` (L347-357).
2. Loop (L377-418):
   - `Accept`: send optional `action.Message` as a banner, then succeed (L379-388).
   - `Reject`: `errDenied(action.Message)` (L389-392).
   - **`HoldAndDelegate != ""`**: send `action.Message` via `c.spac.SendAuthBanner(...)` (L393-398). Expand URL variables (`expandDelegateURLLocked`, L720-736: `$SRC_NODE_IP $SRC_NODE_ID $DST_NODE_IP $DST_NODE_ID $SSH_USER $LOCAL_USER`). Then **block** in `fetchSSHAction(ctx, url)` under `context.WithTimeout(…, 30*time.Minute)` (L400-413).
3. [`fetchSSHAction` L823-860](https://github.com/tailscale/tailscale/blob/v1.104.1/ssh/tailssh/tailssh.go#L823-L860) long-polls control over Noise (`DoNoiseRequest`). It retries with exponential backoff capped at 10 s for up to 30 min and returns the next `SSHAction`, usually `Accept` (with optional message) or `Reject`. Multi-step chains are possible: tests show `Message:"First"` → check1 `Message:"url-here"` → check2 accept (`tailssh_test.go:943-951`).
- `SendAuthBanner` writes `SSH_MSG_USERAUTH_BANNER` to the transport immediately (x/crypto [`ssh/server.go:84-89`](https://github.com/golang/crypto/blob/v0.57.0/ssh/server.go#L84-L89)), **before** any USERAUTH_SUCCESS or FAILURE. Meanwhile the client's `none` request stays unanswered.
- **The banner text is written by the control server, not tailscaled** (`SSHAction.Message`, `tailcfg/tailcfg.go:2757-2819`). User reports show `# Tailscale SSH requires an additional check.` followed by `# To authenticate, visit: https://login.tailscale.com/a/<id>` ([issue #5708](https://github.com/tailscale/tailscale/issues/5708)) [source, wording not guaranteed]. Extract URLs with a regex like `https://\S+`. Don't hard-code the wording.
- On denial or error, `errTerminal = &ssh.PartialSuccessError{}` (L57-60) → x/crypto returns `"ssh: no authentication methods available"` (`server.go:1048-1049`) and the connection closes **without** USERAUTH_FAILURE or DISCONNECT. The client sees a banner (`"tailscale: …\n"` from `errBanner`, L300-308, or the policy message from `errDenied`, L286-294, default `"tailscale: access denied"`) followed by EOF. In russh that is `authenticate_none → Ok(Failure{remaining_methods: []})` plus `disconnected(Error(IO(UnexpectedEof)))` [observed in the fakets equivalent].
- After auth:
  - `SessionDuration` (if set by policy) kills sessions with the message `"Session timeout of %v elapsed."` (L946-953).
  - A policy change re-evaluates the connection and may cancel sessions with `"Access revoked.\r\n"` (`OnPolicyChange` L192-205, `checkStillValid` L807-821). Check mode itself doesn't re-prompt on an open connection. The control server's `checkPeriod` (default 12h, `always` possible; [docs](https://tailscale.com/docs/features/tailscale-ssh.md)) only affects **new** connections [inferred from source + docs].

#### 3.3 What TeleFlock should do
1. Keep the single long-lived `russh` connection. Check mode costs one browser approval per connection, and per `checkPeriod` across connections, so **one connection with many channels** (exec/PTY/direct-tcpip) is the right design [inferred].
2. Auth sequence:
   ```rust
   let r = tokio::select! {
       r = tokio::time::timeout(Duration::from_secs(31 * 60), handle.authenticate_none(user)) => r,
       _ = cancel_rx => { handle.disconnect(Disconnect::ByApplication, "cancelled", "").await.ok(); return Err(Cancelled) }
   };
   match r {
       Ok(Ok(AuthResult::Success)) => {}
       Ok(Ok(AuthResult::Failure { remaining_methods, .. })) if remaining_methods.is_empty() || handle.is_closed()
           => return Err(ServerEndedAuth { banner: last_banner }),   // Tailscale deny/timeout
       Ok(Ok(AuthResult::Failure { .. })) => return Err(NotTailscaleSsh), // e.g. OpenSSH: [PublicKey, Password]
       ...
   }
   ```
   In `Handler::auth_banner`, forward `banner` (full text) plus extracted URLs to the UI over an mpsc channel, e.g. a Tauri event `ssh://auth-banner {text, urls[]}`. On Android, also post a notification with an "Open" action (`ACTION_VIEW` on the URL) so the user can approve while the app is in the background [inferred].
3. Config while auth may block: `keepalive_interval: None` and `inactivity_timeout: None` (§2.3).
4. If `remaining_methods` is not empty (e.g. `[PublicKey, Password]`, which is what the system OpenSSH on :22 returned [observed]), you've reached OpenSSH, not Tailscale SSH. Common causes: dialling the host's own IP, or `tailscale set --ssh` not enabled. Show a "Tailscale SSH not enabled on host" hint.
5. Username: send the host-local user (`root` here). The policy's `sshUsers` maps it (`"*":"="` = same name) [observed].

#### 3.4 Port forwarding
- `ChannelHandlers["direct-tcpip"] = gliderssh.DirectTCPIPHandler` (L499-502), gated by [`mayForwardLocalPortTo` L541-550](https://github.com/tailscale/tailscale/blob/v1.104.1/ssh/tailssh/tailssh.go#L541-L550):
  - `TS_SSH_DISABLE_FORWARDING` envknob → deny (L54).
  - `finalAction.AllowLocalPortForwarding` → allow.
  - No host/port restriction ("TODO" comment L540).
- Denial is `newChan.Reject(gossh.Prohibited, "port forwarding is disabled")`. A dial failure is `Reject(ConnectionFailed, err)` (gliderssh `tcpip.go:29-58`). In russh these map to `ChannelOpenFailure(AdministrativelyProhibited)` and `(ConnectFailed)` [inferred mapping; ConnectFailed observed against OpenSSH].
- `direct-streamlocal@openssh.com` is supported too, with the same flag (L556-566). A host-local **unix socket** relay therefore works via `channel_open_direct_streamlocal(path)`, with no TCP port needed [source].
- This host's policy: `allowLocalPortForwarding: true` [observed].

#### 3.5 Host key verification
- Key source: [`hostkeys.go#L29-L77,L140-L158`](https://github.com/tailscale/tailscale/blob/v1.104.1/ssh/tailssh/hostkeys.go):
  - Types are `rsa, ecdsa, ed25519`.
  - It **reuses the system OpenSSH host keys** (`systemHostKeyFile(typ)` → `/etc/ssh/ssh_host_<typ>_key` when readable), otherwise generates `$TAILSCALE_VAR/ssh/ssh_host_<typ>_key`.
  - On aron-dev, `/var/lib/tailscale/ssh/` does not exist, so the system keys are used. ED25519 is `SHA256:YEp852Oki45S28B4DnnAVV515hs98Bs6ugtdHzikmoA` [observed: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`, and the probe against system sshd showed the same fingerprint].
  - Consequence: OpenSSH (via `lo`) and Tailscale SSH (via the tailnet) present **the same host key** on this host [inferred].
- Distribution: tailscaled advertises them in `Hostinfo.SSH_HostKeys` when `RunSSH` is set (`ipn/ipnlocal/local.go:6737-6750`). Peers see them as `sshHostKeys` in `tailscale status --json` (`ipn/ipnstate/ipnstate.go:315-316`) [source + observed].
- How `tailscale ssh` verifies ([`cmd/tailscale/cli/ssh.go#L99-L194`](https://github.com/tailscale/tailscale/blob/v1.104.1/cmd/tailscale/cli/ssh.go#L99-L194)): `writeKnownHosts` writes `$XDG_CONFIG/tailscale/ssh_known_hosts`, one line per `{DNSName, each TailscaleIP} × sshHostKeys`. It then runs OpenSSH with `UserKnownHostsFile`, `StrictHostKeyChecking yes`, `UpdateHostKeys no`, plus `ProxyCommand tailscale nc %h %p` on non-darwin. **There is no `tailscale configure` subcommand for known_hosts.** The `configure` subcommands are kube/synology/jetkvm/etc. (file list in `cmd/tailscale/cli/`) [source].
- **TeleFlock `check_server_key` policy** [inferred]:
  1. Desktop (Windows Tailscale client present): run `tailscale status --json` (no admin rights needed). Find the peer by IP and accept iff the presented key's `to_openssh()` (`"<alg> <base64>"`) equals one of `Peer.sshHostKeys` (compare type + base64, ignore comment). This is equivalent to `tailscale ssh`'s strict mode.
  2. Android: third-party apps can't query the Tailscale app's LocalAPI [inferred]. Use **TOFU**: on first connect show the SHA256 fingerprint (`key.fingerprint(HashAlg::Sha256)`) and pin `{host IP/NodeID → openssh key string}` in the app store. Optionally pair from desktop (QR/deep link carrying the pinned key) or show the expected value from the host (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`).
  3. If the key changes: hard-fail with a "host key changed" UI; `check_server_key` → `Ok(false)` makes `connect()` return `Err(UnknownKey)` [observed].
  4. Also pin the alternate key types announced via `openssh_ext_host_keys_announced` only after `Handle::hostkeys_prove` succeeds (new in 0.64.0). Tailscale (x/crypto) doesn't implement `hostkeys-00@openssh.com` [inferred], so don't rely on it.
  5. WireGuard already authenticates the peer IP inside the tailnet, so TOFU risk is low. The pin mainly guards against a wrong IP or a re-provisioned node [inferred].

---

### 4. Crypto backend builds [observed]
Script: `.research/tauri-hello/research-scratch/russh-probe/xbuild.sh`. NDK `/opt/android-sdk/ndk/29.0.14206865`, `CC_aarch64_linux_android=.../aarch64-linux-android24-clang`, `AR=llvm-ar`. Windows built with `cargo xwin build --target x86_64-pc-windows-msvc`. Release builds of the probe (russh + tokio):

| Target | `aws-lc-rs` (russh default; aws-lc-sys 0.46.0) | `ring` 0.17.14 |
|---|---|---|
| aarch64-linux-android | ✅ 27 s. aws-lc-sys log: `Building with: CC` (cc-builder, **no cmake binary used**, only the `cmake` crate compiled); needs NDK clang via `CC_*`/`AR_*` env (Tauri's Android build sets these) | ✅ 18 s |
| x86_64-pc-windows-msvc via cargo-xwin | ❌ `warning: aws-lc-sys@0.46.0: NASM command not found or failed to execute.` → `error: failed to run custom build command for aws-lc-sys v0.46.0`. ✅ with **`AWS_LC_SYS_PREBUILT_NASM=1`** (35 s) | ✅ 20 s, no extra tools |

`cargo tree --no-default-features --features ring-backend -i aws-lc-sys` reports no match, so a ring build pulls in no aws-lc [observed]. The `ml-kem` KEX is pure Rust, so the KEX list is identical on both backends (`Cargo.toml` dep `ml-kem`; cipher gating `cipher/mod.rs:26-33`) [source].
**Recommendation:** `russh = { version = "0.64.1", default-features = false, features = ["flate2", "rsa", "ring"] }` for the least build friction. If you choose aws-lc-rs instead, set `AWS_LC_SYS_PREBUILT_NASM=1` in `.cargo/config.toml` `[env]` for Windows cross builds, and make sure no other crate (rustls via the updater, hickory) silently enables aws-lc anyway. `tauri-plugin-updater` → `reqwest 0.13`/`rustls 0.23`, which defaults to aws-lc-rs [inferred]; check `cargo tree -i aws-lc-sys` in the real app.

---

### 5. Recommended crate versions (crates.io API, max_stable_version, queried 2026-10-20) [observed]
| Crate | Version | Role | Platform caveat |
|---|---|---|---|
| tauri | 2.12.4 | app runtime | depends on `jni ^0.21` (android), `windows ^0.62`, `webview2-com ^0.39` [source: crates.io deps] |
| tauri-build | 2.7.3 | build script | — |
| tauri-cli / @tauri-apps/cli | 2.12.3 | `tauri android init/build` | npm `@tauri-apps/api` 2.12.4 |
| tauri-plugin-notification | 2.7.0 | basic notifications | desktop uses `notify-rust ^4.18`. Android actions + inline reply → custom Kotlin plugin (per plan) [inferred] |
| tauri-plugin-single-instance | 2.5.4 | one desktop instance, forward deep links | desktop only [inferred] |
| tauri-plugin-deep-link | 2.6.2 | `teleflock://` links (pairing) | Android needs intent-filter config in `tauri.conf.json` [inferred] |
| tauri-plugin-shell | 2.5.0 | spawn `wsl.exe`/`tailscale.exe` (Local/WSL mode) | use `opener` for URLs. Shell scope must allowlist the commands [inferred] |
| tauri-plugin-opener | 2.7.2 | open the check-mode login URL in the browser | works on Android (ACTION_VIEW) [inferred] |
| tauri-plugin-os | 2.4.0 | OS/arch detection | — |
| tauri-plugin-store | 2.5.0 | host list + host-key pins | not secret storage |
| tauri-plugin-window-state | 2.5.0 | remember window geometry | desktop only |
| tauri-plugin-log | 2.10.1 | log → file/webview | bridges `log`. Add `tracing-log` or use `tracing` → `log` [inferred] |
| tauri-plugin-clipboard-manager | 2.5.0 | copy/paste in the terminal | — |
| tauri-plugin-dialog | 2.8.3 | confirm host-key TOFU, file pickers | — |
| tauri-plugin-process | 2.4.0 | restart after update | — |
| tauri-plugin-updater | 2.14.0 | desktop self-update | pulls `reqwest ^0.13`, `windows-sys ^0.61`; rustls backend (see §4) |
| tauri-plugin-autostart | 2.7.0 | start with Windows | desktop only |
| tauri-plugin-global-shortcut | 2.4.1 | summon hotkey | desktop only |
| **russh** | **0.64.1** | SSH client (exec/PTY/direct-tcpip) | MSRV 1.89. Prefer the `ring` feature (§4). Keepalive busy-loop pre-auth (§2.3) |
| ssh-key | 0.6.7 stable (russh 0.64.1 uses **0.7.0-rc.11**, re-exported as `russh::keys::ssh_key`) | key types | **use `russh::keys::*`**, don't add `ssh-key` directly or you get type mismatches [observed in registry] |
| ring | 0.17.14 | crypto backend | builds everywhere, no NASM |
| aws-lc-rs / aws-lc-sys | 1.18.2 / 0.46.0 | alternative backend | Windows cross needs NASM or `AWS_LC_SYS_PREBUILT_NASM=1` |
| portable-pty | 0.9.0 (2025-02) | Local-mode PTY on Windows (ConPTY) | uses `winapi 0.3`. Not needed on Android. Last release is old |
| tokio | 1.54.0 | async runtime | `features=["full"]` fine; Android OK |
| tokio-tungstenite | 0.30.0 | websocket client over `ChannelStream` | `client_async(url, channel.into_stream())` compiles [observed]. No TLS feature needed (tunnel) |
| tungstenite | 0.30.0 | WS protocol (via tokio-tungstenite) | keep versions in lockstep |
| aes-gcm | 0.11.1 | relay payload encryption | 0.11 is the new RustCrypto generation (hybrid-array API). Many examples are written for 0.10.x [inferred] |
| serde / serde_json | 1.0.229 / 1.0.154 | herdr JSON CLI parsing, IPC | — |
| anyhow | 1.0.104 | app-level errors | — |
| thiserror | 2.0.21 | typed errors for commands | v2 syntax |
| tracing / tracing-subscriber | 0.1.44 / 0.3.23 | structured logs | russh logs via the `log` crate. Add `tracing-log` bridge [inferred] |
| futures | 0.3.34 | stream combinators | — |
| bytes | 1.12.1 | russh `ChannelMsg::Data { data: Bytes }` | — |
| hickory-resolver | 0.26.3 | custom DNS | **likely unnecessary**: MagicDNS is off on this tailnet, so dial the 100.x IP. Default `system-config` feature pulls `jni ^0.22` + `ndk-context` on Android (a second jni version alongside tauri's 0.21) [source: crates.io deps] |
| keyring | 4.2.0 | OS secret store (relay keys) | v4 = `keyring-core` + per-platform store crates. Default feature `v1` = apple/windows/zbus stores. **Android requires feature `android-native-keyring-store`** (uses `jni ^0.21` + `ndk-context`, needs the Android context initialised) [source: `cargo info keyring@4.2.0`, crates.io deps] |
| directories | 6.0.0 | config dirs (desktop) | on Android use Tauri's `app.path().app_data_dir()` instead [inferred] |
| interprocess | 2.4.6 | Windows named pipes / UDS for Local mode | enable feature `tokio` |
| windows | 0.62.2 | Win32 (job objects, WSL detection) | matches tauri's `^0.62`. Don't pick another major |
| windows-sys | 0.61.2 | raw Win32 | matches the updater's `^0.61` |
| **jni** | **0.21.1** (latest 0.22.4) | Kotlin plugin bridge | **Pin 0.21.x to match tauri/wry/tao (`jni ^0.21`)** so `JNIEnv`/`JavaVM` types interoperate. 0.22 has a different API [source: crates.io deps] |
| ndk-context | 0.1.1 | get JavaVM/Context on Android | same one tao uses (`ndk-context ^0.1`) |

npm (for reference): `@tauri-apps/api` 2.12.4, `@tauri-apps/plugin-notification` 2.7.0, `@xterm/xterm` 6.0.0, `@xterm/addon-webgl` 0.19.0 [observed: `npm view`].

---

### 6. Open items to verify on a real Tailscale peer (not done here, per directive)
1. Id string `SSH-2.0-Tailscale` and the host key alg russh negotiates (expect ssh-ed25519).
2. `authenticate_none` → `Success` directly in accept mode. In check mode: banner text and URL format, the hold lasting until approval, and behaviour when the user never approves (30-min server timeout → banner `tailscale: failed to fetch next SSH action` + EOF).
3. `channel_open_direct_tcpip("127.0.0.1", relay_port, …)` with `allowLocalPortForwarding:true`, and the exact russh error variant when forwarding is disabled.
4. The `send_ping()` reply from Tailscale (expected REQUEST_FAILURE), and keepalive behaviour across Android Doze and network handover.
5. PTY `request_pty` + `window_change` on Tailscale SSH (incubator path), and `set_env` restrictions (`acceptEnv` policy).
