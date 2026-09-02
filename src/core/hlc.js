/**
 * @file Hybrid Logical Clocks (Kulkarni et al., 2014).
 *
 * Why not plain wall-clock time? Because phones and laptops have skewed,
 * jumping clocks, and last-writer-wins on a bad clock silently destroys data.
 * Why not a plain Lamport counter? Because timestamps that drift arbitrarily
 * far from real time are useless for the product (sorting a feed, showing
 * "edited 5m ago") and for debugging.
 *
 * An HLC gives both: it is a correct logical clock (causally related events
 * always compare in causal order) whose value stays within a bounded distance
 * of physical time as long as clocks are roughly synchronised.
 *
 * Wire format is a fixed-width, lexicographically sortable string:
 *
 *     <12 hex: wall ms> "-" <4 hex: counter> "-" <16 hex: node id>
 *     000001946d2c1f40-0003-a1b2c3d4e5f60718
 *
 * Fixed widths mean `a < b` on the raw strings is exactly `compare(a, b) < 0`,
 * so SQLite/IndexedDB can order by the timestamp column with no custom collation.
 */

import { toHex } from '#core/util';
import { ClockDriftError, ValidationError } from '#core/errors';
import { assertNodeId, NODE_ID_LEN } from '#core/ids';

const WALL_HEX = 12;          // 48 bits of ms -- good until year 10889
const COUNTER_HEX = 4;        // 16 bits of logical counter per millisecond
export const MAX_COUNTER = 0xffff;
export const TIMESTAMP_LEN = WALL_HEX + 1 + COUNTER_HEX + 1 + NODE_ID_LEN;

/** Reject remote timestamps more than this far ahead of us. */
export const DEFAULT_MAX_DRIFT_MS = 60_000;

/** The smallest possible timestamp; sorts before every real one. */
export const ZERO_TIMESTAMP = `${'0'.repeat(WALL_HEX)}-${'0'.repeat(COUNTER_HEX)}-${'0'.repeat(NODE_ID_LEN)}`;

/**
 * @typedef {string} Timestamp An encoded HLC timestamp.
 * @typedef {{ wall: number, counter: number, node: string }} ParsedTimestamp
 */

/** @param {number} wall @param {number} counter @param {string} node @returns {Timestamp} */
export function encodeTimestamp(wall, counter, node) {
  if (counter > MAX_COUNTER) throw new ValidationError('HLC counter overflow', { wall, counter });
  return `${toHex(wall, WALL_HEX)}-${toHex(counter, COUNTER_HEX)}-${node}`;
}

/** @param {Timestamp} ts @returns {ParsedTimestamp} */
export function parseTimestamp(ts) {
  if (typeof ts !== 'string' || ts.length !== TIMESTAMP_LEN) {
    throw new ValidationError('malformed HLC timestamp', { ts });
  }
  return {
    wall: parseInt(ts.slice(0, WALL_HEX), 16),
    counter: parseInt(ts.slice(WALL_HEX + 1, WALL_HEX + 1 + COUNTER_HEX), 16),
    node: ts.slice(WALL_HEX + COUNTER_HEX + 2),
  };
}

/** Replica that issued `ts`, without paying for a full parse. */
export function timestampNode(ts) {
  return ts.slice(WALL_HEX + COUNTER_HEX + 2);
}

/** Wall-clock component in ms, for "edited 5m ago" style display. */
export function timestampWallMs(ts) {
  return parseInt(ts.slice(0, WALL_HEX), 16);
}

/**
 * Total order over timestamps: wall, then counter, then node id.
 * The node-id tiebreak is what makes the order *total* rather than partial --
 * two genuinely concurrent writes still get a deterministic, replica-independent
 * winner, which is precisely what last-writer-wins needs to converge.
 * @returns {-1|0|1}
 */
export function compareTimestamps(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The later of two timestamps under {@link compareTimestamps}. */
export function maxTimestamp(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a >= b ? a : b;
}

/**
 * A replica's hybrid logical clock.
 *
 * Call {@link HybridClock#now} before sending anything, and
 * {@link HybridClock#observe} for every timestamp received. Doing both is what
 * keeps the happens-before relation intact across the network.
 */
export class HybridClock {
  #wall = 0;
  #counter = 0;
  #node;
  #physical;
  #maxDriftMs;

  /**
   * @param {object} opts
   * @param {string} opts.node replica id
   * @param {() => number} [opts.physical] injectable clock source (tests, sim)
   * @param {number} [opts.maxDriftMs]
   * @param {Timestamp} [opts.last] resume from a persisted timestamp
   */
  constructor({ node, physical = Date.now, maxDriftMs = DEFAULT_MAX_DRIFT_MS, last } = {}) {
    this.#node = assertNodeId(node);
    this.#physical = physical;
    this.#maxDriftMs = maxDriftMs;
    if (last) {
      const p = parseTimestamp(last);
      this.#wall = p.wall;
      this.#counter = p.counter;
    }
  }

  get node() { return this.#node; }

  /** Current internal state as a timestamp, without advancing the clock. */
  peek() { return encodeTimestamp(this.#wall, this.#counter, this.#node); }

  /**
   * Stamp a new local event. Monotone: two calls never return the same value,
   * and the result is always >= every timestamp this clock has observed.
   * @returns {Timestamp}
   */
  now() {
    const phys = Math.trunc(this.#physical());
    const prevWall = this.#wall;
    this.#wall = Math.max(prevWall, phys);
    // Physical time did not advance past us (same ms, or our clock went
    // backwards) -- fall back to the logical counter to stay strictly monotone.
    this.#counter = this.#wall === prevWall ? this.#counter + 1 : 0;
    if (this.#counter > MAX_COUNTER) {
      // >65k events inside one millisecond: borrow from the next millisecond
      // rather than throw. Still monotone, still within drift bounds.
      this.#wall += 1;
      this.#counter = 0;
    }
    return this.peek();
  }

  /**
   * Fold a remote timestamp into this clock. Must be called for every inbound
   * timestamp *before* any local event that causally follows it.
   * @param {Timestamp} remote
   * @returns {Timestamp} this clock's new value
   */
  observe(remote) {
    const r = parseTimestamp(remote);
    const phys = Math.trunc(this.#physical());

    if (r.wall - phys > this.#maxDriftMs) {
      throw new ClockDriftError('remote clock too far ahead', {
        remote, remoteWall: r.wall, localWall: phys, maxDriftMs: this.#maxDriftMs,
      });
    }

    const prevWall = this.#wall, prevCounter = this.#counter;
    this.#wall = Math.max(prevWall, r.wall, phys);

    if (this.#wall === prevWall && this.#wall === r.wall) {
      this.#counter = Math.max(prevCounter, r.counter) + 1;
    } else if (this.#wall === prevWall) {
      this.#counter = prevCounter + 1;
    } else if (this.#wall === r.wall) {
      this.#counter = r.counter + 1;
    } else {
      this.#counter = 0; // physical time moved past both: reset
    }

    if (this.#counter > MAX_COUNTER) {
      this.#wall += 1;
      this.#counter = 0;
    }
    return this.peek();
  }

  /** Observe many timestamps (e.g. a whole inbound sync batch). */
  observeAll(timestamps) {
    for (const ts of timestamps) this.observe(ts);
    return this.peek();
  }
}
