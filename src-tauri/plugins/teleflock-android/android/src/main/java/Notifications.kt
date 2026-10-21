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
import android.os.Bundle
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
    const val ACTION_DISMISSED = "dev.teleflock.android.NOTIFICATION_DISMISSED"
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
            .setDeleteIntent(dismissIntent(ctx, a))
            .addExtras(identity(a.notificationId))
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
            syncGroupSummary(ctx)
        } catch (_: SecurityException) {
        }
    }

    /** Which tf-proto notification a posted notification shows (checked by [retract]). */
    private fun identity(notificationId: String) = Bundle().apply { putString(EXTRA_NOTIFICATION, notificationId) }

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

    /** Swipe-away / "clear all": the app marks the notification read. */
    private fun dismissIntent(ctx: Context, a: NotifyArgs): PendingIntent {
        val intent = Intent(ctx, ActionReceiver::class.java)
            .setAction(ACTION_DISMISSED)
            .putExtra(EXTRA_ID, a.id)
            .putExtra(EXTRA_TAG, a.tag)
            .putExtra(EXTRA_HOST, a.hostId)
            .putExtra(EXTRA_NOTIFICATION, a.notificationId)
        return PendingIntent.getBroadcast(
            ctx, requestCode(a.id, a.tag, "dismiss"), intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
    }

    /**
     * Handled elsewhere (answered in the app, on another device, in omp; read in the app):
     * removes `(tag, id)` if it still shows [notificationId]. A newer notification of the same
     * agent, or the "Sent" confirmation of an inline reply, stays.
     */
    fun retract(ctx: Context, tag: String, id: Int, notificationId: String) {
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        val shown = nm.activeNotifications.any {
            it.tag == tag && it.id == id && it.notification.extras.getString(EXTRA_NOTIFICATION) == notificationId
        }
        if (!shown) return
        nm.cancel(tag, id)
        syncGroupSummary(ctx, gone = tag to id)
    }

    /**
     * Bundles agent notifications once there are several (Android groups 4+ automatically, we do
     * it from 2), keeps the count current and removes the summary with the last child. [gone]:
     * a child just cancelled that may still be listed as active.
     */
    fun syncGroupSummary(ctx: Context, gone: Pair<String?, Int>? = null) {
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        val listed = nm.activeNotifications.filter { it.notification.group == GROUP_AGENTS }
        val hasSummary = listed.any { it.id == SUMMARY_ID && it.tag == null }
        val active = listed.count { it.id != SUMMARY_ID && (gone == null || it.tag != gone.first || it.id != gone.second) }
        if (active == 0) {
            // Only with no children left: cancelling a summary cancels its children too.
            if (hasSummary) nm.cancel(SUMMARY_ID)
            return
        }
        if (active < 2 && !hasSummary) return
        val summary = NotificationCompat.Builder(ctx, CHANNEL_QUIET)
            .setSmallIcon(R.drawable.ic_stat_teleflock)
            .setColor(COLOR_ACCENT)
            .setContentTitle("TeleFlock")
            .setContentText(if (active == 1) "1 agent update" else "$active agent updates")
            .setGroup(GROUP_AGENTS)
            .setGroupSummary(true)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setOnlyAlertOnce(true)
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
