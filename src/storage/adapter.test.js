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
