import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toHex, randomHex, makeRng, randInt, pick, shuffled,
  stableStringify, deepEqual, fnv1a, digest, backoffDelay, chunk, bisect, Emitter,
} from '#core/util';
import { ValidationError } from '#core/errors';

test('toHex pads to a fixed width and refuses to overflow', () => {
  assert.equal(toHex(255, 4), '00ff');
  assert.equal(toHex(0, 2), '00');
  // Fixed width is what makes string comparison equal numeric comparison;
  // silently widening would break timestamp ordering.
  assert.throws(() => toHex(0x10000, 4), ValidationError);
});

test('randomHex produces the requested length and varies', () => {
  assert.equal(randomHex(8).length, 16);
  assert.match(randomHex(4), /^[0-9a-f]{8}$/);
  const seen = new Set(Array.from({ length: 200 }, () => randomHex(8)));
  assert.equal(seen.size, 200, 'collisions at 64 bits over 200 draws indicate a broken source');
});

test('the seeded generator is reproducible and well distributed', () => {
  assert.deepEqual(
    Array.from({ length: 5 }, makeRng(42)),
    Array.from({ length: 5 }, makeRng(42)),
    'a benchmark that cannot replay is an anecdote',
  );
  assert.notDeepEqual(Array.from({ length: 5 }, makeRng(42)), Array.from({ length: 5 }, makeRng(43)));

  const rng = makeRng(7);
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 10_000; i++) buckets[Math.floor(rng() * 10)]++;
  for (const n of buckets) assert.ok(n > 800 && n < 1200, `uneven distribution: ${buckets}`);
});

test('randInt is inclusive at both ends', () => {
  const rng = makeRng(3);
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(randInt(rng, 1, 3));
  assert.deepEqual([...seen].sort(), [1, 2, 3]);
  assert.equal(randInt(makeRng(1), 5, 5), 5);
});

test('shuffled leaves the input alone and preserves its contents', () => {
  const rng = makeRng(9);
  const input = [1, 2, 3, 4, 5, 6, 7, 8];
  const out = shuffled(rng, input);
  assert.deepEqual(input, [1, 2, 3, 4, 5, 6, 7, 8], 'must not mutate');
  assert.deepEqual([...out].sort((a, b) => a - b), input);
  assert.ok(pick(rng, input) >= 1);
});

test('stableStringify sorts keys at every depth', () => {
  const a = { b: { d: 1, c: 2 }, a: [{ z: 1, y: 2 }] };
  const b = { a: [{ y: 2, z: 1 }], b: { c: 2, d: 1 } };
  assert.equal(stableStringify(a), stableStringify(b));
  assert.equal(digest(a), digest(b));
  assert.notEqual(digest(a), digest({ ...a, extra: 1 }));
});

test('deepEqual handles nesting, arrays and NaN', () => {
  assert.ok(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }));
  assert.ok(!deepEqual({ a: 1 }, { a: 1, b: 2 }));
  assert.ok(!deepEqual([1, 2], [1, 2, 3]));
  assert.ok(!deepEqual([1, 2], { 0: 1, 1: 2 }));
  assert.ok(deepEqual(NaN, NaN), 'a field written as NaN must not look changed on every merge');
  assert.ok(!deepEqual(null, {}));
});

test('fnv1a is stable and spreads similar inputs apart', () => {
  assert.equal(fnv1a('hello'), fnv1a('hello'));
  assert.notEqual(fnv1a('hello'), fnv1a('hellp'));
  assert.ok(fnv1a('x') >= 0 && fnv1a('x') <= 0xffffffff);
});

test('backoff is bounded, full-jittered, and grows', () => {
  // Full jitter, not partial: with many clients reconnecting after the same
  // outage, spreading uniformly across the window avoids a thundering herd.
  assert.equal(backoffDelay(0, { baseMs: 1000, rng: () => 0 }), 0);
  assert.equal(backoffDelay(0, { baseMs: 1000, rng: () => 0.999 }), 999);
  assert.equal(backoffDelay(3, { baseMs: 100, rng: () => 1 - 1e-9 }), 799);
  assert.equal(backoffDelay(50, { baseMs: 100, maxMs: 30_000, rng: () => 0.5 }), 15_000,
    'must saturate rather than overflow');

  const rng = makeRng(5);
  const samples = Array.from({ length: 200 }, () => backoffDelay(5, { baseMs: 100, rng }));
  assert.ok(new Set(samples).size > 100, 'jitter must actually spread retries out');
  assert.ok(Math.max(...samples) <= 3200);
});

test('chunk and bisect behave at the boundaries', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
  const cmp = (a, b) => a - b;
  assert.equal(bisect([], 1, cmp), 0);
  assert.equal(bisect([1, 3, 5], 0, cmp), 0);
  assert.equal(bisect([1, 3, 5], 9, cmp), 3);
  assert.equal(bisect([1, 3, 5], 3, cmp), 1, 'ties insert before the equal element');
});

test('the emitter supports once, off and self-removal mid-dispatch', () => {
  const e = new Emitter();
  const seen = [];

  const off = e.on('x', (v) => seen.push(`a${v}`));
  e.once('x', (v) => seen.push(`once${v}`));
  e.emit('x', 1);
  e.emit('x', 2);
  assert.deepEqual(seen, ['a1', 'once1', 'a2']);

  off();
  e.emit('x', 3);
  assert.deepEqual(seen, ['a1', 'once1', 'a2']);

  // A handler that unsubscribes itself must not disturb the dispatch in flight.
  const log = [];
  const stop = e.on('y', () => { log.push('first'); stop(); });
  e.on('y', () => log.push('second'));
  e.emit('y');
  assert.deepEqual(log, ['first', 'second']);

  e.removeAllListeners();
  e.emit('y');
  assert.deepEqual(log, ['first', 'second']);
});

test('a throwing listener does not break the emit loop, and is reported', () => {
  const e = new Emitter();
  const seen = [];
  const errors = [];
  // One subscriber's bug must not stop the others -- a render callback that
  // throws should not stop the engine's own bookkeeping listener.
  e.onListenerError = (err, ctx) => errors.push([String(err), ctx.event]);

  e.on('x', () => { throw new Error('listener blew up'); });
  e.on('x', () => seen.push('still ran'));
  e.emit('x');

  assert.deepEqual(seen, ['still ran']);
  assert.equal(errors.length, 1, 'and the failure must not vanish');
  assert.match(errors[0][0], /blew up/);
  assert.equal(errors[0][1], 'x');
});
