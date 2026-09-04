/**
 * @file The compact operation codec -- where the bandwidth work happens.
 *
 * A batch of operations serialised as plain JSON is enormously redundant.
 * Typing one word into a note produces four operations that look like this:
 *
 *   {"node":"a1b2c3d4e5f60718","seq":41,"ts":"000001946d2c1f40-0003-a1b2c3d4e5f60718",
 *    "collection":"notes","doc":"9f3c1a7b22d0","field":"body",
 *    "payload":{"i":"w","p":"000001946d2c1f3f-0001-a1b2c3d4e5f60718"}}
 *
 * Roughly 200 bytes to record one keystroke, and almost none of it is the
 * keystroke. On a metered, high-latency link that is the whole problem.
 *
 * Four transformations, each attacking a different kind of redundancy:
 *
 * 1. **Dictionary interning.** Collection, document and field names repeat on
 *    every operation in a batch. Hoist them into tables and store indices.
 *
 * 2. **Columnar layout.** Store all the `seq` values together, all the `field`
 *    indices together, and so on. Like values sit adjacent, which is both
 *    run-length encodable here and far more compressible by DEFLATE afterwards
 *    than the same data interleaved row by row.
 *
 * 3. **Derived and delta-encoded causality.** An operation's HLC timestamp
 *    always carries the id of the replica that issued it -- which we already
 *    have in the node column -- so it is dropped and reconstructed. What
 *    remains is delta-encoded against a batch base: within one editing burst
 *    those deltas are single digits. Sequence numbers, being dense, are almost
 *    always a delta of exactly 1.
 *
 * 4. **Timestamp back-references.** Operations point at each other constantly:
 *    every character inserted names the one before it, every delete names its
 *    target, every set removal names the tags it observed. When the referenced
 *    operation is in the same batch -- overwhelmingly the common case, because
 *    people type in runs -- a 34-character timestamp becomes a small integer.
 *
 * Only structural keys are rewritten (`p`, `x`, and the array forms of `d` and
 * `t`). Application values travel untouched, so a user string that happens to
 * look like a timestamp is never mangled.
 *
 * The result then goes through DEFLATE. `src/protocol/compress.js` handles
 * that; `bench/scenarios/bandwidth.js` measures each stage separately.
 */

import { ProtocolError } from '#core/errors';
import { TIMESTAMP_LEN, ZERO_TIMESTAMP, parseTimestamp, encodeTimestamp } from '#core/hlc';
import { validateOp } from '#core/op';

export const CODEC_VERSION = 2;

/* -------------------------------------------------------------- run-length */

/**
 * Collapse runs into [value, count] pairs, but only when that actually helps.
 * A column of distinct values is left alone rather than padded with counts.
 * @param {Array<number>} values
 * @returns {{ r: Array<any> }|Array<number>}
 */
function rle(values) {
  const runs = [];
  for (const v of values) {
    const last = runs.at(-1);
    if (last && last[0] === v) last[1]++;
    else runs.push([v, 1]);
  }
  // Each run costs two slots; only worth it if runs are shorter than half.
  if (runs.length * 2 >= values.length) return values;
  return { r: runs.map(([v, n]) => (n === 1 ? v : [v, n])) };
}

/** @returns {Array<number>} */
function unrle(encoded, expected) {
  if (Array.isArray(encoded)) return encoded;
  if (!encoded || !Array.isArray(encoded.r)) throw new ProtocolError('malformed column', { encoded });
  const out = [];
  for (const item of encoded.r) {
    if (Array.isArray(item)) for (let i = 0; i < item[1]; i++) out.push(item[0]);
    else out.push(item);
  }
  if (expected !== undefined && out.length !== expected) {
    throw new ProtocolError('column length mismatch', { got: out.length, expected });
  }
  return out;
}

/* ---------------------------------------------------------- string interning */

class Dictionary {
  #index = new Map();
  #values = [];
  /** @returns {number} */
  intern(value) {
    let i = this.#index.get(value);
    if (i === undefined) {
      i = this.#values.length;
      this.#index.set(value, i);
      this.#values.push(value);
    }
    return i;
  }
  get values() { return this.#values; }
}

/* ------------------------------------------------------- payload references */

/** Structural payload keys holding a single timestamp. */
const TS_KEYS = ['p', 'x'];
/**
 * Reserved back-reference for the sequence root -- the anchor every insert at
 * position zero carries. Worth its own code: it is 34 characters that appear
 * at the start of every new text field and every list built front-to-back.
 */
const ROOT_REF = -1;
/** Structural payload keys holding a list of timestamps. */
const TS_LIST_KEYS = ['d', 't'];

/**
 * Rewrite timestamps that name operations inside this batch as integer indices.
 * `d` is only treated as a list when it actually is one -- the PN-counter uses
 * the same key for its numeric delta.
 */
function packPayload(payload, tsIndex) {
  let out = payload;
  const copy = () => (out === payload ? (out = { ...payload }) : out);

  for (const key of TS_KEYS) {
    const ts = payload[key];
    if (typeof ts !== 'string' || ts.length !== TIMESTAMP_LEN) continue;
    if (ts === ZERO_TIMESTAMP) { copy()[key] = ROOT_REF; continue; }
    const ref = tsIndex.get(ts);
    if (ref !== undefined) copy()[key] = ref;
  }
  for (const key of TS_LIST_KEYS) {
    const list = payload[key];
    if (!Array.isArray(list) || list.length === 0) continue;
    let hit = false;
    const packed = list.map((ts) => {
      const ref = typeof ts === 'string' ? tsIndex.get(ts) : undefined;
      if (ref === undefined) return ts;
      hit = true;
      return ref;
    });
    if (hit) copy()[key] = packed;
  }
  return out;
}

/** @param {string[]} timestamps resolved timestamps of this batch, by index */
function unpackPayload(payload, timestamps) {
  let out = payload;
  const copy = () => (out === payload ? (out = { ...payload }) : out);
  const resolve = (ref) => {
    if (ref === ROOT_REF) return ZERO_TIMESTAMP;
    const ts = timestamps[ref];
    if (ts === undefined) throw new ProtocolError('back-reference out of range', { ref });
    return ts;
  };

  for (const key of TS_KEYS) {
    if (typeof payload[key] === 'number') copy()[key] = resolve(payload[key]);
  }
  for (const key of TS_LIST_KEYS) {
    const list = payload[key];
    if (!Array.isArray(list)) continue;
    if (list.some((v) => typeof v === 'number')) {
      copy()[key] = list.map((v) => (typeof v === 'number' ? resolve(v) : v));
    }
  }
  return out;
}

/* -------------------------------------------------------------------- encode */

/**
 * @param {Array<import('#core/op').Op>} ops
 * @returns {object} a compact, JSON-serialisable batch
 */
export function encodeOps(ops) {
  if (ops.length === 0) return { v: CODEC_VERSION, n: 0 };

  const nodes = new Dictionary();
  const collections = new Dictionary();
  const docs = new Dictionary();
  const fields = new Dictionary();

  const nodeCol = [], seqCol = [], wallCol = [], counterCol = [];
  const colCol = [], docCol = [], fieldCol = [], payloads = [];

  /** timestamp -> index within this batch, for back-references */
  const tsIndex = new Map();
  /** last seq seen per node, so seq can be delta-encoded per replica */
  const lastSeq = new Map();

  let base = Infinity;
  for (const op of ops) base = Math.min(base, parseTimestamp(op.ts).wall);

  ops.forEach((op, i) => {
    const ts = parseTimestamp(op.ts);
    if (ts.node !== op.node) {
      // The whole timestamp-shortening trick rests on this holding.
      throw new ProtocolError('operation timestamp does not match its issuing replica', {
        op: `${op.node}:${op.seq}`, tsNode: ts.node,
      });
    }

    const nodeIdx = nodes.intern(op.node);
    nodeCol.push(nodeIdx);
    // First operation from a replica carries its absolute sequence number;
    // the rest are deltas, which are almost always exactly 1.
    seqCol.push(lastSeq.has(nodeIdx) ? op.seq - lastSeq.get(nodeIdx) : op.seq);
    lastSeq.set(nodeIdx, op.seq);

    wallCol.push(ts.wall - base);
    counterCol.push(ts.counter);
    colCol.push(collections.intern(op.collection));
    docCol.push(docs.intern(op.doc));
    fieldCol.push(fields.intern(op.field));

    // Pack against operations already emitted, then register this one so later
    // operations in the batch can point back at it.
    payloads.push(packPayload(op.payload, tsIndex));
    tsIndex.set(op.ts, i);
  });

  return {
    v: CODEC_VERSION,
    n: ops.length,
    b: base,
    N: nodes.values, C: collections.values, D: docs.values, F: fields.values,
    ni: rle(nodeCol), sq: rle(seqCol), wl: rle(wallCol), ct: rle(counterCol),
    ci: rle(colCol), di: rle(docCol), fi: rle(fieldCol),
    p: payloads,
  };
}

/* -------------------------------------------------------------------- decode */

/**
 * @param {object} batch
 * @param {{ validate?: boolean }} [opts] validation is on by default; the
 *   server must never skip it for client-supplied data.
 * @returns {Array<import('#core/op').Op>}
 */
export function decodeOps(batch, { validate = true } = {}) {
  if (!batch || typeof batch !== 'object') throw new ProtocolError('batch must be an object', { batch });
  if (batch.v !== CODEC_VERSION) {
    throw new ProtocolError('unsupported codec version', { got: batch.v, expected: CODEC_VERSION });
  }
  const count = batch.n ?? 0;
  if (count === 0) return [];

  const { N: nodes = [], C: cols = [], D: docs = [], F: fields = [], b: base } = batch;
  if (!Number.isFinite(base)) throw new ProtocolError('batch is missing its timestamp base', { base });

  const nodeCol = unrle(batch.ni, count);
  const seqCol = unrle(batch.sq, count);
  const wallCol = unrle(batch.wl, count);
  const counterCol = unrle(batch.ct, count);
  const colCol = unrle(batch.ci, count);
  const docCol = unrle(batch.di, count);
  const fieldCol = unrle(batch.fi, count);
  const payloads = batch.p ?? [];
  if (payloads.length !== count) {
    throw new ProtocolError('payload count mismatch', { got: payloads.length, expected: count });
  }

  const pick = (table, i, what) => {
    const v = table[i];
    if (v === undefined) throw new ProtocolError(`${what} index out of range`, { index: i, size: table.length });
    return v;
  };

  const lastSeq = new Map();
  /** Resolved timestamps, filled as we go so back-references can be looked up. */
  const timestamps = new Array(count);
  const out = new Array(count);

  for (let i = 0; i < count; i++) {
    const nodeIdx = nodeCol[i];
    const node = pick(nodes, nodeIdx, 'node');
    const seq = lastSeq.has(nodeIdx) ? lastSeq.get(nodeIdx) + seqCol[i] : seqCol[i];
    lastSeq.set(nodeIdx, seq);

    const ts = encodeTimestamp(base + wallCol[i], counterCol[i], node);
    timestamps[i] = ts;

    const op = {
      node, seq, ts,
      collection: pick(cols, colCol[i], 'collection'),
      doc: pick(docs, docCol[i], 'doc'),
      field: pick(fields, fieldCol[i], 'field'),
      payload: unpackPayload(payloads[i], timestamps),
    };
    out[i] = validate ? validateOp(op) : op;
  }
  return out;
}

/** Plain JSON of the same operations, for the bandwidth comparison baseline. */
export function encodeOpsPlain(ops) { return ops; }

/**
 * Byte counts for each stage of the pipeline, used by the benchmarks and the
 * evaluation section. Reported honestly: `plain` is the same operations as
 * ordinary JSON, which is what a naive implementation would put on the wire.
 */
export function measure(ops) {
  const plain = JSON.stringify(ops).length;
  const packed = JSON.stringify(encodeOps(ops)).length;
  return {
    ops: ops.length,
    plainBytes: plain,
    packedBytes: packed,
    packedRatio: plain === 0 ? 1 : packed / plain,
    bytesPerOp: ops.length === 0 ? 0 : packed / ops.length,
  };
}

/** The first seq this decoder expects per node -- used when resuming a stream. */
export function firstSeqs(batch) {
  const out = new Map();
  if (!batch?.n) return out;
  const nodeCol = unrle(batch.ni, batch.n);
  const seqCol = unrle(batch.sq, batch.n);
  const lastSeq = new Map();
  for (let i = 0; i < batch.n; i++) {
    const idx = nodeCol[i];
    const seq = lastSeq.has(idx) ? lastSeq.get(idx) + seqCol[i] : seqCol[i];
    lastSeq.set(idx, seq);
    if (!out.has(batch.N[idx])) out.set(batch.N[idx], seq);
  }
  return out;
}
