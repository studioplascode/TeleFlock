package dev.teleflock.android

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat

object Notifications {
    /** Needs-you: heads-up, sound. */
    const val CHANNEL_NEEDS = "agents.needs"
    /** Finished / errors / info. */
    const val CHANNEL_EVENTS = "agents.events"
    /** Quiet hours: same content, no sound, no heads-up. */
    const val CHANNEL_QUIET = "agents.quiet"
    /** Ongoing keep-alive notice of the foreground service. */
    const val CHANNEL_KEEPALIVE = "keepalive"

    const val GROUP_AGENTS = "dev.teleflock.agents"
    const val KEY_REPLY = "reply"
    const val ACTION_NOTIFICATION = "dev.teleflock.android.NOTIFICATION_ACTION"
    const val EXTRA_ID = "id"
    const val EXTRA_TAG = "tag"
    const val EXTRA_HOST = "hostId"
    const val EXTRA_NOTIFICATION = "notificationId"
    const val EXTRA_ACTION = "actionId"
    const val EXTRA_OPEN_URL = "openUrl"

    private const val COLOR_ACCENT = 0xFFA35CF0.toInt()
    private const val COLOR_NEEDS = 0xFFFF3D77.toInt()
    private const val COLOR_ERROR = 0xFFFF5A5A.toInt()

    fun ensureChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannels(
            listOf(
                NotificationChannel(CHANNEL_NEEDS, "Needs you", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "An agent is waiting for your answer or approval"
                    enableVibration(true)
                    vibrationPattern = longArrayOf(0, 40, 60, 40)
                },
                NotificationChannel(CHANNEL_EVENTS, "Agent updates", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "Agents finished a turn or hit an error"
                },
                NotificationChannel(CHANNEL_QUIET, "Quiet hours", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Agent notifications during quiet hours (silent)"
                    setShowBadge(true)
                },
                NotificationChannel(CHANNEL_KEEPALIVE, "Connection", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Keeps host connections alive while TeleFlock is in the background"
                    setShowBadge(false)
                },
            )
        )
    }

    fun canPost(ctx: Context): Boolean =
        (Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED) &&
            NotificationManagerCompat.from(ctx).areNotificationsEnabled()

    /** Launcher activity intent (singleTask), optionally carrying a deep link. */
    fun launchIntent(ctx: Context, url: String?): Intent {
        val i = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
            ?: Intent(Intent.ACTION_MAIN).setPackage(ctx.packageName)
        i.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
        if (url != null) {
            // ACTION_VIEW + data: the deep-link plugin routes it (load() on cold start, onNewIntent warm).
            i.action = Intent.ACTION_VIEW
            i.data = Uri.parse(url)
            i.removeCategory(Intent.CATEGORY_LAUNCHER)
        }
        return i
    }

    fun openAppIntent(ctx: Context, requestCode: Int = 0, url: String? = null): PendingIntent =
        PendingIntent.getActivity(
            ctx, requestCode, launchIntent(ctx, url),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

    private fun requestCode(id: Int, tag: String, action: String): Int =
        31 * (31 * id + tag.hashCode()) + action.hashCode()

    fun post(ctx: Context, a: NotifyArgs) {
        if (!canPost(ctx)) return
        ensureChannels(ctx)
        val channel = when {
            a.silent -> CHANNEL_QUIET
            a.category == "needs" -> CHANNEL_NEEDS
            else -> CHANNEL_EVENTS
        }
        val color = when (a.category) {
            "needs" -> COLOR_NEEDS
            "error" -> COLOR_ERROR
            else -> COLOR_ACCENT
        }
        val b = NotificationCompat.Builder(ctx, channel)
            .setSmallIcon(R.drawable.ic_stat_teleflock)
            .setColor(color)
            .setContentTitle(a.title)
            .setContentText(a.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(a.body))
            .setSubText(a.subText)
            .setCategory(if (a.category == "error") NotificationCompat.CATEGORY_ERROR else NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(
                when {
                    a.silent -> NotificationCompat.PRIORITY_LOW
                    a.category == "needs" -> NotificationCompat.PRIORITY_HIGH
                    else -> NotificationCompat.PRIORITY_DEFAULT
                }
            )
            .setGroup(GROUP_AGENTS)
            .setAutoCancel(true)
            .setOnlyAlertOnce(false)
            .setSilent(a.silent || !a.sound)
            .setContentIntent(openAppIntent(ctx, requestCode(a.id, a.tag, "open"), a.openUrl))
        if (a.`when` > 0) b.setWhen(a.`when`).setShowWhen(true)

        val maxButtons = if (a.reply) 2 else 3
        if (a.reply) {
            val pi = actionIntent(ctx, a, null, mutable = true)
            val action = NotificationCompat.Action.Builder(R.drawable.ic_stat_teleflock, a.replyLabel ?: "Reply", pi)
                .addRemoteInput(RemoteInput.Builder(KEY_REPLY).setLabel(a.replyLabel ?: "Reply to the agent").build())
                .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
                .setAllowGeneratedReplies(false)
                .setShowsUserInterface(false)
                .build()
            b.addAction(action)
        }
        for (btn in a.buttons.take(maxButtons)) {
            val pi = actionIntent(ctx, a, btn.id, mutable = false)
            b.addAction(
                NotificationCompat.Action.Builder(R.drawable.ic_stat_teleflock, btn.title, pi)
                    .setShowsUserInterface(false)
                    .setSemanticAction(
                        if (btn.destructive) NotificationCompat.Action.SEMANTIC_ACTION_DELETE
                        else NotificationCompat.Action.SEMANTIC_ACTION_NONE
                    )
                    .build()
            )
        }
        try {
            val nm = NotificationManagerCompat.from(ctx)
            nm.notify(a.tag, a.id, b.build())
            postGroupSummary(ctx)
        } catch (_: SecurityException) {
        }
    }

    private fun actionIntent(ctx: Context, a: NotifyArgs, actionId: String?, mutable: Boolean): PendingIntent {
        // Explicit component: required for mutable PendingIntents on targetSdk 34+.
        val intent = Intent(ctx, ActionReceiver::class.java)
            .setAction(ACTION_NOTIFICATION)
            .putExtra(EXTRA_ID, a.id)
            .putExtra(EXTRA_TAG, a.tag)
            .putExtra(EXTRA_HOST, a.hostId)
            .putExtra(EXTRA_NOTIFICATION, a.notificationId)
            .putExtra(EXTRA_ACTION, actionId)
            .putExtra(EXTRA_OPEN_URL, a.openUrl)
        // RemoteInput needs the system to fill the intent => FLAG_MUTABLE (API 31+).
        val flags = (if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE) or
            PendingIntent.FLAG_UPDATE_CURRENT
        return PendingIntent.getBroadcast(ctx, requestCode(a.id, a.tag, actionId ?: "reply"), intent, flags)
    }

    /** Bundles agent notifications once there are several (Android groups 4+ automatically, we do it from 2). */
    private fun postGroupSummary(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        val active = nm.activeNotifications.count { it.notification.group == GROUP_AGENTS && it.id != SUMMARY_ID }
        if (active < 2) return
        val summary = NotificationCompat.Builder(ctx, CHANNEL_QUIET)
            .setSmallIcon(R.drawable.ic_stat_teleflock)
            .setColor(COLOR_ACCENT)
            .setContentTitle("TeleFlock")
            .setContentText("$active agent updates")
            .setGroup(GROUP_AGENTS)
            .setGroupSummary(true)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setAutoCancel(true)
            .setContentIntent(openAppIntent(ctx))
            .build()
        try {
            NotificationManagerCompat.from(ctx).notify(SUMMARY_ID, summary)
        } catch (_: SecurityException) {
        }
    }

    private const val SUMMARY_ID = 0x7F10C

    /**
     * After a RemoteInput reply the notification MUST be re-posted (or cancelled), otherwise the
     * reply field keeps spinning.
     */
    fun markReplied(ctx: Context, id: Int, tag: String?, reply: String, delivered: Boolean, openUrl: String?) {
        if (!canPost(ctx)) return
        val n = NotificationCompat.Builder(ctx, CHANNEL_QUIET)
            .setSmallIcon(R.drawable.ic_stat_teleflock)
            .setColor(if (delivered) COLOR_ACCENT else COLOR_ERROR)
            .setContentTitle(if (delivered) "Sent" else "Not sent: open TeleFlock")
            .setContentText(reply)
            .setGroup(GROUP_AGENTS)
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .setTimeoutAfter(if (delivered) 4_000 else 0)
            .setContentIntent(openAppIntent(ctx, requestCode(id, tag ?: "", "replied"), openUrl))
            .build()
        try {
            NotificationManagerCompat.from(ctx).notify(tag, id, n)
        } catch (_: SecurityException) {
        }
    }

    /** A button could not reach the core (process was cold-started by the tap). */
    fun markUndelivered(ctx: Context, id: Int, tag: String?, openUrl: String?) {
        if (!canPost(ctx)) return
        val n = NotificationCompat.Builder(ctx, CHANNEL_QUIET)
            .setSmallIcon(R.drawable.ic_stat_teleflock)
            .setColor(COLOR_ERROR)
            .setContentTitle("TeleFlock is not connected")
            .setContentText("Tap to open and answer there")
            .setGroup(GROUP_AGENTS)
            .setAutoCancel(true)
            .setContentIntent(openAppIntent(ctx, requestCode(id, tag ?: "", "undelivered"), openUrl))
            .build()
        try {
            NotificationManagerCompat.from(ctx).notify(tag, id, n)
        } catch (_: SecurityException) {
        }
    }
}
