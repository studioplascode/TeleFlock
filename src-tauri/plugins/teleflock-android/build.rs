// Commands the webview may invoke directly (`plugin:teleflock-android|<name>`). Everything else
// (keep-alive, notifications) is driven from Rust via `run_mobile_plugin`, which bypasses the ACL.
const COMMANDS: &[&str] = &[
    "haptic",
    "notification_permission",
    "request_notification_permission",
    "battery_status",
    "request_ignore_battery_optimizations",
    "request_microphone_permission",
    "open_app_settings",
    "dictation_available",
    "start_dictation",
    "stop_dictation",
    "cancel_dictation",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
