import test from 'node:test';
import assert from 'node:assert/strict';
import { RGA } from '#core/crdt/rga';
import { Replica, replicas, assertConverged } from '../../../test/helpers/crdt-laws.js';
import { shuffled, makeRng } from '#core/util';

const text = (c) => c.text;

/** Type `str` at visible index `at`, returning the ops it produced. */
function type(rep, at, str) {
  const ops = [];
  let after = rep.crdt.idAtIndex(at - 1);
  for (const ch of str) {
    const op = rep.emit(() => RGA.insertOp(ch, after));
    after = op.meta.ts;
    ops.push(op);
  }
  return ops;
}

/** Delete `count` characters starting at visible index `at`. */
function erase(rep, at, count) {
  const ids = rep.crdt.ids().slice(at, at + count);
  return ids.map((id) => rep.emit(() => RGA.deleteOp(id)));
}

function sync(...reps) {
  for (const a of reps) for (const b of reps) {
    if (a !== b) for (const op of a.sent ?? []) b.receive(op);
  }
}

test('local typing and deleting reads back as plain text', () => {
  const [a] = replicas(1, () => new RGA());
  type(a, 0, 'hello world');
  assert.equal(a.crdt.text, 'hello world');
  erase(a, 5, 6);
  assert.equal(a.crdt.text, 'hello');
  assert.equal(a.crdt.length, 5);
  assert.equal(a.crdt.size, 5);
  assert.equal(a.crdt.isEmpty, false);
  assert.equal(a.crdt.physicalLength, 11, 'deleted characters remain as tombstones');

  const empty = new RGA();
  assert.equal(empty.size, 0);
  assert.equal(empty.isEmpty, true);
});

test('concurrent typing at the same spot interleaves deterministically', () => {
  const [a, b] = replicas(2, () => new RGA());
  const seed = type(a, 0, 'AB');
  for (const op of seed) b.receive(op);
  assert.equal(b.crdt.text, 'AB');

  // Both insert between A and B without seeing each other.
  const fromA = type(a, 1, 'xx');
  const fromB = type(b, 1, 'yy');
  for (const op of fromB) a.receive(op);
  for (const op of fromA) b.receive(op);

  const merged = assertConverged([a, b], text);
  assert.ok(merged === 'AxxyyB' || merged === 'AyyxxB',
    `concurrent runs must not interleave character-by-character, got ${merged}`);
  assert.equal(merged.length, 6, 'no characters lost or duplicated');
});

test('concurrent edits converge under every delivery permutation', () => {
  const rng = makeRng(99);
  const [a, b, c] = replicas(3, () => new RGA());
  const base = type(a, 0, 'the quick fox');
  for (const op of base) { b.receive(op); c.receive(op); }

  const edits = [
    ...type(b, 10, 'brown '),
    ...erase(c, 0, 4),            // c drops "the ", leaving 9 visible chars
    ...type(c, 9, ' jumps'),
  ];

  for (const observer of [a, b, c]) {
    for (const op of shuffled(rng, edits)) {
      if (op.meta.node !== observer.node) observer.receive(op);
    }
  }
  assertConverged([a, b, c], text);
});

test('an insert whose neighbour has not arrived waits, then lands correctly', () => {
  const [author, peer] = replicas(2, () => new RGA());
  const ops = type(author, 0, 'abcdef');

  // Deliver strictly backwards: every insert arrives before its neighbour.
  for (const op of [...ops].reverse()) peer.receive(op);

  assert.equal(peer.crdt.pendingCount, 0, 'every buffered op must eventually replay');
  assert.equal(peer.crdt.text, 'abcdef');
});

test('a delete that outruns its insert still takes effect', () => {
  const [author, peer] = replicas(2, () => new RGA());
  const inserts = type(author, 0, 'xyz');
  const del = erase(author, 1, 1)[0];

  peer.receive(del);                       // target does not exist yet
  assert.equal(peer.crdt.text, '');
  for (const op of inserts) peer.receive(op);

  assert.equal(peer.crdt.text, 'xz', 'the late insert must arrive already deleted');
  assert.equal(author.crdt.text, 'xz');
});

test('concurrent deletes of the same character are safe', () => {
  const [a, b] = replicas(2, () => new RGA());
  for (const op of type(a, 0, 'hello')) b.receive(op);

  const da = erase(a, 0, 1);
  const db = erase(b, 0, 1);
  for (const op of db) a.receive(op);
  for (const op of da) b.receive(op);

  assert.equal(assertConverged([a, b], text), 'ello');
});

test('deleting everything leaves an empty, still-usable sequence', () => {
  const [a, b] = replicas(2, () => new RGA());
  for (const op of type(a, 0, 'abc')) b.receive(op);
  for (const op of erase(a, 0, 3)) b.receive(op);
  assert.equal(assertConverged([a, b], text), '');

  for (const op of type(a, 0, 'new')) b.receive(op);
  assert.equal(assertConverged([a, b], text), 'new');
});

test('state snapshots round-trip and merge to the same document', () => {
  const [a, b] = replicas(2, () => new RGA());
  for (const op of type(a, 0, 'shared')) b.receive(op);
  type(a, 6, '-left');
  type(b, 0, 'right-');

  const revivedA = RGA.fromJSON(JSON.parse(JSON.stringify(a.crdt)));
  assert.equal(revivedA.text, a.crdt.text, 'serialisation must preserve order');

  const m1 = RGA.fromJSON(JSON.parse(JSON.stringify(a.crdt)));
  m1.merge(b.crdt);
  const m2 = RGA.fromJSON(JSON.parse(JSON.stringify(b.crdt)));
  m2.merge(a.crdt);
  assert.equal(m1.text, m2.text, 'merge order must not matter');
  assert.equal(m1.length, 'shared'.length + '-left'.length + 'right-'.length);
});

test('gc reclaims stable tombstones and rebases operations that still name them', () => {
  const [a, b] = replicas(2, () => new RGA());
  for (const op of type(a, 0, 'hello world')) b.receive(op);
  const deletes = erase(a, 5, 6);
  for (const op of deletes) b.receive(op);
  assert.equal(a.crdt.text, 'hello');
  assert.equal(a.crdt.stats.tombstones, 6);

  // b composes an insert anchored on a character a is about to collect.
  const anchoredOnTombstone = b.emit(() => RGA.insertOp('!', deletes.at(-1).payload.x));

  const stable = deletes.at(-1).meta.ts;
  assert.equal(a.crdt.gc(stable), 6, 'all six tombstones are collectable');
  assert.equal(a.crdt.stats.tombstones, 0);
  assert.equal(a.crdt.text, 'hello', 'visible text is unaffected by collection');

  a.receive(anchoredOnTombstone);
  assert.equal(assertConverged([a, b], text), 'hello!',
    'a redirect must rebase the op onto the surviving predecessor');

  assert.equal(a.crdt.dropRedirects(), 6, 'one redirect per collected tombstone');
});

test('a document assembled from shuffled ops matches one built in order', () => {
  const rng = makeRng(2024);
  const [author] = replicas(1, () => new RGA());
  const ops = type(author, 0, 'the rain in spain');
  erase(author, 3, 5).forEach((op) => ops.push(op));

  for (let trial = 0; trial < 25; trial++) {
    const observer = new Replica('obs', () => new RGA());
    for (const op of shuffled(rng, ops)) observer.receive(op);
    assert.equal(observer.crdt.pendingCount, 0);
    assert.equal(observer.crdt.text, author.crdt.text, `trial ${trial}`);
  }
});
