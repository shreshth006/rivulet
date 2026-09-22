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

/**
 * The four transformations, individually switchable.
 *
 * Production always runs with all four on. They are separable so the
 * evaluation can measure each one's actual contribution by ablation rather
 * than asserting a split -- and so a regression in any one of them shows up as
 * a number rather than a vague loss of efficiency.
 *
 * A batch records any non-default choice in its `o` field, so a decoder never
 * has to be told which variant it is reading.
 */
export const DEFAULT_OPTIONS = Object.freeze({
  intern: true,    // dictionary-encode collection, document and field names
  deltas: true,    // delta-encode sequence numbers and wall-clock times
  backrefs: true,  // replace in-batch timestamp references with indices
  rle: true,       // run-length encode the columns
});

/** Pack the option set into the compact `o` field, or omit it when default. */
function optionField(opts) {
  const diff = {};
  for (const [k, v] of Object.entries(DEFAULT_OPTIONS)) {
    if (opts[k] !== v) diff[k[0]] = opts[k] ? 1 : 0;
  }
  return Object.keys(diff).length ? diff : undefined;
}

/** Recover the option set a batch was encoded with. */
function readOptions(batch) {
  const o = batch.o;
  if (!o) return DEFAULT_OPTIONS;
  return {
    intern: o.i === undefined ? DEFAULT_OPTIONS.intern : !!o.i,
    deltas: o.d === undefined ? DEFAULT_OPTIONS.deltas : !!o.d,
    backrefs: o.b === undefined ? DEFAULT_OPTIONS.backrefs : !!o.b,
    rle: o.r === undefined ? DEFAULT_OPTIONS.rle : !!o.r,
  };
}

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
 * @param {Partial<typeof DEFAULT_OPTIONS>} [options] ablation switches; see
 *   {@link DEFAULT_OPTIONS}. Production leaves this alone.
 * @returns {object} a compact, JSON-serialisable batch
 */
export function encodeOps(ops, options) {
  const opts = options ? { ...DEFAULT_OPTIONS, ...options } : DEFAULT_OPTIONS;
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

  const maybeRle = opts.rle ? rle : (col) => col;
  const intern = (dict, value) => (opts.intern ? dict.intern(value) : value);

  let base = 0;
  if (opts.deltas) {
    base = Infinity;
    for (const op of ops) base = Math.min(base, parseTimestamp(op.ts).wall);
  }

  ops.forEach((op, i) => {
    const ts = parseTimestamp(op.ts);
    if (ts.node !== op.node) {
      // The whole timestamp-shortening trick rests on this holding.
      throw new ProtocolError('operation timestamp does not match its issuing replica', {
        op: `${op.node}:${op.seq}`, tsNode: ts.node,
      });
    }

    const nodeIdx = intern(nodes, op.node);
    nodeCol.push(nodeIdx);
    // First operation from a replica carries its absolute sequence number;
    // the rest are deltas, which are almost always exactly 1.
    if (opts.deltas) {
      seqCol.push(lastSeq.has(op.node) ? op.seq - lastSeq.get(op.node) : op.seq);
      lastSeq.set(op.node, op.seq);
    } else {
      seqCol.push(op.seq);
    }

    wallCol.push(ts.wall - base);
    counterCol.push(ts.counter);
    colCol.push(intern(collections, op.collection));
    docCol.push(intern(docs, op.doc));
    fieldCol.push(intern(fields, op.field));

    // Pack against operations already emitted, then register this one so later
    // operations in the batch can point back at it.
    payloads.push(opts.backrefs ? packPayload(op.payload, tsIndex) : op.payload);
    tsIndex.set(op.ts, i);
  });

  const batch = {
    v: CODEC_VERSION,
    n: ops.length,
    b: base,
    ni: maybeRle(nodeCol), sq: maybeRle(seqCol), wl: maybeRle(wallCol), ct: maybeRle(counterCol),
    ci: maybeRle(colCol), di: maybeRle(docCol), fi: maybeRle(fieldCol),
    p: payloads,
  };
  if (opts.intern) {
    batch.N = nodes.values; batch.C = collections.values;
    batch.D = docs.values; batch.F = fields.values;
  }
  const o = optionField(opts);
  if (o) batch.o = o;
  return batch;
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

  const opts = readOptions(batch);
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

  // Without interning the column holds the value itself rather than an index.
  const pick = (table, i, what) => {
    if (!opts.intern) return i;
    const v = table[i];
    if (v === undefined) throw new ProtocolError(`${what} index out of range`, { index: i, size: table.length });
    return v;
  };

  const lastSeq = new Map();
  /** Resolved timestamps, filled as we go so back-references can be looked up. */
  const timestamps = new Array(count);
  const out = new Array(count);

  for (let i = 0; i < count; i++) {
    const node = pick(nodes, nodeCol[i], 'node');
    let seq;
    if (opts.deltas) {
      seq = lastSeq.has(node) ? lastSeq.get(node) + seqCol[i] : seqCol[i];
      lastSeq.set(node, seq);
    } else {
      seq = seqCol[i];
    }

    const ts = encodeTimestamp(base + wallCol[i], counterCol[i], node);
    timestamps[i] = ts;

    const op = {
      node, seq, ts,
      collection: pick(cols, colCol[i], 'collection'),
      doc: pick(docs, docCol[i], 'doc'),
      field: pick(fields, fieldCol[i], 'field'),
      payload: opts.backrefs ? unpackPayload(payloads[i], timestamps) : payloads[i],
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
export function measure(ops, options) {
  const plain = JSON.stringify(ops).length;
  const packed = JSON.stringify(encodeOps(ops, options)).length;
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
  const opts = readOptions(batch);
  const nodeCol = unrle(batch.ni, batch.n);
  const seqCol = unrle(batch.sq, batch.n);
  const lastSeq = new Map();
  for (let i = 0; i < batch.n; i++) {
    const node = opts.intern ? batch.N[nodeCol[i]] : nodeCol[i];
    let seq;
    if (opts.deltas) {
      seq = lastSeq.has(node) ? lastSeq.get(node) + seqCol[i] : seqCol[i];
      lastSeq.set(node, seq);
    } else seq = seqCol[i];
    if (!out.has(node)) out.set(node, seq);
  }
  return out;
}

/**
 * Inspect an encoded batch structure and return summary statistics.
 * @param {object} batch
 * @returns {{ count: number, version: number, nodes: string[], collections: string[], options: object }}
 */
export function batchStats(batch) {
  if (!batch || typeof batch !== 'object') {
    throw new ProtocolError('invalid batch object', { batch });
  }
  const opts = readOptions(batch);
  const count = batch.n ?? 0;
  const nodes = Array.isArray(batch.N) ? [...batch.N] : [];
  const collections = Array.isArray(batch.C) ? [...batch.C] : [];
  return {
    count,
    version: batch.v ?? 1,
    nodes,
    collections,
    options: opts,
  };
}

