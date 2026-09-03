/**
 * @file A compact set of positive integers stored as disjoint inclusive ranges.
 *
 * Each replica numbers its own operations 1, 2, 3, ... On a good link a peer
 * receives them in order and "I have everything up to 42" is the whole story.
 * On a bad link -- a partial batch, a resumed transfer, a partition that healed
 * from two directions -- a replica ends up holding {1..20, 27..42} with a hole.
 *
 * Recording that hole matters. If we collapsed the set to its maximum (42) we
 * would tell peers we already have 21..26 and those operations would never be
 * resent: silent, permanent data loss that no amount of CRDT merging recovers.
 * So the local store tracks exact ranges here, and advertises only the
 * contiguous prefix ({@link RangeSet#frontier}) on the wire.
 *
 * Ranges compact as gaps fill, so steady-state memory is O(1) per replica and
 * degrades only while a replica is genuinely behind.
 */

import { ValidationError } from '#core/errors';
import { bisect } from '#core/util';

export class RangeSet {
  /** @type {Array<[number, number]>} sorted, disjoint, non-adjacent */
  #ranges = [];

  /** @param {Array<[number,number]>} [ranges] */
  constructor(ranges = []) {
    for (const [lo, hi] of ranges) this.addRange(lo, hi);
  }

  get ranges() { return this.#ranges.map((r) => /** @type {[number,number]} */ ([...r])); }
  get rangeCount() { return this.#ranges.length; }

  /** Total number of integers held. */
  get size() {
    let n = 0;
    for (const [lo, hi] of this.#ranges) n += hi - lo + 1;
    return n;
  }

  get isEmpty() { return this.#ranges.length === 0; }

  /** @param {number} n */
  add(n) { return this.addRange(n, n); }

  /**
   * Insert [lo, hi], merging with any range it touches or abuts.
   * @param {number} lo @param {number} hi
   */
  addRange(lo, hi) {
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1 || hi < lo) {
      throw new ValidationError('invalid range', { lo, hi });
    }
    const r = this.#ranges;
    // First range that could touch or abut [lo, hi] -- note `lo - 1`, which is
    // what merges [1,5] with [6,9] into [1,9] instead of leaving them adjacent.
    let i = bisect(r, [lo - 1, lo - 1], (a, b) => a[1] - b[0]);
    let start = lo, end = hi, j = i;
    while (j < r.length && r[j][0] <= hi + 1) {
      start = Math.min(start, r[j][0]);
      end = Math.max(end, r[j][1]);
      j++;
    }
    r.splice(i, j - i, [start, end]);
    return this;
  }

  /** @param {number} n */
  has(n) {
    const r = this.#ranges;
    let lo = 0, hi = r.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (n < r[mid][0]) hi = mid - 1;
      else if (n > r[mid][1]) lo = mid + 1;
      else return true;
    }
    return false;
  }

  /** True when every integer in [lo, hi] is present. */
  hasRange(lo, hi) {
    const r = this.#ranges;
    for (const [a, b] of r) if (a <= lo && hi <= b) return true;
    return false;
  }

  /**
   * Largest `n` such that 1..n are all present; 0 when even 1 is missing.
   * This is the only number safe to advertise to peers.
   */
  frontier() {
    const first = this.#ranges[0];
    return first && first[0] === 1 ? first[1] : 0;
  }

  /** Highest integer held, or 0. */
  max() {
    const last = this.#ranges.at(-1);
    return last ? last[1] : 0;
  }

  /**
   * Gaps below `upTo`, as ranges -- exactly what to re-request from a peer.
   * @param {number} upTo @returns {Array<[number,number]>}
   */
  gaps(upTo = this.max()) {
    /** @type {Array<[number,number]>} */
    const out = [];
    let cursor = 1;
    for (const [lo, hi] of this.#ranges) {
      if (lo > upTo) break;
      if (lo > cursor) out.push([cursor, Math.min(lo - 1, upTo)]);
      cursor = Math.max(cursor, hi + 1);
    }
    if (cursor <= upTo) out.push([cursor, upTo]);
    return out;
  }

  /** Union in place. */
  merge(other) {
    for (const [lo, hi] of other.#ranges) this.addRange(lo, hi);
    return this;
  }

  clone() { return new RangeSet(this.ranges); }

  *[Symbol.iterator]() {
    for (const [lo, hi] of this.#ranges) for (let n = lo; n <= hi; n++) yield n;
  }

  /**
   * Delta-varint form: [lo1, len1, gap, len2, ...]. Consecutive ranges are
   * stored as offsets from the previous end, which keeps a long-lived replica's
   * range list small on the wire even when it has many holes.
   * @returns {number[]}
   */
  toJSON() {
    const out = [];
    let prev = 0;
    for (const [lo, hi] of this.#ranges) {
      out.push(lo - prev, hi - lo);
      prev = hi;
    }
    return out;
  }

  /** @param {number[]|undefined|null} arr */
  static fromJSON(arr) {
    const rs = new RangeSet();
    if (!arr) return rs;
    if (arr.length % 2 !== 0) throw new ValidationError('odd range encoding', { arr });
    let prev = 0;
    for (let i = 0; i < arr.length; i += 2) {
      const lo = prev + arr[i];
      const hi = lo + arr[i + 1];
      rs.addRange(lo, hi);
      prev = hi;
    }
    return rs;
  }

  toString() {
    return `RangeSet(${this.#ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(',')})`;
  }
}
