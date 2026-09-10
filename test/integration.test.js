import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCluster, assertSameView } from './helpers/cluster.js';
import { Status } from '#client/engine';
import { RivuletClient } from '#client/client';
import { MemoryAdapter } from '#storage/adapter';
import { notebookSchema } from './helpers/fixtures.js';

test('a write on one client reaches another', async (t) => {
  const c = await makeCluster({ clients: 2 });
  t.after(() => c.close());
  const [a, b] = c.clients;

  const id = a.mutate((tx) => tx.create('notes', { title: 'Hostel wifi', body: 'it drops' }));
  await a.sync();
  await b.sync();

  assert.equal(b.get('notes', id).title, 'Hostel wifi');
  assert.equal(b.get('notes', id).body, 'it drops');
  assert.equal(a.status, Status.LIVE);
});

test('writes made offline are queued and delivered on reconnect', async (t) => {
  const c = await makeCluster({ clients: 2 });
  t.after(() => c.close());
  const [a, b] = c.clients;

  a.link.partition();
  const id = a.mutate((tx) => tx.create('notes', { title: 'written offline' }));
  a.mutate((tx) => tx.setText('notes', id, 'body', 'still works'));

  assert.equal(a.get('notes', id).title, 'written offline', 'reads work while offline');
  const failed = await a.sync();
  assert.ok(failed.error, 'syncing while partitioned fails');
  assert.equal(a.status, Status.OFFLINE);
  assert.ok(await a.pendingCount() > 0, 'work is queued, not lost');

  a.link.heal();
  await a.syncUntilIdle();
  await b.syncUntilIdle();

  assert.equal(b.get('notes', id).title, 'written offline');
  assert.equal(await a.pendingCount(), 0, 'the outbox drains once delivered');
  assert.equal(a.status, Status.LIVE);
});

test('concurrent offline edits merge without losing either', async (t) => {
  const c = await makeCluster({ clients: 3 });
  t.after(() => c.close());
  const [a, b, d] = c.clients;

  const id = a.mutate((tx) => tx.create('notes', {
    title: 'shared', body: 'The wifi is down.', tags: ['infra'],
  }));
  await c.settle();
  assert.equal(d.get('notes', id).body, 'The wifi is down.');

  // Everyone goes offline and edits a different aspect of the same note.
  for (const client of c.clients) client.link.partition();
  a.mutate((tx) => tx.setText('notes', id, 'body', 'The hostel wifi is down.'));
  b.mutate((tx) => tx.add('notes', id, 'tags', 'urgent'));
  d.mutate((tx) => tx.increment('notes', id, 'reads', 4));
  a.mutate((tx) => tx.increment('notes', id, 'reads', 1));

  for (const client of c.clients) client.link.heal();
  await c.settle();

  const view = assertSameView(c.clients, 'notes');
  assert.equal(view.length, 1);
  assert.ok(view[0].body.includes('hostel'), 'the text edit survived');
  assert.deepEqual(view[0].tags.sort(), ['infra', 'urgent'], 'the tag survived');
  assert.equal(view[0].reads, 5, 'concurrent increments added up');
});

test('concurrent typing in one body converges character by character', async (t) => {
  const c = await makeCluster({ clients: 2 });
  t.after(() => c.close());
  const [a, b] = c.clients;

  const id = a.mutate((tx) => tx.create('notes', { body: 'Meet at 6.' }));
  await c.settle();

  a.link.partition(); b.link.partition();
  a.mutate((tx) => tx.setText('notes', id, 'body', 'Meet at 6 tonight.'));
  b.mutate((tx) => tx.setText('notes', id, 'body', 'Please meet at 6.'));
  a.link.heal(); b.link.heal();
  await c.settle();

  const merged = a.get('notes', id).body;
  assert.equal(merged, b.get('notes', id).body);
  assert.ok(merged.includes('tonight'), `lost A's edit: ${merged}`);
  assert.ok(merged.includes('Please'), `lost B's edit: ${merged}`);
});

test('a retried push does not duplicate operations', async (t) => {
  const c = await makeCluster({ clients: 2 });
  t.after(() => c.close());
  const [a, b] = c.clients;

  const id = a.mutate((tx) => tx.create('notes', { title: 'counted', reads: 0 }));
  a.mutate((tx) => tx.increment('notes', id, 'reads', 10));
  await c.settle();

  // Force several failed attempts before letting one through.
  a.link.failNext = 3;
  a.mutate((tx) => tx.increment('notes', id, 'reads', 5));
  for (let i = 0; i < 5; i++) await a.sync();
  await c.settle();

  assert.equal(a.get('notes', id).reads, 15);
  assert.equal(b.get('notes', id).reads, 15, 'retries must not double-count');
});

test('a client restart resumes identity, sequence and clock', async (t) => {
  const storage = new MemoryAdapter({ name: 'persistent' });
  const server = (await makeCluster({ clients: 1 })).server;
  t.after(() => server.close());

  const { LoopbackTransport } = await import('#client/transport');
  const node = (await import('#core/ids')).nodeIdFromLabel('restarter');

  const first = await RivuletClient.open({
    schema: notebookSchema, room: 'restart', storage, node,
    transport: new LoopbackTransport(server, { node, room: 'restart' }),
    sync: { pollMs: 1e9, debounceMs: 1e9 },
  });
  const id = first.mutate((tx) => tx.create('notes', { title: 'before restart', body: 'abc' }));
  await first.syncUntilIdle();
  const seqBefore = first.db.seq;
  await first.close();

  // Same storage, new process.
  const second = await RivuletClient.open({
    schema: notebookSchema, room: 'restart', storage,
    transport: new LoopbackTransport(server, { node, room: 'restart' }),
    sync: { pollMs: 1e9, debounceMs: 1e9 },
  });
  t.after(() => second.close());

  assert.equal(second.node, node, 'identity must be reused, never re-minted');
  assert.equal(second.get('notes', id).title, 'before restart', 'state replays from the log');
  assert.equal(second.db.seq, seqBefore, 'the sequence counter resumes');

  second.mutate((tx) => tx.set('notes', id, 'title', 'after restart'));
  assert.ok(second.db.seq > seqBefore, 'new writes continue the sequence');
  await second.syncUntilIdle();
  assert.equal(second.get('notes', id).title, 'after restart');
});

test('a new client bootstraps the full history from the server', async (t) => {
  const c = await makeCluster({ clients: 1 });
  t.after(() => c.close());
  const [a] = c.clients;

  for (let i = 0; i < 20; i++) a.mutate((tx) => tx.create('notes', { title: `note ${i}` }));
  await a.syncUntilIdle();

  const { LoopbackTransport } = await import('#client/transport');
  const fresh = await RivuletClient.open({
    schema: notebookSchema, room: 'test-room',
    storage: new MemoryAdapter({ name: 'fresh' }),
    transport: new LoopbackTransport(c.server, { node: a.node.replace(/^./, 'f'), room: 'test-room' }),
    sync: { pollMs: 1e9, debounceMs: 1e9, batching: { initial: 8, max: 8 } },
  });
  t.after(() => fresh.close());

  await fresh.syncUntilIdle();
  assert.equal(fresh.count('notes'), 20, 'a bounded pull must still transfer everything');
});

test('a partial transfer resumes rather than restarting', async (t) => {
  // A page size of 5 against 12 notes forces several rounds per sync.
  const c = await makeCluster({ clients: 2, sync: { batching: { initial: 5, max: 5, min: 5 } } });
  t.after(() => c.close());
  const [a, b] = c.clients;

  for (let i = 0; i < 12; i++) a.mutate((tx) => tx.create('notes', { title: `n${i}` }));
  await a.syncUntilIdle();

  // Let exactly one round through, then drop the link mid-transfer.
  b.link.allowNext = 1;
  await b.sync();
  const afterDrop = b.count('notes');
  assert.ok(afterDrop > 0 && afterDrop < 12,
    `expected a partial pull before the drop, got ${afterDrop}`);
  assert.equal(b.status, Status.OFFLINE);

  // Reconnect: the frontier is the cursor, so the pull picks up where it
  // stopped rather than starting the transfer again.
  b.link.allowNext = null;
  const requestsBefore = b.link.requests;
  await b.syncUntilIdle();

  assert.equal(b.count('notes'), 12);
  assert.ok(b.link.requests - requestsBefore <= 4,
    'resuming must not re-transfer the pages already received');
  assertSameView([a, b], 'notes', (v) => v.title);
});

test('the server never sees an operation it did not have to store twice', async (t) => {
  const c = await makeCluster({ clients: 2 });
  t.after(() => c.close());
  const [a] = c.clients;

  const seen = [];
  c.server.on('ops', (e) => seen.push(e.count));
  a.mutate((tx) => tx.create('notes', { title: 'once' }));
  for (let i = 0; i < 4; i++) await a.sync();

  assert.equal(seen.reduce((s, n) => s + n, 0), 1, 'one operation, broadcast once');
});

test('deletes propagate and survive a concurrent edit', async (t) => {
  const c = await makeCluster({ clients: 2 });
  t.after(() => c.close());
  const [a, b] = c.clients;

  const id = a.mutate((tx) => tx.create('notes', { title: 'doomed' }));
  await c.settle();

  a.link.partition(); b.link.partition();
  b.mutate((tx) => tx.set('notes', id, 'title', 'renamed'));
  a.mutate((tx) => tx.delete('notes', id));
  a.link.heal(); b.link.heal();
  await c.settle();

  assert.equal(a.get('notes', id), b.get('notes', id));
  assertSameView([a, b], 'notes');
});

test('a foreign replica cannot forge another\'s history', async (t) => {
  const c = await makeCluster({ clients: 2 });
  t.after(() => c.close());
  const [a, b] = c.clients;

  const id = a.mutate((tx) => tx.create('notes', { title: 'mine' }));
  await c.settle();

  // Hand-craft a push attributed to a, sent by b.
  const { encodeOps } = await import('#protocol/codec');
  const { sync } = await import('#protocol/messages');
  const forged = [{
    node: a.node, seq: 9999, ts: a.db.clock.peek().replace(/-\w{16}$/, `-${a.node}`),
    collection: 'notes', doc: id, field: 'title', payload: { v: 'forged' },
  }];
  const reply = await c.server.handleSync(sync({
    node: b.node, room: 'test-room', have: {}, push: encodeOps(forged),
  }));

  assert.equal(reply.ok, 0, 'nothing forged was stored');
  assert.equal(reply.bad?.[0]?.reason, 'foreign-replica');
  await c.settle();
  assert.equal(a.get('notes', id).title, 'mine');
});

test('stats describe what is actually outstanding', async (t) => {
  const c = await makeCluster({ clients: 2 });
  t.after(() => c.close());
  const [a] = c.clients;

  a.link.partition();
  a.mutate((tx) => tx.create('notes', { title: 'pending' }));
  await a.sync();

  const stats = await a.stats();
  assert.equal(stats.pending, 1);
  assert.equal(stats.sync.status, Status.OFFLINE);
  assert.ok(stats.sync.lastError);

  a.link.heal();
  await a.syncUntilIdle();
  assert.equal((await a.stats()).pending, 0);

  const server = await c.server.stats();
  assert.equal(server.rooms[0].operations, 1);
});

test('a purely local client works with no transport at all', async (t) => {
  const client = await RivuletClient.open({
    schema: notebookSchema, room: 'local-only',
    storage: new MemoryAdapter({ name: 'solo' }),
  });
  t.after(() => client.close());

  const id = client.mutate((tx) => tx.create('notes', { title: 'no server' }));
  assert.equal(client.get('notes', id).title, 'no server');
  assert.deepEqual(await client.sync(), { pushed: 0, pulled: 0, rounds: 0 });
  assert.equal(client.status, Status.OFFLINE);
});

test('subscribe re-renders on local and remote changes', async (t) => {
  const c = await makeCluster({ clients: 2 });
  t.after(() => c.close());
  const [a, b] = c.clients;

  const renders = [];
  const off = b.subscribe('notes', (rows) => renders.push(rows.length));
  assert.deepEqual(renders, [0], 'renders once immediately');

  a.mutate((tx) => tx.create('notes', { title: 'remote' }));
  await c.settle();
  assert.ok(renders.at(-1) === 1, 'a remote change triggers a render');

  b.mutate((tx) => tx.create('notes', { title: 'local' }));
  assert.equal(renders.at(-1), 2, 'a local change triggers a render');

  off();
  b.mutate((tx) => tx.create('notes', { title: 'after unsubscribe' }));
  assert.equal(renders.at(-1), 2);
});

test('a transport factory receives the replica id restored from storage', async (t) => {
  const { LoopbackTransport } = await import('#client/transport');
  const { makeCluster } = await import('./helpers/cluster.js');
  const c = await makeCluster({ clients: 1 });
  t.after(() => c.close());

  const storage = new MemoryAdapter({ name: 'factory' });
  const seen = [];
  const open = () => RivuletClient.open({
    schema: notebookSchema, room: 'test-room', storage,
    transport: (node) => {
      seen.push(node);
      return new LoopbackTransport(c.server, { node, room: 'test-room' });
    },
    sync: { pollMs: 1e9, debounceMs: 1e9 },
  });

  const first = await open();
  const id = first.mutate((tx) => tx.create('notes', { title: 'from factory' }));
  await first.syncUntilIdle();
  await first.close();

  const second = await open();
  t.after(() => second.close());
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1], 'the factory must see the same id across restarts');
  assert.equal(second.get('notes', id).title, 'from factory');
});
