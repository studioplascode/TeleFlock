package dev.teleflock.android

import java.net.URI

/**
 * Which addresses a preview window ([PreviewActivity]) shows and where its navigations go. A
 * preview is a dev server on an agent host, reached through a tunnel that listens on this device's
 * loopback (`http://127.0.0.1:<port>/`): pages there stay in the window, other web pages open in
 * the browser, anything else (`intent:`, `file:`, `content:`, `javascript:` …) goes nowhere.
 * Loopback means the two names the app's network security config lets through in clear text, the
 * same the app page's frames were limited to before previews left it.
 */
internal object PreviewLinks {
    enum class Route {
        /** Load in the preview window. */
        STAY,
        /** Hand to the browser (on a tap; refused otherwise). */
        BROWSER,
        /** Go nowhere. */
        REFUSE,
    }

    private val LOOPBACK_HOSTS = setOf("127.0.0.1", "localhost")

    /** An http(s) page on this device's loopback: what `open_preview` shows. */
    fun isLoopbackPage(url: String): Boolean {
        val u = parse(url) ?: return false
        return isWeb(u) && u.rawUserInfo == null && u.host?.lowercase() in LOOPBACK_HOSTS
    }

    /** An http(s) address the browser can open. */
    fun isWebUrl(url: String): Boolean = parse(url)?.let(::isWeb) ?: false

    fun route(url: String): Route = when {
        isLoopbackPage(url) || url == "about:blank" -> Route.STAY
        // A document the page made itself (`URL.createObjectURL`), from its own loopback origin.
        url.startsWith("blob:") && isLoopbackPage(url.removePrefix("blob:")) -> Route.STAY
        isWebUrl(url) -> Route.BROWSER
        else -> Route.REFUSE
    }

    private fun isWeb(u: URI): Boolean = u.scheme?.lowercase().let { it == "http" || it == "https" } && !u.host.isNullOrEmpty()

    /** Strict RFC 3986 parsing: an address Chromium would read differently (`\`, spaces) is refused. */
    private fun parse(url: String): URI? = try {
        URI(url)
    } catch (_: Exception) {
        null
    }
}
