/**
 * @file Multi-value register -- keeps concurrent writes instead of dropping them.
 *
 * Where {@link LWWRegister} silently picks a winner, this keeps every value
 * written concurrently and hands the whole set to the application. That is what
 * you want for a field where losing an edit is worse than asking the user:
 * a shared note body, a price, an address someone corrected offline.
 *
 * Mechanics: a write names the sibling timestamps it observed and therefore
 * replaces. A value survives until some write that saw it supersedes it, so
 * writes that never saw each other -- the definition of concurrent -- all stay.
 * When one replica's write causally follows another's, the set collapses back
 * to a single value on its own.
 *
 * Superseded timestamps are remembered so that a late-arriving write cannot
 * resurrect a value that was already replaced; {@link MVRegister#gc} drops that
 * bookkeeping once the sync layer proves nothing older can still arrive.
 */

import { registerType } from '#core/crdt/contract';
import { compareTimestamps } from '#core/hlc';

export class MVRegister {
  static type = 'mv';

  /** @type {Map<string, any>} live siblings, keyed by the timestamp that wrote them */
  #entries = new Map();
  /** @type {Set<string>} timestamps some write has superseded */
  #superseded = new Set();

  constructor(state) {
    if (state) {
      for (const [t, v] of state.e ?? []) this.#entries.set(t, v);
      for (const t of state.s ?? []) this.#superseded.add(t);
    }
  }

  /** All concurrent values, ordered by their timestamp for stable display. */
  get values() {
    return [...this.#entries.entries()]
      .sort((a, b) => compareTimestamps(a[0], b[0]))
      .map(([, v]) => v);
  }

  /** Convenience for the common case: the latest value under the total order. */
  get value() {
    const vs = this.values;
    return vs.length === 0 ? null : vs.at(-1);
  }

  /** True when replicas disagree and the application should show a choice. */
  get hasConflict() { return this.#entries.size > 1; }

  get siblings() {
    return [...this.#entries.entries()]
      .sort((a, b) => compareTimestamps(a[0], b[0]))
      .map(([ts, value]) => ({ ts, value }));
  }

  /**
   * Build a write payload. Must be called on the writing replica's *current*
   * state: the sibling list it captures is what makes the write supersede
   * everything this replica had seen.
   */
  op(value) { return { v: value, d: [...this.#entries.keys()] }; }

  /** Static form for a blind write that supersedes nothing it has not seen. */
  static op(value, observed = []) { return { v: value, d: [...observed] }; }

  apply(payload, meta) {
    let changed = false;
    for (const ts of payload.d ?? []) {
      if (!this.#superseded.has(ts)) this.#superseded.add(ts);
      if (this.#entries.delete(ts)) changed = true;
    }
    // A write that some later write already superseded must not come back,
    // however late it arrives.
    if (!this.#superseded.has(meta.ts) && !this.#entries.has(meta.ts)) {
      this.#entries.set(meta.ts, payload.v ?? null);
      changed = true;
    }
    return changed;
  }

  merge(other) {
    let changed = false;
    for (const ts of other.#superseded) {
      if (!this.#superseded.has(ts)) { this.#superseded.add(ts); changed = true; }
      if (this.#entries.delete(ts)) changed = true;
    }
    for (const [ts, v] of other.#entries) {
      if (!this.#superseded.has(ts) && !this.#entries.has(ts)) {
        this.#entries.set(ts, v);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Forget superseded timestamps at or below `stableTs`. Safe only once the
   * sync layer knows every replica has moved past that point, so no operation
   * naming them can still be in flight.
   */
  gc(stableTs) {
    let dropped = 0;
    for (const ts of this.#superseded) {
      if (compareTimestamps(ts, stableTs) <= 0) { this.#superseded.delete(ts); dropped++; }
    }
    return dropped;
  }

  toJSON() {
    return {
      e: [...this.#entries.entries()].sort((a, b) => compareTimestamps(a[0], b[0])),
      s: [...this.#superseded].sort(),
    };
  }

  static fromJSON(state) { return new MVRegister(state); }
}

registerType(MVRegister.type, MVRegister);
