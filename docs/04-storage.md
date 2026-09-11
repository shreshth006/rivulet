# Storage

## One contract, three backends

Three environments need durable operations — a browser (IndexedDB), a Node
client or server (SQLite), and tests and benchmarks (memory) — and the sync
engine must not care which it is talking to.

So the interface is deliberately narrow: append operations, ask which ones a
peer is missing, read and write a little metadata. Everything is async, because
IndexedDB is; SQLite pays a negligible price for that and it keeps one code path
instead of three.

If the three disagreed about anything — how a duplicate append is counted, where
a frontier stops, whether a bounded pull is resumable — the bug would appear as
a sync failure on one platform only, which is the worst kind to debug. So the
behaviour is specified once, in `test/helpers/adapter-conformance.js`, and each
adapter is held to it.

## The query that matters

```js
adapter.opsSince(versionVector, { limit, exclude })
```

The whole sync protocol is this one call: given a peer's version vector, return
the operations it does not have. It must be bounded and resumable, because the
target environment drops connections mid-transfer.

Results are ordered by `(node, seq)` rather than by timestamp. That keeps each
replica's operations contiguous, which is exactly what the codec's delta
encoding wants — consecutive sequence numbers collapse to a run of 1s — and
costs nothing in correctness, since the CRDTs accept any order.

## SQLite

Uses Node's built-in `node:sqlite`, which keeps the zero-dependency property.
That is worth real money for a research artefact: someone should be able to
clone this in five years and run it without lockfile archaeology.

```sql
CREATE TABLE ops (
  node TEXT, seq INTEGER, ts TEXT,
  collection TEXT, doc TEXT, field TEXT, payload TEXT,
  PRIMARY KEY (node, seq)
) WITHOUT ROWID;
```

`(node, seq)` as the primary key makes append de-duplication a plain
`INSERT OR IGNORE` — the cheapest possible exactly-once guarantee, enforced by
the storage engine rather than by us.

Two pragma choices are workload-specific:

- **WAL journaling**, so readers never block the writer. The server materialises
  and serves reads while sync writes land underneath.
- **`synchronous = NORMAL`**, not `FULL`. A full fsync per commit would cap sync
  throughput at the disk's fsync rate for no real benefit: an operation lost to
  an OS crash is still held by the replica that produced it and will be resent
  on the next sync. The log is redundant by construction.

## IndexedDB

The only browser store that is both durable across restarts and large enough for
an operation log — `localStorage` caps out around 5 MB and is synchronous.

The compound key `[node, seq]` gives exactly-once appends for free (`add` fails
on an existing key, which is precisely the de-duplication we want) and makes the
sync query a bounded range scan per replica rather than a full cursor walk.

### The bug worth knowing about

An IndexedDB transaction auto-commits as soon as its request queue drains. So
this is a trap:

```js
const tx = db.transaction('ops', 'readonly');
const nodes = await getNodes(tx);        // transaction commits here
const ops = await getOps(tx, nodes);     // TransactionInactiveError
```

The first version of the adapter did exactly that. It worked against an
in-memory double until the double was made faithful, and would have failed in
every real browser.

Every multi-step read now issues all of its requests synchronously and awaits
them together. A cursor walk is still safe to await as a whole, because a
pending cursor keeps its transaction alive — but it must own its transaction,
since that transaction is spent by the time it returns.

The browser adapter is tested against an in-process IndexedDB double
(`test/helpers/fake-indexeddb.js`) covering compound keys, bounded ranges, key
cursors with `continue(key)`, and duplicate-key rejection. Shipping an untested
adapter to the one environment this project exists to serve would be
indefensible.

## The op log

Sits on any adapter and adds the three things every replica needs:

1. **Exactly-once delivery to the CRDTs.** The adapter's primary key rejects
   duplicates; the log turns that into a precise answer — *these* operations
   were new — so no CRDT type has to carry its own seen-set. This is the
   layering that lets the PN-counter exist.
2. **An accurate frontier.** Held in memory as a range set per replica, rebuilt
   from the adapter at startup and advanced on every append. Rebuilt from the
   *store*, not from a cached summary: after a crash the cache may be stale, the
   store never is.
3. **An outbox**, derived from one persisted watermark rather than a second
   table that could drift.

## Compaction

The log grows with every edit ever made; a snapshot grows only with surviving
state. A replica bootstrapping from a snapshot should pay the second.

Compaction is only safe up to a frontier every replica has — anything newer may
still be the answer to a pull from a replica that has been offline for a week.

One honest finding from the evaluation: compaction only pays *once tombstones
are collected*. An uncollected snapshot is slightly **larger** than the encoded
log, because the snapshot format stores every element identifier in full while
the codec replaces in-batch references with integers. Applying the same
interning to the snapshot format would close that gap and is unfinished work.

Collected, the snapshot is 96–99.9% smaller than the log.
