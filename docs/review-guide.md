# Rivulet: project review guide

Everything about the project in one place: the problem, the design from the
ground up, why each decision was made, what was built and when, how it was
verified, what the numbers are, and what it still does not do. Written to
prepare for a review.

**How to read it**

| You have | Read |
|---|---|
| 1 minute | [§1 The pitch](#1-the-pitch) |
| 10 minutes | §1–§3, then [§10 Results](#10-results-in-numbers) and [§12 Limitations](#12-limitations-stated-plainly) |
| An hour before the review | Everything, then [§14 Questions a reviewer will ask](#14-questions-a-reviewer-will-ask) |
| A machine to try it on | [`demo-handbook.md`](demo-handbook.md) |

Deeper material lives elsewhere and is linked where relevant: the paper
(`paper/paper.md`), the end-to-end walkthrough (`docs/00-how-it-works.md`), the
design documents (`docs/01`–`09`), the decision records (`docs/adr/`) and the
generated benchmark results (`bench/results/`).

---

## Contents

1. [The pitch](#1-the-pitch)
2. [The problem](#2-the-problem)
3. [Goals and non-goals](#3-goals-and-non-goals)
4. [The design, from the ground up](#4-the-design-from-the-ground-up)
5. [A keystroke's journey](#5-a-keystrokes-journey)
6. [Phase 2: closing the limitations](#6-phase-2-closing-the-limitations)
7. [Phase 3: Rivulet on Android](#7-phase-3-rivulet-on-android)
8. [Bugs found, and how](#8-bugs-found-and-how)
9. [How correctness is verified](#9-how-correctness-is-verified)
10. [Results in numbers](#10-results-in-numbers)
11. [Decision log](#11-decision-log)
12. [Limitations, stated plainly](#12-limitations-stated-plainly)
13. [Timeline and contributions](#13-timeline-and-contributions)
14. [Questions a reviewer will ask](#14-questions-a-reviewer-will-ask)
15. [Glossary](#15-glossary)
16. [Where things are](#16-where-things-are)

---

## 1. The pitch

**Rivulet is an offline-first database that synchronises over networks that
barely work.**

Every write lands in local storage and returns immediately. There is no network
call in the path of a keystroke and no error to handle when offline. When the
network allows, replicas reconcile in a single round trip, and concurrent edits
merge automatically by *conflict-free replicated data types* (CRDTs). No server
decides, and no user is shown a "sync conflict" dialog.

The data structures are standard. The contribution is the **transport** that
carries them over bad links:

- a columnar operation codec that cuts a keystroke from **210 bytes to 22**,
  and stays 31–44% smaller than simply gzipping the naive encoding
- a **one-round-trip, resumable, idempotent** sync protocol
- a batch-size controller that tells congestion apart from packet loss.

Around that engine the project now has room-scoped access tokens, end-to-end
encryption, rate limiting, compact snapshots, and an **Android background
daemon** that gives any Android app offline-first synced storage.

It has **zero runtime dependencies** and runs in Node and the browser from the
same source. There are 300 automated tests.

---

## 2. The problem

### The networks people actually use

A shared access point in a hostel at nine in the evening. Mobile data at the
edge of coverage, with half-second round trips and a few percent packet loss. A
metered connection where every byte costs money. A train tunnel that removes the
network for minutes.

### Why the usual architecture fails there

Most apps work as *request, wait, render*. On a bad link that means:

- **The UI stalls** on a spinner. If the link is merely poor it stalls
  intermittently, which is worse, because the user cannot tell whether their
  work was saved.
- **Writes get lost or doubled.** If a request went out but the response was
  lost, the client does not know whether to retry. Retrying may apply the change
  twice, and not retrying may drop it.
- **Every byte is expensive.** Verbose JSON payloads cost time on a slow link
  and money on a capped one.

### Offline is easy; converging is the hard part

Making an app work offline is mostly a caching problem. The hard part is what
happens when **several people edited the same thing while apart**. The common
answers all lose data or push the problem onto the user:

| Approach | What goes wrong |
|---|---|
| Last-write-wins on a timestamp | Device clocks are wrong; a phone five minutes fast wins every conflict. Concurrent edits to *different* fields of a record are destroyed. |
| "Sync conflict" copy of the file | The user has to merge by hand, and usually doesn't. |
| A merge dialog | The user is asked a question they cannot answer well, at the worst moment. |

Rivulet's position: **the merge should be settled by the data structure,
decided once per field by whoever designed the feature, and then never surfaced
again**, except where a human genuinely has to choose.

---

## 3. Goals and non-goals

**Goals**

1. A write is local, synchronous and durable. The network is never in the
   critical path.
2. Replicas that have seen the same operations agree, whatever the order,
   duplication or partitioning of delivery.
3. One round trip per reconciliation. Interrupted transfers resume, and every
   retry is safe.
4. Frugal on the wire, because bytes are time and money on the target networks.
5. Honest about conflicts: silent and correct where possible, surfaced where a
   human must choose.
6. No dependencies, so it still runs in five years.

**Non-goals**

- Competing with Automerge or Yjs on CRDT engineering. Their data structures
  are more optimised; this project's contribution is the transport.
- Documents shared by hundreds of thousands of people. Metadata is per replica
  (§12).
- Intent-level merging of prose. No CRDT can know that two people rewrote the
  same sentence to mean different things.

---

## 4. The design, from the ground up

```
                    ┌───────────────────────────┐
  your code  ─────▶ │      RivuletClient        │   identity, restart recovery,
                    │  mutate / get / subscribe │   write queue
                    └─────────┬─────────┬───────┘
              ┌───────────────▼──┐   ┌──▼───────────────┐
              │    Database      │   │   SyncEngine     │  batching, backoff,
              │ documents of     │   │ one round trip   │  live stream, status
              │ CRDT fields      │   │ per sync         │
              └────────┬─────────┘   └──┬───────────────┘
              ┌────────▼─────────┐   ┌──▼───────────────┐
              │     OpLog        │   │    Protocol      │  codec, messages,
              │ exactly-once,    │   │ encode / decode  │  framing, sealing
              │ frontier, outbox │   └──┬───────────────┘
              └────────┬─────────┘   ┌──▼───────────────┐
              ┌────────▼─────────┐   │   Transport      │
              │ StorageAdapter   │   │ HTTP+SSE /       │
              │ memory / SQLite  │   │ loopback / sim   │
              │ / IndexedDB      │   └──────────────────┘
              └──────────────────┘
```

**The two columns never talk to each other.** `Database` has never heard of a
network, and `SyncEngine` has never heard of SQLite. That separation is what
lets the benchmarks swap in a simulated link and a naive codec without touching
anything else.

Each layer is described below as *what it is → why → how*.

### 4.1 Hybrid logical clocks (`src/core/hlc.js`)

- **What:** every operation gets a timestamp: 12 hex digits of wall-clock
  milliseconds, a 4-hex-digit counter, and the replica id.
- **Why:** plain wall-clock time breaks last-writer-wins when clocks are skewed,
  and a pure Lamport counter drifts away from real time, which makes timestamps
  useless for "edited 5 minutes ago" and for debugging. A hybrid logical clock
  respects causality and stays close to real time.
- **How:** it takes the maximum of the local clock and any observed timestamp,
  and bumps the counter on ties. A fixed-width string means plain string
  comparison *is* timestamp comparison, so SQLite and IndexedDB can sort it
  without a custom collation. Remote timestamps more than 60 s ahead are
  rejected (`ClockDriftError`). On restart the clock resumes past the highest
  timestamp ever issued.

### 4.2 CRDTs, chosen per field (`src/core/crdt/`)

- **What:** five types, declared per field in the schema.

| Type | Concurrent A and B | Result |
|---|---|---|
| `lww` (last writer wins) | rename to "X" / rename to "Y" | later timestamp wins |
| `text` / `seq` (RGA sequence) | insert "hostel" / append "again" | both survive, character by character |
| `set` (observed-remove set) | add "urgent" / remove "draft" | both applied; a remove only deletes what it saw, so adds win |
| `counter` (PN-counter) | +2 / +3 | **5**, summed, not overwritten |
| `mv` (multi-value register) | set 900 / set 950 | **both kept**; the UI offers a choice |

- **Why per field:** a record is not one thing. Two people editing *different
  fields* of the same note should never conflict, and with per-field CRDTs they
  don't. Within a field, the merge rule is a product decision ("is a rename
  atomic?", "should a remove beat a concurrent add?"), so the schema makes it
  once (ADR 0001).
- **How:** each type implements `apply(op)`, `merge(state)` and `toJSON()`.
  The sequence type (RGA) is the subtle one. Each character names the one it was
  inserted after, and concurrent inserts at the same spot are ordered by
  timestamp. Deleted characters stay as *tombstones* until it is provably safe
  to collect them.

### 4.3 The database: the local-first boundary (`src/core/database.js`)

- **What:** collections of documents whose fields are CRDTs, plus a transaction
  API (`create`, `set`, `setText`, `add`, `remove`, `increment`, `delete`, ...).
- **Why:** this is where "a write is local and synchronous" is enforced. A
  transaction applies to memory *and* produces operations for sync in the same
  call.
- **How:** `setText` takes the whole new value and recovers the edit with a
  diff, so binding a text box is one line and still produces one operation per
  keystroke. Deletes are soft (a `__deleted` field), so a delete can propagate
  and a concurrent edit can still land (ADR 0006). Queries support `$gt`, `$in`,
  `$regex` and similar operators, along with sorting and projection.

### 4.4 The operation log: exactly-once and a truthful frontier (`src/storage/oplog.js`)

- **What:** the durable list of every operation, keyed by `(replica, seq)`.
- **Why:** three guarantees live here, and getting them wrong silently loses
  data.
  1. **Exactly-once to the CRDTs.** The log returns only *new* operations, so
     no CRDT keeps its own seen-set. This is what allows a PN-counter, which
     cannot be idempotent, to exist at all (ADR 0004).
  2. **A truthful frontier.** A replica holding `{1..20, 27..42}` advertises
     **20**, not 42. Claiming 42 would tell peers it has 21–26, and those would
     never be resent.
  3. **An outbox derived from one watermark**, advanced only when the server
     *proves* it stored the operations (`ack.you`), so a partly accepted push
     retries exactly the missing part.
- **How:** ranges are tracked with a `RangeSet` that compacts to O(1) per
  replica in steady state.

### 4.5 Storage adapters (`src/storage/`)

The same contract has three implementations: memory (tests), SQLite through the
built-in `node:sqlite` (server and Node clients) and IndexedDB (browsers and
the Android daemon). A shared conformance suite runs against all of them.
IndexedDB is used because it is the only browser store that is both durable and
large enough; `localStorage` caps at about 5 MB and is synchronous.

### 4.6 The protocol: one round trip, resumable, idempotent (`src/protocol/messages.js`)

- **What:** a `sync` message carries the client's frontier *and* its pending
  operations. The `ack` carries the acknowledgement *and* everything the client
  is missing.
- **Why:** on a 400 ms round trip, a protocol that asks, waits, sends, waits and
  then pulls has spent over a second before any data moves.
- **How:**
  - **Resumable:** a large pull is paged (`more: true`), and the frontier
    doubles as the cursor. A connection that dies mid-transfer resumes exactly
    where it stopped, with no server-side session to lose.
  - **Idempotent:** an operation the server already holds is counted and
    ignored, so the client can resend freely after a timeout.
  - **Safe against forgery:** the server only accepts operations attributed to
    the replica that sent them.
  - **Vector deltas (Phase 2, §6.3):** frontiers are sent as differences
    against a version the server numbered.

### 4.7 The codec: where the bandwidth goes (`src/protocol/codec.js`)

As plain JSON, one keystroke is about 210 bytes, and almost none of it is the
keystroke. The codec applies four transformations, each attacking a different
kind of redundancy:

1. **Dictionary interning:** collection, document and field names become small
   integers.
2. **Columnar layout and run-length encoding:** like values sit together and
   collapse into runs.
3. **Derived and delta-encoded causality:** the replica id inside each
   timestamp is dropped because the replica column already has it, and the rest
   is delta-encoded. Sequence numbers are almost always "+1".
4. **In-batch back-references:** "inserted after character X" becomes a small
   integer when X is in the same batch, which it nearly always is when typing.

Then DEFLATE. Every transformation is individually switchable, so the
evaluation measures each one's contribution by ablation (§10). Only structural
keys are rewritten; application values are never touched.

### 4.8 Transport: HTTP plus Server-Sent Events (`src/server/http.js`, `src/client/transport.js`)

- **Why not WebSockets:** sync is client-initiated (a sync *is* a request), so
  a socket would only add server-to-client push. Server-Sent Events do that over
  plain HTTP, and survive the proxies and captive portals that break WebSocket
  upgrades on exactly the networks this targets (ADR 0003).
- **The stream is a hint, not a delivery (ADR 0007):** it only says "something
  changed", and the client pulls through the normal path. A stream that silently
  dies costs latency and never data.

### 4.9 Adaptive batching (`src/client/adaptive.js`)

How many operations go in one request? Too few on a satellite link wastes round
trips; too many on a lossy link means every request times out. The controller
grows the batch on success and shrinks it only on *timeouts*. A dropped packet
or an unreachable server says nothing about size, and treating them as
congestion once drove a 5%-loss link to hundreds of round trips. It remembers
the size that genuinely failed and approaches it gently.

### 4.10 The server (`src/server/engine.js`)

The server is **not authoritative about content**. It never merges and never
resolves a conflict. It holds the union of everyone's operations, answers "what
am I missing?" cheaply and pushes change notifications. In effect it is a
replica that never writes. If it loses its disk, availability stops but data
does not, because every client still holds its own operations. Each room is its
own SQLite file.

---

## 5. A keystroke's journey

1. The app calls `mutate(tx => tx.setText('notes', id, 'body', newText))`.
2. A diff recovers "insert `w` after character X"; the RGA applies it **in
   memory, now**, and the UI re-renders.
3. The operation, stamped with an HLC timestamp and the next sequence number, is
   queued to the durable log.
4. A sync round starts after a short debounce. The engine reads the outbox and
   the frontier.
5. The codec packs the batch, and DEFLATE compresses it if that pays.
6. One POST to `/v1/sync`. The server validates the batch, rejects operations
   attributed to another replica, appends the rest (duplicates are ignored),
   computes what the client lacks and answers in the same response.
7. The client advances its outbox watermark to exactly `ack.you`, applies only
   genuinely new incoming operations, and re-renders.
8. The server sends every other connected client a one-line "something changed"
   over the stream, and each pulls.

The long version, stage by stage with file references, is
`docs/00-how-it-works.md`.

---

## 6. Phase 2: closing the limitations

The original README listed the project's limitations honestly. Phase 2 worked
through them one at a time. Each item below follows the same shape:
**problem → why it mattered → what we did → result**.

### 6.1 Compact snapshots (`src/core/snapshot.js`)

- **Problem:** a snapshot (the compacted state a new device downloads instead
  of the whole history) stored every 34-character timestamp and field name in
  full. Uncollected, it was 0.2–16% *larger* than the encoded log it was meant
  to replace. The paper called this "the single clearest piece of unfinished
  work".
- **What we did:** applied the codec's ideas to state. There is one timestamp
  table, columnar and run-length encoded, referenced by index; field names are
  listed once per collection; and sequences are stored as columns. Because an
  RGA is written in document order, its element ids are consecutive table
  indices, and their deltas collapse to a single run. Application values are
  never rewritten.
- **Result:** an uncollected snapshot is now **77–78% smaller** than the
  encoded log, and a collected one is 69–72% smaller than before. Old (version
  1) snapshots still load.

### 6.2 Room-scoped access tokens (`src/server/tokens.js`)

- **Problem:** auth was one bearer token for the whole deployment, so anyone
  who could sync anything could sync everything. Reviewing it also turned up
  real gaps: `/v1/stats` (which lists every room) and `/v1/room` were open even
  with a token set, the live stream skipped the per-room check, and the token
  comparison was not constant-time.
- **What we did:** added stateless HMAC-SHA256 tokens naming a room (exactly,
  by prefix like `team-42/*`, or `*`), with a scope of `read`, `write` or
  `admin`, optional binding to one replica and an optional expiry. The engine's
  authorisation hook now sees the action, whether the request writes, and the
  credential, and is consulted for streams and inspection endpoints too.
- **Result:** a read-only follower can pull and subscribe but not push. The
  stats endpoints need admin, and the deployment token is compared in constant
  time. CLI: `serve.js --room-tokens` and `npm run token`.

### 6.3 Vector deltas (`src/protocol/messages.js`)

- **Problem:** every sync carried the whole version vector, one entry per
  replica that ever wrote, and every reply echoed the server's. So even an idle
  poll grew with how widely a room was shared: 401 bytes at 32 replicas.
- **What we did:** the server numbers the frontiers it reports (`hv`). A client
  sends back the last one it saw (`bv`) along with only the entries that
  differ, and the reply is a delta against the same base. The server keeps the
  last 256 frontiers per room in memory. An unknown base (after a restart, or
  for a client that slept through many writes) gets the full vector and a retry,
  costing one round trip and never correctness.
- **Result:** an idle round is flat at about **190 B up and 116 B down at any
  replica count**, against 514 B for a full-vector request at 32 replicas.
  Total traffic in the 32-replica benchmark fell 21%. Old clients and servers
  still interoperate.

### 6.4 End-to-end encryption (`src/protocol/seal.js`)

- **Problem:** the server saw plaintext.
- **What we did, take 1:** sealed each operation separately with AES-256-GCM.
  The benchmark showed this cost **8–24× the bytes**, because ciphertext does
  not compress and each operation carried its own nonce and tag. For a project
  whose point is bandwidth, that was unacceptable.
- **What we did, take 2 (shipped): sealed runs.** Each push's operations are
  encoded by the codec, compressed and *then* encrypted once. The ciphertext
  rides on the run's **last** operation, and the others carry a tiny `$r`
  pointer to it. It is the last operation, not the first, because a retried push
  can repeat the start of a run the server already stored, and those operations
  are dropped as duplicates; the last operation of a retry is always new. When a
  pull page stops part-way through a run, the server adds the run's last
  operation to the page. That pointer is the only thing inside a payload the
  server ever reads.
- **What is protected:** the room, replica, sequence range and timestamp are
  authenticated. Tampered, renumbered, replayed-into-another-room or unencrypted
  operations are refused, and a client with the wrong key stops as
  `unauthorised` without applying anything.
- **Result:** **1.3–1.75× the bytes of plaintext**, and still 85–93% smaller
  than plain JSON.

### 6.5 Rate limiting (`src/server/rate-limit.js`)

- **Problem:** a misbehaving client could sync in a tight loop.
- **What we did:** a token bucket per replica per room (5/s, bursts of 40),
  plus a deliberately loose one per IP address (125/s, bursts of 1000). Hostel,
  campus and mobile NATs put many honest people behind one address, so the
  per-IP bucket exists only to stop one client evading the replica limit by
  minting new ids. Limits are checked before authorisation or any room work.
  Refusals are HTTP 429 with `Retry-After`, and clients wait at least that long.
- **Result:** on by default in the CLI (`--rate`, `--no-rate-limit`).

### 6.6 Demo: encrypted rooms from a link

"New encrypted room" in the browser demo creates a room whose name and key live
in the link's `#fragment`, which browsers never send to the server. Sharing the
link shares the key with exactly the people it is sent to.

---

## 7. Phase 3: Rivulet on Android

### 7.1 What was asked, and what we built

The goal was a **background daemon on Android that helps other apps**, with a
notes app as the fallback if that proved impossible. Both were built:

- **Rivulet Sync** (`apps/android/daemon`): the daemon. Any app with the user's
  permission can register a room with its schema, then read and write. Rivulet
  Sync keeps the data on the phone, merges concurrent edits and syncs in the
  background, including after the app closes.
- **`client`** (`apps/android/client`): a one-class library (`Rivulet`) apps
  use to talk to the daemon.
- **Rivulet Notes** (`apps/android/notes`): an example app built *only* on that
  library, with no networking or storage code of its own and not even the
  INTERNET permission.

### 7.2 The key decision: how to run the engine on Android

| Option | Verdict |
|---|---|
| Rewrite the engine in Kotlin | Weeks of work, and a second engine that drifts from the one the tests cover. |
| React Native / an embedded JS engine | No IndexedDB, no WebCrypto, no CompressionStream: everything the engine relies on would need bridging. |
| **The engine's own JS in an off-screen WebView** ✔ | All three APIs are built in. The engine is copied from `src/` at build time, unmodified. |

The page is served from `https://appassets.androidplatform.net`, a secure
origin (which WebCrypto requires) answered entirely from the APK's assets, so
nothing leaves the device.

### 7.3 How other apps use it

A **ContentProvider**, Android's standard interface for one app serving data to
others, at `content://dev.rivulet.sync.provider`.

- **Writes** go through `call()` with JSON, because Rivulet writes ("insert
  these characters", "add this tag", "increment by two") do not fit
  ContentValues rows.
- **Reads** also work through `query()`, so Cursors and ContentObservers behave
  the way Android developers expect.
- **Privacy:** rooms are namespaced by the calling package
  (`dev.rivulet.notes/notebook`), and a URI naming another package is refused.
- **Consent:** apps need `dev.rivulet.permission.ACCESS`, a *runtime*
  permission, so Android asks the user. The provider checks it in code on every
  entry point.
- **Discovery:** Android 11+ hides other apps' providers, so the client
  library's manifest declares the daemon in `<queries>`.

### 7.4 Background behaviour, and what Android allows

- **No app open:** JobScheduler runs a periodic job (about every 15 minutes,
  Android's floor) and a one-off job after every write. So an edit made just
  before an app closes is pushed as soon as there is a network. Both survive
  reboots.
- **App open:** Android 14+ cuts the network of background processes and
  destroys their sockets, which killed the daemon's live stream (found on the
  emulator, §8). The client library therefore holds a connection to the
  daemon's provider while an app is observing data. Android ranks a provider's
  process by its clients, so the daemon becomes as important as the app on
  screen and keeps its network. The connection is *unstable* on purpose: if the
  daemon crashed while a *stable* connection was held, Android would kill the
  app too.
- **Always-on:** an optional "Live sync" foreground service syncs every 30 s.
  Android 15 caps that at about six hours a day, after which the jobs take over.

### 7.5 Verified on an Android 15 emulator

| Scenario | Result |
|---|---|
| Permission | System dialog shown; Notes works after "Allow" |
| Phone → laptop | Note typed on the phone visible on a laptop client |
| Laptop → phone, live | Appeared on the phone's screen **within one second**, untouched |
| Offline write | Saved instantly with no network; "2 to send" shown |
| Background push | With Notes closed, pushed **~12 s** after the network returned |
| Isolation | Another caller refused, by room name and by URI |
| Encrypted room | Works on device; the server holds only ciphertext (`~` collection, no plaintext anywhere) |

Deployment: a `Dockerfile` and `docker-compose.yml` for the server, built and
smoke-tested.

---

## 8. Bugs found, and how

These are worth raising in a review: they show what the verification actually
caught.

| Bug | How it was found | Fix |
|---|---|---|
| **A batch listing the same operation twice applied it twice** (a counter could double-count). Existed in the original engine. | A randomized stress test of encrypted rooms diverged on 25 of 200 seeds; traced to `OpLog.append`. | De-duplicate within the batch too. A regression test fails without the fix. |
| **Live updates never reached an idle client.** A stream nudge waited behind the pending idle poll. Existed in the original engine; the browser demo only *looked* live because it polls every 10 s. | Testing live sync on the Android emulator. | A sooner sync request now replaces a later one. |
| **A dropped stream was never reopened**, and a client that started offline never opened one. | Same. | Reopen with backoff, sync on reopening, open after the first successful sync. |
| **An `unauthorised` client was pulled back into syncing** by its own nudges. | The fix above made an existing test intermittently fail; traced rather than retried. | Automatic rounds stand down; the app's explicit `sync()` still runs. |
| **Per-operation encryption cost 8–24×.** | The bandwidth benchmark, before shipping. | Sealed runs (§6.4). |
| **Android 14+ destroyed the daemon's sockets.** | Emulator logs: `Destroyed live tcp sockets for uids={…}`. | Hold an unstable provider connection while observing (§7.4). |
| **A room opened twice concurrently** on the daemon (two engines on one store). | Status reported two different replica ids. | Track in-flight opens; a test opens three at once. |
| `/v1/stats` and `/v1/room` open with auth configured. | Reading the auth code while adding tokens. | Gated behind the deployment token or an admin token. |

---

## 9. How correctness is verified

| Layer | What |
|---|---|
| **Unit and integration tests** | 300 tests on `node:test`, covering every module, all three storage backends (shared conformance suite), real HTTP servers, the cluster harness and the CLI paths. |
| **CRDT laws** | Property tests generate random operations and deliver them to independent replicas in shuffled orders, asserting convergence, commutativity, idempotence and snapshot/replay parity. A failing seed prints and replays exactly. |
| **Fuzzing** | Chaotic multi-replica partitions and corrupted payloads (`test/fuzz.test.js`). |
| **Partition benchmark** | Four replicas edit entirely offline; every edit with a defined survival requirement is checked individually after reconnection: **792 of 792 survived, in every run**. |
| **Randomized stress** | 600 seeds of random writers, small pages, dropped requests, lost replies and server restarts, with and without encryption: all converged. The harness was itself checked by deliberately breaking the server, which made all 200 seeds diverge. |
| **Regression discipline** | Each fix in §8 has a test confirmed to fail on the old code. |
| **Device** | End-to-end on an Android 15 emulator (§7.5). |
| **CI** | GitHub Actions runs the suite on every push. |

Convergence is **checked, not proven**: strong evidence, but not a mechanised
proof. The CRDT types themselves are standard, with published correctness
arguments.

---

## 10. Results in numbers

All network figures come from the simulator in `bench/netsim` (simulated time,
reproducible by seed). Full tables are in `bench/results/README.md`.

**Bytes per operation**

| Workload | Plain JSON | Codec | Codec + DEFLATE | vs gzipped JSON |
|---|--:|--:|--:|--:|
| typing | 210 B | 22.1 B | 5.4 B | −44% |
| form-filling (worst case) | 174 B | 36.0 B | 12.0 B | −31% |

**Which transformation matters (ablation, typing):** back-references save the
most (55.4 → 22.1 B). With every transformation disabled it is 133.7 B.

**Convergence time, edit on one device to visible on another**

| Link | Plain JSON | Rivulet | Speed-up |
|---|--:|--:|--:|
| LAN (1 ms, 100 Mbps) | 1.52 s | 1.51 s | 1.01× |
| Hostel Wi-Fi (80 ms, 2 Mbps) | 2.91 s | 2.41 s | 1.20× |
| Mobile edge (500 ms, 128 kbps) | 16.49 s | 7.45 s | **2.21×** |

Traffic is 93.7% smaller on every link. **The spread is the honest finding:**
this matters a great deal on a 128 kbps link and very little on a LAN.

**Phase 2 numbers**

| Feature | Before | After |
|---|---|---|
| Uncollected snapshot vs encoded log | 0.2–16% larger | 77–78% smaller |
| Idle sync at 32 replicas (request) | 514 B | ~190 B (flat) |
| Encryption overhead | — | 1.3–1.75× plaintext (per-op design was 8–24×) |

**Adaptive batching** stays within 1.29–1.71× of the best fixed batch size
without being told the network, while the worst plausible fixed choice is up to
286× off. It does *not* beat a well-chosen constant, and the README says so.

---

## 11. Decision log

The architecture decision records are in `docs/adr/`:

| ADR | Decision |
|---|---|
| 0001 | Per-field CRDTs, declared in the schema |
| 0002 | Hybrid logical clocks |
| 0003 | HTTP + Server-Sent Events, not WebSockets |
| 0004 | De-duplicate in the operation log, not in each CRDT |
| 0005 | No runtime dependencies |
| 0006 | Soft deletes |
| 0007 | The stream is a hint, not a delivery |

Decisions made in phases 2 and 3, and why:

| Decision | Why |
|---|---|
| Vector deltas against server-numbered frontiers, not server-assigned positions | Positions would remove the last per-replica cost but need a storage migration across three adapters; deltas fixed the idle cost with no migration and full backward compatibility. |
| Sealed **runs**, ciphertext on the **last** operation | Per-op sealing cost 8–24×; first-operation placement loses data when a retried push overlaps a stored one. |
| Stateless HMAC tokens, not a token database | Issuing is a function call in whatever already knows the user; checking costs one hash. Revocation is by expiry or secret rotation, and is documented as such. |
| Loose per-IP rate limit | The target networks put many honest users behind one NAT address. |
| Android engine in a WebView | The only option with IndexedDB, WebCrypto and CompressionStream built in; no second engine to drift. |
| ContentProvider with JSON `call()` | The Android-standard cross-app interface; writes are richer than rows. |
| Unstable provider connection while observing | Keeps the daemon's network on Android 14+ without risking the client app being killed if the daemon crashes. |

---

## 12. Limitations, stated plainly

- **Tombstones.** A repeatedly rewritten field can hold up to 759× more deleted
  characters than live ones. Collection recovers 97–99.9%, but only below a
  timestamp every replica has seen.
- **Per-replica metadata.** Idle polls are flat, but a client that is behind
  sends an entry per replica it is behind on, and stored state grows with the
  number of replicas. Fine for a team or a class; not for a document shared with
  a hundred thousand people.
- **Encryption is per room, not per person.** Members share one key, with no
  key rotation and no per-user identity. The server still sees who wrote, when
  and roughly how much, and it cannot compact an encrypted room.
- **Text merging is character-level, not intent-level.** Two people rewriting
  the same sentence get a correct merge that may read badly. That is why `mv`
  exists.
- **The network model is a model.** Bufferbloat, TCP slow start and captive
  portals are not simulated. Relative comparisons should hold; absolute timings
  are not predictions.
- **No real-device measurements** of battery, low-end phone throughput or
  memory pressure. Android was verified on an emulator, not a physical phone.
- **Android background sync** is as frequent as Android allows: about every 15
  minutes with no app open and live sync off.
- **Rate limits are per process.** Several servers behind a load balancer each
  enforce their own.

---

## 13. Timeline and contributions

| When | What |
|---|---|
| 2026-09-01 → 09-13 | **Phase 1, the engine** (Shreshth Mishra): CRDTs, HLC, database, op log, storage adapters, codec, protocol, sync engine, server, network simulator, benchmarks, paper, ADRs, browser demo. |
| 2026-09-22 | **v0.2.0** (Ayush Sinha): query operators and projection, storage export/import and compaction tools, `maxRooms` limit, diagnostics endpoints, REPL, fuzz suite, query benchmark. |
| 2026-10-05 | Repository made public. |
| 2026-10-12 | **Phase 2, hardening:** compact snapshots, room tokens, vector deltas, the append fix, end-to-end encryption, rate limiting, encrypted rooms in the demo. |
| 2026-10-12 | **Phase 3, Android:** Rivulet Sync, the client library, Rivulet Notes, Docker deployment, and the live-update engine fixes. |

The repository has 210+ commits. Every feature commit was tested at that commit.

---

## 14. Questions a reviewer will ask

**Why not just last-write-wins everywhere?**
Three independent failures. Device clocks are wrong, so a phone five minutes
fast wins every conflict. Whole-record granularity destroys concurrent edits to
different fields. And counters must not be overwritten: two devices each reading
5 and adding 1 should give 7, not 6.

**Why not use Automerge or Yjs?**
For a production app, use them; Yjs in particular has a more optimised binary
encoding. The contribution here is the transport, designed and evaluated with
the network as the primary constraint, including outages that interrupt
requests mid-flight.

**What's actually novel, if the CRDTs are standard?**
The codec's combination of interning, delta-encoded derived causality and
in-batch back-references, measured by ablation. Then the single-round-trip
resumable protocol, the batch controller that separates loss from congestion,
and in Phase 2 sealed runs, which make end-to-end encryption cost 1.3–1.75×
instead of 8–24×.

**How do you know it converges?**
Property tests, fuzzing, the 792-edit partition benchmark and a 600-seed
randomized stress harness, which was itself validated by breaking the server on
purpose (§9). It is checked, not proven.

**What happens if the server dies?**
Availability stops; data does not. Every client holds its own operations, and
the union reassembles as clients resync.

**What if a device clock is badly wrong?**
HLC timestamps stay causally ordered regardless. A remote timestamp more than
60 s ahead is rejected rather than allowed to win every future conflict.

**What if the network drops in the middle of a sync?**
Pushes are idempotent, so a retry is safe. The outbox advances only on proof of
storage. Pulls are paged with the frontier as the cursor, so a transfer resumes
where it stopped.

**Can the server read encrypted data? Can it tamper with it?**
No, and no. It can withhold or delay operations (availability), but it cannot
read them, and anything it alters or replays fails authentication and is
refused.

**What does the server learn about an encrypted room?**
Who writes, how often, when and roughly how much; the room name; and the schema
fingerprint (collection and field names). This is documented.

**Why a WebView on Android? Isn't that a hack?**
It is the only Android runtime with IndexedDB, WebCrypto and CompressionStream
built in, and it means the phone runs exactly the engine the 300 tests cover.
It costs memory comparable to one browser tab while the process is alive.

**How does the Android daemon sync when no app is open?**
JobScheduler: a periodic job, plus a one-off job after every write that waits
for a network. Android grants network for the duration of a job. Optional live
sync uses a foreground service.

**Can one Android app read another's data through the daemon?**
No. Rooms are namespaced by the calling package, URIs naming another package are
refused, and access requires a runtime permission the user grants.

**What's the worst case?**
Tombstones under a hostile rewrite workload (759×), recoverable only at a
causally stable point.

**Where does this design not help?**
On a fast network. It is 1.01× on a LAN and 2.21× on 128 kbps, and the README
says so before anyone adopts it.

**What would you do next?**
Server-assigned sequence positions (to remove the last per-replica cost), key
rotation for encrypted rooms, measurements on real low-end phones, and a
physical-device test of the Android daemon.

---

## 15. Glossary

| Term | Meaning |
|---|---|
| **CRDT** | Conflict-free replicated data type: a data structure whose replicas converge when they have seen the same operations, in any order. |
| **Replica / node** | One copy of the data: a browser tab, a phone, the server. Each has a permanent id. |
| **Operation (op)** | One change: who made it, its sequence number, its timestamp, and what changed. |
| **HLC** | Hybrid logical clock: a timestamp that respects causality and stays close to real time. |
| **Version vector / frontier** | Per replica, the highest *contiguous* sequence number held: "what I have". |
| **Tombstone** | A deleted element kept so concurrent operations that reference it still apply. |
| **RGA** | Replicated growable array: the CRDT behind text and ordered lists. |
| **Room** | One synchronisation domain, such as a shared notebook; each has its own log. |
| **Outbox watermark** | How far the server has proven it stored this replica's operations. |
| **SSE** | Server-Sent Events: server-to-client messages over a plain HTTP response. |
| **Sealed run** | A push's operations, encoded, compressed and encrypted as one unit. |
| **ContentProvider** | Android's standard interface for an app to serve data to other apps. |

---

## 16. Where things are

```
src/core/            clocks, CRDTs, database, schema, snapshots
src/protocol/        codec, messages (incl. vector deltas), framing, compression, sealing
src/storage/         op log + memory, SQLite and IndexedDB adapters
src/client/          RivuletClient, sync engine, adaptive batching, transports
src/server/          sync server, HTTP/SSE, room tokens, rate limiting
bench/               network simulator and evaluation scenarios
apps/demo-web/       browser demo notebook
apps/cli/            server CLI and token issuer
apps/android/        Rivulet Sync daemon, client library, Rivulet Notes
examples/            two-replicas, REPL, Node client, Android companion
docs/                design documents, ADRs, this guide, the demo handbook
paper/               the write-up
Dockerfile           the sync server, ready to deploy
```

Start with `examples/two-replicas.js` (the whole model in about eighty lines),
then `docs/00-how-it-works.md`.
