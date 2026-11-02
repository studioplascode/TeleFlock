package dev.teleflock.android

import dev.teleflock.android.PreviewLinks.Route
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PreviewLinksTest {
    @Test
    fun opensOnlyLoopbackPages() {
        for (url in listOf(
            "http://127.0.0.1:5173/",
            "http://127.0.0.1:49152/app?x=1#top",
            "http://localhost:3000/",
            "HTTP://LOCALHOST:3000/",
            "https://127.0.0.1:8443/",
        )) assertTrue(url, PreviewLinks.isLoopbackPage(url))

        for (url in listOf(
            "http://example.com/",
            // another host behind a loopback-looking prefix, user info or a lookalike name
            "http://127.0.0.1.example.com/",
            "http://localhost.example.com:3000/",
            "http://127.0.0.1@example.com/",
            "http://user@127.0.0.1:5173/",
            // read differently by Chromium (backslash as slash): refused outright
            "http://example.com\\@127.0.0.1/",
            // the app's own origin and Tauri's IPC endpoint are no previews
            "http://tauri.localhost/",
            "http://ipc.localhost/core_call",
            "file:///data/data/dev.teleflock.app/",
            "content://dev.teleflock.app.fileprovider/x",
            "javascript:alert(1)",
            "blob:http://127.0.0.1:5173/0b1c",
            "http:///nohost",
            "",
        )) assertFalse(url, PreviewLinks.isLoopbackPage(url))
    }

    @Test
    fun routesNavigations() {
        assertEquals(Route.STAY, PreviewLinks.route("http://127.0.0.1:5173/next"))
        assertEquals(Route.STAY, PreviewLinks.route("http://localhost:5173/"))
        assertEquals(Route.STAY, PreviewLinks.route("about:blank"))
        assertEquals(Route.STAY, PreviewLinks.route("blob:http://127.0.0.1:5173/3f2a"))

        assertEquals(Route.BROWSER, PreviewLinks.route("https://docs.example.com/guide"))
        assertEquals(Route.BROWSER, PreviewLinks.route("http://example.com/"))
        assertEquals(Route.BROWSER, PreviewLinks.route("http://127.0.0.1@example.com/"))

        for (url in listOf(
            "intent://scan/#Intent;scheme=zxing;end",
            "market://details?id=x",
            "javascript:alert(1)",
            "file:///sdcard/x.html",
            "content://media/external/images/1",
            "data:text/html,<p>x",
            "blob:https://example.com/3f2a",
            "tel:123",
            "http://example.com\\@127.0.0.1/",
        )) assertEquals(url, Route.REFUSE, PreviewLinks.route(url))
    }

    @Test
    fun webUrlsAreHttpWithAHost() {
        assertTrue(PreviewLinks.isWebUrl("https://example.com/a.zip"))
        assertTrue(PreviewLinks.isWebUrl("http://127.0.0.1:5173/report.pdf"))
        assertFalse(PreviewLinks.isWebUrl("blob:http://127.0.0.1:5173/3f2a"))
        assertFalse(PreviewLinks.isWebUrl("data:application/zip;base64,UEsDBA=="))
        assertFalse(PreviewLinks.isWebUrl("ftp://example.com/x"))
    }
}
