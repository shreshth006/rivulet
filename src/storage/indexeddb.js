/**
 * @file IndexedDB-backed storage, for the browser client.
 *
 * IndexedDB is the only browser store that is both durable across restarts and
 * large enough to hold an operation log -- localStorage caps out around 5MB and
 * is synchronous, which would block the main thread on every write.
 *
 * Its API is callback-and-event based, so most of this file is the adapter
 * layer that turns requests into promises. The one design decision worth
 * calling out is the key:
 *
 *   `[node, seq]` as a compound primary key
 *
 * That gives exactly-once appends for free (`add` on an existing key fails, and
 * we treat that as "already have it"), and it makes the sync query a bounded
 * range scan per replica -- `IDBKeyRange.bound([node, after+1], [node, Inf])` --
 * rather than a full cursor walk. On a phone with a few hundred thousand
 * operations that difference is the difference between a usable app and one
 * that janks on every sync.
 */

import { StorageError } from '#core/errors';
import { validateOp } from '#core/op';
import { DEFAULT_PAGE, compactRanges } from '#storage/adapter';

const OPS = 'ops';
const META = 'meta';
const DB_VERSION = 1;

/** @param {IDBRequest} req */
function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** @param {IDBTransaction} tx */
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

/**
 * Awaiting between two requests on the same IndexedDB transaction is a trap:
 * a transaction auto-commits as soon as its request queue drains, so the
 * second request lands on a closed transaction and throws
 * `TransactionInactiveError`. Every multi-step read below therefore issues all
 * of its requests synchronously and awaits them together.
 */
function allSync(requests) { return Promise.all(requests.map(promisify)); }

export class IndexedDbAdapter {
  #db = null;
  #name;
  #factory;

  /**
   * @param {object} opts
   * @param {string} [opts.name] database name; one per room keeps rooms isolated
   * @param {IDBFactory} [opts.factory] injectable, for tests against a shim
   */
  constructor({ name = 'rivulet', factory } = {}) {
    this.#name = name;
    this.#factory = factory ?? globalThis.indexedDB;
    this.name = `indexeddb(${name})`;
  }

  static get available() { return typeof globalThis.indexedDB !== 'undefined'; }

  async open() {
    if (this.#db) return;
    if (!this.#factory) throw new StorageError('IndexedDB is not available in this environment');

    const req = this.#factory.open(this.#name, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OPS)) {
        const ops = db.createObjectStore(OPS, { keyPath: ['node', 'seq'] });
        // Supports "what changed in this document?" without scanning the log.
        ops.createIndex('by_doc', ['collection', 'doc', 'ts']);
        ops.createIndex('by_ts', 'ts');
      }
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      if (ev.oldVersion > 0 && ev.oldVersion < DB_VERSION) {
        // Future migrations land here. The log is replayable from the server,
        // so a failed migration can always fall back to a clean resync.
      }
    };

    try {
      this.#db = await promisify(req);
    } catch (err) {
      throw new StorageError('could not open IndexedDB', { name: this.#name, cause: String(err) });
    }

    // A second tab upgrading the schema would otherwise deadlock on our handle.
    this.#db.onversionchange = () => { this.#db?.close(); this.#db = null; };
  }

  async close() { this.#db?.close(); this.#db = null; }

  #assertOpen() {
    if (!this.#db) throw new StorageError('adapter is not open', { adapter: this.name });
  }

  #store(name, mode) {
    this.#assertOpen();
    const tx = this.#db.transaction(name, mode);
    return { tx, store: tx.objectStore(name) };
  }

  async appendOps(ops) {
    if (ops.length === 0) return 0;
    for (const op of ops) validateOp(op);

    const { tx, store } = this.#store(OPS, 'readwrite');
    let added = 0;
    await Promise.all(ops.map((op) => new Promise((resolve) => {
      // `add` rejects on a duplicate key, which is precisely the de-duplication
      // we want -- so the error is expected, not exceptional.
      const req = store.add(op);
      req.onsuccess = () => { added++; resolve(); };
      req.onerror = (ev) => { ev.preventDefault(); resolve(); };
    })));
    await txDone(tx);
    return added;
  }

  /**
   * Distinct replica ids present in the log.
   *
   * Walks one key per replica: after reading a node's first key the cursor
   * jumps straight past the rest of that replica's operations, so the cost is
   * O(replicas) rather than O(operations). A cursor keeps its transaction
   * alive across steps, so this is safe to await as a whole -- but it must own
   * its transaction, because that transaction is spent by the time it returns.
   */
  async #nodes() {
    const { store } = this.#store(OPS, 'readonly');
    const nodes = new Set();
    await new Promise((resolve, reject) => {
      const req = store.openKeyCursor();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        const node = cursor.key[0];
        nodes.add(node);
        cursor.continue([node, Infinity]);
      };
    });
    return [...nodes].sort();
  }

  /** Range covering every operation from `node` after `after`. */
  #range(node, after = 0, upTo = Infinity) {
    return IDBKeyRange.bound([node, after + 1], [node, upTo]);
  }

  async opsSince(vector = {}, { limit = DEFAULT_PAGE, exclude } = {}) {
    const nodes = (await this.#nodes()).filter((n) => n !== exclude);
    if (nodes.length === 0) return { ops: [], more: false };

    const { store } = this.#store(OPS, 'readonly');
    // One extra row per replica tells us whether another page exists without
    // a second query. All requests are issued before the first await.
    const pages = await allSync(
      nodes.map((node) => store.getAll(this.#range(node, vector[node] ?? 0), limit + 1)));

    const out = [];
    let more = false;
    for (const page of pages) {
      for (const op of page) {
        if (out.length >= limit) { more = true; break; }
        out.push(op);
      }
      if (more) break;
    }
    return { ops: out, more };
  }

  async readOps({ node, fromSeq = 0, toSeq = Infinity, limit, collection, doc } = {}) {
    let out;
    if (collection && doc) {
      const { store } = this.#store(OPS, 'readonly');
      const range = IDBKeyRange.bound([collection, doc, ''], [collection, doc, '\uffff']);
      out = (await promisify(store.index('by_doc').getAll(range)))
        .filter((op) => op.seq > fromSeq && op.seq <= toSeq && (!node || op.node === node));
    } else {
      const nodes = node ? [node] : await this.#nodes();
      if (nodes.length === 0) return [];
      const { store } = this.#store(OPS, 'readonly');
      const pages = await allSync(nodes.map((n) => store.getAll(this.#range(n, fromSeq, toSeq))));
      out = pages.flat();
    }
    out.sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : a.seq - b.seq));
    return limit === undefined ? out : out.slice(0, limit);
  }

  async hasOp(node, seq) {
    const { store } = this.#store(OPS, 'readonly');
    return (await promisify(store.getKey([node, seq]))) !== undefined;
  }

  async countOps() {
    const { store } = this.#store(OPS, 'readonly');
    return promisify(store.count());
  }

  /** Sequence keys held per replica; payloads are never read. */
  async #keysByNode() {
    const nodes = await this.#nodes();
    if (nodes.length === 0) return [];
    const { store } = this.#store(OPS, 'readonly');
    const pages = await allSync(nodes.map((node) => store.getAllKeys(this.#range(node))));
    return nodes.map((node, i) => [node, pages[i].map(([, seq]) => seq)]);
  }

  /**
   * Highest *contiguous* sequence per replica -- deliberately not the maximum.
   * A log holding 1..20 and 27..42 must advertise 20, or 21..26 are never resent.
   */
  async frontier() {
    /** @type {Record<string, number>} */
    const out = {};
    for (const [node, seqs] of await this.#keysByNode()) {
      let f = 0;
      for (const seq of seqs) { if (seq === f + 1) f = seq; else break; }
      if (f > 0) out[node] = f;
    }
    return out;
  }

  async maxSeqs() {
    /** @type {Record<string, number>} */
    const out = {};
    for (const [node, seqs] of await this.#keysByNode()) {
      if (seqs.length) out[node] = seqs.at(-1);
    }
    return out;
  }

  /**
   * Which sequence numbers are held, per replica, as compact ranges.
   * Reads keys only, so a large log does not have to be deserialised at
   * startup just to learn what we have.
   * @returns {Promise<Record<string, Array<[number, number]>>>}
   */
  async seqRanges() {
    /** @type {Record<string, Array<[number, number]>>} */
    const out = {};
    for (const [node, seqs] of await this.#keysByNode()) out[node] = compactRanges(seqs);
    return out;
  }

  async getMeta(key) {
    const { store } = this.#store(META, 'readonly');
    return promisify(store.get(key));
  }

  async setMeta(key, value) {
    const { tx, store } = this.#store(META, 'readwrite');
    if (value === undefined) store.delete(key);
    else store.put(value, key);
    await txDone(tx);
  }

  async truncateBelow(frontier) {
    const entries = Object.entries(frontier);
    if (entries.length === 0) return 0;

    // Read phase: find the keys to drop, all requests issued together.
    const reader = this.#store(OPS, 'readonly');
    const keySets = await allSync(
      entries.map(([node, seq]) => reader.store.getAllKeys(this.#range(node, 0, seq))));

    // Write phase: a fresh transaction, all deletes issued synchronously.
    const { tx, store } = this.#store(OPS, 'readwrite');
    let removed = 0;
    for (const keys of keySets) for (const key of keys) { store.delete(key); removed++; }
    await txDone(tx);
    return removed;
  }

  async clear() {
    const tx = this.#db.transaction([OPS, META], 'readwrite');
    tx.objectStore(OPS).clear();
    tx.objectStore(META).clear();
    await txDone(tx);
  }

  async sizeBytes() {
    const ops = await this.readOps();
    let n = 0;
    for (const op of ops) n += JSON.stringify(op).length;
    return n;
  }
}
