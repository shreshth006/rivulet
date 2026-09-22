import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, notebookSchema, deliver } from '../../test/helpers/fixtures.js';
import { defineSchema } from '#core/schema';
import { ValidationError } from '#core/errors';

test('a write is readable immediately, with no round trip', () => {
  const db = makeDb('a');
  const { ops, result: id } = db.mutate((tx) => tx.create('notes', {
    title: 'Hostel wifi notes', body: 'it drops', tags: ['infra'], pinned: true,
  }));

  assert.equal(db.get('notes', id).title, 'Hostel wifi notes');
  assert.equal(db.get('notes', id).body, 'it drops');
  assert.deepEqual(db.get('notes', id).tags, ['infra']);
  assert.equal(db.get('notes', id).reads, 0, 'unwritten counter reads as zero');
  assert.ok(ops.length > 0, 'the transaction must yield ops for the outbox');
  assert.ok(ops.every((op) => op.seq >= 1 && op.node === db.node));
});

test('sequence numbers are dense and strictly increasing', () => {
  const db = makeDb('a');
  db.mutate((tx) => tx.create('notes', { title: 'one' }));
  db.mutate((tx) => tx.create('notes', { title: 'two' }));
  const seqs = [];
  db.on('local-ops', ({ ops }) => seqs.push(...ops.map((o) => o.seq)));
  db.mutate((tx) => tx.create('notes', { title: 'three' }));
  assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => db.seq - seqs.length + i + 1));
});

test('concurrent edits to different fields all survive', () => {
  const a = makeDb('a'), b = makeDb('b'), c = makeDb('c');
  const seed = a.mutate((tx) => tx.create('notes', { title: 'draft', body: 'hello', tags: [] }));
  deliver(seed.ops, b, c);
  const id = seed.result;

  // Three replicas, three fields, no contact between them.
  const fromA = a.mutate((tx) => tx.set('notes', id, 'title', 'final'));
  const fromB = b.mutate((tx) => tx.add('notes', id, 'tags', 'urgent'));
  const fromC = c.mutate((tx) => tx.increment('notes', id, 'reads', 3));

  deliver(fromA.ops, b, c);
  deliver(fromB.ops, a, c);
  deliver(fromC.ops, a, b);

  for (const db of [a, b, c]) {
    const note = db.get('notes', id);
    assert.equal(note.title, 'final', `${db.label} lost the rename`);
    assert.deepEqual(note.tags, ['urgent'], `${db.label} lost the tag`);
    assert.equal(note.reads, 3, `${db.label} lost the counter`);
  }
});

test('concurrent typing in one body merges character by character', () => {
  const a = makeDb('a'), b = makeDb('b');
  const seed = a.mutate((tx) => tx.create('notes', { title: 't', body: 'The wifi is down.' }));
  deliver(seed.ops, b);
  const id = seed.result;

  // Each edits a different part of the sentence while offline.
  const fromA = a.mutate((tx) => tx.setText('notes', id, 'body', 'The hostel wifi is down.'));
  const fromB = b.mutate((tx) => tx.setText('notes', id, 'body', 'The wifi is down again.'));

  deliver(fromA.ops, b);
  deliver(fromB.ops, a);

  const merged = a.get('notes', id).body;
  assert.equal(merged, b.get('notes', id).body, 'replicas must agree');
  assert.ok(merged.includes('hostel'), 'A\'s insertion survived');
  assert.ok(merged.includes('again'), 'B\'s insertion survived');
  assert.ok(fromA.ops.length <= 8, `a 7-char insert should cost ~7 ops, got ${fromA.ops.length}`);
});

test('setText sends only the characters that changed', () => {
  const db = makeDb('a');
  const id = db.mutate((tx) => tx.create('notes', { body: 'a'.repeat(500) })).result;
  const { ops } = db.mutate((tx) => tx.setText('notes', id, 'body', 'a'.repeat(250) + 'X' + 'a'.repeat(250)));
  assert.equal(ops.length, 1, 'inserting one character must cost exactly one op');
  assert.equal(db.get('notes', id).body.length, 501);
});

test('delete is a tombstone that still merges, and can be undone', () => {
  const a = makeDb('a'), b = makeDb('b');
  const seed = a.mutate((tx) => tx.create('notes', { title: 'temp' }));
  deliver(seed.ops, b);
  const id = seed.result;

  const del = a.mutate((tx) => tx.delete('notes', id));
  assert.equal(a.get('notes', id), null);
  assert.equal(a.list('notes').length, 0);
  assert.equal(a.list('notes', { includeDeleted: true }).length, 1);

  deliver(del.ops, b);
  assert.equal(b.get('notes', id), null);

  const undo = b.mutate((tx) => tx.restore('notes', id));
  deliver(undo.ops, a);
  assert.equal(a.get('notes', id).title, 'temp', 'restore must bring the content back');
});

test('a delete racing an edit resolves by timestamp on both replicas', () => {
  const a = makeDb('a'), b = makeDb('b');
  const seed = a.mutate((tx) => tx.create('notes', { title: 'contested' }));
  deliver(seed.ops, b);
  const id = seed.result;

  b.advance(50); // b's delete happens later in real time
  const edit = a.mutate((tx) => tx.set('notes', id, 'title', 'edited'));
  const del = b.mutate((tx) => tx.delete('notes', id));

  deliver(edit.ops, b);
  deliver(del.ops, a);
  assert.equal(a.get('notes', id), b.get('notes', id));
  assert.equal(a.get('notes', id), null, 'the later delete wins');
  assert.equal(a.get('notes', id, { includeDeleted: true }).title, 'edited',
    'the edit is not destroyed, just hidden behind the tombstone');
});

test('multi-value fields surface a conflict for review', () => {
  const a = makeDb('a'), b = makeDb('b');
  const seed = a.mutate((tx) => tx.create('notes', { title: 'quote' }));
  deliver(seed.ops, b);
  const id = seed.result;

  deliver(a.mutate((tx) => tx.set('notes', id, 'estimate', 1200)).ops, b);
  deliver(b.mutate((tx) => tx.set('notes', id, 'estimate', 1500)).ops, a);
  // Now both write concurrently.
  const ca = a.mutate((tx) => tx.set('notes', id, 'estimate', 900));
  const cb = b.mutate((tx) => tx.set('notes', id, 'estimate', 950));
  deliver(ca.ops, b); deliver(cb.ops, a);

  const conflicts = a.conflicts('notes');
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].fields[0].values.sort(), [900, 950]);
  assert.deepEqual(a.conflicts(), b.conflicts());

  // Resolving is an ordinary write, made after seeing both.
  deliver(a.mutate((tx) => tx.set('notes', id, 'estimate', 925)).ops, b);
  assert.equal(b.conflicts('notes').length, 0);
  assert.equal(b.get('notes', id).estimate, 925);
});

test('update() reconciles whole objects against every field type', () => {
  const db = makeDb('a');
  const id = db.mutate((tx) => tx.create('notes', {
    title: 'v1', body: 'abc', tags: ['x', 'y'], reads: 5,
  })).result;

  db.mutate((tx) => tx.update('notes', id, {
    title: 'v2', body: 'abcd', tags: ['y', 'z'], reads: 9,
  }));

  const note = db.get('notes', id);
  assert.equal(note.title, 'v2');
  assert.equal(note.body, 'abcd');
  assert.deepEqual(note.tags.sort(), ['y', 'z'], 'x removed, z added, y untouched');
  assert.equal(note.reads, 9, 'counter target set by emitting the delta');
});

test('list() filters, sorts and paginates', () => {
  const db = makeDb('a');
  for (const n of [3, 1, 2, 5, 4]) db.mutate((tx) => tx.create('notes', { title: `n${n}`, reads: n }));
  const top = db.list('notes', {
    where: (v) => v.reads > 1,
    sort: (x, y) => y.reads - x.reads,
    limit: 2,
  });
  assert.deepEqual(top.map((v) => v.title), ['n5', 'n4']);
  assert.equal(db.count('notes'), 5);
  assert.equal(db.list('notes', { offset: 4 }).length, 1);
});

test('snapshots round-trip and merge without discarding local writes', () => {
  const a = makeDb('a'), b = makeDb('b');
  const id = a.mutate((tx) => tx.create('notes', { title: 'shared', body: 'hello', tags: ['t'] })).result;

  // b has its own unsynced write when the snapshot arrives.
  b.mutate((tx) => tx.create('notes', { title: 'local-only' }));
  const merged = b.loadSnapshot(a.snapshot());

  assert.ok(merged > 0);
  assert.equal(b.get('notes', id).title, 'shared');
  assert.equal(b.get('notes', id).body, 'hello');
  assert.equal(b.list('notes').length, 2, 'the local-only note must survive the bootstrap');
});

test('snapshots refuse to load across a schema change', () => {
  const a = makeDb('a');
  const other = makeDb('b', { schema: defineSchema({ notes: { title: 'lww' } }) });
  assert.throws(() => other.loadSnapshot(a.snapshot()), /schema does not match/);
  assert.throws(() => a.loadSnapshot({ v: 99 }), /unsupported snapshot version/);
});

test('operations for unknown collections and fields are ignored, not fatal', () => {
  const db = makeDb('a');
  const id = db.mutate((tx) => tx.create('notes', { title: 'x' })).result;
  const [sample] = db.mutate((tx) => tx.set('notes', id, 'title', 'y')).ops;

  assert.equal(db.apply({ ...sample, collection: 'gone' }), false);
  assert.equal(db.apply({ ...sample, field: 'removedField' }), false);
  assert.equal(db.get('notes', id).title, 'y', 'state is untouched');
});

test('the API rejects type-mismatched operations at the call site', () => {
  const db = makeDb('a');
  const id = db.mutate((tx) => tx.create('notes', { title: 'x' })).result;
  assert.throws(() => db.mutate((tx) => tx.increment('notes', id, 'title', 1)), ValidationError);
  assert.throws(() => db.mutate((tx) => tx.add('notes', id, 'title', 'v')), ValidationError);
  assert.throws(() => db.mutate((tx) => tx.setText('notes', id, 'title', 'v')), /does not match the field type/);
  assert.throws(() => db.mutate((tx) => tx.setText('notes', id, 'checklist', 'v')), /not declared as text/);
  assert.throws(() => db.mutate((tx) => tx.set('notes', id, 'nope', 1)), /unknown field/);
  assert.throws(() => db.list('nope'), /unknown collection/);
  assert.throws(() => defineSchema({ x: { f: 'blob' } }), /unknown field type/);
});

test('non-text sequence fields splice as ordered lists', () => {
  const a = makeDb('a'), b = makeDb('b');
  const seed = a.mutate((tx) => tx.create('notes', { title: 'shopping' }));
  deliver(seed.ops, b);
  const id = seed.result;

  deliver(a.mutate((tx) => tx.splice('notes', id, 'checklist', 0, 0, ['rice', 'dal'])).ops, b);
  assert.deepEqual(b.get('notes', id).checklist, ['rice', 'dal']);

  // Concurrent: a appends, b removes the first item.
  const fromA = a.mutate((tx) => tx.splice('notes', id, 'checklist', 2, 0, ['oil']));
  const fromB = b.mutate((tx) => tx.splice('notes', id, 'checklist', 0, 1));
  deliver(fromA.ops, b); deliver(fromB.ops, a);

  assert.deepEqual(a.get('notes', id).checklist, b.get('notes', id).checklist);
  assert.deepEqual(a.get('notes', id).checklist, ['dal', 'oil']);
});

test('a committed transaction cannot be reused', () => {
  const db = makeDb('a');
  const tx = db.transaction();
  tx.create('notes', { title: 'x' });
  tx.commit();
  assert.throws(() => tx.commit(), /already committed/);
  assert.throws(() => tx.create('notes', { title: 'y' }), /already committed/);
});

test('schema fingerprints are stable and detect drift', () => {
  assert.equal(notebookSchema.fingerprint, notebookSchema.fingerprint);
  assert.notEqual(
    defineSchema({ notes: { a: 'lww' } }).fingerprint,
    defineSchema({ notes: { a: 'text' } }).fingerprint,
  );
  assert.equal(
    defineSchema({ n: { a: 'lww', b: 'set' } }).fingerprint,
    defineSchema({ n: { b: 'set', a: 'lww' } }).fingerprint,
    'declaration order must not change the fingerprint',
  );
});

test('an untouched field reads the same as an emptied one, on every replica', () => {
  const a = makeDb('a'), b = makeDb('b');
  // `body` is never written: the create emits no operation for an empty text
  // field, so b never materialises the CRDT at all while a does.
  const seed = a.mutate((tx) => tx.create('notes', { title: 'no body', body: '' }));
  deliver(seed.ops, b);
  const id = seed.result;

  assert.equal(a.get('notes', id).body, '', 'text reads as a string');
  assert.deepEqual(a.get('notes', id), b.get('notes', id),
    'identical state must render identically regardless of local history');

  // The same must hold for the other empty forms.
  assert.deepEqual(b.get('notes', id).tags, []);
  assert.deepEqual(b.get('notes', id).checklist, []);
  assert.equal(b.get('notes', id).reads, 0);
  assert.equal(b.get('notes', id).estimate, null);

  // And an emptied field must match a never-written one.
  deliver(a.mutate((tx) => tx.setText('notes', id, 'body', 'x')).ops, b);
  deliver(a.mutate((tx) => tx.setText('notes', id, 'body', '')).ops, b);
  assert.equal(a.get('notes', id).body, '');
  assert.deepEqual(a.get('notes', id), b.get('notes', id));
});

test('exists checks document presence and deletion status', () => {
  const db = makeDb('a');
  assert.equal(db.exists('notes', 'missing'), false);

  const id = db.mutate((tx) => tx.create('notes', { title: 'check' })).result;
  assert.equal(db.exists('notes', id), true);

  db.mutate((tx) => tx.delete('notes', id));
  assert.equal(db.exists('notes', id), false);

  db.mutate((tx) => tx.restore('notes', id));
  assert.equal(db.exists('notes', id), true);
});

test('find and list support function predicates and object filters', () => {
  const db = makeDb('a');
  const id1 = db.mutate((tx) => tx.create('notes', { title: 'First', tags: ['infra', 'urgent'], pinned: true })).result;
  const id2 = db.mutate((tx) => tx.create('notes', { title: 'Second', tags: ['infra'], pinned: false })).result;
  const id3 = db.mutate((tx) => tx.create('notes', { title: 'Third', tags: ['todo'], pinned: false })).result;

  // Object filter matching primitive and array membership
  assert.equal(db.find('notes', { title: 'Second' })?.id, id2);
  assert.equal(db.find('notes', { tags: 'urgent' })?.id, id1);
  assert.equal(db.find('notes', { title: 'Nonexistent' }), null);

  const pinned = db.list('notes', { where: { pinned: true } });
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].id, id1);

  const infra = db.list('notes', { where: { tags: 'infra' } });
  assert.equal(infra.length, 2);

  // Function predicate
  const custom = db.find('notes', (doc) => doc.title.startsWith('Th'));
  assert.equal(custom?.id, id3);
});

test('query filters support comparison and logical operators', () => {
  const db = makeDb('a');
  const id1 = db.mutate((tx) => tx.create('notes', { title: 'Note A', reads: 10, pinned: true })).result;
  const id2 = db.mutate((tx) => tx.create('notes', { title: 'Note B', reads: 25, pinned: false })).result;
  const id3 = db.mutate((tx) => tx.create('notes', { title: 'Note C', reads: 50, pinned: true })).result;

  // $gt and $lt
  const mid = db.list('notes', { where: { reads: { $gt: 10, $lt: 50 } } });
  assert.equal(mid.length, 1);
  assert.equal(mid[0].id, id2);

  // $gte and $lte
  const allExceptOne = db.list('notes', { where: { reads: { $gte: 25 } } });
  assert.equal(allExceptOne.length, 2);

  // $ne
  const notA = db.list('notes', { where: { title: { $ne: 'Note A' } } });
  assert.equal(notA.length, 2);

  // $in and $nin
  const inList = db.list('notes', { where: { reads: { $in: [10, 50] } } });
  assert.equal(inList.length, 2);

  const notInList = db.list('notes', { where: { reads: { $nin: [10, 50] } } });
  assert.equal(notInList.length, 1);
  assert.equal(notInList[0].id, id2);

  // $regex
  const matchesRegex = db.list('notes', { where: { title: { $regex: /^Note [BC]$/ } } });
  assert.equal(matchesRegex.length, 2);
});

test('query supports field projection with select option', () => {
  const db = makeDb('a');
  const id = db.mutate((tx) => tx.create('notes', {
    title: 'Projected Note', body: 'Very long text content that we may not need', tags: ['infra'], reads: 42,
  })).result;

  const projected = db.find('notes', { id }, { select: ['title', 'reads'] });
  assert.equal(projected.id, id);
  assert.equal(projected.title, 'Projected Note');
  assert.equal(projected.reads, 42);
  assert.equal(projected.body, undefined);
  assert.equal(projected.tags, undefined);

  const listProjected = db.list('notes', { select: ['title'] });
  assert.equal(listProjected.length, 1);
  assert.deepEqual(listProjected[0], { id, title: 'Projected Note' });
});

test('query list supports string and object sorting specs', () => {
  const db = makeDb('a');
  db.mutate((tx) => tx.create('notes', { title: 'Zebra', reads: 10 }));
  db.mutate((tx) => tx.create('notes', { title: 'Apple', reads: 30 }));
  db.mutate((tx) => tx.create('notes', { title: 'Mango', reads: 20 }));

  // Ascending string sort
  const asc = db.list('notes', { sort: 'title' });
  assert.deepEqual(asc.map((n) => n.title), ['Apple', 'Mango', 'Zebra']);

  // Descending string sort with '-'
  const desc = db.list('notes', { sort: '-title' });
  assert.deepEqual(desc.map((n) => n.title), ['Zebra', 'Mango', 'Apple']);

  // Object sort
  const byReadsDesc = db.list('notes', { sort: { reads: -1 } });
  assert.deepEqual(byReadsDesc.map((n) => n.reads), [30, 20, 10]);
});
