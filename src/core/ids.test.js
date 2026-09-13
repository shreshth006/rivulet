import test from 'node:test';
import assert from 'node:assert/strict';
import { newNodeId, isNodeId, assertNodeId, nodeIdFromLabel, shortId, newDocId, NODE_ID_LEN } from '#core/ids';
import { ValidationError } from '#core/errors';

test('minted replica ids are well-formed and unique', () => {
  const ids = Array.from({ length: 500 }, newNodeId);
  for (const id of ids) {
    assert.equal(id.length, NODE_ID_LEN);
    assert.ok(isNodeId(id), `${id} should be a valid node id`);
  }
  assert.equal(new Set(ids).size, 500);
});

test('validation rejects anything that is not exactly the right shape', () => {
  for (const bad of [
    '', 'xyz', 'A1B2C3D4E5F60718',          // upper case is not the encoding
    '0123456789abcde',                       // too short
    '0123456789abcdef0',                     // too long
    '0123456789abcdeg',                      // not hex
    null, undefined, 42, {}, ['0'.repeat(16)],
  ]) {
    assert.equal(isNodeId(bad), false, `${JSON.stringify(bad)} must be rejected`);
    assert.throws(() => assertNodeId(bad), ValidationError);
  }
  assert.equal(assertNodeId('0'.repeat(16)), '0'.repeat(16));
});

test('labelled ids are deterministic, valid, and distinct', () => {
  assert.equal(nodeIdFromLabel('alice'), nodeIdFromLabel('alice'));
  assert.notEqual(nodeIdFromLabel('alice'), nodeIdFromLabel('bob'));
  assert.ok(isNodeId(nodeIdFromLabel('alice')));
  // Near-identical labels must not collide: benchmarks name replicas r0, r1, …
  const ids = new Set(Array.from({ length: 300 }, (_, i) => nodeIdFromLabel(`client-${i}`)));
  assert.equal(ids.size, 300);
  assert.ok(isNodeId(nodeIdFromLabel('')));
});

test('document ids are unique and URL-safe', () => {
  const ids = Array.from({ length: 500 }, newDocId);
  assert.equal(new Set(ids).size, 500);
  for (const id of ids) assert.match(id, /^[0-9a-f]+$/);
  assert.equal(encodeURIComponent(ids[0]), ids[0]);
});

test('shortId is safe on anything', () => {
  assert.equal(shortId('0123456789abcdef'), '012345');
  assert.equal(shortId(undefined), 'undefined');
  assert.equal(shortId(42), '42');
});
