# Architecture

## The constraint that shapes everything

The system is designed for networks that are *usually* absent and *sometimes*
terrible. Not "mostly fine with occasional blips" — genuinely unavailable for
minutes at a time, and when present, capped, contended, and high-latency.

That single assumption eliminates most of the usual design space:

- **No read path through the network.** If a read can block on the network, the
  application is unusable while disconnected. So all reads are local and
  synchronous, and the local store must hold everything the user can see.
- **No write path through the network either.** A write that waits for
  acknowledgement is a write that fails when the network does. So writes commit
  locally and are reconciled later.
- **No server-side conflict resolution.** The server may not have heard from a
  replica for days. Anything that requires all parties present to decide an
  outcome cannot be part of the design.
- **No assumption of ordered or exactly-once delivery.** The transport can lose,
  duplicate, reorder and truncate. Everything above it must tolerate that.

What is left is: replicate an operation log, merge with a data structure that
does not need coordination, and make the wire format cheap.

## Layers

```
┌──────────────────────────────────────────────────────────────┐
│ application                                                  │
│   client.mutate(tx => …)            client.subscribe(…)      │
├──────────────────────────────────────────────────────────────┤
│ RivuletClient          identity, restart recovery, write queue│
├───────────────────────────────┬──────────────────────────────┤
│ Database                      │ SyncEngine                   │
│   documents of CRDT fields    │   batching, backoff, status   │
│   transactions → operations   │   one round trip per sync     │
├───────────────────────────────┼──────────────────────────────┤
│ OpLog                         │ Protocol                     │
│   exactly-once, frontier,     │   codec, messages, framing,  │
│   outbox watermark            │   compression                │
├───────────────────────────────┼──────────────────────────────┤
│ StorageAdapter                │ Transport                    │
│   memory · SQLite · IndexedDB │   HTTP+SSE · loopback · sim  │
└───────────────────────────────┴──────────────────────────────┘
```

Each layer has one job and knows nothing about the layers beside it. The
`Database` has never heard of a network; the `SyncEngine` has never heard of
SQLite; the CRDT types have never heard of either.

That separation is what makes the evaluation possible: the benchmarks swap the
transport for a simulated link and the codec for a naive baseline, and nothing
else in the stack changes.

## The unit of replication

An **operation** is the only thing that crosses a boundary:

```js
{ node, seq, ts, collection, doc, field, payload }
```

It is immutable, self-contained, and addressed by *identity* rather than
position. Nothing in it depends on the receiver's current state, which is what
lets it be stored, replayed, batched, resent after a three-day outage, and
applied in any order.

`(node, seq)` is the primary key, with sequence numbers dense from 1. That
choice pays for itself repeatedly:

- De-duplication is the storage engine's primary-key constraint, not our code.
- "What am I missing?" is an integer comparison per replica, not a diff.
- A peer can describe everything it holds in a few dozen bytes.

## Where each guarantee comes from

| Guarantee | Mechanism | Lives in |
|---|---|---|
| A write is never lost | Local commit before anything else | `Database`, `OpLog` |
| Replicas converge | Commutative, associative merge | `src/core/crdt/` |
| An operation applies once | `(node, seq)` primary key | `OpLog` |
| A retry is safe | Idempotent push + watermark | `SyncEngine`, `SyncServer` |
| Partial transfers resume | Frontier doubles as cursor | `OpLog`, protocol |
| Clocks can be wrong | Hybrid logical clocks | `src/core/hlc.js` |
| Restart is safe | Persisted identity, seq and clock | `RivuletClient.open` |

## The layering that makes counters possible

Worth stating explicitly, because it is the one place where a layer's
correctness depends on another's:

CRDT types here are **commutative and associative but not necessarily
idempotent**. A PN-counter that applied the same increment twice would
double-count.

That is safe because the operation log guarantees each `(node, seq)` reaches
`apply` exactly once, using a structure that compacts to O(1) per replica. The
alternative — making every type idempotent — would mean a second, unbounded set
of seen identifiers inside each one.

The contract is written down in `src/core/crdt/contract.js` and checked by the
property tests, which run the counter without the idempotence law and every
other type with it.

## Restart correctness

Opening a client is not "load the data". Three things must be recovered or the
replica corrupts its own history:

1. **Identity**, minted once and reused forever. A replica that re-mints its id
   restarts sequence numbers at 1, and its new operation 1 collides with its old
   one.
2. **The sequence counter**, resumed from the highest operation held.
3. **The clock**, resumed past the highest timestamp ever issued, so a restart
   cannot mint a timestamp that loses to a write it happened after.

All three are persisted in the op log's metadata and restored in
`RivuletClient.open`. There is an integration test for each.

## What the server is

A replica that never writes. It holds the union of everyone's operations,
answers "what am I missing?", and notifies listeners that something changed. It
never merges, never resolves a conflict, and never rejects an operation for
disagreeing with another.

The consequence is that it is not a single point of correctness. If it loses its
disk, every client still holds its own operations and the union reassembles on
the next sync. Losing the server costs availability, not data.

It *is* a single point of authority for one thing: it rejects operations
attributed to a replica other than the sender, so one client cannot forge
another's history or block its sequence numbers.
