/**
 * @file A minimal IndexedDB implementation, so the browser storage adapter is
 * tested rather than merely written.
 *
 * Node has no IndexedDB, and shipping an untested adapter to the one
 * environment this project exists to serve would be indefensible. This covers
 * exactly the surface `IndexedDbAdapter` uses -- compound keys, bounded ranges,
 * key cursors with `continue(key)`, and the duplicate-key rejection that the
 * adapter relies on for de-duplication.
 *
 * It is a test double, not a spec-complete implementation: no versioning edge
 * cases, no blocked events, no structured-clone semantics beyond a deep copy.
 * The adapter is held to the same conformance suite as the SQLite and memory
 * adapters, which is what makes the double worth having.
 */

/** IndexedDB key ordering: numbers before strings before arrays. */
function cmp(a, b) {
  const rank = (v) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2);
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 2) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const c = cmp(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

class FakeKeyRange {
  constructor(lower, upper, lowerOpen = false, upperOpen = false) {
    Object.assign(this, { lower, upper, lowerOpen, upperOpen });
  }
  static bound(lower, upper, lowerOpen, upperOpen) {
    return new FakeKeyRange(lower, upper, lowerOpen, upperOpen);
  }
  static only(value) { return new FakeKeyRange(value, value); }
  static lowerBound(lower, open) { return new FakeKeyRange(lower, undefined, open, false); }
  static upperBound(upper, open) { return new FakeKeyRange(undefined, upper, false, open); }

  includes(key) {
    if (this.lower !== undefined) {
      const c = cmp(key, this.lower);
      if (c < 0 || (c === 0 && this.lowerOpen)) return false;
    }
    if (this.upper !== undefined) {
      const c = cmp(key, this.upper);
      if (c > 0 || (c === 0 && this.upperOpen)) return false;
    }
    return true;
  }
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const matches = (range, key) => range === undefined || range === null
  || (range instanceof FakeKeyRange ? range.includes(key) : cmp(range, key) === 0);

class FakeRequest {
  result = undefined;
  error = null;
  onsuccess = null;
  onerror = null;
  onupgradeneeded = null;

  /** Deliver asynchronously, as the real API does, so handler assignment wins the race. */
  _settle(fn) {
    queueMicrotask(() => {
      try {
        this.result = fn();
        this.onsuccess?.({ target: this });
      } catch (err) {
        this.error = err;
        const ev = { target: this, preventDefault() { this.defaultPrevented = true; }, defaultPrevented: false };
        this.onerror?.(ev);
        if (!ev.defaultPrevented) this._transaction?._fail(err);
      }
    });
    return this;
  }
}

class FakeIndex {
  constructor(store, keyPath) { this.store = store; this.keyPath = keyPath; }

  #keyOf(value) { return this.keyPath.map((p) => value[p]); }

  getAll(range) {
    const req = new FakeRequest();
    return req._settle(() => this.store._entries()
      .filter(([, value]) => matches(range, this.#keyOf(value)))
      .sort((a, b) => cmp(this.#keyOf(a[1]), this.#keyOf(b[1])))
      .map(([, value]) => clone(value)));
  }
}

class FakeObjectStore {
  constructor(data, keyPath, tx, indexes) {
    this._data = data; this.keyPath = keyPath; this._tx = tx; this._indexes = indexes;
  }

  _entries() { return [...this._data.entries()].sort((a, b) => cmp(a[1].key, b[1].key)); }

  #key(value, explicit) {
    if (explicit !== undefined) return explicit;
    if (!this.keyPath) throw new Error('store has no key path and no key was supplied');
    return Array.isArray(this.keyPath) ? this.keyPath.map((p) => value[p]) : value[this.keyPath];
  }

  #id(key) { return JSON.stringify(key); }

  #write(value, explicit, { failIfPresent }) {
    const req = new FakeRequest();
    req._transaction = this._tx;
    return req._settle(() => {
      this._tx._assertWritable();
      const key = this.#key(value, explicit);
      const id = this.#id(key);
      if (failIfPresent && this._data.has(id)) {
        const err = new Error('ConstraintError: key already exists');
        err.name = 'ConstraintError';
        throw err;
      }
      this._data.set(id, { key, value: clone(value) });
      return key;
    });
  }

  add(value, key) { return this.#write(value, key, { failIfPresent: true }); }
  put(value, key) { return this.#write(value, key, { failIfPresent: false }); }

  get(key) {
    const req = new FakeRequest();
    return req._settle(() => clone(this._data.get(this.#id(key))?.value));
  }

  getKey(key) {
    const req = new FakeRequest();
    return req._settle(() => (this._data.has(this.#id(key)) ? key : undefined));
  }

  getAll(range, count) {
    const req = new FakeRequest();
    return req._settle(() => {
      const out = this._entries().filter(([, e]) => matches(range, e.key)).map(([, e]) => clone(e.value));
      return count === undefined ? out : out.slice(0, count);
    });
  }

  getAllKeys(range, count) {
    const req = new FakeRequest();
    return req._settle(() => {
      const out = this._entries().filter(([, e]) => matches(range, e.key)).map(([, e]) => clone(e.key));
      return count === undefined ? out : out.slice(0, count);
    });
  }

  count(range) {
    const req = new FakeRequest();
    return req._settle(() => this._entries().filter(([, e]) => matches(range, e.key)).length);
  }

  delete(key) {
    const req = new FakeRequest();
    req._transaction = this._tx;
    return req._settle(() => { this._tx._assertWritable(); this._data.delete(this.#id(key)); });
  }

  clear() {
    const req = new FakeRequest();
    req._transaction = this._tx;
    return req._settle(() => { this._tx._assertWritable(); this._data.clear(); });
  }

  /**
   * Key cursor. `continue(key)` jumps to the first key at or after `key`,
   * which is how the adapter skips a whole replica's operations in one step.
   */
  openKeyCursor(range) {
    const req = new FakeRequest();
    const keys = this._entries().filter(([, e]) => matches(range, e.key)).map(([, e]) => e.key);
    let i = 0;
    const step = () => {
      queueMicrotask(() => {
        if (i >= keys.length) { req.result = null; req.onsuccess?.({ target: req }); return; }
        const key = keys[i];
        req.result = {
          key,
          continue(target) {
            i = target === undefined
              ? i + 1
              : keys.findIndex((k) => cmp(k, target) >= 0) === -1 ? keys.length
                : Math.max(i + 1, keys.findIndex((k) => cmp(k, target) >= 0));
            step();
          },
        };
        req.onsuccess?.({ target: req });
      });
    };
    step();
    return req;
  }

  index(name) {
    const keyPath = this._indexes.get(name);
    if (!keyPath) throw new Error(`no such index: ${name}`);
    return new FakeIndex(this, keyPath);
  }

  createIndex(name, keyPath) { this._indexes.set(name, keyPath); return new FakeIndex(this, keyPath); }
}

class FakeTransaction {
  #oncomplete = null;
  onerror = null; onabort = null; error = null;

  constructor(db, names, mode) {
    this._db = db; this._names = names; this._mode = mode;
    this._failed = false; this._completed = false;
    // Complete once the microtask queue drains, approximating the real
    // "transaction ends when no more requests are pending" behaviour -- which
    // is exactly the auto-commit the adapter has to be written around.
    queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
      if (this._failed) return;
      this._completed = true;
      this.#oncomplete?.({ target: this });
    })));
  }

  // A handler attached after completion still fires, so a caller that awaited
  // something else first does not hang waiting for an event already past.
  set oncomplete(fn) {
    this.#oncomplete = fn;
    if (this._completed && fn) queueMicrotask(() => fn({ target: this }));
  }
  get oncomplete() { return this.#oncomplete; }

  _assertWritable() {
    if (this._mode !== 'readwrite') throw new Error('ReadOnlyError: transaction is read-only');
  }

  _fail(err) {
    if (this._failed) return;
    this._failed = true;
    this.error = err;
    this.onerror?.({ target: this });
    this.onabort?.({ target: this });
  }

  objectStore(name) {
    if (!this._names.includes(name)) throw new Error(`store ${name} is not in this transaction`);
    const s = this._db._stores.get(name);
    if (!s) throw new Error(`no such store: ${name}`);
    return new FakeObjectStore(s.data, s.keyPath, this, s.indexes);
  }

  abort() { this._fail(new Error('AbortError')); }
}

class FakeDatabase {
  onversionchange = null;

  constructor(name, version) {
    this.name = name; this.version = version;
    /** @type {Map<string, {data: Map, keyPath: any, indexes: Map}>} */
    this._stores = new Map();
    this._closed = false;
  }

  get objectStoreNames() {
    const names = [...this._stores.keys()];
    return { contains: (n) => names.includes(n), length: names.length, [Symbol.iterator]: () => names[Symbol.iterator]() };
  }

  createObjectStore(name, { keyPath } = {}) {
    const entry = { data: new Map(), keyPath, indexes: new Map() };
    this._stores.set(name, entry);
    return new FakeObjectStore(entry.data, keyPath, { _mode: 'readwrite', _assertWritable() {} }, entry.indexes);
  }

  transaction(names, mode = 'readonly') {
    if (this._closed) throw new Error('InvalidStateError: database is closed');
    return new FakeTransaction(this, Array.isArray(names) ? names : [names], mode);
  }

  close() { this._closed = true; }
}

/** A standalone IndexedDB factory; each instance is an isolated origin. */
export function createFakeIndexedDB() {
  /** @type {Map<string, FakeDatabase>} */
  const databases = new Map();

  return {
    open(name, version = 1) {
      const req = new FakeRequest();
      queueMicrotask(() => {
        let db = databases.get(name);
        const oldVersion = db?.version ?? 0;
        if (!db) { db = new FakeDatabase(name, version); databases.set(name, db); }
        db._closed = false;
        req.result = db;
        if (version > oldVersion) {
          db.version = version;
          req.onupgradeneeded?.({ target: req, oldVersion, newVersion: version });
        }
        req.onsuccess?.({ target: req });
      });
      return req;
    },
    deleteDatabase(name) {
      const req = new FakeRequest();
      return req._settle(() => { databases.delete(name); });
    },
    _databases: databases,
  };
}

export { FakeKeyRange as IDBKeyRange };

/** Install the shim globally for the duration of a test file. */
export function installFakeIndexedDB() {
  const previous = { indexedDB: globalThis.indexedDB, IDBKeyRange: globalThis.IDBKeyRange };
  const factory = createFakeIndexedDB();
  globalThis.indexedDB = factory;
  globalThis.IDBKeyRange = FakeKeyRange;
  return {
    factory,
    restore() {
      globalThis.indexedDB = previous.indexedDB;
      globalThis.IDBKeyRange = previous.IDBKeyRange;
    },
  };
}
