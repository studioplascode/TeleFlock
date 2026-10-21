package dev.teleflock.android

/**
 * JNI bridge into the app's Rust cdylib (`libteleflock_lib.so`, already loaded by Tauri's
 * generated `Rust` object while the app runs). Calls work with no Activity or WebView alive.
 */
object RustBridge {
    @JvmStatic private external fun onNotificationAction(json: String): Boolean
    @JvmStatic private external fun onNotificationDismissed(json: String): Boolean
    @JvmStatic private external fun onNetworkChanged(): Boolean

    /** false = the Rust core is not loaded (cold process from a notification) or not ready. */
    fun deliverAction(json: String): Boolean = try {
        onNotificationAction(json)
    } catch (_: UnsatisfiedLinkError) {
        false
    }

    /** Best effort: a cold process has no app state to mark read. */
    fun deliverDismissed(json: String): Boolean = try {
        onNotificationDismissed(json)
    } catch (_: UnsatisfiedLinkError) {
        false
    }

    fun networkChanged(): Boolean = try {
        onNetworkChanged()
    } catch (_: UnsatisfiedLinkError) {
        false
    }
}
