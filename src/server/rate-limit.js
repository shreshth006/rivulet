/**
 * @file Request rate limiting: token buckets, in memory.
 *
 * A client that syncs in a tight loop -- a bug, a reconnect storm, a browser
 * tab gone wrong -- costs the server a request and a log query every time, and
 * on a room shared over a slow link it competes with everyone else's real
 * traffic. A bucket per key allows bursts (opening a client is several rounds
 * back to back) and caps the sustained rate.
 *
 * The server keys two buckets per request; see `SyncServer`. Per replica per
 * room is the real limit. Per IP address is deliberately loose: the networks
 * this project is for -- a hostel's shared access point, a campus NAT, a
 * carrier-grade NAT on mobile -- put many honest people behind one address, so
 * it exists only to stop one client from evading the replica limit by minting
 * new replica ids.
 *
 * Memory is bounded. A bucket that has refilled completely is the same as no
 * bucket, so those are dropped first when the table is full; past that, the
 * longest idle go.
 */

/**
 * @typedef {object} RateOptions
 * @property {number} perSecond sustained requests per second
 * @property {number} burst bucket capacity: requests allowed back to back
 */

export class RateLimiter {
  #rate;
  #burst;
  #maxKeys;
  /** @type {Map<string, { tokens: number, at: number }>} insertion order is age */
  #buckets = new Map();

  /** @param {RateOptions & { maxKeys?: number }} opts */
  constructor({ perSecond, burst, maxKeys = 100_000 }) {
    if (!(perSecond > 0) || !(burst >= 1)) throw new RangeError('rate limit needs perSecond > 0 and burst >= 1');
    this.#rate = perSecond / 1000;
    this.#burst = burst;
    this.#maxKeys = maxKeys;
  }

  get size() { return this.#buckets.size; }

  #level(bucket, now) {
    return Math.min(this.#burst, bucket.tokens + (now - bucket.at) * this.#rate);
  }

  /**
   * Spend one token for `key`.
   * @returns {{ ok: true } | { ok: false, retryAfterMs: number }}
   */
  take(key, now = Date.now()) {
    const bucket = this.#buckets.get(key);
    const tokens = bucket ? this.#level(bucket, now) : this.#burst;
    if (tokens < 1) return { ok: false, retryAfterMs: Math.ceil((1 - tokens) / this.#rate) };

    // Re-insert, so the map's order tracks recency for eviction.
    this.#buckets.delete(key);
    this.#buckets.set(key, { tokens: tokens - 1, at: now });
    if (this.#buckets.size > this.#maxKeys) this.#evict(now);
    return { ok: true };
  }

  #evict(now) {
    for (const [key, bucket] of this.#buckets) {
      if (this.#level(bucket, now) >= this.#burst) this.#buckets.delete(key);
    }
    // Still full: everything is active. Drop the least recently used.
    for (const key of this.#buckets.keys()) {
      if (this.#buckets.size <= this.#maxKeys) break;
      this.#buckets.delete(key);
    }
  }
}
