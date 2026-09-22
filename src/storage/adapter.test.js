import { runAdapterConformance } from '../../test/helpers/adapter-conformance.js';
import { MemoryAdapter } from '#storage/adapter';
import { SqliteAdapter } from '#storage/sqlite';
import { IndexedDbAdapter } from '#storage/indexeddb';
import { installFakeIndexedDB } from '../../test/helpers/fake-indexeddb.js';

runAdapterConformance('memory', async () => new MemoryAdapter());

runAdapterConformance('sqlite', async () => new SqliteAdapter({ path: ':memory:' }), { compaction: true });

// The browser adapter runs against an in-process IndexedDB double so the
// platform we actually target is not the only one left untested.
const fake = installFakeIndexedDB();
let dbCounter = 0;
runAdapterConformance('indexeddb', async () =>
  new IndexedDbAdapter({ name: `conformance-${dbCounter++}`, factory: fake.factory }));

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeDb } from '../../test/helpers/fixtures.js';

test('memory adapter stats reports telemetry breakdown', async () => {
  const adapter = new MemoryAdapter({ name: 'mem-stats' });
  await adapter.open();

  const opsA = makeDb('a').mutate((tx) => tx.create('notes', { title: '1' })).ops;
  const opsB = makeDb('b').mutate((tx) => tx.create('notes', { title: '2' })).ops;

  await adapter.appendOps([...opsA, ...opsB]);
  await adapter.setMeta('schema', 'test-fingerprint');

  const stats = await adapter.stats();
  assert.equal(stats.adapter, 'memory');
  assert.equal(stats.name, 'mem-stats');
  assert.equal(stats.operations, opsA.length + opsB.length);
  assert.equal(stats.nodes, 2);
  assert.equal(stats.metadataKeys, 1);
  assert.ok(stats.sizeBytes > 0);

  await adapter.close();
});
