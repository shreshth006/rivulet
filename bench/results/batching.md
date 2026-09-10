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
