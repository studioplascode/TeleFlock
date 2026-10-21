package dev.teleflock.android

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.view.HapticFeedbackConstants
import android.webkit.WebView
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.FileProvider
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.security.MessageDigest

@InvokeArg
class KeepAliveArgs {
    var title: String = "TeleFlock"
    var text: String = "Connected"
}

@InvokeArg
class ButtonArg {
    lateinit var id: String
    lateinit var title: String
    var destructive: Boolean = false
}

@InvokeArg
class NotifyArgs {
    var id: Int = 0
    lateinit var tag: String
    lateinit var hostId: String
    lateinit var notificationId: String
    /** needs | finished | error | info */
    var category: String = "info"
    lateinit var title: String
    var body: String = ""
    var subText: String? = null
    var openUrl: String? = null
    var buttons: Array<ButtonArg> = arrayOf()
    var reply: Boolean = false
    var replyLabel: String? = null
    var silent: Boolean = false
    var sound: Boolean = true
    var `when`: Long = 0
}

@InvokeArg
class RetractArgs {
    var id: Int = 0
    lateinit var tag: String
    lateinit var notificationId: String
}

@InvokeArg
class HapticArgs {
    var kind: String = "tick"
}

@InvokeArg
class UrlArgs {
    lateinit var url: String
}

@InvokeArg
class InstallApkArgs {
    lateinit var path: String
    var openSettings: Boolean = true
}

@TauriPlugin(
    permissions = [
        Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "postNotification")
    ]
)
class TeleFlockPlugin(private val activity: Activity) : Plugin(activity) {
    override fun load(webView: WebView) {
        Notifications.ensureChannels(activity)
        watchNetwork(activity.applicationContext)
    }

    // ── keep-alive ────────────────────────────────────────────────────────────────────────────

    @Command
    fun startKeepAlive(invoke: Invoke) {
        val a = invoke.parseArgs(KeepAliveArgs::class.java)
        try {
            KeepAliveService.start(activity, a.title, a.text)
            invoke.resolve()
        } catch (e: Exception) { // ForegroundServiceStartNotAllowedException (31+), SecurityException (34+)
            invoke.reject(e.message ?: "failed to start the foreground service", "FGS_START", e)
        }
    }

    @Command
    fun updateKeepAlive(invoke: Invoke) {
        val a = invoke.parseArgs(KeepAliveArgs::class.java)
        KeepAliveService.update(activity, a.title, a.text)
        invoke.resolve()
    }

    @Command
    fun stopKeepAlive(invoke: Invoke) {
        KeepAliveService.stop(activity)
        invoke.resolve()
    }

    // ── notifications ─────────────────────────────────────────────────────────────────────────

    @Command
    fun showNotification(invoke: Invoke) {
        Notifications.post(activity, invoke.parseArgs(NotifyArgs::class.java))
        invoke.resolve()
    }

    @Command
    fun retract(invoke: Invoke) {
        val a = invoke.parseArgs(RetractArgs::class.java)
        Notifications.retract(activity, a.tag, a.id, a.notificationId)
        invoke.resolve()
    }

    private fun notificationState(): String {
        if (Build.VERSION.SDK_INT < 33) {
            return if (NotificationManagerCompat.from(activity).areNotificationsEnabled()) "granted" else "denied"
        }
        val state = getPermissionState("postNotification") ?: PermissionState.PROMPT
        if (state == PermissionState.GRANTED && !NotificationManagerCompat.from(activity).areNotificationsEnabled()) {
            return "denied" // granted at runtime but switched off in system settings
        }
        return state.toString()
    }

    private fun resolveNotificationState(invoke: Invoke) {
        val r = JSObject()
        r.put("postNotification", notificationState())
        invoke.resolve(r)
    }

    @Command
    fun notificationPermission(invoke: Invoke) = resolveNotificationState(invoke)

    @Command
    fun requestNotificationPermission(invoke: Invoke) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("postNotification") != PermissionState.GRANTED) {
            requestPermissionForAlias("postNotification", invoke, "notificationPermissionResult")
            return
        }
        if (!NotificationManagerCompat.from(activity).areNotificationsEnabled()) {
            // Denied permanently or disabled in settings: the only way back is the settings screen.
            openNotificationSettings()
        }
        resolveNotificationState(invoke)
    }

    @PermissionCallback
    fun notificationPermissionResult(invoke: Invoke) = resolveNotificationState(invoke)

    private fun openNotificationSettings() {
        val i = if (Build.VERSION.SDK_INT >= 26) {
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
        } else {
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).setData(Uri.parse("package:" + activity.packageName))
        }
        try {
            activity.startActivity(i)
        } catch (_: ActivityNotFoundException) {
        }
    }

    // ── battery ───────────────────────────────────────────────────────────────────────────────

    @Command
    fun batteryStatus(invoke: Invoke) {
        val pm = activity.getSystemService(PowerManager::class.java)
        val r = JSObject()
        r.put("ignoringOptimizations", pm?.isIgnoringBatteryOptimizations(activity.packageName) ?: false)
        invoke.resolve(r)
    }

    @SuppressLint("BatteryLife")
    @Command
    fun requestIgnoreBatteryOptimizations(invoke: Invoke) {
        val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            .setData(Uri.parse("package:" + activity.packageName))
        try {
            activity.startActivity(direct)
        } catch (_: ActivityNotFoundException) {
            try {
                activity.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } catch (_: ActivityNotFoundException) {
            }
        }
        invoke.resolve()
    }

    // ── haptics ───────────────────────────────────────────────────────────────────────────────

    @Command
    fun haptic(invoke: Invoke) {
        val kind = invoke.parseArgs(HapticArgs::class.java).kind
        val constant = when (kind) {
            "tick" -> HapticFeedbackConstants.CLOCK_TICK
            "select", "selection" ->
                if (Build.VERSION.SDK_INT >= 27) HapticFeedbackConstants.TEXT_HANDLE_MOVE
                else HapticFeedbackConstants.CLOCK_TICK
            "light" -> HapticFeedbackConstants.KEYBOARD_TAP
            "medium" -> HapticFeedbackConstants.VIRTUAL_KEY
            "heavy" -> HapticFeedbackConstants.LONG_PRESS
            "success" ->
                if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM
                else HapticFeedbackConstants.VIRTUAL_KEY
            "warning", "error" ->
                if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT
                else HapticFeedbackConstants.LONG_PRESS
            else -> {
                invoke.reject("unknown haptic kind: $kind", "BAD_KIND")
                return
            }
        }
        activity.runOnUiThread {
            activity.window?.decorView?.performHapticFeedback(constant)
        }
        invoke.resolve()
    }

    // ── misc ──────────────────────────────────────────────────────────────────────────────────

    @Command
    fun deviceName(invoke: Invoke) {
        val name = (if (Build.VERSION.SDK_INT >= 25) Settings.Global.getString(activity.contentResolver, Settings.Global.DEVICE_NAME) else null)
            ?.takeIf { it.isNotBlank() }
            ?: listOf(Build.MANUFACTURER.replaceFirstChar { it.uppercase() }, Build.MODEL)
                .filter { it.isNotBlank() }.distinct().joinToString(" ")
        val r = JSObject()
        r.put("name", name)
        invoke.resolve(r)
    }

    @Command
    fun openUrl(invoke: Invoke) {
        val url = invoke.parseArgs(UrlArgs::class.java).url
        try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            invoke.resolve()
        } catch (e: ActivityNotFoundException) {
            invoke.reject("no app can open $url", "NO_HANDLER", e)
        }
    }

    // ── self-update ───────────────────────────────────────────────────────────────────────────

    /**
     * Opens the system installer for a verified APK in the cache dir (FileProvider authority
     * `<applicationId>.fileprovider`, declared by the app manifest with `res/xml/file_paths.xml`).
     * The archive must be this package, signed with exactly the installed app's certificates and
     * have a higher versionCode; otherwise it is deleted and the call rejects (`APK_REJECTED`).
     * Android 8+ needs the per-app "install unknown apps" grant first: without it, resolves
     * `needsPermission` (opening that settings screen when `openSettings`); Rust retries on resume.
     */
    @Command
    fun installApk(invoke: Invoke) {
        val a = invoke.parseArgs(InstallApkArgs::class.java)
        val file = File(a.path)
        if (!file.isFile) {
            invoke.reject("update file missing: ${a.path}", "NOT_FOUND")
            return
        }
        val rejected = try {
            apkRejectReason(file)
        } catch (e: Exception) {
            "the update can't be inspected: ${e.message}"
        }
        if (rejected != null) {
            file.delete()
            invoke.reject(rejected, "APK_REJECTED")
            return
        }
        val r = JSObject()
        if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
            if (a.openSettings) {
                try {
                    activity.startActivity(
                        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName))
                    )
                } catch (_: ActivityNotFoundException) {
                }
            }
            r.put("status", "needsPermission")
            invoke.resolve(r)
            return
        }
        try {
            val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", file)
            val i = Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.startActivity(i)
            r.put("status", "started")
            invoke.resolve(r)
        } catch (e: Exception) { // IllegalArgumentException (path outside the provider), ActivityNotFoundException
            invoke.reject(e.message ?: "couldn't open the package installer", "INSTALL_FAILED", e)
        }
    }

    /** Why `apk` must not replace this app, or null when it may. */
    @Suppress("DEPRECATION")
    private fun apkRejectReason(apk: File): String? {
        val pm = activity.packageManager
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val archive = pm.getPackageArchiveInfo(apk.path, flags) ?: return "the update is not a valid APK"
        if (archive.packageName != activity.packageName) {
            return "the update is for ${archive.packageName}, not ${activity.packageName}"
        }
        val installed = pm.getPackageInfo(activity.packageName, flags)
        val signers = signerDigests(archive)
        if (signers.isEmpty() || signers != signerDigests(installed)) {
            return "the update is not signed with TeleFlock's key"
        }
        val (next, current) = versionCode(archive) to versionCode(installed)
        if (next <= current) return "the update (versionCode $next) is not newer than this app ($current)"
        return null
    }

    /** SHA-256 (hex) of the package's signing certificates. */
    @Suppress("DEPRECATION")
    private fun signerDigests(p: PackageInfo): Set<String> {
        val certs: Array<out Signature?>? = if (Build.VERSION.SDK_INT >= 28) {
            val s = p.signingInfo ?: return emptySet()
            if (s.hasMultipleSigners()) s.apkContentsSigners else s.signingCertificateHistory
        } else {
            p.signatures
        }
        return certs.orEmpty().filterNotNull().map { sig ->
            MessageDigest.getInstance("SHA-256").digest(sig.toByteArray()).joinToString("") { "%02x".format(it) }
        }.toSet()
    }

    @Suppress("DEPRECATION")
    private fun versionCode(p: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= 28) p.longVersionCode else p.versionCode.toLong()

    companion object {
        @Volatile private var networkWatched = false

        /** Process-wide default-network watcher → Rust core reconnects immediately. */
        private fun watchNetwork(ctx: Context) {
            if (networkWatched || Build.VERSION.SDK_INT < 24) return
            val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return
            networkWatched = true
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                private var last: Network? = null
                override fun onAvailable(network: Network) {
                    if (network != last) {
                        last = network
                        RustBridge.networkChanged()
                    }
                }
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                    // VPN (Tailscale) coming up changes capabilities of the default network.
                    if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) && network != last) {
                        last = network
                        RustBridge.networkChanged()
                    }
                }
                override fun onLost(network: Network) {
                    if (network == last) last = null
                }
            })
        }
    }
}
