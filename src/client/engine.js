/**
 * @file The client sync engine: everything between a local write and a server.
 *
 * The engine's job is to make the network invisible to the application. Writes
 * go to local storage and return; the engine decides when and how to reconcile,
 * and the app's reads never block on it.
 *
 * ## Design commitments
 *
 * **Offline is the normal case, not the error case.** There is no "failed"
 * terminal state and no error to handle at the call site. Being unable to
 * reach the server is an expected condition that resolves itself, so the
 * engine retries with backoff and the UI shows a status, not a dialog.
 *
 * **Every retry is safe.** A push is idempotent: operations are keyed by
 * `(node, seq)` and the server ignores ones it has. So a request that times
 * out after the server processed it costs a duplicate transfer and nothing
 * else. This is what lets the engine retry aggressively without bookkeeping
 * about what might have half-happened.
 *
 * **The outbox watermark only moves on proof.** It advances to the frontier
 * the server reports for *our* replica, never to what we hoped we sent. A
 * partially accepted push retries exactly the part that did not land.
 *
 * **Gaps heal themselves.** If a batch arrives incomplete, the frontier stops
 * at the hole, so the next pull starts from there and re-sends the rest. The
 * duplicates are discarded by the log. No repair protocol is needed.
 *
 * **The stream is an optimisation.** Server push shortens latency; it never
 * carries data the engine could not get by syncing. A stream that dies
 * silently degrades to polling.
 */

import { Emitter, backoffDelay } from '#core/util';
import { encodeOps, decodeOps } from '#protocol/codec';
import { sync as syncMessage, hello, MessageType, validateMessage, readVector } from '#protocol/messages';
import { AdaptiveBatcher } from '#client/adaptive';
import { RivuletError, AuthError } from '#core/errors';

/** @typedef {'offline'|'connecting'|'syncing'|'live'|'unauthorised'} Status */

/**
 * Largest delay a timer can express (2^31-1 ms, about 24.8 days).
 *
 * Exceeding it does not push the timer further out -- the runtime silently
 * truncates to a 32-bit value, and a delay of, say, 4e9 ms fires after 1ms.
 * That turns an idle poll into a spin loop that syncs continuously, which is
 * exactly the opposite of what a long interval was asking for, and on a
 * metered link would be expensive as well as wrong.
 */
const MAX_TIMER_DELAY = 2_147_483_647;

export const Status = Object.freeze({
  OFFLINE: 'offline',
  CONNECTING: 'connecting',
  SYNCING: 'syncing',
  LIVE: 'live',
  UNAUTHORISED: 'unauthorised',
});

export class SyncEngine extends Emitter {
  #db;
  #log;
  #transport;
  #room;
  #schema;
  #batcher;

  #status = Status.OFFLINE;
  #running = false;
  #attempt = 0;
  #inFlight = null;
  #queued = null;
  #timer = null;
  #unsubscribe = null;
  #dirty = false;
  #lastError = null;

  #opts;
  #timers;
  #beforeSync;
  #codec;

  /**
   * @param {object} opts
   * @param {import('#core/database').Database} opts.db
   * @param {import('#storage/oplog').OpLog} opts.log
   * @param {import('#client/transport').Transport} opts.transport
   * @param {string} opts.room
   * @param {string} [opts.schema] fingerprint sent for the compatibility check
   * @param {number} [opts.pollMs] fallback poll interval when push is unavailable
   * @param {number} [opts.debounceMs] coalesce a burst of local writes
   * @param {number} [opts.maxBackoffMs]
   * @param {object} [opts.batching] {@link AdaptiveBatcher} options
   * @param {() => Promise<void>} [opts.beforeSync] awaited before each round;
   *   the client uses it to flush local writes into the log first, so a sync
   *   can never read an outbox that a just-committed transaction has not
   *   reached yet
   * @param {{encode: Function, decode: Function}} [opts.codec] operation batch
   *   encoding. Swappable so the evaluation can measure a naive baseline
   *   through the identical protocol and transport rather than modelling it.
   * @param {object} [opts.timers] injectable setTimeout/clearTimeout/now, for tests
   */
  constructor({
    db, log, transport, room, schema,
    pollMs = 15_000, debounceMs = 120, maxBackoffMs = 30_000,
    batching, timers, beforeSync, codec,
  }) {
    super();
    this.#db = db;
    this.#log = log;
    this.#transport = transport;
    this.#room = room;
    this.#schema = schema;
    this.#batcher = new AdaptiveBatcher(batching);
    this.#codec = codec ?? { encode: encodeOps, decode: decodeOps };
    this.#beforeSync = beforeSync ?? (() => Promise.resolve());
    this.#opts = { pollMs, debounceMs, maxBackoffMs };
    this.#timers = timers ?? {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      now: () => Date.now(),
    };

    // Any local write marks the engine dirty; the sync itself is debounced so
    // a burst of keystrokes becomes one request rather than one per character.
    this.#onLocalOps = () => { this.#dirty = true; this.#schedule(this.#opts.debounceMs); };
  }

  #onLocalOps;

  get status() { return this.#status; }
  get online() { return this.#status === Status.LIVE || this.#status === Status.SYNCING; }
  get lastError() { return this.#lastError; }
  get batchSize() { return this.#batcher.size; }
  get room() { return this.#room; }

  #setStatus(next, detail) {
    if (this.#status === next) return;
    const previous = this.#status;
    this.#status = next;
    this.emit('status', { status: next, previous, ...detail });
  }

  /* -------------------------------------------------------------- lifecycle */

  /** Begin syncing. Returns once the first attempt has been made. */
  async start() {
    if (this.#running) return this;
    this.#running = true;
    this.#db.on('local-ops', this.#onLocalOps);
    this.#dirty = (await this.#log.outboxSize(this.#db.node)) > 0;

    await this.#connect();
    return this;
  }

  async stop() {
    this.#running = false;
    this.#db.off('local-ops', this.#onLocalOps);
    if (this.#timer !== null) { this.#timers.clearTimeout(this.#timer); this.#timer = null; }
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    await this.#inFlight?.catch(() => {});
    await this.#queued?.catch(() => {});
    await this.#transport.close?.();
    this.#setStatus(Status.OFFLINE, { reason: 'stopped' });
  }

  /** Handshake, then an immediate first sync. */
  async #connect() {
    this.#setStatus(Status.CONNECTING);
    try {
      const reply = await this.#transport.request(hello({
        node: this.#db.node,
        room: this.#room,
        schema: this.#schema,
        compression: ['deflate-raw'],
      }));
      validateMessage(reply);
      if (reply.t === MessageType.ERROR) throw new RivuletError(reply.code, reply.message, reply.details);
      if (reply.limits?.maxOpsPerPull) this.#batcher.setCeiling(reply.limits.maxOpsPerPull);

      await this.#openStream();
      this.#attempt = 0;
      await this.sync();
    } catch (err) {
      this.#handleFailure(err);
    }
  }

  /** Open the push stream if the transport has one. Failure is not fatal. */
  async #openStream() {
    if (!this.#transport.supportsPush || typeof this.#transport.subscribe !== 'function') return;
    try {
      this.#unsubscribe = await this.#transport.subscribe((msg) => {
        // The stream's opening frame only confirms the subscription; syncing
        // on it would duplicate the round `#connect` is about to run anyway.
        if (msg?.t === 'ready') return;
        // Anything else is a nudge. The body is not trusted to be complete --
        // the engine reacts by syncing through the normal path.
        this.#schedule(0);
      });
      this.#transport.on?.('stream-closed', () => {
        this.#unsubscribe = null;
        this.emit('stream-closed', {});
        this.#schedule(this.#opts.pollMs); // fall back to polling
      });
    } catch {
      // No stream: polling covers it. Not worth surfacing to the application.
      this.#unsubscribe = null;
    }
  }

  /* ------------------------------------------------------------ scheduling */

  /** Ask for a sync in `delay` ms, collapsing any already-pending request. */
  #schedule(delay) {
    if (!this.#running || this.#timer !== null) return;
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = null;
      this.sync().catch(() => {});
    }, Math.min(Math.max(0, delay), MAX_TIMER_DELAY));
    // A pending poll must not by itself keep a Node process alive: a CLI that
    // has finished its work should exit, not wait out the next interval.
    this.#timer?.unref?.();
  }

  /** After a completed round: poll if there is no stream, idle if there is. */
  #scheduleIdle() {
    if (!this.#running) return;
    if (this.#dirty) return this.#schedule(this.#opts.debounceMs);
    this.#schedule(this.#unsubscribe ? this.#opts.pollMs * 4 : this.#opts.pollMs);
  }

  #handleFailure(err) {
    this.#lastError = err;
    this.#batcher.fail();

    if (err instanceof AuthError) {
      // Credentials will not fix themselves; retrying is pointless noise.
      this.#setStatus(Status.UNAUTHORISED, { error: err.message });
      this.emit('error', err);
      return;
    }

    this.#setStatus(Status.OFFLINE, { error: err?.message });
    this.emit('error', err);

    const delay = backoffDelay(this.#attempt++, { maxMs: this.#opts.maxBackoffMs });
    this.emit('retry', { attempt: this.#attempt, delayMs: delay });
    this.#schedule(delay);
  }

  /* ----------------------------------------------------------------- sync */

  /**
   * Reconcile now: rounds repeat while the server reports more to send.
   *
   * A caller gets a round that begins *after* the call. Handing back a round
   * already in flight would be subtly wrong -- it started before the caller's
   * write existed, so it can report "nothing to do" for work it never saw, and
   * `await client.sync()` would not mean what it says.
   *
   * At most one follow-up is queued, so concurrent callers coalesce onto a
   * single extra round instead of stacking a request each.
   *
   * @returns {Promise<{pushed: number, pulled: number, rounds: number}>}
   */
  async sync() {
    if (!this.#inFlight) {
      this.#inFlight = this.#syncLoop().finally(() => { this.#inFlight = null; });
      return this.#inFlight;
    }
    this.#queued ??= this.#inFlight
      .catch(() => {})
      .then(() => { this.#queued = null; return this.sync(); });
    return this.#queued;
  }

  async #syncLoop() {
    if (!this.#running) return { pushed: 0, pulled: 0, rounds: 0 };
    this.#setStatus(Status.SYNCING);

    let pushed = 0, pulled = 0, rounds = 0;
    try {
      for (;;) {
        const round = await this.#syncRound();
        pushed += round.pushed;
        pulled += round.pulled;
        rounds++;
        if (!round.more) break;
        if (rounds > 10_000) break; // defensive: never spin forever
      }

      this.#attempt = 0;
      this.#lastError = null;
      this.#setStatus(Status.LIVE);
      this.emit('sync', { pushed, pulled, rounds, batchSize: this.#batcher.size });
      this.#scheduleIdle();
      return { pushed, pulled, rounds };
    } catch (err) {
      this.#handleFailure(err);
      return { pushed, pulled, rounds, error: err };
    }
  }

  /** A single request/response exchange. */
  async #syncRound() {
    // Local writes are queued into the log asynchronously; draining that queue
    // first is what makes "write then sync" mean what it says.
    await this.#beforeSync();

    const node = this.#db.node;
    const limit = this.#batcher.size;

    const outbox = await this.#log.outbox(node, { limit });
    const have = this.#log.frontier();

    const request = syncMessage({
      node, room: this.#room, have,
      push: outbox.length ? this.#codec.encode(outbox) : undefined,
      limit,
      schema: this.#schema,
    });

    const startedAt = this.#timers.now();
    const reply = await this.#transport.request(request);
    const elapsed = Math.max(1, this.#timers.now() - startedAt);

    validateMessage(reply);
    if (reply.t === MessageType.ERROR) throw new RivuletError(reply.code, reply.message, reply.details);

    /* ---- our push ---- */
    // Advance only as far as the server proves it holds. `you` is the server's
    // contiguous frontier for this replica, so a partial accept retries the rest.
    if (typeof reply.you === 'number' && reply.you > 0) await this.#log.markPushed(reply.you);
    if (reply.bad?.length) this.emit('rejected', { operations: reply.bad });

    /* ---- their push ---- */
    let applied = 0;
    if (reply.pull) {
      const incoming = this.#codec.decode(reply.pull);
      const { fresh } = await this.#log.append(incoming);
      // Only genuinely new operations reach the CRDTs; see the op log's contract.
      this.#db.applyAll(fresh);
      applied = fresh.length;
      if (fresh.length) {
        await this.#log.recordTimestamp(fresh.reduce((m, op) => (op.ts > m ? op.ts : m), fresh[0].ts));
        this.emit('applied', { count: fresh.length });
      }
    }

    await this.#log.setServerFrontier(readVector(reply));
    this.#batcher.record({ ops: outbox.length + applied, ms: elapsed });

    // Still dirty if the server did not take everything we had queued.
    this.#dirty = (await this.#log.outboxSize(node)) > 0;

    return {
      pushed: reply.ok ?? 0,
      pulled: applied,
      more: !!reply.more || (this.#dirty && outbox.length > 0 && (reply.ok ?? 0) > 0),
    };
  }

  /** Sync repeatedly until nothing is left to push or pull. Used by tests. */
  async syncUntilIdle({ maxRounds = 50 } = {}) {
    let total = { pushed: 0, pulled: 0, rounds: 0 };
    for (let i = 0; i < maxRounds; i++) {
      const r = await this.sync();
      total = {
        pushed: total.pushed + r.pushed, pulled: total.pulled + r.pulled,
        rounds: total.rounds + r.rounds,
      };
      if (r.error) return { ...total, error: r.error };
      if (r.pushed === 0 && r.pulled === 0) break;
    }
    return total;
  }

  /** Called by the host app when the device reports it is back online. */
  resume() {
    this.#attempt = 0;
    if (this.#timer !== null) { this.#timers.clearTimeout(this.#timer); this.#timer = null; }
    this.#schedule(0);
  }

  get stats() {
    return {
      status: this.#status,
      room: this.#room,
      dirty: this.#dirty,
      attempt: this.#attempt,
      batching: this.#batcher.estimate,
      bytes: this.#transport.meter?.summary,
      lastError: this.#lastError?.message ?? null,
    };
  }
}
