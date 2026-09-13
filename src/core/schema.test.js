import test from 'node:test';
import assert from 'node:assert/strict';
import { defineSchema, CollectionSchema, DELETED_FIELD } from '#core/schema';
import { ValidationError } from '#core/errors';

test('aliases resolve to their underlying CRDT type', () => {
  const schema = defineSchema({
    notes: {
      body: 'text', label: 'string', count: 'number',
      flag: 'boolean', blob: 'json', raw: 'seq',
    },
  });
  const notes = schema.collection('notes');
  assert.equal(notes.field('body').type, 'seq');
  assert.equal(notes.field('body').asText, true, 'text renders as a string');
  assert.equal(notes.field('raw').asText, false, 'a plain sequence renders as a list');
  for (const f of ['label', 'count', 'flag', 'blob']) {
    assert.equal(notes.field(f).type, 'lww');
    assert.equal(notes.field(f).asText, false);
  }
});

test('the deletion tombstone is added to every collection', () => {
  const schema = defineSchema({ notes: { title: 'lww' } });
  const notes = schema.collection('notes');
  assert.equal(notes.field(DELETED_FIELD).type, 'lww');
  assert.ok(notes.has(DELETED_FIELD));
  assert.deepEqual(notes.userFields.map((f) => f.name), ['title'],
    'but it is not presented as a user field');
});

test('field definitions may carry a default', () => {
  const schema = defineSchema({ notes: { status: { type: 'lww', default: 'draft' } } });
  assert.equal(schema.collection('notes').field('status').defaultValue, 'draft');
});

test('unknown types, collections and fields fail loudly and helpfully', () => {
  assert.throws(() => defineSchema({ n: { f: 'blob-store' } }), (err) => {
    assert.ok(err instanceof ValidationError);
    assert.match(err.message, /unknown field type/);
    // The message has to say what *is* valid, or the author has to read source.
    assert.ok(err.details.valid.includes('lww'));
    assert.ok(err.details.valid.includes('text'));
    return true;
  });

  const schema = defineSchema({ notes: { title: 'lww' } });
  assert.throws(() => schema.collection('nope'), /unknown collection/);
  assert.throws(() => schema.collection('notes').field('nope'), /unknown field/);
  assert.throws(() => new CollectionSchema('', {}), /needs a name/);
  assert.throws(() => defineSchema({ n: { __secret: 'lww' } }), /reserved/);
});

test('fingerprints ignore declaration order but catch every real change', () => {
  const base = defineSchema({ notes: { a: 'lww', b: 'set' }, tags: { c: 'counter' } });
  assert.equal(base.fingerprint,
    defineSchema({ tags: { c: 'counter' }, notes: { b: 'set', a: 'lww' } }).fingerprint);

  // Each of these would change how operations are interpreted, so each must
  // be detected at connect time rather than surfacing as a silent no-op.
  for (const changed of [
    { notes: { a: 'lww', b: 'set' } },                            // collection removed
    { notes: { a: 'lww' }, tags: { c: 'counter' } },              // field removed
    { notes: { a: 'lww', b: 'set', d: 'lww' }, tags: { c: 'counter' } }, // field added
    { notes: { a: 'text', b: 'set' }, tags: { c: 'counter' } },   // type changed
    { notes: { a: 'lww', b: 'set' }, labels: { c: 'counter' } },  // renamed
  ]) {
    assert.notEqual(base.fingerprint, defineSchema(changed).fingerprint,
      `undetected schema change: ${JSON.stringify(changed)}`);
  }
});

test('a schema serialises back to its declared form', () => {
  const schema = defineSchema({ notes: { body: 'text', tags: 'set' } });
  const json = schema.toJSON();
  assert.equal(json.notes.body, 'text', 'the alias survives, not the underlying type');
  assert.equal(json.notes.tags, 'set');
  assert.ok(DELETED_FIELD in json.notes);
  assert.deepEqual(schema.names, ['notes']);
  assert.equal(schema.has('notes'), true);
  assert.equal(schema.has('nope'), false);
});
