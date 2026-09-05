/**
 * @file Adaptive batch sizing.
 *
 * How many operations should a sync request carry? There is no good fixed
 * answer. Too few and a high-latency link spends all its time in round trips:
 * at 400ms RTT, 50 operations per request means 8 seconds to move 1000
 * operations, nearly all of it waiting. Too many and a single request outlives
 * the connection -- on a link that drops every 30 seconds, a 45-second transfer
 * never completes, retries from the start, and never will.
 *
 * So the batch size is measured rather than configured. The controller tracks
 * how fast rounds actually complete and targets a request that takes about
 * `targetMs` end to end -- long enough to amortise the round trip, short enough
 * to finish before a flaky link drops it.
 *
 * The control law is AIMD, for the same reason TCP uses it: growth must be
 * cautious and backoff decisive, because the cost of overshooting (a timed-out
 * request, retried from scratch) is far higher than the cost of undershooting
 * (one extra round trip). Growth is capped per round so one fast burst on a
 * briefly-good link cannot set a size the link cannot sustain.
 */

/** Weight for the newest sample in the throughput average. */
const EWMA_ALPHA = 0.3;

export class AdaptiveBatcher {
  #size;
  #min;
  #max;
  #targetMs;
  #growth;
  #opsPerMs = null;
  #rttMs = null;
  #consecutiveFailures = 0;

  /**
   * @param {object} [opts]
   * @param {number} [opts.initial] first request size, before any measurement
   * @param {number} [opts.min] never go below this; one round must make progress
   * @param {number} [opts.max] server-side ceiling
   * @param {number} [opts.targetMs] how long one round should take
   * @param {number} [opts.growth] maximum multiplier per successful round
   */
  constructor({ initial = 64, min = 8, max = 1000, targetMs = 2000, growth = 2 } = {}) {
    this.#min = min;
    this.#max = max;
    this.#size = Math.min(Math.max(initial, min), max);
    this.#targetMs = targetMs;
    this.#growth = growth;
  }

  /** Operations to request in the next round. */
  get size() { return this.#size; }

  get estimate() {
    return {
      size: this.#size,
      opsPerSecond: this.#opsPerMs === null ? null : Math.round(this.#opsPerMs * 1000),
      rttMs: this.#rttMs === null ? null : Math.round(this.#rttMs),
      consecutiveFailures: this.#consecutiveFailures,
    };
  }

  /**
   * Record a completed round.
   * @param {object} sample
   * @param {number} sample.ops operations transferred (both directions)
   * @param {number} sample.ms wall time for the whole round trip
   */
  record({ ops, ms }) {
    this.#consecutiveFailures = 0;
    if (ms <= 0) return this.#size;

    if (ops === 0) {
      // An empty round measures latency, not throughput. Keeping it out of the
      // throughput average matters: idle polling would otherwise drive the
      // estimate to zero and collapse the batch size before real work arrives.
      this.#rttMs = this.#rttMs === null ? ms : this.#rttMs + EWMA_ALPHA * (ms - this.#rttMs);
      return this.#size;
    }

    const observed = ops / ms;
    this.#opsPerMs = this.#opsPerMs === null
      ? observed
      : this.#opsPerMs + EWMA_ALPHA * (observed - this.#opsPerMs);

    const ideal = Math.round(this.#opsPerMs * this.#targetMs);
    // Additive-ish increase: approach the target, but never overshoot what the
    // link has actually demonstrated it can carry in one round.
    this.#size = this.#clamp(Math.min(ideal, this.#size * this.#growth));
    return this.#size;
  }

  /**
   * Record a failed or timed-out round: halve the batch.
   * Multiplicative decrease, because a size the link cannot sustain wastes a
   * whole round trip each time it is retried.
   */
  fail() {
    this.#consecutiveFailures++;
    this.#size = this.#clamp(Math.floor(this.#size / 2));
    return this.#size;
  }

  /** Apply a ceiling the server advertised at connect time. */
  setCeiling(max) {
    this.#max = Math.max(this.#min, max);
    this.#size = this.#clamp(this.#size);
    return this.#size;
  }

  #clamp(n) { return Math.min(Math.max(Math.round(n) || this.#min, this.#min), this.#max); }
}
