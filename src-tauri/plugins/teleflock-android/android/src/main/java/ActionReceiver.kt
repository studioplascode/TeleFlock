package dev.teleflock.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import org.json.JSONObject

/**
 * Receives notification buttons and inline replies (explicit broadcast, works with the Activity
 * destroyed) and forwards them to the Rust core over JNI, which answers / prompts the agent.
 */
class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Notifications.ACTION_NOTIFICATION) return
        val id = intent.getIntExtra(Notifications.EXTRA_ID, 0)
        val tag = intent.getStringExtra(Notifications.EXTRA_TAG)
        val hostId = intent.getStringExtra(Notifications.EXTRA_HOST) ?: return
        val notificationId = intent.getStringExtra(Notifications.EXTRA_NOTIFICATION) ?: return
        val actionId = intent.getStringExtra(Notifications.EXTRA_ACTION)
        val openUrl = intent.getStringExtra(Notifications.EXTRA_OPEN_URL)
        val reply = RemoteInput.getResultsFromIntent(intent)
            ?.getCharSequence(Notifications.KEY_REPLY)?.toString()?.trim()?.takeIf { it.isNotEmpty() }
        if (actionId == null && reply == null) {
            // Empty reply submitted: re-post nothing, just stop the spinner.
            NotificationManagerCompat.from(ctx).cancel(tag, id)
            return
        }

        val json = JSONObject()
            .put("hostId", hostId)
            .put("notificationId", notificationId)
            .put("actionId", actionId ?: JSONObject.NULL)
            .put("reply", reply ?: JSONObject.NULL)
            .toString()
        val delivered = RustBridge.deliverAction(json)

        when {
            reply != null -> Notifications.markReplied(ctx, id, tag, reply, delivered, openUrl)
            delivered -> NotificationManagerCompat.from(ctx).cancel(tag, id)
            else -> Notifications.markUndelivered(ctx, id, tag, openUrl)
        }
    }
}
