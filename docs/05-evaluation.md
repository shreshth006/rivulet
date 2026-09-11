# Evaluation method

## What is being claimed

Three things, and they should be judged separately:

1. **Correctness.** Replicas that have seen the same operations agree, and no
   edit made offline is lost.
2. **Bandwidth.** A change costs substantially fewer bytes than the obvious
   implementation, and fewer than simply compressing the obvious implementation.
3. **Time.** Those saved bytes become saved time on the networks this targets —
   and, honestly, barely matter on the ones it does not.

## How correctness is established

Not by running the system and observing that it seemed fine.

**Algebraic laws.** Each CRDT type is checked by generating operations across
several replicas and delivering the whole set to independent replicas in
independently shuffled orders, asserting they agree. Also commutativity,
idempotence (every type but the PN-counter, which the op log de-duplicates
instead), and parity between merging states and replaying operations. A failing
seed prints and replays exactly.

**Storage conformance.** One suite, three adapters, including the browser one
against an in-process IndexedDB double.

**End-to-end convergence.** Every network scenario checks that all replicas hold
byte-identical state at the end, not merely that the run finished without error.

**Per-edit verification.** The partition scenario records every edit with a
defined survival requirement — a set addition, a text insertion — and checks
each one individually in the converged state, plus that concurrent counter
increments summed rather than overwrote.

Edits with *no* defined survival requirement are deliberately excluded: one of
two concurrent last-writer-wins titles is supposed to disappear, and counting
that as loss would make the benchmark measure the wrong thing.

## The simulator

Real networks are not reproducible, and a three-minute partition on a
500 ms-RTT link should not take three minutes to test. So the evaluation runs
against a model, in virtual time, seeded.

`bench/netsim` models four things:

| | Why it is modelled |
|---|---|
| **Latency with jitter** | Jitter is why a protocol cannot pipeline around latency: request times vary, so a fixed batch size is either too cautious or too optimistic. |
| **Bandwidth** | Transmission time scales with bytes actually sent, which is what makes the codec's savings show up as *time*. |
| **Loss, split by direction** | A lost request the server never saw and a lost *response* to a request it fully processed are different failures. The second is the one that breaks naive protocols. |
| **Outages, including mid-request** | A request in flight when the window opens is cut, not waved through. Without this, an arbitrarily large batch is never punished and the simulation would recommend the largest possible request. |

Simulated time is a number the clock advances; events run in timestamp order
with the real microtask queue drained between them. The engine under test
receives `setTimeout` and `now` by injection and cannot tell the difference.

### Profiles

| Profile | RTT | Jitter | Bandwidth | Loss | Outage |
|---|--:|--:|--:|--:|---|
| `lan` | 1 ms | 0 | 100 Mbps | 0 | — |
| `broadband` | 25 ms | 5 ms | 20 Mbps | 0.01% | — |
| `satellite` | 600 ms | 40 ms | 5 Mbps | 0.5% | — |
| `mobile-3g` | 200 ms | 100 ms | 1 Mbps | 1.5% | — |
| `hostel-wifi` | 80 ms | 120 ms | 2 Mbps | 3% | 15 s every 90 s |
| `mobile-edge` | 500 ms | 250 ms | 128 kbps | 5% | 20 s every 60 s |

These are a *model*, drawn from commonly reported figures for each link type,
not a capture of any specific network. The point is a reproducible spread from
excellent to barely usable, with the two bottom rows representing the conditions
this work is aimed at.

## The baseline is measured, not modelled

The comparison is the same engine, the same protocol, the same simulated link,
with the operation codec swapped for plain JSON and transport compression
disabled (`bench/lib/baseline.js`). So the difference between the two rows is
attributable to the encoding and nothing else — no estimated round trips, no
assumption about what a hypothetical baseline would have done.

Where the comparison is against "just turn on gzip", that is reported too, as a
separate column, because it is the cheap alternative actually worth beating.

## Workloads

Synthetic benchmarks are only as honest as their workloads. Four are used, and
all four are reported:

- **typing** — long runs of single-character inserts chained onto each other.
  The dominant real pattern, and the best case for back-references. Labelled as
  such.
- **form-filling** — scattered single writes to unrelated documents. Nothing to
  intern, nothing to chain. The worst case.
- **bulk-import** — a first sync, dominated by document identifiers.
- **collaborative** — several replicas, all field types, shared documents. The
  closest thing here to an average.

Quoting only `typing` would be choosing the number that flatters the design.

## Variance

Scenarios involving packet loss are genuinely stochastic: one run can be decided
by whether a single timeout landed inside an outage window. The latency,
partition and batching scenarios therefore run every configuration over five
seeds and report the **median**, with the observed spread alongside.

Correctness columns are *not* averaged. A single lost edit in any run is a
failure, so those are totals.

## Reproducing

```bash
node --experimental-sqlite bench/run.js --all --out bench/results
node --experimental-sqlite bench/run.js bandwidth --seed 42
```

Every scenario is deterministic given its seed. Results land as terminal tables,
JSON, Markdown and per-table CSV, all generated from one structure so a number
cannot be transcribed wrongly between the terminal and the write-up.

## Threats to validity

Stated so a reader can discount appropriately:

- **The network model is a model.** Real links have bufferbloat, TCP slow start,
  DNS failures, captive portals and middleboxes that none of this captures. The
  relative comparisons should hold; the absolute timings are not predictions.
- **No real-device measurement.** No measurement of IndexedDB throughput on a
  low-end phone, battery cost, or how the engine behaves under memory pressure.
  These are the numbers that would decide whether it is usable in practice.
- **Single-machine, single-process.** Server-side contention, multi-tenant load
  and disk behaviour under concurrency are untested.
- **Workloads are synthetic.** Generated from a small vocabulary with a seeded
  generator. Real editing has structure — pauses, bursts, copy-paste, undo —
  that is not reproduced.
- **Convergence is checked, not proven.** Property tests over many random
  schedules are strong evidence and not a proof. The types are standard ones
  with published correctness arguments; the implementations are not verified.
