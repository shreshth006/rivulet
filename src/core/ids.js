/**
 * @file Replica identity.
 *
 * A `NodeId` names one replica -- concretely, one app install on one device.
 * It is minted once, persisted locally, and never reused. Everything causal in
 * the system (HLC tiebreaks, version vectors, CRDT tags) keys off it, so the
 * only hard requirement is global uniqueness.
 */

import { randomHex } from '#core/util';
import { ValidationError } from '#core/errors';

/** Width in hex chars. 64 bits: ~1e-7 collision odds at 10^6 replicas. */
export const NODE_ID_LEN = 16;

const NODE_ID_RE = /^[0-9a-f]{16}$/;

/** @returns {string} a fresh random replica id. */
export function newNodeId() {
  return randomHex(NODE_ID_LEN / 2);
}

/** @param {unknown} id @returns {id is string} */
export function isNodeId(id) {
  return typeof id === 'string' && NODE_ID_RE.test(id);
}

/** Throws unless `id` is a well-formed replica id. */
export function assertNodeId(id) {
  if (!isNodeId(id)) throw new ValidationError('malformed node id', { id });
  return id;
}

/**
 * Derive a stable replica id from an arbitrary string. Used by tests and
 * benchmarks so that a scenario replays byte-identically; never in production
 * paths, where ids must be random.
 */
export function nodeIdFromLabel(label) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < label.length; i++) {
    h1 = Math.imul(h1 ^ label.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + label.charCodeAt(i) + i, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, NODE_ID_LEN);
}

/** Short, human-readable form for logs and debug UIs. */
export function shortId(id) {
  return typeof id === 'string' ? id.slice(0, 6) : String(id);
}

/** Opaque document id; collision-resistant and URL-safe. */
export function newDocId() {
  return randomHex(12);
}
