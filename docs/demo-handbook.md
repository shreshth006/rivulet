# Rivulet demo handbook

Step-by-step demos you can run on your own machine, each with the exact commands
and what you should see. They start with zero setup and build up to an Android
phone syncing with a laptop.

For *why* any of this works the way it does, see
[`review-guide.md`](review-guide.md).

| # | Demo | Needs | Time |
|---|---|---|---|
| 0 | [Install and run the tests](#0-install-and-run-the-tests) | Node 22.5+ | 2 min |
| 1 | [Two replicas, one partition](#1-two-replicas-one-partition-no-setup) | Node | 1 min |
| 2 | [The browser notebook](#2-the-browser-notebook) | Node + a browser | 5 min |
| 3 | [Encrypted rooms in the browser](#3-encrypted-rooms-in-the-browser) | Node + a browser | 3 min |
| 4 | [A durable Node client and the restart path](#4-a-durable-node-client-and-the-restart-path) | Node | 2 min |
| 5 | [The interactive REPL](#5-the-interactive-repl) | Node | 2 min |
| 6 | [Room-scoped access tokens](#6-room-scoped-access-tokens) | Node + curl | 3 min |
| 7 | [Rate limiting](#7-rate-limiting) | Node + curl | 1 min |
| 8 | [Reproduce the evaluation](#8-reproduce-the-evaluation) | Node | 2–10 min |
| 9 | [Run the server in Docker](#9-run-the-server-in-docker) | Docker or Podman | 3 min |
| 10 | [Android: the daemon and Rivulet Notes](#10-android-the-daemon-and-rivulet-notes) | Android SDK | 20 min first time |
| — | [A 10-minute run for a live review](#a-10-minute-run-for-a-live-review) | | |
| — | [Troubleshooting](#troubleshooting) | | |

Commands are for Linux or macOS. On Windows use WSL, or replace the
`VAR=value command` form with `set VAR=value` first.

---

## 0. Install and run the tests

**Needs:** Node.js **22.5 or newer** (`node --version`), for the built-in
`node:sqlite`. Nothing else: there are no dependencies to install.

```bash
git clone https://github.com/shreshth006/rivulet.git
cd rivulet
npm test          # the whole suite
npm run check     # every file parses, every import resolves, nothing orphaned
```

**You should see:** `ℹ tests 300` and `ℹ fail 0`, then
`checked 97 files: all parse, all imports resolve, none orphaned`.

> On Node 22.x before 23 you may see `ExperimentalWarning: SQLite is an
> experimental feature`. That's expected and harmless.

---

## 1. Two replicas, one partition (no setup)

Two clients and a server in one process, a link that gets cut, and concurrent
edits on both sides.

```bash
npm run example
```

**You should see:**

```
both replicas start from: "The wifi is down."
alice sees offline:       "The hostel wifi is down."
bob sees offline:         "The wifi is down again."
alice has queued:         8 operations

after reconciliation:
  body:  "The hostel wifi is down again."
  tags:  infra, urgent
  reads: 5 (2 + 3, summed rather than overwritten)
  identical on both replicas: true
```

**What it shows:** both people edited the same sentence while apart, and
*both* edits survived, character by character. Each added a different tag, and
both tags are kept. Each bumped a counter, and the increments add up (5, not 3).
Nobody was asked to resolve anything.

The source is `examples/two-replicas.js`, about eighty lines, and the best first
file to read.

---

## 2. The browser notebook

```bash
npm run demo
```

Open **http://127.0.0.1:8787** in **two browser windows side by side**. (Two
profiles, or one normal and one private window, give two separate replicas; two
tabs of the same profile share storage.)

**Try, in order:**

1. **Live sync.** Create a note in window A. It appears in window B.
2. **Offline editing.** In window A, click **Go offline**. Edit the *same
   note's body* in both windows: type at the start in A and at the end in B.
   Then click **Go online** in A. **You should see:** both edits merged, with
   nothing lost and no dialog.
3. **Rename conflict.** Go offline again and rename the note differently in
   each window, then go back online. **You should see:** one title wins, the one
   with the later timestamp, identically in both windows. A rename is atomic,
   so last-writer-wins is the right rule.
4. **Tags.** Offline, add a different tag in each window. **You should see:**
   both tags after reconnecting.
5. **Votes.** Offline, press **+** three times in A and twice in B. **You
   should see:** +5.
6. **Estimate (the "ask a human" type).** Offline, set *Estimate* to 900 in A
   and 950 in B. **You should see:** a conflict notice offering both values.
   Rivulet keeps both, because silently dropping a number is worse than asking.
7. **Survives a reload.** Go offline, make an edit, reload the page.
   **You should see:** the edit is still there, because it was saved locally
   first, and "pending" in the footer shows it is waiting to send.

The footer shows this replica's id, pending operations, local operations, the
**actual bytes sent and received** and the current batch size.

---

## 3. Encrypted rooms in the browser

With `npm run demo` still running:

1. Click **New encrypted room** in the header. The page reloads into a fresh
   room with a 🔒 badge. The address bar now ends in
   `#room=sealed-…&key=…`.
2. Click **Copy invite link** and open it in your second window. Create and
   edit notes; they sync between the windows as before.
3. **Check what the server stores.** Take the room name from the link (the
   `sealed-…` part) and pull its raw operations, as anyone with network access
   to the server could:

   ```bash
   ROOM=sealed-xxxxxxxxxxxx     # from your link
   curl -s -X POST -H 'content-type: application/json' \
     --data "{\"t\":\"sync\",\"pv\":1,\"node\":\"0123456789abcdef\",\"room\":\"$ROOM\",\"have\":{}}" \
     http://127.0.0.1:8787/v1/sync | head -c 600; echo
   ```

   **You should see:** the collection listed only as `"~"`, and payloads like
   `{"$e":"CNgoxL0S…"}`: ciphertext. Your note titles and text appear nowhere.
4. **Wrong key.** Edit the `key=` part of the link to anything else and open it.
   **You should see:** the status reads *cannot decrypt: wrong room key?*, and
   nothing from the room is shown.

The key is in the fragment (after `#`), which browsers never send to servers.
Sharing the link shares the key with exactly the people you send it to.

---

## 4. A durable Node client and the restart path

```bash
# terminal 1: a server. --open-schema because this client has its own schema;
# without it the server pins the browser demo's and answers 400.
npm run serve -- --memory --open-schema

# terminal 2: a client that keeps its state in example-client.sqlite
node --experimental-sqlite examples/node-client.js
node --experimental-sqlite examples/node-client.js     # run it again
```

**You should see:** the first run print `no local state; creating a note`, then
`synced: pushed 1`. The second run prints the **same replica id**,
`restored 1 note(s) from the local log`, and syncs again. A restart neither
forks the replica's identity nor replays old operation numbers, both of which
would corrupt history.

**Bonus, offline queueing:** stop the server and run the client. It reports
`server unreachable` and `… operation(s) queued`. Start the server again and
run it once more: the queue drains.

---

## 5. The interactive REPL

A local, offline database you can poke at:

```bash
npm run repl
```

```
create Groceries
list
append <id> milk, eggs
tag <id> errands
read <id>
stats
help
```

`list` and `stats` show the documents, the operation count and the storage
size.

---

## 6. Room-scoped access tokens

```bash
# terminal 1: require signed room tokens
export RIVULET_SECRET=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
npm run serve -- --memory --open-schema --room-tokens

# terminal 2: same secret, then issue tokens
export RIVULET_SECRET=<the same value as terminal 1>
ADMIN=$(npm run -s token -- --room '*' --scope admin)
READER=$(npm run -s token -- --room notebook --scope read --ttl 3600)

curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/v1/stats                                    # 403: no token
curl -s -o /dev/null -w '%{http_code}\n' -H "authorization: Bearer $READER" http://127.0.0.1:8787/v1/stats   # 403: read-only
curl -s -w '\n' -H "authorization: Bearer $ADMIN" http://127.0.0.1:8787/v1/stats                            # 200 + JSON
```

**You should see:** `403`, `403`, then the stats JSON.

The secret is read from the environment, never from the command line, because
command-line arguments are visible to other users in `ps`.

**Scopes:** `read` can pull and subscribe; `write` can also push; `admin` can
also use the inspection endpoints. A token can name a room exactly, by prefix
(`team-42/*`) or `*`, and can be bound to one replica and given an expiry.

---

## 7. Rate limiting

```bash
npm run serve -- --memory --open-schema --rate 1      # 1/s per replica, burst 8

# another terminal: 12 requests as fast as possible from one replica
for i in $(seq 12); do
  curl -s -o /dev/null -w '%{http_code} ' -X POST -H 'content-type: application/json' \
    --data '{"t":"sync","pv":1,"node":"a1b2c3d4e5f60718","room":"r","have":{}}' \
    http://127.0.0.1:8787/v1/sync
done; echo
```

**You should see:** `200` eight times, then `429`. A refused request carries a
`retry-after` header (`curl -si … | grep -i retry-after`), and Rivulet clients
wait at least that long before retrying.

The defaults, without `--rate`, are 5/s per replica with bursts of 40, and a
deliberately loose 125/s per IP address, because shared NATs put many honest
users behind one address.

---

## 8. Reproduce the evaluation

```bash
npm run bench -- --help             # list the scenarios
npm run bench -- bandwidth           # bytes per operation, ablation, encryption cost
npm run bench -- latency             # convergence time on six simulated links
npm run bench -- partition           # four replicas offline; every edit checked
npm run bench -- scale               # 2 to 32 replicas, idle-sync cost
npm run bench -- overhead            # tombstones, collection, snapshot sizes
npm run bench                        # all of them, one after another (several minutes)
```

Everything runs on a network simulator with a fixed seed, so the numbers match
`bench/results/` exactly. **What to look for:**

- **bandwidth:** typing costs about 22 bytes per operation against 210 for
  plain JSON, and the ablation table shows back-references matter most.
- **latency:** 2.21× faster on the 128 kbps "mobile-edge" link, but only 1.01×
  on a LAN. That spread is the honest result.
- **partition:** `Lost 0` and `Correct yes` on every row.

> Running a single scenario with `--out bench/results` rewrites
> `bench/results/README.md` with just that scenario. Use `npm run bench:all` to
> regenerate everything.

---

## 9. Run the server in Docker

```bash
docker build -t rivulet-server .                    # or: podman build ...
docker run --rm -p 8787:8787 -v rivulet-data:/data rivulet-server

curl -s http://127.0.0.1:8787/v1/health             # {"ok":true,"node":"…"}
```

Or with compose, optionally requiring tokens:

```bash
docker compose up -d
RIVULET_SECRET=$(openssl rand -hex 32) RIVULET_FLAGS="--open-schema --room-tokens" docker compose up -d
```

In real deployments, put TLS in front (a reverse proxy or your platform's
https).

---

## 10. Android: the daemon and Rivulet Notes

**Rivulet Sync** is a background daemon that gives any Android app
offline-first synced storage. **Rivulet Notes** is an example app built only on
it. This demo runs both on an emulator and syncs them with your laptop.

### 10.1 One-time setup

**Needs:** JDK 17 or 21, and the Android SDK. Android Studio installs the SDK;
or, with only the command-line tools:

```bash
export ANDROID_HOME=$HOME/Android/Sdk
# Unpack Google's command-line tools to $ANDROID_HOME/cmdline-tools/latest, then:
yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses
$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager \
  "platform-tools" "platforms;android-35" "build-tools;35.0.0" \
  "emulator" "system-images;android-35;google_apis;x86_64"
echo no | $ANDROID_HOME/cmdline-tools/latest/bin/avdmanager create avd \
  -n rivulet -k "system-images;android-35;google_apis;x86_64" -d pixel_6
```

That's about 3 GB. On Linux the emulator needs KVM (`ls /dev/kvm`).

### 10.2 Build

```bash
cd apps/android
echo "sdk.dir=$ANDROID_HOME" > local.properties
./gradlew assembleDebug
```

**You should see** two APKs:
`daemon/build/outputs/apk/debug/daemon-debug.apk` and
`notes/build/outputs/apk/debug/notes-debug.apk`.

### 10.3 Start a server and the emulator

```bash
# terminal 1, from the repository root. --open-schema because the daemon
# hosts rooms for any app, each with its own schema.
npm run serve -- --open-schema --memory

# terminal 2
$ANDROID_HOME/emulator/emulator -avd rivulet -gpu swangle_indirect
```

The emulator reaches your computer as **10.0.2.2**, which is the daemon's
default server. Wait for the home screen, then install both apps:

```bash
ADB=$ANDROID_HOME/platform-tools/adb
$ADB install -r daemon/build/outputs/apk/debug/daemon-debug.apk
$ADB install -r notes/build/outputs/apk/debug/notes-debug.apk
```

### 10.4 The walkthrough

1. **Consent.** Open **Rivulet Notes**. It says it stores notes with Rivulet
   Sync and offers **Allow access**. Tap it; Android's own dialog asks
   "Allow Rivulet Notes to keep its data available offline and synced with
   Rivulet Sync?". Tap **Allow**. The header reads *0 notes · synced*.
2. **Phone → laptop.** Tap **New**, type a title, tap into the body and type a
   sentence, then go back. From the repository root on your computer:

   ```bash
   node --experimental-sqlite examples/android-companion.js list
   ```

   **You should see** the note you typed on the phone.
3. **Laptop → phone, live.** Leave Notes open on the list and run:

   ```bash
   node --experimental-sqlite examples/android-companion.js add "From the laptop" "nobody tapped sync"
   ```

   **You should see** it appear on the phone within about a second, without
   touching it.
4. **Merging.** On the laptop, append to the phone's note (use the id prefix
   from `list`):

   ```bash
   node --experimental-sqlite examples/android-companion.js append <id-prefix> " Added on the laptop."
   ```

   The phone's note body now ends with that sentence, merged into the text, not
   replaced.
5. **Offline on the phone.** Turn the network off:

   ```bash
   $ADB shell svc wifi disable; $ADB shell svc data disable
   ```

   Create a note in Notes. **You should see** it saved at once, with the header
   reading *… · 2 to send*.
6. **Background push, app closed.** Close Notes completely, then restore the
   network:

   ```bash
   $ADB shell am force-stop dev.rivulet.notes
   $ADB shell svc wifi enable; $ADB shell svc data enable
   node --experimental-sqlite examples/android-companion.js watch
   ```

   **You should see** the offline note arrive on the laptop within about 15
   seconds, pushed by the daemon's background job with no app open.
7. **The daemon's own screen.** Open **Rivulet Sync** from the launcher: the
   server address, an optional token, the **Live sync** switch and every app's
   rooms with their status.

### 10.5 Optional: privacy and encryption from the terminal

Debug builds of the daemon accept calls from `adb shell`, which acts as a
separate "app" (`com.android.shell`):

```bash
c() { $ADB shell "content call --uri content://dev.rivulet.sync.provider --method $1 --arg '$2'"; }

# Another app cannot read Notes' rooms, by name or by URI:
c list '{"room":"notebook","collection":"notes"}'                                   # "not registered"
$ADB shell content query --uri content://dev.rivulet.sync.provider/dev.rivulet.notes/notebook/notes   # SecurityException

# An end-to-end encrypted room:
KEY=$(node --input-type=module -e "import('./src/protocol/seal.js').then(m => console.log(m.generateRoomKey()))")
c register "{\"room\":\"vault\",\"schema\":{\"secrets\":{\"text\":\"lww\"}},\"key\":\"$KEY\"}"
c mutate '{"room":"vault","actions":[{"op":"create","collection":"secrets","values":{"text":"the wifi password is hunter2"}}]}'
c list '{"room":"vault","collection":"secrets"}'                                     # readable on the device

# ...but not on the server:
curl -s -X POST -H 'content-type: application/json' \
  --data '{"t":"sync","pv":1,"node":"0123456789abcdef","room":"com.android.shell/vault","have":{}}' \
  http://127.0.0.1:8787/v1/sync | grep -c hunter2                                    # 0
```

### 10.6 Using a real phone

Set **Sync server** in Rivulet Sync to your computer's LAN address (for example
`http://192.168.1.20:8787`) and start the server with `--host 0.0.0.0`. The
app's network security config only permits plain http to `10.0.2.2` and
`localhost`, so either add your LAN address to
`apps/android/daemon/src/main/res/xml/network_security_config.xml` and rebuild,
or deploy the server behind https (§9), which needs no change.

---

## A 10-minute run for a live review

| Minute | Do | Point to make |
|---|---|---|
| 0–1 | `npm test` | 300 tests, zero dependencies. |
| 1–2 | `npm run example` | Concurrent offline edits all survive; counters add up. |
| 2–5 | Browser demo (§2): two windows, go offline, edit the same body in both, reconnect | No conflict dialog; character-level merge. Show the *wire* bytes in the footer. |
| 5–6 | §2 step 6, the estimate conflict | Where a human must choose, Rivulet keeps both values and asks. |
| 6–7 | Encrypted room (§3), then the `curl` | The server stores only ciphertext. |
| 7–9 | Android (§10.4 steps 3 and 5–6), prepared beforehand | Live laptop → phone in a second; offline write pushed in the background with the app closed. |
| 9–10 | `bench/results/README.md`, the latency table | 2.21× on 128 kbps, 1.01× on LAN: where it matters and where it doesn't. |

Prepare the Android part in advance: build, boot the emulator, install, and
grant access. Booting cold takes a minute or two.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Cannot find module 'node:sqlite'` or `No such built-in module` | Node is older than 22.5. Upgrade (`nvm install 22`). |
| `ExperimentalWarning: SQLite…` | Expected on some Node versions; harmless. |
| `EADDRINUSE :8787` | Something is already on the port. Stop it, or use `--port 8788` and adjust URLs. |
| Browser: edits don't appear in the other window | Two tabs of the same profile share storage and look like one replica. Use two profiles or a private window. |
| Browser: "Encrypted rooms need a secure context" | WebCrypto requires https or `localhost`/`127.0.0.1`. Open the demo via `127.0.0.1`, not a LAN IP. |
| Client status `unauthorised` | Wrong or missing token, a read-only token used to write, or (in an encrypted room) the wrong key. It won't retry by itself; fix the credential and sync. |
| `429` responses | Rate limited, as intended. Wait for `retry-after`, or start the server with `--no-rate-limit` for experiments. |
| Android: `./gradlew` says SDK location not found | Create `apps/android/local.properties` with `sdk.dir=…` (§10.2). |
| Android: emulator exits immediately (segfault) | Use `-gpu swangle_indirect`. With emulator 37.x the default SwiftShader renderer crashed in testing. Headless: add `-no-window`. |
| Android: Notes says "Rivulet Sync is not installed" | Install `daemon-debug.apk` first, or reinstall Notes after it. |
| Android: nothing syncs | The server must run with `--open-schema` and listen where the emulator can reach it (`10.0.2.2:8787` is your computer's `127.0.0.1:8787`). Check the daemon's log: `adb logcat -s RivuletEngine RivuletSync`. |
| Android: laptop edits arrive only after a delay | Live updates need Notes on screen (it keeps the daemon awake and on the network). With no app open, Android allows background sync about every 15 minutes; turn on **Live sync** in Rivulet Sync for always-on. |
| `adb shell content call` prints usage and "Binding not well formed" | Pass JSON with `--arg '…'`, not `--extra`; `content` cannot parse JSON in extras. |
