package dev.rivulet.notes

import android.app.Activity
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import dev.rivulet.client.Rivulet
import dev.rivulet.client.RivuletException
import org.json.JSONObject

/** The list of notes, newest edits merged in as they arrive. */
class NotesActivity : Activity() {

    private lateinit var rivulet: Rivulet
    private lateinit var status: TextView
    private lateinit var message: TextView
    private lateinit var action: Button
    private lateinit var list: ListView
    private val adapter = NotesAdapter()
    private var stopObserving: (() -> Unit)? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        rivulet = Notebook.rivulet(this)
        val pad = dp(16)

        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(pad, pad * 2, pad, pad / 2)
            addView(TextView(context).apply {
                text = "Notes"; textSize = 24f; typeface = Typeface.DEFAULT_BOLD
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(Button(context).apply { text = "Sync"; setOnClickListener { syncNow() } })
            addView(Button(context).apply { text = "New"; setOnClickListener { newNote() } })
        }
        status = TextView(this).apply { setPadding(pad, 0, pad, pad / 2); textSize = 12f }
        message = TextView(this).apply { setPadding(pad, pad, pad, pad); visibility = View.GONE }
        action = Button(this).apply { visibility = View.GONE }
        list = ListView(this).apply {
            adapter = this@NotesActivity.adapter
            setOnItemClickListener { _, _, position, _ -> open(this@NotesActivity.adapter.getItem(position).getString("id")) }
        }

        setContentView(LinearLayout(this).apply {
            // Android 15 draws edge to edge; keep content clear of the system bars.
            fitsSystemWindows = true
            orientation = LinearLayout.VERTICAL
            addView(bar); addView(status); addView(message); addView(action)
            addView(list, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        })
    }

    override fun onResume() {
        super.onResume()
        connect()
    }

    override fun onPause() {
        stopObserving?.invoke()
        stopObserving = null
        super.onPause()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        connect()
    }

    /** Check the daemon is there and we may use it, then load and watch the notes. */
    private fun connect() {
        when {
            !rivulet.installed -> blocked("Rivulet Sync is not installed. Install it to keep notes synced offline.", null)
            !rivulet.hasAccess -> blocked("Notes stores your notes with Rivulet Sync.", "Allow access") {
                rivulet.requestAccess(this)
            }
            else -> {
                message.visibility = View.GONE
                action.visibility = View.GONE
                if (stopObserving == null) stopObserving = rivulet.observe(Notebook.ROOM, Notebook.NOTES) { reload() }
                reload()
            }
        }
    }

    private fun blocked(text: String, button: String?, onClick: (() -> Unit)? = null) {
        message.text = text
        message.visibility = View.VISIBLE
        action.visibility = if (button == null) View.GONE else View.VISIBLE
        action.text = button ?: ""
        action.setOnClickListener { onClick?.invoke() }
        adapter.set(emptyList())
    }

    private fun reload() {
        Notebook.io.execute {
            try {
                Notebook.ensure(rivulet)
                val notes = rivulet.list(Notebook.ROOM, Notebook.NOTES)
                    .sortedWith(compareByDescending<JSONObject> { it.optBoolean("pinned") }
                        .thenBy { it.optString("title").ifBlank { "￿" }.lowercase() })
                val room = rivulet.status().optJSONObject(Notebook.ROOM)
                runOnUiThread {
                    adapter.set(notes)
                    status.text = describe(room, notes.size)
                }
            } catch (e: RivuletException) {
                runOnUiThread { status.text = "Rivulet Sync: ${e.message}" }
            }
        }
    }

    private fun describe(room: JSONObject?, count: Int): String {
        val state = when (room?.optString("status")) {
            "live" -> "synced"
            "syncing" -> "syncing…"
            "offline" -> "offline — edits are saved and will sync"
            "unauthorised" -> "the sync server refused access"
            null, "" -> "starting…"
            else -> room.optString("status")
        }
        val pending = room?.optInt("pending") ?: 0
        return "$count note${if (count == 1) "" else "s"} · $state" + if (pending > 0) " · $pending to send" else ""
    }

    private fun syncNow() {
        status.text = "Syncing…"
        Notebook.io.execute {
            runCatching { rivulet.sync(Notebook.ROOM) }
            reload()
        }
    }

    private fun newNote() {
        Notebook.io.execute {
            try {
                Notebook.ensure(rivulet)
                val id = rivulet.create(Notebook.ROOM, Notebook.NOTES, mapOf("title" to "", "body" to ""))
                runOnUiThread { open(id) }
            } catch (e: RivuletException) {
                runOnUiThread { status.text = "Could not create a note: ${e.message}" }
            }
        }
    }

    private fun open(id: String) {
        startActivity(Intent(this, EditorActivity::class.java).putExtra(EditorActivity.EXTRA_ID, id))
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private inner class NotesAdapter : BaseAdapter() {
        private var notes: List<JSONObject> = emptyList()

        fun set(next: List<JSONObject>) { notes = next; notifyDataSetChanged() }

        override fun getCount() = notes.size
        override fun getItem(position: Int) = notes[position]
        override fun getItemId(position: Int) = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val note = notes[position]
            val row = (convertView as? LinearLayout) ?: LinearLayout(parent.context).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(16), dp(12), dp(16), dp(12))
                addView(TextView(context).apply { textSize = 17f; typeface = Typeface.DEFAULT_BOLD })
                addView(TextView(context).apply { textSize = 13f; maxLines = 2 })
            }
            val title = note.optString("title").ifBlank { "Untitled" }
            (row.getChildAt(0) as TextView).text = if (note.optBoolean("pinned")) "📌 $title" else title
            (row.getChildAt(1) as TextView).text = note.optString("body").trim().ifBlank { "Empty note" }
            return row
        }
    }
}
