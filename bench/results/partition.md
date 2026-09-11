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
