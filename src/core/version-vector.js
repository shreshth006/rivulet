/**
 * @file Version vectors: "how much of each replica's history do I hold?"
 *
 * A vector maps replica id -> contiguous sequence frontier. Sync is one round
 * trip: each side sends its vector, each side replies with only the operations
 * the other is missing. No full-state transfer, no per-record comparison, and
 * the request is a few dozen bytes -- which is what makes this workable on a
 * link with 400ms RTT and a metered data cap.
 *
 * Only the *contiguous* prefix goes in a vector (see {@link RangeSet}); holes
 * stay local so a peer never assumes we hold something we do not.
 */

import { assertNodeId } from '#core/ids';
import { ValidationError } from '#core/errors';

/** @typedef {'equal'|'lt'|'gt'|'concurrent'} VectorOrder */

export class VersionVector {
  /** @type {Map<string, number>} */
  #v = new Map();

  /** @param {Record<string, number>|Map<string,number>|VersionVector} [init] */
  constructor(init) {
    if (init instanceof VersionVector) { this.#v = new Map(init.#v); return; }
    if (init) for (const [node, seq] of init instanceof Map ? init : Object.entries(init)) {
      this.observe(node, seq);
    }
  }

  get size() { return this.#v.size; }
  nodes() { return [...this.#v.keys()]; }
  entries() { return [...this.#v.entries()]; }
  isEmpty() { return this.#v.size === 0; }

  /** Frontier for `node`; 0 when we have never heard from it. */
  get(node) { return this.#v.get(node) ?? 0; }

  /** Raise the frontier for `node` to `seq` (never lowers it). */
  observe(node, seq) {
    assertNodeId(node);
    if (!Number.isInteger(seq) || seq < 0) throw new ValidationError('invalid seq', { node, seq });
    if (seq > this.get(node)) this.#v.set(node, seq);
    return this;
  }

  /** Have we already seen operation `seq` from `node`? */
  has(node, seq) { return seq <= this.get(node); }

  /** Pointwise maximum, in place. */
  merge(other) {
    for (const [node, seq] of other.#v) this.observe(node, seq);
    return this;
  }

  /** True when this vector covers everything `other` covers. */
  dominates(other) {
    for (const [node, seq] of other.#v) if (this.get(node) < seq) return false;
    return true;
  }

  equals(other) {
    return this.#v.size === other.#v.size && this.dominates(other);
  }

  /**
   * Causal relationship between two vectors.
   * `concurrent` means both sides hold operations the other lacks -- the normal
   * state after any offline period, and the case CRDTs exist to resolve.
   * @returns {VectorOrder}
   */
  compare(other) {
    const le = other.dominates(this);
    const ge = this.dominates(other);
    if (le && ge) return 'equal';
    if (le) return 'lt';
    if (ge) return 'gt';
    return 'concurrent';
  }

  /**
   * What `this` holds that `other` does not, as {node: [fromSeqExclusive, toSeq]}.
   * This is the exact query a peer answers when responding to a pull.
   * @returns {Map<string, [number, number]>}
   */
  diff(other) {
    /** @type {Map<string, [number, number]>} */
    const out = new Map();
    for (const [node, seq] of this.#v) {
      const theirs = other.get(node);
      if (seq > theirs) out.set(node, [theirs, seq]);
    }
    return out;
  }

  clone() { return new VersionVector(this); }

  /** Plain object, sorted by node id so encodings are byte-stable. */
  toJSON() {
    /** @type {Record<string, number>} */
    const out = {};
    for (const node of [...this.#v.keys()].sort()) out[node] = this.#v.get(node);
    return out;
  }

  /** @param {Record<string,number>|undefined|null} obj */
  static fromJSON(obj) { return new VersionVector(obj ?? {}); }

  toString() {
    return `VV{${this.entries().map(([n, s]) => `${n.slice(0, 6)}:${s}`).join(' ')}}`;
  }
}
