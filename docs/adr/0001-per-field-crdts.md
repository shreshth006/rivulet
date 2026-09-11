# 1. Per-field CRDTs, chosen in the schema

**Status:** accepted

## Context

A record edited concurrently has to merge somehow. The options are
whole-record (pick a winner), per-field with a fixed strategy, or per-field with
a declared strategy.

## Decision

Each field is an independent CRDT whose type is declared in the schema.

## Why

Whole-record last-writer-wins manufactures conflicts that do not exist: two
people editing different fields of the same record have not disagreed about
anything, and discarding one of them is pure loss.

A single fixed per-field strategy is not possible either, because the right
merge is a *product* decision. "Two people renamed this note" and "two people
edited this note's body" want different answers, and only the person designing
the feature knows which. Forcing one strategy means being wrong somewhere.

Putting it in the schema makes the decision explicit, reviewable, and stated
once — rather than implied by whichever merge code happens to run.

## Consequences

- Concurrent edits to different fields never contend.
- The schema becomes a compatibility surface; a fingerprint is exchanged at
  connect time so a version skew is a clear error rather than operations that
  silently do nothing.
- Choosing badly is possible — modelling a counter as `lww` loses increments.
  The documentation names that case explicitly.
