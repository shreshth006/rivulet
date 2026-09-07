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
