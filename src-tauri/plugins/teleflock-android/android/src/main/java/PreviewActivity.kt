package dev.teleflock.android

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/**
 * A preview tunnel's page (`open_preview`) in a window of its own, with Reload, Open in browser and
 * Close. Its WebView is a plain one: no JavaScript interface, no document-start scripts, no request
 * interception, so nothing it loads can reach the app's commands. A frame of the app's own WebView
 * could: on Android wry injects Tauri's IPC script (with the invoke key) and the `ipc` bridge object
 * into every frame, and Tauri takes the top page's URL as the caller's origin, so a page framed
 * there would act as the app (docs/architecture.md §8, "Framed content").
 *
 * Navigations follow [PreviewLinks]: loopback pages stay, other web pages open in the browser when
 * tapped. Downloads go to the browser too. Permission requests (camera, microphone, location) are
 * denied, files can be picked for an upload field.
 */
class PreviewActivity : ComponentActivity() {
    private lateinit var web: WebView
    private lateinit var progress: ProgressBar
    /** The address the preview opened (Open in browser falls back to it). */
    private lateinit var start: String

    /** Back steps through the page's history first; with none left, back closes the window. */
    private val back = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() = web.goBack()
    }

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        fileCallback = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = intent.getStringExtra(EXTRA_URL)
        if (url == null || !PreviewLinks.isLoopbackPage(url)) {
            finish()
            return
        }
        start = url
        WindowCompat.setDecorFitsSystemWindows(window, false)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BG)
        }
        root.addView(bar(intent.getStringExtra(EXTRA_TITLE) ?: "Preview", intent.getStringExtra(EXTRA_SUBTITLE)))
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progressTintList = ColorStateList.valueOf(ACCENT)
            progressBackgroundTintList = ColorStateList.valueOf(BG)
        }
        root.addView(progress, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(2)))
        web = WebView(this).also(::configure)
        root.addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        // Edge to edge (enforced from Android 15): the bars and the keyboard pad the window.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val i = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
            )
            v.setPadding(i.left, i.top, i.right, i.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)
        onBackPressedDispatcher.addCallback(this, back)
        web.loadUrl(url)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configure(w: WebView) {
        w.settings.apply {
            javaScriptEnabled = true // a dev server's page is an app
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false) // window.open and target=_blank navigate this window, through the policy below
            setGeolocationEnabled(false)
        }
        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                return when (PreviewLinks.route(url)) {
                    PreviewLinks.Route.STAY -> false
                    PreviewLinks.Route.BROWSER -> {
                        // Only a tap leaves the app: a page redirecting by itself stays put.
                        if (request.isForMainFrame && request.hasGesture()) openInBrowser(url)
                        true
                    }
                    PreviewLinks.Route.REFUSE -> true
                }
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                back.isEnabled = view.canGoBack()
            }

            /** The renderer died: close the preview instead of letting the app go down with it. */
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                (view.parent as? ViewGroup)?.removeView(view)
                view.destroy()
                finish()
                return true
            }
        }
        w.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progress.progress = newProgress
                progress.visibility = if (newProgress < 100) View.VISIBLE else View.INVISIBLE
            }

            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    pickFiles.launch(params.createIntent())
                    true
                } catch (_: ActivityNotFoundException) {
                    fileCallback = null
                    false
                }
            }
        }
        w.setDownloadListener { url, _, _, _, _ -> if (PreviewLinks.isWebUrl(url)) openInBrowser(url) }
    }

    /** Title, subtitle and the window's buttons. */
    private fun bar(title: String, subtitle: String?): View {
        val texts = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(4), 0, dp(4), 0)
            addView(TextView(this@PreviewActivity).apply {
                text = title
                setTextColor(FG)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
                typeface = Typeface.DEFAULT_BOLD
                setSingleLine(true)
                ellipsize = TextUtils.TruncateAt.END
            })
            if (!subtitle.isNullOrBlank()) addView(TextView(this@PreviewActivity).apply {
                text = subtitle
                setTextColor(MUTE)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                typeface = Typeface.MONOSPACE
                setSingleLine(true)
                ellipsize = TextUtils.TruncateAt.MIDDLE
            })
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(56)
            setPadding(dp(4), 0, dp(4), 0)
            addView(button(R.drawable.tf_preview_close, "Close preview") { finish() })
            addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(button(R.drawable.tf_preview_reload, "Reload") { web.reload() })
            addView(button(R.drawable.tf_preview_open, "Open in browser") { openInBrowser(web.url?.takeIf(PreviewLinks::isWebUrl) ?: start) })
        }
    }

    private fun button(icon: Int, label: String, onClick: () -> Unit) = ImageButton(this).apply {
        setImageResource(icon)
        contentDescription = label
        ViewCompat.setTooltipText(this, label)
        val ripple = TypedValue()
        theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, ripple, true)
        setBackgroundResource(ripple.resourceId)
        layoutParams = LinearLayout.LayoutParams(dp(48), dp(48))
        setOnClickListener { onClick() }
    }

    private fun openInBrowser(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, "No app can open $url", Toast.LENGTH_SHORT).show()
        }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    override fun onPause() {
        super.onPause()
        if (::web.isInitialized) web.onPause()
    }

    override fun onResume() {
        super.onResume()
        if (::web.isInitialized) web.onResume()
    }

    override fun onDestroy() {
        fileCallback?.onReceiveValue(null)
        fileCallback = null
        if (::web.isInitialized) web.destroy()
        super.onDestroy()
    }

    companion object {
        private const val EXTRA_URL = "dev.teleflock.android.preview.URL"
        private const val EXTRA_TITLE = "dev.teleflock.android.preview.TITLE"
        private const val EXTRA_SUBTITLE = "dev.teleflock.android.preview.SUBTITLE"

        // TeleFlock's dark surface (src/design/styles/tokens.css): bg, ink, mute, accent.
        private const val BG = 0xFF0B0B10.toInt()
        private const val FG = 0xFFF5F5F7.toInt()
        private const val MUTE = 0xFF9A9AAD.toInt()
        private const val ACCENT = 0xFFA35CF0.toInt()

        /** Opens `url` (a loopback page, [PreviewLinks.isLoopbackPage]) under `title` and `subtitle`. */
        fun intent(context: Context, url: String, title: String, subtitle: String?): Intent =
            Intent(context, PreviewActivity::class.java)
                .putExtra(EXTRA_URL, url)
                .putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_SUBTITLE, subtitle)
    }
}
