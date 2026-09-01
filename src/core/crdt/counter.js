/**
 * @file PN-counter -- a number that survives concurrent increments.
 *
 * Writing a count through a register is a classic offline bug: two devices
 * each read 5, each add 1, and the merged result is 6 instead of 7. This type
 * stores per-replica running totals instead of a single number, so increments
 * from different replicas add up rather than overwrite.
 *
 * Positive and negative contributions are tracked separately (the "PN" part).
 * Keeping them apart means each half only ever grows, so merging is a pointwise
 * maximum -- which is what makes the snapshot path safe to apply repeatedly.
 *
 * This is the one type that is not idempotent under {@link apply}: replaying an
 * operation would double-count it. The operation log guarantees exactly-once
 * delivery to `apply`, which is why that is sound; see `contract.js`.
 */

import { registerType } from '#core/crdt/contract';

export class PNCounter {
  static type = 'counter';

  /** @type {Map<string, number>} replica -> total added */
  #p = new Map();
  /** @type {Map<string, number>} replica -> total subtracted */
  #n = new Map();

  constructor(state) {
    if (state) {
      for (const [node, v] of state.p ?? []) this.#p.set(node, v);
      for (const [node, v] of state.n ?? []) this.#n.set(node, v);
    }
  }

  get value() {
    let total = 0;
    for (const v of this.#p.values()) total += v;
    for (const v of this.#n.values()) total -= v;
    return total;
  }

  /** Per-replica breakdown -- useful for debugging a diverged counter. */
  get contributions() {
    const nodes = new Set([...this.#p.keys(), ...this.#n.keys()]);
    return [...nodes].sort().map((node) => ({
      node, added: this.#p.get(node) ?? 0, subtracted: this.#n.get(node) ?? 0,
    }));
  }

  /** @param {number} delta may be negative */
  static op(delta) { return { d: delta }; }

  apply(payload, meta) {
    const delta = Number(payload.d) || 0;
    if (delta === 0) return false;
    const side = delta > 0 ? this.#p : this.#n;
    side.set(meta.node, (side.get(meta.node) ?? 0) + Math.abs(delta));
    return true;
  }

  merge(other) {
    let changed = false;
    for (const [side, mine] of [[other.#p, this.#p], [other.#n, this.#n]]) {
      for (const [node, v] of side) {
        if (v > (mine.get(node) ?? 0)) { mine.set(node, v); changed = true; }
      }
    }
    return changed;
  }

  toJSON() {
    const sort = (m) => [...m.entries()].filter(([, v]) => v !== 0).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return { p: sort(this.#p), n: sort(this.#n) };
  }

  static fromJSON(state) { return new PNCounter(state); }
}

registerType(PNCounter.type, PNCounter);
