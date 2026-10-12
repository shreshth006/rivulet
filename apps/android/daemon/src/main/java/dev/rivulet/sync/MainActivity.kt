package dev.rivulet.sync

import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import org.json.JSONObject

/**
 * The daemon's only screen: where it syncs to, whether it stays live, and
 * what every app's rooms are doing. Apps never need to open it; it exists for
 * the person who owns the phone.
 */
class MainActivity : Activity() {

    private val app get() = application as SyncApp
    private lateinit var server: EditText
    private lateinit var token: EditText
    private lateinit var live: Switch
    private lateinit var status: TextView

    private val listener = object : EngineHost.Listener {
        override fun onStatus(room: String, status: String) = refreshSoon()
        override fun onChanged(room: String, collections: List<String>) = refreshSoon()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (16 * resources.displayMetrics.density).toInt()
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad * 2, pad, pad)
        }

        column += heading("Rivulet Sync")
        column += text("Keeps other apps' data available offline and syncs it in the background.")

        column += label("Sync server")
        server = EditText(this).apply {
            setText(app.rooms.serverUrl)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine()
        }
        column += server

        column += label("Access token (optional)")
        token = EditText(this).apply {
            setText(app.rooms.serverToken ?: "")
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setSingleLine()
        }
        column += token

        column += Button(this).apply {
            text = "Save and reconnect"
            setOnClickListener { save() }
        }

        live = Switch(this).apply {
            text = "Live sync (keeps a notification while on)"
            isChecked = app.rooms.liveSync
            setOnCheckedChangeListener { _, on -> setLive(on) }
        }
        column += live

        column += Button(this).apply {
            text = "Sync now"
            setOnClickListener { syncNow() }
        }

        column += label("Rooms")
        status = TextView(this).apply { typeface = Typeface.MONOSPACE; textSize = 12f }
        column += status

        // Android 15 draws edge to edge; keep content clear of the system bars.
        setContentView(ScrollView(this).apply { fitsSystemWindows = true; addView(column) })
    }

    override fun onResume() {
        super.onResume()
        EngineHost.addListener(listener)
        refresh()
    }

    override fun onPause() {
        EngineHost.removeListener(listener)
        super.onPause()
    }

    private fun save() {
        app.rooms.serverUrl = server.text.toString()
        app.rooms.serverToken = token.text.toString()
        status.text = "Reconnecting…"
        app.worker.execute { app.reconnectAll(); refreshSoon() }
    }

    private fun setLive(on: Boolean) {
        app.rooms.liveSync = on
        if (on) {
            if (Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            ) {
                requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1)
            }
            LiveSyncService.start(this)
        } else {
            LiveSyncService.stop(this)
        }
    }

    private fun syncNow() {
        status.text = "Syncing…"
        app.worker.execute {
            runCatching { EngineHost.call("sync", JSONObject(), timeoutMs = 60_000) }
            refreshSoon()
        }
    }

    private fun refreshSoon() { runOnUiThread { refresh() } }

    private fun refresh() {
        app.worker.execute {
            val rooms = app.rooms.all()
            val engine = runCatching { EngineHost.call("status") as? JSONObject }.getOrNull() ?: JSONObject()
            val lines = if (rooms.isEmpty()) {
                "No app has registered a room yet."
            } else {
                rooms.joinToString("\n\n") { room ->
                    val s = engine.optJSONObject(room.id)
                    buildString {
                        append(room.owner).append('\n')
                        append("  ").append(room.name)
                        if (room.key != null) append("  🔒")
                        append('\n')
                        append("  ").append(s?.optString("status") ?: "closed")
                        s?.optInt("pending")?.takeIf { it > 0 }?.let { append(" · $it pending") }
                    }
                }
            }
            runOnUiThread { status.text = lines }
        }
    }

    private operator fun LinearLayout.plusAssign(view: View) {
        addView(view, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
    }

    private fun heading(s: String) = TextView(this).apply { text = s; textSize = 24f; typeface = Typeface.DEFAULT_BOLD }
    private fun text(s: String) = TextView(this).apply { text = s; setPadding(0, 8, 0, 24) }
    private fun label(s: String) = TextView(this).apply {
        text = s; textSize = 12f; typeface = Typeface.DEFAULT_BOLD; setPadding(0, 32, 0, 4)
    }
}
