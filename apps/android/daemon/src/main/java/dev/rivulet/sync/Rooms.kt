package dev.rivulet.sync

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject

/**
 * One app's room, as registered with the daemon.
 *
 * Rooms are namespaced by the owning package: an app asks for "notebook" and
 * gets `dev.example.app/notebook`. Two apps can use the same name without
 * seeing each other's data, and the server sees which app a room belongs to.
 */
data class RoomConfig(
    val owner: String,
    val name: String,
    val schema: JSONObject,
    /** Room key for end-to-end encryption, or null for a plaintext room. */
    val key: String?,
) {
    val id: String get() = qualify(owner, name)

    fun toJson(): JSONObject = JSONObject()
        .put("owner", owner).put("name", name).put("schema", schema).put("key", key ?: JSONObject.NULL)

    companion object {
        fun qualify(owner: String, name: String) = "$owner/$name"

        fun fromJson(json: JSONObject) = RoomConfig(
            owner = json.getString("owner"),
            name = json.getString("name"),
            schema = json.getJSONObject("schema"),
            key = json.optString("key").takeIf { it.isNotEmpty() && !json.isNull("key") },
        )
    }
}

/**
 * Durable daemon state: the server to sync with, and every registered room.
 * Survives the process being killed, so the daemon can reopen every room on
 * the next start -- which is what lets a background job sync rooms whose apps
 * are not running.
 *
 * Room keys live in this app's private storage, which other apps cannot read.
 */
class Rooms(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("rivulet-rooms", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString("server.url", BuildConfig.DEFAULT_SERVER) ?: BuildConfig.DEFAULT_SERVER
        set(value) { prefs.edit().putString("server.url", value.trim().trimEnd('/')).apply() }

    /** Bearer token for the server: a deployment token, or a room token whose pattern covers the apps' rooms. */
    var serverToken: String?
        get() = prefs.getString("server.token", null)?.takeIf { it.isNotBlank() }
        set(value) { prefs.edit().putString("server.token", value?.trim()).apply() }

    var liveSync: Boolean
        get() = prefs.getBoolean("live", false)
        set(value) { prefs.edit().putBoolean("live", value).apply() }

    fun all(): List<RoomConfig> = prefs.all.entries
        .filter { it.key.startsWith("room:") }
        .mapNotNull { (it.value as? String)?.let { json -> runCatching { RoomConfig.fromJson(JSONObject(json)) }.getOrNull() } }
        .sortedBy { it.id }

    fun get(id: String): RoomConfig? =
        prefs.getString("room:$id", null)?.let { RoomConfig.fromJson(JSONObject(it)) }

    fun put(room: RoomConfig) { prefs.edit().putString("room:${room.id}", room.toJson().toString()).commit() }

    fun remove(id: String) { prefs.edit().remove("room:$id").commit() }

    /** Arguments for the engine's `open`. */
    fun openArgs(room: RoomConfig): JSONObject = JSONObject()
        .put("room", room.id)
        .put("schema", room.schema)
        .put("url", if (serverUrl.isBlank()) JSONObject.NULL else serverUrl)
        .put("token", serverToken ?: JSONObject.NULL)
        .put("key", room.key ?: JSONObject.NULL)
}
