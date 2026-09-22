import test from 'node:test';
import assert from 'node:assert/strict';
import { RivuletClient, Status } from '#client/client';
import { MemoryAdapter } from '#storage/adapter';
import { notebookSchema } from '../../test/helpers/fixtures.js';
import { ValidationError } from '#core/errors';

test('RivuletClient works locally with query, exists and find', async (t) => {
  const client = await RivuletClient.open({
    schema: notebookSchema,
    room: 'test-room',
    storage: new MemoryAdapter({ name: 'test-mem' }),
  });
  t.after(() => client.close());

  assert.equal(client.status, Status.OFFLINE);
  assert.equal(client.online, false);

  // Initially nothing exists
  assert.equal(client.exists('notes', 'nonexistent'), false);
  assert.equal(client.find('notes', { title: 'First' }), null);
  assert.equal(client.count('notes'), 0);

  // Create documents
  const id1 = client.mutate((tx) => tx.create('notes', {
    title: 'Note 1', body: 'First body', tags: ['work'], pinned: true,
  }));
  const id2 = client.mutate((tx) => tx.create('notes', {
    title: 'Note 2', body: 'Second body', tags: ['personal'], pinned: false,
  }));

  assert.equal(client.exists('notes', id1), true);
  assert.equal(client.exists('notes', id2), true);
  assert.equal(client.count('notes'), 2);

  // find with object filter
  const foundPinned = client.find('notes', { pinned: true });
  assert.equal(foundPinned?.id, id1);
  assert.equal(foundPinned?.title, 'Note 1');

  const foundByTag = client.find('notes', { tags: 'personal' });
  assert.equal(foundByTag?.id, id2);

  // findOne alias
  const foundOne = client.findOne('notes', { tags: 'personal' });
  assert.equal(foundOne?.id, id2);

  // find with predicate function
  const foundByPredicate = client.find('notes', (doc) => doc.body.includes('Second'));
  assert.equal(foundByPredicate?.id, id2);

  // list with object filter
  const workNotes = client.list('notes', { where: { tags: 'work' } });
  assert.equal(workNotes.length, 1);
  assert.equal(workNotes[0].id, id1);

  // Soft delete and exists check
  client.mutate((tx) => tx.delete('notes', id1));
  assert.equal(client.exists('notes', id1), false);
  assert.equal(client.get('notes', id1), null);
  assert.equal(client.count('notes'), 1);

  // Restore and exists check
  client.mutate((tx) => tx.restore('notes', id1));
  assert.equal(client.exists('notes', id1), true);
  assert.equal(client.get('notes', id1)?.title, 'Note 1');
});

test('RivuletClient subscribe notifies on mutations and unsubscribes cleanly', async (t) => {
  const client = await RivuletClient.open({
    schema: notebookSchema,
    room: 'sub-room',
    storage: new MemoryAdapter({ name: 'sub-mem' }),
  });
  t.after(() => client.close());

  const seen = [];
  const unsubscribe = client.subscribe('notes', (rows) => {
    seen.push(rows.length);
  });

  // subscribe runs once immediately
  assert.deepEqual(seen, [0]);

  client.mutate((tx) => tx.create('notes', { title: 'Sub 1' }));
  assert.deepEqual(seen, [0, 1]);

  client.mutate((tx) => tx.create('notes', { title: 'Sub 2' }));
  assert.deepEqual(seen, [0, 1, 2]);

  unsubscribe();
  client.mutate((tx) => tx.create('notes', { title: 'Sub 3' }));
  assert.deepEqual(seen, [0, 1, 2], 'unsubscribed listener must not receive further notifications');
});

test('RivuletClient flush, pendingCount, stats and closing', async () => {
  const client = await RivuletClient.open({
    schema: notebookSchema,
    room: 'stats-room',
    storage: new MemoryAdapter({ name: 'stats-mem' }),
  });

  client.mutate((tx) => tx.create('notes', { title: 'Pending note' }));
  await client.flush();

  const stats = await client.stats();
  assert.equal(typeof stats.node, 'string');
  assert.equal(stats.database.documents, 1);

  const vacuumed = await client.vacuum();
  assert.equal(vacuumed, false); // Memory adapter has no vacuum
  assert.equal(client.canCompact, false);

  await client.close();
  assert.throws(() => client.mutate((tx) => tx.create('notes', { title: 'fails' })), ValidationError);
});

test('RivuletClient onStatus and waitForStatus report status lifecycle', async () => {
  const client = await RivuletClient.open({
    schema: notebookSchema,
    room: 'status-room',
    storage: new MemoryAdapter({ name: 'status-mem' }),
  });

  const seen = [];
  const unsubscribe = client.onStatus((status) => seen.push(status));
  assert.deepEqual(seen, [Status.OFFLINE]);

  assert.equal(await client.waitForStatus(Status.OFFLINE), true);

  unsubscribe();
  await client.close();
});

test('RivuletClient snapshot, loadSnapshot and gc methods', async () => {
  const clientA = await RivuletClient.open({
    schema: notebookSchema,
    room: 'snap-room',
    storage: new MemoryAdapter({ name: 'snap-mem-a' }),
  });

  clientA.mutate((tx) => tx.create('notes', { title: 'Snapshot note' }));
  const snap = clientA.snapshot();
  assert.equal(snap.v, 1);
  assert.equal(typeof snap.collections.notes, 'object');

  const clientB = await RivuletClient.open({
    schema: notebookSchema,
    room: 'snap-room-b',
    storage: new MemoryAdapter({ name: 'snap-mem-b' }),
  });

  const merged = clientB.loadSnapshot(snap);
  assert.equal(merged, 1);
  assert.equal(clientB.list('notes')[0].title, 'Snapshot note');

  const reclaimed = clientB.gc('9999999999999999-0000-ffffffffffffffff');
  assert.equal(typeof reclaimed, 'number');

  await clientA.close();
  await clientB.close();
});



