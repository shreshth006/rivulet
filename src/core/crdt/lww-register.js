/**
 * @file Last-writer-wins register -- the default field type.
 *
 * Holds one value; concurrent writes are resolved by HLC timestamp with the
 * replica id as tiebreak. Every replica picks the same winner because that
 * order is total and computed purely from the operations, with no coordination.
 *
 * The honest caveat: LWW *discards* the loser. That is the right trade for a
 * status flag or a title, and the wrong one for a field where a lost edit is
 * expensive -- use {@link MVRegister} there and surface both values to the user.
 */

import { ZERO_TIMESTAMP, compareTimestamps } from '#core/hlc';
import { registerType } from '#core/crdt/contract';
import { deepEqual } from '#core/util';

export class LWWRegister {
  static type = 'lww';

  #ts = ZERO_TIMESTAMP;
  #value = null;

  constructor(state) {
    if (state) { this.#ts = state.t ?? ZERO_TIMESTAMP; this.#value = state.v ?? null; }
  }

  get value() { return this.#value; }
  get timestamp() { return this.#ts; }
  get hasValue() { return this.#value !== null && this.#value !== undefined; }
  get isInitialized() { return this.#ts !== ZERO_TIMESTAMP; }

  /** Payload for a write. The HLC timestamp travels in the op envelope. */
  static op(value) { return { v: value }; }

  apply(payload, meta) {
    if (compareTimestamps(meta.ts, this.#ts) <= 0) return false;
    const changed = !deepEqual(this.#value, payload.v);
    this.#ts = meta.ts;
    this.#value = payload.v ?? null;
    return changed;
  }

  merge(other) {
    if (compareTimestamps(other.#ts, this.#ts) <= 0) return false;
    const changed = !deepEqual(this.#value, other.#value);
    this.#ts = other.#ts;
    this.#value = other.#value;
    return changed;
  }

  toJSON() { return { t: this.#ts, v: this.#value }; }
  static fromJSON(state) { return new LWWRegister(state); }
}

registerType(LWWRegister.type, LWWRegister);
