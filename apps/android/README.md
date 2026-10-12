# Rivulet on Android

**Rivulet Sync** is a background daemon that gives any Android app
offline-first, synced storage. Apps describe their data once, then read and
write locally; the daemon keeps it on the device, merges concurrent edits and
syncs in the background, including after the app has closed.

```
 ┌──────────────┐   ContentProvider    ┌──────────────────────────────────┐   HTTPS   ┌────────────┐
 │ Rivulet Notes│ ───────────────────▶ │ Rivulet Sync                     │ ────────▶ │ sync server│
 │ (any app)    │ ◀─── change notify ─ │  provider · jobs · live service  │ ◀──────── │ (Docker)   │
 └──────────────┘                      │  engine: Rivulet JS in a WebView │           └────────────┘
                                       └──────────────────────────────────┘
```

Three Gradle modules:

| Module | What it is |
|---|---|
| `daemon` | The Rivulet Sync app: provider, background sync, settings screen |
| `client` | A small library apps use to talk to the daemon (one class, `Rivulet`) |
| `notes` | Rivulet Notes, an example app built only on `client` |

## How the daemon works

**The engine is not ported.** The daemon runs Rivulet's own JavaScript, copied
from `src/` at build time, in an off-screen WebView. That gives it IndexedDB for
durable storage, WebCrypto for encrypted rooms and CompressionStream for the
wire, all of which the engine already uses in browsers, and no embeddable JS
engine on Android has. The page is served from a secure origin
(`https://appassets.androidplatform.net`, answered from the APK's assets), so
WebCrypto is available.

**Apps talk to it through a ContentProvider** at `content://dev.rivulet.sync.provider`.
Writes go through `call()` with JSON, because Rivulet writes ("insert these
characters", "add this tag", "increment by two") do not fit ContentValues.
Reads also work through `query()`, so Cursors and ContentObservers behave as
Android developers expect:

```
content://dev.rivulet.sync.provider/<package>/<room>/<collection>
```

**Rooms are private to the app that registered them.** A room called
`notebook` registered by `dev.rivulet.notes` is `dev.rivulet.notes/notebook`
on the daemon and the server, and another app cannot read it.

**Access needs the user's consent.** Apps hold `dev.rivulet.permission.ACCESS`,
a runtime ("dangerous") permission, so Android asks the user first. The
provider checks it in code on every entry point, rather than in the manifest,
so that debug builds can also accept `adb shell content call`.

**Staying live while an app is open.** Android 14+ cuts the network of
background processes and destroys their sockets, which would end the live
stream that brings other devices' edits in. So while an app is observing a
collection, the client library holds a connection to the daemon's provider;
Android ranks a provider by its clients, so the daemon is then as important as
the app on screen and keeps its network. Edits from other devices appear in
about a second. The connection is *unstable* on purpose: if the daemon crashed
while a stable one was held, Android would kill the app too.

**Background sync** uses JobScheduler. A periodic job runs about every 15
minutes when there is a network (Android's floor), and a one-off job is
scheduled after every write, so an edit made just before an app closes is
pushed as soon as possible. Both survive reboots. The optional **live sync**
switch runs a foreground service that syncs every 30 seconds. Android 15 caps
that at about six hours a day, after which the jobs take over.

**Encrypted rooms**: pass a key to `register`, and the server stores the room
without being able to read it (see `docs/03-sync-protocol.md`).

## Using it from an app

Add the `client` module (or copy `Rivulet.kt`; it has no dependencies). Its
manifest already declares the permission and the `<queries>` entry Android 11+
needs to see the provider.

```kotlin
val rivulet = Rivulet(context)

if (!rivulet.installed) { /* ask the user to install Rivulet Sync */ }
if (!rivulet.hasAccess) rivulet.requestAccess(activity)

// Off the main thread: these are calls into another process.
rivulet.register("notebook", mapOf(
    "notes" to mapOf("title" to "lww", "body" to "text", "pinned" to "boolean"),
))
val id = rivulet.create("notebook", "notes", mapOf("title" to "Groceries"))
rivulet.setText("notebook", "notes", id, "body", "milk, eggs")
val notes = rivulet.list("notebook", "notes", sort = "title")

val stop = rivulet.observe("notebook", "notes") { refresh() }   // local and remote changes
```

Field types: `lww` (last writer wins), `text` (character-level merge), `seq`,
`set` (add wins), `counter`, `mv` (keeps concurrent values), plus the aliases
`string`, `number`, `boolean` and `json`. A field's type cannot change once
data exists.

Several writes can go in one transaction with `mutate(room, Action.set(...),
Action.increment(...), ...)`.

## Build and run

Requires JDK 17+ and the Android SDK (platform 35, build-tools 35). Point
`local.properties` at the SDK (`sdk.dir=/path/to/Android/Sdk`).

```bash
cd apps/android
./gradlew assembleDebug        # daemon/build/outputs/apk/debug/daemon-debug.apk
                               # notes/build/outputs/apk/debug/notes-debug.apk
```

Start a sync server the emulator can reach. The emulator sees the host
machine as `10.0.2.2`, which is the daemon's default server:

```bash
npm run serve -- --open-schema --memory      # from the repository root
# or: docker compose up -d
```

Install both apps, open Notes, and allow access:

```bash
adb install -r daemon/build/outputs/apk/debug/daemon-debug.apk
adb install -r notes/build/outputs/apk/debug/notes-debug.apk
```

On a physical phone, set the server in Rivulet Sync's settings to your
machine's LAN address, or to a deployed https server.

### Exercising the provider from a terminal

Debug builds of the daemon accept calls from `adb shell`:

```bash
adb shell content call --uri content://dev.rivulet.sync.provider --method status \
  --extra args:s:'{}'
```

## Deploying the server

The repository root has a `Dockerfile` and `docker-compose.yml`. Put TLS in
front of the container, then set the server URL in Rivulet Sync's settings.
To require access tokens, run with `RIVULET_SECRET` set and
`RIVULET_FLAGS="--open-schema --room-tokens"`, issue a token covering an app's
rooms (`npm run token -- --room 'dev.rivulet.notes/*'`), and enter it in the
settings screen.

## Limits

- Every app's data lives in the daemon's storage. Uninstalling Rivulet Sync
  removes unsynced changes; synced ones are on the server.
- The WebView engine costs memory (about the same as one browser tab) while the
  daemon's process is alive. Android may kill it at any time; it restarts on
  the next call or job and reopens every room from storage.
- With no app open, sync is as frequent as Android allows: about every 15
  minutes, or every 30 seconds with live sync on. A write is pushed by a
  one-off job as soon as there is a network, app open or not.
- The emulator needs `-gpu swangle_indirect` for headless runs with emulator
  37.x; the default SwiftShader renderer crashed on start.
- One server for all rooms on the device, and one token. A token covering
  several apps' rooms needs a pattern such as `*` or a shared prefix.
