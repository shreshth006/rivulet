/**
 * @file The storage contract, and the in-memory implementation of it.
 *
 * Three environments need durable operations -- a browser (IndexedDB), a Node
 * client or server (SQLite), and tests and benchmarks (memory) -- and the sync
 * engine must not care which it is talking to. So the interface is deliberately
 * narrow: append operations, ask which ones a peer is missing, read and write a
 * little metadata.
 *
 * Everything is async, because IndexedDB is. SQLite pays a negligible price for
 * that and it keeps one code path instead of three.
 *
 * ## The query that matters
 *
 * {@link StorageAdapter#opsSince} is the whole sync protocol in one call:
 * given a peer's version vector, return the operations it does not have. It
 * must be bounded (`limit`) and resumable, because the target environment
 * drops connections mid-transfer and an initial sync that cannot resume is an
 * initial sync that never completes.
 *
 * Results are ordered by `(node, seq)` rather than by timestamp. That keeps
 * each replica's operations contiguous, which is exactly what the codec's
 * delta encoding wants -- consecutive sequence numbers collapse to a run of
 * 1s -- and costs nothing in correctness, since the CRDTs accept any order.
 */

import { StorageError } from '#core/errors';
import { validateOp } from '#core/op';

/**
 * @typedef {object} StorageAdapter
 * @property {() => Promise<void>} open
 * @property {() => Promise<void>} close
 * @property {(ops: object[]) => Promise<number>} appendOps insert-or-ignore; returns how many were new
 * @property {(vector: object, opts?: object) => Promise<{ops: object[], more: boolean}>} opsSince
 * @property {(opts?: object) => Promise<object[]>} readOps
 * @property {(node: string, seq: number) => Promise<boolean>} hasOp
 * @property {() => Promise<number>} countOps
 * @property {(key: string) => Promise<any>} getMeta
 * @property {(key: string, value: any) => Promise<void>} setMeta
 * @property {() => Promise<object>} frontier highest contiguous seq per replica
 * @property {() => Promise<void>} clear
 */

/** Default page size for a bounded pull. */
export const DEFAULT_PAGE = 500;

/** Primary key for an operation, as adapters store it. */
export const opId = (op) => `${op.node}:${String(op.seq).padStart(12, '0')}`;

/**
 * Turn a sorted list of sequence numbers into inclusive ranges.
 * Shared by every adapter: the storage engines differ in how they enumerate
 * keys, but not in what a run of consecutive ones means.
 * @param {number[]} sorted
 * @returns {Array<[number, number]>}
 */
export function compactRanges(sorted) {
  /** @type {Array<[number, number]>} */
  const out = [];
  for (const seq of sorted) {
    const last = out.at(-1);
    if (last && seq === last[1] + 1) last[1] = seq;
    else out.push([seq, seq]);
  }
  return out;
}

/**
 * Reference implementation: keeps everything in memory.
 *
 * Used by the benchmarks and most tests, where durability is noise and being
 * able to spin up forty replicas in a millisecond is the point. It is also the
 * executable specification -- the SQLite and IndexedDB adapters are checked
 * against the same conformance suite.
 */
export class MemoryAdapter {
  /** @type {Map<string, object>} opId -> op, insertion ordered */
  #ops = new Map();
  /** @type {Map<string, Map<number, object>>} node -> seq -> op */
  #byNode = new Map();
  /** @type {Map<string, any>} */
  #meta = new Map();
  #open = false;

  constructor({ name = 'memory' } = {}) { this.name = name; }

  async open() { this.#open = true; }
  async close() { this.#open = false; }

  #assertOpen() {
    if (!this.#open) throw new StorageError('adapter is not open', { adapter: this.name });
  }

  async appendOps(ops) {
    this.#assertOpen();
    let added = 0;
    for (const op of ops) {
      validateOp(op);
      const id = opId(op);
      if (this.#ops.has(id)) continue; // already stored: the log de-duplicates
      this.#ops.set(id, op);
      if (!this.#byNode.has(op.node)) this.#byNode.set(op.node, new Map());
      this.#byNode.get(op.node).set(op.seq, op);
      added++;
    }
    return added;
  }

  async opsSince(vector = {}, { limit = DEFAULT_PAGE, exclude } = {}) {
    this.#assertOpen();
    const out = [];
    let more = false;

    for (const node of [...this.#byNode.keys()].sort()) {
      if (exclude && node === exclude) continue;
      const from = vector[node] ?? 0;
      const seqs = [...this.#byNode.get(node).keys()].filter((s) => s > from).sort((a, b) => a - b);
      for (const seq of seqs) {
        if (out.length >= limit) { more = true; break; }
        out.push(this.#byNode.get(node).get(seq));
      }
      if (more) break;
    }
    return { ops: out, more };
  }

  async readOps({ node, fromSeq = 0, toSeq = Infinity, limit = Infinity } = {}) {
    this.#assertOpen();
    const out = [];
    const nodes = node ? [node] : [...this.#byNode.keys()].sort();
    for (const n of nodes) {
      const map = this.#byNode.get(n);
      if (!map) continue;
      for (const seq of [...map.keys()].sort((a, b) => a - b)) {
        if (seq <= fromSeq || seq > toSeq) continue;
        if (out.length >= limit) return out;
        out.push(map.get(seq));
      }
    }
    return out;
  }

  async hasOp(node, seq) {
    this.#assertOpen();
    return this.#byNode.get(node)?.has(seq) ?? false;
  }

  async countOps() { this.#assertOpen(); return this.#ops.size; }

  async frontier() {
    this.#assertOpen();
    /** @type {Record<string, number>} */
    const out = {};
    for (const [node, map] of this.#byNode) {
      let f = 0;
      while (map.has(f + 1)) f++;
      if (f > 0) out[node] = f;
    }
    return out;
  }

  async maxSeqs() {
    this.#assertOpen();
    /** @type {Record<string, number>} */
    const out = {};
    for (const [node, map] of this.#byNode) out[node] = Math.max(...map.keys());
    return out;
  }

  /**
   * Which sequence numbers are held, per replica, as compact ranges.
   * The op log rebuilds its in-memory frontier from this at startup, so it
   * must be cheap and must not load payloads.
   * @returns {Promise<Record<string, Array<[number, number]>>>}
   */
  async seqRanges() {
    this.#assertOpen();
    /** @type {Record<string, Array<[number, number]>>} */
    const out = {};
    for (const [node, map] of this.#byNode) {
      out[node] = compactRanges([...map.keys()].sort((a, b) => a - b));
    }
    return out;
  }

  async getMeta(key) {
    this.#assertOpen();
    const v = this.#meta.get(key);
    return v === undefined ? undefined : JSON.parse(v);
  }

  async setMeta(key, value) {
    this.#assertOpen();
    if (value === undefined) this.#meta.delete(key);
    else this.#meta.set(key, JSON.stringify(value));
  }

  async clear() {
    this.#ops.clear();
    this.#byNode.clear();
    this.#meta.clear();
  }

  /** Approximate footprint, for the benchmarks' memory column. */
  async sizeBytes() {
    let n = 0;
    for (const op of this.#ops.values()) n += JSON.stringify(op).length;
    return n;
  }

  /** Telemetry breakdown for in-memory storage. */
  async stats() {
    this.#assertOpen();
    const byNode = {};
    for (const [node, map] of this.#byNode) {
      byNode[node] = map.size;
    }
    return {
      adapter: 'memory',
      name: this.name,
      operations: this.#ops.size,
      nodes: this.#byNode.size,
      metadataKeys: this.#meta.size,
      sizeBytes: await this.sizeBytes(),
      byNode,
    };
  }
}
