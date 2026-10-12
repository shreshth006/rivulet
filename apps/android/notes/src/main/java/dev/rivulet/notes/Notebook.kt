package dev.rivulet.notes

import android.content.Context
import dev.rivulet.client.Rivulet
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * This app's whole data layer: one room, one schema. Everything else --
 * storage, offline queueing, merging concurrent edits, sync -- is the daemon's.
 */
object Notebook {
    const val ROOM = "notebook"
    const val NOTES = "notes"

    val schema = mapOf(
        NOTES to mapOf(
            "title" to "lww",    // a rename is atomic: newest wins
            "body" to "text",    // character-level merge: nobody's typing is lost
            "pinned" to "boolean",
        ),
    )

    /** Rivulet calls cross a process boundary, so they run here, never on the UI thread. */
    val io: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "notes-io") }

    @Volatile private var registered = false

    fun rivulet(context: Context) = Rivulet(context)

    /** Register the room once per process; cheap to call again. */
    fun ensure(rivulet: Rivulet) {
        if (registered) return
        rivulet.register(ROOM, schema)
        registered = true
    }
}
