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
 * 4. **Outages.** Recurring windows where nothing gets through -- roaming
 *    between access points, a tunnel, a saturated channel.
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
      throw new TransportError('network unreachable');
    }

    const halfLoss = this.#profile.loss / 2;

    // Uplink loss: the server never sees the request at all.
    if (this.#rng() < halfLoss) {
      this.stats.lostUplink++;
      await this.#clock.sleep(this.#timeoutMs);
      throw new TransportError('request lost in transit');
    }

    const latency = this.sampleLatency();
    const { reply, upBytes, downBytes } = await exchange();

    // Downlink loss: the server did the work, but the client never hears back
    // and must retry something that has already been applied. This is the
    // case idempotent pushes exist for.
    if (this.#rng() < halfLoss) {
      this.stats.lostDownlink++;
      this.stats.bytesUp += upBytes;
      await this.#clock.sleep(this.#timeoutMs);
      throw new TransportError('response lost in transit');
    }

    const transmit = this.transmitMs(upBytes) + this.transmitMs(downBytes);
    await this.#clock.sleep(latency + transmit);

    this.stats.delivered++;
    this.stats.bytesUp += upBytes;
    this.stats.bytesDown += downBytes;
    this.stats.transmitMs += transmit;
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
      lossRate: s.requests ? (s.lostUplink + s.lostDownlink) / s.requests : 0,
      avgLatencyMs: s.delivered ? s.latencyMs / s.delivered : 0,
    };
  }

  reset() {
    for (const k of Object.keys(this.stats)) this.stats[k] = 0;
  }
}
