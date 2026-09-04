/**
 * @file Turning a protocol message into bytes, and back.
 *
 * Compression is applied only when it pays. A sync request carrying no
 * operations is around 80 bytes; DEFLATE would make it *larger* and cost CPU on
 * a phone. So framing measures both and keeps whichever is smaller, recording
 * the choice in the frame's encoding tag rather than assuming it.
 *
 * Every frame reports what it cost. Those numbers are not debug output -- they
 * feed the client's adaptive batching (which sizes the next request from
 * observed goodput) and the evaluation in the paper.
 */

import { deflate, inflate, toBytes, fromBytes, MIN_COMPRESS_BYTES, compressionAvailable } from '#protocol/compress';
import { ProtocolError } from '#core/errors';

export const Encoding = Object.freeze({ JSON: 'json', DEFLATE: 'deflate-raw' });

/**
 * @typedef {object} Frame
 * @property {Uint8Array} bytes what goes on the wire
 * @property {'json'|'deflate-raw'} encoding
 * @property {number} rawBytes uncompressed size
 * @property {number} wireBytes actual size sent
 */

/**
 * @param {object} message
 * @param {object} [opts]
 * @param {boolean} [opts.compress] allow compression (subject to the threshold)
 * @param {number} [opts.threshold] skip compression below this many bytes
 * @param {number} [opts.level]
 * @returns {Promise<Frame>}
 */
export async function packMessage(message, { compress = true, threshold = MIN_COMPRESS_BYTES, level = 6 } = {}) {
  const raw = toBytes(JSON.stringify(message));

  if (!compress || !compressionAvailable() || raw.length < threshold) {
    return { bytes: raw, encoding: Encoding.JSON, rawBytes: raw.length, wireBytes: raw.length };
  }

  const packed = await deflate(raw, { level });
  // Compression can lose on small or already-dense payloads. Take the winner.
  if (packed.length >= raw.length) {
    return { bytes: raw, encoding: Encoding.JSON, rawBytes: raw.length, wireBytes: raw.length };
  }
  return { bytes: packed, encoding: Encoding.DEFLATE, rawBytes: raw.length, wireBytes: packed.length };
}

/**
 * @param {Uint8Array} bytes
 * @param {'json'|'deflate-raw'} encoding
 * @returns {Promise<object>}
 */
export async function unpackMessage(bytes, encoding = Encoding.JSON) {
  let raw = bytes;
  if (encoding === Encoding.DEFLATE) {
    try {
      raw = await inflate(bytes);
    } catch (err) {
      throw new ProtocolError('could not decompress frame', { cause: String(err) });
    }
  } else if (encoding !== Encoding.JSON) {
    throw new ProtocolError('unsupported content encoding', { encoding });
  }

  try {
    return JSON.parse(fromBytes(raw));
  } catch (err) {
    throw new ProtocolError('frame is not valid JSON', { cause: String(err), bytes: raw.length });
  }
}

/** Negotiate an encoding from what the peer advertised. */
export function negotiateEncoding(clientSupports = [], serverSupports = [Encoding.DEFLATE]) {
  for (const enc of serverSupports) if (clientSupports.includes(enc)) return enc;
  return Encoding.JSON;
}

/** Running totals for one connection; the client surfaces these to the UI. */
export class ByteMeter {
  sentFrames = 0; sentRaw = 0; sentWire = 0;
  recvFrames = 0; recvRaw = 0; recvWire = 0;

  recordSend(frame) {
    this.sentFrames++; this.sentRaw += frame.rawBytes; this.sentWire += frame.wireBytes;
    return frame;
  }

  recordReceive({ rawBytes, wireBytes }) {
    this.recvFrames++; this.recvRaw += rawBytes; this.recvWire += wireBytes;
  }

  get summary() {
    const ratio = (wire, raw) => (raw === 0 ? 1 : wire / raw);
    return {
      sentFrames: this.sentFrames, sentWire: this.sentWire, sentRaw: this.sentRaw,
      recvFrames: this.recvFrames, recvWire: this.recvWire, recvRaw: this.recvRaw,
      totalWire: this.sentWire + this.recvWire,
      compressionRatio: ratio(this.sentWire + this.recvWire, this.sentRaw + this.recvRaw),
    };
  }

  reset() {
    this.sentFrames = this.sentRaw = this.sentWire = 0;
    this.recvFrames = this.recvRaw = this.recvWire = 0;
  }
}
