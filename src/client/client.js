/**
 * @file The application-facing client: one object that owns identity, local
 * storage, the materialised database and the sync engine.
 *
 * The whole point is that application code below this line looks like it is
 * talking to a local database, because it is:
 *
 *     const client = await RivuletClient.open({ schema, room: 'notebook', transport });
 *     const id = client.mutate((tx) => tx.create('notes', { title: 'Hello' }));
 *     client.list('notes');            // reads back immediately, online or not
 *     client.subscribe('notes', render);
 *
 * There is no `await` on the network anywhere in that. `mutate` returns once
 * the write is in memory and queued; sync happens on its own schedule.
 *
 * ## Restart correctness
 *
 * Opening a client is not just "load the data". Three things must be recovered
 * or the replica silently corrupts its own history:
 *
 * 1. **Identity**, minted once and reused forever. A replica that re-mints its
 *    id restarts sequence numbers at 1, and its previous operations become
 *    unattributable -- worse, its *new* operation 1 collides with its old one.
 * 2. **The sequence counter**, resumed from the highest operation we hold.
 * 3. **The clock**, resumed past the highest timestamp we ever issued, so a
 *    restart cannot mint a timestamp that loses to a write it happened after.
 */

import { Emitter } from '#core/util';
import { Database } from '#core/database';
import { OpLog } from '#storage/oplog';
import { defaultAdapter } from '#storage/index';
import { SyncEngine, Status } from '#client/engine';
import { newNodeId } from '#core/ids';
import { ValidationError } from '#core/errors';

/**
 * Serialises local writes into the operation log.
 *
 * `mutate` returns synchronously, but the log append is asynchronous, so
 * without ordering here two problems appear: a sync could read the outbox
 * before a just-committed transaction reached it, and concurrent appends could
 * interleave. One promise chain fixes both, and {@link WriteQueue#drain} gives
 * the sync engine something to await.
 */
class WriteQueue {
  #tail = Promise.resolve();
  #log;
  #onError;

  constructor(log, onError) { this.#log = log; this.#onError = onError; }

  push(ops) {
    this.#tail = this.#tail
      .then(() => this.#log.append(ops))
      .then(() => this.#log.recordTimestamp(ops.at(-1).ts))
      .catch(this.#onError);
    return this.#tail;
  }

  /** Resolve once every queued write has landed. */
  drain() { return this.#tail; }
}

export class RivuletClient extends Emitter {
  #db;
  #log;
  #engine = null;
  #writes;
  #closed = false;

  constructor({ db, log, engine, writes }) {
    super();
    this.#db = db;
    this.#log = log;
    this.#engine = engine;
    this.#writes = writes;
    // Anything that changes the database is a reason to re-render.
    this.#db.on('change', (e) => this.emit('change', e));
    this.#db.on('batch', (e) => this.emit('batch', e));
    this.#engine?.on('status', (e) => this.emit('status', e));
    this.#engine?.on('sync', (e) => this.emit('sync', e));
    this.#engine?.on('error', (e) => this.emit('sync-error', e));
  }

  /**
   * Open a client: restore local state, then start syncing.
   *
   * @param {object} opts
   * @param {import('#core/schema').Schema} opts.schema
   * @param {string} opts.room synchronisation domain
   * @param {object} [opts.storage] adapter; chosen per environment if omitted
   * @param {object|((node: string) => object)} [opts.transport] omit for a
   *   purely local, offline database. A function is called with this replica's
   *   id once it has been restored from storage -- transports generally need
   *   it, and it does not exist until the log has been opened, so passing a
   *   factory is the only way to avoid constructing one with a placeholder
   * @param {boolean} [opts.autoStart]
   * @param {object} [opts.sync] {@link SyncEngine} options
   * @param {() => number} [opts.physical] injectable clock, for tests
   * @param {string} [opts.node] identity to mint on first run; a previously
   *   stored identity always takes precedence
   */
  static async open({
    schema, room = 'default', storage, transport,
    autoStart = true, sync: syncOpts, physical, node: fixedNode,
  }) {
    if (!schema) throw new ValidationError('a schema is required');

    const adapter = storage ?? await defaultAdapter({ name: room });
    const log = await new OpLog(adapter).open();

    // 1. Identity: minted on first run, reused forever after.
    //
    // An explicitly supplied id is treated as the *mint* rather than an
    // override, so it is persisted on first run and ignored on every later
    // one. A stored identity always wins: re-minting would restart sequence
    // numbering at 1 and collide with operations this replica already issued.
    const node = await log.identity(() => fixedNode ?? newNodeId());

    // 2 and 3. Resume the sequence counter and the clock past everything we
    // already issued, so a restart cannot replay a sequence number or rewind.
    const { seq, lastTs } = await log.resumePoint(node);

    const db = new Database({ schema, node, startSeq: seq, lastTimestamp: lastTs, physical });

    // Replay the durable log into memory. Snapshot first when one exists, so
    // startup is O(state) rather than O(history).
    const snapshot = await log.latestSnapshot();
    if (snapshot?.state?.v) db.loadSnapshot(snapshot.state);
    const stored = await log.read();
    db.applyAll(stored);

    const schemaState = await log.checkSchema(schema.fingerprint);

    const link = typeof transport === 'function' ? transport(node) : transport;

    /** @type {WriteQueue} */
    let writes;
    const engine = link
      ? new SyncEngine({
        db, log, transport: link, room, schema: schema.fingerprint,
        beforeSync: () => writes.drain(),
        ...syncOpts,
      })
      : null;

    const client = new RivuletClient({ db, log, engine, writes: null });
    writes = new WriteQueue(log, (err) => client.emit('storage-error', err));
    client._attachWrites(writes);
    client.schemaState = schemaState;

    // Persist every local write, and keep the clock mark ahead of it, so a
    // crash between writing and syncing cannot rewind us on the next start.
    db.on('local-ops', ({ ops }) => { writes.push(ops); });

    if (engine && autoStart) await engine.start();
    return client;
  }

  /** @internal wiring, so the queue can report errors through this emitter */
  _attachWrites(writes) { this.#writes = writes; }

  /** Resolve once every local write has reached durable storage. */
  async flush() { await this.#writes?.drain(); }

  /* -------------------------------------------------------------- reading */

  get db() { return this.#db; }
  get log() { return this.#log; }
  get engine() { return this.#engine; }
  get node() { return this.#db.node; }
  get status() { return this.#engine?.status ?? Status.OFFLINE; }
  get online() { return this.#engine?.online ?? false; }

  get(collection, id, opts) { return this.#db.get(collection, id, opts); }
  exists(collection, id) { return this.#db.exists(collection, id); }
  find(collection, where, opts) { return this.#db.find(collection, where, opts); }
  findOne(collection, where, opts) { return this.#db.findOne(collection, where, opts); }
  list(collection, opts) { return this.#db.list(collection, opts); }
  count(collection, opts) { return this.#db.count(collection, opts); }
  conflicts(collection) { return this.#db.conflicts(collection); }
  hasConflict(collection, id) { return this.#db.hasConflict(collection, id); }

  /**
   * Re-run `render` whenever `collection` changes, and once immediately.
   * Deliberately coarse: it re-reads rather than diffing, which is the right
   * trade at the scale a single device's working set lives at, and removes a
   * whole class of stale-view bugs.
   * @returns {() => void} unsubscribe
   */
  subscribe(collection, render, opts) {
    const run = () => render(this.#db.list(collection, opts));
    const off = this.#db.on('change', (e) => { if (e.collection === collection) run(); });
    const offBatch = this.#db.on('batch', run);
    run();
    return () => { off(); offBatch(); };
  }

  /* -------------------------------------------------------------- writing */

  /**
   * Apply a change locally and queue it for sync. Returns synchronously --
   * durability and delivery are the engine's problem, not the caller's.
   * @param {(tx: import('#core/database').Transaction) => any} fn
   */
  mutate(fn) {
    if (this.#closed) throw new ValidationError('client is closed');
    return this.#db.mutate(fn).result;
  }

  /* ----------------------------------------------------------------- sync */

  /** Force a reconciliation now. Resolves when the round completes. */
  async sync() {
    await this.flush();
    if (!this.#engine) return { pushed: 0, pulled: 0, rounds: 0 };
    return this.#engine.sync();
  }

  /** Sync until nothing is outstanding in either direction. */
  async syncUntilIdle(opts) {
    await this.flush();
    if (!this.#engine) return { pushed: 0, pulled: 0, rounds: 0 };
    return this.#engine.syncUntilIdle(opts);
  }

  /** Tell the engine the device is back online, short-circuiting backoff. */
  resume() { this.#engine?.resume(); }

  /** Operations written locally but not yet acknowledged by the server. */
  async pendingCount() {
    await this.flush();
    return this.#log.outboxSize(this.#db.node);
  }

  async stats() {
    return {
      node: this.node,
      database: this.#db.stats,
      log: this.#log.stats,
      storedOps: await this.#log.count(),
      pending: await this.pendingCount(),
      sync: this.#engine?.stats ?? { status: Status.OFFLINE },
    };
  }

  async close() {
    this.#closed = true;
    await this.flush();
    await this.#engine?.stop();
    await this.#log.close();
    this.removeAllListeners();
  }
}

export { Status };
