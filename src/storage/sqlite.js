/**
 * @file SQLite-backed storage, for the server and for Node clients.
 *
 * Uses Node's built-in `node:sqlite`, so the whole engine keeps its zero-
 * dependency property -- worth real money for a research artefact, which
 * someone should be able to clone and run in five years without a lockfile
 * archaeology session.
 *
 * Durability settings are chosen for this workload specifically:
 *
 * - **WAL journaling.** Readers never block the writer. The server materialises
 *   and serves reads while sync writes land underneath.
 * - **`synchronous = NORMAL`.** Full fsync on every commit would cap sync
 *   throughput at the disk's fsync rate for no real benefit here: an operation
 *   lost to an OS crash is still held by the replica that produced it, and
 *   will be resent on the next sync. The log is redundant by construction.
 *
 * Schema notes: `(node, seq)` is the primary key, which makes append
 * de-duplication a plain `INSERT OR IGNORE` -- the cheapest possible
 * exactly-once guarantee, enforced by the storage engine rather than by us.
 */

import { DatabaseSync } from 'node:sqlite';
import { StorageError } from '#core/errors';
import { validateOp } from '#core/op';
import { DEFAULT_PAGE, compactRanges } from '#storage/adapter';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ops (
  node       TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  ts         TEXT    NOT NULL,
  collection TEXT    NOT NULL,
  doc        TEXT    NOT NULL,
  field      TEXT    NOT NULL,
  payload    TEXT    NOT NULL,
  PRIMARY KEY (node, seq)
) WITHOUT ROWID;

-- Serves "what changed in this document?" without scanning the log.
CREATE INDEX IF NOT EXISTS ops_by_doc ON ops (collection, doc, ts);
-- Serves ordered replay and causal-stability queries.
CREATE INDEX IF NOT EXISTS ops_by_ts ON ops (ts);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS snapshots (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at  INTEGER NOT NULL,
  frontier  TEXT    NOT NULL,
  state     TEXT    NOT NULL
);
`;

export class SqliteAdapter {
  #db = null;
  #stmts = null;
  #path;
  #pragmas;

  /**
   * @param {object} opts
   * @param {string} [opts.path] file path, or ':memory:' for an ephemeral store
   * @param {boolean} [opts.durable] full fsync per commit; slower, rarely needed
   */
  constructor({ path = ':memory:', durable = false } = {}) {
    this.#path = path;
    this.name = `sqlite(${path})`;
    this.#pragmas = durable ? 'FULL' : 'NORMAL';
  }

  async open() {
    if (this.#db) return;
    try {
      this.#db = new DatabaseSync(this.#path);
    } catch (err) {
      throw new StorageError('could not open the database', { path: this.#path, cause: String(err) });
    }
    this.#db.exec(`PRAGMA journal_mode = WAL;`);
    this.#db.exec(`PRAGMA synchronous = ${this.#pragmas};`);
    this.#db.exec(`PRAGMA foreign_keys = ON;`);
    this.#db.exec(SCHEMA);

    this.#stmts = {
      insert: this.#db.prepare(
        `INSERT OR IGNORE INTO ops (node, seq, ts, collection, doc, field, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`),
      has: this.#db.prepare(`SELECT 1 FROM ops WHERE node = ? AND seq = ?`),
      count: this.#db.prepare(`SELECT COUNT(*) AS n FROM ops`),
      maxSeqs: this.#db.prepare(`SELECT node, MAX(seq) AS m FROM ops GROUP BY node`),
      perNodeSeqs: this.#db.prepare(`SELECT seq FROM ops WHERE node = ? ORDER BY seq`),
      getMeta: this.#db.prepare(`SELECT value FROM meta WHERE key = ?`),
      setMeta: this.#db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
                                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
      delMeta: this.#db.prepare(`DELETE FROM meta WHERE key = ?`),
      saveSnapshot: this.#db.prepare(
        `INSERT INTO snapshots (taken_at, frontier, state) VALUES (?, ?, ?)`),
      latestSnapshot: this.#db.prepare(
        `SELECT frontier, state FROM snapshots ORDER BY id DESC LIMIT 1`),
      pruneSnapshots: this.#db.prepare(
        `DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT ?)`),
    };
  }

  async close() {
    this.#db?.close();
    this.#db = null;
    this.#stmts = null;
  }

  #assertOpen() {
    if (!this.#db) throw new StorageError('adapter is not open', { adapter: this.name });
  }

  #row(op) {
    return [op.node, op.seq, op.ts, op.collection, op.doc, op.field, JSON.stringify(op.payload)];
  }

  #parse(row) {
    return {
      node: row.node, seq: row.seq, ts: row.ts,
      collection: row.collection, doc: row.doc, field: row.field,
      payload: JSON.parse(row.payload),
    };
  }

  async appendOps(ops) {
    this.#assertOpen();
    if (ops.length === 0) return 0;
    // Validate before opening a transaction, so a malformed operation surfaces
    // as the validation error it is rather than a wrapped storage failure --
    // and so a bad batch never opens a write lock at all.
    for (const op of ops) validateOp(op);

    let added = 0;
    // One transaction for the whole batch: sync pushes arrive in bulk and
    // per-operation commits would dominate the cost.
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const op of ops) {
        added += this.#stmts.insert.run(...this.#row(op)).changes;
      }
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw new StorageError('could not append operations', { cause: String(err) });
    }
    return added;
  }

  /**
   * Operations a peer with `vector` is missing.
   *
   * The per-node threshold is expressed as a `CASE` over the node column, so
   * the whole delta is one indexed scan with a bounded parameter list, rather
   * than one query per replica.
   */
  async opsSince(vector = {}, { limit = DEFAULT_PAGE, exclude } = {}) {
    this.#assertOpen();
    const nodes = Object.keys(vector);
    const params = [];
    let threshold = '0';
    if (nodes.length) {
      const cases = nodes.map((n) => { params.push(n, vector[n]); return 'WHEN ? THEN ?'; }).join(' ');
      threshold = `CASE node ${cases} ELSE 0 END`;
    }
    let where = `seq > ${threshold}`;
    if (exclude) { where += ' AND node != ?'; params.push(exclude); }

    // Fetch one extra row to learn whether another page exists, without a count.
    params.push(limit + 1);
    const rows = this.#db
      .prepare(`SELECT node, seq, ts, collection, doc, field, payload FROM ops
                WHERE ${where} ORDER BY node, seq LIMIT ?`)
      .all(...params);

    const more = rows.length > limit;
    return { ops: rows.slice(0, limit).map((r) => this.#parse(r)), more };
  }

  async readOps({ node, fromSeq = 0, toSeq, limit, collection, doc } = {}) {
    this.#assertOpen();
    const clauses = ['seq > ?'];
    const params = [fromSeq];
    if (node) { clauses.push('node = ?'); params.push(node); }
    if (toSeq !== undefined) { clauses.push('seq <= ?'); params.push(toSeq); }
    if (collection) { clauses.push('collection = ?'); params.push(collection); }
    if (doc) { clauses.push('doc = ?'); params.push(doc); }
    let sql = `SELECT node, seq, ts, collection, doc, field, payload FROM ops
               WHERE ${clauses.join(' AND ')} ORDER BY node, seq`;
    if (limit !== undefined) { sql += ' LIMIT ?'; params.push(limit); }
    return this.#db.prepare(sql).all(...params).map((r) => this.#parse(r));
  }

  async hasOp(node, seq) {
    this.#assertOpen();
    return this.#stmts.has.get(node, seq) !== undefined;
  }

  async countOps() {
    this.#assertOpen();
    return this.#stmts.count.get().n;
  }

  /**
   * Highest *contiguous* sequence per replica. Deliberately not `MAX(seq)`:
   * after an out-of-order delivery the log may hold 1..20 and 27..42, and
   * claiming 42 would mean 21..26 are never resent.
   */
  async frontier() {
    this.#assertOpen();
    /** @type {Record<string, number>} */
    const out = {};
    for (const { node } of this.#stmts.maxSeqs.all()) {
      const seqs = this.#stmts.perNodeSeqs.all(node);
      let f = 0;
      for (const { seq } of seqs) { if (seq === f + 1) f = seq; else break; }
      if (f > 0) out[node] = f;
    }
    return out;
  }

  async maxSeqs() {
    this.#assertOpen();
    /** @type {Record<string, number>} */
    const out = {};
    for (const { node, m } of this.#stmts.maxSeqs.all()) out[node] = m;
    return out;
  }

  /**
   * Which sequence numbers are held, per replica, as compact ranges.
   * Keys only -- no payloads are read, so this stays cheap enough to run at
   * startup even on a large log.
   * @returns {Promise<Record<string, Array<[number, number]>>>}
   */
  async seqRanges() {
    this.#assertOpen();
    /** @type {Record<string, Array<[number, number]>>} */
    const out = {};
    for (const { node } of this.#stmts.maxSeqs.all()) {
      out[node] = compactRanges(this.#stmts.perNodeSeqs.all(node).map((r) => r.seq));
    }
    return out;
  }

  async getMeta(key) {
    this.#assertOpen();
    const row = this.#stmts.getMeta.get(key);
    return row === undefined ? undefined : JSON.parse(row.value);
  }

  async setMeta(key, value) {
    this.#assertOpen();
    if (value === undefined) this.#stmts.delMeta.run(key);
    else this.#stmts.setMeta.run(key, JSON.stringify(value));
  }

  /** Persist a compacted snapshot alongside the log, keeping the last few. */
  async saveSnapshot(state, frontier, { keep = 3 } = {}) {
    this.#assertOpen();
    this.#stmts.saveSnapshot.run(Date.now(), JSON.stringify(frontier), JSON.stringify(state));
    this.#stmts.pruneSnapshots.run(keep);
  }

  async latestSnapshot() {
    this.#assertOpen();
    const row = this.#stmts.latestSnapshot.get();
    if (!row) return null;
    return { frontier: JSON.parse(row.frontier), state: JSON.parse(row.state) };
  }

  /** Drop operations already covered by a snapshot -- log compaction. */
  async truncateBelow(frontier) {
    this.#assertOpen();
    let removed = 0;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const [node, seq] of Object.entries(frontier)) {
        removed += this.#db.prepare('DELETE FROM ops WHERE node = ? AND seq <= ?').run(node, seq).changes;
      }
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw new StorageError('could not truncate the log', { cause: String(err) });
    }
    return removed;
  }

  async clear() {
    this.#assertOpen();
    this.#db.exec('DELETE FROM ops; DELETE FROM meta; DELETE FROM snapshots;');
  }

  async sizeBytes() {
    this.#assertOpen();
    const { n } = this.#db.prepare(
      `SELECT COALESCE(SUM(LENGTH(node) + LENGTH(ts) + LENGTH(collection) +
              LENGTH(doc) + LENGTH(field) + LENGTH(payload) + 8), 0) AS n FROM ops`).get();
    return n;
  }

  /** Reclaim free pages after a truncation. */
  async vacuum() { this.#assertOpen(); this.#db.exec('VACUUM'); }
}
