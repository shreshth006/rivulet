# Sync protocol

## The constraint

At 500 ms round-trip time, a protocol that asks "what do you have?", waits,
sends, waits, then pulls has spent 1.5 seconds before any useful data moves. On
a link that drops every thirty seconds, that is most of the connection's life.

So the protocol has exactly one shape: **one message carries everything the
client wants to say, and the reply carries everything it needs to hear.**

## One round trip

```
client                                                    server
  │                                                          │
  │  sync { have: <version vector>, push: <encoded ops> }     │
  ├─────────────────────────────────────────────────────────▶│
  │                                          apply the push   │
  │                                          compute the delta│
  │  ack  { ok, you, pull: <encoded ops>, have, more }         │
  │◀─────────────────────────────────────────────────────────┤
```

Order matters inside the handler. Applying the push *before* computing the pull
means a client that just wrote something does not receive its own operations
back, and two clients syncing in the same instant each see the other's work on
the first round rather than the second.

An idle sync — nothing to push, nothing to pull — is one request of about 125
bytes and its reply. That is the floor, and it is what a polling client pays.

## Version vectors as both question and cursor

A version vector maps replica id → contiguous sequence frontier:

```json
{ "a1b2c3d4e5f60718": 412, "9f3c1a7b22d0e4f1": 87 }
```

It says "I have everything from A up to 412, and from B up to 87". The server
answers with exactly what is missing. No full-state transfer, no per-record
comparison, no Merkle tree: the whole question is a few dozen bytes and the
answer is an indexed range scan.

The same vector is the resumption cursor. When a pull is too large for one
response the server sets `more`, and the client re-issues `sync` with its
advanced frontier. Because the frontier *is* the cursor, there is no server-side
session to lose: a connection that dies mid-transfer resumes exactly where it
stopped. Without that, a large initial sync on a link that drops every few
minutes can never complete.

### Why only the contiguous prefix

A replica advertises the largest `n` such that it holds sequences 1..n — not the
highest sequence it holds.

After a partial batch or a partition that healed from two directions, a replica
may hold `{1..20, 27..42}`. Advertising 42 would tell peers it already has
21..26, and those operations would never be resent: silent, permanent data loss
that no amount of CRDT merging recovers.

So the local store tracks exact ranges (`RangeSet`, which compacts to O(1) per
replica in steady state) and advertises only the prefix. Gaps heal on their own —
the next pull starts at the hole and re-sends the rest, and the duplicates are
discarded by the log.

### Sending only what changed

A vector has an entry per replica that ever wrote to the room, so sending it
whole makes even a no-op poll grow with how widely the room is shared — and the
reply carries the server's vector back the same way.

So the server numbers the frontiers it reports. Each `ack` carries `hv`, an
opaque id (`<random epoch>.<counter>`) for the frontier in its `have`. The
client stores that id together with the vector, as one value, and on its next
`sync` sends `bv: <id>` with `have` holding only the entries where its own
frontier differs from that base — including entries *below* it, and 0 for a
replica the base has and it does not. The server rebuilds the full vector from
its copy of the base. The reply's `have` is likewise only what moved since the
base, marked `hd: <id>`; a client that receives a delta against an id it did
not send treats it as a protocol error rather than guessing.

```json
{ "t": "sync", "bv": "6f0e…c2.1k", "have": {} }
```

That is a fully caught-up client, at any replica count. A client that is behind
sends one entry per replica it is behind on, so the cost follows activity
rather than membership.

The server keeps the last 256 numbered frontiers per room, in memory. A base it
no longer holds — after a restart, or from a client that slept through more
than 256 changes — is answered with the full frontier, a fresh `hv`, no pull
and `more: true`. The client's next round is compact again. That is one extra
round trip, never a wrong answer: the server never guesses what a client has.

Either side leaving the fields out gets the plain protocol, so old clients and
old servers interoperate.

## Idempotence, and why it matters more than it sounds

Every message is safe to retry. A pushed operation the server already holds is
counted and ignored, because `(node, seq)` is a primary key.

This is load-bearing. The genuinely awkward network failure is not a lost
request — it is a lost *response* to a request the server fully processed. A
protocol without idempotent writes has to distinguish those two cases, and it
cannot. Here, both are the same: retry, and the second attempt is free.

The simulator models the two separately for exactly this reason.

## The outbox watermark

The client advances its outbox watermark only to `ack.you` — the server's
contiguous frontier *for this client's own replica*. Never to what the client
hoped it sent.

So a partially accepted push retries exactly the part that did not land, and a
response lost after the server committed is recovered on the next round rather
than assumed.

The outbox itself is not a separate table. It is derived: one persisted
watermark, and the outbox is everything after it. A separate table could drift
out of step with the log; a derived one cannot.

## Operation encoding

A batch of operations as plain JSON is enormously redundant. Typing one word
produces four operations of roughly 200 bytes each, almost none of which is the
keystroke.

Four transformations, each attacking a different redundancy:

1. **Dictionary interning.** Collection, document and field names repeat on
   every operation in a batch. Hoist them into tables and store indices.
2. **Columnar layout.** All the `seq` values together, all the `field` indices
   together. Like values sit adjacent, which is both run-length encodable and
   far more compressible by DEFLATE than the same data interleaved row by row.
3. **Derived and delta-encoded causality.** An operation's HLC timestamp always
   carries the id of the replica that issued it — already in the node column —
   so it is dropped and reconstructed. What remains is delta-encoded against a
   batch base. Sequence numbers, being dense, are almost always a delta of 1.
4. **Timestamp back-references.** Operations point at each other constantly:
   every inserted character names the one before it, every delete names its
   target, every set removal names the tags it observed. When the referenced
   operation is in the same batch — overwhelmingly the common case, because
   people type in runs — a 34-character timestamp becomes a small integer.

Only structural keys are rewritten, so a user string that happens to look like a
timestamp is never mangled. There is a test for that.

The result then goes through DEFLATE, but only when it pays: a sync request with
no operations is around 80 bytes, and compressing it would make it larger.

Measured contribution of each transformation is in [evaluation](05-evaluation.md).
The switches exist in the codec (`DEFAULT_OPTIONS`) so the ablation measures
rather than asserts.

## Adaptive batching

How many operations should one request carry? There is no good fixed answer.

Too few, and a high-latency link spends its time in round trips. Too many, and a
single request outlives the connection: on a link that drops every thirty
seconds, a forty-five-second transfer never completes and retries from the
start, forever.

So the size is measured. The controller targets a request that takes about two
seconds end to end — long enough to amortise the round trip, short enough to
finish before a flaky link drops it — using TCP-like congestion avoidance.

Two details matter, and both were found by the benchmarks:

- **Not every failure is congestion.** A dropped packet or an unreachable server
  says nothing about how much a round can carry. Treating them as congestion
  drove the size to the floor on a 5%-loss link and turned one transfer into
  hundreds of round trips. Only a timeout implicates size.
- **Not every timeout is congestion either.** A request cut short by the link
  going down looks identical to one that was too big — except in how long it had
  been running. A round that died well before a normal round was killed by the
  link.

The controller remembers the size that genuinely failed and approaches it gently
rather than doubling back into it, relaxing the ceiling additively during
sustained success.

## Live updates

Server-Sent Events, not WebSockets. Sync traffic is overwhelmingly
client-initiated — a sync *is* a request — so the only thing a socket adds is
server-to-client notification, which SSE does over ordinary HTTP. In exchange it
survives the proxies, captive portals and middleboxes that routinely break
WebSocket upgrades, and it reconnects on its own.

Critically, **a stream message is a hint, not a delivery**. It says "something
changed", carrying a count and nothing else; the client reacts by syncing
through the normal path. A stream that silently dies costs latency and nothing
else, and the engine degrades to polling without noticing.

This is deliberate. A half-working stream is the normal condition behind a
captive portal or a mobile NAT, and a design that depended on it would fail
exactly where this project is aimed. Furthermore, when intermediate middleboxes
or edge proxies buffer event stream chunks, the client remains protected by
retaining baseline polling until a live ready frame verifies unbuffered delivery.

## Security boundary

The server enforces one thing about content: **operations must be attributed to
the replica that sent them.** Accepting an operation labelled with another
replica's id would let a client forge that replica's history, and forged
sequence numbers would block the real ones from ever being accepted.

Everything else is transport-level: bounded request bodies, rooms isolated in
separate databases, and an authorisation hook consulted before every room
access — `hello`, `sync`, `subscribe`, and `inspect` for the operational
endpoints — with the request's bearer credential and whether it writes.

The bundled hook (`roomTokens` in `src/server/tokens.js`) accepts stateless
HMAC-signed tokens naming a room (exactly, by prefix, or `*`) and a scope:

| Scope | May |
|---|---|
| `read` | pull, subscribe |
| `write` | also push operations |
| `admin` | also `GET /v1/room`; with room `*`, `GET /v1/stats` |

A token can also be bound to one replica id and given an expiry. A sync that
carries operations counts as a write, so a read-only follower that writes
anyway is refused outright and goes to `unauthorised` rather than silently
diverging. The simpler single deployment token (`--token`) remains, and now
also guards the operational endpoints.

### End-to-end encryption

A room can be opened with a key the server never sees (`encryption: { key }`
on the client). The server keeps working because it only ever needed each
operation's envelope — replica, sequence number, timestamp — and those stay in
the clear. Collection, document, field and value are sealed with AES-256-GCM.

Operations are sealed in **runs**, not one by one: a replica's consecutive
operations, as one push carries them, go through the codec and DEFLATE and are
then encrypted once. Sealing each operation separately cost 8–24× the bytes,
because ciphertext does not compress; sealed runs cost 1.3–1.75× and are still
85–93% smaller than plain JSON (`bench/results/bandwidth.md`).

The ciphertext rides on the run's last operation; the others carry
`{ "$r": <last seq> }`. Last rather than first because a retried push may repeat
the start of a run the server already stored, and those operations are dropped
as duplicates — the last one of a retry never is. When a pull page ends
part-way through a run, the server adds the run's last operation to the page.
That `$r` pointer is the only thing inside a payload the server ever reads.

The room, replica, first and last sequence numbers and timestamp are bound to
the ciphertext as authenticated data, and every operation inside is checked
against them on opening. A key-holding replica refuses unsealed operations and
anything that fails to open, and goes to `unauthorised`.

What the server still learns: which replicas write, how often, when, and
roughly how much; the schema fingerprint (collection and field names, sent at
connect so version skew is caught); and room names. It also cannot compact an
encrypted room, since it cannot materialise one. The key is shared by everyone
in the room, so it protects against the server, not between members.

What is *not* here, stated plainly: no per-user identity beyond what the token
issuer encodes, no key rotation for an encrypted room, and no revocation short
of token expiry or rotating the secret.
