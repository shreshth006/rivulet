## scale

Traffic and metadata cost as the number of replicas grows.

### Replicas each making 40 edits to 8 shared documents

| Replicas | Edits | Converge | Total | Per replica | Per edit | Idle request | Idle reply | Full-vector request | Requests | Converged |
| --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| 2 | 80 | 1.38 s | 4.2 kB | 2.1 kB | 53 B | 188 B | 115 B | 191 B | 8 | yes |
| 4 | 160 | 1.39 s | 9.7 kB | 2.4 kB | 61 B | 189 B | 116 B | 217 B | 16 | yes |
| 8 | 320 | 1.42 s | 29.2 kB | 3.7 kB | 91 B | 188 B | 116 B | 263 B | 40 | yes |
| 16 | 640 | 1.45 s | 90.1 kB | 5.6 kB | 141 B | 191 B | 116 B | 351 B | 96 | yes |
| 32 | 1280 | 1.47 s | 287.5 kB | 9.0 kB | 225 B | 191 B | 116 B | 514 B | 224 | yes |

*"Idle request" and "Idle reply" are one sync round from a fully caught-up replica: no operations, only frontiers. That is the metadata floor every poll pays. With vector deltas both are sent relative to the last frontier the server numbered, so they stay flat as the room grows; "Full-vector request" is the same request carrying the whole vector, which is what it cost before.*
