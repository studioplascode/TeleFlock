//! TeleFlock Android glue (Kotlin package `dev.teleflock.android`).
//!
//! * `KeepAliveService`: a `remoteMessaging` foreground service that keeps the process (and the
//!   in-process Rust core with its SSH sessions) at foreground priority while `keepAlive` is on.
//! * Agent notifications with up to 3 action buttons and an optional inline reply. Taps on
//!   buttons / replies and swipe-dismissals reach Rust over JNI ([`set_sink`]) even when no
//!   WebView is alive; taps on the body open the app through a `teleflock://` deep link.
//!   Notifications handled elsewhere are retracted by tag + id (the group summary follows).
//! * `POST_NOTIFICATIONS` permission flow, haptics, battery-optimisation status.
//! * Self-update install: a verified APK from the cache dir goes to the system installer through
//!   the app's FileProvider (`REQUEST_INSTALL_PACKAGES`, "install unknown apps" grant flow).
//! * Default-network changes (Wi-Fi ↔ cellular, VPN up) are reported through the same sink so
//!   the core can reconnect immediately.
//!
//! On non-Android targets the plugin registers nothing; the types still compile so the app can
//! share code paths.

use serde::{Deserialize, Serialize};
use tauri::{
    Runtime,
    plugin::{Builder, TauriPlugin},
};

#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "android")]
pub use android::{ApkInstall, Permission, TeleFlockAndroid, TeleFlockAndroidExt, set_sink};

/// A user action on one of our notifications, delivered from the Kotlin `ActionReceiver`.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationAction {
    pub host_id: String,
    /// `Notification.id` from tf-proto.
    pub notification_id: String,
    /// `NotifyAction.id`, or `None` for a submitted inline reply.
    pub action_id: Option<String>,
    pub reply: Option<String>,
}

/// One of our notifications, by its tf-proto identity.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRef {
    pub host_id: String,
    pub notification_id: String,
}

/// Events Kotlin pushes into Rust without going through the WebView.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeEvent {
    Action(NotificationAction),
    /// The user swiped a notification away.
    Dismissed(NotificationRef),
    /// The default network changed (became available or its capabilities changed).
    NetworkChanged,
}

/// One action button.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyButton {
    pub id: String,
    pub title: String,
    /// Destructive styling hint (deny / reject); Android shows it like any other action.
    pub destructive: bool,
}

/// Visual category; picks the accent colour and channel.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NotifyCategory {
    Needs,
    Finished,
    Error,
    Info,
}

/// A notification to post. `(tag, id)` is the Android identity: re-posting with the same pair
/// replaces the previous notification (one live notification per agent).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notify {
    pub id: i32,
    pub tag: String,
    pub host_id: String,
    pub notification_id: String,
    pub category: NotifyCategory,
    pub title: String,
    pub body: String,
    /// Sub-text (host name).
    pub sub_text: Option<String>,
    /// Deep link opened when the body is tapped.
    pub open_url: String,
    /// At most 3 buttons; when `reply` is set at most 2 (Android shows 3 actions total).
    pub buttons: Vec<NotifyButton>,
    pub reply: bool,
    pub reply_label: Option<String>,
    /// Post without sound / heads-up (quiet hours).
    pub silent: bool,
    pub sound: bool,
    pub when: i64,
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("teleflock-android")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle =
                    _api.register_android_plugin("dev.teleflock.android", "TeleFlockPlugin")?;
                _app.manage(TeleFlockAndroid(handle));
            }
            Ok(())
        })
        .build()
}
