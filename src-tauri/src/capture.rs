//! Quick capture (desktop): a small always-on-top window (`capture.html`, label `capture`) that a
//! system-wide shortcut, the tray menu or `teleflock://capture` opens over any app. The page
//! talks to the main window in webview events (`src/features/capture/link.ts`): the main window
//! owns the stores and does the work. The shell creates, shows, hides and sizes the window and
//! owns the shortcut (`Settings.captureShortcut`: absent or empty = off until the user sets one;
//! [`DEFAULT_SHORTCUT`] is only what Settings suggests when they turn it on).
//!
//! Wayland lets no app listen for keys system-wide (global-hotkey grabs X11 keys, which XWayland
//! only delivers while an X11 window has focus), so there the shortcut is reported `unsupported`
//! with a command to bind in the desktop's own keyboard settings instead.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindowBuilder, window::Color};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tf_proto::{AppEvent, Settings};

use crate::core::CoreState;

pub const LABEL: &str = "capture";
const WIDTH: f64 = 640.0;
const INITIAL_HEIGHT: f64 = 300.0;
const MIN_HEIGHT: f64 = 150.0;
const MAX_HEIGHT: f64 = 640.0;
/// Status changes (Settings → Quick capture listens).
pub const STATUS_EVENT: &str = "capture-status";

/// What Settings offers when the user turns the shortcut on (it is off until they do: a global
/// grab of a chord other software may use isn't something an upgrade should do unasked).
/// macOS: ⌃⌥Space switches input sources and ⌥⌘Space opens a Finder search.
pub const DEFAULT_SHORTCUT: &str = if cfg!(target_os = "macos") { "Cmd+Shift+Space" } else { "Ctrl+Alt+Space" };

const PLATFORM: &str = if cfg!(windows) {
    "windows"
} else if cfg!(target_os = "macos") {
    "macos"
} else {
    "linux"
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Registered,
    Off,
    Taken,
    Invalid,
    Unsupported,
    Failed,
}

/// What Settings shows (`capture_status`, [`STATUS_EVENT`]); `src/features/capture/QuickCaptureSettings.tsx`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    platform: &'static str,
    /// The accelerator wanted; "" = off.
    shortcut: String,
    default_shortcut: &'static str,
    state: State,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    /// Wayland: what to bind in the desktop's own shortcut settings.
    #[serde(skip_serializing_if = "Option::is_none")]
    command: Option<String>,
}

/// What the capture page says it holds ([`capture_draft`]).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Draft {
    /// Text in the box (it survives a restart in the page's localStorage).
    typing: bool,
    /// Pasted images or a request waiting for the main window: lost by a restart.
    unsaved: bool,
}

pub struct Capture {
    status: Mutex<Status>,
    /// What is registered with the OS now (unregistered before another one is).
    registered: Mutex<Option<Shortcut>>,
    /// What the page holds, for the updater (`in_front`).
    draft: Mutex<Draft>,
    /// Why this session can't have a system-wide shortcut (Wayland, no display, plugin failed).
    unsupported: Option<String>,
}

/// Why a Linux session can't take a system-wide shortcut, from its environment.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn unsupported_reason(wayland_display: bool, session_type: Option<&str>, x_display: bool) -> Option<&'static str> {
    if wayland_display || session_type.is_some_and(|t| t.eq_ignore_ascii_case("wayland")) {
        return Some("Wayland doesn't let apps listen for a shortcut system-wide.");
    }
    if !x_display {
        return Some("There is no X11 display to listen on.");
    }
    None
}

/// The shortcut `Settings.captureShortcut` asks for: `None` = off.
pub fn wanted(setting: Option<&str>) -> Option<&str> {
    match setting.map(str::trim) {
        None | Some("") => None,
        Some(s) => Some(s),
    }
}

/// How a refused registration reads in Settings.
pub fn refusal(message: &str) -> State {
    if message.to_ascii_lowercase().contains("already registered") { State::Taken } else { State::Failed }
}

fn quote(path: &str) -> String {
    if path.chars().all(|c| c.is_ascii_alphanumeric() || "/._-+".contains(c)) { path.to_owned() } else { format!("'{}'", path.replace('\'', "'\\''")) }
}

/// The command that opens Quick capture in the running app (single-instance forwards the link).
/// In an AppImage that is the AppImage itself, not the binary mounted inside it (Linux only).
fn open_command<R: Runtime>(app: &AppHandle<R>) -> String {
    #[cfg(target_os = "linux")]
    let exe = app.env().appimage.map(std::path::PathBuf::from).or_else(|| std::env::current_exe().ok());
    #[cfg(not(target_os = "linux"))]
    let exe = {
        let _ = app;
        std::env::current_exe().ok()
    };
    let exe = exe.map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| "teleflock".to_owned());
    format!("{} teleflock://capture", quote(&exe))
}

fn handler<R: Runtime>(app: &AppHandle<R>, _shortcut: &Shortcut, event: tauri_plugin_global_shortcut::ShortcutEvent) {
    if event.state == ShortcutState::Pressed {
        toggle(app);
    }
}

/// Installs the shortcut plugin (where the session allows it), the managed state and the settings
/// watcher. Never fails the app: a session without system-wide shortcuts keeps the tray item.
pub fn install<R: Runtime>(app: &AppHandle<R>, core: CoreState) {
    #[cfg(target_os = "linux")]
    let mut unsupported = unsupported_reason(
        std::env::var_os("WAYLAND_DISPLAY").is_some(),
        std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
        std::env::var_os("DISPLAY").is_some(),
    )
    .map(str::to_owned);
    #[cfg(not(target_os = "linux"))]
    let mut unsupported: Option<String> = None;
    if unsupported.is_none()
        && let Err(e) = app.plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(handler).build())
    {
        log::warn!("quick capture: no global shortcuts: {e}");
        unsupported = Some(format!("System-wide shortcuts aren't available: {e}"));
    }
    let command = unsupported.as_ref().map(|_| open_command(app));
    app.manage(Capture {
        status: Mutex::new(Status {
            platform: PLATFORM,
            shortcut: String::new(),
            default_shortcut: DEFAULT_SHORTCUT,
            state: State::Off,
            reason: None,
            command,
        }),
        registered: Mutex::new(None),
        draft: Mutex::new(Draft::default()),
        unsupported,
    });

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut rx = core.engine.subscribe();
        let mut last: Option<Option<String>> = None;
        let mut settings = core.engine.call(None, "settings.get", serde_json::json!({})).await.ok().and_then(|v| serde_json::from_value::<Settings>(v).ok());
        loop {
            if let Some(s) = settings.take()
                && last.as_ref() != Some(&s.capture_shortcut)
            {
                last = Some(s.capture_shortcut.clone());
                let app = app.clone();
                // Registering waits for the main thread.
                let _ = tauri::async_runtime::spawn_blocking(move || apply(&app, s.capture_shortcut.as_deref())).await;
            }
            match rx.recv().await {
                Ok(AppEvent::Settings { settings: s }) => settings = Some(s),
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// Registers the shortcut `setting` asks for (replacing the previous one) and publishes the outcome.
fn apply<R: Runtime>(app: &AppHandle<R>, setting: Option<&str>) {
    let Some(cap) = app.try_state::<Capture>() else { return };
    let want = wanted(setting);
    let mut status = cap.status.lock().unwrap_or_else(|e| e.into_inner()).clone();
    status.shortcut = want.unwrap_or_default().to_owned();
    status.reason = None;
    let parsed = want.map(|w| w.parse::<Shortcut>());
    let mut registered = cap.registered.lock().unwrap_or_else(|e| e.into_inner());
    let same = matches!((&parsed, registered.as_ref()), (Some(Ok(p)), Some(r)) if p == r);
    if !same && let Some(old) = registered.take() {
        let _ = app.global_shortcut().unregister(old);
    }
    status.state = match (&cap.unsupported, parsed) {
        (_, None) => State::Off,
        (Some(why), Some(_)) => {
            status.reason = Some(why.clone());
            State::Unsupported
        }
        (None, Some(Err(e))) => {
            status.reason = Some(e.to_string());
            State::Invalid
        }
        (None, Some(Ok(_))) if same => State::Registered,
        (None, Some(Ok(s))) => match app.global_shortcut().register(s) {
            Ok(()) => {
                *registered = Some(s);
                State::Registered
            }
            Err(e) => {
                log::warn!("quick capture: {} not registered: {e}", status.shortcut);
                status.reason = Some(e.to_string());
                refusal(&e.to_string())
            }
        },
    };
    drop(registered);
    if let Some(p) = app.try_state::<std::sync::Arc<crate::platform::TauriPlatform>>()
        && let Some(tray) = p.shell.tray.get()
    {
        tray.set_capture_shortcut((status.state == State::Registered).then_some(status.shortcut.as_str()));
    }
    *cap.status.lock().unwrap_or_else(|e| e.into_inner()) = status.clone();
    let _ = app.emit(STATUS_EVENT, status);
}

/// Shows the window (created on first use) on the monitor under the pointer, focused.
pub fn show<R: Runtime>(app: &AppHandle<R>) {
    // Opening the box is the user at work: a departure being timed for an update is void.
    if let Some(u) = app.try_state::<crate::update::UpdaterState>() {
        u.active();
    }
    if let Some(w) = app.get_webview_window(LABEL) {
        place(app, &w);
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        let _ = w.emit_to(LABEL, "tf-capture://shown", ());
        return;
    }
    // Off the calling thread: the shortcut handler may run on the main thread, which building a
    // webview waits for on some platforms.
    let app = app.clone();
    std::thread::spawn(move || {
        let built = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("capture.html".into()))
            .title("TeleFlock · Quick capture")
            .inner_size(WIDTH, INITIAL_HEIGHT)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .decorations(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .shadow(true)
            .background_color(Color(11, 11, 16, 255))
            // HTML5 drops (screenshots dragged onto the box), as in the main window.
            .disable_drag_drop_handler()
            .visible(false)
            .build();
        match built {
            Ok(w) => {
                place(&app, &w);
                let _ = w.show();
                let _ = w.set_focus();
            }
            Err(e) => log::error!("quick capture: window not created: {e}"),
        }
    });
}

/// The shortcut again while the box has focus puts it away; otherwise it comes to the front.
pub fn toggle<R: Runtime>(app: &AppHandle<R>) {
    match app.get_webview_window(LABEL) {
        Some(w) if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) => hide(app),
        _ => show(app),
    }
}

pub fn hide<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.emit_to(LABEL, "tf-capture://hidden", ());
        let _ = w.hide();
        // An update waiting for the user to leave starts timing from now.
        if let Some(u) = app.try_state::<crate::update::UpdaterState>() {
            u.left_front();
        }
    }
}

/// What the updater needs to know about the user's use of Quick capture (`update::apply::capture_in_front`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub visible: bool,
    pub focused: bool,
    pub typing: bool,
    pub unsaved: bool,
}

/// The window's state (unreadable = shown and focused, i.e. in use) and what the page holds.
pub fn usage<R: Runtime>(app: &AppHandle<R>) -> Usage {
    let Some(cap) = app.try_state::<Capture>() else { return Usage::default() };
    let draft = *cap.draft.lock().unwrap_or_else(|e| e.into_inner());
    let (visible, focused) = app.get_webview_window(LABEL).map_or((false, false), |w| (w.is_visible().unwrap_or(true), w.is_focused().unwrap_or(true)));
    Usage { visible, focused, typing: draft.typing, unsaved: draft.unsaved }
}

/// Top centre (a fifth down) of the monitor the pointer is on; the window manager decides where
/// it can't be asked (Wayland).
fn place<R: Runtime>(app: &AppHandle<R>, w: &tauri::WebviewWindow<R>) {
    let monitor = app.cursor_position().ok().and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten()).or_else(|| w.current_monitor().ok().flatten());
    let Some(m) = monitor else {
        let _ = w.center();
        return;
    };
    let (pos, size, scale) = (m.position(), m.size(), m.scale_factor());
    let width = (WIDTH * scale) as i32;
    let x = pos.x + (size.width as i32 - width).max(0) / 2;
    let y = pos.y + size.height as i32 / 5;
    let _ = w.set_position(PhysicalPosition::new(x, y));
}

#[tauri::command]
pub fn capture_status<R: Runtime>(app: AppHandle<R>) -> Option<Status> {
    app.try_state::<Capture>().map(|c| c.status.lock().unwrap_or_else(|e| e.into_inner()).clone())
}

#[tauri::command]
pub fn capture_open<R: Runtime>(app: AppHandle<R>) {
    show(&app);
}

#[tauri::command]
pub fn capture_hide<R: Runtime>(app: AppHandle<R>) {
    hide(&app);
}

/// The page reports what it holds (`CaptureWindow.tsx`, on every change): text typed, and what a
/// restart would lose (images, a send in flight). The updater counts that as the user being at
/// work (`in_front`), so it neither restarts the app under them nor loses the images.
#[tauri::command]
pub fn capture_draft<R: Runtime>(app: AppHandle<R>, typing: bool, unsaved: bool) {
    let Some(cap) = app.try_state::<Capture>() else { return };
    let next = Draft { typing, unsaved };
    if std::mem::replace(&mut *cap.draft.lock().unwrap_or_else(|e| e.into_inner()), next) == next {
        return;
    }
    if let Some(u) = app.try_state::<crate::update::UpdaterState>() {
        if typing || unsaved { u.active() } else { u.left_front() }
    }
}

/// The page fits the window to its content (width fixed).
#[tauri::command]
pub fn capture_resize<R: Runtime>(app: AppHandle<R>, height: f64) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.set_size(LogicalSize::new(WIDTH, height.clamp(MIN_HEIGHT, MAX_HEIGHT)));
    }
}

/// "Open in Dispatch" / "Answer in TeleFlock": the main window comes forward.
#[tauri::command]
pub fn capture_show_main<R: Runtime>(app: AppHandle<R>) {
    crate::tray::show_main(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wayland_and_headless_sessions_have_no_global_shortcuts() {
        assert!(unsupported_reason(true, None, true).is_some());
        assert!(unsupported_reason(false, Some("wayland"), true).is_some());
        assert!(unsupported_reason(false, Some("x11"), false).is_some());
        assert_eq!(unsupported_reason(false, Some("x11"), true), None);
        assert_eq!(unsupported_reason(false, None, true), None);
    }

    #[test]
    fn setting_absent_or_empty_is_off() {
        assert_eq!(wanted(None), None);
        assert_eq!(wanted(Some("  ")), None);
        assert_eq!(wanted(Some(" Ctrl+Shift+K ")), Some("Ctrl+Shift+K"));
    }

    #[test]
    fn defaults_and_recorded_shortcuts_parse() {
        for s in [DEFAULT_SHORTCUT, "Ctrl+Alt+Space", "Cmd+Shift+Space", "Ctrl+Alt+Shift+K", "Super+Backquote", "Alt+F7", "F13", "Ctrl+Num5"] {
            assert!(s.parse::<Shortcut>().is_ok(), "{s}");
        }
        assert!("Ctrl+".parse::<Shortcut>().is_err());
        assert!("Ctrl+Nope".parse::<Shortcut>().is_err());
    }

    #[test]
    fn refusals() {
        assert_eq!(refusal("HotKey already registered: HotKey { .. }"), State::Taken);
        assert_eq!(refusal("Unable to register hotkey: Unknown VKCode"), State::Failed);
        assert_eq!(quote("/usr/bin/teleflock"), "/usr/bin/teleflock");
        assert_eq!(quote("/home/a b/TeleFlock.AppImage"), "'/home/a b/TeleFlock.AppImage'");
    }
}
