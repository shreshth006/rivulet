package dev.rivulet.sync

import android.app.Application
import android.net.Uri
import android.util.Log
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Process-wide setup. Whatever woke the process -- an app calling the
 * provider, a scheduled job, the user opening the settings screen -- the engine
 * starts, and every registered room is reopened so it can sync.
 */
class SyncApp : Application() {

    /**
     * Lazy, not set in onCreate: Android installs providers and can deliver a
     * provider call on a binder thread before Application.onCreate has run.
     */
    val rooms: Rooms by lazy { Rooms(this) }

    /** Blocking engine calls run here, never on the main thread. */
    val worker: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "rivulet-worker") }

    override fun attachBaseContext(base: android.content.Context) {
        super.attachBaseContext(base)
        // Before any provider runs, so RivuletProvider can always reach the app.
        instance = this
    }

    override fun onCreate() {
        super.onCreate()

        EngineHost.addListener(object : EngineHost.Listener {
            override fun onReady() { worker.execute { reopenAll() } }

            override fun onChanged(room: String, collections: List<String>) {
                // Rooms are "<owner package>/<name>"; tell the owner's observers.
                val (owner, name) = room.split('/', limit = 2).takeIf { it.size == 2 } ?: return
                for (collection in collections) {
                    contentResolver.notifyChange(RivuletProvider.uriFor(owner, name, collection), null)
                }
                contentResolver.notifyChange(RivuletProvider.roomUri(owner, name), null)
            }
        })
        EngineHost.start(this)
        SyncJobService.schedulePeriodic(this)
        // Android 12+ refuses a foreground-service start from the background --
        // say, when a scheduled job woke the process. The jobs cover that case.
        if (rooms.liveSync) {
            runCatching { LiveSyncService.start(this) }
                .onFailure { Log.i("RivuletSync", "live sync deferred: ${it.message}") }
        }
    }

    /** Open every registered room. Rooms already open are left as they are. */
    fun reopenAll() {
        for (room in rooms.all()) {
            try {
                EngineHost.call("open", rooms.openArgs(room))
            } catch (e: Exception) {
                Log.w("RivuletSync", "could not reopen ${room.id}: ${e.message}")
            }
        }
    }

    /** Server settings changed: close and reopen every room against the new server. */
    fun reconnectAll() {
        for (room in rooms.all()) {
            runCatching { EngineHost.call("close", org.json.JSONObject().put("room", room.id)) }
        }
        reopenAll()
    }

    companion object {
        lateinit var instance: SyncApp
            private set
    }
}

/** Convenience for building content URIs. */
internal fun Uri.Builder.segments(vararg parts: String): Uri.Builder = apply { parts.forEach { appendPath(it) } }
