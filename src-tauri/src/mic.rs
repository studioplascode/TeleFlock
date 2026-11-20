//! The microphone's permissions where only the desktop shell can reach them: three `dictation.*`
//! app methods it answers before the engine, as `update/` does (docs/architecture.md §5.4, §6.16).
//!
//! - **The system's settings page.** Windows keeps the decision in Settings → Privacy & security →
//!   Microphone, macOS in System Settings → Privacy & Security → Microphone. Neither asks again once
//!   refused, and no app may change it, so the app can only open the page:
//!   `dictation.openMicrophoneSettings`; `dictation.microphoneAccess` says it can (`settings`).
//! - **The window's own permission (Windows).** The page's speech recognition (System in Settings →
//!   Dictation) records through WebView2, which asks first with a prompt of its own ("tauri.localhost
//!   wants to use your microphone") and keeps a Block in the app's WebView2 profile for good: it never
//!   asks again, and nothing in Windows' settings undoes it. `dictation.microphoneAccess` reads it
//!   (`windowBlocked`, `ICoreWebView2Profile4::GetNonDefaultPermissionSettings`) and
//!   `dictation.allowWindowMicrophone` allows the page's origin (`SetPermissionState`): the user
//!   asked for exactly that with the button. WKWebView (macOS) grants the page's requests itself
//!   (wry, no permission handler), and WebKitGTK has no speech recognition.

use serde_json::Value;
use tauri::{AppHandle, Runtime};
use tf_proto::{ApiError, AppMethod, DictationMicrophoneAccess, Empty};

use crate::core::CoreState;

/// App methods answered here (`core_call`).
pub const METHODS: &[&str] = &["dictation.microphoneAccess", "dictation.openMicrophoneSettings", "dictation.allowWindowMicrophone"];

/// The system's microphone privacy page.
const SETTINGS: Option<&str> = if cfg!(windows) {
    Some("ms-settings:privacy-microphone")
} else if cfg!(target_os = "macos") {
    Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
} else {
    None
};

pub async fn call<R: Runtime>(app: &AppHandle<R>, core: &CoreState, method: &str, params: Value) -> Result<Value, ApiError> {
    match AppMethod::parse(method, params.clone())? {
        AppMethod::DictationMicrophoneAccessReq(_) => {
            // The system's setting is the engine's to read (tf-dictation, for the capturing process).
            let answer = core.engine.call(None, method, params).await?;
            let mut access: DictationMicrophoneAccess = serde_json::from_value(answer).map_err(internal)?;
            access.settings = SETTINGS.is_some();
            access.window_blocked = window::blocked(app).await;
            serde_json::to_value(access).map_err(internal)
        }
        AppMethod::DictationOpenMicrophoneSettings(_) => {
            let page = SETTINGS.ok_or_else(|| ApiError::new("unsupported", "Linux keeps no microphone permission for apps"))?;
            crate::platform::open_default(page.as_ref()).map_err(|e| ApiError::new("io_error", e))?;
            serde_json::to_value(Empty {}).map_err(internal)
        }
        AppMethod::DictationAllowWindowMicrophone(_) => {
            window::allow(app).await?;
            serde_json::to_value(Empty {}).map_err(internal)
        }
        m => Err(ApiError::new("unknown_method", format!("{} is not a microphone method", m.name()))),
    }
}

fn internal(e: impl std::fmt::Display) -> ApiError {
    ApiError::new("internal", e.to_string())
}

/// WebView2's own microphone permission for the app's page.
#[cfg(windows)]
mod window {
    use std::time::Duration;

    use tauri::{AppHandle, Manager, Runtime, webview::PlatformWebview};
    use tf_proto::ApiError;
    use tokio::sync::oneshot;
    use webview2_com::{
        GetNonDefaultPermissionSettingsCompletedHandler, Microsoft::Web::WebView2::Win32::*, SetPermissionStateCompletedHandler, take_pwstr,
    };
    use windows::core::{HSTRING, Interface, PWSTR};

    /// How long an answer from the webview may take (it comes through the UI thread's queue).
    const WAIT: Duration = Duration::from_secs(5);

    /// The main window and its page's origin (`http://tauri.localhost`; the dev server's in a dev
    /// build). The Quick capture window has the same origin and profile.
    fn target<R: Runtime>(app: &AppHandle<R>) -> Option<(tauri::WebviewWindow<R>, String)> {
        let window = app.get_webview_window("main")?;
        let origin = window.url().ok()?.origin().ascii_serialization();
        Some((window, origin))
    }

    /// Permission management: WebView2 runtime 1.0.1661 and later.
    fn profile(webview: &PlatformWebview) -> windows::core::Result<ICoreWebView2Profile4> {
        // SAFETY: COM calls on the UI thread, where `with_webview` runs.
        unsafe { webview.controller().CoreWebView2()?.cast::<ICoreWebView2_13>()?.Profile()?.cast::<ICoreWebView2Profile4>() }
    }

    /// The same origin as WebView2 writes it (`http://tauri.localhost`, maybe with a slash).
    fn same_origin(a: &str, b: &str) -> bool {
        a.trim_end_matches('/').eq_ignore_ascii_case(b.trim_end_matches('/'))
    }

    /// Whether `settings` hold a Block of the microphone for `origin`.
    fn denies(settings: &ICoreWebView2PermissionSettingCollectionView, origin: &str) -> windows::core::Result<bool> {
        let mut count = 0u32;
        // SAFETY: the collection the completed call hands over, read on the UI thread.
        unsafe { settings.Count(&mut count)? };
        for i in 0..count {
            let (mut kind, mut state, mut at) = (COREWEBVIEW2_PERMISSION_KIND::default(), COREWEBVIEW2_PERMISSION_STATE::default(), PWSTR::null());
            // SAFETY: as above; `at` is the callee's allocation, freed by `take_pwstr`.
            unsafe {
                let setting = settings.GetValueAtIndex(i)?;
                setting.PermissionKind(&mut kind)?;
                setting.PermissionState(&mut state)?;
                setting.PermissionOrigin(&mut at)?;
            }
            let at = take_pwstr(at);
            if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE && state == COREWEBVIEW2_PERMISSION_STATE_DENY && same_origin(&at, origin) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// A Block of the page's microphone is saved in the profile. False when it can't be read (a
    /// runtime without permission management would show its prompt again anyway).
    pub async fn blocked<R: Runtime>(app: &AppHandle<R>) -> bool {
        let Some((window, origin)) = target(app) else { return false };
        let (tx, rx) = oneshot::channel();
        let queued = window.with_webview(move |webview| {
            let read = profile(&webview).and_then(|profile| {
                let done = GetNonDefaultPermissionSettingsCompletedHandler::create(Box::new(move |result, settings| {
                    let blocked = match (result, settings) {
                        (Ok(()), Some(settings)) => denies(&settings, &origin)?,
                        _ => false,
                    };
                    let _ = tx.send(blocked);
                    Ok(())
                }));
                // SAFETY: as in `profile`.
                unsafe { profile.GetNonDefaultPermissionSettings(&done) }
            });
            if let Err(e) = read {
                log::debug!("mic: the window's microphone permission can't be read: {e}");
            }
        });
        queued.is_ok() && matches!(tokio::time::timeout(WAIT, rx).await, Ok(Ok(true)))
    }

    /// Allows the page's origin the microphone in the profile, replacing a saved Block: the next
    /// request is granted without WebView2's prompt (Windows' own setting still applies).
    pub async fn allow<R: Runtime>(app: &AppHandle<R>) -> Result<(), ApiError> {
        let (window, origin) = target(app).ok_or_else(|| ApiError::new("unavailable", "TeleFlock's window isn't open"))?;
        let (tx, rx) = oneshot::channel::<Result<(), String>>();
        let queued = window.with_webview(move |webview| {
            let set = profile(&webview).and_then(|profile| {
                let done = SetPermissionStateCompletedHandler::create(Box::new(move |result| {
                    let _ = tx.send(result.map_err(|e| e.message()));
                    Ok(())
                }));
                // SAFETY: as in `profile`; the origin's HSTRING outlives the call.
                unsafe { profile.SetPermissionState(COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, &HSTRING::from(origin.as_str()), COREWEBVIEW2_PERMISSION_STATE_ALLOW, &done) }
            });
            if let Err(e) = set {
                log::warn!("mic: allowing the window's microphone failed: {e}");
            }
        });
        queued.map_err(|e| ApiError::new("internal", e.to_string()))?;
        match tokio::time::timeout(WAIT, rx).await {
            Ok(Ok(Ok(()))) => Ok(()),
            Ok(Ok(Err(e))) => Err(ApiError::new("internal", format!("WebView2 refused: {e}"))),
            // The call failed before WebView2 took it (a runtime without permission management),
            // or no answer came.
            _ => Err(ApiError::new("unsupported", "This WebView2 can't change its microphone permission: update Microsoft Edge WebView2 Runtime")),
        }
    }
}

/// Only WebView2 keeps a microphone permission of its own for the page.
#[cfg(not(windows))]
mod window {
    use tauri::{AppHandle, Runtime};
    use tf_proto::ApiError;

    pub async fn blocked<R: Runtime>(_app: &AppHandle<R>) -> bool {
        false
    }

    pub async fn allow<R: Runtime>(_app: &AppHandle<R>) -> Result<(), ApiError> {
        Err(ApiError::new("unsupported", "only WebView2 (Windows) keeps a microphone permission of its own"))
    }
}
