/**
 * @file The sync server, independent of any transport.
 *
 * The server is deliberately not authoritative about *content*. It never
 * merges, never resolves a conflict, and never rejects an operation for
 * disagreeing with another -- the CRDTs make that unnecessary, and a server
 * that adjudicated would reintroduce exactly the coordination point this
 * design exists to remove.
 *
 * What it is authoritative about is *durability and fan-out*: it holds the
 * union of every replica's operations, answers "what am I missing?" cheaply,
 * and pushes new operations to whoever is listening. It is, in effect, a
 * replica that never writes.
 *
 * That has a useful consequence: the server is not a single point of
 * correctness. If it loses its disk, every client still holds its own
 * operations and the union reassembles on the next sync. Losing the server
 * costs availability, not data.
 *
 * Transport lives in `http.js`; this file is what both the HTTP server and the
 * in-process test harness drive.
 */

import { Emitter } from '#core/util';
import { OpLog } from '#storage/oplog';
import { VersionVector } from '#core/version-vector';
import { decodeOps, encodeOps } from '#protocol/codec';
import {
  MessageType, DEFAULT_LIMITS, ack, welcome, errorMessage,
  validateMessage, readVector, assertSchemaMatch, applyVectorDelta,
} from '#protocol/messages';
import { newNodeId } from '#core/ids';
import { RateLimiter } from '#server/rate-limit';
import { AuthError, ProtocolError, ValidationError, RivuletError, LimitError } from '#core/errors';

/** How many recent frontiers a room remembers as delta bases. */
const FRONTIER_RING = 256;

/**
 * The numbered frontiers a room has reported, so a client can name one as the
 * base for a vector delta instead of resending the whole vector. See "Vector
 * deltas" in `#protocol/messages`.
 *
 * In memory only, and bounded: forgetting a base costs a client one extra
 * round trip, so there is nothing here worth persisting. The epoch is fresh
 * per process, so an id from before a restart can never match a different
 * frontier that happens to reuse its number.
 */
class FrontierVersions {
  #epoch = newNodeId();
  #next = 0;
  /** @type {Map<string, VersionVector>} insertion order is age */
  #ring = new Map();
  #latest = null;
  #latestKey = null;

  /** The id for `frontier`, minting a new one only when it has moved. */
  versionOf(frontier) {
    const key = JSON.stringify(frontier.toJSON());
    if (key === this.#latestKey) return this.#latest;
    const id = `${this.#epoch}.${(this.#next++).toString(36)}`;
    this.#ring.set(id, frontier.clone());
    if (this.#ring.size > FRONTIER_RING) this.#ring.delete(this.#ring.keys().next().value);
    this.#latest = id;
    this.#latestKey = key;
    return id;
  }

  /** @returns {VersionVector|undefined} */
  get(id) { return this.#ring.get(id); }
}

/** A room is one synchronisation domain: one shared operation log. */
class Room extends Emitter {
  /** @param {string} name @param {OpLog} log */
  constructor(name, log) {
    super();
    this.name = name;
    this.log = log;
    /** @type {Set<(ops: object[], from: string) => void>} live listeners */
    this.listeners = new Set();
    this.lastActivity = Date.now();
    this.versions = new FrontierVersions();
  }

  /**
   * Hand new operations to every connected client except the one that sent
   * them. Excluding the sender is not just an optimisation: a client that
   * received its own operations back would re-append them, and on a slow link
   * that echo competes with real traffic for the same scarce bandwidth.
   */
  broadcast(ops, from) {
    if (ops.length === 0) return 0;
    let delivered = 0;
    for (const listener of [...this.listeners]) {
      try {
        if (listener.node !== from) { listener(ops, from); delivered++; }
      } catch {
        // A wedged listener must not take down a sync request.
        this.listeners.delete(listener);
      }
    }
    return delivered;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get connections() { return this.listeners.size; }
}

export class SyncServer extends Emitter {
  #rooms = new Map();
  #openRoom;
  #node = null;
  #limits;
  #authorize;
  #schema;
  #codec;
  #maxRooms;
  #perReplica = null;
  #perIp = null;

  /**
   * @param {object} opts
   * @param {(room: string) => Promise<object>} opts.storage adapter factory, one per room
   * @param {string} [opts.schema] schema fingerprint clients must match
   * @param {(ctx: object) => (boolean|Promise<boolean>)} [opts.authorize]
   *   called before every room access with `{ action, room, node, writes,
   *   credential, ip }`; `action` is 'hello', 'sync', 'subscribe' or
   *   'inspect'. Return false or throw an AuthError to refuse. See
   *   `roomTokens` in `#server/tokens` for a ready-made one.
   * @param {object} [opts.limits]
   * @param {string} [opts.node] fixed server id (tests); otherwise minted
   * @param {{encode: Function, decode: Function}} [opts.codec] operation batch
   *   encoding; must match what clients use
   * @param {number} [opts.maxRooms] maximum number of concurrently open rooms
   * @param {object} [opts.rateLimit] token buckets, off by default here and on
   *   in `startServer`: `{ perSecond, burst }` per replica per room, plus an
   *   optional looser `perIp: { perSecond, burst }`. See `#server/rate-limit`.
   */
  constructor({ storage, schema, authorize, limits, node, codec, maxRooms = Infinity, rateLimit } = {}) {
    super();
    if (typeof storage !== 'function') {
      throw new ValidationError('SyncServer needs a storage factory');
    }
    this.#openRoom = storage;
    this.#schema = schema;
    this.#authorize = authorize ?? (() => true);
    this.#limits = { ...DEFAULT_LIMITS, ...limits };
    this.#maxRooms = limits?.maxRooms ?? maxRooms;
    this.#node = node ?? null;
    this.#codec = codec ?? { encode: encodeOps, decode: decodeOps };
    if (rateLimit) {
      this.#perReplica = new RateLimiter(rateLimit);
      if (rateLimit.perIp) this.#perIp = new RateLimiter(rateLimit.perIp);
    }
  }

  get node() { return (this.#node ??= newNodeId()); }
  get limits() { return { ...this.#limits, maxRooms: this.#maxRooms }; }
  get roomNames() { return [...this.#rooms.keys()]; }
  get roomCount() { return this.#rooms.size; }

  hasRoom(name) { return this.#rooms.has(name); }

  /** Return operational statistics for a specific room. */
  async roomStats(name) {
    const r = await this.room(name);
    return {
      name: r.name,
      connections: r.connections,
      lastActivity: r.lastActivity,
      operations: await r.log.count(),
      replicas: r.log.frontier().size,
      bytes: await r.log.sizeBytes(),
      canCompact: r.log.canCompact,
    };
  }

  /** Close and evict a single room. */
  async closeRoom(name) {
    const entry = this.#rooms.get(name);
    if (!entry) return false;
    const room = entry instanceof Promise ? await entry : entry;
    room.listeners.clear();
    await room.log.close();
    this.#rooms.delete(name);
    this.emit('room-close', { room: name });
    return true;
  }

  /** Open a room's log on first use. Concurrent callers share one open. */
  async room(name) {
    let entry = this.#rooms.get(name);
    if (entry) return entry instanceof Promise ? entry : entry;
    if (this.#rooms.size >= this.#maxRooms) {
      throw new LimitError('maximum room limit reached', { maxRooms: this.#maxRooms });
    }

    const opening = (async () => {
      const log = await new OpLog(await this.#openRoom(name)).open();
      const room = new Room(name, log);
      this.#rooms.set(name, room);
      this.emit('room-open', { room: name });
      return room;
    })();
    this.#rooms.set(name, opening);
    return opening;
  }

  /**
   * Spend a request from the caller's budgets, before any other work -- and
   * before authorisation, so a client guessing credentials is throttled too.
   */
  #throttle(ctx, room, node) {
    const checks = [];
    if (this.#perIp && ctx.ip) checks.push(() => this.#perIp.take(ctx.ip));
    if (this.#perReplica && node) checks.push(() => this.#perReplica.take(`${room}\u0000${node}`));
    for (const check of checks) {
      const result = check();
      if (!result.ok) throw new LimitError('too many requests', { retryAfterMs: result.retryAfterMs });
    }
  }

  /** Throw unless the configured hook allows this access. */
  async authorize(ctx) {
    if (!(await this.#authorize(ctx))) {
      throw new AuthError('not authorised for this room', { room: ctx.room });
    }
  }

  /* ----------------------------------------------------------- handlers */

  /** Capability negotiation and an early schema check. */
  async handleHello(msg, ctx = {}) {
    validateMessage(msg, MessageType.HELLO);
    this.#throttle(ctx, msg.room, msg.node);
    await this.authorize({ ...ctx, action: 'hello', room: msg.room, node: msg.node, writes: false });
    assertSchemaMatch(this.#schema ?? msg.schema, msg.schema);

    const room = await this.room(msg.room);
    return welcome({
      node: this.node,
      room: msg.room,
      limits: this.#limits,
      compression: msg.comp?.includes('deflate-raw') ? 'deflate-raw' : null,
      have: room.log.frontier(),
      serverTs: Date.now(),
    });
  }

  /**
   * The whole protocol in one handler: accept the client's operations, then
   * answer with everything it is missing.
   *
   * Order matters. Applying the push *before* computing the pull means a
   * client that just wrote something does not receive its own operations back,
   * and two clients syncing in the same instant each see the other's work on
   * the first round rather than the second.
   */
  async handleSync(msg, ctx = {}) {
    validateMessage(msg, MessageType.SYNC);
    this.#throttle(ctx, msg.room, msg.node);
    // A request carrying operations is a write; one that only pulls is a read,
    // so a read-only credential can still follow a room.
    const writes = Boolean(msg.push && (msg.push.n ?? 1) > 0);
    await this.authorize({ ...ctx, action: 'sync', room: msg.room, node: msg.node, writes });
    assertSchemaMatch(this.#schema ?? msg.schema, msg.schema);

    const room = await this.room(msg.room);
    room.lastActivity = Date.now();

    /* ---- push ---- */
    let accepted = 0, duplicates = 0;
    /** @type {Array<{op: string, reason: string}>} */
    const rejected = [];
    let fresh = [];

    if (msg.push) {
      const incoming = this.#decodePush(msg.push, rejected);
      // Only operations the sender actually issued. Accepting operations
      // attributed to another replica would let one client forge another's
      // history -- and forged sequence numbers would block the real ones.
      const own = [];
      for (const op of incoming) {
        if (op.node !== msg.node) rejected.push({ op: `${op.node}:${op.seq}`, reason: 'foreign-replica' });
        else own.push(op);
      }

      if (own.length > this.#limits.maxOpsPerPush) {
        throw new ProtocolError('push exceeds the server limit', {
          got: own.length, limit: this.#limits.maxOpsPerPush,
        });
      }

      const result = await room.log.append(own);
      accepted = result.added;
      duplicates = result.duplicates;
      fresh = result.fresh;

      if (fresh.length) {
        room.broadcast(fresh, msg.node);
        this.emit('ops', { room: msg.room, from: msg.node, count: fresh.length });
      }
    }

    /* ---- pull ---- */
    const frontier = room.log.frontier();
    const version = room.versions.versionOf(frontier);
    const baseVector = msg.bv === undefined ? undefined : room.versions.get(msg.bv);

    let outgoing = [], more = false;
    if (msg.bv !== undefined && !baseVector) {
      // A base we no longer hold: we cannot know what the client has, so send
      // the full frontier and a fresh id, and let it ask again. Its push above
      // has already been taken; only the pull waits a round.
      more = true;
    } else {
      const clientHas = baseVector ? applyVectorDelta(baseVector, msg.have ?? {}) : readVector(msg);
      const limit = Math.min(msg.limit ?? this.#limits.maxOpsPerPull, this.#limits.maxOpsPerPull);
      ({ ops: outgoing, more } = await room.log.delta(clientHas, { limit }));
      outgoing = await this.#completeSealedRuns(room, outgoing);
    }

    return ack({
      node: this.node,
      accepted, duplicates, rejected,
      pull: outgoing.length ? this.#codec.encode(outgoing) : undefined,
      have: frontier,
      version,
      base: baseVector ? { version: msg.bv, vector: baseVector } : undefined,
      // How far the client's own history has been durably accepted. The client
      // advances its outbox watermark to exactly this and no further.
      you: frontier.get(msg.node),
      more,
      serverTs: Date.now(),
    });
  }

  /**
   * An end-to-end encrypted replica seals its operations in runs whose
   * ciphertext rides on the run's last operation; the others carry only
   * `{ $r: <last seq> }` (see `#protocol/seal`). A page that stops part-way
   * through a run would leave its reader holding pointers to nothing, so the
   * run's last operation is added to the page. This reads one structural key
   * and nothing else: the server still cannot see, and does not need, content.
   */
  async #completeSealedRuns(room, ops) {
    const last = new Map();
    for (const op of ops) {
      if (!last.has(op.node) || op.seq > last.get(op.node).seq) last.set(op.node, op);
    }
    const extra = [];
    for (const op of last.values()) {
      const tail = op.payload?.$r;
      if (!Number.isInteger(tail) || tail <= op.seq) continue;
      const [found] = await room.log.read({ node: op.node, fromSeq: tail - 1, toSeq: tail, limit: 1 });
      if (found) extra.push(found);
    }
    return extra.length ? [...ops, ...extra] : ops;
  }

  /**
   * Decode a push, keeping malformed operations from poisoning the batch.
   * A bad operation is reported and dropped; it must never reach the log,
   * because every replica would replay it forever.
   */
  #decodePush(push, rejected) {
    try {
      return this.#codec.decode(push);
    } catch (err) {
      if (err instanceof RivuletError) {
        rejected.push({ op: '*', reason: err.code });
        throw new ProtocolError('push batch could not be decoded', { cause: err.message });
      }
      throw err;
    }
  }

  /**
   * Register a live listener for a room, and report what it already missed.
   * Returning the current frontier lets a client that just connected decide
   * whether it needs a catch-up sync before trusting the stream.
   */
  async subscribe(roomName, listener, { node, ...ctx } = {}) {
    this.#throttle(ctx, roomName, node);
    await this.authorize({ ...ctx, action: 'subscribe', room: roomName, node, writes: false });
    const room = await this.room(roomName);
    if (node) listener.node = node;
    const off = room.subscribe(listener);
    this.emit('subscribe', { room: roomName, node, connections: room.connections });
    return { off, have: room.log.frontier() };
  }

  /** Turn any error into a protocol-level error message. */
  static toErrorMessage(err) {
    if (err instanceof RivuletError) return errorMessage(err.code, err.message, err.details);
    return errorMessage('E_INTERNAL', 'internal server error');
  }

  /** HTTP status for an error, so the transport layer has no error taxonomy. */
  static statusFor(err) {
    switch (err?.code) {
      case 'E_AUTH': return 403;
      case 'E_LIMIT': return 429;
      case 'E_VALIDATION': return 400;
      case 'E_PROTOCOL': return 400;
      case 'E_STORAGE': return 503;
      default: return 500;
    }
  }

  async stats() {
    const rooms = [];
    for (const [name, entry] of this.#rooms) {
      if (entry instanceof Promise) continue;
      rooms.push({
        name,
        operations: await entry.log.count(),
        replicas: entry.log.frontier().size,
        connections: entry.connections,
        bytes: await entry.log.sizeBytes(),
        lastActivity: entry.lastActivity,
      });
    }
    return { node: this.node, rooms, limits: this.#limits };
  }

  /**
   * Snapshot a room and drop the operations it covers.
   *
   * Only safe up to a frontier every client has: anything newer may still be
   * the answer to a pull from a replica that has been offline. `minFrontier`
   * is that bound, and must come from tracking connected clients, not guessed.
   */
  async compactRoom(name, materialise, minFrontier) {
    const room = await this.room(name);
    const ops = await room.log.read();
    const state = materialise(ops);
    return room.log.compact(state, minFrontier instanceof VersionVector ? minFrontier.toJSON() : minFrontier);
  }

  async close() {
    for (const entry of this.#rooms.values()) {
      const room = entry instanceof Promise ? await entry : entry;
      room.listeners.clear();
      await room.log.close();
    }
    this.#rooms.clear();
  }
}
