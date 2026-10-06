# CRDT design

## Why not just use timestamps

The tempting shortcut is: put `updatedAt` on every record, and on conflict keep
the newer one. It fails in three separate ways, and each failure is silent.

1. **Device clocks are wrong.** A phone whose clock is five minutes fast wins
   every conflict for five minutes, including against writes that causally
   *followed* it. A clock that jumps backwards after an NTP correction loses
   writes it should have won.
2. **Whole-record granularity destroys concurrent edits.** Two people editing
   different fields of the same record produce a "conflict" where none exists.
3. **Some values must not be overwritten at all.** Two devices each read a
   counter at 5 and add 1. Last-write-wins gives 6. The answer is 7.

Each of the three has a specific answer here.

## Hybrid logical clocks

A [hybrid logical clock](https://cse.buffalo.edu/tech-reports/2014-04.pdf)
(Kulkarni et al.) is a correct logical clock whose value stays within a bounded
distance of physical time.

It gives what a Lamport clock gives — if event A causally precedes B then
`ts(A) < ts(B)` — while remaining usable for anything that needs real time, like
sorting a feed or showing "edited 5m ago".

The encoding is a fixed-width, lexicographically sortable string:

```
<12 hex: wall ms> "-" <4 hex: counter> "-" <16 hex: node id>
018bcfe56800-0003-a1b2c3d4e5f60718
```

Fixed widths mean `a < b` on the raw strings is exactly `compare(a, b) < 0`, so
SQLite and IndexedDB can order by the timestamp column with no custom collation.

Two properties matter downstream:

- **Monotonicity survives a backwards clock jump.** `now()` never returns a
  value less than or equal to one it has already issued, even if the operating
  system moves time backwards underneath it.
- **The node id makes the order total.** Two genuinely concurrent writes get a
  deterministic, replica-independent winner. Without that, last-writer-wins has
  no defined answer for a tie, and replicas can disagree.

A remote timestamp more than `maxDriftMs` ahead is rejected rather than
absorbed, so one badly-set device cannot drag the whole system's clock forward.

## Per-field merge

A document is a map of independent CRDTs, one per field, typed by the schema.
Two people editing different fields never contend. Only writes to the *same*
field can conflict, and the field's type decides what happens.

The schema is where that decision is recorded, once, by the person designing the
feature — because it is a product decision, not a technical one. "Two people
renamed this note offline" and "two people edited this note's body offline" want
completely different answers.

## The five types

### `lww` — last-writer-wins register

Holds one value; concurrent writes resolve by HLC timestamp with the node id as
tiebreak. Every replica picks the same winner because that order is total and
computed purely from the operations.

The honest caveat: it *discards* the loser. Right for a title or a status flag,
wrong where a lost edit is expensive.

### `mv` — multi-value register

Keeps every concurrently-written value and hands the set to the application.

A write names the sibling timestamps it observed and therefore replaces. A value
survives until some write that saw it supersedes it — so writes that never saw
each other all stay, and the set collapses to one value on its own as soon as
someone writes after seeing them.

This is the type to use when asking the user is better than silently picking.

### `counter` — PN-counter

Per-replica running totals, positive and negative tracked separately. Increments
from different replicas add up rather than overwrite.

Keeping the halves separate means each only ever grows, so merging two states is
a pointwise maximum — which is what makes the snapshot path safe to apply
repeatedly.

This is the one type that is not idempotent under `apply`; see the layering note
in [architecture](01-architecture.md).

### `set` — observed-remove set (add-wins)

Every add gets a unique tag. A remove deletes only the tags it *observed*, so an
add the remover never saw survives.

That gives add-wins semantics: the forgiving default. A user who re-adds a tag
offline does not lose it to someone else's stale delete, and re-adding after a
remove always works because it mints a fresh tag.

Tags are HLC timestamps, so they are unique without costing extra bytes.

### `seq` / `text` — RGA

Indices cannot be synchronised. If I insert at position 3 while you delete
position 1, my index means something different by the time my operation reaches
you.

So no operation mentions a position. An insert names the *identity* of the
element it goes after; a delete names the identity of its target. Identities
never shift, so an operation means the same thing whenever it arrives.

Elements form a tree, and reading the document is a depth-first walk. The only
real question is how to order elements inserted after the same neighbour — two
people typing at the same spot. RGA sorts those siblings by descending identity.

Implemented, that is a forward scan skipping every element whose id exceeds the
new one. This works because ids are HLC timestamps and a replica must have seen
an element before inserting after it, so a child's id always exceeds its
parent's. An entire subtree therefore sits above its root in id order, and one
flat comparison skips the whole subtree at once.

**Out-of-order arrival.** An insert whose neighbour has not arrived cannot be
placed, so it waits in a pending table keyed by that neighbour and replays —
transitively — the moment it shows up. This is the only type needing causal
context, and it resolves that itself, so the sync layer never has to enforce
causal delivery. Because the HLC timestamp embeds the unique replica identity,
sibling inserts at the exact same logical tick break ties deterministically,
producing identical character sequences across all peers.

## Tombstones and collection

Deleted elements become tombstones rather than disappearing, because a
concurrent insert may still name one as its neighbour.

They can be reclaimed, but only below a **causally stable** timestamp — one
every replica has seen, so no replica can still be composing an operation
against a newer view. Collection leaves a redirect so an operation that still
names a collected tombstone is rebased onto its surviving predecessor. The
redirects themselves may be dropped after a second stability round.

The cost is real and measured: under a deliberately hostile rewrite workload,
tombstones outnumber live characters by up to 759×. Collection recovers
97–99.9%. Numbers in [evaluation](05-evaluation.md).

## How convergence is established

Not by inspection. The types are checked against their algebraic laws by
generating operations and delivering them to independent replicas in
independently shuffled orders:

- **commutativity** — `apply(a); apply(b)` equals `apply(b); apply(a)`
- **associativity** — merge grouping does not matter
- **idempotence** — re-applying changes nothing (every type but the counter)
- **convergence** — any delivery order of the same operation set agrees
- **snapshot parity** — merging states equals replaying operations

A failing seed is printed and replays exactly, which turns a flaky distributed
bug into a deterministic one. See `test/helpers/crdt-laws.js`.
