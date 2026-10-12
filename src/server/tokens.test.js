import test from 'node:test';
import assert from 'node:assert/strict';
import { issueRoomToken, verifyRoomToken, roomTokens, roomMatches } from '#server/tokens';
import { AuthError, ValidationError } from '#core/errors';

const SECRET = 'a-test-secret-of-adequate-length';

test('a token round-trips its claims', () => {
  const token = issueRoomToken(SECRET, { room: 'notebook', scope: 'read', node: 'abc', ttlSeconds: 60, now: 1_000_000 });
  assert.deepEqual(verifyRoomToken(SECRET, token, { now: 1_000_000 }),
    { room: 'notebook', scope: 'read', node: 'abc', expires: 1_060 });
});

test('a token signed with another secret, or altered, is refused', () => {
  const token = issueRoomToken(SECRET, { room: 'notebook' });
  assert.throws(() => verifyRoomToken('another-secret-entirely-here', token), /signature/);

  // Swap in claims for a different room but keep the original signature.
  const [prefix, , sig] = token.split('.');
  const forged = `${prefix}.${Buffer.from('{"r":"*","s":"admin"}').toString('base64url')}.${sig}`;
  assert.throws(() => verifyRoomToken(SECRET, forged), AuthError);
  assert.throws(() => verifyRoomToken(SECRET, 'not-a-token'), /malformed/);
  assert.throws(() => verifyRoomToken(SECRET, undefined), /malformed/);
});

test('an expired token is refused', () => {
  const token = issueRoomToken(SECRET, { room: 'r', ttlSeconds: 10, now: 0 });
  assert.ok(verifyRoomToken(SECRET, token, { now: 9_999 }));
  assert.throws(() => verifyRoomToken(SECRET, token, { now: 10_000 }), /expired/);
});

test('weak secrets and bad claims are rejected at issue time', () => {
  assert.throws(() => issueRoomToken('short', { room: 'r' }), ValidationError);
  assert.throws(() => issueRoomToken(SECRET, { room: '' }), ValidationError);
  assert.throws(() => issueRoomToken(SECRET, { room: 'r', scope: 'root' }), ValidationError);
  assert.throws(() => roomTokens('short'), ValidationError);
});

test('room patterns match exactly, by prefix, or everything', () => {
  assert.ok(roomMatches('notebook', 'notebook'));
  assert.ok(!roomMatches('notebook', 'notebook-2'));
  assert.ok(roomMatches('team-42/*', 'team-42/notes'));
  assert.ok(!roomMatches('team-42/*', 'team-43/notes'));
  assert.ok(roomMatches('*', 'anything'));
});

test('the authorizer enforces room, scope and replica binding', () => {
  const authorize = roomTokens(SECRET);
  const ctx = (claims, extra) => ({ credential: issueRoomToken(SECRET, claims), ...extra });

  assert.ok(authorize(ctx({ room: 'n', scope: 'read' }, { action: 'sync', room: 'n', writes: false })));
  assert.throws(() => authorize(ctx({ room: 'n', scope: 'read' }, { action: 'sync', room: 'n', writes: true })), /read-only/);
  assert.ok(authorize(ctx({ room: 'n', scope: 'write' }, { action: 'sync', room: 'n', writes: true })));
  assert.throws(() => authorize(ctx({ room: 'n' }, { action: 'sync', room: 'other' })), /does not cover/);

  assert.throws(() => authorize(ctx({ room: 'n', scope: 'write' }, { action: 'inspect', room: 'n' })), /write-only/);
  assert.ok(authorize(ctx({ room: 'n', scope: 'admin' }, { action: 'inspect', room: 'n' })));
  // Inspecting without a room lists every room, so only `*` will do.
  assert.throws(() => authorize(ctx({ room: 'n', scope: 'admin' }, { action: 'inspect', room: null })), /does not cover/);
  assert.ok(authorize(ctx({ room: '*', scope: 'admin' }, { action: 'inspect', room: null })));

  assert.ok(authorize(ctx({ room: 'n', node: 'me' }, { action: 'sync', room: 'n', node: 'me' })));
  assert.throws(() => authorize(ctx({ room: 'n', node: 'me' }, { action: 'sync', room: 'n', node: 'you' })), /different replica/);
  assert.throws(() => authorize({ action: 'sync', room: 'n' }), /required/);
});
