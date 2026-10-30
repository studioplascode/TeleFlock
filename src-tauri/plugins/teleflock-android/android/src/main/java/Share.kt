package dev.teleflock.android

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Base64
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import java.util.concurrent.Executors

/**
 * "Share to TeleFlock": `ACTION_SEND` / `ACTION_SEND_MULTIPLE` intents (filters in the app
 * manifest: plain text and any image type) become shares the page takes with `take_shares`
 * (`src/features/capture/androidShare.ts`), which opens Dispatch prefilled. Text, subject and up
 * to [MAX_IMAGES] images ([MAX_TOTAL_BYTES] together) are read at once (the sender's URI grant
 * lasts while the activity does), off the main thread; anything else is counted as skipped.
 * Only `content://` URIs of other apps are read, and their own provider's type decides whether
 * they are images: the sender names the URI, so a `file://` path into this app's private storage
 * (or a URI of its own provider) must never be opened on the sender's say-so.
 */
internal object Share {
    /** Prompt images at most (Dispatch's cap). */
    private const val MAX_IMAGES = 8
    /** The page scales big images down (≤ 2560 px); far larger files aren't worth the memory. */
    private const val MAX_IMAGE_BYTES = 20L * 1024 * 1024
    /** All images of one share together (each goes through the plugin bridge as base64 JSON). */
    private const val MAX_TOTAL_BYTES = 32L * 1024 * 1024
    /** Shares kept until the page takes them (a burst of shares while it starts). */
    private const val MAX_PENDING = 4

    private val reader = Executors.newSingleThreadExecutor()
    private val pending = ArrayDeque<JSObject>()
    private var seq = 0

    fun isShare(intent: Intent?): Boolean {
        val action = intent?.action ?: return false
        // Recents replays the launch intent after the process died: that share was taken already.
        if ((intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return false
        return action == Intent.ACTION_SEND || action == Intent.ACTION_SEND_MULTIPLE
    }

    /** Reads the share in the background, then [onReady] (the plugin tells the page). */
    fun accept(context: Context, intent: Intent, onReady: () -> Unit) {
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT) ?: intent.getStringExtra(Intent.EXTRA_TITLE)
        val uris = streams(intent)
        val resolver = context.applicationContext.contentResolver
        val own = context.packageName
        reader.execute {
            val images = JSArray()
            var usedBytes = 0L
            var skipped = 0
            for (uri in uris) {
                if (images.length() >= MAX_IMAGES) {
                    skipped++
                    continue
                }
                if (!isForeignContentUri(uri, own)) {
                    skipped++
                    continue
                }
                val mime = try { resolver.getType(uri) } catch (_: Exception) { null } ?: ""
                if (!mime.startsWith("image/")) {
                    skipped++
                    continue
                }
                val limit = minOf(MAX_IMAGE_BYTES, MAX_TOTAL_BYTES - usedBytes)
                val bytes = try {
                    resolver.openInputStream(uri)?.use { input ->
                        val out = java.io.ByteArrayOutputStream()
                        val buf = ByteArray(64 * 1024)
                        var total = 0L
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            total += n
                            if (total > limit) return@use null
                            out.write(buf, 0, n)
                        }
                        out.toByteArray()
                    }
                } catch (_: Exception) { // SecurityException (grant gone), IOException
                    null
                }
                if (bytes == null) {
                    skipped++
                    continue
                }
                usedBytes += bytes.size
                val img = JSObject()
                img.put("mime", mime)
                img.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
                displayName(context, uri)?.let { img.put("name", it) }
                images.put(img)
            }
            val share = JSObject()
            share.put("id", "share-${System.currentTimeMillis()}-${seq++}")
            text?.takeIf { it.isNotBlank() }?.let { share.put("text", it) }
            subject?.takeIf { it.isNotBlank() }?.let { share.put("subject", it) }
            share.put("images", images)
            if (skipped > 0) share.put("skipped", skipped)
            synchronized(pending) {
                if (pending.size == MAX_PENDING) pending.removeFirst()
                pending.addLast(share)
            }
            onReady()
        }
    }

    /** Hands over (and forgets) every share read so far. */
    fun take(): JSArray = synchronized(pending) {
        val out = JSArray()
        for (s in pending) out.put(s)
        pending.clear()
        out
    }

    /** A `content://` URI served by another app: `file://` and this app's own providers are refused. */
    internal fun isForeignContentUri(uri: Uri, ownPackage: String): Boolean {
        if (!"content".equals(uri.scheme, ignoreCase = true)) return false
        val authority = uri.authority?.lowercase() ?: return false
        val host = uri.host?.lowercase()
        val own = ownPackage.lowercase()
        fun ours(a: String) = a == own || a.startsWith("$own.")
        return '@' !in authority && !ours(authority) && (host == null || !ours(host))
    }

    @Suppress("DEPRECATION")
    private fun streams(intent: Intent): List<Uri> {
        val out = LinkedHashSet<Uri>()
        if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
            val list = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
            list?.let { out.addAll(it) }
        } else {
            val one = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
            one?.let { out.add(it) }
        }
        // Newer senders put the items (and their grants) in the clip data too.
        intent.clipData?.let { clip -> for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { out.add(it) } }
        return out.toList()
    }

    private fun displayName(context: Context, uri: Uri): String? = try {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    } catch (_: Exception) {
        null
    }
}
