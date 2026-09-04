/**
 * @file Storage entry point, with a default adapter chosen per environment.
 * Keeps `new OpLog(await defaultAdapter())` working in both Node and a browser.
 */

export { MemoryAdapter, DEFAULT_PAGE, opId, compactRanges } from '#storage/adapter';
export { OpLog, MetaKeys } from '#storage/oplog';
export { IndexedDbAdapter } from '#storage/indexeddb';

const isNode = typeof process !== 'undefined' && !!process.versions?.node;

/**
 * Pick the best durable adapter available here.
 * @param {{ name?: string, path?: string, memory?: boolean }} [opts]
 */
export async function defaultAdapter({ name = 'rivulet', path, memory = false } = {}) {
  const { MemoryAdapter } = await import('#storage/adapter');
  if (memory) return new MemoryAdapter({ name });

  if (isNode) {
    const { SqliteAdapter } = await import('#storage/sqlite');
    return new SqliteAdapter({ path: path ?? `${name}.sqlite` });
  }
  const { IndexedDbAdapter } = await import('#storage/indexeddb');
  if (IndexedDbAdapter.available) return new IndexedDbAdapter({ name });

  // No durable store (private mode, blocked storage). The app still works --
  // it just loses unsynced writes on reload, which the client surfaces.
  return new MemoryAdapter({ name });
}
