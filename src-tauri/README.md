# src-tauri — TeleFlock app shell (owner: TauriShell)

Embeds `tf_client::Engine` (AppCore) and wires it to the webview and the OS.

## Webview API

| Call | Args (camelCase) | Result |
|---|---|---|
| `invoke("core_call", …)` | `{ hostId: string \| null, method: string, params?: unknown }` | method result; rejects with a tf-proto `ApiError`. `app.update*` are answered by the shell (below), everything else by the engine |
| `invoke("core_term_input", …)` | `{ hostId, termId, data: string }` | `void` (fast path, never waits for the host) |
| `invoke("core_events", …)` | `{ channel: Channel<AppEvent[]> }` | `void`. Replays current state first (Profiles, Settings, Tunnels, HostStatus + HostSnapshot per host), then streams live events, in order, in batches (a live event with whatever queued behind it; one webview eval per batch). Call once per page load; a reload drops older subscriptions. |

UI intents arrive on the same channel: `{type:"openAgent", hostId, agentId}` (toast / notification /
deep link) and `{type:"answerNext"}` (tray menu, `teleflock://answer-next`). Intents raised while no
page is subscribed (cold start from a notification) are delivered right after the next replay.

## Self-update (`src/update/`)

Same IPC as the engine's app methods (typed in tf-proto `AppMethods`, so the UI calls
`core.app("app.updateCheck", …)`), but answered in `core_call` by `update::Updater` before the
engine sees them (tf-client answers them `unsupported`, e.g. for tf-devserver). Status changes
are pushed as `{type:"update", status: UpdateStatus}` on the `core_events` channel.

| Method | Params | Result |
|---|---|---|
| `app.updateStatus` | `{}` | `UpdateStatus` `{ current, supported, manual, unsupportedReason?, phase, latest?, progress?, error?, checkedAt? }` |
| `app.updateCheck` | `{ install }` | `UpdateStatus` once discovery is done. `install`: install a newer release right away |
| `app.updateInstall` | `{}` | `UpdateStatus`; starts download + install of the last found release (`not_found` before a check found one). `manual` (macOS): opens the release's `.dmg` in the browser instead |

`phase`: `idle` → `checking` → `upToDate` \| `available` → `downloading` (`progress` 0–100) →
`installing`; `needsPermission` (Android), `error` (message in `error`; failures are only logged and
shown in Settings, never toasted). `supported` is false in debug builds, for the Arch package
(pacman owns it) and for any Linux copy that is neither a running AppImage nor dpkg's `.deb`
install; `unsupportedReason` says why and Settings shows it.

- Automatic checks (`schedule.rs`, unit-tested) run in the shell, so they also work on Android
  while the keep-alive service keeps the process up without an activity (and its webview): 8 s
  after setup, then whenever the last completed check (manual ones included) is older than 1 h
  plus 0–10 min of random jitter (compared on the wall clock every 5 min, so a laptop that slept
  catches up), and when the app comes back to the front (desktop window focus,
  `MainActivity.onResume`) if it is older than 20 min. Never while a check or install runs or
  waits for the user (`needsPermission`, Android installer prompt), only while
  `settings.autoUpdate` is on, never for unsupported copies. Failed checks, failed installs and
  dismissed Android install prompts back off (30 min doubling to 12 h, at least the period); a
  clean result resets it. At most about 3 API requests per hour and device (GitHub allows 60
  anonymous ones per IP). What they find installs like `{ install: true }`.
- Discovery (`release.rs`, unit-tested): `GET https://api.github.com/repos/studioplascode/TeleFlock/releases?per_page=30`
  anonymously (rustls + webpki roots, 10 s connect / 20 s request timeouts); highest semver
  `vX.Y.Z[-pre]` tag, drafts skipped, that has this platform's assets, if newer than the app.
- Windows, Linux: tauri-plugin-updater with that release's `latest.json` as the only
  endpoint. `latest.json` must announce the tag's version; the plugin checks the minisign signature
  against `plugins.updater.pubkey` and, with `requireSignedVersion`, that the signature was made for
  that version (no replay of an older signed package under a newer tag). Downloads fail after 60 s
  without data. It installs by
  bundle type. Windows runs the NSIS installer passively (`installMode: passive`) and exits; the
  installer relaunches TeleFlock. Teardown (toasts, engine shutdown, tray) runs in the plugin's
  `on_before_exit`, as `RunEvent::Exit` won't fire. Linux replaces the AppImage in place or runs
  `pkexec dpkg -i` for the `.deb`; then `request_restart()` exits through `RunEvent::Exit` and
  starts the new version.
- macOS (`manual: true`): discovery looks for the release's `TeleFlock_<v>_universal.dmg` (built
  by `macos.yml`, never signed with the updater key); automatic checks never install, the UI
  shows one "vX is available" toast per new version and Settings a **Download** button, both calling
  `app.updateInstall`, which opens the `.dmg` URL (`Platform::open_external` → `open`).
- Android: `<cacheDir>/updates/TeleFlock_<v>_universal.apk`, SHA-256 checked against the release's
  `.sha256` (a verified file is reused), then the plugin's `installApk` (below), which rejects and
  deletes an APK that isn't this package, signed by the installed app's certificates, with a
  higher versionCode. The installer only starts while the app is in front (`MainActivity`
  reports `onResume` / `onPause`); an APK verified in the background stays `available` and its
  prompt opens on the next resume. On
  `needsPermission` the shell retries when the app comes back to the front (`MainActivity.onResume`); a dismissed system prompt
  falls back to `available`.
- UI: `src/features/updates/updates.tsx` (`useAutoUpdate`, mounted in `App`: progress toast,
  macOS availability toast) and Settings → Updates (`src/features/settings/Updates.tsx`; "checked
  …" includes automatic checks).

Release assets, keys and publishing: `docs/build.md` §11.

Android only (Kotlin plugin `src-tauri/plugins/teleflock-android`, capability `teleflock-android:default`):

| Call | Args | Result |
|---|---|---|
| `invoke("plugin:teleflock-android\|haptic", { kind })` | `kind`: `tick` `select` `light` `medium` `heavy` `success` `warning` `error` | `void` |
| `invoke("plugin:teleflock-android\|notification_permission")` | – | `{ postNotification: "granted" \| "denied" \| "prompt" \| "prompt-with-rationale" }` |
| `invoke("plugin:teleflock-android\|request_notification_permission")` | – | same; opens system settings if permanently denied |
| `invoke("plugin:teleflock-android\|battery_status")` | – | `{ ignoringOptimizations: boolean }` |
| `invoke("plugin:teleflock-android\|request_ignore_battery_optimizations")` | – | `void` |
| `invoke("plugin:teleflock-android\|request_microphone_permission")` | – | `{ recordAudio: "granted" \| "denied" \| "prompt-with-rationale" }` once the user answered the system prompt (none when granted); `denied` = only the app's settings can grant it |
| `invoke("plugin:teleflock-android\|open_app_settings")` | – | `void`; opens the app's page in Android's settings |
| `invoke("plugin:teleflock-android\|dictation_available")` | – | `{ available: boolean }`: a speech recognizer is installed |
| `invoke("plugin:teleflock-android\|start_dictation", { channel })` | `channel`: a `Channel` for the session's events | `void`; rejects `PERMISSION` (no `RECORD_AUDIO`), `UNAVAILABLE` |
| `invoke("plugin:teleflock-android\|stop_dictation", { session })` | `session`: the channel's `id` | `void`; the phrase being spoken still arrives |
| `invoke("plugin:teleflock-android\|cancel_dictation", { session })` | same | `void`; drops the phrase being spoken |

Dictation (`Dictation.kt`, used by `src/features/session/composer/useDictation.ts` instead of the
Web Speech API, which Android's WebView lacks): `android.speech.SpeechRecognizer` (free-form, the
recognizer's default language), one session at a time, a newer one ends the older. Channel events:
`{ type: "partial", text }` (the phrase so far), `{ type: "final", text }`, `{ type: "error", code,
message }` (readable message per `SpeechRecognizer.ERROR_*`), then always `{ type: "end" }`. Like Web
Speech's continuous mode it keeps listening across pauses (a fresh recognizer per phrase) until
stopped; silence, or a stop, after a phrase ends it without an error. The app leaving the front
stops it, a destroyed activity cancels it. The plugin manifest declares `RECORD_AUDIO` (with
`android.hardware.microphone` not required) and a `<queries>` entry for
`android.speech.RecognitionService`, without which API 30+ hides the recognizer. The composer asks
for the permission when the mic is tapped; after a denial it explains, and once Android blocks the
prompt it offers **Open settings**. No recognizer installed: the mic is hidden.

Driven from Rust only (`run_mobile_plugin`, not in the webview ACL): `installApk { path, openSettings }`
→ `{ status: "started" | "needsPermission" }`. First checks the archive with
`getPackageArchiveInfo(GET_SIGNING_CERTIFICATES)`: package name = ours, signing-certificate SHA-256
set = the installed app's, `longVersionCode` > the installed one; otherwise deletes the file and
rejects with `APK_REJECTED`. Then opens the package installer for the cache-dir APK via
the app's FileProvider (`${applicationId}.fileprovider`, `res/xml/file_paths.xml` →
`cache-path updates/`) with `FLAG_GRANT_READ_URI_PERMISSION`; needs `REQUEST_INSTALL_PACKAGES`
(plugin manifest) and, on Android 8+, the per-app "install unknown apps" grant: without it,
`needsPermission` and (with `openSettings`) `Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES` opens.

Desktop window chrome: `src/design/ui/TitleBar.tsx` (drag region, window controls; the maximize
button has `id="tf-max"` for the Windows 11 Snap Layouts overlay of `tauri-plugin-snap-layout`).
Linux uses the same undecorated window (opaque: `tauri.linux.conf.json`); macOS keeps native
traffic lights over the bar (`tauri.macos.conf.json`, `titleBarStyle: Overlay`) and TitleBar
drops its own buttons there.

## Deep links (`teleflock://`)

- `teleflock://agent/<hostId>/<agentId>` opens an agent (segments percent-encoded).
- `…?n=<notificationId>` = notification body tap (routed through `Engine::notification_action`).
- `teleflock://answer-next`, `teleflock://open`.

Windows: registered by the NSIS installer (`register_all()` in debug builds); a second instance
forwards its URL to the running one (single-instance). Linux: the `.deb` / Arch desktop entry
(`linux/teleflock.desktop`, `MimeType=x-scheme-handler/teleflock;`, `Exec=teleflock %u`); an
AppImage registers a `~/.local/share/applications` handler on every launch (`register_all()`);
single-instance forwards like on Windows (D-Bus). macOS: `CFBundleURLTypes` in Info.plist,
delivered to the running app by the OS. Android: intent filter from the deep-link plugin;
notification taps use it too.

## OS integration

| | Windows | Android |
|---|---|---|
| Notifications | WinRT toasts (tag = host/agent, group `agents`): buttons + inline reply (in-process activation), body = protocol deep link, cleared on quit | Kotlin notifications (tag = host/agent, id 1, grouped): ≤ 3 actions incl. RemoteInput reply → JNI → engine, even with the Activity gone |
| Handled elsewhere | `Platform::retract` → removed from Action Center by tag + group (`History.RemoveGroupedTagWithId`) if that tag still shows the notification; user close (`Dismissed`/`UserCanceled`) → `Engine::notification_dismissed` | `retract` command → cancelled by tag + id if the shown notification still carries that `notificationId` extra; group summary count updated, removed with the last child; swipe-away (delete intent) → JNI `onNotificationDismissed` → `Engine::notification_dismissed` |
| Badge | tray icon (comet while running: orbiting in Lively motion, still in Calm and Reduced; pink count when needs-you) + taskbar overlay + progress bar (running: marquee in Lively, a still full bar otherwise; needs-you: paused yellow) + flash | keep-alive notice text "3 running · 2 need you" |
| Keep-alive | window close hides to tray | `remoteMessaging` foreground service while `settings.keepAlive` and a host is connected |
| App closed from recents | — | the keep-alive service keeps the process and the core running without an activity. `MainActivity` reports its lifecycle over JNI (`RustBridge`): Kotlin commands are skipped meanwhile (Tauri can't reach plugins without an activity), so agent notifications are not posted until the app is opened again, and the next activity gets the main window rebuilt (`restore_main_window`; Tauri creates windows once per process, tauri-apps/tauri#15671), Wry's back handler (Tauri's is bound to the first activity) and its launch intent forwarded to the plugins (deep links) |
| Reconnect hints | window focus → `engine.resume(Resume::Focus)` (only links quiet for 20 s are checked, with 15 s to answer), update check if due | `MainActivity.onResume` (Tauri's `RunEvent::Resumed` never fires on Android) → `engine.resume(Resume::Foreground)` (every live link answers within 5 s), keep-alive start/stop retry, pending update install or an update check if due (`onPause` marks the app as not in front); default-network change → `engine.resume(Resume::Network)` |

Linux and macOS: no OS notifications (`supports_notifications() == false`: the engine keeps them
in the app, i.e. the inbox, tray badge and tooltip; a test notification answers `unsupported`).
Tray icon with the same badge and menu (Linux: libayatana-appindicator / StatusNotifierItem; the
comet stays still there), window close hides to the tray, focus → `engine.resume(Resume::Focus)` and an update check if due; macOS also
reopens the hidden window from the Dock (`RunEvent::Reopen`). `open_external` uses `xdg-open` /
`open`.

## Layout

- `src/lib.rs` builder, plugins, run loop · `core.rs` commands + event fan-out · `platform.rs`
  `tf_client::Platform` impl · `present.rs` notification presentation · `deeplink.rs` ·
  `tray.rs` + `badge.rs` (desktop) · `toast.rs` + `toastxml.rs` (Windows) · `update/` self-update.
- `plugins/teleflock-android/` Kotlin plugin crate (`dev.teleflock.android`).
- `gen/android/` generated by `tauri android init`, plus the release signing block, the theme and
  `MainActivity` (lifecycle reports to Rust, see "App closed from recents").

Builds: `scripts/build-hostd.sh`, `scripts/build-windows.sh`, `scripts/build-android.sh`,
`scripts/build-linux.sh`, `.github/workflows/macos.yml`; releases: `scripts/set-version.sh`,
`scripts/release.sh` (see `docs/build.md`).
