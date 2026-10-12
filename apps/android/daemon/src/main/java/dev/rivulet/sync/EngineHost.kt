package dev.rivulet.sync

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.FileNotFoundException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicLong

/** A failure reported by the engine, with its Rivulet error code (E_AUTH, E_VALIDATION, ...). */
class EngineException(val code: String, message: String) : Exception(message)

/**
 * Runs the Rivulet engine -- the same JavaScript the browser demo runs -- in an
 * off-screen WebView, and turns it into blocking calls for the rest of the app.
 *
 * Why a WebView: the engine needs IndexedDB for durable storage, WebCrypto for
 * encrypted rooms and CompressionStream for the wire. Android's WebView has all
 * three; no embeddable JS engine does. So the engine is not ported, and cannot
 * drift from the one the tests cover.
 *
 * The page is served from https://appassets.androidplatform.net, a secure
 * origin, which WebCrypto requires. Requests to it never leave the device:
 * [shouldInterceptRequest] answers them from the APK's assets.
 */
object EngineHost {
    private const val TAG = "RivuletEngine"
    private const val ORIGIN_HOST = "appassets.androidplatform.net"
    private const val HOST_PAGE = "https://$ORIGIN_HOST/host/host.html"

    interface Listener {
        fun onChanged(room: String, collections: List<String>) {}
        fun onStatus(room: String, status: String) {}
        fun onReady() {}
    }

    private val main = Handler(Looper.getMainLooper())
    private val nextId = AtomicLong()
    private val pending = ConcurrentHashMap<String, CompletableFuture<JSONObject>>()
    private val listeners = CopyOnWriteArrayList<Listener>()

    @Volatile private var ready = CountDownLatch(1)
    private var webView: WebView? = null
    private lateinit var appContext: Context

    fun addListener(listener: Listener) { listeners += listener }
    fun removeListener(listener: Listener) { listeners -= listener }

    /** Create the WebView if it does not exist. Safe to call from any thread, any number of times. */
    fun start(context: Context) {
        appContext = context.applicationContext
        main.post { if (webView == null) create() }
    }

    /**
     * Call an engine method and wait for its result. Never call on the main
     * thread: the engine itself runs there, so waiting on it would deadlock.
     */
    fun call(method: String, args: JSONObject = JSONObject(), timeoutMs: Long = 20_000): Any? {
        check(Looper.myLooper() != Looper.getMainLooper()) { "EngineHost.call must not run on the main thread" }
        if (!ready.await(timeoutMs, TimeUnit.MILLISECONDS)) throw TimeoutException("engine did not start")

        val id = nextId.incrementAndGet().toString()
        val future = CompletableFuture<JSONObject>()
        pending[id] = future
        val script = "rivulet.handle(${JSONObject.quote(id)}, ${JSONObject.quote(method)}, ${JSONObject.quote(args.toString())})"
        main.post {
            val view = webView
            if (view == null) future.completeExceptionally(IllegalStateException("engine is not running"))
            else view.evaluateJavascript(script, null)
        }
        try {
            val reply = future.get(timeoutMs, TimeUnit.MILLISECONDS)
            if (!reply.optBoolean("ok")) {
                val error = reply.optJSONObject("error") ?: JSONObject()
                throw EngineException(error.optString("code", "E_INTERNAL"), error.optString("message", "engine error"))
            }
            return reply.opt("result").takeUnless { it == JSONObject.NULL }
        } finally {
            pending.remove(id)
        }
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun create() {
        val view = WebView(appContext)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // The page's origin is https; a development sync server is plain
            // http on 10.0.2.2. Production servers are https and need none of this.
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            allowFileAccess = false
            allowContentAccess = false
        }
        view.addJavascriptInterface(Bridge(), "RivuletNative")
        view.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                Log.d(TAG, "${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                return true
            }
        }
        view.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (request.url.host != ORIGIN_HOST) return null
                return asset(request.url.path ?: "/")
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // The renderer died (memory pressure, crash). Fail whatever was
                // waiting, then start over: every room is reopened from storage.
                Log.w(TAG, "engine renderer gone; restarting")
                ready = CountDownLatch(1)
                for (future in pending.values) future.completeExceptionally(IllegalStateException("engine restarted"))
                webView?.destroy()
                webView = null
                main.post { create() }
                return true
            }
        }
        webView = view
        view.loadUrl(HOST_PAGE)
    }

    /**
     * Serve the host page and engine source from assets. Like the demo's static
     * server, an extensionless module path also tries `.js`: the engine imports
     * `#core/util`, which the import map turns into `/engine/src/core/util`.
     */
    private fun asset(path: String): WebResourceResponse {
        val relative = path.trimStart('/')
        if (relative.contains("..")) return notFound()
        for (candidate in listOf(relative, "$relative.js")) {
            try {
                val stream = appContext.assets.open(candidate)
                val response = WebResourceResponse(mimeOf(candidate), "utf-8", stream)
                response.responseHeaders = mapOf("Cache-Control" to "no-cache")
                return response
            } catch (_: FileNotFoundException) {
                // try the next candidate
            }
        }
        return notFound()
    }

    private fun notFound() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)

    private fun mimeOf(path: String) = when (path.substringAfterLast('.', "")) {
        "html" -> "text/html"
        "js", "mjs" -> "text/javascript"
        "json" -> "application/json"
        "css" -> "text/css"
        else -> "application/octet-stream"
    }

    /** Called from JavaScript, on a WebView binder thread. */
    private class Bridge {
        @JavascriptInterface
        fun ready() {
            Log.i(TAG, "engine ready")
            ready.countDown()
            for (l in listeners) l.onReady()
        }

        @JavascriptInterface
        fun reply(id: String, json: String) {
            pending[id]?.complete(JSONObject(json))
        }

        @JavascriptInterface
        fun changed(room: String, collectionsJson: String) {
            val array = JSONArray(collectionsJson)
            val collections = List(array.length()) { array.getString(it) }
            for (l in listeners) l.onChanged(room, collections)
        }

        @JavascriptInterface
        fun status(room: String, status: String) {
            for (l in listeners) l.onStatus(room, status)
        }
    }
}
