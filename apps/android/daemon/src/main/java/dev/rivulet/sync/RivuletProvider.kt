package dev.rivulet.sync

import android.content.ContentProvider
import android.content.ContentValues
import android.content.pm.PackageManager
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Binder
import android.os.Bundle
import android.os.Process
import org.json.JSONArray
import org.json.JSONObject

/**
 * The daemon's interface to other apps.
 *
 * Everything goes through `call()` with JSON arguments, because Rivulet's
 * writes -- "insert these characters", "add this tag", "increment by two" --
 * do not fit ContentValues. Reads are also available through `query()`, so a
 * Cursor and a ContentObserver work the way Android developers expect:
 *
 *   content://dev.rivulet.sync.provider/<package>/<room>/<collection>
 *
 * Each app sees only its own rooms: room names are qualified with the calling
 * package, and a URI naming another package is refused.
 *
 * Results come back as `{ "result": json }` or `{ "error": { code, message } }`
 * in the returned Bundle; exceptions do not cross process boundaries intact.
 */
class RivuletProvider : ContentProvider() {

    override fun onCreate(): Boolean = true

    private val app get() = SyncApp.instance

    /* ------------------------------------------------------------ call() */

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
        val caller = authorise()
        return try {
            // JSON arguments in the extras, or in `arg` -- which is what a
            // terminal can send: `content call` cannot put JSON in an extra.
            val args = JSONObject(extras?.getString(ARGS) ?: arg ?: "{}")
            Bundle().apply { putString(RESULT, JSONObject.wrap(dispatch(caller, method, args))?.toString() ?: "null") }
        } catch (e: EngineException) {
            error(e.code, e.message)
        } catch (e: IllegalArgumentException) {
            error("E_VALIDATION", e.message)
        } catch (e: Exception) {
            error("E_INTERNAL", e.message ?: e.javaClass.simpleName)
        }
    }

    private fun dispatch(caller: String, method: String, args: JSONObject): Any? = when (method) {
        "register" -> register(caller, args)
        "unregister" -> {
            val room = ownRoom(caller, args)
            runCatching { EngineHost.call("close", JSONObject().put("room", room.id)) }
            app.rooms.remove(room.id)
            JSONObject().put("removed", true)
        }
        "mutate" -> engine(caller, args, "mutate").also { SyncJobService.scheduleSoon(app) }
        "get", "list", "conflicts" -> engine(caller, args, method)
        "sync" -> {
            if (args.has("room")) engine(caller, args, "sync")
            else JSONObject().also { out ->
                for (room in app.rooms.all().filter { it.owner == caller }) {
                    val r = engineCall(room, "sync", JSONObject()) as? JSONObject
                    r?.optJSONObject(room.id)?.let { out.put(room.name, it) }
                }
            }
        }
        "status" -> status(caller)
        else -> throw IllegalArgumentException("unknown method: $method")
    }

    private fun register(caller: String, args: JSONObject): Any? {
        val name = roomName(args)
        val schema = args.optJSONObject("schema") ?: throw IllegalArgumentException("a schema is required")
        val key = args.optString("key").takeIf { it.isNotEmpty() && !args.isNull("key") }
        val room = RoomConfig(caller, name, schema, key)

        app.rooms.get(room.id)?.let { existing ->
            // A field's merge type is permanent once data exists; and a room
            // cannot quietly switch between encrypted and plaintext.
            require(existing.schema.toString() == schema.toString()) { "room $name is registered with a different schema" }
            require(existing.key == key) { "room $name is registered with a different encryption key" }
        }
        app.rooms.put(room)
        val opened = EngineHost.call("open", app.rooms.openArgs(room)) as JSONObject
        return opened.put("room", name).put("encrypted", key != null)
    }

    private fun status(caller: String): JSONObject {
        val all = EngineHost.call("status") as? JSONObject ?: JSONObject()
        val out = JSONObject()
        for (room in app.rooms.all().filter { it.owner == caller }) {
            out.put(room.name, all.optJSONObject(room.id) ?: JSONObject().put("status", "closed"))
        }
        return out
    }

    /** Forward to the engine with the room qualified, reopening it once if the engine restarted. */
    private fun engine(caller: String, args: JSONObject, method: String): Any? =
        engineCall(ownRoom(caller, args), method, args)

    private fun engineCall(room: RoomConfig, method: String, args: JSONObject): Any? {
        val qualified = JSONObject(args.toString()).put("room", room.id)
        return try {
            EngineHost.call(method, qualified)
        } catch (e: EngineException) {
            if (e.code != "E_NO_ROOM") throw e
            EngineHost.call("open", app.rooms.openArgs(room))
            EngineHost.call(method, qualified)
        }
    }

    private fun ownRoom(caller: String, args: JSONObject): RoomConfig {
        val name = roomName(args)
        return app.rooms.get(RoomConfig.qualify(caller, name))
            ?: throw IllegalArgumentException("room $name is not registered; call register first")
    }

    private fun roomName(args: JSONObject): String {
        val name = args.optString("room")
        require(ROOM_NAME.matches(name)) { "room names are 1-64 of A-Z a-z 0-9 . _ -" }
        return name
    }

    /* ----------------------------------------------------------- query() */

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?,
                       selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val caller = authorise()
        val segments = uri.pathSegments
        require(segments.size == 3) { "expected content://$AUTHORITY/<package>/<room>/<collection>" }
        val (owner, name, collection) = segments
        if (owner != caller) throw SecurityException("$caller cannot read $owner's rooms")

        val room = app.rooms.get(RoomConfig.qualify(owner, name))
            ?: throw IllegalArgumentException("room $name is not registered")
        val args = JSONObject().put("collection", collection)
        uri.getQueryParameter("limit")?.toIntOrNull()?.let { args.put("limit", it) }
        uri.getQueryParameter("sort")?.let { args.put("sort", it) }

        val docs = engineCall(room, "list", args) as? JSONArray ?: JSONArray()
        val cursor = MatrixCursor(arrayOf("_id", "id", "json"), docs.length())
        for (i in 0 until docs.length()) {
            val doc = docs.getJSONObject(i)
            cursor.addRow(arrayOf<Any>(i.toLong(), doc.optString("id"), doc.toString()))
        }
        cursor.setNotificationUri(context!!.contentResolver, uriFor(owner, name, collection))
        return cursor
    }

    override fun getType(uri: Uri) = "vnd.android.cursor.dir/vnd.rivulet.document"

    // Rivulet writes are richer than rows: use call("mutate").
    override fun insert(uri: Uri, values: ContentValues?): Uri? =
        throw UnsupportedOperationException("use call(\"mutate\")")
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int =
        throw UnsupportedOperationException("use call(\"mutate\")")
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int =
        throw UnsupportedOperationException("use call(\"mutate\")")

    /* ------------------------------------------------------------ access */

    /**
     * The only gate: every entry point that touches data calls this first.
     * Returns the calling package.
     */
    private fun authorise(): String {
        val ctx = context!!
        val uid = Binder.getCallingUid()
        val ownUid = uid == Process.myUid()
        // `adb shell content call` in debug builds, so the provider can be
        // exercised from a terminal.
        val shell = BuildConfig.DEBUG && uid == SHELL_UID
        if (!ownUid && !shell && ctx.checkCallingPermission(PERMISSION) != PackageManager.PERMISSION_GRANTED) {
            throw SecurityException("requires $PERMISSION")
        }
        return callingPackage ?: ctx.packageName
    }

    private fun error(code: String, message: String?) = Bundle().apply {
        putString(ERROR, JSONObject().put("code", code).put("message", message ?: code).toString())
    }

    companion object {
        const val AUTHORITY = "dev.rivulet.sync.provider"
        const val PERMISSION = "dev.rivulet.permission.ACCESS"
        const val ARGS = "args"
        const val RESULT = "result"
        const val ERROR = "error"
        /** android.os.Process.SHELL_UID, which is not public API. */
        private const val SHELL_UID = 2000
        private val ROOM_NAME = Regex("[A-Za-z0-9._-]{1,64}")

        fun roomUri(owner: String, room: String): Uri =
            Uri.Builder().scheme("content").authority(AUTHORITY).segments(owner, room).build()

        fun uriFor(owner: String, room: String, collection: String): Uri =
            Uri.Builder().scheme("content").authority(AUTHORITY).segments(owner, room, collection).build()
    }
}
