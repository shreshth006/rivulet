/**
 * @file The operation log: durable storage plus the bookkeeping sync needs.
 *
 * Sits on any {@link StorageAdapter} and adds the three things every replica
 * needs regardless of where its bytes live:
 *
 * 1. **Exactly-once delivery to the CRDTs.** The adapter's primary key already
 *    rejects a duplicate `(node, seq)`; the log turns that into a precise
 *    answer -- *these* operations were new -- so the CRDT layer applies each
 *    one once and no type has to carry its own seen-set. This is the layering
 *    that lets the PN-counter exist at all.
 *
 * 2. **An accurate frontier.** Held in memory as a {@link RangeSet} per
 *    replica, rebuilt from the adapter at startup and advanced on every
 *    append. Gaps from partial transfers are tracked exactly, so what goes on
 *    the wire is only the contiguous prefix a peer can rely on.
 *
 * 3. **An outbox.** Local operations not yet acknowledged by the server. Rather
 *    than a second table that could drift out of step with the log, this is
 *    derived: one persisted watermark, and the outbox is everything after it.
 *    A crash mid-push replays; it cannot lose or duplicate.
 */

import { Emitter } from '#core/util';
import { RangeSet } from '#core/range-set';
import { VersionVector } from '#core/version-vector';
import { DEFAULT_PAGE } from '#storage/adapter';
import { StorageError } from '#core/errors';

const META = Object.freeze({
  NODE: 'node',            // this replica's id, minted once and kept forever
  LAST_TS: 'lastTs',       // HLC high-water mark, so a restart cannot rewind
  PUSHED: 'pushedSeq',     // outbox watermark: local seq the server has acked
  SERVER_HAVE: 'serverHave', // last known server frontier, to skip no-op syncs
  SCHEMA: 'schema',        // fingerprint, to detect an app upgrade
});

export class OpLog extends Emitter {
  #adapter;
  /** @type {Map<string, RangeSet>} replica -> sequence numbers held */
  #ranges = new Map();
  #open = false;

  /** @param {import('#storage/adapter').StorageAdapter} adapter */
  constructor(adapter) {
    super();
    this.#adapter = adapter;
  }

  get adapter() { return this.#adapter; }

  async open() {
    if (this.#open) return this;
    await this.#adapter.open();
    // Rebuild what we hold from the store itself rather than trusting a cached
    // summary: after a crash the cache may be stale, the store never is.
    const ranges = await this.#adapter.seqRanges();
    for (const [node, list] of Object.entries(ranges)) this.#ranges.set(node, new RangeSet(list));
    this.#open = true;
    return this;
  }

  async close() { this.#open = false; await this.#adapter.close(); }

  #assertOpen() {
    if (!this.#open) throw new StorageError('operation log is not open');
  }

  /* ----------------------------------------------------------- appending */

  /**
   * Store operations, returning only the ones that were new.
   *
   * The caller applies exactly that subset to its CRDTs. Resending after a
   * timeout, receiving the same operation from two peers, or replaying a
   * partial batch are therefore all free.
   *
   * @param {object[]} ops
   * @returns {Promise<{ added: number, fresh: object[], duplicates: number }>}
   */
  async append(ops) {
    this.#assertOpen();
    if (ops.length === 0) return { added: 0, fresh: [], duplicates: 0 };

    const fresh = [];
    for (const op of ops) {
      const held = this.#ranges.get(op.node);
      if (!held?.has(op.seq)) fresh.push(op);
    }
    if (fresh.length === 0) return { added: 0, fresh: [], duplicates: ops.length };

    const added = await this.#adapter.appendOps(fresh);
    for (const op of fresh) {
      if (!this.#ranges.has(op.node)) this.#ranges.set(op.node, new RangeSet());
      this.#ranges.get(op.node).add(op.seq);
    }

    this.emit('append', { ops: fresh });
    return { added, fresh, duplicates: ops.length - fresh.length };
  }

  /* ------------------------------------------------------------ querying */

  /**
   * Operations a peer with `vector` does not have. Bounded and resumable:
   * when `more` is true the caller re-asks with an advanced vector, which is
   * how a large initial sync survives a link that drops every few minutes.
   */
  async delta(vector, { limit = DEFAULT_PAGE, exclude } = {}) {
    this.#assertOpen();
    const have = vector instanceof VersionVector ? vector.toJSON() : (vector ?? {});
    return this.#adapter.opsSince(have, { limit, exclude });
  }

  /** What this replica can honestly claim to hold. */
  frontier() {
    this.#assertOpen();
    const vv = new VersionVector();
    for (const [node, ranges] of this.#ranges) {
      const f = ranges.frontier();
      if (f > 0) vv.observe(node, f);
    }
    return vv;
  }

  /** Gaps below each replica's highest held sequence -- what to re-request. */
  gaps() {
    this.#assertOpen();
    /** @type {Record<string, Array<[number, number]>>} */
    const out = {};
    for (const [node, ranges] of this.#ranges) {
      const g = ranges.gaps();
      if (g.length) out[node] = g;
    }
    return out;
  }

  has(node, seq) { return this.#ranges.get(node)?.has(seq) ?? false; }

  /** Highest sequence held per replica, gaps included. */
  heads() {
    /** @type {Record<string, number>} */
    const out = {};
    for (const [node, ranges] of this.#ranges) out[node] = ranges.max();
    return out;
  }

  async count() { this.#assertOpen(); return this.#adapter.countOps(); }
  async read(opts) { this.#assertOpen(); return this.#adapter.readOps(opts); }
  async sizeBytes() { return this.#adapter.sizeBytes?.() ?? 0; }

  /* --------------------------------------------------------- the outbox */

  /**
   * Local operations the server has not acknowledged.
   * Derived from one watermark rather than stored separately, so it can never
   * disagree with the log.
   */
  async outbox(node, { limit = DEFAULT_PAGE } = {}) {
    this.#assertOpen();
    const pushed = (await this.getMeta(META.PUSHED)) ?? 0;
    return this.#adapter.readOps({ node, fromSeq: pushed, limit });
  }

  async outboxSize(node) {
    const pushed = (await this.getMeta(META.PUSHED)) ?? 0;
    const held = this.#ranges.get(node);
    return held ? Math.max(0, held.max() - pushed) : 0;
  }

  /**
   * Advance the outbox watermark after a successful push.
   * Only ever moves forward: a late or duplicated acknowledgement must not
   * resurrect operations the server already has.
   */
  async markPushed(seq) {
    const current = (await this.getMeta(META.PUSHED)) ?? 0;
    if (seq > current) await this.setMeta(META.PUSHED, seq);
    return Math.max(seq, current);
  }

  async pushedSeq() { return (await this.getMeta(META.PUSHED)) ?? 0; }

  /* ---------------------------------------------------------- metadata */

  async getMeta(key) { this.#assertOpen(); return this.#adapter.getMeta(key); }
  async setMeta(key, value) { this.#assertOpen(); return this.#adapter.setMeta(key, value); }
  async deleteMeta(key) { this.#assertOpen(); return this.#adapter.setMeta(key, undefined); }
  async hasMeta(key) { this.#assertOpen(); return (await this.#adapter.getMeta(key)) !== undefined; }

  /**
   * This replica's durable identity, minted on first run.
   * Must survive restarts: a replica that re-mints its id restarts its
   * sequence numbers at 1 and its old operations become unattributable.
   */
  async identity(mint) {
    let node = await this.getMeta(META.NODE);
    if (!node) { node = mint(); await this.setMeta(META.NODE, node); }
    return node;
  }

  /** Resume points for the clock and the sequence counter after a restart. */
  async resumePoint(node) {
    const held = this.#ranges.get(node);
    return {
      seq: held?.max() ?? 0,
      lastTs: await this.getMeta(META.LAST_TS),
    };
  }

  /** Record the highest timestamp seen, so a restart cannot rewind the clock. */
  async recordTimestamp(ts) {
    const last = await this.getMeta(META.LAST_TS);
    if (!last || ts > last) await this.setMeta(META.LAST_TS, ts);
  }

  async serverFrontier() { return VersionVector.fromJSON((await this.getMeta(META.SERVER_HAVE)) ?? {}); }
  async setServerFrontier(vv) { await this.setMeta(META.SERVER_HAVE, vv.toJSON()); }

  /**
   * Compare the stored schema fingerprint with the running one.
   * @returns {Promise<'first-run'|'match'|'changed'>}
   */
  async checkSchema(fingerprint) {
    const stored = await this.getMeta(META.SCHEMA);
    if (stored === undefined) { await this.setMeta(META.SCHEMA, fingerprint); return 'first-run'; }
    if (stored === fingerprint) return 'match';
    return 'changed';
  }

  async acceptSchema(fingerprint) { await this.setMeta(META.SCHEMA, fingerprint); }

  /* -------------------------------------------------------- compaction */

  /** Whether the underlying storage adapter supports snapshotting and compaction. */
  get canCompact() {
    return typeof this.#adapter.saveSnapshot === 'function' &&
           typeof this.#adapter.truncateBelow === 'function';
  }

  /**
   * Replace the covered prefix of the log with a snapshot.
   *
   * Safe only up to a frontier every replica has: anything newer may still be
   * needed to answer a peer's pull. The in-memory ranges keep the truncated
   * prefix marked as held, because we still *have* those operations' effects
   * -- discarding that would make us re-request our own history.
   */
  async compact(state, upTo) {
    this.#assertOpen();
    if (typeof this.#adapter.saveSnapshot !== 'function') {
      throw new StorageError('this adapter does not support compaction', { adapter: this.#adapter.name });
    }
    const frontier = upTo instanceof VersionVector ? upTo.toJSON() : upTo;
    await this.#adapter.saveSnapshot(state, frontier);
    const removed = await this.#adapter.truncateBelow(frontier);
    this.emit('compact', { removed, frontier });
    return removed;
  }

  /** Save a snapshot into storage without log truncation. */
  async saveSnapshot(state, upTo, opts) {
    this.#assertOpen();
    if (typeof this.#adapter.saveSnapshot !== 'function') {
      throw new StorageError('this adapter does not support snapshots', { adapter: this.#adapter.name });
    }
    const frontier = upTo instanceof VersionVector ? upTo.toJSON() : upTo;
    await this.#adapter.saveSnapshot(state, frontier, opts);
    this.emit('snapshot', { frontier });
  }

  async latestSnapshot() {
    return this.#adapter.latestSnapshot?.() ?? null;
  }


  /** Reclaim freed storage space if the underlying adapter supports it (e.g. SQLite). */
  async vacuum() {
    this.#assertOpen();
    if (typeof this.#adapter.vacuum === 'function') {
      await this.#adapter.vacuum();
      return true;
    }
    return false;
  }

  async clear() {
    this.#assertOpen();
    await this.#adapter.clear();
    this.#ranges.clear();
  }

  /**
   * Export recorded operations in the log.
   * @param {object} [opts]
   * @param {string} [opts.collection]
   * @param {string} [opts.doc]
   * @returns {Promise<object[]>}
   */
  async exportOps(opts = {}) {
    this.#assertOpen();
    return this.#adapter.readOps(opts);
  }

  /**
   * Import operations into the log.
   * @param {object[]} ops
   * @returns {Promise<{added: number, duplicates: number, fresh: object[]}>}
   */
  async importOps(ops) {
    this.#assertOpen();
    return this.append(ops);
  }

  /**
   * Export operations serialized as JSON.
   * @param {object} [opts]
   * @param {number|string} [opts.indent]
   * @returns {Promise<string>}
   */
  async exportJson({ indent, ...opts } = {}) {
    const ops = await this.exportOps(opts);
    return JSON.stringify(ops, null, indent);
  }

  /**
   * Import operations from a JSON serialized string.
   * @param {string} jsonString
   * @returns {Promise<{added: number, duplicates: number, fresh: object[]}>}
   */
  async importJson(jsonString) {
    let parsed;
    try {
      parsed = JSON.parse(jsonString);
    } catch (err) {
      throw new StorageError('invalid JSON for operation import', { cause: String(err) });
    }
    if (!Array.isArray(parsed)) {
      throw new StorageError('operation import JSON must be an array', { received: typeof parsed });
    }
    return this.importOps(parsed);
  }

  get stats() {
    let held = 0, rangeCount = 0;
    for (const ranges of this.#ranges.values()) { held += ranges.size; rangeCount += ranges.rangeCount; }
    return {
      replicas: this.#ranges.size,
      operations: held,
      // More ranges than replicas means gaps: a partial transfer is outstanding.
      ranges: rangeCount,
      fragmented: rangeCount > this.#ranges.size,
    };
  }
}

export const MetaKeys = META;
