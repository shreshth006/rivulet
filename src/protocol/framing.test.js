import test from 'node:test';
import assert from 'node:assert/strict';
import { packMessage, unpackMessage, Encoding, negotiateEncoding, ByteMeter } from '#protocol/framing';
import {
  sync, ack, hello, welcome, event, errorMessage,
  validateMessage, safeParseMessage, readVector, assertSchemaMatch, MessageType, PROTOCOL_VERSION,
  isHelloMessage, isWelcomeMessage, isSyncMessage, isAckMessage, isEventMessage, isErrorMessage,
} from '#protocol/messages';

import { encodeOps } from '#protocol/codec';
import { ProtocolError, ValidationError } from '#core/errors';
import { VersionVector } from '#core/version-vector';
import { makeDb } from '../../test/helpers/fixtures.js';
import { nodeIdFromLabel } from '#core/ids';

const NODE = nodeIdFromLabel('client');

test('a small frame is sent uncompressed', async () => {
  const frame = await packMessage(sync({ node: NODE, room: 'r1', have: {} }));
  assert.equal(frame.encoding, Encoding.JSON);
  assert.equal(frame.wireBytes, frame.rawBytes);
  assert.ok(frame.wireBytes < 120, `an idle sync should be tiny, got ${frame.wireBytes}B`);
});

test('a large frame is compressed, and round-trips', async () => {
  const db = makeDb('a');
  const id = db.mutate((tx) => tx.create('notes', { body: '' })).result;
  const { ops } = db.mutate((tx) => tx.setText('notes', id, 'body', 'the quick brown fox. '.repeat(40)));

  const message = sync({ node: NODE, room: 'r1', have: {}, push: encodeOps(ops) });
  const frame = await packMessage(message);

  assert.equal(frame.encoding, Encoding.DEFLATE);
  assert.ok(frame.wireBytes < frame.rawBytes * 0.5,
    `DEFLATE should halve the columnar batch, got ${frame.wireBytes}/${frame.rawBytes}`);
  assert.deepEqual(await unpackMessage(frame.bytes, frame.encoding), message);
});

test('compression is skipped when it would not help', async () => {
  // High-entropy content: DEFLATE cannot shrink it, so the raw form must win.
  const noise = Array.from({ length: 400 }, (_, i) => ((i * 2654435761) >>> 0).toString(36)).join('');
  const frame = await packMessage({ t: 'x', noise });
  assert.ok(frame.wireBytes <= frame.rawBytes, 'never send more bytes than the raw form');
});

test('compression can be disabled outright', async () => {
  const big = { t: 'x', pad: 'a'.repeat(5000) };
  const off = await packMessage(big, { compress: false });
  const on = await packMessage(big);
  assert.equal(off.encoding, Encoding.JSON);
  assert.equal(on.encoding, Encoding.DEFLATE);
  assert.ok(on.wireBytes < off.wireBytes / 10);
});

test('corrupt frames fail with a protocol error, not a crash', async () => {
  await assert.rejects(() => unpackMessage(new Uint8Array([1, 2, 3]), Encoding.DEFLATE), ProtocolError);
  await assert.rejects(() => unpackMessage(new TextEncoder().encode('{nope')), /not valid JSON/);
  await assert.rejects(() => unpackMessage(new Uint8Array(), 'br'), /unsupported content encoding/);
});

test('encoding negotiation falls back to plain JSON', () => {
  assert.equal(negotiateEncoding([Encoding.DEFLATE]), Encoding.DEFLATE);
  assert.equal(negotiateEncoding([]), Encoding.JSON);
  assert.equal(negotiateEncoding(['br']), Encoding.JSON);
});

test('the byte meter reports what a session actually cost', async () => {
  const meter = new ByteMeter();
  meter.recordSend(await packMessage({ t: 'a', pad: 'x'.repeat(2000) }));
  meter.recordReceive(await packMessage({ t: 'b', pad: 'y'.repeat(2000) }));

  const s = meter.summary;
  assert.equal(s.sentFrames, 1);
  assert.equal(s.recvFrames, 1);
  assert.equal(s.totalFrames, 2);
  assert.ok(s.totalWire < s.sentRaw + s.recvRaw);
  assert.ok(s.compressionRatio < 0.2);
  assert.ok(s.savedBytes > 0);
  assert.equal(s.savedBytes, meter.savedBytes);
  assert.ok(s.savedPercentage > 75);
  meter.reset();
  assert.equal(meter.summary.totalWire, 0);
  assert.equal(meter.savedBytes, 0);
});


test('messages carry their protocol version and validate', () => {
  const h = hello({ node: NODE, room: 'r1', schema: 'fp', compression: [Encoding.DEFLATE] });
  assert.equal(h.pv, PROTOCOL_VERSION);
  assert.equal(validateMessage(h, MessageType.HELLO), h);

  const w = welcome({ node: nodeIdFromLabel('server'), room: 'r1', have: new VersionVector({ [NODE]: 4 }) });
  assert.deepEqual(w.have, { [NODE]: 4 });
  assert.equal(readVector(w).get(NODE), 4);

  const a = ack({ node: NODE, accepted: 3, duplicates: 1, have: new VersionVector() });
  assert.equal(a.ok, 3);
  assert.equal(a.dup, 1);
  assert.equal(a.more, false);
});

test('invalid messages are rejected at the edge', () => {
  assert.throws(() => validateMessage(null), /must be an object/);
  assert.throws(() => validateMessage({}), /missing its type/);
  assert.throws(() => validateMessage({ t: 'nope' }), /unknown message type/);
  assert.throws(() => validateMessage({ t: 'sync', pv: 99 }), /unsupported protocol version/);
  assert.throws(() => validateMessage(sync({ node: NODE, room: 'r' }), MessageType.ACK), /unexpected message type/);
  assert.throws(() => validateMessage({ t: 'sync', node: 'bad', room: 'r' }), /malformed node id/);
  assert.throws(() => validateMessage({ t: 'sync', node: NODE }), /missing a room/);
  assert.throws(() => validateMessage({ t: 'sync', node: NODE, room: 'r', have: 7 }), /version vector/);
  assert.throws(() => validateMessage({ t: 'sync', node: NODE, room: 'r', limit: 0 }), /positive integer/);
  assert.throws(() => readVector({ have: { bad: 'x' } }), /malformed version vector/);
});

test('a schema mismatch is reported clearly', () => {
  assertSchemaMatch('fp', 'fp');
  assertSchemaMatch('fp', undefined);
  assert.throws(() => assertSchemaMatch('fp-a', 'fp-b'), ValidationError);
});

test('message type guards identify protocol messages accurately', () => {
  const h = hello({ node: NODE, room: 'r1' });
  const w = welcome({ node: NODE, room: 'r1' });
  const s = sync({ node: NODE, room: 'r1', have: {} });
  const a = ack({ node: NODE });
  const ev = event({ node: NODE });
  const err = errorMessage('BAD', 'something broke');

  assert.equal(isHelloMessage(h), true);
  assert.equal(isHelloMessage(s), false);

  assert.equal(isWelcomeMessage(w), true);
  assert.equal(isWelcomeMessage(h), false);

  assert.equal(isSyncMessage(s), true);
  assert.equal(isSyncMessage(a), false);

  assert.equal(isAckMessage(a), true);
  assert.equal(isAckMessage(s), false);

  assert.equal(isEventMessage(ev), true);
  assert.equal(isEventMessage(w), false);

  assert.equal(isErrorMessage(err), true);
  assert.equal(isErrorMessage(null), false);
  assert.equal(isErrorMessage(undefined), false);
  assert.equal(isErrorMessage('hello'), false);
});

test('safeParseMessage validates messages safely without throwing', () => {
  const json = JSON.stringify(sync({ node: NODE, room: 'r1', have: {} }));
  const parsed = safeParseMessage(json, MessageType.SYNC);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.t, MessageType.SYNC);
  assert.equal(parsed.error, null);

  const badJson = safeParseMessage('{malformed json', MessageType.SYNC);
  assert.equal(badJson.ok, false);
  assert.equal(badJson.value, null);
  assert.ok(badJson.error);

  const typeMismatch = safeParseMessage(json, MessageType.ACK);
  assert.equal(typeMismatch.ok, false);
  assert.equal(typeMismatch.value, null);
  assert.ok(typeMismatch.error instanceof ProtocolError);
});


