import test from 'node:test';
import assert from 'node:assert/strict';
import { diffText, textEdit } from '#core/text-diff';
import { RGA } from '#core/crdt/rga';
import { HybridClock } from '#core/hlc';
import { nodeIdFromLabel } from '#core/ids';

/** Apply a diff to confirm it actually reconstructs the target. */
function applyDiff(before, change) {
  if (!change) return before;
  return before.slice(0, change.index)
    + change.inserted
    + before.slice(change.index + change.removed);
}

test('an unchanged string produces no edit at all', () => {
  assert.equal(diffText('', ''), null);
  assert.equal(diffText('hello', 'hello'), null);
});

test('single-character edits cost exactly one character', () => {
  assert.deepEqual(diffText('helo', 'hello'), { index: 3, removed: 0, inserted: 'l' });
  assert.deepEqual(diffText('hello', 'helo'), { index: 3, removed: 1, inserted: '' });
  assert.deepEqual(diffText('hello', 'hallo'), { index: 1, removed: 1, inserted: 'a' });
});

test('edits at the very start and end are handled', () => {
  assert.deepEqual(diffText('bc', 'abc'), { index: 0, removed: 0, inserted: 'a' });
  assert.deepEqual(diffText('ab', 'abc'), { index: 2, removed: 0, inserted: 'c' });
  assert.deepEqual(diffText('abc', ''), { index: 0, removed: 3, inserted: '' });
  assert.deepEqual(diffText('', 'abc'), { index: 0, removed: 0, inserted: 'abc' });
});

test('repeated characters do not confuse the prefix and suffix scan', () => {
  // The overlapping prefix/suffix is the classic place this goes wrong:
  // naive independent scans would double-count the shared run.
  for (const [before, after] of [
    ['aaa', 'aa'], ['aa', 'aaa'], ['aaaa', 'aa'], ['', 'aaa'],
    ['abab', 'abababab'], ['xxxx', 'xxyxx'], ['aaa', 'bbb'],
  ]) {
    const change = diffText(before, after);
    assert.equal(applyDiff(before, change), after,
      `diff of ${JSON.stringify(before)} -> ${JSON.stringify(after)} must reconstruct`);
    assert.ok(change.removed >= 0);
  }
});

test('a paragraph insert costs only the inserted characters', () => {
  const before = 'The wifi is down. '.repeat(20);
  const after = `${before.slice(0, 200)}INSERTED${before.slice(200)}`;
  const change = diffText(before, after);
  assert.equal(change.inserted, 'INSERTED');
  assert.equal(change.removed, 0);
  assert.equal(applyDiff(before, change), after);
});

test('textEdit resolves identities and anchors on a surviving character', () => {
  const clock = new HybridClock({ node: nodeIdFromLabel('a') });
  const rga = RGA.from([...'hello'], clock);
  const ids = rga.ids();

  const insert = textEdit(rga, 'hello!');
  assert.deepEqual(insert.deleteIds, []);
  assert.equal(insert.insert, '!');
  assert.equal(insert.insertAfter, ids[4]);

  const replace = textEdit(rga, 'heXlo');
  assert.deepEqual(replace.deleteIds, [ids[2]]);
  assert.equal(replace.insert, 'X');
  // Anchored on 'e', not on the 'l' being removed -- an insert hanging off a
  // tombstone still converges but drifts from where the caret actually was.
  assert.equal(replace.insertAfter, ids[1]);

  assert.equal(textEdit(rga, 'hello'), null);
});

test('an edit at position zero has no anchor', () => {
  const clock = new HybridClock({ node: nodeIdFromLabel('a') });
  const rga = RGA.from([...'world'], clock);
  const edit = textEdit(rga, 'Xworld');
  assert.equal(edit.insertAfter, undefined, 'the sequence root is the anchor');
  assert.equal(edit.insert, 'X');
});

test('clearing the text deletes every identity', () => {
  const clock = new HybridClock({ node: nodeIdFromLabel('a') });
  const rga = RGA.from([...'abc'], clock);
  const edit = textEdit(rga, '');
  assert.deepEqual(edit.deleteIds, rga.ids());
  assert.equal(edit.insert, '');
});
