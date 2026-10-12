# Changelog

## Unreleased

### Storage & Compaction

- Compact snapshot format (version 2, `src/core/snapshot.js`). Structural
  timestamps are interned into one run-length-encoded columnar table, field
  names are listed once per collection, and sequences are stored as columns.
  An uncollected snapshot is now 77–78% smaller than the encoded log rather than
  0.2–16% larger; a collected one is 69–72% smaller than before.
- `snapshot({ compact: false })` still writes the plain version-1 form, and
  version-1 snapshots already in storage continue to load.
- `bench/scenarios/overhead.js` reports plain and compact snapshot sizes side by side.

### Security

- Room-scoped access tokens (`src/server/tokens.js`): stateless HMAC-SHA256
  tokens naming a room, a room prefix or `*`, with `read`, `write` or `admin`
  scope, optional replica binding and optional expiry. `issueRoomToken`,
  `verifyRoomToken` and the `roomTokens(secret)` authorizer are exported.
- The engine's `authorize` hook now receives `action`, `writes` and the bearer
  `credential`, and is consulted for `/v1/stream` subscriptions and the
  inspection endpoints as well as for sync.
- `/v1/stats` and `/v1/room` are no longer open when auth is configured: they
  require the deployment token, or an admin room token (`*` for stats).
- The deployment token is compared in constant time.
- CLI: `serve.js --room-tokens` (secret from `RIVULET_SECRET`) and
  `npm run token` to issue tokens.

## 0.2.0

Comprehensive query, reliability, diagnostic, and developer tooling enhancements.

### Query Engine & Schema

- Rich query operator support in `Database.list` and `client.list`: `$gt`, `$gte`,
  `$lt`, `$lte`, `$ne`, `$in`, `$nin`, `$exists`, and `$regex`.
- Field projection (`select: ['field1', 'field2']`) for efficient bandwidth and memory reads.
- Multi-format sorting: string (`'title'`, `'-reads'`), object maps (`{ reads: -1 }`), and custom comparators.
- Single document query helpers: `exists(collection, id)`, `find(collection, where)`, `findOne(collection, where)`.
- Runtime document schema validation (`schema.validate(doc)`).

### Storage & Compaction

- Checkpointing and compaction capability inspection (`log.canCompact`, `client.canCompact`).
- Safe checkpointing without log truncation (`log.saveSnapshot`).
- Storage vacuuming (`log.vacuum`, `client.vacuum`) to reclaim disk pages in SQLite.
- Full operation import and export (`log.exportOps`, `log.importOps`, `log.exportJson`, `log.importJson`).
- Metadata lifecycle management with `log.hasMeta` and `log.deleteMeta`.

### Sync Server & Protocol

- Server resource ceiling with `maxRooms` limit protection against denial-of-service.
- Room operational inspection: `server.roomStats(name)`, `server.roomCount`, `server.hasRoom`, `server.closeRoom`.
- Operational HTTP diagnostic endpoints: `GET /v1/info` and `GET /v1/room`.
- Wire protocol message type guards (`isSyncMessage`, `isAckMessage`, etc.) and error-safe parser (`safeParseMessage`).
- Bandwidth savings telemetry and compression metrics in `ByteMeter`.

### Client & Developer Tooling

- Status lifecycle subscription (`client.onStatus`) and synchronization awaiters (`client.waitForStatus`, `client.waitForIdle`).
- Portable snapshot accessors on client (`client.snapshot`, `client.loadSnapshot`, `client.gc`).
- Interactive terminal REPL (`examples/repl.js`, `npm run repl`).
- Property-based fuzz test suite (`test/fuzz.test.js`) verifying chaotic multi-replica partitions and payload corruption.
- Query performance benchmark scenario (`bench/scenarios/query.js`).
- Dependency-free data structures (`LruCache`, `cloneDeep`, `asyncMap`).

## 0.1.0

First release. The engine is complete and the evaluation reproduces.

### Core

- Hybrid logical clocks: causally correct, bounded to real time, monotone
  across backwards clock jumps and process restarts.
- Version vectors over a gap-tolerant range set, so a replica never advertises
  coverage it does not have after a partial transfer.
- Five CRDT types — last-writer-wins, multi-value, PN-counter, add-wins
  observed-remove set, and an RGA sequence with a text view.
- Per-field CRDTs under a schema, so concurrent edits to different fields of a
  record never contend.
- Soft deletes as ordinary last-writer-wins tombstones, so a delete merges with
  a concurrent edit by timestamp and can be undone.

### Protocol

- Columnar operation codec: dictionary interning, per-replica sequence deltas,
  timestamps derived from the node column, and in-batch reference substitution.
  22.1 bytes per operation for text editing against 210 for plain JSON.
- Push and pull in a single message, so a reconciliation is one round trip.
- Transfers resume from the version-vector frontier rather than restarting.
- Compression applied only when it wins.

### Storage

- One adapter contract with in-memory, SQLite and IndexedDB backends, all held
  to a shared conformance suite.
- Operation log providing exactly-once delivery, an accurate frontier, and an
  outbox derived from a single watermark.
- Snapshot compaction with tombstone collection at a causally stable point.

### Client and server

- Local-first writes that return synchronously.
- Adaptive batch sizing that distinguishes congestion from packet loss and from
  link outages.
- Full-jitter exponential backoff; authentication failures stop rather than spin.
- HTTP sync server with Server-Sent Events, bearer auth and static hosting.

### Evaluation

- Discrete-event network simulator with latency, jitter, bandwidth, directional
  loss and outages that interrupt requests in flight.
- Six scenarios covering bandwidth, convergence time, partition recovery,
  replica scaling, batch sizing and metadata overhead.
- The baseline is the same engine with the codec swapped, not an estimate.

### Known gaps

- Snapshots do not intern identifiers, so an uncollected snapshot is larger
  than the encoded log.
- Metadata is linear in replica count; an idle sync is 401 bytes at 32 replicas.
- No end-to-end encryption and no per-document authorisation.
- No measurement on real mobile hardware.
