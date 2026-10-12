import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, deliver } from '../../test/helpers/fixtures.js';
import { packCollections, expandCollections } from '#core/snapshot';
import { ZERO_TIMESTAMP } from '#core/hlc';
import { ValidationError } from '#core/errors';

const bytes = (v) => JSON.stringify(v).length;

/**
 * Three replicas editing the same notes concurrently, so every field type ends
 * up holding the awkward cases: multi-value conflicts, counters from several
 * nodes, removed set tags, text tombstones -- and, after a partial collection,
 * RGA redirects.
 */
function busyReplica() {
  const a = makeDb('a'), b = makeDb('b'), c = makeDb('c');
  const { ops: seed, result: id } = a.mutate((tx) => tx.create('notes', {
    title: 'shared', body: 'the wifi drops at nine', tags: ['infra', 'hostel'],
    checklist: ['reset router', 'call landlord'],
  }));
  deliver(seed, b, c);

  const burst = [
    a.mutate((tx) => {
      tx.setText('notes', id, 'body', 'the wifi drops every evening at nine');
      tx.set('notes', id, 'estimate', 3);
      tx.increment('notes', id, 'reads', 2);
      tx.remove('notes', id, 'tags', 'hostel');
    }).ops,
    b.mutate((tx) => {
      tx.setText('notes', id, 'body', 'wifi drops at nine, router reset fixes it');
      tx.set('notes', id, 'estimate', 5);
      tx.increment('notes', id, 'reads', -1);
      tx.add('notes', id, 'tags', 'urgent');
      tx.splice('notes', id, 'checklist', 0, 1, ['reset router twice']);
    }).ops,
    c.mutate((tx) => {
      tx.set('notes', id, 'title', 'renamed');
      tx.increment('notes', id, 'reads', 4);
      tx.create('folders', { name: 'infra', noteIds: [id] });
    }).ops,
  ];
  for (const ops of burst) deliver(ops, a, b, c);

  // Collect below the seed's timestamp so some tombstones go and others stay.
  a.gc(seed.at(-1).ts);
  // ...then edit again, so tombstones and retired tags newer than it remain.
  a.mutate((tx) => {
    tx.setText('notes', id, 'body', 'wifi drops at nine');
    tx.remove('notes', id, 'tags', 'urgent');
  });
  return { db: a, id };
}

test('the compact form expands to exactly the plain form', () => {
  const { db } = busyReplica();
  const plain = db.snapshot({ compact: false });
  const packed = packCollections(plain.collections, db.schema);
  const expanded = expandCollections(JSON.parse(JSON.stringify(packed)), db.schema);
  assert.deepEqual(expanded, JSON.parse(JSON.stringify(plain.collections)));
});

test('a compact snapshot restores the same state as a plain one', () => {
  const { db, id } = busyReplica();
  const fromCompact = makeDb('x'), fromPlain = makeDb('y');
  fromCompact.loadSnapshot(JSON.parse(JSON.stringify(db.snapshot())));
  fromPlain.loadSnapshot(JSON.parse(JSON.stringify(db.snapshot({ compact: false }))));

  assert.deepEqual(fromCompact.get('notes', id), db.get('notes', id));
  assert.deepEqual(fromCompact.list('folders'), db.list('folders'));
  assert.deepEqual(
    fromCompact.snapshot({ compact: false }).collections,
    fromPlain.snapshot({ compact: false }).collections,
  );
  assert.ok(fromCompact.hasConflict('notes', id), 'the multi-value conflict must survive');
});

test('version-1 snapshots already on disk still load', () => {
  const { db, id } = busyReplica();
  const legacy = db.snapshot({ compact: false });
  assert.equal(legacy.v, 1);
  const restored = makeDb('z');
  restored.loadSnapshot(JSON.parse(JSON.stringify(legacy)));
  assert.deepEqual(restored.get('notes', id), db.get('notes', id));
});

test('an uncollected heavily edited document is smaller compact than plain', () => {
  const db = makeDb('editor');
  const id = db.mutate((tx) => tx.create('notes', { title: 'draft', body: '' })).result;
  let text = '';
  for (let i = 0; i < 60; i++) {
    text += 'the router is behind reception. ';
    if (text.length > 120) text = text.slice(0, 40) + text.slice(80);
    db.mutate((tx) => tx.setText('notes', id, 'body', text));
  }
  const plain = bytes(db.snapshot({ compact: false }));
  const compact = bytes(db.snapshot());
  assert.ok(compact < plain * 0.4, `expected a large saving, got ${compact} vs ${plain} bytes`);
});

test('application values that look like timestamps travel untouched', () => {
  const db = makeDb('a');
  const lookalike = db.clock.peek();
  const id = db.mutate((tx) => tx.create('notes', {
    title: lookalike, body: 'x', tags: [lookalike], checklist: [lookalike, ZERO_TIMESTAMP],
  })).result;
  const restored = makeDb('b');
  restored.loadSnapshot(JSON.parse(JSON.stringify(db.snapshot())));
  assert.deepEqual(restored.get('notes', id), db.get('notes', id));
});

test('a corrupt reference is rejected, not silently misread', () => {
  const { db } = busyReplica();
  const snap = JSON.parse(JSON.stringify(db.snapshot()));
  const [, row] = Object.entries(snap.collections.notes.d)[0];
  const title = snap.collections.notes.f.indexOf('title');
  row[title][0] = snap.T.n + 10;
  assert.throws(() => makeDb('x').loadSnapshot(snap), ValidationError);
});
