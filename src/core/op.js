/**
 * @file The operation envelope -- the unit of everything that crosses the wire.
 *
 * An operation is immutable, self-contained, and addressed by identity rather
 * than position: it names the replica that issued it, that replica's sequence
 * number, an HLC timestamp, and the exact field it touches. Nothing in it
 * depends on the receiver's current state, which is what lets it be stored,
 * replayed, batched, resent after a three-day outage, and applied in any order.
 *
 * `(node, seq)` is the primary key. Sequence numbers are dense and start at 1,
 * so a peer can name a missing range compactly ({@link RangeSet}) and the whole
 * sync protocol reduces to exchanging integer frontiers.
 */

import { ValidationError } from '#core/errors';
import { isNodeId } from '#core/ids';
import { TIMESTAMP_LEN } from '#core/hlc';

/**
 * @typedef {object} Op
 * @property {string} node       issuing replica
 * @property {number} seq        that replica's sequence number, from 1, dense
 * @property {string} ts         HLC timestamp
 * @property {string} collection
 * @property {string} doc        document id
 * @property {string} field
 * @property {any} payload       CRDT-specific; shape is owned by the field's type
 */

/** Stable primary key for an operation. */
export function opKey(op) { return `${op.node}:${op.seq}`; }

/** @returns {Op} a frozen, validated operation */
export function makeOp({ node, seq, ts, collection, doc, field, payload }) {
  const op = Object.freeze({ node, seq, ts, collection, doc, field, payload });
  return validateOp(op);
}

/**
 * Validate an operation from an untrusted source. The server runs this on
 * every inbound operation: a malformed one must be rejected at the edge, never
 * written to a log that replicas will replay forever.
 * @param {Op} op @returns {Op}
 */
export function validateOp(op) {
  if (!op || typeof op !== 'object') throw new ValidationError('operation must be an object', { op });
  if (!isNodeId(op.node)) throw new ValidationError('operation has a malformed node id', { node: op.node });
  if (!Number.isInteger(op.seq) || op.seq < 1) {
    throw new ValidationError('operation seq must be a positive integer', { seq: op.seq });
  }
  if (typeof op.ts !== 'string' || op.ts.length !== TIMESTAMP_LEN) {
    throw new ValidationError('operation has a malformed timestamp', { ts: op.ts });
  }
  for (const key of ['collection', 'doc', 'field']) {
    if (typeof op[key] !== 'string' || op[key].length === 0) {
      throw new ValidationError(`operation ${key} must be a non-empty string`, { [key]: op[key] });
    }
  }
  if (op.payload === undefined || op.payload === null || typeof op.payload !== 'object') {
    throw new ValidationError('operation payload must be an object', { payload: op.payload });
  }
  return op;
}

/** Metadata slice the CRDT layer consumes. */
export function opMeta(op) { return { ts: op.ts, node: op.node, seq: op.seq }; }

/**
 * Issues densely numbered operations for one replica, pairing the HLC with the
 * sequence counter so the two never drift apart.
 */
export class OpFactory {
  #clock;
  #seq;

  /** @param {import('#core/hlc').HybridClock} clock @param {number} [startSeq] resume point */
  constructor(clock, startSeq = 0) {
    this.#clock = clock;
    this.#seq = startSeq;
  }

  get node() { return this.#clock.node; }
  get seq() { return this.#seq; }
  get clock() { return this.#clock; }

  /** @returns {Op} */
  create({ collection, doc, field, payload }) {
    return makeOp({
      node: this.#clock.node,
      seq: ++this.#seq,
      ts: this.#clock.now(),
      collection, doc, field, payload,
    });
  }
}

/** Sort operations into a deterministic, causally consistent order. */
export function sortOps(ops) {
  return [...ops].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}
