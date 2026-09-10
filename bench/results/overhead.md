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
