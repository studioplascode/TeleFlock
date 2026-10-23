use std::collections::BTreeSet;
use std::sync::{
    Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};

use jni::{
    JNIEnv,
    objects::{JClass, JString},
    sys::{JNI_FALSE, JNI_TRUE, jboolean, jint},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tauri::{
    Manager, Runtime,
    plugin::{PermissionState, PluginHandle, mobile::PluginInvokeError},
};

use crate::{NativeEvent, NotificationAction, NotificationRef, Notify};

/// Ids (`WryActivity.id`) of this process's live activities, reported by `MainActivity`.
static ACTIVITIES: Mutex<BTreeSet<i32>> = Mutex::new(BTreeSet::new());

/// `MainActivity` is resumed (between `onResume` and `onPause`).
static FOREGROUND: AtomicBool = AtomicBool::new(false);

/// Whether an activity is alive. Kotlin commands (and windows) need one, but the keep-alive
/// service keeps the process and its Rust core running after the last activity is destroyed
/// (swiped away from recents).
pub fn has_activity() -> bool {
    !ACTIVITIES.lock().unwrap_or_else(|p| p.into_inner()).is_empty()
}

/// Whether the app is in front (an activity is resumed). Starting another activity, e.g. the
/// system package installer, only works then (background activity starts are blocked).
pub fn in_foreground() -> bool {
    FOREGROUND.load(Ordering::Acquire) && has_activity()
}

pub struct TeleFlockAndroid<R: Runtime>(pub PluginHandle<R>);

#[derive(Serialize)]
struct KeepAlive<'a> {
    title: &'a str,
    text: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Retract<'a> {
    id: i32,
    tag: &'a str,
    notification_id: &'a str,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Permission {
    pub post_notification: PermissionState,
}

impl<R: Runtime> TeleFlockAndroid<R> {
    /// Runs a Kotlin command. Without an activity, Tauri has no way to reach the plugin (wry's
    /// dispatcher panics), so the call fails as `UnreachableWebview` instead.
    fn run<T: DeserializeOwned>(&self, command: &str, payload: impl Serialize) -> Result<T, PluginInvokeError> {
        if !has_activity() {
            return Err(PluginInvokeError::UnreachableWebview);
        }
        // The last activity can still go between the check and the dispatch (it is reported
        // before wry drops it, but on another thread): the same panic, caught.
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.0.run_mobile_plugin(command, payload)))
            .unwrap_or(Err(PluginInvokeError::UnreachableWebview))
    }

    /// Starts (or refreshes the text of) the keep-alive foreground service. Must be called while
    /// the app is visible the first time (Android 12+ background-start restriction).
    pub fn start_keep_alive(&self, title: &str, text: &str) -> Result<(), PluginInvokeError> {
        self.run("startKeepAlive", KeepAlive { title, text })
    }
    /// Updates the ongoing keep-alive notification if the service runs; no-op otherwise.
    pub fn update_keep_alive(&self, title: &str, text: &str) -> Result<(), PluginInvokeError> {
        self.run("updateKeepAlive", KeepAlive { title, text })
    }
    pub fn stop_keep_alive(&self) -> Result<(), PluginInvokeError> {
        self.run("stopKeepAlive", ())
    }
    pub fn notify(&self, n: &Notify) -> Result<(), PluginInvokeError> {
        self.run("showNotification", n)
    }
    /// Removes the notification `(tag, id)` if it still shows `notification_id` (a newer one of
    /// the same agent stays), and updates or removes the group summary.
    pub fn retract(&self, id: i32, tag: &str, notification_id: &str) -> Result<(), PluginInvokeError> {
        self.run("retract", Retract { id, tag, notification_id })
    }
    pub fn notification_permission(&self) -> Result<Permission, PluginInvokeError> {
        self.run("notificationPermission", ())
    }
    /// Shows the system prompt (Android 13+) when the state is `prompt*`. Resolves after the
    /// user answered.
    pub async fn request_notification_permission(&self) -> Result<Permission, PluginInvokeError> {
        if !has_activity() {
            return Err(PluginInvokeError::UnreachableWebview);
        }
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
        self.run::<Name>("deviceName", ()).map(|n| n.name)
    }
    pub fn open_url(&self, url: &str) -> Result<(), PluginInvokeError> {
        self.run("openUrl", serde_json::json!({ "url": url }))
    }
    /// Hands a downloaded APK (a file under the app cache dir) to the system package installer.
    /// Without the "install unknown apps" permission the installer is not started; with
    /// `open_settings` the permission screen for this package opens instead.
    pub fn install_apk(&self, path: &str, open_settings: bool) -> Result<ApkInstall, PluginInvokeError> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Args<'a> {
            path: &'a str,
            open_settings: bool,
        }
        #[derive(Deserialize)]
        struct Res {
            status: ApkInstall,
        }
        self.run::<Res>("installApk", Args { path, open_settings }).map(|r| r.status)
    }
}

/// Outcome of [`TeleFlockAndroid::install_apk`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApkInstall {
    /// The system install prompt is showing.
    Started,
    /// `canRequestPackageInstalls()` is false: the user has to allow installs from TeleFlock.
    NeedsPermission,
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

/// `RustBridge.onActivityCreated(id)`, after `WryActivity.onCreate` registered the activity.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_teleflock_android_RustBridge_onActivityCreated(_env: JNIEnv, _class: JClass, id: jint) {
    ACTIVITIES.lock().unwrap_or_else(|p| p.into_inner()).insert(id);
}

/// `RustBridge.onActivityDestroyed(id)`, before `WryActivity.onDestroy` (not for configuration
/// changes: the replacement keeps the id, its window and its WebView).
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_teleflock_android_RustBridge_onActivityDestroyed(_env: JNIEnv, _class: JClass, id: jint) {
    let mut activities = ACTIVITIES.lock().unwrap_or_else(|p| p.into_inner());
    activities.remove(&id);
    if activities.is_empty() {
        FOREGROUND.store(false, Ordering::Release);
    }
}

/// `RustBridge.onActivityResumed(needsWindow)` from `MainActivity.onResume`: the app is in front.
/// Tauri's own `RunEvent::Resumed` never fires on Android (the event loop never polls). Returns
/// false before the core is up (cold start: Tauri creates the window itself).
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_teleflock_android_RustBridge_onActivityResumed(
    _env: JNIEnv,
    _class: JClass,
    needs_window: jboolean,
) -> jboolean {
    FOREGROUND.store(true, Ordering::Release);
    match SINK.get() {
        Some(sink) => {
            sink(NativeEvent::ActivityResumed { needs_window: needs_window != JNI_FALSE });
            JNI_TRUE
        }
        None => JNI_FALSE,
    }
}

/// `RustBridge.onActivityPaused()` from `MainActivity.onPause`: the app left the front.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_teleflock_android_RustBridge_onActivityPaused(_env: JNIEnv, _class: JClass) {
    FOREGROUND.store(false, Ordering::Release);
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

/// `RustBridge.onNotificationDismissed(json)`: the user swiped one of our notifications away.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_teleflock_android_RustBridge_onNotificationDismissed(
    mut env: JNIEnv,
    _class: JClass,
    json: JString,
) -> jboolean {
    let Ok(json) = env.get_string(&json) else { return JNI_FALSE };
    let json: String = json.into();
    let Some(sink) = SINK.get() else { return JNI_FALSE };
    match serde_json::from_str::<NotificationRef>(&json) {
        Ok(r) => {
            sink(NativeEvent::Dismissed(r));
            JNI_TRUE
        }
        Err(e) => {
            log::warn!("teleflock-android: bad notification dismissal payload: {e}");
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
