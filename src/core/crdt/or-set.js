/**
 * @file Observed-remove set (add-wins).
 *
 * The naive offline set breaks in both directions: a two-phase set can never
 * re-add a removed element, and a plain "last operation wins" set loses adds.
 * An OR-Set fixes both by tagging every add with a unique identifier. A remove
 * deletes only the tags it actually *observed*; an add that the remover never
 * saw keeps its tag, so the element stays.
 *
 * That gives add-wins semantics, which is the forgiving default: concurrently
 * adding and removing the same tag leaves it present. A user who re-adds a tag
 * offline does not lose it to someone else's stale delete, and re-adding after
 * a remove always works because it mints a fresh tag.
 *
 * Tags are HLC timestamps, so they are unique without extra bytes on the wire.
 * Removed tags are remembered so a late add cannot resurrect a deleted element;
 * {@link ORSet#gc} drops that record once the sync layer proves the operation
 * naming it can no longer be in flight.
 */

import { registerType } from '#core/crdt/contract';
import { compareTimestamps } from '#core/hlc';
import { stableStringify } from '#core/util';

/** Elements are compared by value, so objects need a stable key. */
const keyOf = (el) => (typeof el === 'string' ? `s${el}` : `j${stableStringify(el)}`);

export class ORSet {
  static type = 'set';

  /** @type {Map<string, { el: any, tags: Set<string> }>} */
  #live = new Map();
  /** @type {Set<string>} tags some remove has already retired */
  #removed = new Set();

  constructor(state) {
    if (state) {
      for (const [k, el, tags] of state.l ?? []) this.#live.set(k, { el, tags: new Set(tags) });
      for (const t of state.r ?? []) this.#removed.add(t);
    }
  }

  /** @returns {any[]} members, ordered by their earliest surviving tag */
  get value() {
    return [...this.#live.values()]
      .map((e) => ({ el: e.el, first: [...e.tags].sort(compareTimestamps)[0] }))
      .sort((a, b) => compareTimestamps(a.first, b.first))
      .map((e) => e.el);
  }

  get size() { return this.#live.size; }
  get isEmpty() { return this.#live.size === 0; }
  has(el) { return this.#live.has(keyOf(el)); }

  /** Payload for adding `el`. The op's HLC timestamp becomes its tag. */
  static op(el) { return { a: el }; }

  /**
   * Payload for removing `el`. Captures the tags this replica can currently
   * see -- concurrent adds it has not seen are deliberately left alone.
   */
  op(el) {
    const entry = this.#live.get(keyOf(el));
    return { r: el, t: entry ? [...entry.tags] : [] };
  }

  /**
   * Return remove payloads for all currently observed elements.
   * @returns {Array<{r: any, t: string[]}>}
   */
  clearOps() {
    const ops = [];
    for (const entry of this.#live.values()) {
      ops.push({ r: entry.el, t: [...entry.tags] });
    }
    return ops;
  }

  apply(payload, meta) {
    if ('a' in payload) {
      // A tag already retired by a remove we saw first must not come back.
      if (this.#removed.has(meta.ts)) return false;
      const k = keyOf(payload.a);
      const entry = this.#live.get(k);
      if (entry) {
        if (entry.tags.has(meta.ts)) return false;
        entry.tags.add(meta.ts);
        return false; // element was already present; membership did not change
      }
      this.#live.set(k, { el: payload.a, tags: new Set([meta.ts]) });
      return true;
    }

    const k = keyOf(payload.r);
    let changed = false;
    for (const tag of payload.t ?? []) this.#removed.add(tag);
    const entry = this.#live.get(k);
    if (entry) {
      for (const tag of payload.t ?? []) entry.tags.delete(tag);
      if (entry.tags.size === 0) { this.#live.delete(k); changed = true; }
    }
    return changed;
  }

  merge(other) {
    let changed = false;
    for (const tag of other.#removed) this.#removed.add(tag);

    for (const [k, entry] of other.#live) {
      const tags = [...entry.tags].filter((t) => !this.#removed.has(t));
      if (tags.length === 0) continue;
      const mine = this.#live.get(k);
      if (!mine) { this.#live.set(k, { el: entry.el, tags: new Set(tags) }); changed = true; }
      else for (const t of tags) mine.tags.add(t);
    }

    // Our own tags may have been retired by a remove only the peer had seen.
    for (const [k, entry] of this.#live) {
      for (const tag of entry.tags) if (this.#removed.has(tag)) entry.tags.delete(tag);
      if (entry.tags.size === 0) { this.#live.delete(k); changed = true; }
    }
    return changed;
  }

  /** Drop retired-tag bookkeeping at or below a causally stable timestamp. */
  gc(stableTs) {
    let dropped = 0;
    for (const tag of this.#removed) {
      if (compareTimestamps(tag, stableTs) <= 0) { this.#removed.delete(tag); dropped++; }
    }
    return dropped;
  }

  /** Bytes of bookkeeping beyond the visible members -- watched by the benchmarks. */
  get overhead() {
    let tags = 0;
    for (const e of this.#live.values()) tags += e.tags.size;
    return { liveTags: tags, retiredTags: this.#removed.size };
  }

  toJSON() {
    return {
      l: [...this.#live.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([k, e]) => [k, e.el, [...e.tags].sort()]),
      r: [...this.#removed].sort(),
    };
  }

  static fromJSON(state) { return new ORSet(state); }
}

registerType(ORSet.type, ORSet);
