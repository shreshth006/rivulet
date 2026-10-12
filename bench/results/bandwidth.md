## bandwidth

Bytes on the wire per operation, against a plain-JSON baseline.

### Wire cost per workload

| Workload | Ops | JSON | JSON/op | JSON+gz | Codec | Codec+gz | Codec+gz/op | vs JSON | vs JSON+gz |
| :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| typing | 400 | 83.9 kB | 210 B | 3.9 kB | 8.8 kB | 2.2 kB | 5.4 B | 97.4% | 44.2% |
| form-filling | 120 | 20.9 kB | 174 B | 2.1 kB | 4.3 kB | 1.4 kB | 12.0 B | 93.1% | 31.1% |
| bulk-import | 5774 | 1.21 MB | 210 B | 57.9 kB | 139.6 kB | 34.1 kB | 5.9 B | 97.2% | 41.0% |
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

### Cost of end-to-end encryption

| Workload | Codec+gz/op | Sealed+gz/op | Cost | Sealed vs JSON |
| :-- | --: | --: | --: | --: |
| typing | 8.1 B | 14.3 B | 1.75x | 93.2% |
| form-filling | 20.8 B | 26.8 B | 1.29x | 84.6% |
| bulk-import | 8.6 B | 14.2 B | 1.66x | 93.2% |
| collaborative | 10.4 B | 16.3 B | 1.56x | 92.2% |

*Both columns push each replica's own operations in batches of 64, as a client does, so they are comparable; this is why the clear column differs from the whole-workload figure above. Sealing adds one AES-256-GCM nonce and tag per batch, base64url overhead, and a pointer per operation; content is still interned, back-referenced and compressed, but inside the ciphertext, where the outer DEFLATE cannot see repetition across batches.*

### Operations per megabyte of data allowance

| Workload | JSON | Codec | Bytes/op |
| :-- | --: | --: | --: |
| typing | 4768 | 45249 | 22.1 B |
| form-filling | 5739 | 27778 | 36.0 B |
| bulk-import | 4757 | 41356 | 24.2 B |
| collaborative | 4819 | 40444 | 24.7 B |

*Uncompressed codec output, framed as a data budget: the figure that matters to someone on a metered connection.*
