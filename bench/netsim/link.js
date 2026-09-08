/**
 * @file A simulated network link between one client and the server.
 *
 * Models the four things that actually determine whether sync works on a bad
 * connection, and that a naive "add 200ms" simulation misses:
 *
 * 1. **Round-trip latency with jitter.** Jitter is why a protocol cannot just
 *    pipeline around latency: request times vary run to run, so a fixed batch
 *    size is either too cautious or too optimistic.
 * 2. **Bandwidth.** Transmission time scales with the bytes actually sent,
 *    which is what makes the codec's savings show up as *time*, not just as a
 *    smaller number in a table.
 * 3. **Loss, split across directions.** A lost request the server never saw
 *    and a lost *response* to a request the server fully processed are very
 *    different failures. The second is the one that breaks naive protocols:
 *    the client retries something already applied. Modelling it is how we
 *    demonstrate that idempotent pushes actually hold up.
 * 4. **Outages, including mid-request.** Recurring windows where nothing gets
 *    through -- roaming between access points, a tunnel, a saturated channel.
 *    Critically, a request already in flight when the window opens is cut,
 *    not waved through. Without that, an arbitrarily large batch is never
 *    punished and the simulation would report that the biggest possible
 *    request is always best, which is the opposite of what happens on a link
 *    that keeps dropping. A request that would simply take longer than the
 *    client's timeout fails for the same reason.
 *
 * Every decision comes from a seeded generator, so a run replays exactly.
 */

import { TransportError } from '#core/errors';
import { makeRng } from '#core/util';

export class SimulatedLink {
  #clock;
  #rng;
  #profile;
  #timeoutMs;
  #forcedOffline = false;

  stats = {
    requests: 0,
    delivered: 0,
    lostUplink: 0,
    lostDownlink: 0,
    interrupted: 0,
    timedOut: 0,
    refused: 0,
    bytesUp: 0,
    bytesDown: 0,
    transmitMs: 0,
    latencyMs: 0,
  };

  /**
   * @param {object} opts
   * @param {import('#bench/netsim/profiles').NetworkProfile} opts.profile
   * @param {import('#bench/netsim/clock').VirtualClock} opts.clock
   * @param {number} [opts.seed]
   * @param {number} [opts.timeoutMs] how long a client waits before giving up
   */
  constructor({ profile, clock, seed = 1, timeoutMs = 20_000 }) {
    this.#profile = profile;
    this.#clock = clock;
    this.#rng = makeRng(seed);
    this.#timeoutMs = timeoutMs;
  }

  get profile() { return this.#profile; }

  /** Force the link down regardless of the profile's outage schedule. */
  setOffline(offline) { this.#forcedOffline = offline; return this; }

  /** True when the profile's recurring outage covers the current instant. */
  get inOutage() {
    const o = this.#profile.outage;
    if (!o) return false;
    return (this.#clock.now % o.everyMs) < o.forMs;
  }

  /**
   * When the next outage window opens, or Infinity if the profile has none.
   * Windows are [k*everyMs, k*everyMs + forMs).
   */
  nextOutageAt(from = this.#clock.now) {
    const o = this.#profile.outage;
    if (!o) return Infinity;
    return Math.ceil(from / o.everyMs) * o.everyMs;
  }

  get offline() { return this.#forcedOffline || this.inOutage; }

  /** Milliseconds to push `bytes` through the link's bandwidth. */
  transmitMs(bytes) {
    return (bytes * 8) / this.#profile.bandwidthBps * 1000;
  }

  /** One sample of round-trip latency, jitter included. Never negative. */
  sampleLatency() {
    const { rttMs, jitterMs } = this.#profile;
    return Math.max(1, rttMs + (this.#rng() * 2 - 1) * jitterMs);
  }

  /**
   * Carry one request/response exchange.
   * @param {() => Promise<{reply: object, upBytes: number, downBytes: number}>} exchange
   */
  async carry(exchange) {
    this.stats.requests++;

    if (this.offline) {
      // Connection refused is fast; the client does not wait out a timeout.
      this.stats.refused++;
      await this.#clock.sleep(Math.min(50, this.#timeoutMs));
      throw new TransportError('network unreachable', { kind: 'unreachable' });
    }

    const halfLoss = this.#profile.loss / 2;

    // Uplink loss: the server never sees the request at all.
    if (this.#rng() < halfLoss) {
      this.stats.lostUplink++;
      await this.#clock.sleep(this.#timeoutMs);
      throw new TransportError('request lost in transit', { kind: 'lost' });
    }

    const latency = this.sampleLatency();
    const { reply, upBytes, downBytes } = await exchange();
    const duration = latency + this.transmitMs(upBytes) + this.transmitMs(downBytes);

    // A request that cannot finish before the link goes down is cut off. This
    // is what makes an oversized batch expensive: the work is done and thrown
    // away, and the whole round has to be repeated.
    const outageAt = this.nextOutageAt();
    if (this.#clock.now + duration > outageAt) {
      this.stats.interrupted++;
      this.stats.bytesUp += upBytes;
      await this.#clock.sleep(Math.max(1, outageAt - this.#clock.now));
      throw new TransportError('connection dropped mid-transfer', { kind: 'timeout' });
    }

    // Likewise a request that would simply take longer than the client waits.
    if (duration > this.#timeoutMs) {
      this.stats.timedOut++;
      this.stats.bytesUp += upBytes;
      await this.#clock.sleep(this.#timeoutMs);
      throw new TransportError('request timed out', { kind: 'timeout' });
    }

    // Downlink loss: the server did the work, but the client never hears back
    // and must retry something that has already been applied. This is the
    // case idempotent pushes exist for.
    if (this.#rng() < halfLoss) {
      this.stats.lostDownlink++;
      this.stats.bytesUp += upBytes;
      await this.#clock.sleep(this.#timeoutMs);
      throw new TransportError('response lost in transit', { kind: 'lost' });
    }

    await this.#clock.sleep(duration);

    this.stats.delivered++;
    this.stats.bytesUp += upBytes;
    this.stats.bytesDown += downBytes;
    this.stats.transmitMs += duration - latency;
    this.stats.latencyMs += latency;
    return reply;
  }

  /** Bound `carry`, ready to pass as a transport's `link` option. */
  get hook() { return (exchange) => this.carry(exchange); }

  get summary() {
    const s = this.stats;
    return {
      ...s,
      totalBytes: s.bytesUp + s.bytesDown,
      failures: s.lostUplink + s.lostDownlink + s.interrupted + s.timedOut + s.refused,
      lossRate: s.requests ? (s.lostUplink + s.lostDownlink) / s.requests : 0,
      avgLatencyMs: s.delivered ? s.latencyMs / s.delivered : 0,
    };
  }

  reset() {
    for (const k of Object.keys(this.stats)) this.stats[k] = 0;
  }
}
