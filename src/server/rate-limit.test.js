import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '#server/rate-limit';
import { SyncServer } from '#server/engine';
import { RivuletClient } from '#client/client';
import { LoopbackTransport } from '#client/transport';
import { MemoryAdapter } from '#storage/adapter';
import { LimitError } from '#core/errors';
import { nodeIdFromLabel } from '#core/ids';
import { sync as syncMessage } from '#protocol/messages';
import { notebookSchema } from '../../test/helpers/fixtures.js';

test('a bucket allows its burst, then refills at the sustained rate', () => {
  const limiter = new RateLimiter({ perSecond: 2, burst: 3 });
  for (let i = 0; i < 3; i++) assert.ok(limiter.take('k', 0).ok);
  const refused = limiter.take('k', 0);
  assert.equal(refused.ok, false);
  assert.equal(refused.retryAfterMs, 500, 'one token takes half a second at 2/s');
  assert.equal(limiter.take('k', 499).ok, false);
  assert.ok(limiter.take('k', 500).ok);
  assert.ok(limiter.take('other', 0).ok, 'keys are independent');
});

test('a bucket never holds more than its burst, however long it idles', () => {
  const limiter = new RateLimiter({ perSecond: 10, burst: 2 });
  limiter.take('k', 0);
  assert.ok(limiter.take('k', 1e9).ok);
  assert.ok(limiter.take('k', 1e9).ok);
  assert.equal(limiter.take('k', 1e9).ok, false);
});

test('memory is bounded: full buckets go first, then the least recently used', () => {
  const limiter = new RateLimiter({ perSecond: 1, burst: 5, maxKeys: 3 });
  limiter.take('busy', 0); limiter.take('busy', 0);
  limiter.take('a', 0); limiter.take('b', 0);
  limiter.take('c', 10_000); // a and b have refilled by now; busy has too
  assert.ok(limiter.size <= 3);

  const lru = new RateLimiter({ perSecond: 0.001, burst: 5, maxKeys: 2 });
  lru.take('x', 0); lru.take('y', 1); lru.take('z', 2);
  assert.equal(lru.size, 2);
  assert.throws(() => new RateLimiter({ perSecond: 0, burst: 1 }), RangeError);
});

const server = (rateLimit, authorize) => new SyncServer({
  storage: async (room) => new MemoryAdapter({ name: room }),
  schema: notebookSchema.fingerprint,
  rateLimit, authorize,
});
const request = (node) => syncMessage({ node, room: 'r', have: {}, schema: notebookSchema.fingerprint });

test('the server refuses a replica past its budget, before doing any work', async () => {
  let authorised = 0;
  const s = server({ perSecond: 1, burst: 2 }, () => { authorised++; return true; });
  const node = nodeIdFromLabel('rl-a');
  await s.handleSync(request(node));
  await s.handleSync(request(node));
  await assert.rejects(() => s.handleSync(request(node)), (err) => {
    assert.ok(err instanceof LimitError);
    assert.ok(err.details.retryAfterMs > 0 && err.details.retryAfterMs <= 1000);
    return true;
  });
  assert.equal(authorised, 2, 'the refused request never reached authorisation');
  assert.equal(SyncServer.statusFor(new LimitError('x')), 429);
  // Another replica in the same room has its own budget.
  await s.handleSync(request(nodeIdFromLabel('rl-b')));
});

test('rotating replica ids does not escape the per-address budget', async () => {
  const s = server({ perSecond: 100, burst: 100, perIp: { perSecond: 1, burst: 3 } });
  const ctx = { ip: '10.0.0.7' };
  for (let i = 0; i < 3; i++) await s.handleSync(request(nodeIdFromLabel(`rot-${i}`)), ctx);
  await assert.rejects(() => s.handleSync(request(nodeIdFromLabel('rot-9')), ctx), LimitError);
  await s.handleSync(request(nodeIdFromLabel('rot-9')), { ip: '10.0.0.8' });
});

test('a limited client waits at least as long as it was told to', async (t) => {
  const s = server({ perSecond: 0.5, burst: 2 });
  const node = nodeIdFromLabel('rl-client');
  const client = await RivuletClient.open({
    schema: notebookSchema, room: 'r', node,
    storage: new MemoryAdapter({ name: 'rl-client' }),
    transport: new LoopbackTransport(s, { node, room: 'r' }),
    // A tiny backoff ceiling, so any wait over it can only be the server's.
    sync: { pollMs: 1e9, debounceMs: 1e9, maxBackoffMs: 10 },
  });
  t.after(() => client.close());
  const retries = [];
  client.engine.on('retry', (e) => retries.push(e.delayMs));

  let result;
  for (let i = 0; i < 4 && !result?.error; i++) result = await client.sync();
  assert.ok(result.error instanceof LimitError, 'the budget runs out');
  assert.ok(retries.at(-1) >= result.error.details.retryAfterMs,
    `retry scheduled after ${retries.at(-1)} ms, server asked for ${result.error.details.retryAfterMs}`);
  assert.ok(retries.at(-1) > 10);
});
