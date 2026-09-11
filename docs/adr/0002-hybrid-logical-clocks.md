# 2. Hybrid logical clocks, not wall time or Lamport counters

**Status:** accepted

## Context

Last-writer-wins needs a total order over writes. Version vectors give the
causal order but not a total one, and the system needs a deterministic winner
for genuinely concurrent writes.

## Decision

Hybrid logical clocks (Kulkarni et al., 2014), encoded as fixed-width
lexicographically sortable strings, with the replica id as the final tiebreak.

## Why

**Not wall time.** Device clocks are skewed and jump. A phone five minutes fast
wins every conflict for five minutes, including against writes that causally
followed it — silent data loss with no way to detect it after the fact.

**Not a Lamport counter.** Correct, but the values drift arbitrarily far from
real time, which makes them useless for anything the product needs: sorting a
feed, showing "edited 5m ago", or debugging.

An HLC gives both: causally correct, and within a bounded distance of physical
time as long as clocks are roughly synchronised.

## Consequences

- Fixed-width encoding means string comparison *is* timestamp comparison, so
  SQLite and IndexedDB order by it with no custom collation.
- The replica-id tiebreak makes the order total, so concurrent writes have a
  deterministic, replica-independent winner.
- A remote timestamp beyond `maxDriftMs` is rejected rather than absorbed, so
  one badly-set device cannot drag the system's clock forward permanently.
- Clocks must be persisted across restarts, or a restart can mint a timestamp
  that loses to a write it happened after.
