package dev.teleflock.app

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import dev.teleflock.android.RustBridge

/**
 * The keep-alive service can keep the process (and the Rust core) running after this activity is
 * destroyed, e.g. swiped away from recents. The launcher then creates a new activity in that
 * process, but Tauri creates its windows (and plugins) once per process: without help the new
 * activity stays on its blank window background until the app is force-stopped
 * (tauri-apps/tauri#15671).
 */
class MainActivity : TauriActivity() {
  /** Wry attached a WebView to this activity. */
  private var hasWebView = false

  /** Not the process's first activity: a relaunch, or a recreation for a configuration change. */
  private var laterActivity = false

  // Tauri's back handler (AppPlugin) is registered on the first activity only; later ones use
  // Wry's (the same WebView-history-first behaviour). Read when the WebView attaches.
  override val handleBackNavigation: Boolean
    get() = laterActivity

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    laterActivity = processHadActivity
    // Not a configuration change (that restores its state and keeps its window).
    val relaunched = laterActivity && savedInstanceState == null
    super.onCreate(savedInstanceState)
    RustBridge.activityCreated(id)
    processHadActivity = true
    // Plugins only ever see the first activity's launch intent and later onNewIntent ones: hand
    // them this one (a notification tap carries its deep link here).
    if (relaunched) getPluginManager().onNewIntent(intent)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    hasWebView = true
  }

  override fun onResume() {
    super.onResume()
    // Without a WebView, Rust rebuilds the window (a process that outlived its activity); on a
    // cold start Tauri is about to create it anyway, and the core is not up yet.
    RustBridge.activityResumed(!hasWebView)
  }

  override fun onDestroy() {
    // Before super, which reports the window destroyed: from now on Rust must not reach this
    // activity (plugin calls) or wait for it to come back.
    if (!isChangingConfigurations) RustBridge.activityDestroyed(id)
    super.onDestroy()
  }

  private companion object {
    /** An activity was created before in this process. */
    var processHadActivity = false
  }
}
