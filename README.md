# Rivulet

**An offline-first database that synchronises over networks that barely work.**

Rivulet is a CRDT-based sync engine for applications whose users are regularly
disconnected, on a metered connection, or behind a link with half-second round
trips. Writes land in a local database and return immediately; reconciliation
happens when the network allows, and concurrent edits merge without anyone
being asked to choose.

Zero runtime dependencies. Runs in Node and in the browser from the same source.

```js
const client = await RivuletClient.open({ schema, room: 'notebook', transport });

const id = client.mutate((tx) => tx.create('notes', { title: 'Hello' }));
client.get('notes', id);                    // reads back immediately, online or not
client.subscribe('notes', render);          // re-renders on local and remote change
```

There is no `await` on the network in any of that, and no error to handle at the
call site. Being offline is an expected condition, not a failure.

---

## Why this exists

The usual architecture -- request, wait, render -- fails badly in exactly the
conditions many people use software in. A shared access point at peak hours, a
mobile connection at the edge of coverage, a train tunnel. The application
stalls on a spinner, and if a write did go out but the response was lost, it may
be applied twice or silently dropped.

Making an app work offline is easy. Making it work offline *and* converge
correctly when several people edited the same thing is the hard part, and it is
where ad-hoc solutions -- last-write-wins on a timestamp, a "sync conflict" copy
of the file, a merge dialog -- lose data or push the problem onto the user.

Rivulet's position is that the merge should be settled by the data structure,
decided once per field by whoever designed the feature, and then never surfaced
again except where a human genuinely has to choose.

## What it does

| | |
|---|---|
| **Local-first** | Every write goes to local storage and is readable immediately. The network is never in the critical path of a keystroke. |
| **Converges without coordination** | Five CRDT types, chosen per field. Any delivery order, any duplication, any partition -- replicas that have seen the same operations agree. |
| **Survives a bad link** | One round trip per reconciliation, interrupted transfers resume rather than restart, and every retry is safe because pushes are idempotent. |
| **Frugal on the wire** | A keystroke costs ~22 bytes instead of ~210. Details in [Evaluation](#evaluation). |
| **Honest about conflicts** | Most merges are silent and correct. Where two people genuinely disagree, the field type can keep both and hand them to the UI. |

## Quick start

Requires **Node 22.5+** (for the built-in `node:sqlite`). Nothing to install.

```bash
git clone <this repo> && cd rivulet
npm test                                            # 187 tests, no dependencies
node --experimental-sqlite apps/cli/serve.js --demo # http://127.0.0.1:8787
```

Open the demo in two windows. Click **Go offline** in one, edit the same note in
both, then come back online. Nothing is lost and nothing asks you to choose.

```bash
node --experimental-sqlite bench/run.js             # reproduce the evaluation
node --experimental-sqlite bench/run.js bandwidth   # just one scenario
```

## Choosing a merge strategy

The schema is where the merge behaviour of each field is stated, once:

```js
const schema = defineSchema({
  notes: {
    title:    'lww',      // last writer wins -- a rename is atomic
    body:     'text',     // character-level merge -- nothing typed is lost
    tags:     'set',      // add-wins -- an offline tag survives a stale delete
    reads:    'counter',  // concurrent increments add up
    estimate: 'mv',       // keeps both values and lets the user decide
  },
});
```

| Type | Merge behaviour | Reach for it when |
|---|---|---|
| `lww` | Newest write wins, by hybrid logical clock | A status, a title, a flag. Losing the older value is fine. |
| `text` | Character-level merge (RGA) | Prose two people might edit at once. |
| `set` | Add-wins observed-remove set | Tags, labels, membership. Re-adding after removal works. |
| `counter` | Increments and decrements sum | Votes, views, stock. **Never** model a count as `lww`. |
| `mv` | Keeps concurrent values | A number where a silently discarded edit would be expensive. |
| `seq` | Ordered list, position-free | Checklists, ordered items. |

Fields are independent, so two people editing *different* fields of the same
record never contend at all.

## How it works

```
   your app
      │  mutate(tx => …)                      reads are synchronous
      ▼
 ┌─────────────┐   operations   ┌───────────┐   delta sync   ┌──────────┐
 │  Database   │ ─────────────▶ │  Op log   │ ◀────────────▶ │  Server  │
 │ CRDT fields │ ◀───────────── │  SQLite / │   one RTT      │  op log  │
 └─────────────┘   remote ops   │ IndexedDB │                └──────────┘
                                └───────────┘
```

- **Causality** is tracked with [hybrid logical clocks](docs/02-crdt-design.md):
  correct ordering that also stays close to real time, so last-writer-wins
  survives skewed device clocks.
- **Sync** exchanges [version vectors](docs/03-sync-protocol.md). A peer says
  what it has in a few dozen bytes; the other side replies with exactly what is
  missing. No full-state transfer, no per-record comparison.
- **Delivery** is at-least-once and unordered. The op log de-duplicates by
  `(node, seq)`, so the CRDTs need only be commutative -- and a retry after a
  lost response costs a duplicate transfer and nothing else.

Further reading: [architecture](docs/01-architecture.md) ·
[CRDT design](docs/02-crdt-design.md) ·
[sync protocol](docs/03-sync-protocol.md) ·
[storage](docs/04-storage.md) ·
[evaluation method](docs/05-evaluation.md)

## Evaluation

Measured with the simulator in `bench/`, which models latency, jitter,
bandwidth, directional packet loss and recurring outages. Timings are simulated
and reproducible given a seed. The baseline is *the same engine* with plain-JSON
operations, over the same simulated link -- not an estimate.

**Wire cost per operation** (uncompressed, against plain JSON):

| Workload | Plain JSON | Rivulet | |
|---|--:|--:|--:|
| Typing prose | 210 B | 22.1 B | −89% |
| Scattered single writes (worst case) | 174 B | 36.0 B | −79% |
| Bulk import | 210 B | 24.2 B | −88% |
| Mixed collaborative | 208 B | 24.7 B | −88% |

With DEFLATE on top, the full pipeline is 31–44% smaller than simply gzipping
the naive encoding — which is the alternative actually worth beating.

**Time for an edit to reach another device**, two replicas:

| Network | Baseline | Rivulet | Speed-up |
|---|--:|--:|--:|
| LAN | 1.52 s | 1.51 s | 1.01× |
| Broadband (25 ms) | 1.80 s | 1.76 s | 1.03× |
| Satellite (600 ms RTT, 5 Mbps) | 7.73 s | 7.53 s | 1.03× |
| Shared wifi (2 Mbps) | 2.91 s | 2.41 s | 1.20× |
| Mobile 3G (1 Mbps) | 4.68 s | 3.70 s | 1.27× |
| Edge-of-coverage (128 kbps) | 16.49 s | 7.45 s | **2.21×** |

Median of 5 seeds. 94% fewer bytes on every row. The pattern is the honest one:
where bandwidth is plentiful the encoding barely matters and the gain comes from
the single-round-trip protocol; where bandwidth is the constraint, the encoding
is nearly the whole story. Satellite is the clearest case — 600 ms round trips,
but 5 Mbps, so saving bytes buys almost nothing.

**Offline reconciliation.** Four replicas, ten shared documents, all edits made
while disconnected. Every set addition and text insertion is verified
individually in the converged state, and every concurrent increment is checked
to have been summed:

| Edits made offline | Catch-up | Traffic | Bytes/edit | Lost |
|--:|--:|--:|--:|--:|
| 20 | 1.8 s | 8.5 kB | 426 B | 0 |
| 100 | 1.9 s | 16.4 kB | 164 B | 0 |
| 400 | 22.3 s | 39.0 kB | 98 B | 0 |
| 1600 | 22.7 s | 121.3 kB | 76 B | 0 |

Median of 5 seeds; the lost-edit column is a total across all runs, because a
single lost edit is a failure and not something to average away. The jump at 400
edits is the shared-wifi profile's recurring 15-second outage: past a certain
size the catch-up no longer fits in one window between outages.

Full tables, including the ablation of each encoding technique and the cases
where this design does *worse*, are in
[`bench/results/`](bench/results/) and in [the paper](paper/paper.md).

## Limitations

Stated plainly, because they bound where this is the right tool:

- **Tombstones.** Deleted characters are retained until collection is provably
  safe. Under a deliberately hostile rewrite workload they outnumber live
  characters by up to 759×. Collection recovers 97–99.9%, but requires knowing
  what every replica has seen.
- **Metadata grows with replica count.** A version vector has an entry per
  replica: an idle sync request is 125 B at 2 replicas and 401 B at 32. Fine for
  a team, not for a document shared with a hundred thousand people.
- **The snapshot format does not intern identifiers**, so an uncollected
  snapshot is slightly *larger* than the encoded log. Collected, it is 96–99.7%
  smaller. Applying the codec's interning to snapshots is unfinished work.
- **Adaptive batching does not beat a well-chosen constant.** It gets within
  1.29–1.71× of the best fixed size without being told which network it is on,
  while the worst plausible fixed choice is 2.2–286× off. If you know your
  network, hard-code the number.
- **No end-to-end encryption, and no per-document authorisation.** The server
  sees plaintext operations, and auth is a single bearer token per deployment.
- **Text merging is character-level, not intent-level.** Two people rewriting
  the same sentence get a correct merge that may still read badly. No CRDT
  fixes that; it is why `mv` exists.

## Project layout

```
src/core/       clocks, version vectors, CRDT types, document model
src/protocol/   operation codec, messages, framing, compression
src/storage/    adapter contract + memory, SQLite and IndexedDB backends
src/client/     sync engine, adaptive batching, transports
src/server/     sync server core and its HTTP/SSE transport
bench/          network simulator and the evaluation scenarios
apps/           demo notebook and the server CLI
docs/           design documents and decision records
paper/          the write-up
```

## Testing

```bash
npm test              # everything
npm run test:core     # CRDT laws and core data structures
```

The CRDT types are checked against their algebraic laws by generating
operations and delivering them in many random permutations, asserting
convergence, commutativity, idempotence and snapshot/replay parity. A failing
seed is printed and replays exactly. The three storage adapters are held to a
single shared conformance suite, including the browser one, which runs against
an in-process IndexedDB double.

## Licence

MIT. See [LICENSE](LICENSE).
