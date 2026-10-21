package dev.teleflock.android

/**
 * JNI bridge into the app's Rust cdylib (`libteleflock_lib.so`, already loaded by Tauri's
 * generated `Rust` object while the app runs). Calls work with no Activity or WebView alive.
 */
object RustBridge {
    @JvmStatic private external fun onNotificationAction(json: String): Boolean
    @JvmStatic private external fun onNotificationDismissed(json: String): Boolean
    @JvmStatic private external fun onNetworkChanged(): Boolean
    @JvmStatic private external fun onActivityCreated(id: Int)
    @JvmStatic private external fun onActivityDestroyed(id: Int)
    @JvmStatic private external fun onActivityResumed(needsWindow: Boolean): Boolean

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

    /**
     * `MainActivity` lifecycle, keyed by `WryActivity.id`. The keep-alive service can keep the
     * process (and the Rust core) running after its activity is destroyed; Rust must not reach
     * for plugins or windows then. Report creation after `super.onCreate` and destruction
     * before `super.onDestroy`, skipping configuration changes (the replacement keeps the id).
     */
    fun activityCreated(id: Int) {
        try {
            onActivityCreated(id)
        } catch (_: UnsatisfiedLinkError) {
        }
    }

    fun activityDestroyed(id: Int) {
        try {
            onActivityDestroyed(id)
        } catch (_: UnsatisfiedLinkError) {
        }
    }

    /**
     * `MainActivity.onResume` (Tauri's own resume event never fires on Android). [needsWindow]:
     * the activity has no WebView. false = the core is not up (cold start: Tauri makes the window).
     */
    fun activityResumed(needsWindow: Boolean): Boolean = try {
        onActivityResumed(needsWindow)
    } catch (_: UnsatisfiedLinkError) {
        false
    }
}
