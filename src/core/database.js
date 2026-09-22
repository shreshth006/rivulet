/**
 * @file The in-memory materialised database: collections of {@link Document}s,
 * plus the transaction API that turns application intent into operations.
 *
 * This is the local-first boundary. A write lands here synchronously and the
 * UI can read it back immediately -- there is no request, no spinner, and no
 * difference in behaviour between online and offline. The operations a
 * transaction produces are handed to the sync engine, which is free to deliver
 * them in a second or in three days.
 *
 * The database is deliberately transport-unaware and storage-unaware. It knows
 * how to apply an operation and how to build one; persistence lives in the
 * storage adapters and delivery lives in the sync engine.
 */

import { Emitter } from '#core/util';
import { Document } from '#core/document';
import { DELETED_FIELD } from '#core/schema';
import { OpFactory, validateOp } from '#core/op';
import { HybridClock } from '#core/hlc';
import { newDocId } from '#core/ids';
import { LWWRegister } from '#core/crdt/lww-register';
import { PNCounter } from '#core/crdt/counter';
import { ORSet } from '#core/crdt/or-set';
import { RGA } from '#core/crdt/rga';
import { textEdit } from '#core/text-diff';
import { ValidationError } from '#core/errors';

const SNAPSHOT_VERSION = 1;

function matchField(actual, expected) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof RegExp)) {
    for (const [op, target] of Object.entries(expected)) {
      switch (op) {
        case '$eq': if (actual !== target) return false; break;
        case '$ne': if (actual === target) return false; break;
        case '$gt': if (!(actual > target)) return false; break;
        case '$gte': if (!(actual >= target)) return false; break;
        case '$lt': if (!(actual < target)) return false; break;
        case '$lte': if (!(actual <= target)) return false; break;
        case '$in': if (!Array.isArray(target) || !target.includes(actual)) return false; break;
        case '$nin': if (Array.isArray(target) && target.includes(actual)) return false; break;
        case '$exists': if ((actual !== undefined && actual !== null) !== Boolean(target)) return false; break;
        case '$regex': {
          const re = target instanceof RegExp ? target : new RegExp(target);
          if (!re.test(String(actual ?? ''))) return false;
          break;
        }
        default: if (actual !== expected) return false;
      }
    }
    return true;
  }
  if (expected instanceof RegExp) return expected.test(String(actual ?? ''));
  if (Array.isArray(actual)) return actual.includes(expected);
  if (actual instanceof Set) return actual.has(expected);
  return actual === expected;
}

export class Database extends Emitter {
  #schema;
  #clock;
  #factory;
  /** @type {Map<string, Map<string, Document>>} collection -> id -> document */
  #collections = new Map();

  /**
   * @param {object} opts
   * @param {import('#core/schema').Schema} opts.schema
   * @param {string} opts.node this replica's id
   * @param {number} [opts.startSeq] resume sequence numbering after a restart
   * @param {string} [opts.lastTimestamp] resume the HLC after a restart
   * @param {() => number} [opts.physical] injectable clock (tests, simulation)
   */
  constructor({ schema, node, startSeq = 0, lastTimestamp, physical }) {
    super();
    this.#schema = schema;
    this.#clock = new HybridClock({ node, physical, last: lastTimestamp });
    this.#factory = new OpFactory(this.#clock, startSeq);
    for (const name of schema.names) this.#collections.set(name, new Map());
  }

  get schema() { return this.#schema; }
  get node() { return this.#clock.node; }
  get clock() { return this.#clock; }
  get seq() { return this.#factory.seq; }

  // ------------------------------------------------------------- applying

  /**
   * Apply one operation, local or remote. Safe to call with operations in any
   * order; the caller is responsible for not replaying the same `(node, seq)`
   * twice (the operation log enforces that).
   * @returns {boolean} whether a visible value changed
   */
  apply(op, { local = false } = {}) {
    validateOp(op);
    if (!this.#schema.has(op.collection)) return false; // unknown collection: ignore, do not crash
    const collection = this.#schema.collection(op.collection);
    if (!collection.has(op.field)) return false;        // field dropped from schema

    if (!local) this.#clock.observe(op.ts);

    const docs = this.#collections.get(op.collection);
    let doc = docs.get(op.doc);
    if (!doc) {
      doc = new Document(op.doc, collection);
      docs.set(op.doc, doc);
    }
    const changed = doc.apply(op);
    if (changed) this.emit('change', { collection: op.collection, doc: op.doc, op });
    return changed;
  }

  /** @param {Iterable<object>} ops @returns {{ applied: number, changed: number }} */
  applyAll(ops, opts) {
    let applied = 0, changed = 0;
    for (const op of ops) {
      applied++;
      if (this.apply(op, opts)) changed++;
    }
    if (applied) this.emit('batch', { applied, changed });
    return { applied, changed };
  }

  // -------------------------------------------------------------- reading

  /** @returns {Document|undefined} */
  document(collection, id) {
    return this.#collections.get(collection)?.get(id);
  }

  /**
   * Get the document, materialising an empty one if it does not exist yet.
   * Transactions need this: composing a multi-character insert means reading
   * back each operation's effect to anchor the next, so the document being
   * written must be the one the operations are landing in, not a detached copy.
   */
  ensureDocument(collection, id) {
    const schema = this.#schema.collection(collection);
    const docs = this.#collections.get(collection);
    let doc = docs.get(id);
    if (!doc) { doc = new Document(id, schema); docs.set(id, doc); }
    return doc;
  }

  /** @returns {Record<string,any>|null} null when absent or deleted */
  get(collection, id, opts) {
    this.#schema.collection(collection);
    return this.document(collection, id)?.value(opts) ?? null;
  }

  exists(collection, id) {
    const doc = this.document(collection, id);
    return !!doc && !doc.deleted;
  }

  /**
   * @param {string} collection
   * @param {object} [opts]
   * @param {boolean} [opts.includeDeleted]
   * @param {((value: any, doc: Document) => boolean)|Record<string, any>} [opts.where]
   * @param {(a: any, b: any) => number} [opts.sort]
   * @param {number} [opts.limit]
   * @param {number} [opts.offset]
   * @param {string[]} [opts.select] fields to project
   */
  list(collection, { includeDeleted = false, where, sort, limit, offset = 0, select } = {}) {
    this.#schema.collection(collection);
    const filterFn = typeof where === 'function'
      ? where
      : (typeof where === 'object' && where !== null)
        ? (val) => Object.entries(where).every(([k, v]) => matchField(val[k], v))
        : null;
    let out = [];
    for (const doc of this.#collections.get(collection).values()) {
      if (doc.deleted && !includeDeleted) continue;
      const value = doc.value({ includeDeleted });
      if (value && (!filterFn || filterFn(value, doc))) {
        if (select && Array.isArray(select) && select.length) {
          const projected = { id: value.id };
          for (const k of select) if (k in value) projected[k] = value[k];
          out.push(projected);
        } else {
          out.push(value);
        }
      }
    }
    if (sort) out.sort(sort);
    if (offset) out = out.slice(offset);
    if (limit !== undefined) out = out.slice(0, limit);
    return out;
  }

  /**
   * Find the first document matching `where`.
   * @param {string} collection
   * @param {((value: any, doc: Document) => boolean)|Record<string, any>} where
   * @param {object} [opts]
   * @returns {Record<string,any>|null}
   */
  find(collection, where, opts = {}) {
    const results = this.list(collection, { ...opts, where, limit: 1 });
    return results[0] ?? null;
  }

  /** Documents holding unresolved concurrent values, for a conflict-review UI. */
  conflicts(collection) {
    const names = collection ? [collection] : this.#schema.names;
    const out = [];
    for (const name of names) {
      for (const doc of this.#collections.get(name).values()) {
        const fields = doc.conflicts;
        if (fields.length) out.push({ collection: name, doc: doc.id, fields });
      }
    }
    return out;
  }

  count(collection, opts) { return this.list(collection, opts).length; }

  // --------------------------------------------------------------- writing

  /** Begin a transaction. Nothing is emitted until {@link Transaction#commit}. */
  transaction() { return new Transaction(this, this.#factory); }

  /**
   * Run `fn` in a transaction and commit it.
   * @param {(tx: Transaction) => any} fn
   * @returns {{ ops: object[], result: any }}
   */
  mutate(fn) {
    const tx = this.transaction();
    const result = fn(tx);
    return { ops: tx.commit(), result };
  }

  // ----------------------------------------------------------- persistence

  /** Full CRDT state -- the compaction artefact, not a value dump. */
  snapshot() {
    /** @type {Record<string, Record<string, any>>} */
    const collections = {};
    for (const [name, docs] of this.#collections) {
      if (docs.size === 0) continue;
      collections[name] = {};
      for (const id of [...docs.keys()].sort()) collections[name][id] = docs.get(id).toJSON();
    }
    return {
      v: SNAPSHOT_VERSION,
      schema: this.#schema.fingerprint,
      node: this.node,
      seq: this.#factory.seq,
      ts: this.#clock.peek(),
      collections,
    };
  }

  /**
   * Restore from a snapshot, merging into whatever is already loaded. Merging
   * rather than replacing is what lets a client bootstrap from a server
   * snapshot without discarding local writes it has not yet pushed.
   */
  loadSnapshot(snap) {
    if (!snap || snap.v !== SNAPSHOT_VERSION) {
      throw new ValidationError('unsupported snapshot version', { got: snap?.v, expected: SNAPSHOT_VERSION });
    }
    if (snap.schema !== this.#schema.fingerprint) {
      throw new ValidationError('snapshot schema does not match', {
        snapshot: snap.schema, local: this.#schema.fingerprint,
      });
    }
    let merged = 0;
    for (const [name, docs] of Object.entries(snap.collections ?? {})) {
      if (!this.#schema.has(name)) continue;
      const collection = this.#schema.collection(name);
      const target = this.#collections.get(name);
      for (const [id, state] of Object.entries(docs)) {
        const incoming = new Document(id, collection, state);
        const existing = target.get(id);
        if (existing) { if (existing.merge(incoming)) merged++; }
        else { target.set(id, incoming); merged++; }
      }
    }
    if (snap.ts) this.#clock.observe(snap.ts);
    this.emit('batch', { applied: merged, changed: merged, source: 'snapshot' });
    return merged;
  }

  /** Reclaim CRDT bookkeeping below a causally stable timestamp. */
  gc(stableTs) {
    let reclaimed = 0;
    for (const docs of this.#collections.values()) {
      for (const doc of docs.values()) reclaimed += doc.gc(stableTs);
    }
    return reclaimed;
  }

  get stats() {
    /** @type {Record<string, {documents:number, deleted:number}>} */
    const byCollection = {};
    let documents = 0, deleted = 0;
    for (const [name, docs] of this.#collections) {
      let d = 0;
      for (const doc of docs.values()) if (doc.deleted) d++;
      byCollection[name] = { documents: docs.size, deleted: d };
      documents += docs.size;
      deleted += d;
    }
    return { node: this.node, seq: this.#factory.seq, documents, deleted, byCollection };
  }
}

/**
 * Collects the operations for one logical change.
 *
 * Operations are applied to the local database *as they are built*, for two
 * reasons: the UI must see the write immediately, and types whose payload
 * depends on current state -- an OR-Set remove naming the tags it observed, a
 * sequence insert anchored on the previous character -- need each step's effect
 * visible before the next is composed.
 */
export class Transaction {
  #db;
  #factory;
  /** @type {object[]} */
  #ops = [];
  #committed = false;

  constructor(db, factory) {
    this.#db = db;
    this.#factory = factory;
  }

  get ops() { return [...this.#ops]; }
  get size() { return this.#ops.length; }

  #emit(collection, doc, field, payload) {
    if (this.#committed) throw new ValidationError('transaction already committed');
    const op = this.#factory.create({ collection, doc, field, payload });
    this.#db.apply(op, { local: true });
    this.#ops.push(op);
    return op;
  }

  /**
   * The live CRDT for a field, so payloads can capture current state.
   * Must be the instance operations actually land in -- see
   * {@link Database#ensureDocument}.
   */
  #crdt(collection, id, field) {
    this.#db.schema.collection(collection).field(field);
    return this.#db.ensureDocument(collection, id).crdt(field);
  }

  #expect(collection, field, ...types) {
    const def = this.#db.schema.collection(collection).field(field);
    if (!types.includes(def.type)) {
      throw new ValidationError('operation does not match the field type', {
        collection, field, fieldType: def.type, expected: types,
      });
    }
    return def;
  }

  /** Last-writer-wins or multi-value write. */
  set(collection, id, field, value) {
    const def = this.#expect(collection, field, 'lww', 'mv');
    const payload = def.type === 'mv'
      ? this.#crdt(collection, id, field).op(value)
      : LWWRegister.op(value);
    this.#emit(collection, id, field, payload);
    return this;
  }

  /** Add to an observed-remove set. */
  add(collection, id, field, element) {
    this.#expect(collection, field, 'set');
    this.#emit(collection, id, field, ORSet.op(element));
    return this;
  }

  /** Remove from an observed-remove set; only tags this replica has seen. */
  remove(collection, id, field, element) {
    this.#expect(collection, field, 'set');
    this.#emit(collection, id, field, this.#crdt(collection, id, field).op(element));
    return this;
  }

  /** Increment (or, with a negative delta, decrement) a counter. */
  increment(collection, id, field, delta = 1) {
    this.#expect(collection, field, 'counter');
    if (delta !== 0) this.#emit(collection, id, field, PNCounter.op(delta));
    return this;
  }

  /**
   * Splice a sequence field: remove `removeCount` items at `index`, then insert.
   * Each inserted item anchors on the previous one, so a run stays contiguous
   * even against a concurrent insert at the same point.
   */
  splice(collection, id, field, index, removeCount, items = []) {
    this.#expect(collection, field, 'seq');
    const rga = this.#crdt(collection, id, field);

    const doomed = rga.ids().slice(index, index + removeCount);
    for (const targetId of doomed) this.#emit(collection, id, field, RGA.deleteOp(targetId));

    if (items.length) {
      let anchor = index > 0 ? rga.idAtIndex(index - 1) : undefined;
      for (const item of items) {
        anchor = this.#emit(collection, id, field, RGA.insertOp(item, anchor)).ts;
      }
    }
    return this;
  }

  /**
   * Reconcile a text field with a new whole string, emitting only the
   * characters that actually changed. This is the binding point for a plain
   * `<textarea>`: the UI hands over its value and the engine recovers the edit.
   */
  setText(collection, id, field, nextText) {
    const def = this.#expect(collection, field, 'seq');
    if (!def.asText) throw new ValidationError('field is not declared as text', { collection, field });

    const rga = this.#crdt(collection, id, field);
    const edit = textEdit(rga, String(nextText));
    if (!edit) return this;

    for (const targetId of edit.deleteIds) this.#emit(collection, id, field, RGA.deleteOp(targetId));

    let anchor = edit.insertAfter;
    for (const ch of edit.insert) {
      anchor = this.#emit(collection, id, field, RGA.insertOp(ch, anchor)).ts;
    }
    return this;
  }

  /** Write several fields at once, dispatching on each field's declared type. */
  update(collection, id, values) {
    const schema = this.#db.schema.collection(collection);
    for (const [field, value] of Object.entries(values)) {
      const def = schema.field(field);
      switch (def.type) {
        case 'lww': case 'mv':
          this.set(collection, id, field, value); break;
        case 'counter': {
          const current = this.#crdt(collection, id, field).value;
          this.increment(collection, id, field, Number(value) - current); break;
        }
        case 'set': {
          const crdt = this.#crdt(collection, id, field);
          const next = new Set(value ?? []);
          for (const el of crdt.value) if (!next.has(el)) this.remove(collection, id, field, el);
          for (const el of next) if (!crdt.has(el)) this.add(collection, id, field, el);
          break;
        }
        case 'seq':
          if (def.asText) this.setText(collection, id, field, value);
          else {
            const crdt = this.#crdt(collection, id, field);
            this.splice(collection, id, field, 0, crdt.length, [...(value ?? [])]);
          }
          break;
      }
    }
    return this;
  }

  /** Create a document with a fresh id. @returns {string} the id */
  create(collection, values = {}, id = newDocId()) {
    this.update(collection, id, values);
    return id;
  }

  /**
   * Soft-delete. The tombstone is a normal last-writer-wins field, so a delete
   * and a concurrent edit resolve by timestamp like any other write -- and an
   * undelete is just setting it back to false.
   */
  delete(collection, id) {
    this.#db.schema.collection(collection);
    this.#emit(collection, id, DELETED_FIELD, LWWRegister.op(true));
    return this;
  }

  restore(collection, id) {
    this.#db.schema.collection(collection);
    this.#emit(collection, id, DELETED_FIELD, LWWRegister.op(false));
    return this;
  }

  /** Finalise and hand the operations to whoever is listening (the outbox). */
  commit() {
    if (this.#committed) throw new ValidationError('transaction already committed');
    this.#committed = true;
    if (this.#ops.length) this.#db.emit('local-ops', { ops: this.ops });
    return this.ops;
  }
}
