package dev.rivulet.notes

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import dev.rivulet.client.Rivulet
import org.json.JSONObject

/**
 * One note. Typing is saved through Rivulet after a short pause; Rivulet turns
 * the whole new value into a character-level diff, so two people editing
 * different parts of the body on different phones both keep their work.
 *
 * A remote edit arriving while you type must not move your cursor, so fields
 * are refreshed only when their text actually differs, keeping the selection.
 */
class EditorActivity : Activity() {

    private lateinit var rivulet: Rivulet
    private lateinit var noteId: String
    private lateinit var titleField: EditText
    private lateinit var body: EditText
    private lateinit var pinned: CheckBox

    private val main = Handler(Looper.getMainLooper())
    private val save = Runnable { flush() }
    private var applyingRemote = false
    private var savePending = false
    /** What was last written, so a save sends only fields that changed. */
    private var saved = JSONObject()
    private var stopObserving: (() -> Unit)? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        rivulet = Notebook.rivulet(this)
        noteId = intent.getStringExtra(EXTRA_ID) ?: return finish()
        val pad = (16 * resources.displayMetrics.density).toInt()

        titleField = EditText(this).apply {
            hint = "Title"; textSize = 22f; setSingleLine()
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        }
        body = EditText(this).apply {
            hint = "Write something…"; gravity = Gravity.TOP; minLines = 10
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or
                InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        }
        pinned = CheckBox(this).apply { text = "Pinned" }

        val watcher = object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                if (applyingRemote) return
                main.removeCallbacks(save)
                savePending = true
                main.postDelayed(save, 400)
            }
        }
        titleField.addTextChangedListener(watcher)
        body.addTextChangedListener(watcher)
        pinned.setOnCheckedChangeListener { _, _ -> if (!applyingRemote) flush() }

        val delete = Button(this).apply {
            text = "Delete note"
            setOnClickListener {
                main.removeCallbacks(save)
                Notebook.io.execute { runCatching { rivulet.delete(Notebook.ROOM, Notebook.NOTES, noteId) } }
                finish()
            }
        }

        setContentView(ScrollView(this).apply {
            fitsSystemWindows = true
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(pad, pad * 2, pad, pad)
                addView(titleField); addView(pinned)
                addView(body, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
                addView(delete)
            })
        })
        load()
    }

    override fun onResume() {
        super.onResume()
        stopObserving = rivulet.observe(Notebook.ROOM, Notebook.NOTES) { load() }
    }

    override fun onPause() {
        stopObserving?.invoke()
        stopObserving = null
        // Leaving the screen saves at once rather than after the pause.
        main.removeCallbacks(save)
        flush()
        super.onPause()
    }

    private fun load() {
        Notebook.io.execute {
            val note = runCatching { rivulet.get(Notebook.ROOM, Notebook.NOTES, noteId) }.getOrNull()
            runOnUiThread { if (note == null) finish() else show(note) }
        }
    }

    private fun show(note: JSONObject) {
        // Our own pending edit is newer than what is stored; let it land first.
        if (savePending) return
        saved = note
        applyingRemote = true
        setKeepingCursor(titleField, note.optString("title"))
        setKeepingCursor(body, note.optString("body"))
        pinned.isChecked = note.optBoolean("pinned")
        applyingRemote = false
    }

    private fun setKeepingCursor(field: EditText, next: String) {
        if (field.text.toString() == next) return
        val start = field.selectionStart.coerceAtMost(next.length)
        val end = field.selectionEnd.coerceAtMost(next.length)
        field.setText(next)
        field.setSelection(start.coerceAtLeast(0), end.coerceAtLeast(0))
    }

    private fun flush() {
        savePending = false
        val titleNow = titleField.text.toString()
        val bodyNow = body.text.toString()
        val pinnedNow = pinned.isChecked
        val actions = buildList {
            // title is last-writer-wins: a whole new value, sent only if it changed.
            if (titleNow != saved.optString("title")) add(Rivulet.Action.set(Notebook.NOTES, noteId, "title", titleNow))
            // body is text: Rivulet stores just the characters that differ.
            if (bodyNow != saved.optString("body")) add(Rivulet.Action.setText(Notebook.NOTES, noteId, "body", bodyNow))
            if (pinnedNow != saved.optBoolean("pinned")) add(Rivulet.Action.set(Notebook.NOTES, noteId, "pinned", pinnedNow))
        }
        if (actions.isEmpty()) return
        saved = JSONObject(saved.toString()).put("title", titleNow).put("body", bodyNow).put("pinned", pinnedNow)
        Notebook.io.execute { runCatching { rivulet.mutate(Notebook.ROOM, *actions.toTypedArray()) } }
    }

    companion object {
        const val EXTRA_ID = "id"
    }
}
