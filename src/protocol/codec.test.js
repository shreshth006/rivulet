import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeOps, decodeOps, measure, firstSeqs, CODEC_VERSION } from '#protocol/codec';
import { ProtocolError } from '#core/errors';
import { ZERO_TIMESTAMP, encodeTimestamp } from '#core/hlc';
import { makeDb, deliver } from '../../test/helpers/fixtures.js';
import { makeRng, randInt, pick } from '#core/util';

/** Generate a mixed, realistic batch touching every CRDT type. */
function mixedBatch(seed = 5, { notes = 3, edits = 12 } = {}) {
  const rng = makeRng(seed);
  const db = makeDb('author');
  const ids = [];
  const ops = [];
  for (let i = 0; i < notes; i++) {
    const r = db.mutate((tx) => tx.create('notes', { title: `note ${i}`, body: 'seed text', tags: ['a'] }));
    ids.push(r.result);
    ops.push(...r.ops);
  }
  for (let i = 0; i < edits; i++) {
    const id = pick(rng, ids);
    const r = db.mutate((tx) => {
      switch (randInt(rng, 0, 4)) {
        case 0: return tx.set('notes', id, 'title', `retitled ${i}`);
        case 1: return tx.setText('notes', id, 'body', `${db.get('notes', id).body} word${i}`);
        case 2: return tx.add('notes', id, 'tags', `t${i}`);
        case 3: return tx.increment('notes', id, 'reads', randInt(rng, 1, 4));
        default: return tx.set('notes', id, 'estimate', randInt(rng, 1, 999));
      }
    });
    ops.push(...r.ops);
  }
  return { db, ops, ids };
}

test('every operation kind survives a round trip byte for byte', () => {
  const { ops } = mixedBatch(11);
  assert.ok(ops.length > 40, 'fixture should produce a substantial batch');
  const decoded = decodeOps(encodeOps(ops));
  assert.deepEqual(decoded, ops);
});

test('decoded operations rebuild an identical database', () => {
  const { db, ops } = mixedBatch(12);
  const replica = makeDb('replica');
  replica.applyAll(decodeOps(encodeOps(ops)));
  assert.deepEqual(replica.list('notes'), db.list('notes'));
});

test('an empty batch encodes and decodes cleanly', () => {
  const encoded = encodeOps([]);
  assert.deepEqual(decodeOps(encoded), []);
  assert.ok(JSON.stringify(encoded).length < 25);
});

test('interning, deltas and back-references cut a typing burst by ~85%', () => {
  const db = makeDb('a');
  const id = db.mutate((tx) => tx.create('notes', { title: 'perf', body: '' })).result;
  const { ops } = db.mutate((tx) =>
    tx.setText('notes', id, 'body', 'The hostel wifi drops every evening around nine.'));

  const m = measure(ops);
  assert.ok(m.packedRatio < 0.16,
    `expected >84% reduction on a typing burst, got ${(100 - m.packedRatio * 100).toFixed(1)}%`);
  assert.ok(m.bytesPerOp < 30, `expected <30 bytes per keystroke, got ${m.bytesPerOp.toFixed(1)}`);
});

test('a chained insert run costs a back-reference, not a timestamp', () => {
  const db = makeDb('a');
  const id = db.mutate((tx) => tx.create('notes', { body: '' })).result;
  const { ops } = db.mutate((tx) => tx.setText('notes', id, 'body', 'abcdef'));

  const encoded = encodeOps(ops);
  const parents = encoded.p.map((payload) => payload.p);
  assert.equal(parents[0], -1, 'first insert anchors on the sequence root');
  assert.deepEqual(parents.slice(1), [0, 1, 2, 3, 4], 'the rest chain by index');
  assert.ok(!JSON.stringify(encoded.p).includes(ZERO_TIMESTAMP),
    'no full root timestamp should survive encoding');
});

test('references to operations outside the batch stay literal', () => {
  const a = makeDb('a'), b = makeDb('b');
  const seed = a.mutate((tx) => tx.create('notes', { body: 'hello' }));
  deliver(seed.ops, b);
  const id = seed.result;

  // b deletes characters a created: the targets are not in b's batch.
  const { ops } = b.mutate((tx) => tx.setText('notes', id, 'body', 'ho'));
  const encoded = encodeOps(ops);
  assert.ok(encoded.p.some((p) => typeof p.x === 'string'),
    'an out-of-batch target must be sent in full');
  assert.deepEqual(decodeOps(encoded), ops);
});

test('user data that looks like a timestamp is never rewritten', () => {
  const db = makeDb('a');
  const lookalike = encodeTimestamp(12345, 6, 'ffffffffffffffff');
  const { ops } = db.mutate((tx) => tx.create('notes', { title: lookalike, tags: [lookalike] }));
  const decoded = decodeOps(encodeOps(ops));
  assert.deepEqual(decoded, ops);
  assert.equal(decoded.find((o) => o.field === 'title').payload.v, lookalike);
});

test('columns run-length encode only when it saves space', () => {
  const { ops } = mixedBatch(13, { notes: 1, edits: 30 });
  const encoded = encodeOps(ops);
  assert.ok(!Array.isArray(encoded.ci), 'one collection everywhere must collapse to a run');
  assert.ok(!Array.isArray(encoded.ni), 'one author everywhere must collapse to a run');
  assert.deepEqual(decodeOps(encoded), ops);
});

test('multi-replica batches keep each sequence stream separate', () => {
  const a = makeDb('a'), b = makeDb('b'), c = makeDb('c');
  const seed = a.mutate((tx) => tx.create('notes', { title: 'shared' }));
  deliver(seed.ops, b, c);
  const id = seed.result;

  const ops = [
    ...seed.ops,
    ...b.mutate((tx) => tx.add('notes', id, 'tags', 'from-b')).ops,
    ...c.mutate((tx) => tx.increment('notes', id, 'reads', 2)).ops,
    ...a.mutate((tx) => tx.set('notes', id, 'title', 'renamed')).ops,
  ];
  assert.deepEqual(decodeOps(encodeOps(ops)), ops);

  const firsts = firstSeqs(encodeOps(ops));
  assert.equal(firsts.get(a.node), 1);
  assert.equal(firsts.get(b.node), b.seq);
});

test('a batch that does not start at seq 1 still decodes', () => {
  const db = makeDb('a');
  db.mutate((tx) => tx.create('notes', { title: 'first' }));
  const { ops } = db.mutate((tx) => tx.create('notes', { title: 'second' }));
  assert.ok(ops[0].seq > 1);
  assert.deepEqual(decodeOps(encodeOps(ops)), ops);
});

test('malformed batches are rejected with a protocol error', () => {
  const { ops } = mixedBatch(14);
  const good = encodeOps(ops);

  assert.throws(() => decodeOps({ ...good, v: 99 }), ProtocolError);
  assert.throws(() => decodeOps(null), ProtocolError);
  assert.throws(() => decodeOps({ ...good, b: undefined }), /missing its timestamp base/);
  assert.throws(() => decodeOps({ ...good, p: [] }), /payload count mismatch/);
  assert.throws(() => decodeOps({ ...good, N: [] }), /node index out of range/);
  assert.throws(() => decodeOps({ ...good, ci: { r: null } }), /malformed column/);
  assert.throws(() => decodeOps({ ...good, n: good.n + 5 }), ProtocolError);
});

test('a back-reference past the end of the batch is rejected', () => {
  const db = makeDb('a');
  const id = db.mutate((tx) => tx.create('notes', { body: '' })).result;
  const { ops } = db.mutate((tx) => tx.setText('notes', id, 'body', 'abc'));
  const encoded = encodeOps(ops);
  encoded.p = encoded.p.map((p) => ({ ...p, p: 999 }));
  assert.throws(() => decodeOps(encoded), /back-reference out of range/);
});

test('decoding validates operations unless explicitly told not to', () => {
  const { ops } = mixedBatch(15);
  const encoded = encodeOps(ops);
  encoded.F = encoded.F.map(() => '');
  assert.throws(() => decodeOps(encoded), /field must be a non-empty string/);
  assert.equal(decodeOps(encoded, { validate: false }).length, ops.length);
});

test('the codec version is part of the encoding', () => {
  assert.equal(encodeOps([]).v, CODEC_VERSION);
  assert.equal(encodeOps(mixedBatch(16).ops).v, CODEC_VERSION);
});
