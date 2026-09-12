---
title: "Implementing CRDT-Based Database Synchronisation for Low-Bandwidth and High-Latency Environments"
author: Shreshth Mishra
date: 2026
abstract: |
  Applications built on the request–response model degrade badly on the networks
  many people actually use: shared access points at peak hours, mobile data at
  the edge of coverage, links that disappear for minutes at a time. We present
  Rivulet, an offline-first database synchronisation engine in which every write
  commits to local storage and reconciliation happens opportunistically, with
  concurrent edits merged by conflict-free replicated data types rather than by
  a server or a user. The contribution is not the CRDTs, which are standard, but
  the transport that carries them: a columnar operation codec combining
  dictionary interning, delta-encoded causality and in-batch reference
  substitution, paired with a single-round-trip resumable protocol and a
  batch-size controller that distinguishes congestion from packet loss. Against
  an identical engine carrying plain-JSON operations over an identical simulated
  link, the codec reduces wire cost from 210 to 22.1 bytes per operation for
  text editing and from 174 to 36.0 bytes in its worst case, and remains 31–44%
  smaller than simply compressing the naive encoding. Convergence time improves
  by 2.21× on a 128 kbps link and by 1.01× on a LAN — a spread we report because
  it delimits where the work matters. Across four replicas editing shared
  documents entirely offline, all 792 individually-verified edits survived
  reconciliation in every run.
---

# 1. Introduction

The dominant architecture for collaborative applications assumes the network is
present. A user acts, a request goes out, the server decides, the interface
updates. When the network is absent the interface stalls; when it is merely poor
the interface stalls intermittently, which is worse, because the user cannot
tell whether their work was saved.

For a large fraction of users this is the normal condition rather than the
exception. A shared access point in a hostel or dormitory at nine in the evening
is contended to the point of unusability. Mobile data at the edge of coverage
has half-second round trips, a few percent packet loss, and a cap that makes
every byte a cost. A train tunnel removes the network entirely for minutes.

Making an application *work* offline is not difficult: write locally, queue the
changes, replay them later. The difficulty is what happens when two people
changed the same thing while both were disconnected. The common answers all
fail: last-write-wins on a device timestamp silently discards work and is
vulnerable to clock skew; producing a "conflicting copy" of the document pushes
the problem onto the user; a merge dialog interrupts them at the worst moment.

Conflict-free replicated data types [@shapiro2011] solve the merge problem
properly: replicas that have received the same operations converge, without
coordination, in any delivery order. They are well understood, and mature
implementations exist [@automerge; @yjs].

What is less well addressed is the cost of *getting the operations there* on the
networks that motivate offline-first in the first place. A CRDT operation log is
verbose — recording one keystroke as JSON takes around 200 bytes, almost none of
which is the keystroke — and a protocol designed for a datacentre link behaves
badly at 500 ms RTT with a 5% loss rate.

This paper describes a complete engine built around that transport problem, and
evaluates it against a measured baseline rather than an estimated one.

## 1.1 Contributions

1. **A columnar operation codec** (§4) combining four transformations —
   dictionary interning, columnar layout with run-length encoding,
   delta-encoded causality with timestamps derived from the node column, and
   substitution of in-batch timestamp references by integer indices. We report
   an ablation isolating each.
2. **A single-round-trip, resumable sync protocol** (§5) in which a version
   vector serves as both the "what am I missing" query and the resumption
   cursor, so an interrupted transfer resumes rather than restarting.
3. **A batch-size controller** (§5.3) that distinguishes congestion from packet
   loss and from link outages, using signals a real client has. We show that
   conflating them costs an order of magnitude on a lossy link.
4. **An evaluation** (§6) in which the baseline is the same engine over the same
   simulated link with only the encoding changed, and in which correctness is
   verified per-edit rather than assumed.
5. **A reproducible artefact**: zero runtime dependencies, 187 tests, a seeded
   network simulator, and every reported figure regenerable by one command.

# 2. Background and related work

**CRDTs.** Shapiro et al. [@shapiro2011] formalise two families: state-based
(CvRDT), where replicas exchange states merged by a join-semilattice, and
operation-based (CmRDT), where replicas exchange operations that must commute.
We use operation-based types with a state-based merge path for snapshots, and
require commutativity and associativity but not idempotence — see §3.3.

**Sequence CRDTs.** Ordering concurrent insertions into a shared sequence is the
hard case. RGA [@roh2011] assigns each element an identifier and orders siblings
sharing an insertion point by descending identifier. Logoot and LSEQ
[@weiss2009; @nedelec2013] use dense position identifiers instead, trading
tombstones for identifier growth. We use RGA, for the reason given in §3.2.

**Hybrid logical clocks.** Kulkarni et al. [@kulkarni2014] combine a logical
clock with physical time, preserving the happens-before relation while staying
within a bounded distance of wall time. This matters for last-writer-wins
semantics on consumer devices, whose clocks are routinely wrong.

**Production systems.** Automerge [@automerge] and Yjs [@yjs] are mature CRDT
libraries; Yjs in particular has a highly optimised binary encoding. Our codec
is not claimed to beat it. The difference in emphasis is that we treat the
*network profile* as the primary design constraint and evaluate against
explicitly stated link models, including outages that interrupt requests in
flight. Systems such as Couchbase Mobile and PouchDB/CouchDB provide offline
sync with revision trees rather than CRDTs, surfacing conflicts to the
application to resolve.

**Delta synchronisation.** Almeida et al. [@almeida2018] show how to ship
deltas instead of full states for state-based CRDTs. Our operation log with
version-vector exchange achieves a similar effect for the operation-based case,
and §5.1 describes why only the contiguous prefix of a replica's history may be
advertised.

# 3. Data model

## 3.1 Per-field CRDTs

A document is a map of independent CRDTs, one per field, with the type declared
in a schema:

```js
notes: {
  title:    'lww',      // last writer wins
  body:     'text',     // character-level merge (RGA)
  tags:     'set',      // add-wins observed-remove set
  reads:    'counter',  // PN-counter
  estimate: 'mv',       // multi-value register
}
```

Two consequences follow. First, concurrent edits to *different* fields never
contend, which removes a large class of conflicts that whole-record merging
manufactures. Second, the merge strategy becomes an explicit, reviewable
decision made once by whoever designs the feature — which is correct, because it
is a product decision. "Two people renamed this note" and "two people edited
this note's body" want different answers, and no single strategy is right for
both.

The cost is that choosing badly is possible. Modelling a count as `lww` loses
increments; we document that case explicitly rather than trying to prevent it.

## 3.2 Sequences without positions

Indices cannot be synchronised: if one replica inserts at position 3 while
another deletes position 1, the index means something different by the time the
operation arrives. Our sequence operations therefore name identities — an insert
names the element it follows, a delete names its target — so an operation means
the same thing whenever it arrives.

Elements form a tree; reading is a depth-first walk. Siblings sharing an
insertion point are ordered by descending identifier. Because identifiers are
HLC timestamps and a replica must have observed an element before inserting
after it, a child's identifier always exceeds its parent's. An entire subtree
therefore sits above its root in identifier order, and the insertion scan
reduces to skipping forward while the next identifier exceeds the new one — one
comparison skips a whole subtree.

An insert whose neighbour has not yet arrived is buffered against that
neighbour and replayed transitively when it appears. This is the only type
requiring causal context, and it resolves that internally, so the sync layer
never has to enforce causal delivery.

RGA retains tombstones. We chose it over dense-identifier schemes because the
tombstone cost is bounded, measurable and collectable (§6.5), whereas identifier
growth is unbounded and harder to reason about under adversarial editing.

## 3.3 The de-duplication layering

Operations arrive at-least-once and unordered. Rather than requiring every type
to be idempotent, exactly-once delivery is guaranteed by the operation log,
which keys operations by `(node, seq)` using a structure that compacts to O(1)
per replica in steady state — a structure the sync protocol needs anyway.

This is what makes the PN-counter possible: a counter cannot be idempotent under
increment. Requiring idempotence of every type would mean a second, unbounded
seen-set inside each one, paying twice for the same guarantee.

The dependency is load-bearing and is documented in both layers.

## 3.4 Causality

Each replica maintains a hybrid logical clock encoded as a fixed-width,
lexicographically sortable string:

```
018bcfe56800-0003-a1b2c3d4e5f60718
<-- 48-bit ms --> <ctr> <-- node id -->
```

Fixed widths make string comparison equivalent to timestamp comparison, so
SQLite and IndexedDB order by it without custom collation. The trailing node
identifier makes the order *total*, giving concurrent writes a deterministic,
replica-independent winner — without which last-writer-wins has no defined
answer for a tie and replicas can disagree.

Remote timestamps more than a configured drift bound ahead are rejected rather
than absorbed, so a single badly-set device cannot drag the system's clock
permanently forward.

# 4. Operation encoding

A batch of operations as plain JSON is heavily redundant. A single keystroke:

```json
{"node":"a1b2c3d4e5f60718","seq":41,
 "ts":"018bcfe56800-0003-a1b2c3d4e5f60718",
 "collection":"notes","doc":"9f3c1a7b22d0","field":"body",
 "payload":{"i":"w","p":"018bcfe567ff-0001-a1b2c3d4e5f60718"}}
```

Roughly 200 bytes to record one character. Four transformations address four
distinct redundancies.

**Dictionary interning.** Collection, document and field names repeat on every
operation in a batch; they are hoisted into tables and replaced by indices.

**Columnar layout.** All `seq` values are stored together, all `field` indices
together, and so on. Like values become adjacent, which makes them run-length
encodable and substantially more compressible by DEFLATE than the same data
interleaved row by row.

**Derived and delta-encoded causality.** An operation's HLC timestamp always
embeds the identifier of the replica that issued it — information already
present in the node column — so it is dropped and reconstructed at decode. What
remains is delta-encoded against a per-batch base; within one editing burst
these deltas are single digits. Sequence numbers, being dense, are almost always
a delta of exactly 1.

**In-batch reference substitution.** Operations refer to each other constantly:
every inserted character names its predecessor, every delete names its target,
every set removal names the tags it observed. When the referenced operation is
in the same batch — overwhelmingly common, because people type in runs — a
34-character timestamp becomes a small integer.

Only structural payload keys are rewritten, so application data that happens to
resemble a timestamp is never altered. The sequence root, which anchors every
insertion at position zero, has a reserved single-byte code.

All four transformations are individually switchable in the implementation, so
the ablation in §6.2 measures rather than asserts their contributions.

# 5. Synchronisation protocol

## 5.1 One round trip

At 500 ms RTT, a protocol that negotiates, then pushes, then pulls has spent
1.5 s before useful data moves. Rivulet carries the client's version vector and
its pending operations in a single message; the reply carries the
acknowledgement and everything the client is missing.

```
client ──  sync { have, push }  ─────────▶ server
       ◀── ack  { ok, you, pull, have, more } ──
```

The server applies the push before computing the pull, so a client that just
wrote does not receive its own operations back, and two clients syncing
simultaneously each see the other's work on the first round.

**The frontier is the cursor.** When a pull exceeds one response the server sets
`more` and the client re-issues `sync` with its advanced vector. There is no
server-side session to lose, so a connection that dies mid-transfer resumes
exactly where it stopped. Without this property a large initial sync on a link
that drops every few minutes can never complete.

**Only the contiguous prefix is advertised.** After a truncated transfer a
replica may hold `{1..20, 27..42}`. Advertising 42 would assert coverage of
21..26, and those operations would never be resent — silent, permanent loss that
no amount of CRDT merging recovers. The local store therefore tracks exact
ranges and advertises only the prefix; gaps heal because the next pull begins at
the hole and the resulting duplicates are discarded.

## 5.2 Idempotence

Every message is safe to retry, because `(node, seq)` is a primary key and an
already-stored operation is counted and ignored.

This is more important than it sounds. The genuinely awkward failure is not a
lost request but a lost *response* to a request the server fully processed. A
protocol without idempotent writes must distinguish those cases and cannot.
Here both are identical: retry, and the second attempt costs only bandwidth. Our
simulator models the two directions separately for this reason.

The client advances its outbox watermark only to `ack.you` — the server's
contiguous frontier for that client's own replica — never to what it hoped it
sent, so a partially accepted push retries exactly the remainder.

## 5.3 Adaptive batching

Fixed batch sizes fail in opposite directions. Small batches waste round trips
on a high-latency link; large ones produce requests that a flaky link cannot
finish, which then time out and retry from the beginning.

Our controller targets a round of roughly two seconds using TCP-like congestion
avoidance, with two refinements that the evaluation forced:

**Not every failure is congestion.** A dropped packet or an unreachable server
says nothing about how much a round can carry. Our first implementation treated
all failures alike; on a 5%-loss link this drove the batch size to its floor and
turned one transfer into hundreds of round trips. Only a timeout implicates
size.

**Not every timeout is congestion either.** A request cut short because the link
went down is indistinguishable from one that was too large — except in how long
it had been running. A round that died well before a typical round completes was
killed by the link, and backing off would leave the client permanently below
what the link carries fine once it returns. Both signals are available to a real
client.

The controller remembers the size that genuinely failed and approaches it
gently, relaxing that ceiling additively during sustained success.

# 6. Evaluation

## 6.1 Method

All network results come from a discrete-event simulator (`bench/netsim`)
modelling round-trip latency with jitter, bandwidth, packet loss split by
direction, and recurring outages that interrupt requests in flight. Simulated
time is advanced explicitly, and the engine receives its timer functions by
injection, so runs are deterministic given a seed.

| Profile | RTT | Jitter | Bandwidth | Loss | Outage |
|---|--:|--:|--:|--:|---|
| `lan` | 1 ms | 0 | 100 Mbps | 0 | — |
| `broadband` | 25 ms | 5 ms | 20 Mbps | 0.01% | — |
| `satellite` | 600 ms | 40 ms | 5 Mbps | 0.5% | — |
| `mobile-3g` | 200 ms | 100 ms | 1 Mbps | 1.5% | — |
| `hostel-wifi` | 80 ms | 120 ms | 2 Mbps | 3% | 15 s / 90 s |
| `mobile-edge` | 500 ms | 250 ms | 128 kbps | 5% | 20 s / 60 s |

**The baseline is measured.** It is the same engine, protocol, transport and
simulated link, with the codec replaced by plain-JSON operations and transport
compression disabled. The difference between rows is therefore attributable to
the encoding alone. Where the comparison is against "simply enable gzip", that
is reported separately, since it is the cheap alternative worth beating.

**Workloads.** Four are used and all four reported: *typing* (chained
single-character inserts — the best case for back-references), *form-filling*
(scattered single writes to unrelated documents — the worst case), *bulk-import*
(a first sync), and *collaborative* (several replicas, all field types).

**Variance.** Scenarios involving loss are stochastic; latency, partition and
batching run five seeds and report the median with the observed spread.
Correctness columns are totals, not medians.

## 6.2 Wire cost

Bytes per operation, uncompressed, against plain JSON:

| Workload | Ops | JSON/op | Codec/op | Reduction |
|---|--:|--:|--:|--:|
| typing | 400 | 209.7 B | **22.1 B** | 89.5% |
| form-filling | 120 | 174.3 B | **36.0 B** | 79.3% |
| bulk-import | 5 774 | 210.2 B | **24.2 B** | 88.5% |
| collaborative | 3 836 | 207.5 B | **24.7 B** | 88.1% |

With DEFLATE applied to both, the full pipeline remains **31–44% smaller** than
compressing the naive encoding (44.3% on typing, 31.0% on form-filling, 41.0% on
bulk-import, 43.4% on collaborative).

**Ablation** — bytes per operation with one transformation disabled:

| Variant | typing | form-filling | bulk-import | collaborative | Worst |
|---|--:|--:|--:|--:|--:|
| all four | 22.1 | 36.0 | 24.2 | 24.7 | — |
| no interning | 22.1 | 46.5 | 24.3 | 28.1 | +29% |
| no deltas | 25.8 | 39.1 | 29.0 | 29.2 | +20% |
| no back-references | 55.4 | 36.1 | 55.7 | 54.1 | **+151%** |
| no run-length | 33.9 | 45.5 | 36.8 | 36.5 | +53% |
| columnar only | 133.7 | 98.2 | 135.0 | 132.2 | +505% |

The transformations are complementary rather than redundant, and which one
dominates depends on the workload. Back-references carry text editing, where
every operation names its predecessor, but contribute *nothing* to form-filling,
where operations are mutually unrelated — the row is flat at 36.1 versus 36.0.
Interning is the reverse: worth 29% on scattered writes across many documents,
worth nothing when a single document is being typed into, because run-length
encoding has already collapsed the repeated column.

This is the argument for keeping all four rather than the single most effective
one: each covers a case in which another is useless.

## 6.3 Convergence time

Time for an edit on one replica to become visible on another, median of five
seeds:

| Profile | RTT | Bandwidth | Baseline | Rivulet | Speed-up | Bytes saved |
|---|--:|--:|--:|--:|--:|--:|
| lan | 1 ms | 100 Mbps | 1.52 s | 1.51 s | 1.01× | 93.7% |
| broadband | 25 ms | 20 Mbps | 1.80 s | 1.76 s | 1.03× | 93.7% |
| satellite | 600 ms | 5 Mbps | 7.73 s | 7.53 s | 1.03× | 93.7% |
| hostel-wifi | 80 ms | 2 Mbps | 2.91 s | 2.41 s | 1.20× | 93.7% |
| mobile-3g | 200 ms | 1 Mbps | 4.68 s | 3.70 s | 1.27× | 93.7% |
| mobile-edge | 500 ms | 128 kbps | 16.49 s | **7.45 s** | **2.21×** | 93.7% |

The bytes saved are constant; the time saved is not. Satellite is the
instructive row: 600 ms round trips, but 5 Mbps of bandwidth, so removing 94% of
the bytes buys 3%. Where bandwidth is the binding constraint the same saving is
worth 2.21×.

We report the LAN row deliberately. On a fast network this work is close to
pointless, and a reader should know that before adopting it.

## 6.4 Offline reconciliation

Four replicas, ten shared documents, all edits made while disconnected, then
reconnected. Each set addition and text insertion is verified individually in
the converged state; concurrent counter increments are checked to have summed.
Median of five seeds; lost-edit counts are totals across all runs.

| Edits offline | Operations | Catch-up | Traffic | Bytes/edit | Verified | Lost |
|--:|--:|--:|--:|--:|--:|--:|
| 20 | 86 | 1.80 s | 8.5 kB | 426 B | 11 | **0** |
| 100 | 287 | 1.94 s | 16.4 kB | 164 B | 53 | **0** |
| 400 | 944 | 22.27 s | 39.0 kB | 98 B | 201 | **0** |
| 1 600 | 3 924 | 22.66 s | 121.3 kB | 76 B | 792 | **0** |

Per-edit cost falls by 5.6× as volume rises, because dictionary and batch
overheads amortise. The discontinuity between 100 and 400 edits is the profile's
recurring 15-second outage: beyond a certain size the catch-up no longer fits
into one window between outages, so the tail waits out an outage. This is the
behaviour a real user on a contended access point experiences, and it is the
argument for resumable transfers rather than against them.

## 6.5 Metadata cost

A deliberately hostile workload — a short text field rewritten repeatedly, so
nearly every character written is later deleted — bounds tombstone growth:

| Revisions | Operations | Live chars | Tombstones | Ratio | State | After collection |
|--:|--:|--:|--:|--:|--:|--:|
| 50 | 5 602 | 84 | 2 759 | 32.8× | 127.8 kB | 3.6 kB (−97.2%) |
| 200 | 24 803 | 127 | 12 338 | 97.2× | 560.7 kB | 5.5 kB (−99.0%) |
| 800 | 110 507 | 145 | 55 181 | 380.6× | 2.49 MB | 6.2 kB (−99.7%) |
| 2 000 | 316 004 | 208 | 157 898 | 759.1× | 7.11 MB | 9.0 kB (−99.9%) |

Collection is safe only below a causally stable timestamp, and leaves redirects
so that an operation still naming a collected tombstone is rebased onto its
surviving neighbour. Text was verified intact after collection in every case.

An unflattering finding: an **uncollected** snapshot is 0.2–16% *larger* than
the encoded operation log, because the snapshot format stores identifiers in
full while the codec interns them. Compaction only pays once tombstones are
collected, after which the snapshot is 96.4–99.9% smaller than the log.
Applying the codec's interning to the snapshot format is unfinished work.

## 6.6 Scaling in replicas

Replicas each making 40 edits to 8 shared documents:

| Replicas | Total traffic | Per replica | Per edit | Idle sync request |
|--:|--:|--:|--:|--:|
| 2 | 4.4 kB | 2.20 kB | 54.9 B | 125 B |
| 4 | 10.3 kB | 2.57 kB | 64.1 B | 123 B |
| 8 | 32.8 kB | 4.10 kB | 102.5 B | 165 B |
| 16 | 107.5 kB | 6.72 kB | 167.9 B | 248 B |
| 32 | 365.1 kB | 11.41 kB | 285.2 B | 401 B |

Total traffic is quadratic in replica count, as it must be when every replica
receives every other's work. The number that bounds practical sharing is the
last column: a version vector carries an entry per replica, so a fully
caught-up replica still sends 401 bytes at 32 replicas. This is adequate for a
team and inadequate for a document shared with a hundred thousand people, which
delimits the design's applicability.

## 6.7 Batch sizing

Bulk transfer of 120 documents, median of five seeds, as a multiple of the best
fixed size for that network:

| Strategy | satellite | mobile-edge | hostel-wifi |
|---|--:|--:|--:|
| fixed 8 | 2.23× | 53.56× | 286.47× |
| fixed 64 | 1.71× | 23.31× | 33.44× |
| fixed 512 | 1.32× | 3.65× | 1.44× |
| fixed 2000 | 1.00× | 1.00× | 1.00× |
| **adaptive** | **1.71×** | **1.36×** | **1.29×** |

The honest reading: adaptation does **not** beat a well-chosen constant. On all
three profiles the largest fixed size wins. What adaptation provides is that it
is within 1.29–1.71× everywhere without being told which network it is on, while
the worst plausible fixed choice is 2.2–286× off. For a deployment whose network
is known, a hard-coded constant is the better engineering choice.

The `fixed 8` row on mobile-edge failed to converge within the simulation budget
in at least one seed — too many round trips, each exposed to 5% loss.

# 7. Implementation

Approximately 6 000 lines of JavaScript with **zero runtime dependencies**,
running unmodified in Node and in browsers. Node's built-in `node:sqlite`,
`node:test` and `node:http` cover storage, testing and transport, which keeps
the artefact reproducible without lockfile archaeology.

Three storage backends — in-memory, SQLite and IndexedDB — implement one narrow
adapter contract and are held to a single conformance suite. The browser adapter
is tested against an in-process IndexedDB double; shipping an untested adapter
to the target environment would be indefensible.

Correctness is established by property testing rather than inspection: each CRDT
type is checked for convergence, commutativity, idempotence (all but the
PN-counter) and snapshot/replay parity by generating operations and delivering
them in independently shuffled orders, with failing seeds replayable exactly.
187 tests in total.

## 7.1 Defects found by the evaluation

Three bugs were found by benchmarking rather than by testing, which we record
because each is a plausible mistake for anyone building the same thing:

1. **Timer truncation.** Delays above 2³¹−1 ms are silently truncated to a
   32-bit value, so a 4×10⁹ ms idle poll fired after 1 ms and turned the idle
   path into a continuous sync loop — expensive in exactly the setting the
   system targets.
2. **Stale in-flight rounds.** `sync()` originally returned an already-running
   round, which had begun before the caller's write existed and could therefore
   report "nothing to do" for work it had never seen.
3. **A rendering divergence.** An untouched text field rendered as `[]` rather
   than `""`, so two replicas with identical state displayed differently
   depending on local history. Found by a benchmark reporting non-convergence.

The batch controller's two refinements in §5.3 also originated as benchmark
results rather than as design.

# 8. Limitations and future work

- **The network model is a model.** Bufferbloat, TCP slow start, DNS failures
  and captive portals are not captured. Relative comparisons should hold;
  absolute timings are not predictions.
- **No real-device measurement.** IndexedDB throughput on a low-end phone,
  battery cost and behaviour under memory pressure are the figures that would
  determine practical usability, and none were measured.
- **Convergence is checked, not proven.** Property testing over many random
  schedules is strong evidence, not a proof. The types are standard with
  published correctness arguments; these implementations are not verified.
- **Security is minimal.** A bearer token per deployment, operations constrained
  to their sending replica, and nothing else. No end-to-end encryption, no
  per-document authorisation. The server sees plaintext.
- **Metadata is linear in replica count**, bounding practical sharing (§6.6).
  Compressed vector encodings or server-assigned sequence positions would
  extend that bound.
- **Snapshots do not intern identifiers** (§6.5), the single clearest piece of
  unfinished work.
- **Text merging is character-level, not intent-level.** Two people rewriting
  the same sentence receive a correct merge that may read badly. No CRDT solves
  this; it is why a multi-value type is offered.

# 9. Conclusion

Offline-first synchronisation is usually presented as a data-structure problem,
and the data structures are largely settled. We have argued that on the networks
that motivate offline-first, the remaining difficulty is transport, and that it
responds to ordinary engineering: exploit the redundancy in an operation log,
collapse the protocol to a single resumable round trip, and measure the link
rather than assuming it.

The results support that with an important qualification. Encoding reduces wire
cost by 79–89% and, where bandwidth binds, cuts convergence time by 2.21×; where
it does not bind, it changes almost nothing. Correctness held throughout — 792
individually verified edits survived reconciliation in every run of the offline
scenario — and the metadata costs are real, bounded and measurable. The honest
summary is that this work matters a great deal on a 128 kbps link and very
little on a LAN, which is precisely the claim we set out to test.

# References

<a id="shapiro2011"></a>[shapiro2011] M. Shapiro, N. Preguiça, C. Baquero, M. Zawirski.
*Conflict-free Replicated Data Types.* SSS 2011.

<a id="roh2011"></a>[roh2011] H.-G. Roh, M. Jeon, J.-S. Kim, J. Lee.
*Replicated Abstract Data Types: Building Blocks for Collaborative Applications.*
Journal of Parallel and Distributed Computing, 71(3), 2011.

<a id="kulkarni2014"></a>[kulkarni2014] S. Kulkarni, M. Demirbas, D. Madappa,
B. Avva, M. Leone. *Logical Physical Clocks and Consistent Snapshots in
Globally Distributed Databases.* OPODIS 2014.

<a id="weiss2009"></a>[weiss2009] S. Weiss, P. Urso, P. Molli.
*Logoot: A Scalable Optimistic Replication Algorithm for Collaborative Editing
on P2P Networks.* ICDCS 2009.

<a id="nedelec2013"></a>[nedelec2013] B. Nédelec, P. Molli, A. Mostefaoui,
E. Desmontils. *LSEQ: An Adaptive Structure for Sequences in Distributed
Collaborative Editing.* DocEng 2013.

<a id="almeida2018"></a>[almeida2018] P. S. Almeida, A. Shoker, C. Baquero.
*Delta State Replicated Data Types.* Journal of Parallel and Distributed
Computing, 111, 2018.

<a id="automerge"></a>[automerge] M. Kleppmann et al. *Automerge.*
https://automerge.org

<a id="yjs"></a>[yjs] K. Jahns. *Yjs: A CRDT framework.* https://yjs.dev

---

**Artefact.** Source, tests and the complete evaluation harness accompany this
paper. All figures regenerate with:

```bash
npm test
node --experimental-sqlite bench/run.js --all --out bench/results
```
