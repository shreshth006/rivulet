import test from 'node:test';
import assert from 'node:assert/strict';
import { VersionVector } from '#core/version-vector';
import { RangeSet } from '#core/range-set';
import { nodeIdFromLabel } from '#core/ids';
import { makeRng, randInt, shuffled } from '#core/util';

const A = nodeIdFromLabel('a'), B = nodeIdFromLabel('b'), C = nodeIdFromLabel('c');

test('RangeSet merges adjacent runs and reports exact membership', () => {
  const rs = new RangeSet();
  for (const n of [1, 2, 3, 7, 8, 5]) rs.add(n);
  assert.deepEqual(rs.ranges, [[1, 3], [5, 5], [7, 8]]);
  rs.add(4);                                     // bridges [1,3] and [5,5]
  assert.deepEqual(rs.ranges, [[1, 5], [7, 8]]);
  rs.add(6);                                     // bridges everything
  assert.deepEqual(rs.ranges, [[1, 8]]);
  assert.equal(rs.size, 8);
  assert.equal(rs.rangeCount, 1);
  assert.ok(rs.has(4) && !rs.has(9));
  assert.ok(rs.hasRange(2, 6) && !rs.hasRange(2, 9));
});

test('frontier stops at the first hole, and gaps name exactly what is missing', () => {
  const rs = new RangeSet([[1, 20], [27, 42]]);
  assert.equal(rs.frontier(), 20, 'must not advertise past the hole');
  assert.equal(rs.max(), 42);
  assert.deepEqual(rs.gaps(), [[21, 26]]);
  assert.deepEqual(rs.gaps(50), [[21, 26], [43, 50]]);

  rs.addRange(21, 26);
  assert.equal(rs.frontier(), 42);
  assert.deepEqual(rs.gaps(), []);
});

test('a set starting above 1 has no frontier at all', () => {
  const rs = new RangeSet([[3, 9]]);
  assert.equal(rs.frontier(), 0);
  assert.deepEqual(rs.gaps(), [[1, 2]]);
});

test('RangeSet survives an encode/decode round trip', () => {
  const rs = new RangeSet([[1, 20], [27, 42], [100, 100]]);
  const wire = JSON.parse(JSON.stringify(rs));
  assert.deepEqual(RangeSet.fromJSON(wire).ranges, rs.ranges);
  assert.deepEqual(RangeSet.fromJSON(undefined).ranges, []);
  assert.ok(JSON.stringify(wire).length < JSON.stringify(rs.ranges).length);
});

test('RangeSet is insertion-order independent (randomised)', () => {
  const rng = makeRng(7);
  for (let trial = 0; trial < 200; trial++) {
    const nums = Array.from({ length: randInt(rng, 1, 40) }, () => randInt(rng, 1, 60));
    const a = new RangeSet(), b = new RangeSet();
    for (const n of nums) a.add(n);
    for (const n of shuffled(rng, nums)) b.add(n);
    assert.deepEqual(a.ranges, b.ranges);
    assert.deepEqual([...a], [...new Set(nums)].sort((x, y) => x - y));
  }
});

test('version vectors take the pointwise maximum on merge', () => {
  const v1 = new VersionVector({ [A]: 5, [B]: 2 });
  const v2 = new VersionVector({ [B]: 9, [C]: 1 });
  v1.merge(v2);
  assert.deepEqual(v1.toJSON(), { [A]: 5, [B]: 9, [C]: 1 });
  assert.equal(v1.get(nodeIdFromLabel('zz')), 0, 'unknown replicas read as 0');
  v1.observe(A, 3);
  assert.equal(v1.get(A), 5, 'observe never moves a frontier backwards');
});

test('compare() distinguishes causal order from genuine concurrency', () => {
  const base = new VersionVector({ [A]: 3, [B]: 3 });
  const ahead = new VersionVector({ [A]: 4, [B]: 3 });
  const forked = new VersionVector({ [A]: 3, [B]: 4 });

  assert.equal(base.compare(base.clone()), 'equal');
  assert.equal(base.compare(ahead), 'lt');
  assert.equal(ahead.compare(base), 'gt');
  assert.equal(ahead.compare(forked), 'concurrent');
  assert.ok(ahead.dominates(base) && !base.dominates(ahead));
});

test('an empty vector is dominated by everything', () => {
  const empty = new VersionVector();
  const some = new VersionVector({ [A]: 1 });
  assert.ok(empty.isEmpty());
  assert.ok(some.dominates(empty));
  assert.equal(empty.compare(some), 'lt');
});

test('diff() yields the exact ranges a peer must be sent', () => {
  const mine = new VersionVector({ [A]: 10, [B]: 4, [C]: 7 });
  const theirs = new VersionVector({ [A]: 10, [B]: 1 });
  const d = mine.diff(theirs);
  assert.deepEqual([...d.entries()].sort(), [[B, [1, 4]], [C, [0, 7]]].sort());
  assert.ok(!d.has(A), 'nothing to send for a replica they are current on');
  assert.equal(mine.diff(mine.clone()).size, 0);
});

test('vector JSON is key-sorted so identical state encodes identically', () => {
  const v1 = new VersionVector(); v1.observe(C, 1); v1.observe(A, 2);
  const v2 = new VersionVector(); v2.observe(A, 2); v2.observe(C, 1);
  assert.equal(JSON.stringify(v1), JSON.stringify(v2));
  assert.ok(VersionVector.fromJSON(JSON.parse(JSON.stringify(v1))).equals(v1));
});

test('rejects malformed replica ids and sequence numbers', () => {
  const v = new VersionVector();
  assert.throws(() => v.observe('not-a-node-id', 1), /malformed node id/);
  assert.throws(() => v.observe(A, -1), /invalid seq/);
  assert.throws(() => v.observe(A, 1.5), /invalid seq/);
  assert.throws(() => new RangeSet().addRange(5, 2), /invalid range/);
  assert.throws(() => new RangeSet().add(0), /invalid range/);
});
