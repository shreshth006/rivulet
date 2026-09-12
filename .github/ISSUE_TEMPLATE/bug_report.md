---
name: Bug report
about: Something converged wrongly, lost data, or behaved badly on a poor network
labels: bug
---

## What happened

## What should have happened

## Reproduction

The most useful report includes a failing seed. The property tests and every
benchmark print one, and it replays exactly:

```bash
node --experimental-sqlite bench/run.js <scenario> --seed <n>
```

If it is a convergence bug, the minimum needed to chase it is: how many
replicas, which field types, and what each replica did while disconnected.

## Environment

- Node version:
- Platform (Node / browser, and which):
- Storage backend (SQLite / IndexedDB / memory):
- Anything unusual about the network:
