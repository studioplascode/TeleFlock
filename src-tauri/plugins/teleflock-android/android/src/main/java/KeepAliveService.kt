package dev.teleflock.android

import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the process (and with it the in-process Rust tokio runtime + russh sessions) at
 * foreground-service priority while the Activity is in the background. It does no work itself.
 */
class KeepAliveService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Notifications.ensureChannels(this)
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: "TeleFlock"
        val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Connected"
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else 0
        // Must happen within seconds of startForegroundService(), so do it first.
        ServiceCompat.startForeground(this, NOTIFICATION_ID, build(this, title, text), type)
        running = true
        // Not sticky: if the process dies the Rust core is gone; a restarted empty service is useless.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        running = false
        super.onDestroy()
    }

    /** API 35+: only delivered for time-limited types; remoteMessaging has none, but be safe. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        stopSelf()
    }

    companion object {
        const val NOTIFICATION_ID = 1
        const val EXTRA_TITLE = "title"
        const val EXTRA_TEXT = "text"

        @Volatile var running = false
            private set

        fun build(ctx: Context, title: String, text: String): Notification =
            NotificationCompat.Builder(ctx, Notifications.CHANNEL_KEEPALIVE)
                .setSmallIcon(R.drawable.ic_stat_teleflock)
                .setColor(0xFFA35CF0.toInt())
                .setContentTitle(title)
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .setContentIntent(Notifications.openAppIntent(ctx))
                .build()

        /** Call while the app is visible (Android 12+ forbids FGS starts from the background). */
        fun start(ctx: Context, title: String, text: String) {
            val i = Intent(ctx, KeepAliveService::class.java)
                .putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_TEXT, text)
            ContextCompat.startForegroundService(ctx, i)
        }

        /** Refreshes the ongoing notice ("3 running · 1 needs you") without restarting the service. */
        fun update(ctx: Context, title: String, text: String) {
            if (!running || !Notifications.canPost(ctx)) return
            try {
                NotificationManagerCompat.from(ctx).notify(NOTIFICATION_ID, build(ctx, title, text))
            } catch (_: SecurityException) {
            }
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, KeepAliveService::class.java))
            running = false
        }
    }
}
