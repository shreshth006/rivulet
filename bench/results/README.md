# Evaluation results

Generated 2026-09-21T21:42:03.171Z on Node v24.13.1.
Network figures come from the simulator in `bench/netsim`; timings are
simulated, not wall-clock, and are reproducible given the seed.

## bandwidth

Bytes on the wire per operation, against a plain-JSON baseline.

### Wire cost per workload

| Workload | Ops | JSON | JSON/op | JSON+gz | Codec | Codec+gz | Codec+gz/op | vs JSON | vs JSON+gz |
| :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| typing | 400 | 83.9 kB | 210 B | 3.9 kB | 8.8 kB | 2.2 kB | 5.4 B | 97.4% | 44.2% |
| form-filling | 120 | 20.9 kB | 174 B | 2.1 kB | 4.3 kB | 1.4 kB | 12.0 B | 93.1% | 31.0% |
| bulk-import | 5774 | 1.21 MB | 210 B | 57.9 kB | 139.6 kB | 34.1 kB | 5.9 B | 97.2% | 41.1% |
| collaborative | 3836 | 796.0 kB | 208 B | 43.1 kB | 94.8 kB | 24.4 kB | 6.3 B | 96.9% | 43.4% |

*Reduction is against the naive encoding; the last column is against the same data simply compressed, which is the alternative worth beating.*

### Ablation: bytes per operation with one transformation disabled

| Variant | typing | form-filling | bulk-import | collaborative | Worst case |
| :-- | --: | --: | --: | --: | --: |
| all four | 22.1 B | 36.0 B | 24.2 B | 24.7 B | - |
| no interning | 22.1 B | 46.5 B | 24.3 B | 28.1 B | +29% |
| no deltas | 25.8 B | 39.1 B | 29.0 B | 29.2 B | +20% |
| no back-references | 55.4 B | 36.1 B | 55.7 B | 54.1 B | +151% |
| no run-length | 33.9 B | 45.5 B | 36.8 B | 36.5 B | +53% |
| none (columnar only) | 133.7 B | 98.2 B | 135.0 B | 132.2 B | +505% |

*Uncompressed, so each transformation is measured rather than partly absorbed by DEFLATE. Back-references dominate wherever text is typed; interning dominates wherever many documents are touched.*

### Operations per megabyte of data allowance

| Workload | JSON | Codec | Bytes/op |
| :-- | --: | --: | --: |
| typing | 4768 | 45249 | 22.1 B |
| form-filling | 5739 | 27778 | 36.0 B |
| bulk-import | 4757 | 41356 | 24.2 B |
| collaborative | 4819 | 40444 | 24.7 B |

*Uncompressed codec output, framed as a data budget: the figure that matters to someone on a metered connection.*

## latency

Time for an edit on one device to become visible on another.

### Convergence time and traffic, two replicas

| Profile | RTT | Bandwidth | Baseline | This work | Speed-up | Baseline B | This work B | Bytes saved | Converged |
| :-- | --: | :-- | --: | --: | --: | --: | --: | --: | --: |
| lan | 1 ms | 100 Mbps | 1.52 s | 1.51 s | 1.01x | 131.7 kB | 8.3 kB | 93.7% | yes |
| broadband | 25 ms | 20 Mbps | 1.80 s | 1.76 s | 1.03x | 131.7 kB | 8.3 kB | 93.7% | yes |
| satellite | 600 ms | 5 Mbps | 7.73 s | 7.53 s | 1.03x | 131.7 kB | 8.3 kB | 93.7% | yes |
| mobile-3g | 200 ms | 1 Mbps | 4.68 s | 3.70 s | 1.27x | 131.7 kB | 8.3 kB | 93.7% | yes |
| hostel-wifi | 80 ms | 2 Mbps | 2.91 s | 2.41 s | 1.20x | 131.7 kB | 8.3 kB | 93.7% | yes |
| mobile-edge | 500 ms | 128 kbps | 16.49 s | 7.45 s | 2.21x | 132.6 kB | 8.4 kB | 93.7% | yes |

*Median of 5 seeds. Baseline is the identical engine with plain-JSON operations and no compression, over the identical simulated link. Times are simulated, not wall-clock.*

## partition

Cost of reconciling after every replica has worked offline.

### Four replicas, ten shared documents, varying offline work

| Edits each | Total edits | Operations | Catch-up | Traffic | Bytes/edit | Requests | Checked | Lost | Correct |
| --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| 5 | 20 | 86 | 1.80 s | 8.5 kB | 426 B | 16 | 11 | 0 | yes |
| 25 | 100 | 287 | 1.94 s | 16.4 kB | 164 B | 20 | 53 | 0 | yes |
| 100 | 400 | 944 | 22.27 s | 39.0 kB | 97 B | 30 | 201 | 0 | yes |
| 400 | 1600 | 3924 | 22.66 s | 121.3 kB | 76 B | 46 | 792 | 0 | yes |

*Median of 5 seeds, except the correctness columns, which are totals across every run -- a single lost edit anywhere is a failure, not something to average away. On the hostel-wifi profile. Catch-up is simulated time from reconnection to convergence, and excludes the outage itself. "Checked" counts the edits with a defined survival requirement -- set additions and text insertions -- each verified individually in the converged state; "Correct" also requires every concurrent counter increment to have been summed rather than overwritten.*

### The same offline work, reconciled over different links

| Profile | Catch-up | Traffic | Requests | Checked | Lost | Correct |
| :-- | --: | --: | --: | --: | --: | --: |
| broadband | 1.41 s | 35.1 kB | 24 | 201 | 0 | yes |
| mobile3g | 22.44 s | 35.8 kB | 24 | 201 | 0 | yes |
| hostelWifi | 22.27 s | 38.9 kB | 30 | 201 | 0 | yes |
| mobileEdge | 25.28 s | 36.0 kB | 28 | 201 | 0 | yes |

*Median of 5 seeds. Four replicas, 100 edits each, made entirely offline. The hostel-wifi and edge profiles have recurring outages during the catch-up itself, so their timings are dominated by how much of an outage window the reconnection happens to land in.*

## batching

Adaptive batch sizing against fixed sizes, on networks that punish opposite mistakes.

### Bulk transfer on satellite

| Strategy | Time (median) | Spread | vs best fixed | Requests | Failed rounds | Traffic | Settled at | Converged |
| :-- | --: | --: | --: | --: | --: | --: | --: | --: |
| fixed 8 | 21.02 s | 20.02 s | 2.23x | 36 | 0 | 74.8 kB | - | yes |
| fixed 64 | 16.08 s | 198 ms | 1.71x | 28 | 0 | 71.0 kB | - | yes |
| fixed 512 | 12.45 s | 170 ms | 1.32x | 22 | 0 | 67.7 kB | - | yes |
| fixed 2000 | 9.41 s | 172 ms | 1.00x | 17 | 0 | 67.2 kB | - | yes |
| adaptive | 16.08 s | 198 ms | 1.71x | 28 | 0 | 71.0 kB | 1000 | yes |

*Median of 5 seeds. Adaptive: 1.71x of the best fixed size (which had to be chosen knowing the network), against 2.23x for the worst fixed choice. The claim being tested is not that adapting beats a well-chosen constant -- it does not -- but that it stays close to the best on every network without being told which one it is on.*

### Bulk transfer on mobileEdge

| Strategy | Time (median) | Spread | vs best fixed | Requests | Failed rounds | Traffic | Settled at | Converged |
| :-- | --: | --: | --: | --: | --: | --: | --: | --: |
| fixed 8 | 11.5 min | 4.3 min | 53.56x | 1414 | 980 | 219.3 kB | - | NO |
| fixed 64 | 5.0 min | 36.07 s | 23.31x | 619 | 419 | 167.5 kB | - | yes |
| fixed 512 | 46.79 s | 58.47 s | 3.65x | 130 | 99 | 74.3 kB | - | yes |
| fixed 2000 | 12.83 s | 57.35 s | 1.00x | 17 | 0 | 67.2 kB | - | yes |
| adaptive | 17.50 s | 42.26 s | 1.36x | 26 | 0 | 71.7 kB | 2000 | yes |

*Median of 5 seeds. Adaptive: 1.36x of the best fixed size (which had to be chosen knowing the network), against 53.56x for the worst fixed choice. The claim being tested is not that adapting beats a well-chosen constant -- it does not -- but that it stays close to the best on every network without being told which one it is on.*

### Bulk transfer on hostelWifi

| Strategy | Time (median) | Spread | vs best fixed | Requests | Failed rounds | Traffic | Settled at | Converged |
| :-- | --: | --: | --: | --: | --: | --: | --: | --: |
| fixed 8 | 14.1 min | 3.1 min | 286.47x | 1900 | 380 | 749.1 kB | - | yes |
| fixed 64 | 1.6 min | 1.4 min | 33.44x | 257 | 61 | 163.4 kB | - | yes |
| fixed 512 | 4.22 s | 21.13 s | 1.44x | 32 | 0 | 73.8 kB | - | yes |
| fixed 2000 | 2.94 s | 458 ms | 1.00x | 17 | 0 | 67.2 kB | - | yes |
| adaptive | 3.79 s | 21.08 s | 1.29x | 26 | 0 | 71.6 kB | 2000 | yes |

*Median of 5 seeds. Adaptive: 1.29x of the best fixed size (which had to be chosen knowing the network), against 286.47x for the worst fixed choice. The claim being tested is not that adapting beats a well-chosen constant -- it does not -- but that it stays close to the best on every network without being told which one it is on.*

## scale

Traffic and metadata cost as the number of replicas grows.

### Replicas each making 40 edits to 8 shared documents

| Replicas | Edits | Converge | Total | Per replica | Per edit | Idle sync | Requests | Converged |
| --: | --: | --: | --: | --: | --: | --: | --: | --: |
| 2 | 80 | 1.36 s | 4.4 kB | 2.2 kB | 55 B | 125 B | 8 | yes |
| 4 | 160 | 1.36 s | 10.3 kB | 2.6 kB | 64 B | 123 B | 16 | yes |
| 8 | 320 | 1.39 s | 32.8 kB | 4.1 kB | 102 B | 165 B | 40 | yes |
| 16 | 640 | 1.42 s | 107.5 kB | 6.7 kB | 168 B | 248 B | 96 | yes |
| 32 | 1280 | 1.45 s | 365.1 kB | 11.4 kB | 285 B | 401 B | 224 | yes |

*"Idle sync" is one request from a fully caught-up replica: version vector only, no operations. It is the per-replica metadata floor, and the number that would eventually limit how widely a document can be shared before polling alone becomes expensive.*

## overhead

Memory cost of convergence metadata, and what collection reclaims.

### Tombstone accumulation under repeated rewriting

| Revisions | Operations | Live chars | Tombstones | Tomb/live | State | Bytes/live char |
| --: | --: | --: | --: | --: | --: | --: |
| 50 | 5602 | 84 | 2759 | 32.85x | 127.8 kB | 1521 B |
| 200 | 24803 | 127 | 12338 | 97.15x | 560.7 kB | 4415 B |
| 800 | 110507 | 145 | 55181 | 380.56x | 2.49 MB | 17168 B |
| 2000 | 316004 | 208 | 157898 | 759.13x | 7.11 MB | 34204 B |

*A deliberately hostile workload: a short field rewritten over and over, so almost every character written is later deleted. It is an upper bound on tombstone growth, not a typical document. The ratio is the honest cost of position-free editing -- deleted characters must be retained while any replica might still anchor an insert on them -- and the row below shows what collection reclaims.*

### Garbage collection at a causally stable point

| Revisions | Before | After | Tombstones freed | Reduction | Text intact |
| --: | --: | --: | --: | --: | --: |
| 50 | 127.8 kB | 3.6 kB | 2759 | 97.2% | yes |
| 200 | 560.7 kB | 5.5 kB | 12338 | 99.0% | yes |
| 800 | 2.49 MB | 6.2 kB | 55181 | 99.7% | yes |
| 2000 | 7.11 MB | 9.0 kB | 157898 | 99.9% | yes |

*Collection is only safe below a timestamp every replica has seen. Operations that still name a collected tombstone are rebased onto its surviving neighbour, so a late arrival converges rather than dangling.*

### Bootstrap cost: operation log versus snapshot

| Revisions | Operations | Encoded log | Snapshot (uncollected) | Snapshot (collected) | vs log |
| --: | --: | --: | --: | --: | --: |
| 50 | 5602 | 110.3 kB | 128.1 kB | 4.0 kB | 96.4% |
| 200 | 24803 | 524.0 kB | 561.0 kB | 5.8 kB | 98.9% |
| 800 | 110507 | 2.41 MB | 2.49 MB | 6.6 kB | 99.7% |
| 2000 | 316004 | 7.10 MB | 7.11 MB | 9.3 kB | 99.9% |

*Compaction only pays once tombstones are collected. An uncollected snapshot is no smaller than the encoded log -- it is slightly larger, because it stores every element identifier in full while the codec replaces in-batch references with integers. Applying the same interning to the snapshot format would close that gap and is not done here. Collected, the snapshot is what a new device should download.*
