# 4. De-duplication lives in the operation log, not in each CRDT

**Status:** accepted

## Context

Operations arrive at-least-once and unordered. Something must ensure an
operation is applied once. Either each CRDT type is idempotent, or a layer below
guarantees exactly-once delivery to them.

## Decision

The operation log de-duplicates by `(node, seq)`. CRDT types are required to be
commutative and associative, but not necessarily idempotent.

## Why

The log already tracks exactly which `(node, seq)` pairs a replica holds, in a
structure that compacts to O(1) per replica in steady state, because the sync
protocol needs that anyway. De-duplication is free there.

Pushing idempotence down into every type would mean a second, unbounded set of
seen identifiers inside each one — paying twice for the same guarantee.

It also makes the PN-counter possible at all. A counter cannot be idempotent
under increment; replaying an operation would double-count. It is safe here
precisely because of this layering.

## Consequences

- The contract is written down in `src/core/crdt/contract.js` and checked by the
  property tests, which run the counter without the idempotence law and every
  other type with it.
- Anyone adding a CRDT type must read that contract. A type that quietly assumes
  idempotence would be wrong in a way the tests would catch, but only if the new
  type is added to the law suite.
- The log's correctness is load-bearing for the counter's correctness. That
  dependency is documented in both places.
