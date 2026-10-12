package dev.rivulet.client

import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject

/** A failure reported by Rivulet Sync, with its error code (E_VALIDATION, E_AUTH, ...). */
class RivuletException(val code: String, message: String) : Exception(message)

/**
 * Offline-first, synced storage for any Android app, provided by the Rivulet
 * Sync daemon. The app describes its data once, then reads and writes locally:
 * every call answers from the device, with no network on the critical path,
 * and the daemon syncs in the background -- including after the app closes.
 *
 * ```
 * val rivulet = Rivulet(context)
 * rivulet.register("notebook", schema = mapOf("notes" to mapOf("title" to "lww", "body" to "text")))
 * val id = rivulet.create("notebook", "notes", mapOf("title" to "Hello"))
 * rivulet.observe("notebook", "notes") { refresh() }
 * ```
 *
 * Every method blocks on a call to another process; use them off the main
 * thread. Rooms are private to the calling app.
 */
class Rivulet(context: Context) {
    private val context = context.applicationContext
    private val resolver = this.context.contentResolver

    /** Whether the Rivulet Sync app is installed. */
    val installed: Boolean
        get() = context.packageManager.resolveContentProvider(AUTHORITY, 0) != null

    /** Whether this app may use it. If not, call [requestAccess] from an Activity. */
    val hasAccess: Boolean
        get() = context.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED

    /** Ask the user to let this app use Rivulet Sync. Result arrives in onRequestPermissionsResult. */
    fun requestAccess(activity: Activity, requestCode: Int = 4711) {
        activity.requestPermissions(arrayOf(PERMISSION), requestCode)
    }

    /* ---------------------------------------------------------- rooms */

    /**
     * Open (creating on first use) a room with this schema: collection ->
     * field -> type, where type is one of lww, text, seq, set, counter, mv,
     * string, number, boolean, json. A field's type cannot change later.
     *
     * Pass [key] (from the daemon's generateRoomKey, shared out of band) to
     * end-to-end encrypt the room: the server then stores what it cannot read.
     */
    fun register(room: String, schema: Map<String, Map<String, String>>, key: String? = null): JSONObject =
        call("register", JSONObject().put("room", room).put("schema", JSONObject(schema)).put("key", key ?: JSONObject.NULL))
            as JSONObject

    fun unregister(room: String) { call("unregister", JSONObject().put("room", room)) }

    /** Sync status of this app's rooms: name -> { status, pending, encrypted, ... }. */
    fun status(): JSONObject = call("status", JSONObject()) as JSONObject

    /** Sync now rather than waiting for the background schedule. */
    fun sync(room: String? = null): JSONObject =
        call("sync", JSONObject().apply { if (room != null) put("room", room) }) as? JSONObject ?: JSONObject()

    /* ---------------------------------------------------------- reads */

    fun get(room: String, collection: String, id: String): JSONObject? =
        call("get", JSONObject().put("room", room).put("collection", collection).put("id", id)) as? JSONObject

    /**
     * Documents in a collection. [where] uses the engine's query operators
     * ($gt, $in, $regex, ...); [sort] is a field name, '-field' for descending.
     */
    fun list(room: String, collection: String, where: Map<String, Any?>? = null, sort: String? = null, limit: Int? = null): List<JSONObject> {
        val args = JSONObject().put("room", room).put("collection", collection)
        where?.let { args.put("where", JSONObject(it)) }
        sort?.let { args.put("sort", it) }
        limit?.let { args.put("limit", it) }
        val array = call("list", args) as? JSONArray ?: return emptyList()
        return List(array.length()) { array.getJSONObject(it) }
    }

    /* --------------------------------------------------------- writes */

    /** Apply several writes as one transaction. Each action is a JSON object; see [Action]. */
    fun mutate(room: String, vararg actions: JSONObject): JSONArray =
        call("mutate", JSONObject().put("room", room).put("actions", JSONArray(actions.toList()))) as JSONArray

    /** Create a document and return its id. */
    fun create(room: String, collection: String, values: Map<String, Any?> = emptyMap()): String =
        mutate(room, Action.create(collection, values)).getString(0)

    fun update(room: String, collection: String, id: String, values: Map<String, Any?>) {
        mutate(room, Action.update(collection, id, values))
    }

    /** Set a text field to [text]; only the difference is stored and sent. */
    fun setText(room: String, collection: String, id: String, field: String, text: String) {
        mutate(room, Action.setText(collection, id, field, text))
    }

    fun delete(room: String, collection: String, id: String) { mutate(room, Action.delete(collection, id)) }

    /** Builders for [mutate]'s actions. */
    object Action {
        fun create(collection: String, values: Map<String, Any?>) =
            JSONObject().put("op", "create").put("collection", collection).put("values", JSONObject(values))
        fun update(collection: String, id: String, values: Map<String, Any?>) =
            JSONObject().put("op", "update").put("collection", collection).put("id", id).put("values", JSONObject(values))
        fun set(collection: String, id: String, field: String, value: Any?) =
            base("set", collection, id).put("field", field).put("value", value ?: JSONObject.NULL)
        fun setText(collection: String, id: String, field: String, text: String) =
            base("setText", collection, id).put("field", field).put("text", text)
        fun add(collection: String, id: String, field: String, element: Any) =
            base("add", collection, id).put("field", field).put("element", element)
        fun remove(collection: String, id: String, field: String, element: Any) =
            base("remove", collection, id).put("field", field).put("element", element)
        fun increment(collection: String, id: String, field: String, delta: Number = 1) =
            base("increment", collection, id).put("field", field).put("delta", delta)
        fun delete(collection: String, id: String) = base("delete", collection, id)

        private fun base(op: String, collection: String, id: String) =
            JSONObject().put("op", op).put("collection", collection).put("id", id)
    }

    /* -------------------------------------------------------- observe */

    /**
     * Run [onChange] on the main thread whenever [collection] changes --
     * locally or because another device's edits arrived. Returns a function
     * that stops observing.
     */
    fun observe(room: String, collection: String, onChange: () -> Unit): () -> Unit {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) = onChange()
        }
        resolver.registerContentObserver(uri(room, collection), true, observer)
        holdDaemon()
        var stopped = false
        return {
            if (!stopped) {
                stopped = true
                resolver.unregisterContentObserver(observer)
                releaseDaemon()
            }
        }
    }

    /**
     * While anything is observing, hold a connection to the daemon's provider.
     * Android ranks a provider's process by its clients, so this keeps Rivulet
     * Sync as important as the app on screen: Android 14+ otherwise cuts the
     * network of background processes and destroys their sockets, which would
     * end the live stream that brings other devices' edits in.
     *
     * Unstable, deliberately: if the daemon crashes while a *stable* client is
     * held, Android kills the client app too.
     */
    private fun holdDaemon() = synchronized(Companion) {
        if (holders++ == 0) held = runCatching { resolver.acquireUnstableContentProviderClient(AUTHORITY) }.getOrNull()
    }

    private fun releaseDaemon() = synchronized(Companion) {
        if (--holders == 0) { held?.close(); held = null }
    }

    /** The content URI for a collection, for a CursorLoader or a ContentObserver. */
    fun uri(room: String, collection: String): Uri = Uri.Builder()
        .scheme("content").authority(AUTHORITY)
        .appendPath(context.packageName).appendPath(room).appendPath(collection)
        .build()

    /* ------------------------------------------------------------ wire */

    private fun call(method: String, args: JSONObject): Any? {
        if (!installed) throw RivuletException("E_NOT_INSTALLED", "Rivulet Sync is not installed")
        val reply: Bundle = try {
            resolver.call(PROVIDER, method, null, Bundle().apply { putString("args", args.toString()) })
        } catch (e: SecurityException) {
            throw RivuletException("E_AUTH", "this app has not been given access to Rivulet Sync")
        } ?: throw RivuletException("E_INTERNAL", "Rivulet Sync returned nothing")

        reply.getString("error")?.let {
            val error = JSONObject(it)
            throw RivuletException(error.optString("code"), error.optString("message"))
        }
        val raw = reply.getString("result") ?: return null
        return when {
            raw == "null" -> null
            raw.startsWith("{") -> JSONObject(raw)
            raw.startsWith("[") -> JSONArray(raw)
            raw.startsWith("\"") -> JSONArray("[$raw]").getString(0)
            else -> raw
        }
    }

    companion object {
        // Shared by every Rivulet instance in the process: one connection is enough.
        private var holders = 0
        private var held: android.content.ContentProviderClient? = null

        const val AUTHORITY = "dev.rivulet.sync.provider"
        const val PERMISSION = "dev.rivulet.permission.ACCESS"
        private val PROVIDER: Uri = Uri.parse("content://$AUTHORITY")
    }
}
