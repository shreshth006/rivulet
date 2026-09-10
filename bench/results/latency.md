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
