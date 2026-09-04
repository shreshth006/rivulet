/**
 * @file One compression API across Node and the browser.
 *
 * Both platforms ship DEFLATE; they disagree only about the interface. Node has
 * `node:zlib`, browsers have `CompressionStream`. This module picks whichever
 * exists and presents a single promise-returning function, so the sync engine
 * has no platform branches in it.
 *
 * Raw DEFLATE, not gzip or zlib: those add 10-18 bytes of header and trailer
 * per message. On a sync payload that is often under 200 bytes, that header is
 * real overhead, and we already know the algorithm from the frame's own flags.
 */

const isNode = typeof process !== 'undefined' && !!process.versions?.node;

/** Below this, framing and headers cost more than compression saves. */
export const MIN_COMPRESS_BYTES = 160;

let zlibPromise = null;
const zlib = () => (zlibPromise ??= import('node:zlib'));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBytes(text) { return encoder.encode(text); }
export function fromBytes(bytes) { return decoder.decode(bytes); }

/** @param {ReadableStream} stream @returns {Promise<Uint8Array>} */
async function drain(stream) {
  const chunks = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @param {{ level?: number }} [opts] 0-9; 6 is the default trade, 9 for
 *   benchmarks that care about the floor rather than CPU time.
 * @returns {Promise<Uint8Array>}
 */
export async function deflate(bytes, { level = 6 } = {}) {
  if (isNode) {
    const { deflateRawSync } = await zlib();
    return new Uint8Array(deflateRawSync(bytes, { level }));
  }
  if (typeof CompressionStream === 'function') {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    writer.write(bytes); writer.close();
    return drain(cs.readable);
  }
  return bytes; // no codec available: the frame flag records that it is raw
}

/** @param {Uint8Array} bytes @returns {Promise<Uint8Array>} */
export async function inflate(bytes) {
  if (isNode) {
    const { inflateRawSync } = await zlib();
    return new Uint8Array(inflateRawSync(bytes));
  }
  if (typeof DecompressionStream === 'function') {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(bytes); writer.close();
    return drain(ds.readable);
  }
  throw new Error('no DEFLATE implementation available');
}

/** True when this runtime can actually compress. */
export function compressionAvailable() {
  return isNode || typeof CompressionStream === 'function';
}
