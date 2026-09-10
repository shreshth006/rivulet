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
