/**
 * @file The contract every CRDT in this engine implements.
 *
 * ## Delivery guarantees we rely on
 *
 * Operations reach a replica **at-least-once, in arbitrary order**. That is all
 * a lossy mobile link can promise, so every type here is **commutative** and
 * **associative** under {@link CRDT#apply}.
 *
 * Deduplication is deliberately *not* each type's job. The operation log
 * already tracks exactly which `(node, seq)` pairs a replica holds, in a
 * structure that compacts to O(1) per replica ({@link RangeSet}), and it drops
 * repeats before they reach a type. Pushing idempotence down into every CRDT
 * would mean a second, unbounded set of seen identifiers inside each one. Most
 * types here are idempotent anyway; the PN-counter is the one that is not, and
 * it is safe precisely because of this layering.
 *
 * ## Causal delivery
 *
 * Registers, counters and sets need no causal ordering: any permutation
 * converges. The sequence type ({@link RGA}) does need its insertion point to
 * exist, so it buffers operations whose parent has not arrived and replays them
 * later. Nothing above it has to care.
 *
 * ## Two merge paths
 *
 * `apply` folds in a single operation (the live sync path). `merge` folds in
 * another replica's whole state (the snapshot path, used for compaction and for
 * bootstrapping a fresh device without replaying all of history). Both must
 * reach the same value -- {@link assertConvergent} in the test suite checks it.
 *
 * @typedef {object} OpMeta
 * @property {string} ts   HLC timestamp of the operation
 * @property {string} node replica that issued it
 * @property {number} seq  that replica's per-operation sequence number
 *
 * @typedef {object} CRDT
 * @property {(payload: any, meta: OpMeta) => boolean} apply fold in one op; returns whether state changed
 * @property {(other: CRDT) => boolean} merge fold in another replica's state
 * @property {any} value materialised value for the application
 * @property {() => any} toJSON serialisable state (not just the value)
 */

import { ValidationError } from '#core/errors';

/** @type {Map<string, { type: string, create: (state?: any) => CRDT }>} */
const REGISTRY = new Map();

/**
 * Register a CRDT implementation under its wire tag.
 * @param {string} type short tag used in schemas and on the wire
 * @param {{ fromJSON: (state?: any) => CRDT }} impl
 */
export function registerType(type, impl) {
  if (REGISTRY.has(type)) throw new ValidationError('duplicate CRDT type', { type });
  REGISTRY.set(type, { type, create: (state) => impl.fromJSON(state) });
  return impl;
}

/** Instantiate a CRDT by wire tag, optionally rehydrating persisted state. */
export function createCRDT(type, state) {
  const entry = REGISTRY.get(type);
  if (!entry) throw new ValidationError('unknown CRDT type', { type, known: [...REGISTRY.keys()] });
  return entry.create(state);
}

/** @returns {string[]} */
export function knownTypes() { return [...REGISTRY.keys()]; }
