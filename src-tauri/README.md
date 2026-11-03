# src-tauri — TeleFlock app shell (owner: TauriShell)

Embeds `tf_client::Engine` (AppCore) and wires it to the webview and the OS.

## Webview API

| Call | Args (camelCase) | Result |
|---|---|---|
| `invoke("core_call", …)` | `{ hostId: string \| null, method: string, params?: unknown }` | method result; rejects with a tf-proto `ApiError`. `app.update*` are answered by the shell (below), everything else by the engine |
| `invoke("core_term_input", …)` | `{ hostId, termId, data: string }` | `void` (fast path, never waits for the host) |
| `invoke("core_events", …)` | `{ channel: Channel<AppEvent[]> }` | `void`. Replays current state first (Profiles, Settings, Tunnels, HostStatus + HostSnapshot per host), then streams live events, in order, in batches (a live event with whatever queued behind it; one webview eval per batch). Call once per page load; a reload drops older subscriptions. |
| `invoke("doc_stage", …)` | `{ html: string }` | `string`: the URL to frame the document from (`tfdoc://localhost/<token>`; Windows, Android `http://tfdoc.localhost/<token>`). Rejects (message string) for a document over 96 MiB. See "Presented documents" |
| `invoke("doc_release", …)` | `{ url: string }` | `void`; an unknown URL is no error |
| `invoke("doc_open", …)` | `{ name: string, base64: string }` | `void` once the file is written and handed to the OS; rejects with a message string (Android: `"unsupported"`) |

UI intents arrive on the `core_events` channel: `{type:"openAgent", hostId, agentId}` (toast / notification /
deep link), `{type:"openPage", hostId, page, notificationId?}` and `{type:"openPresented", hostId, agentId, name}`
(a notification that names a host's page or a document an agent presented) and `{type:"answerNext"}` (tray
menu, `teleflock://answer-next`). Intents raised while no page is subscribed (cold start from a notification)
are delivered right after the next replay.

## Presented documents (`src/docs.rs`)

An agent-presented HTML page (docs/architecture.md §3.32) is framed from the `tfdoc` URI scheme,
not as an `srcdoc` frame, which would inherit the app's CSP (no inline scripts).
- `doc_stage` keeps the document in memory under a 128-bit token (32 hex digits: two SipHash
  values under the process's random `RandomState` keys) and answers its URL: `tfdoc://localhost/<token>`
  on macOS and Linux, `http://tfdoc.localhost/<token>` on Windows and Android (Tauri's form for
  custom schemes there; `useHttpsScheme` is off). At most 12 documents, 96 MiB together: staging
  past either limit evicts the oldest, and a document over 96 MiB on its own is refused. Both
  CSPs in `tauri.conf.json` allow these URLs in `frame-src` (not on Android, below).
- The protocol (asynchronous, every webview) answers `GET /<token>` with the document and
  `Content-Type: text/html; charset=utf-8`, `Content-Security-Policy:` the artifact policy
  (`default-src 'none'`; scripts, styles, images, fonts, media and workers inline or `data:`/`blob:`
  only; frames, connections, objects, forms, `<base>` and manifests `'none'`) plus
  `sandbox allow-scripts`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: no-referrer`; an unknown token answers 404, another method 405 (plain text).
  The copy into the response is made on the blocking pool, not on the webview thread.
- `doc_release` drops a document the page no longer shows.
- `doc_open` (desktop) decodes the bytes (64 MiB at most) and writes them to
  `<temp>/teleflock-docs-<uid>/<random>/<name>` on Unix (`/tmp` is shared on Linux: one folder per
  account, so another account's folder is never in the way) and `%TEMP%\teleflock-docs\<random>\<name>`
  on Windows (folders 0700, file 0600 on Unix), after deleting the folders there older than 24 h,
  then opens the file the way `open_external` opens a URL (`platform::open_default`: ShellExecute,
  `open`, `xdg-open`). The folder must be this user's own and not a symlink; otherwise nothing is
  written or pruned. The name keeps only `[A-Za-z0-9._ -]` (each run of other characters becomes
  one `_`), of a path its last segment, at most 100 characters with the extension, never empty,
  never starting with a dot, never a Windows device name (`con.html` → `_con.html`). An extension
  outside what the app writes (an `.html` page with the artifact policy first, Markdown, images,
  JSON, text) and sources that open in an editor gets `.txt` appended, and so does a name without
  one: a presented `.bat`, `.js` (Windows Script Host), `.py`, `.command` or `.desktop` opens as
  text instead of running, `.svg`/`.xml` (scripts a browser would run) and `.csv`/`.tsv` (formulas a
  spreadsheet would evaluate) too. The app names the file by what it shows (`docFileName` in
  `src/features/session/artifacts/load.ts`).

App commands need no capability entry: the app defines no ACL manifest of its own, so Tauri
checks them only for remote origins, and the page is local.

## Frames of presented documents (`src/frames.rs`, desktop)

CSP covers neither WebRTC nor resource hints. The `tf-frames` plugin (no commands) runs a script in
every frame of every webview before the frame's own scripts (wry: WebView2's document-created
scripts, WebKit user scripts in all frames); in a frame of an opaque origin (every frame of a
presented page, and every frame such a page makes) it removes `RTCPeerConnection` and its kin. On
Linux, `frames::harden` also turns WebKitGTK's WebRTC off (its default) and its `LinkPreconnect`
feature off in the main window (`webkit_settings_set_feature_enabled`, looked up with `dlsym`:
WebKitGTK 2.42+; an older one keeps preconnecting and logs a warning). `cargo test -p teleflock
--lib frames` checks the switch exists, and under a display (`xvfb-run`) that it turns off.

## Quick capture (`src/capture.rs`, desktop)

A second webview window, label `capture` (`capture.html` → `src/capture/main.tsx`, capability
`capabilities/capture.json`: events + dragging), created on first use: 640 px wide, undecorated,
always on top, on all workspaces, not in the taskbar, top-centre of the monitor under the pointer.
Opened by the system-wide shortcut (tauri-plugin-global-shortcut 2.4.1; `Settings.captureShortcut`,
absent or empty = off until the user sets one in Settings (which suggests `Ctrl+Alt+Space` / macOS `Cmd+Shift+Space`); re-registered on every
`settings` change; pressing it while the box has focus hides it), the tray's **Quick capture…**
(its menu item shows the registered shortcut) and `teleflock://capture` (the main window is not
brought forward; a second instance with that argv only forwards it). Its page talks to the main
window in webview events, never to the engine (`src/features/capture/README.md`); `on_page_load`
resets the engine's page state for the `main` webview only.

| Call (either window) | Args | Result |
|---|---|---|
| `invoke("capture_status")` | – | `{ platform, shortcut, defaultShortcut, state: "registered" \| "off" \| "taken" \| "invalid" \| "unsupported" \| "failed", reason?, command? }`; changes are emitted as `capture-status` |
| `invoke("capture_open")` / `invoke("capture_hide")` | – | `void`; the page gets `tf-capture://shown` / `tf-capture://hidden` |
| `invoke("capture_draft", { typing, unsaved })` | bools | `void`; what the box holds (`typing`: a task, text or images, both kept across restarts; `unsaved`: a send in flight), reported on every change: the updater counts it as the user at work |
| `invoke("capture_resize", { height })` | logical px | `void` (clamped 150–640, width fixed) |
| `invoke("capture_show_main")` | – | `void`; main window to the front ("Open in Dispatch", "Answer in TeleFlock") |

Linux: X11 sessions only. Under Wayland (`WAYLAND_DISPLAY` or `XDG_SESSION_TYPE=wayland`) or
without `DISPLAY` the plugin isn't installed and the state is `unsupported` with `command`
(`<exe or AppImage> teleflock://capture`) to bind in the desktop's own shortcut settings.
`taken` = the OS reported the combination registered by another client (X11 `BadAccess`, Win32
`ERROR_HOTKEY_ALREADY_REGISTERED`, macOS duplicate).

## Self-update (`src/update/`)

Same IPC as the engine's app methods (typed in tf-proto `AppMethods`, so the UI calls
`core.app("app.updateCheck", …)`), but answered in `core_call` by `update::Updater` before the
engine sees them (tf-client answers them `unsupported`, e.g. for tf-devserver). Status changes
are pushed as `{type:"update", status: UpdateStatus}` on the `core_events` channel.

| Method | Params | Result |
|---|---|---|
| `app.updateStatus` | `{}` | `UpdateStatus` `{ current, supported, manual, needsPassword, unsupportedReason?, phase, latest?, progress?, error?, checkedAt? }` |
| `app.updateCheck` | `{ install }` | `UpdateStatus` once discovery is done. `install`: install a newer release right away (a manual check does; an automatic one only downloads on Windows/Linux, see below) |
| `app.updateInstall` | `{}` | `UpdateStatus`; starts download + install of the last found release (`not_found` before a check found one), or installs the downloaded update that waits in `ready`. `manual` (macOS): opens the release's `.dmg` in the browser instead |

`phase`: `idle` → `checking` → `upToDate` \| `available` → `downloading` (`progress` 0–100) →
`ready` (desktop, automatic checks only) → `installing`; `needsPermission` (Android), `error` (message in `error`; failures are only logged and
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
  `settings.autoUpdate` is on (read from the engine with `settings.get` and `{}` params, unit-tested
  in `mod.rs`; settings that can't be read count as off), never for unsupported copies. Up to
  v0.6.1 that read sent `null`, which `settings.get` rejects, so no automatic check ever ran
  (docs/build.md §11). Failed checks, failed installs and
  dismissed Android install prompts back off (30 min doubling to 12 h, at least the period); a
  clean result resets it. At most about 3 API requests per hour and device (GitHub allows 60
  anonymous ones per IP). What they find installs like `{ install: true }` on Android; on Windows
  and Linux they only download (next bullet).
- Install timing on Windows and Linux (`apply.rs`, `Origin` × window state × target, unit-tested):
  a manual check or click (`Origin::Manual`: Check for updates, Update to vX, Restart now,
  Install) downloads and installs at once. An automatic one (`Origin::Automatic`) downloads in
  the background, verifies it and parks the package in memory as `phase: "ready"` (the UI toasts
  "Update ready · Restart now" once per version and Settings shows the same button). While the user
  is in front it stays there: the main window shown, not minimized and focused, **Quick capture
  in use** (`capture::usage` → `apply::capture_in_front`: focused; shown with a task in it; or,
  shown or not, a send waiting for the main window, which a restart would lose), or a page with a
  video upload in flight (`drafts_busy`, below).
  Once the user has been away for `AWAY_GRACE` (20 s, so an alt-tab doesn't count) *without a
  break* and `settings.autoUpdate` is still on, it installs and restarts. Every departure
  (`WindowEvent::Focused(false)` of `main` or `capture`, close-to-tray, capture hidden or emptied →
  `Updater::left_front`) starts a timer on `apply::Away`'s counter; every return (any
  `Focused(true)` → `Updater::foreground`, capture opened or typed in → `Updater::active`) and every
  later departure bumps it, and a timer only installs if the counter is unchanged, so away at 0 s,
  back at 5 s and away again at 19 s installs at 39 s, never at 20 s (unit-tested with real short
  timers in `apply.rs`). The AppImage also installs when the app quits (`RunEvent::Exit`; the quit
  is the user's own and nothing restarts, so an open capture box doesn't change it). Windows
  doesn't install at quit (its
  installer relaunches the app) and drops the downloaded package: the next automatic check
  fetches it again. The `.deb` (`needsPassword: true`, `pkexec dpkg -i`) never installs
  unattended at all: it stays `ready` ("Update ready · Install") until the user clicks.
  `ready` also pauses the automatic checks (`Schedule::due`). Android and macOS are unchanged.
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
- Unsent drafts (`src/drafts.rs`, unit-tested, and `apply::install_and_restart`): before anything
  that ends the process (the Linux restart, right after the install; the Windows installer, right
  before it starts; the tray's Quit, where the AppImage installs; the Android installer) the shell
  emits `tf-drafts://flush` with a request id to the pages that called `invoke("drafts_listen")`
  and waits until each called `invoke("drafts_flushed", { id })`, 3 s at most. A page answers once
  every draft is in IndexedDB (`src/core/draftFlush.ts`); a page that starts loading stops
  counting. `invoke("drafts_busy", { busy })`: the page holds an upload a restart would lose; the
  automatic install waits like for a user in front (its end restarts the 20 s grace).
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
| `invoke("plugin:teleflock-android\|take_shares")` | – | `{ shares: { id, text?, subject?, images: { mime, data (base64), name? }[], skipped? }[] }`: what was shared to TeleFlock since the last call (≤ 4 kept); a `share` plugin event (`addPluginListener`) announces new ones |
| `invoke("plugin:teleflock-android\|share_image", { name, data, text? })` | `name`: file name; `data`: PNG, base64; `text`: caption | `void` once the system share sheet opened (the PNG goes to `<cache>/shared/`, offered read-only through the app's FileProvider); rejects `SHARE_FAILED`. Flock Wrapped's **Share…**: the WebView has no downloads or Web Share |
| `invoke("plugin:teleflock-android\|open_preview", { url, title?, subtitle? })` | `url`: a preview tunnel's page, `http(s)://127.0.0.1\|localhost[:port]/…`; `title`, `subtitle`: the window's two lines | `void` once the preview window opened; rejects `BAD_URL` for any other address. `showPreview` (`src/features/preview/store.ts`) sends every live tunnel there in the Android app, on any layout; only the demo host's `blob:` documents stay in the sheet |

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

Preview window (`PreviewActivity.kt`, `PreviewLinks.kt`): on Android every frame of the app's page
gets Tauri's IPC and calls in the name of the top page (docs/architecture.md §8, "Framed content"),
so a tunnel's page opens in an activity of its own (not exported; the application's theme; rotation
doesn't reload it) whose WebView is a plain one: no `ipc` bridge object, no document-start
scripts, no request interception. Loopback pages (`127.0.0.1`, `localhost`, the hosts the network
security config lets through in clear text) and their `blob:` documents stay in it; other http(s)
links open in the browser when tapped (`hasGesture`), a page redirecting by itself goes nowhere;
other schemes (`intent:`, `file:`, `content:`, `javascript:` …) go nowhere. Downloads and **Open in
browser** hand the http(s) address to the browser; camera, microphone and location requests are
denied; an upload field opens the system file picker; back steps through the page's history, then
closes the window. A renderer crash closes the window. JVM unit tests:
`./gradlew --offline :tauri-plugin-teleflock-android:testDebugUnitTest` in `gen/android`.
`tauri.android.conf.json` narrows both CSPs' `frame-src` to `blob:` (the demo host's previews), so
the Android page can't frame anything fetched; the CSPs are maps of directives so that this patch
(JSON Merge Patch over `tauri.conf.json`) replaces only `frame-src`. `cargo test -p teleflock --lib
csp` reads the merged config the way Tauri does and checks both.

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

### What's new after an update (frontend: `src/features/updates/{releaseNotes.ts,WhatsNew.tsx}`)

The shell does not take part. On every platform (desktop, Android, browser, devserver, demo) the
webview compares its own version (`__APP_VERSION__`) with the last one this device showed
(`localStorage` `tf.whatsNew`: `{ seen, failedStarts }`) and, when newer, reads the release notes
itself from `GET https://api.github.com/repos/studioplascode/TeleFlock/releases?per_page=30`
(the endpoint `release.rs` uses; hence `https://api.github.com` in `connect-src` of both CSPs in
`tauri.conf.json`). Apps up to 0.8.x never wrote the record, so with no record the check (run once
the host profiles have loaded) tells an update from a fresh install by whether a real, non-demo host
is configured: yes → the running version's notes are shown; no → the version is recorded silently.
See `docs/architecture.md` §6.12 for the behaviour.

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

### Linux and macOS notifications

Both report through the same `ToastEvent`s as Windows (`present.rs`): `Activated` (button, reply,
or the body: both `None`, which also brings the window forward) and `Dismissed` →
`Engine::notification_action` / `notification_dismissed`; `retract` removes a notification only
while its tag still shows it; the whole set is cleared on quit (their buttons need the process).

- **Linux (`xdg_notify.rs`).** `org.freedesktop.Notifications` over zbus, already in the build
  through the single-instance plugin: no new crate, no libdbus, no package dependency; the
  server is part of every desktop (GNOME Shell, KDE, xfce4-notifyd, dunst, mako). One session-bus
  connection both sends and receives (dunst sends a notification's signals only to the connection
  that posted it), one listener thread for the signals, one worker thread for the calls, so tokio
  never waits on D-Bus. The probe (`GetServerInformation`) runs on a thread of its own at startup:
  until a server answers, `supports_notifications()` is false (inbox and tray only; the Settings
  test says unsupported). One live notification per agent: the same tag posts again with the old
  server id as `replaces_id`. `GetCapabilities` decides the shape: buttons (`a:<id>` actions) only
  with `actions`, `default` (body click) always, KDE's inline reply with `inline-reply`
  (`NotificationReplied`), body escaped with `body-markup` and folded into the title without
  `body`. Hints: `desktop-entry` (`TeleFlock`, only when the package installed
  `TeleFlock.desktop`), `urgency` (low when silent), `category` (`im.received` needs,
  `transfer.complete` finished, `im.error` errors), `suppress-sound` / `sound-name`
  (`message-new-instant`), `x-kde-origin-name` (host). Needs-you notifications ask for no expiry
  (servers like GNOME ignore that). Icon: theme name `teleflock` when the .deb / Arch package
  installed it, else `teleflock-notification.png` written once to the app's local data dir
  (AppImage). `NotificationClosed` reason 2 (user) → `Dismissed`; expiry keeps the notification
  known (a later retract still closes it), our own closes report nothing. Not used: the Wayland
  `ActivationToken` (GTK only reads one at startup), so a click raises the window without it where
  the compositor refuses focus.
- **macOS (`mac_notify.rs`).** `UNUserNotificationCenter` through `objc2-user-notifications`
  (the same objc2 0.6 stack tauri uses). Only in a bundled app: without a bundle identifier
  (`tauri dev`, a bare binary) UserNotifications raises, so there the notifier is not created and
  `supports_notifications()` is false. The permission (alert, sound, badge) is requested at
  startup (the system prompts once); a denial turns support off for that run. One delegate
  (`TeleFlockNotificationDelegate`) handles responses and `willPresent` (banner + list + sound,
  list only when silent, so notifications also show while the app is in front). The request
  identifier is the short tag (re-adding it replaces in place). Buttons live in one
  `UNNotificationCategory` per distinct action set (id spells out buttons, labels, destructive
  flags and the reply flag; bounded to 32, LRU), all with `CustomDismissAction` so a swipe-away
  arrives without polling; the reply is a `UNTextInputNotificationAction`. Notifications are
  grouped per host (`threadIdentifier`), silent ones are `passive` (macOS 12+, guarded for 11).
  The pure parts (tag map, response mapping, categories) are `mac_model.rs`, unit-tested on every
  OS. Not verified on a Mac (none available; CI builds it).

### System presence (`idle.rs`)

`Platform::system_presence()` (polled about every 15 s from `spawn_blocking`) feeds the device
presence the engine sends to hosts: Windows `GetLastInputInfo` against `GetTickCount` plus the
lock state (the input desktop cannot be switched to: lock screen or UAC); macOS
`CGEventSourceSecondsSinceLastEventType` on the combined session state (lock state unknown: a
locked Mac turns away through the idle time); Linux over the session bus: idle from GNOME's
`org.gnome.Mutter.IdleMonitor.GetIdletime` (ms), else KDE's
`org.freedesktop.ScreenSaver.GetSessionIdleTime` (X11 only, ms), lock from `GetActive` of
`org.freedesktop.ScreenSaver` / `org.gnome.ScreenSaver`. The answering source is remembered; a
desktop with none (sway, i3, xfce) reports unknown and presence rests on what the window reports
(`app.presence`); a failed probe is repeated every 5 minutes at most. Every D-Bus call has a 2 s timeout, and the engine gives a whole read 3 s (`tf_client::presence::read_system`; unknown after that); `settings.set` and `app.presence` refresh presence in the background, one refresh at a time, so a desktop service that stops answering never stalls them and hosts get presence in the order it was read.

Tray icon with the same badge and menu (Linux: libayatana-appindicator / StatusNotifierItem; the
comet stays still there), window close hides to the tray, focus → `engine.resume(Resume::Focus)`
and an update check if due; macOS also reopens the hidden window from the Dock
(`RunEvent::Reopen`). `open_external` uses `xdg-open` / `open`.

## Dictation on desktops

The shell builds tf-client with `voice` on Windows, macOS and Linux (`Cargo.toml`), so `dictation.*` and its
events go through `core_call` / `core_events` like every app method (docs/architecture.md §6.16); the speech
engine is linked into the binary (docs/build.md §10.5), the models are downloaded in Settings → Dictation. The
page's `useDictation` uses it once a speech model is chosen, else the webview's Web Speech API where it has one.
Microphone access:
- macOS: `Info.plist` (merged into the bundle's by the bundler) holds `NSMicrophoneUsageDescription` (and
  `NSSpeechRecognitionUsageDescription` for the webview's speech recognition); `Entitlements.plist`
  (`bundle.macOS.entitlements` in `tauri.macos.conf.json`) grants `com.apple.security.device.audio-input`,
  without which the hardened runtime withholds the microphone without asking. A refusal says where to allow it
  (System Settings → Privacy & Security → Microphone).
- Windows: a refusal points at Settings → Privacy & security → Microphone → Let desktop apps access your microphone.
- Linux: ALSA (`libasound2`, a package dependency).

The Android app keeps `Dictation.kt` (above): tf-dictation is not built for it.

## Layout

- `src/lib.rs` builder, plugins, run loop · `core.rs` commands + event fan-out · `platform.rs`
  `tf_client::Platform` impl + `open_default` · `present.rs` notification presentation +
  `ToastEvent` · `docs.rs` presented documents (`tfdoc:` protocol, `doc_*` commands) ·
  `deeplink.rs` · `tray.rs` + `badge.rs` (desktop) · `toast.rs` + `toastxml.rs` (Windows) ·
  `xdg_notify.rs` (Linux) · `mac_notify.rs` + `mac_model.rs` (macOS) · `idle.rs` (system
  presence) · `update/` self-update · `csp.rs` (test only: the page's CSP per platform).
- `plugins/teleflock-android/` Kotlin plugin crate (`dev.teleflock.android`).
- `gen/android/` generated by `tauri android init`, plus the release signing block, the theme and
  `MainActivity` (lifecycle reports to Rust, see "App closed from recents").

Builds: `scripts/build-hostd.sh`, `scripts/build-windows.sh`, `scripts/build-android.sh`,
`scripts/build-linux.sh`, `.github/workflows/macos.yml`; releases: `scripts/set-version.sh`,
`scripts/release.sh` (see `docs/build.md`).
