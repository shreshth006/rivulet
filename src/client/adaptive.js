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
 * The control law borrows from TCP congestion control, because the shape of
 * the problem is the same: overshooting costs a whole wasted round trip,
 * undershooting costs one extra one, so backoff must be decisive and recovery
 * cautious.
 *
 * Growth is multiplicative only until the first failure. After that the
 * controller remembers the size that failed and treats just below it as a
 * ceiling, approaching it gently rather than repeatedly doubling back into it.
 * Without that memory the controller oscillates -- halve, double, fail, halve
 * -- and spends much of its time at a size the link has already demonstrated
 * it cannot carry. The ceiling relaxes slowly during sustained success, so a
 * link that genuinely improves is not held down by one old failure.
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
  /** Just below the smallest size observed to fail; Infinity until one does. */
  #safeMax = Infinity;
  /** EWMA of how long a successful round takes, used to classify failures. */
  #roundMs = null;

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
      safeMax: this.#safeMax === Infinity ? null : this.#safeMax,
      roundMs: this.#roundMs === null ? null : Math.round(this.#roundMs),
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
    // Sustained success lifts the ceiling, so one bad round does not hold the
    // batch size down forever after conditions improve. Additively, not
    // multiplicatively: a proportional lift would restore a failing size
    // within a handful of rounds and put the oscillation straight back.
    if (this.#safeMax !== Infinity) {
      this.#safeMax = Math.min(this.#max, this.#safeMax + this.#min);
    }
    if (ms <= 0) return this.#size;
    this.#roundMs = this.#roundMs === null ? ms : this.#roundMs + EWMA_ALPHA * (ms - this.#roundMs);

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
    // Approach the throughput target, but never past what this link has
    // already shown it cannot carry in a single round.
    this.#size = this.#clamp(Math.min(ideal, this.#size * this.#growth, this.#safeMax));
    return this.#size;
  }

  /**
   * Record a failed round.
   *
   * Only failures that implicate the request's *size* -- a timeout, or a link
   * that died mid-transfer -- cause a backoff. A dropped packet or an
   * unreachable server says nothing about how much a round can carry, and
   * shrinking the batch in response is actively harmful: on a link with a few
   * percent loss, treating every loss as congestion drives the size to the
   * floor and turns one transfer into hundreds of round trips.
   *
   * A timeout is only *evidence* about size, not proof. A request cut short
   * by a link going down looks identical to one that was too big -- except in
   * how long it had been running. A round that died well before a normal round
   * takes was killed by the link, not by its own size, and shrinking the batch
   * in response would leave the client permanently below what the link can
   * carry once it comes back.
   *
   * @param {{ sizeRelated?: boolean, ms?: number }} [cause]
   */
  fail({ sizeRelated = true, ms } = {}) {
    this.#consecutiveFailures++;
    if (!sizeRelated) return this.#size;

    // Died early relative to a normal round: the link failed, not the size.
    if (ms !== undefined && this.#roundMs !== null && ms < this.#roundMs) {
      return this.#size;
    }

    // Remember the size that failed. Approaching it again is what turns an
    // otherwise sensible controller into an oscillator.
    this.#safeMax = Math.max(this.#min, Math.floor(this.#size * 0.9));
    this.#size = this.#clamp(Math.floor(this.#size / 2));
    return this.#size;
  }

  /** Apply a ceiling the server advertised at connect time. */
  setCeiling(max) {
    this.#max = Math.max(this.#min, max);
    if (this.#safeMax !== Infinity) this.#safeMax = Math.min(this.#safeMax, this.#max);
    this.#size = this.#clamp(this.#size);
    return this.#size;
  }

  #clamp(n) {
    const bounded = Math.min(Math.max(Math.round(n) || this.#min, this.#min), this.#max);
    return Math.max(this.#min, Math.min(bounded, this.#safeMax));
  }
}
