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

| Revisions | Operations | Encoded log | Plain snapshot (uncollected) | Snapshot (uncollected) | vs log | Snapshot (collected) | Collected vs log |
| --: | --: | --: | --: | --: | --: | --: | --: |
| 50 | 5602 | 110.3 kB | 128.1 kB | 25.5 kB | 76.9% | 1.2 kB | 98.9% |
| 200 | 24803 | 524.0 kB | 561.0 kB | 119.5 kB | 77.2% | 1.8 kB | 99.7% |
| 800 | 110507 | 2.41 MB | 2.49 MB | 542.7 kB | 77.5% | 1.9 kB | 99.9% |
| 2000 | 316004 | 7.10 MB | 7.11 MB | 1.55 MB | 78.1% | 2.6 kB | 100.0% |

*The plain snapshot stores every element identifier in full, so before collection it is no smaller than the encoded log -- slightly larger. The compact format interns those identifiers into one timestamp table and stores sequences as columns, which makes even an uncollected snapshot cheaper than the log. Collected, the snapshot is what a new device should download.*

### Snapshot interning: plain versus compact

| Revisions | Plain (uncollected) | Compact (uncollected) | Saving | Plain (collected) | Compact (collected) | Saving |
| --: | --: | --: | --: | --: | --: | --: |
| 50 | 128.1 kB | 25.5 kB | 80.1% | 4.0 kB | 1.2 kB | 69.1% |
| 200 | 561.0 kB | 119.5 kB | 78.7% | 5.8 kB | 1.8 kB | 69.9% |
| 800 | 2.49 MB | 542.7 kB | 78.2% | 6.6 kB | 1.9 kB | 70.6% |
| 2000 | 7.11 MB | 1.55 MB | 78.2% | 9.3 kB | 2.6 kB | 72.4% |

*Both forms hold identical state and expand to the same CRDTs; the compact one is what `snapshot()` writes. Neither is DEFLATEd here, to match the log column above.*
