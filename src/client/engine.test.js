import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCluster } from '../../test/helpers/cluster.js';
import { Status } from '#client/engine';

test('a write made while a round is in flight is still delivered by the next sync', async (t) => {
  const c = await makeCluster({ clients: 2 });
  t.after(() => c.close());
  const [a, b] = c.clients;

  // Slow the link so the first round is provably still in flight -- past the
  // point where it collected its outbox -- when the write happens.
  a.link.latencyMs = 40;
  const inFlight = a.sync();
  await new Promise((r) => setTimeout(r, 10));

  const id = a.mutate((tx) => tx.create('notes', { title: 'written mid-round' }));

  // Handing back the already-running round would resolve with "nothing to
  // do" for a write it never saw, and the operation would sit in the outbox.
  await a.sync();
  await inFlight;

  assert.equal(await a.pendingCount(), 0, 'the write must not be left queued');
  a.link.latencyMs = 0;
  await b.syncUntilIdle();
  assert.equal(b.get('notes', id).title, 'written mid-round');
});

test('concurrent sync callers coalesce instead of stacking requests', async (t) => {
  const c = await makeCluster({ clients: 1 });
  t.after(() => c.close());
  const [a] = c.clients;

  a.mutate((tx) => tx.create('notes', { title: 'once' }));
  const before = a.link.requests;
  await Promise.all([a.sync(), a.sync(), a.sync(), a.sync()]);
  assert.ok(a.link.requests - before <= 3,
    `four concurrent callers should coalesce, saw ${a.link.requests - before} requests`);
});

test('an idle engine does not poll itself into a spin', async (t) => {
  // A poll interval beyond the 32-bit timer limit used to truncate to 1ms and
  // turn the idle path into a continuous sync loop.
  const c = await makeCluster({ clients: 1, sync: { pollMs: 1e9, debounceMs: 1e9 } });
  t.after(() => c.close());
  const [a] = c.clients;

  await a.syncUntilIdle();
  assert.equal(a.status, Status.LIVE);

  const requests = a.link.requests;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(a.link.requests, requests, 'an idle engine must make no requests');
  assert.equal(a.status, Status.LIVE, 'and must stay settled');
});

test('failures back off and recover without losing work', async (t) => {
  const c = await makeCluster({ clients: 2 });
  t.after(() => c.close());
  const [a, b] = c.clients;

  const retries = [];
  a.engine.on('retry', (e) => retries.push(e));

  a.link.partition();
  const id = a.mutate((tx) => tx.create('notes', { title: 'survives' }));
  await a.sync();
  await a.sync();

  assert.ok(retries.length >= 2, 'each failure schedules a retry');
  assert.ok(retries[1].delayMs >= 0 && retries[1].attempt > retries[0].attempt);
  assert.equal(a.status, Status.OFFLINE);

  a.link.heal();
  a.resume();
  await a.syncUntilIdle();
  await b.syncUntilIdle();

  assert.equal(a.status, Status.LIVE);
  assert.equal(b.get('notes', id).title, 'survives');
  assert.equal(await a.pendingCount(), 0);
});

test('an unreachable server does not shrink the batch', async (t) => {
  const c = await makeCluster({ clients: 1, sync: { batching: { initial: 256, min: 8 } } });
  t.after(() => c.close());
  const [a] = c.clients;

  assert.equal(a.engine.batchSize, 256);
  a.link.partition();
  for (let i = 0; i < 6; i++) await a.sync();

  // Being offline says nothing about how much a round can carry. Shrinking
  // here would mean every reconnection after an outage starts at the floor
  // and crawls back up, which is exactly when there is most to transfer.
  assert.equal(a.engine.batchSize, 256);
});

test('a timeout does shrink the batch, because the size is implicated', async (t) => {
  const c = await makeCluster({ clients: 1, sync: { batching: { initial: 256, min: 8 } } });
  t.after(() => c.close());
  const [a] = c.clients;

  a.link.failKind = 'timeout';
  a.link.partition();
  for (let i = 0; i < 4; i++) await a.sync();
  assert.ok(a.engine.batchSize < 256, `expected backoff, still at ${a.engine.batchSize}`);
  assert.ok(a.engine.batchSize >= 8, 'but never below the floor');
});

test('stopping the engine halts all activity', async (t) => {
  const c = await makeCluster({ clients: 1 });
  t.after(() => c.close());
  const [a] = c.clients;

  await a.syncUntilIdle();
  await a.engine.stop();
  assert.equal(a.status, Status.OFFLINE);

  const requests = a.link.requests;
  a.mutate((tx) => tx.create('notes', { title: 'after stop' }));
  await a.sync();
  assert.equal(a.link.requests, requests, 'a stopped engine makes no requests');
  assert.equal(a.get('notes', 'anything'), null);
});
