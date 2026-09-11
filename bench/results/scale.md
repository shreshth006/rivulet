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
