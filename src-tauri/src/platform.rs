//! `tf_client::Platform` for the Tauri shell (Windows desktop, Android; Linux only for dev).

use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};

use tauri::{AppHandle, Wry};
use tf_client::{BadgeState, NotifyStyle, Platform};
use tf_proto::{ApiError, HostProfile, Notification};

use crate::present;

/// Late-bound OS integrations (created during `setup`, after the engine exists).
#[derive(Default)]
pub struct Shell {
    #[cfg(desktop)]
    pub tray: OnceLock<Arc<crate::tray::Tray<Wry>>>,
    #[cfg(windows)]
    pub toasts: OnceLock<crate::toast::Toasts>,
}

pub struct TauriPlatform {
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub app: AppHandle<Wry>,
    pub shell: Arc<Shell>,
    badge: Mutex<BadgeState>,
    /// What the engine asked for.
    keep_alive_wanted: AtomicBool,
    /// Whether the Android foreground service is actually running.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    keep_alive_running: AtomicBool,
}

fn is_web_url(url: &str) -> bool {
    tauri::Url::parse(url).is_ok_and(|u| matches!(u.scheme(), "http" | "https"))
}

impl TauriPlatform {
    pub fn new(app: AppHandle<Wry>, shell: Arc<Shell>) -> Self {
        Self {
            app,
            shell,
            badge: Mutex::new(BadgeState::default()),
            keep_alive_wanted: AtomicBool::new(false),
            keep_alive_running: AtomicBool::new(false),
        }
    }

    pub fn badge(&self) -> BadgeState {
        *self.badge.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Android: (re)starts the foreground service if wanted but not running (e.g. a start from
    /// the background was refused; retried when the app comes to the foreground).
    #[cfg(target_os = "android")]
    pub fn sync_keep_alive(&self) {
        use tauri_plugin_teleflock_android::TeleFlockAndroidExt;
        let want = self.keep_alive_wanted.load(Ordering::Acquire);
        let running = self.keep_alive_running.load(Ordering::Acquire);
        let plugin = self.app.teleflock_android();
        if want && !running {
            let b = self.badge();
            match plugin.start_keep_alive("TeleFlock is connected", &present::summary(b.running, b.needs)) {
                Ok(()) => self.keep_alive_running.store(true, Ordering::Release),
                Err(e) => log::warn!("keep-alive service not started: {e}"),
            }
            // The keep-alive notice needs the notification permission to be visible (13+).
            let plugin_app = self.app.clone();
            tauri::async_runtime::spawn(async move {
                let p = plugin_app.teleflock_android();
                if let Ok(state) = p.notification_permission()
                    && matches!(
                        state.post_notification,
                        tauri::plugin::PermissionState::Prompt | tauri::plugin::PermissionState::PromptWithRationale
                    )
                    && let Err(e) = p.request_notification_permission().await
                {
                    log::warn!("notification permission request failed: {e}");
                }
            });
        } else if !want && running {
            if let Err(e) = plugin.stop_keep_alive() {
                log::warn!("keep-alive service not stopped: {e}");
            }
            self.keep_alive_running.store(false, Ordering::Release);
        }
    }

    pub fn keep_alive_wanted(&self) -> bool {
        self.keep_alive_wanted.load(Ordering::Acquire)
    }
}

impl Platform for TauriPlatform {
    fn notify(&self, host: Option<&HostProfile>, n: &Notification, style: NotifyStyle) {
        let p = present::present(host, n, style);
        #[cfg(windows)]
        if let Some(t) = self.shell.toasts.get() {
            t.show(&p);
        }
        #[cfg(target_os = "android")]
        {
            use tauri_plugin_teleflock_android::{NotifyButton, NotifyCategory, TeleFlockAndroidExt};
            let reply = p.reply;
            let notify = tauri_plugin_teleflock_android::Notify {
                id: 1,
                tag: p.tag,
                host_id: p.host_id,
                notification_id: p.notification_id,
                category: match p.category {
                    present::Category::Needs => NotifyCategory::Needs,
                    present::Category::Finished => NotifyCategory::Finished,
                    present::Category::Error => NotifyCategory::Error,
                    present::Category::Info => NotifyCategory::Info,
                },
                title: p.title,
                body: p.body,
                sub_text: p.host_name,
                open_url: p.open_url,
                // Android shows 3 actions in total; the reply field takes one slot.
                buttons: p
                    .buttons
                    .into_iter()
                    .take(if reply { 2 } else { 3 })
                    .map(|b| NotifyButton { id: b.id, title: b.label, destructive: b.destructive })
                    .collect(),
                reply,
                reply_label: Some("Reply".to_owned()),
                silent: p.silent,
                sound: p.sound,
                when: p.at,
            };
            if let Err(e) = self.app.teleflock_android().notify(&notify) {
                log::warn!("notification failed: {e}");
            }
        }
        #[cfg(not(any(windows, target_os = "android")))]
        log::info!("notification (no OS notifications on this dev platform): {} — {}", p.title, p.body);
    }

    fn open_external(&self, url: &str) -> Result<(), ApiError> {
        if !is_web_url(url) {
            return Err(ApiError::new("invalid_params", format!("refusing to open non-web URL {url}")));
        }
        #[cfg(windows)]
        {
            use windows::{Win32::UI::Shell::ShellExecuteW, Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL, core::HSTRING, core::w};
            let r = unsafe { ShellExecuteW(None, w!("open"), &HSTRING::from(url), None, None, SW_SHOWNORMAL) };
            // ShellExecute reports success with a value > 32.
            if r.0 as isize <= 32 {
                return Err(ApiError::new("io_error", format!("ShellExecute failed ({})", r.0 as isize)));
            }
            Ok(())
        }
        #[cfg(target_os = "android")]
        {
            use tauri_plugin_teleflock_android::TeleFlockAndroidExt;
            self.app
                .teleflock_android()
                .open_url(url)
                .map_err(|e| ApiError::new("io_error", e.to_string()))
        }
        #[cfg(not(any(windows, target_os = "android")))]
        {
            std::process::Command::new("xdg-open")
                .arg(url)
                .spawn()
                .map(drop)
                .map_err(|e| ApiError::new("io_error", format!("xdg-open: {e}")))
        }
    }

    fn set_keep_alive(&self, on: bool) {
        self.keep_alive_wanted.store(on, Ordering::Release);
        // Desktop: the process lives in the tray anyway; only Android needs a foreground service.
        #[cfg(target_os = "android")]
        self.sync_keep_alive();
    }

    fn set_badge(&self, badge: BadgeState) {
        *self.badge.lock().unwrap_or_else(|e| e.into_inner()) = badge;
        #[cfg(desktop)]
        if let Some(tray) = self.shell.tray.get() {
            tray.update(badge);
        }
        #[cfg(target_os = "android")]
        if self.keep_alive_running.load(Ordering::Acquire) {
            use tauri_plugin_teleflock_android::TeleFlockAndroidExt;
            let _ = self
                .app
                .teleflock_android()
                .update_keep_alive("TeleFlock is connected", &present::summary(badge.running, badge.needs));
        }
    }

    fn device_name(&self) -> String {
        #[cfg(target_os = "android")]
        {
            use tauri_plugin_teleflock_android::TeleFlockAndroidExt;
            if let Ok(name) = self.app.teleflock_android().device_name() {
                return name;
            }
            "Android".to_owned()
        }
        #[cfg(not(target_os = "android"))]
        {
            let env = if cfg!(windows) { "COMPUTERNAME" } else { "HOSTNAME" };
            std::env::var(env)
                .ok()
                .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "Desktop".to_owned())
        }
    }

    fn supports_notifications(&self) -> bool {
        cfg!(any(windows, target_os = "android"))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_web_urls_open() {
        assert!(super::is_web_url("https://login.tailscale.com/a/xyz"));
        assert!(super::is_web_url("http://127.0.0.1:5173/"));
        assert!(!super::is_web_url("file:///C:/Windows/System32/calc.exe"));
        assert!(!super::is_web_url("C:\\evil.exe"));
        assert!(!super::is_web_url("teleflock://agent/a/b"));
    }
}
