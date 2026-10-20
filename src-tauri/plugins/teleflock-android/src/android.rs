use std::sync::OnceLock;

use jni::{
    JNIEnv,
    objects::{JClass, JString},
    sys::{JNI_FALSE, JNI_TRUE, jboolean},
};
use serde::{Deserialize, Serialize};
use tauri::{
    Manager, Runtime,
    plugin::{PermissionState, PluginHandle, mobile::PluginInvokeError},
};

use crate::{NativeEvent, NotificationAction, Notify};

pub struct TeleFlockAndroid<R: Runtime>(pub PluginHandle<R>);

#[derive(Serialize)]
struct KeepAlive<'a> {
    title: &'a str,
    text: &'a str,
}

#[derive(Serialize)]
struct Cancel<'a> {
    id: i32,
    tag: &'a str,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Permission {
    pub post_notification: PermissionState,
}

impl<R: Runtime> TeleFlockAndroid<R> {
    /// Starts (or refreshes the text of) the keep-alive foreground service. Must be called while
    /// the app is visible the first time (Android 12+ background-start restriction).
    pub fn start_keep_alive(&self, title: &str, text: &str) -> Result<(), PluginInvokeError> {
        self.0.run_mobile_plugin("startKeepAlive", KeepAlive { title, text })
    }
    /// Updates the ongoing keep-alive notification if the service runs; no-op otherwise.
    pub fn update_keep_alive(&self, title: &str, text: &str) -> Result<(), PluginInvokeError> {
        self.0.run_mobile_plugin("updateKeepAlive", KeepAlive { title, text })
    }
    pub fn stop_keep_alive(&self) -> Result<(), PluginInvokeError> {
        self.0.run_mobile_plugin("stopKeepAlive", ())
    }
    pub fn notify(&self, n: &Notify) -> Result<(), PluginInvokeError> {
        self.0.run_mobile_plugin("showNotification", n)
    }
    pub fn cancel(&self, id: i32, tag: &str) -> Result<(), PluginInvokeError> {
        self.0.run_mobile_plugin("cancel", Cancel { id, tag })
    }
    pub fn notification_permission(&self) -> Result<Permission, PluginInvokeError> {
        self.0.run_mobile_plugin("notificationPermission", ())
    }
    /// Shows the system prompt (Android 13+) when the state is `prompt*`. Resolves after the
    /// user answered.
    pub async fn request_notification_permission(&self) -> Result<Permission, PluginInvokeError> {
        self.0
            .run_mobile_plugin_async("requestNotificationPermission", ())
            .await
    }
    pub fn are_notifications_enabled(&self) -> bool {
        matches!(
            self.notification_permission(),
            Ok(Permission { post_notification: PermissionState::Granted })
        )
    }
    pub fn device_name(&self) -> Result<String, PluginInvokeError> {
        #[derive(Deserialize)]
        struct Name {
            name: String,
        }
        self.0.run_mobile_plugin::<Name>("deviceName", ()).map(|n| n.name)
    }
    pub fn open_url(&self, url: &str) -> Result<(), PluginInvokeError> {
        self.0.run_mobile_plugin("openUrl", serde_json::json!({ "url": url }))
    }
}

pub trait TeleFlockAndroidExt<R: Runtime> {
    fn teleflock_android(&self) -> &TeleFlockAndroid<R>;
}

impl<R: Runtime, T: Manager<R>> TeleFlockAndroidExt<R> for T {
    fn teleflock_android(&self) -> &TeleFlockAndroid<R> {
        self.state::<TeleFlockAndroid<R>>().inner()
    }
}

type Sink = Box<dyn Fn(NativeEvent) + Send + Sync>;
static SINK: OnceLock<Sink> = OnceLock::new();

/// Installs the receiver for [`NativeEvent`]s. Call once, before the Tauri builder runs. The
/// callback runs on the Android main thread: it must not block.
pub fn set_sink(f: impl Fn(NativeEvent) + Send + Sync + 'static) {
    let _ = SINK.set(Box::new(f));
}

/// `RustBridge.onNotificationAction(json)`: a button or inline reply on one of our notifications.
/// Returns false when the core is not ready (no sink), so Kotlin can tell the user.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_teleflock_android_RustBridge_onNotificationAction(
    mut env: JNIEnv,
    _class: JClass,
    json: JString,
) -> jboolean {
    let Ok(json) = env.get_string(&json) else { return JNI_FALSE };
    let json: String = json.into();
    let Some(sink) = SINK.get() else { return JNI_FALSE };
    match serde_json::from_str::<NotificationAction>(&json) {
        Ok(action) => {
            sink(NativeEvent::Action(action));
            JNI_TRUE
        }
        Err(e) => {
            log::warn!("teleflock-android: bad notification action payload: {e}");
            JNI_FALSE
        }
    }
}

/// `RustBridge.onNetworkChanged()`: the default network became available / changed.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_teleflock_android_RustBridge_onNetworkChanged(
    _env: JNIEnv,
    _class: JClass,
) -> jboolean {
    match SINK.get() {
        Some(sink) => {
            sink(NativeEvent::NetworkChanged);
            JNI_TRUE
        }
        None => JNI_FALSE,
    }
}
