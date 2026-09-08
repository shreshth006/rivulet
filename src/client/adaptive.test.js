import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveBatcher } from '#client/adaptive';

test('starts at the configured size and respects bounds', () => {
  const b = new AdaptiveBatcher({ initial: 64, min: 8, max: 500 });
  assert.equal(b.size, 64);
  assert.equal(new AdaptiveBatcher({ initial: 5, min: 8 }).size, 8);
  assert.equal(new AdaptiveBatcher({ initial: 9999, max: 500 }).size, 500);
});

test('grows towards what the link demonstrated it can carry', () => {
  const b = new AdaptiveBatcher({ initial: 32, targetMs: 2000, max: 5000 });
  // 100 ops in 200ms = 0.5 ops/ms; a 2s target implies ~1000 ops.
  for (let i = 0; i < 10; i++) b.record({ ops: 100, ms: 200 });
  assert.ok(b.size > 32, 'a fast link must raise the batch size');
  assert.ok(b.size <= 1000, `must not exceed the measured rate, got ${b.size}`);
  assert.ok(b.estimate.opsPerSecond > 0);
});

test('growth is capped per round, so one fast burst cannot overshoot', () => {
  const b = new AdaptiveBatcher({ initial: 10, targetMs: 60_000, growth: 2, max: 1e6 });
  const first = (b.record({ ops: 1000, ms: 1 }), b.size);
  assert.equal(first, 20, 'at most double in one round, whatever the sample says');
});

test('a slow link shrinks the batch', () => {
  const b = new AdaptiveBatcher({ initial: 500, targetMs: 2000, min: 8 });
  // 10 ops in 4s: this link cannot carry 500 in one round.
  for (let i = 0; i < 12; i++) b.record({ ops: 10, ms: 4000 });
  assert.ok(b.size < 100, `expected a small batch on a slow link, got ${b.size}`);
  assert.ok(b.size >= 8);
});

test('packet loss is not treated as congestion', () => {
  const b = new AdaptiveBatcher({ initial: 256, min: 8 });
  for (let i = 0; i < 20; i++) b.fail({ sizeRelated: false });
  assert.equal(b.size, 256,
    'a lossy link must not drive the batch to the floor: that turns one '
    + 'transfer into hundreds of round trips');
  assert.equal(b.estimate.safeMax, null, 'and must not install a ceiling');
  assert.equal(b.estimate.consecutiveFailures, 20, 'but the streak is still counted');
});

test('failure halves the batch, and repeated failure bottoms out at the minimum', () => {
  const b = new AdaptiveBatcher({ initial: 256, min: 8 });
  assert.equal(b.fail(), 128);
  assert.equal(b.fail(), 64);
  for (let i = 0; i < 20; i++) b.fail();
  assert.equal(b.size, 8, 'never below the minimum: a round must still make progress');
  assert.equal(b.estimate.consecutiveFailures, 22);

  b.record({ ops: 10, ms: 100 });
  assert.equal(b.estimate.consecutiveFailures, 0, 'success clears the failure streak');
});

test('a size that failed becomes a ceiling, instead of being doubled back into', () => {
  const b = new AdaptiveBatcher({ initial: 1000, min: 8, max: 4000, targetMs: 10_000 });

  // The link cannot carry 1000 in one round.
  b.fail();
  assert.equal(b.size, 500);
  assert.ok(b.estimate.safeMax < 1000, 'the failing size is remembered');

  // Even with samples suggesting a much larger batch, growth stops below it.
  for (let i = 0; i < 10; i++) b.record({ ops: 500, ms: 10 });
  assert.ok(b.size < 1000,
    `must not climb back to the size that failed, reached ${b.size}`);
  assert.ok(b.size > 500, 'but must still recover towards the ceiling');

  // Over a long healthy run it may eventually exceed it -- conditions change,
  // and a permanent cap would be wrong. It just must not happen immediately.
  for (let i = 0; i < 500; i++) b.record({ ops: 500, ms: 10 });
  assert.ok(b.size > 1000, 'a sustained healthy link must eventually recover');
});

test('the ceiling relaxes during sustained success', () => {
  const b = new AdaptiveBatcher({ initial: 400, min: 8, max: 10_000, targetMs: 10_000 });
  b.fail();
  const initialCeiling = b.estimate.safeMax;
  for (let i = 0; i < 100; i++) b.record({ ops: 1000, ms: 10 });
  assert.ok(b.estimate.safeMax > initialCeiling,
    'a link that improves must not be held down by one old failure');
});

test('idle polls measure latency without collapsing the batch size', () => {
  const b = new AdaptiveBatcher({ initial: 200, targetMs: 2000 });
  for (let i = 0; i < 50; i++) b.record({ ops: 0, ms: 300 });
  assert.equal(b.size, 200, 'an empty round says nothing about throughput');
  assert.ok(b.estimate.rttMs > 0, 'but it is a latency sample');
});

test('a server ceiling is applied immediately', () => {
  const b = new AdaptiveBatcher({ initial: 900, max: 1000 });
  assert.equal(b.setCeiling(100), 100);
  for (let i = 0; i < 10; i++) b.record({ ops: 500, ms: 10 });
  assert.ok(b.size <= 100, 'the ceiling holds even against a fast link');
});

test('a zero-length round is ignored rather than dividing by zero', () => {
  const b = new AdaptiveBatcher({ initial: 50 });
  b.record({ ops: 10, ms: 0 });
  assert.equal(b.size, 50);
  assert.ok(Number.isFinite(b.size));
});

test('a round that died early is blamed on the link, not on its size', () => {
  const b = new AdaptiveBatcher({ initial: 512, min: 8, max: 2000 });
  // Establish what a normal round costs.
  for (let i = 0; i < 10; i++) b.record({ ops: 512, ms: 2000 });
  const settled = b.size;

  // A timeout after 100ms cannot be about size -- a full round takes ~2s.
  // This is a link outage, and backing off would leave us stuck below what
  // the link carries fine once it returns.
  b.fail({ sizeRelated: true, ms: 100 });
  assert.equal(b.size, settled, 'an early death must not shrink the batch');
  assert.equal(b.estimate.safeMax, null);

  // A timeout after an unusually long round is genuine evidence of size.
  b.fail({ sizeRelated: true, ms: 8000 });
  assert.ok(b.size < settled, 'a long-running failure does implicate size');
  assert.ok(b.estimate.safeMax !== null);
});
