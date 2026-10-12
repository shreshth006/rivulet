/**
 * @file The sync protocol's message types.
 *
 * ## One round trip
 *
 * The central constraint is latency, not throughput. On a link with 400ms RTT
 * a protocol that asks "what do you have?", waits, sends, waits, then pulls has
 * already spent over a second before any data moves. So `sync` carries the
 * client's frontier *and* its pending operations in a single request, and the
 * response carries the acknowledgement *and* everything the client is missing.
 * A complete reconciliation is one round trip, and a no-op sync costs one small
 * request rather than a handshake.
 *
 * ## Resumability
 *
 * A large pull is chunked: the server sets `more` and the client re-issues
 * `sync` with its advanced frontier. Because the frontier *is* the cursor,
 * a connection that drops mid-transfer resumes exactly where it stopped, with
 * no server-side session state to lose. This matters when the link fails
 * every few minutes -- without it, a big initial sync can never finish.
 *
 * ## Idempotence
 *
 * Every message is safe to retry. A pushed operation that the server already
 * holds is counted and ignored, so the client can resend freely after a
 * timeout without risking duplicates.
 *
 * ## Vector deltas
 *
 * A version vector has an entry per replica that ever wrote to the room, and
 * a naive sync sends the whole thing both ways on every request -- so the cost
 * of a sync that changes nothing grows with how widely a room is shared.
 *
 * Instead the server numbers the frontiers it reports (`hv`, an opaque id such
 * as `k3x9.41`). A client that remembers the last one sends it back as `bv`,
 * with `have` holding only the entries where its own frontier differs from
 * that base; the reply's `have` is likewise only what moved since the base,
 * marked by `hd`. A caught-up client exchanges two empty objects whatever the
 * replica count.
 *
 * The server keeps a bounded ring of recent frontiers per room, in memory. A
 * base it no longer holds -- after a restart, or a client that slept through
 * many writes -- is answered with the full frontier, a fresh `hv` and `more`,
 * so the client's next round is compact again. That costs one extra round
 * trip, never correctness. Either side omitting the fields gets the plain
 * full-vector protocol, so old clients and old servers interoperate.
 */

import { ProtocolError, ValidationError } from '#core/errors';
import { isNodeId } from '#core/ids';
import { VersionVector } from '#core/version-vector';
import { CODEC_VERSION } from '#protocol/codec';

/** Bumped only for changes that are not backwards compatible. */
export const PROTOCOL_VERSION = 1;

export const MessageType = Object.freeze({
  HELLO: 'hello',
  WELCOME: 'welcome',
  SYNC: 'sync',
  ACK: 'ack',
  EVENT: 'event',
  ERROR: 'error',
});

/** Server-advertised ceilings, so a client never sends something oversized. */
export const DEFAULT_LIMITS = Object.freeze({
  maxOpsPerPush: 2_000,
  maxOpsPerPull: 1_000,
  maxBodyBytes: 4 * 1024 * 1024,
});

/* ------------------------------------------------------------------ builders */

/** Client's opening message: who it is and what it can speak. */
export function hello({ node, room, schema, compression = [], resume }) {
  return {
    t: MessageType.HELLO,
    pv: PROTOCOL_VERSION,
    cv: CODEC_VERSION,
    node, room, schema,
    comp: compression,
    ...(resume ? { resume } : {}),
  };
}

/** Server's reply: its own identity, the negotiated encoding, and the limits. */
export function welcome({ node, room, limits = DEFAULT_LIMITS, compression = null, have, serverTs }) {
  return {
    t: MessageType.WELCOME,
    pv: PROTOCOL_VERSION,
    cv: CODEC_VERSION,
    node, room, limits,
    comp: compression,
    have: have?.toJSON?.() ?? have ?? {},
    ts: serverTs,
  };
}

/**
 * Push and pull in one message.
 * @param {object} args
 * @param {string} args.node client replica id
 * @param {string} args.room
 * @param {VersionVector|object} args.have client frontier -- also the pull cursor
 * @param {object} [args.push] encoded operation batch
 * @param {number} [args.limit] maximum operations to receive in the reply
 */
export function sync({ node, room, have, base, push, limit, schema }) {
  return {
    t: MessageType.SYNC,
    pv: PROTOCOL_VERSION,
    node, room,
    // With a base, `have` is the delta against it -- see "Vector deltas".
    ...(base ? { bv: base.version, have: vectorDelta(have, base.vector) } : { have: have?.toJSON?.() ?? have ?? {} }),
    ...(push ? { push } : {}),
    ...(limit ? { limit } : {}),
    ...(schema ? { schema } : {}),
  };
}

/**
 * @param {object} args
 * @param {number} args.accepted operations newly stored from the push
 * @param {number} args.duplicates operations the server already held
 * @param {Array<{op: string, reason: string}>} [args.rejected]
 * @param {object} [args.pull] encoded batch for the client
 * @param {number} [args.you] the client's own durably-accepted sequence frontier
 * @param {boolean} [args.more] true when another round is needed to finish
 * @param {string} [args.version] id of the frontier in `have`, for the client's next `bv`
 * @param {{ version: string, vector: VersionVector }} [args.base] the client's
 *   base, when the server still holds it: `have` is then sent as a delta
 */
export function ack({
  node, accepted = 0, duplicates = 0, rejected = [], pull, have, more = false, you = 0, serverTs,
  version, base,
}) {
  return {
    t: MessageType.ACK,
    pv: PROTOCOL_VERSION,
    node,
    ok: accepted,
    dup: duplicates,
    ...(rejected.length ? { bad: rejected } : {}),
    ...(pull ? { pull } : {}),
    ...(base ? { hd: base.version, have: vectorDelta(have, base.vector) } : { have: have?.toJSON?.() ?? have ?? {} }),
    ...(version ? { hv: version } : {}),
    // How far the client's own history is durably stored. The client advances
    // its outbox watermark to exactly this, so a partially accepted push
    // retries only the part that did not land.
    you,
    more,
    ts: serverTs,
  };
}

/** Unsolicited server push over the event stream. */
export function event({ node, pull, have, serverTs }) {
  return {
    t: MessageType.EVENT,
    pv: PROTOCOL_VERSION,
    node,
    pull,
    have: have?.toJSON?.() ?? have ?? {},
    ts: serverTs,
  };
}

/** @param {string} code @param {string} message */
export function errorMessage(code, message, details = {}) {
  return { t: MessageType.ERROR, pv: PROTOCOL_VERSION, code, message, details };
}

/* ---------------------------------------------------------------- validation */

function requireString(msg, key, what) {
  if (typeof msg[key] !== 'string' || msg[key].length === 0) {
    throw new ProtocolError(`${what} is missing a ${key}`, { got: msg[key] });
  }
  return msg[key];
}

/**
 * Validate an inbound message. The server runs this before touching anything
 * else: a malformed frame must be rejected at the edge with a clear code, not
 * discovered three layers down as a type error.
 * @param {any} msg
 * @param {string} [expected] required message type
 */
export function validateMessage(msg, expected) {
  if (!msg || typeof msg !== 'object') throw new ProtocolError('message must be an object', { msg });
  if (typeof msg.t !== 'string') throw new ProtocolError('message is missing its type', { msg });
  if (expected && msg.t !== expected) {
    throw new ProtocolError('unexpected message type', { got: msg.t, expected });
  }
  if (msg.pv !== undefined && msg.pv !== PROTOCOL_VERSION) {
    throw new ProtocolError('unsupported protocol version', {
      got: msg.pv, expected: PROTOCOL_VERSION,
    });
  }

  switch (msg.t) {
    case MessageType.HELLO:
    case MessageType.SYNC: {
      const node = requireString(msg, 'node', msg.t);
      if (!isNodeId(node)) throw new ProtocolError('malformed node id', { node });
      requireString(msg, 'room', msg.t);
      if (msg.have !== undefined && (typeof msg.have !== 'object' || msg.have === null)) {
        throw new ProtocolError('have must be a version vector object', { have: msg.have });
      }
      if (msg.bv !== undefined && (typeof msg.bv !== 'string' || msg.bv.length === 0 || msg.bv.length > 64)) {
        throw new ProtocolError('bv must be a frontier version id', { bv: msg.bv });
      }
      if (msg.limit !== undefined && (!Number.isInteger(msg.limit) || msg.limit < 1)) {
        throw new ProtocolError('limit must be a positive integer', { limit: msg.limit });
      }
      break;
    }
    case MessageType.ACK:
    case MessageType.WELCOME:
    case MessageType.EVENT:
    case MessageType.ERROR:
      break;
    default:
      throw new ProtocolError('unknown message type', { type: msg.t });
  }
  return msg;
}

/**
 * Safely parse and validate a JSON string as a protocol message.
 * @param {string} jsonString
 * @param {string} [expectedType]
 * @returns {{ ok: boolean, value: object|null, error: Error|null }}
 */
export function safeParseMessage(jsonString, expectedType) {
  try {
    const raw = typeof jsonString === 'string' ? JSON.parse(jsonString) : jsonString;
    const msg = validateMessage(raw, expectedType);
    return { ok: true, value: msg, error: null };
  } catch (err) {
    return { ok: false, value: null, error: err };
  }
}


/** Read the `have` field of a message back into a {@link VersionVector}. */
export function readVector(msg) {
  try {
    return VersionVector.fromJSON(msg?.have ?? {});
  } catch (err) {
    throw new ProtocolError('malformed version vector', { cause: String(err) });
  }
}

/**
 * The entries of `full` that differ from `base`. A replica in `base` that
 * `full` lacks is sent as 0, so the receiver drops it rather than inheriting it.
 * @param {VersionVector|Record<string, number>} full
 * @param {VersionVector} base
 * @returns {Record<string, number>}
 */
export function vectorDelta(full, base) {
  const vv = full instanceof VersionVector ? full : VersionVector.fromJSON(full);
  /** @type {Record<string, number>} */
  const out = {};
  for (const [node, seq] of vv.entries()) if (base.get(node) !== seq) out[node] = seq;
  for (const node of base.nodes()) if (vv.get(node) === 0) out[node] = 0;
  return Object.fromEntries(Object.entries(out).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

/** Rebuild a full vector from a base and a {@link vectorDelta}. */
export function applyVectorDelta(base, delta) {
  if (!delta || typeof delta !== 'object') throw new ProtocolError('malformed vector delta', { delta });
  const out = base.toJSON();
  for (const [node, seq] of Object.entries(delta)) {
    if (!Number.isInteger(seq) || seq < 0) throw new ProtocolError('malformed vector delta', { node, seq });
    if (seq === 0) delete out[node];
    else out[node] = seq;
  }
  try {
    return VersionVector.fromJSON(out);
  } catch (err) {
    throw new ProtocolError('malformed version vector', { cause: String(err) });
  }
}

/**
 * Check that two replicas agree on the schema. Caught here, a mismatch is a
 * clear error at connect time; missed, it surfaces later as operations that
 * silently do nothing because a field no longer exists.
 */
export function assertSchemaMatch(local, remote) {
  if (remote && local !== remote) {
    throw new ValidationError('schema mismatch between client and server', { local, remote });
  }
}

/* ------------------------------------------------------------- type guards */

export const isHelloMessage = (msg) => typeof msg === 'object' && msg !== null && msg.t === MessageType.HELLO;
export const isWelcomeMessage = (msg) => typeof msg === 'object' && msg !== null && msg.t === MessageType.WELCOME;
export const isSyncMessage = (msg) => typeof msg === 'object' && msg !== null && msg.t === MessageType.SYNC;
export const isAckMessage = (msg) => typeof msg === 'object' && msg !== null && msg.t === MessageType.ACK;
export const isEventMessage = (msg) => typeof msg === 'object' && msg !== null && msg.t === MessageType.EVENT;
export const isErrorMessage = (msg) => typeof msg === 'object' && msg !== null && msg.t === MessageType.ERROR;

