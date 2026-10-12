/**
 * @file The compact snapshot format -- the operation codec's interning,
 * applied to CRDT state.
 *
 * A snapshot is mostly identifiers. Every RGA element, every set tag, every
 * register write carries a 34-character HLC timestamp, and a document's state
 * repeats its field names once per document. Stored as plain JSON, an
 * uncollected snapshot ends up slightly *larger* than the encoded operation
 * log it is meant to replace, because the codec already strips exactly this
 * redundancy from the log.
 *
 * So the snapshot gets the same treatment:
 *
 * 1. **One timestamp table.** Every structural timestamp in the snapshot is
 *    registered once, in first-seen order, and replaced by its index. The
 *    table itself is columnar: wall-clock deltas, counters and interned node
 *    ids, each run-length encoded.
 *
 * 2. **Interned field names.** Each collection lists its field names once and
 *    stores a document's state as an array in that order.
 *
 * 3. **Columnar sequences.** An RGA is stored in document order, so its
 *    element ids are -- unless something else named them first -- consecutive
 *    table indices. Their deltas collapse to a single run of ones, and the
 *    tombstone flags beside them run-length encode just as well.
 *
 * As in the codec, only structural positions are rewritten, chosen per field
 * type from the schema. Application values travel untouched, so a user string
 * that happens to look like a timestamp is never mangled.
 *
 * The packed form expands to exactly the plain form, so nothing downstream of
 * {@link expandCollections} needs to know which one was stored.
 */

import { ZERO_TIMESTAMP, parseTimestamp, encodeTimestamp } from '#core/hlc';
import { ValidationError } from '#core/errors';

/** Reserved reference for the zero timestamp: an unwritten register, the RGA root. */
const ZERO_REF = -1;

/* -------------------------------------------------------------- run-length */

// The same scheme as the operation codec: [value, count] pairs, used only
// when runs are long enough to pay for their counts.
function rle(values) {
  const runs = [];
  for (const v of values) {
    const last = runs.at(-1);
    if (last && last[0] === v) last[1]++;
    else runs.push([v, 1]);
  }
  if (runs.length * 2 >= values.length) return values;
  return { r: runs.map(([v, n]) => (n === 1 ? v : [v, n])) };
}

function unrle(encoded, expected) {
  if (Array.isArray(encoded)) return checkLength(encoded, expected);
  if (!encoded || !Array.isArray(encoded.r)) throw new ValidationError('malformed snapshot column', { encoded });
  const out = [];
  for (const item of encoded.r) {
    if (Array.isArray(item)) for (let i = 0; i < item[1]; i++) out.push(item[0]);
    else out.push(item);
  }
  return checkLength(out, expected);
}

function checkLength(column, expected) {
  if (expected !== undefined && column.length !== expected) {
    throw new ValidationError('snapshot column length mismatch', { got: column.length, expected });
  }
  return column;
}

/* --------------------------------------------------------- timestamp table */

class TimestampTable {
  #index = new Map();
  #timestamps = [];
  #nodes = new Map();

  /** @returns {number} */
  ref(ts) {
    if (ts === ZERO_TIMESTAMP) return ZERO_REF;
    let i = this.#index.get(ts);
    if (i === undefined) {
      i = this.#timestamps.length;
      this.#index.set(ts, i);
      this.#timestamps.push(ts);
    }
    return i;
  }

  /** Node ids share the table's dictionary; counters key on them. */
  node(id) {
    let i = this.#nodes.get(id);
    if (i === undefined) { i = this.#nodes.size; this.#nodes.set(id, i); }
    return i;
  }

  toJSON() {
    const walls = [], counters = [], nodes = [];
    let prev = 0;
    for (const ts of this.#timestamps) {
      const { wall, counter, node } = parseTimestamp(ts);
      walls.push(wall - prev);
      prev = wall;
      counters.push(counter);
      nodes.push(this.node(node));
    }
    return {
      n: this.#timestamps.length,
      N: [...this.#nodes.keys()],
      w: rle(walls), c: rle(counters), i: rle(nodes),
    };
  }
}

/** Rebuild the table's timestamps and node ids from their packed columns. */
function readTable(packed) {
  if (!packed || typeof packed !== 'object') throw new ValidationError('snapshot is missing its timestamp table');
  const count = packed.n ?? 0;
  const nodes = packed.N ?? [];
  const walls = unrle(packed.w ?? [], count);
  const counters = unrle(packed.c ?? [], count);
  const nodeCol = unrle(packed.i ?? [], count);

  const timestamps = new Array(count);
  let wall = 0;
  for (let i = 0; i < count; i++) {
    wall += walls[i];
    const node = nodes[nodeCol[i]];
    if (node === undefined) throw new ValidationError('snapshot node index out of range', { index: nodeCol[i] });
    timestamps[i] = encodeTimestamp(wall, counters[i], node);
  }

  const ts = (ref) => {
    if (ref === ZERO_REF) return ZERO_TIMESTAMP;
    const t = timestamps[ref];
    if (t === undefined) throw new ValidationError('snapshot timestamp reference out of range', { ref });
    return t;
  };
  const node = (i) => {
    const n = nodes[i];
    if (n === undefined) throw new ValidationError('snapshot node index out of range', { index: i });
    return n;
  };
  return { ts, node };
}

/* ------------------------------------------------------ per-type packers */

/**
 * One packer per CRDT wire type. `pack` sees the type's plain `toJSON()` form
 * and rewrites only its timestamps and node ids; `unpack` is the exact inverse.
 */
const PACKERS = {
  lww: {
    pack: (s, t) => [t.ref(s.t), s.v ?? null],
    unpack: ([ref, v], t) => ({ t: t.ts(ref), v }),
  },

  mv: {
    pack: (s, t) => ({ e: s.e.map(([ts, v]) => [t.ref(ts), v]), s: s.s.map((ts) => t.ref(ts)) }),
    unpack: (p, t) => ({ e: p.e.map(([ref, v]) => [t.ts(ref), v]), s: p.s.map(t.ts) }),
  },

  counter: {
    pack: (s, t) => ({
      p: s.p.map(([node, v]) => [t.node(node), v]),
      n: s.n.map(([node, v]) => [t.node(node), v]),
    }),
    unpack: (p, t) => ({
      p: p.p.map(([i, v]) => [t.node(i), v]),
      n: p.n.map(([i, v]) => [t.node(i), v]),
    }),
  },

  set: {
    pack: (s, t) => ({
      l: s.l.map(([k, el, tags]) => [k, el, tags.map((ts) => t.ref(ts))]),
      r: s.r.map((ts) => t.ref(ts)),
    }),
    unpack: (p, t) => ({
      l: p.l.map(([k, el, tags]) => [k, el, tags.map(t.ts)]),
      r: p.r.map(t.ts),
    }),
  },

  seq: {
    pack(s, t) {
      const ids = [], values = [], dels = [];
      let prev = 0;
      for (const [id, v, del] of s.n) {
        const ref = t.ref(id);
        ids.push(ref - prev);
        prev = ref;
        values.push(v);
        dels.push(del ? 1 : 0);
      }
      const out = { i: rle(ids), v: values, x: rle(dels) };
      if (s.rd) out.rd = s.rd.map(([from, to]) => [t.ref(from), t.ref(to)]);
      if (s.od) out.od = s.od.map((ts) => t.ref(ts));
      return out;
    },
    unpack(p, t) {
      const values = p.v ?? [];
      const ids = unrle(p.i, values.length);
      const dels = unrle(p.x, values.length);
      const n = [];
      let ref = 0;
      for (let k = 0; k < values.length; k++) {
        ref += ids[k];
        const id = t.ts(ref);
        n.push(dels[k] ? [id, values[k], 1] : [id, values[k]]);
      }
      const out = { n };
      if (p.rd) out.rd = p.rd.map(([from, to]) => [t.ts(from), t.ts(to)]);
      if (p.od) out.od = p.od.map(t.ts);
      return out;
    },
  },
};

function packerFor(collection, field) {
  const packer = PACKERS[collection.field(field).type];
  if (!packer) throw new ValidationError('no snapshot packer for field type', { field, type: collection.field(field).type });
  return packer;
}

/* ------------------------------------------------------------- public API */

/**
 * Pack the plain `collections` map of a snapshot.
 * @param {Record<string, Record<string, Record<string, any>>>} collections
 *   collection -> document id -> field -> CRDT state, as `Document#toJSON` gives
 * @param {import('#core/schema').Schema} schema
 * @returns {{ T: object, collections: object }}
 */
export function packCollections(collections, schema) {
  const table = new TimestampTable();
  /** @type {Record<string, { f: string[], d: Record<string, any[]> }>} */
  const out = {};

  for (const [name, docs] of Object.entries(collections)) {
    const collection = schema.collection(name);
    /** @type {Map<string, number>} */
    const fieldIndex = new Map();
    const packedDocs = {};
    for (const [id, state] of Object.entries(docs)) {
      const row = [];
      for (const [field, fieldState] of Object.entries(state)) {
        let i = fieldIndex.get(field);
        if (i === undefined) { i = fieldIndex.size; fieldIndex.set(field, i); }
        while (row.length < i) row.push(null);
        row[i] = packerFor(collection, field).pack(fieldState, table);
      }
      packedDocs[id] = row;
    }
    out[name] = { f: [...fieldIndex.keys()], d: packedDocs };
  }
  // Serialised last: node ids met inside counters join the table's dictionary.
  return { T: table.toJSON(), collections: out };
}

/**
 * Exact inverse of {@link packCollections}. The schema must be the one the
 * snapshot was taken under -- check the fingerprint first.
 * @returns {Record<string, Record<string, Record<string, any>>>}
 */
export function expandCollections({ T, collections }, schema) {
  const table = readTable(T);
  const out = {};
  for (const [name, { f: fields = [], d: docs = {} }] of Object.entries(collections ?? {})) {
    if (!schema.has(name)) continue;
    const collection = schema.collection(name);
    out[name] = {};
    for (const [id, row] of Object.entries(docs)) {
      const state = {};
      row.forEach((packed, i) => {
        if (packed === null) return;
        const field = fields[i];
        if (field === undefined) throw new ValidationError('snapshot field index out of range', { index: i });
        if (!collection.has(field)) return;
        state[field] = packerFor(collection, field).unpack(packed, table);
      });
      out[name][id] = state;
    }
  }
  return out;
}
