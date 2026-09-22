/**
 * @file Small dependency-free helpers shared across the engine.
 * Everything here must run unchanged in Node and in the browser.
 */

import { ValidationError } from '#core/errors';

const HEX = '0123456789abcdef';

/** Pad `n` to a fixed-width lowercase hex string (lexicographically sortable). */
export function toHex(n, width) {
  const s = Math.trunc(n).toString(16);
  if (s.length > width) throw new ValidationError('hex overflow', { n, width });
  return s.padStart(width, '0');
}

/** Cryptographically strong random hex, falling back to Math.random offline. */
export function randomHex(bytes) {
  const g = globalThis.crypto;
  if (g && typeof g.getRandomValues === 'function') {
    const buf = new Uint8Array(bytes);
    g.getRandomValues(buf);
    let out = '';
    for (const b of buf) out += HEX[b >> 4] + HEX[b & 15];
    return out;
  }
  let out = '';
  for (let i = 0; i < bytes * 2; i++) out += HEX[(Math.random() * 16) | 0];
  return out;
}

/**
 * Deterministic, seeded PRNG (mulberry32). Benchmarks and fuzz tests depend on
 * reproducible schedules, so we never reach for Math.random in those paths.
 * @param {number} seed
 * @returns {() => number} uniform in [0, 1)
 */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [lo, hi] from a seeded rng. */
export function randInt(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** Pick one element of `arr` using a seeded rng. */
export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Fisher-Yates shuffle of a copy of `arr` using a seeded rng. */
export function shuffled(rng, arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * JSON with object keys sorted at every depth. Used wherever a byte-identical
 * encoding matters: content hashing, snapshot equality, golden-file tests.
 */
export function stableStringify(value) {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted = {};
      for (const k of Object.keys(v).sort()) sorted[k] = v[k];
      return sorted;
    }
    return v;
  });
}

/** Structural equality for JSON-shaped values. */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

/**
 * FNV-1a 32-bit over a string. Not a security hash -- used for cheap content
 * fingerprints (snapshot digests, convergence checks in tests).
 */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Content digest of any JSON value, stable across key insertion order. */
export function digest(value) {
  return toHex(fnv1a(stableStringify(value)), 8);
}

/** Promise that resolves after `ms`, using the injected timer if given. */
export function sleep(ms, { setTimeout: st = globalThis.setTimeout } = {}) {
  return new Promise((resolve) => st(resolve, ms));
}

/**
 * Full-jitter exponential backoff (AWS style). Returns the delay for `attempt`,
 * counting from 0. Full jitter, not equal jitter: with many hostel-Wi-Fi
 * clients reconnecting after the same outage, spreading retries uniformly
 * across the window avoids the thundering herd that partial jitter leaves.
 */
export function backoffDelay(attempt, { baseMs = 500, maxMs = 30_000, rng = Math.random } = {}) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
  return Math.floor(rng() * ceiling);
}

/** Group an iterable into arrays of at most `size`. */
export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Insertion index keeping `arr` sorted under `cmp`. */
export function bisect(arr, item, cmp) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cmp(arr[mid], item) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A tiny typed event emitter; avoids pulling in node:events for browser code. */
export class Emitter {
  #listeners = new Map();

  /**
   * What to do when a listener throws.
   *
   * One subscriber's bug must not stop the others from being notified -- a
   * render callback that throws should not prevent the sync engine's own
   * bookkeeping listener from running. But the error must not vanish either,
   * or the bug is invisible.
   *
   * The default rethrows out of band, which surfaces it as an unhandled error
   * rather than a silent no-op. Applications that would rather log and carry
   * on can replace it; on a phone, taking down the process because a list item
   * failed to render is the worse outcome.
   *
   * @type {(error: unknown, context: {event: string}) => void}
   */
  onListenerError = (error) => { queueMicrotask(() => { throw error; }); };

  /** @param {string} event @param {(payload:any)=>void} fn @returns {() => void} unsubscribe */
  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  once(event, fn) {
    const off = this.on(event, (p) => { off(); fn(p); });
    return off;
  }

  off(event, fn) {
    this.#listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    const set = this.#listeners.get(event);
    if (!set) return;
    // Copy: handlers routinely unsubscribe themselves mid-dispatch.
    for (const fn of [...set]) {
      try { fn(payload); } catch (err) { this.onListenerError(err, { event }); }
    }
  }

  removeAllListeners() { this.#listeners.clear(); }
}

/** Fast structured clone for plain objects, arrays, Sets, Maps, and primitives. */
export function cloneDeep(val) {
  if (val === null || typeof val !== 'object') return val;
  if (val instanceof Date) return new Date(val.getTime());
  if (val instanceof RegExp) return new RegExp(val.source, val.flags);
  if (val instanceof Set) {
    const copy = new Set();
    for (const item of val) copy.add(cloneDeep(item));
    return copy;
  }
  if (val instanceof Map) {
    const copy = new Map();
    for (const [k, v] of val) copy.set(cloneDeep(k), cloneDeep(v));
    return copy;
  }
  if (Array.isArray(val)) {
    return val.map((item) => cloneDeep(item));
  }
  if (val instanceof Uint8Array) {
    const copy = new Uint8Array(val.length);
    copy.set(val);
    return copy;
  }
  const copy = {};
  for (const [k, v] of Object.entries(val)) {
    copy[k] = cloneDeep(v);
  }
  return copy;
}

/** Fixed-capacity LRU cache backed by Map insertion order. */
export class LruCache {
  #capacity;
  #map = new Map();

  constructor(capacity = 256) {
    if (capacity <= 0) throw new ValidationError('capacity must be greater than 0', { capacity });
    this.#capacity = capacity;
  }

  get capacity() { return this.#capacity; }
  get size() { return this.#map.size; }

  has(key) { return this.#map.has(key); }

  get(key) {
    if (!this.#map.has(key)) return undefined;
    const val = this.#map.get(key);
    this.#map.delete(key);
    this.#map.set(key, val);
    return val;
  }

  set(key, value) {
    if (this.#map.has(key)) {
      this.#map.delete(key);
    } else if (this.#map.size >= this.#capacity) {
      const oldestKey = this.#map.keys().next().value;
      this.#map.delete(oldestKey);
    }
    this.#map.set(key, value);
    return this;
  }

  delete(key) { return this.#map.delete(key); }
  clear() { this.#map.clear(); }
}
