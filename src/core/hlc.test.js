import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HybridClock, compareTimestamps, parseTimestamp, encodeTimestamp,
  maxTimestamp, timestampNode, timestampWallMs, ZERO_TIMESTAMP, TIMESTAMP_LEN, MAX_COUNTER,
} from '#core/hlc';
import { nodeIdFromLabel } from '#core/ids';
import { ClockDriftError } from '#core/errors';

const A = nodeIdFromLabel('alice');
const B = nodeIdFromLabel('bob');

/** A clock we can move by hand, so tests never depend on real time. */
function fixedClock(start = 1_700_000_000_000) {
  let t = start;
  return { read: () => t, advance: (ms) => { t += ms; }, set: (ms) => { t = ms; } };
}

test('timestamps are fixed width and lexicographically ordered', () => {
  const phys = fixedClock();
  const clock = new HybridClock({ node: A, physical: phys.read });
  const ts = [];
  for (let i = 0; i < 50; i++) { ts.push(clock.now()); if (i % 7 === 0) phys.advance(1); }

  for (const t of ts) assert.equal(t.length, TIMESTAMP_LEN);
  assert.deepEqual(ts, [...ts].sort(), 'string sort must equal issue order');
  assert.equal(ZERO_TIMESTAMP.length, TIMESTAMP_LEN);
  assert.ok(ZERO_TIMESTAMP < ts[0]);
});

test('now() is strictly monotone even when physical time stalls', () => {
  const phys = fixedClock();
  const clock = new HybridClock({ node: A, physical: phys.read });
  const a = clock.now(), b = clock.now(), c = clock.now();
  assert.ok(a < b && b < c);
  assert.equal(parseTimestamp(c).counter, 2);
});

test('now() stays monotone when the wall clock jumps backwards', () => {
  const phys = fixedClock();
  const clock = new HybridClock({ node: A, physical: phys.read });
  const before = clock.now();
  phys.advance(-5_000); // NTP correction, timezone bug, user set the date
  const after = clock.now();
  assert.ok(after > before, 'a backwards jump must not resurrect old timestamps');
  assert.equal(parseTimestamp(after).wall, parseTimestamp(before).wall);
});

test('observe() preserves happens-before across replicas', () => {
  const pa = fixedClock(1000), pb = fixedClock(1000);
  const alice = new HybridClock({ node: A, physical: pa.read });
  const bob = new HybridClock({ node: B, physical: pb.read });

  // alice -> bob -> alice, with bob's physical clock frozen behind alice's.
  const e1 = alice.now();
  bob.observe(e1);
  const e2 = bob.now();
  alice.observe(e2);
  const e3 = alice.now();

  assert.ok(compareTimestamps(e1, e2) < 0);
  assert.ok(compareTimestamps(e2, e3) < 0);
});

test('a lagging replica does not emit stale timestamps after observing', () => {
  const fast = fixedClock(9_000_000), slow = fixedClock(1_000);
  const a = new HybridClock({ node: A, physical: fast.read });
  const b = new HybridClock({ node: B, physical: slow.read, maxDriftMs: Infinity });
  const fromFast = a.now();
  b.observe(fromFast);
  assert.ok(b.now() > fromFast, 'slow replica must jump forward logically');
});

test('concurrent same-millisecond writes are broken by node id, deterministically', () => {
  const ts1 = encodeTimestamp(5, 0, A);
  const ts2 = encodeTimestamp(5, 0, B);
  assert.equal(Math.sign(compareTimestamps(ts1, ts2)), A < B ? -1 : 1);
  assert.equal(compareTimestamps(ts1, ts1), 0);
  assert.equal(maxTimestamp(ts1, ts2), A < B ? ts2 : ts1);
  assert.equal(maxTimestamp(undefined, ts1), ts1);
});

test('rejects remote clocks beyond the drift bound', () => {
  const phys = fixedClock(1_000_000);
  const clock = new HybridClock({ node: A, physical: phys.read, maxDriftMs: 60_000 });
  const farFuture = encodeTimestamp(1_000_000 + 60_001, 0, B);
  assert.throws(() => clock.observe(farFuture), ClockDriftError);
  // Just inside the bound is accepted.
  clock.observe(encodeTimestamp(1_000_000 + 59_999, 0, B));
});

test('counter overflow borrows a millisecond instead of failing', () => {
  const phys = fixedClock();
  const clock = new HybridClock({ node: A, physical: phys.read });
  let last = clock.now();
  for (let i = 0; i < MAX_COUNTER + 10; i++) {
    const next = clock.now();
    assert.ok(next > last);
    last = next;
  }
  assert.ok(timestampWallMs(last) > phys.read());
});

test('accessors match a full parse, and clocks resume from a persisted value', () => {
  const ts = encodeTimestamp(123456, 7, B);
  assert.equal(timestampNode(ts), B);
  assert.equal(timestampWallMs(ts), 123456);
  assert.deepEqual(parseTimestamp(ts), { wall: 123456, counter: 7, node: B });

  const resumed = new HybridClock({ node: A, physical: () => 1, last: ts });
  assert.ok(resumed.now() > ts, 'restart must not rewind the clock');
});
