# Contributing

## Setup

There is none. Node 22.5 or newer, and:

```bash
npm test                 # 222 tests
node scripts/check.js    # parses everything, resolves every import
```

## The one hard rule: no dependencies

This project has an empty dependency tree and CI enforces it. That is not
minimalism for its own sake — it is what lets someone clone this in five years
and run it, which matters for a research artefact whose results are supposed to
be reproducible.

Node's built-ins cover what is needed: `node:sqlite` for storage, `node:test`
for testing, `node:http` for the server, `node:zlib` for compression. If
something genuinely cannot be done without a dependency, that is worth a
discussion, not a pull request.

## Adding a CRDT type

Read `src/core/crdt/contract.js` first. The contract is that types are
**commutative and associative but need not be idempotent** — de-duplication
happens in the operation log, not in each type. Getting this wrong is the
easiest way to introduce a bug that only appears under packet loss.

Then add the type to the law suite in `test/crdt-laws.test.js`. A type that is
not in that suite is a type whose convergence nobody has checked:

```js
test('MyType obeys the CRDT laws', () => {
  checkAllLaws({
    factory: () => new MyType(),
    genOp: (rep, rng) => MyType.op(randInt(rng, 0, 5)),
    // idempotent: false   // only if the type genuinely cannot be
  });
});
```

## Adding a storage backend

Implement the contract in `src/storage/adapter.js` and add it to
`src/storage/adapter.test.js`. The conformance suite runs against all
backends; a backend that passes it will work with the sync engine, and one that
does not will fail on one platform only, which is the worst kind of bug to
chase.

Pay attention to `frontier()`: it must return the highest *contiguous*
sequence, not the maximum. Returning the maximum silently loses operations
after a partial transfer.

## Tests

Tests describe behaviour, not implementation. The name should say what must be
true, so a failure reads as a statement about the system:

```
✖ frontier stops at a hole, so missing operations are re-requested
```

not

```
✖ test frontier()
```

Assertion messages are for the person reading the failure at 2am. Say what went
wrong and why it matters.

Anything touching the network is tested through the in-process harness in
`test/helpers/cluster.js`, which can partition a link, drop it mid-transfer and
fail a specific number of requests. Do not add `setTimeout`-and-hope — use
`waitFor`, or the virtual clock in `bench/netsim/clock.js`.

## Benchmarks

If a change is meant to make something faster or smaller, add a scenario or
extend one, and put the number in the commit message. If it is meant to make
something *correct*, add a test.

Scenarios must be deterministic given a seed. Anything involving packet loss
should report a median over several seeds, because a single run can be decided
by whether one timeout landed inside an outage window.

Report results that do not flatter the change. The evaluation already contains
several; they are more useful than the ones that do.

## Commits

Explain why, not what — the diff covers what. If a change was driven by a
measurement, include the measurement.
