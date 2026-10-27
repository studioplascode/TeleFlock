package dev.teleflock.android

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import app.tauri.plugin.Channel
import app.tauri.plugin.JSObject

/**
 * Voice dictation through the system speech recognizer: Android's WebView has no working Web
 * Speech API. One session at a time; it reports to the webview channel it was started with:
 * - `{type: "partial", text}`: the phrase so far (each replaces the previous one);
 * - `{type: "final", text}`: a finished phrase;
 * - `{type: "error", code, message}`: why the session failed, readable;
 * - `{type: "end"}`: always last.
 *
 * Like the Web Speech API's continuous mode, a session keeps listening across pauses: the
 * recognizer ends every phrase by itself and the next one starts, until [stop], [cancel], silence
 * or an error. Silence or a stop after a phrase ends the session without an error.
 *
 * Main thread only, as `SpeechRecognizer` requires: plugin commands, plugin lifecycle callbacks
 * and recognizer callbacks all run there.
 */
internal class Dictation(private val context: Context) {
    private val main = Handler(Looper.getMainLooper())
    private var session: Session? = null

    /** A recognition service is installed (visible through the manifest's `<queries>` on API 30+). */
    fun available(): Boolean = SpeechRecognizer.isRecognitionAvailable(context)

    /** Starts listening for [channel]; a session still running (another composer) ends first. */
    fun start(channel: Channel) {
        session?.end(null)
        session = Session(channel).also { it.next() }
    }

    /**
     * Stops listening; the phrase being spoken still arrives as `final` before `end`.
     * [id]: the session's channel id, 0 = whichever session runs.
     */
    fun stop(id: Long) {
        find(id)?.stop()
    }

    /** Ends the session at once, dropping the phrase being spoken. [id] as for [stop]. */
    fun cancel(id: Long) {
        find(id)?.end(null)
    }

    private fun find(id: Long): Session? = session?.takeIf { id == 0L || it.channel.id == id }

    private inner class Session(val channel: Channel) {
        /** The phrase being captured; null between phrases. */
        private var phrase: Phrase? = null

        /** Asked to stop: the phrase being captured is the last. */
        private var stopping = false

        /** A phrase came through: silence after it is the normal way out. */
        private var heard = false

        /** A recognizer that never answers a stop must not keep the session (and the mic) alive. */
        private val giveUp = Runnable { end(null) }

        fun next() {
            phrase = Phrase()
        }

        fun stop() {
            if (stopping) return
            stopping = true
            val p = phrase ?: return end(null)
            p.recognizer.stopListening()
            main.postDelayed(giveUp, STOP_GRACE_MS)
        }

        /** Releases the recognizer and reports [error] (a `SpeechRecognizer.ERROR_*`), then `end`. */
        fun end(error: Int?) {
            if (session !== this) return
            session = null
            main.removeCallbacks(giveUp)
            phrase?.recognizer?.destroy()
            phrase = null
            if (error != null) channel.send(errorEvent(error))
            channel.send(event("end"))
        }

        /**
         * One utterance, on a fresh recognizer: restarting a finished one at once fails as busy
         * with some recognition services.
         */
        private inner class Phrase : RecognitionListener {
            val recognizer: SpeechRecognizer = SpeechRecognizer.createSpeechRecognizer(context)

            init {
                recognizer.setRecognitionListener(this)
                recognizer.startListening(
                    Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                        .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                        .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                        .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
                )
            }

            /** Callbacks of an ended session or a finished phrase are stale. */
            private val current: Boolean
                get() = session === this@Session && phrase === this

            override fun onPartialResults(partialResults: Bundle?) {
                if (!current) return
                val text = best(partialResults) ?: return
                channel.send(event("partial").put("text", text))
            }

            override fun onResults(results: Bundle?) {
                if (!current) return
                val text = best(results) ?: return onError(SpeechRecognizer.ERROR_NO_MATCH)
                heard = true
                channel.send(event("final").put("text", text))
                if (stopping) return end(null)
                recognizer.destroy()
                phrase = null
                // Posted: the recognition service finishes this phrase before the next one binds.
                main.post { if (session === this@Session && !stopping) next() }
            }

            override fun onError(error: Int) {
                if (!current) return
                end(if ((heard || stopping) && error in AFTER_SPEECH) null else error)
            }

            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        }
    }

    private companion object {
        /** How long a stopped recognizer may take to deliver the last phrase. */
        const val STOP_GRACE_MS = 4000L

        /**
         * How a phrase ends when nobody speaks (any more), or when a stop or the next phrase races
         * the service: not an error once something was heard or the user stopped.
         */
        val AFTER_SPEECH = setOf(
            SpeechRecognizer.ERROR_NO_MATCH,
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT,
            SpeechRecognizer.ERROR_CLIENT,
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY,
        )

        fun event(type: String): JSObject = JSObject().put("type", type)

        fun best(results: Bundle?): String? =
            results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                ?.firstOrNull()?.trim()?.takeIf { it.isNotEmpty() }

        fun errorEvent(error: Int): JSObject {
            val (code, message) = when (error) {
                SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT ->
                    "network" to "Speech recognition needs a working network."
                SpeechRecognizer.ERROR_AUDIO -> "audio-capture" to "Couldn't record audio."
                SpeechRecognizer.ERROR_SERVER, SpeechRecognizer.ERROR_SERVER_DISCONNECTED ->
                    "service" to "The speech service failed. Try again."
                SpeechRecognizer.ERROR_CLIENT -> "client" to "Speech recognition failed. Try again."
                SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "no-speech" to "Didn't hear anything."
                SpeechRecognizer.ERROR_NO_MATCH -> "no-match" to "Didn't catch that. Try again."
                SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "busy" to "The speech recognizer is busy. Try again."
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS ->
                    "not-allowed" to "The speech service has no microphone access."
                SpeechRecognizer.ERROR_TOO_MANY_REQUESTS ->
                    "too-many-requests" to "Too many speech requests. Try again later."
                SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED ->
                    "language-not-supported" to "The speech service doesn't support your language."
                SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE ->
                    "language-unavailable" to "Your language isn't available for speech yet."
                else -> "unknown" to "Speech recognition failed (error $error)."
            }
            return event("error").put("code", code).put("message", message)
        }
    }
}
