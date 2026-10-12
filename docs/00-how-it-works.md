# How it works, end to end

A walkthrough of what actually happens inside the system, in execution order.
The other documents explain *why* each decision was made; this one traces *what
runs*, with real values taken from the code rather than illustrative ones.

If you read one section, read [§4 — a keystroke's journey](#4-a-keystrokes-journey).

---

## 1. The one-paragraph version

Every write goes into an in-memory database of CRDT fields and is immediately
readable. The same write is also appended to a durable **operation log** on
disk. A background **sync engine** periodically sends the operations the server
has not acknowledged, and asks for the ones it does not have, in a single
request. Both sides merge whatever arrives using data structures that converge
regardless of order or duplication, so no server decides conflicts and no user
is asked to.

---

## 2. Tech stack

| Layer | Choice | Why this one |
|---|---|---|
| Language | JavaScript (ESM), JSDoc types | Runs in Node *and* the browser from the same source, with no build step. The demo therefore exercises the same files as the tests, not a compiled copy. |
| Runtime | Node 22.5+ | The floor is set by `node:sqlite`, which landed in 22.5. |
| Server storage | `node:sqlite` | Built in, so no native compilation and no dependency. `(node, seq)` as a primary key makes de-duplication an `INSERT OR IGNORE`. |
| Browser storage | IndexedDB | The only browser store that is durable *and* large enough for an operation log. `localStorage` caps around 5 MB and is synchronous. |
| Transport | `node:http` + Server-Sent Events | Sync traffic is client-initiated, so a WebSocket only adds server→client push, which SSE does over plain HTTP — and survives proxies and captive portals that break upgrades. |
| Compression | `node:zlib` / `CompressionStream` | Raw DEFLATE. One wrapper hides the platform difference. |
| Tests | `node:test` | Built in. 222 tests. |
| Dependencies | **None** | Enforced in CI. A research artefact has to still run in five years. |

**There is no framework, no bundler, no TypeScript compiler and no linter.**
Types are JSDoc (so `tsc --checkJs` works if wanted), and `scripts/check.js`
covers what a linter would actually catch here: files that do not parse,
imports that do not resolve, modules nothing reaches.

---

## 3. The map

```
                    ┌───────────────────────────┐
  your code  ─────▶ │      RivuletClient        │   identity, restart recovery,
                    │  mutate / get / subscribe │   write queue
                    └─────────┬─────────┬───────┘
                              │         │
              ┌───────────────▼──┐   ┌──▼───────────────┐
              │    Database      │   │   SyncEngine     │  batching, backoff,
              │ documents of     │   │ one round trip   │  status machine
              │ CRDT fields      │   │ per sync         │
              └────────┬─────────┘   └──┬───────────────┘
                       │                │
              ┌────────▼─────────┐   ┌──▼───────────────┐
              │     OpLog        │   │    Protocol      │  codec, messages,
              │ exactly-once,    │   │ encode / decode  │  framing
              │ frontier, outbox │   └──┬───────────────┘
              └────────┬─────────┘      │
                       │                │
              ┌────────▼─────────┐   ┌──▼───────────────┐
              │ StorageAdapter   │   │   Transport      │
              │ memory / SQLite  │   │ HTTP+SSE /       │
              │ / IndexedDB      │   │ loopback / sim   │
              └──────────────────┘   └──────────────────┘
```

The two columns never talk to each other. `Database` has never heard of a
network; `SyncEngine` has never heard of SQLite. That separation is what lets
the benchmarks swap in a simulated link and a naive codec without touching
anything else.

---

## 4. A keystroke's journey

You type one character into a bound `<textarea>`. Here is every stage.

### Stage 1 — the application calls `mutate`

```js
client.mutate((tx) => tx.setText('notes', id, 'body', textarea.value));
```

The UI hands over the **whole new string**, not a diff. That is deliberate: it
makes binding trivial, and the engine recovers the actual edit itself.

### Stage 2 — recovering the edit (`src/core/text-diff.js`)

`textEdit()` compares the new string with the field's current text, trimming the
common prefix and suffix. What remains is one contiguous change.

```
before: "hell"
after:  "hello"
        ─────┬
             └── index 4, removed 0, inserted "o"
```

It returns identities, not positions:

```js
{ deleteIds: [], insertAfter: <id of 'l'>, insert: 'o' }
```

`insertAfter` is the last character *not* being deleted. Anchoring on a
character that is about to be removed still converges, but the insert drifts
away from where the caret actually was.

### Stage 3 — building the operation (`Transaction.#emit`)

```js
const op = this.#factory.create({ collection, doc, field, payload });
this.#db.apply(op, { local: true });   // applied immediately
this.#ops.push(op);
```

`OpFactory.create` stamps it with the replica id, the **next sequence number**,
and a fresh **hybrid logical clock** reading:

```json
{
  "node": "e40c292cfb8758fc",
  "seq": 6,
  "ts": "018bcfe56800-0005-e40c292cfb8758fc",
  "collection": "notes",
  "doc": "c3736c64c434242730326639",
  "field": "body",
  "payload": { "i": "o", "p": "018bcfe56800-0004-e40c292cfb8758fc" }
}
```

209 bytes as plain JSON, for one character. That number is the whole reason
§5 exists.

Note `payload.p` — the operation names *the identity of the character it
follows*. No index appears anywhere, because an index would mean something
different by the time it arrived.

### Stage 4 — applying locally, right now

`Database.apply` → `Document.apply` → `RGA.apply`. The character is inserted
into the sequence, `this.#cache` is invalidated, and a `change` event fires.

**The UI can now read the new value.** No network has been touched. This is the
whole point of "local-first": `mutate` returns synchronously and reads are
never asynchronous.

### Stage 5 — commit and durability

`tx.commit()` emits `local-ops`, which two listeners pick up:

1. **`WriteQueue`** (in `RivuletClient`) appends to the operation log through a
   single promise chain, so writes land in order and a sync can await them.
2. **`SyncEngine.#onLocalOps`** marks the engine dirty and schedules a sync
   after `debounceMs`, so a burst of typing becomes one request.

### Stage 6 — the sync round begins (`SyncEngine.#syncRound`)

```js
await this.#beforeSync();                       // drain the write queue first
const outbox = await this.#log.outbox(node, { limit });   // unacknowledged ops
const have   = this.#log.frontier();            // what we hold, contiguously
```

- **`outbox`** is derived, not stored: it is every local operation after one
  persisted watermark. A separate table could drift out of step with the log.
- **`have`** is a version vector — `{replicaId: highestContiguousSeq}`. It is
  both the "what am I missing?" question *and* the resumption cursor.
- **`limit`** comes from the adaptive batcher (§7).

### Stage 7 — encoding (`src/protocol/codec.js`)

For a burst of 15 keystrokes, plain JSON is **3 133 bytes**. The codec produces
**572 bytes**. Here is the actual output, trimmed:

```json
{
  "v": 2, "n": 15, "b": 1700000000000,
  "N": ["e40c292cfb8758fc"],          // node dictionary
  "C": ["notes"], "D": ["c3736…"], "F": ["body"],
  "ni": { "r": [[0, 15]] },           // node column: 15 identical → one run
  "sq": { "r": [7, [1, 14]] },        // seq: absolute 7, then fourteen +1s
  "wl": { "r": [[0, 15]] },           // wall-clock delta from "b"
  "ct": [6,7,8,9,10,11,12,13,14,15,16,17,18,19,20],
  "p": [
    { "i": " ", "p": "018bcfe56800-0005-e40c292cfb8758fc" },
    { "i": "t", "p": 0 },             // ← back-reference to op 0 in this batch
    { "i": "h", "p": 1 },
    { "i": "e", "p": 2 },
    …
  ]
}
```

Four transformations are visible in that output:

| | What you can see | Saves |
|---|---|---|
| **Interning** | `"notes"`, the doc id and `"body"` appear **once** in `C`/`D`/`F` | repeating names on every op |
| **Columnar + RLE** | `"ni": {"r":[[0,15]]}` — fifteen identical values as one run | repeated column values |
| **Delta encoding** | `"sq": {"r":[7,[1,14]]}` — one absolute, then fourteen `+1`s | dense sequence numbers |
| **Back-references** | `"p": 0`, `"p": 1` … instead of 34-char timestamps | operations naming each other |

Also note what is *absent*: the `ts` field. An operation's timestamp always
embeds the replica that issued it, which is already in the node column, so the
timestamp is reconstructed at decode from `b + wl[i]`, `ct[i]` and `N[ni[i]]`.

### Stage 8 — framing and the wire (`src/protocol/framing.js`)

`packMessage` serialises the message and compresses it **only if that helps**:

```
encoded batch      572 bytes
after deflate-raw  286 bytes   ← sent, with content-encoding: deflate-raw
```

An idle sync — nothing to push, nothing to pull — is almost all version vector,
so its size depends on how many replicas have ever written to the room:

| Replicas in the vector | Idle sync request |
|--:|--:|
| 0 (a brand-new client) | 85 B |
| 2 | 130 B |
| 4 | 133 B |
| 32 | 466 B |

That is what a request carrying the whole vector costs, and it grows with the
replica count. In practice the engine sends the vector as a delta against the
last frontier the server numbered (see "Sending only what changed" in
`docs/03-sync-protocol.md`), so a caught-up client's `have` is `{}`. The
benchmark in `bench/results/scale.md` measures a real idle round: about 190 B
up and 116 B down whether the room has two replicas or thirty-two, against 191
to 514 B for the full-vector request.

### Stage 9 — the server (`SyncServer.handleSync`)

```js
// ---- push ----
const incoming = decodeOps(msg.push);
const own = incoming.filter(op => op.node === msg.node);   // reject forgeries
const { added, fresh, duplicates } = await room.log.append(own);
room.broadcast(fresh, msg.node);                           // notify others

// ---- pull ----
const { ops: outgoing, more } = await room.log.delta(clientHas, { limit });
```

Three things are worth pausing on:

1. **Push is applied before pull is computed.** So a client that just wrote does
   not get its own operations back, and two clients syncing simultaneously each
   see the other's work on the *first* round.
2. **Operations attributed to another replica are rejected.** Otherwise a client
   could forge another's history — and worse, occupy sequence numbers so the
   real operations could never be accepted.
3. **The server never merges anything.** It stores and forwards. It is a replica
   that does not write, which is why losing it costs availability, not data.

The reply:

```js
ack({
  ok: accepted, dup: duplicates,
  pull: encodeOps(outgoing),
  have: room.log.frontier(),
  you:  room.log.frontier().get(msg.node),   // ← how far YOUR history is stored
  more,                                       // ← another round needed?
})
```

### Stage 10 — back on the client

```js
if (reply.you > 0) await this.#log.markPushed(reply.you);   // advance outbox
const incoming = this.#codec.decode(reply.pull);
const { fresh } = await this.#log.append(incoming);         // drop duplicates
this.#db.applyAll(fresh);                                   // only new ones
this.#batcher.record({ ops: outbox.length + applied, ms: elapsed });
```

- The watermark advances **only to `reply.you`** — what the server proved it
  stored, never what we hoped we sent. A partially accepted push retries exactly
  the remainder.
- `log.append` returns only `fresh` operations. That is what makes the
  PN-counter safe: it is not idempotent, and must never see an operation twice.
- If `reply.more` is set, the loop runs again with an advanced frontier.

Status becomes `live`, a `sync` event fires, and the UI's `subscribe` callback
re-renders.

---

## 5. How a remote change arrives

1. Another replica syncs; the server calls `room.broadcast(fresh, from)`.
2. Every SSE listener **except the sender** receives `{"t":"event","n":3}`.
3. The client's stream handler calls `#schedule(0)`.
4. A normal sync round runs — the one traced above.

**The stream carries a count, never the operations.** It is a hint that
something changed. A dropped frame costs latency; a dead stream degrades to
polling. Nothing depends on the stream being reliable, which matters because
behind a captive portal it usually is not.

---

## 6. Going offline and coming back

**Offline.** `transport.request` throws a `TransportError`. The engine:
- sets status `offline` and emits `error`
- schedules a retry with full-jitter exponential backoff
- **does not** shrink the batch size — being unreachable says nothing about how
  much a round can carry

Meanwhile writes keep working normally. They accumulate in the log; the outbox
watermark simply stops advancing.

**Coming back.** One sync round pushes everything queued and pulls everything
missed. Concurrent edits made by other replicas merge by field type:

```
alice offline: "The wifi is down."  →  "The hostel wifi is down."
bob   offline: "The wifi is down."  →  "The wifi is down again."
after sync   : "The hostel wifi is down again."      ← both survive
```

That is `examples/two-replicas.js`, which runs in about a second.

**If the transfer is interrupted halfway**, the frontier is the cursor, so the
next attempt resumes where it stopped. And if a batch arrives incomplete, the
frontier stops at the hole, so the next pull re-sends from there.

---

## 7. Adaptive batching, in one page

How many operations per request? Too few wastes round trips at 500 ms RTT; too
many produces a request the link cannot finish before it drops.

The controller measures instead of assuming (`src/client/adaptive.js`):

```js
record({ ops, ms })  // successful round: raise towards the measured rate
fail({ sizeRelated, ms })   // failure: maybe back off
```

Two distinctions matter, and both were found by benchmarking:

1. **Not every failure is congestion.** `TransportError.kind` is `timeout`,
   `lost` or `unreachable`. Only `timeout` implicates size. Treating packet loss
   as congestion drove the batch to its floor on a 5%-loss link and turned one
   transfer into hundreds of round trips.
2. **Not every timeout is congestion either.** A request cut short when the link
   died looks identical to one that was too big — except it had been running for
   much less time than a normal round. That duration is the signal.

On failure the controller remembers the size that failed and approaches it
gently, relaxing additively during sustained success.

---

## 8. The five field types, concretely

```js
notes: {
  title:    'lww',      body: 'text',   tags: 'set',
  reads:    'counter',  estimate: 'mv',
}
```

| Type | Concurrent A and B | Result |
|---|---|---|
| `lww` | rename to "X" / rename to "Y" | later HLC timestamp wins; ties broken by replica id |
| `text` | insert "hostel" / append "again" | both survive, character by character |
| `set` | add "urgent" / remove "draft" | both applied; a remove only deletes tags it *saw*, so add wins |
| `counter` | +2 / +3 | **5** — per-replica totals are summed, not overwritten |
| `mv` | set 900 / set 950 | **both kept**; UI shows a choice |

Two people editing *different fields* never conflict at all — that is the point
of per-field CRDTs.

---

## 9. Where each guarantee lives

| Guarantee | Mechanism | File |
|---|---|---|
| A write is never lost | local commit before anything else | `core/database.js` |
| Replicas converge | commutative, associative merge | `core/crdt/` |
| An op applies exactly once | `(node, seq)` primary key | `storage/oplog.js` |
| A retry is safe | idempotent push + `ack.you` watermark | `client/engine.js`, `server/engine.js` |
| Interrupted transfers resume | frontier doubles as cursor | `storage/oplog.js` |
| Wrong device clocks are survivable | hybrid logical clocks | `core/hlc.js` |
| Restart does not corrupt history | persisted identity, seq, clock | `client/client.js` |
| One client cannot forge another | sender-attribution check | `server/engine.js` |

---

## 10. The invariants — what breaks if you get them wrong

These are the non-obvious ones. Each has a test.

1. **A replica advertises its contiguous prefix, never its maximum.**
   Holding `{1..20, 27..42}` and claiming 42 tells peers you have 21–26. They
   are never resent. Silent, permanent data loss.
2. **Identity is minted once, ever.**
   Re-minting restarts sequence numbers at 1, so the new operation 1 collides
   with the old one.
3. **The clock resumes past the highest timestamp ever issued.**
   Otherwise a restart can mint a timestamp that loses to a write it happened
   *after*.
4. **De-duplication happens in the log, not in each CRDT.**
   This is what lets the PN-counter exist; it cannot be idempotent.
5. **The outbox watermark advances only on proof (`ack.you`).**
   Advancing optimistically loses operations when a push is partly accepted.
6. **A child's sequence id always exceeds its parent's.**
   The RGA insertion scan depends on it to skip whole subtrees with one
   comparison.

---

## 11. Where to look in the code

Roughly in the order they were built:

```
src/core/hlc.js              hybrid logical clocks
src/core/range-set.js        gap-tolerant sequence tracking
src/core/version-vector.js   "what am I missing?"
src/core/crdt/contract.js    ← read this before touching a CRDT
src/core/crdt/rga.js         the sequence type; the subtle one
src/core/database.js         documents, transactions, the write API
src/protocol/codec.js        the four encoding transformations
src/protocol/messages.js     the wire protocol
src/storage/oplog.js         exactly-once, frontier, outbox
src/client/engine.js         the sync loop and state machine
src/server/engine.js         push/pull handling
bench/netsim/                the network simulator
```

**To see it work in one file:** `examples/two-replicas.js` — two replicas, one
partition, no lost work, about eighty lines.

---

## 12. Questions worth having an answer to

**Why not just use a timestamp and last-write-wins everywhere?**
Three independent failures: device clocks are wrong (a phone five minutes fast
wins every conflict for five minutes); whole-record granularity destroys
concurrent edits to different fields; and counters must not be overwritten —
two devices each reading 5 and adding 1 should give 7, not 6.

**Why not Automerge or Yjs?**
For production, use them — Yjs in particular has a more optimised binary
encoding. The contribution here is the transport: the network profile is treated
as the primary design constraint, and evaluated against explicitly stated link
models including outages that interrupt requests mid-flight.

**What happens if the server dies?**
Availability stops; data does not. Every client holds its own operations, and
the union reassembles as clients resync. The server is a replica that never
writes.

**How do you know it converges?**
Property tests generate operations and deliver them to independent replicas in
independently shuffled orders, asserting they agree — plus commutativity,
idempotence and snapshot/replay parity. A failing seed prints and replays
exactly. It is checked, not proven.

**What is the worst case?**
Tombstones. A repeatedly rewritten field can hold 759× more deleted characters
than live ones. Collection recovers 97–99.9%, but only below a timestamp every
replica has seen.

**What does this cost that a normal database does not?**
Per-replica metadata. Every operation names its replica, every replica that
ever wrote keeps an entry in the vector, and that vector is stored and compared
on both sides. Vector deltas keep an idle poll flat (about 190 bytes up,
whatever the replica count), but a client that is behind still sends an entry
per replica it is behind on, and the server holds the whole vector per room.
Fine for a team, or a class; still not a document shared with a hundred
thousand people.

**Where does this design not help?**
On a fast network. Convergence improves 2.21× on a 128 kbps link and **1.01×**
on a LAN. That is in the README, because someone should know it before adopting
this.
