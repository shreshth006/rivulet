# Changelog

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
