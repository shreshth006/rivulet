import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore, hashPassword, verifyPassword, isPasswordHash } from '#server/accounts';
import { AuthError, ValidationError } from '#core/errors';
import { issueRoomToken } from '#server/tokens';

const open = () => new AccountStore({ path: ':memory:' });

test('passwords are salted scrypt hashes that verify only the right password', async () => {
  const a = await hashPassword('correct horse');
  const b = await hashPassword('correct horse');
  assert.notEqual(a, b, 'same password, different salt');
  assert.match(a, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword('correct horse', a), true);
  assert.equal(await verifyPassword('correct horsf', a), false);
  assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
});

test('usernames are unique regardless of case, and validated', async (t) => {
  const store = open();
  t.after(() => store.close());
  await store.createUser({ username: 'Asha', password: 'password-1' });
  await assert.rejects(store.createUser({ username: 'asha', password: 'password-2' }),
    (err) => err instanceof ValidationError && /taken/.test(err.message));
  await assert.rejects(store.createUser({ username: 'a b', password: 'password-2' }), ValidationError);
  await assert.rejects(store.createUser({ username: 'shortpw', password: 'short' }), ValidationError);
  await assert.rejects(store.createUser({ username: 'boss', password: 'password-2', role: 'root' }), ValidationError);
  assert.equal(store.userByName('ASHA').username, 'Asha');
});

test('login opens a session; logout, disabling and expiry close it', async (t) => {
  let now = 1_000_000;
  const store = new AccountStore({ sessionDays: 1, now: () => now });
  t.after(() => store.close());
  await store.createUser({ username: 'admin', password: 'admin-pass', role: 'admin' });
  const user = await store.createUser({ username: 'ravi', password: 'ravi-pass' });

  await assert.rejects(store.login({ username: 'ravi', password: 'wrong-pass' }), AuthError);
  await assert.rejects(store.login({ username: 'nobody', password: 'ravi-pass' }), AuthError);

  const a = await store.login({ username: 'RAVI', password: 'ravi-pass' });
  assert.equal(store.session(a.token).user.id, user.id);
  assert.equal(store.session('x'.repeat(43)), null);
  assert.ok(store.user(user.id).lastLoginAt, 'last login recorded');

  store.logout(a.sessionId);
  assert.equal(store.session(a.token), null);

  const b = await store.login({ username: 'ravi', password: 'ravi-pass' });
  store.updateUser(user.id, { disabled: true });
  assert.equal(store.session(b.token), null, 'disabling signs out at once');
  await assert.rejects(store.login({ username: 'ravi', password: 'ravi-pass' }), /disabled/);

  store.updateUser(user.id, { disabled: false });
  const c = await store.login({ username: 'ravi', password: 'ravi-pass' });
  now += 86_400_000;
  assert.equal(store.session(c.token), null, 'sessions expire');
});

test('the database refuses to lose its last active admin', async (t) => {
  const store = open();
  t.after(() => store.close());
  const root = await store.createUser({ username: 'root', password: 'root-pass', role: 'admin' });
  assert.throws(() => store.updateUser(root.id, { role: 'user' }), /last active admin/);
  assert.throws(() => store.updateUser(root.id, { disabled: true }), /last active admin/);
  assert.throws(() => store.deleteUser(root.id), /last active admin/);

  const second = await store.createUser({ username: 'second', password: 'second-pass', role: 'admin' });
  store.updateUser(root.id, { role: 'user' });
  assert.equal(store.user(root.id).role, 'user');
  assert.throws(() => store.deleteUser(second.id), /last active admin/);
});

test('notebooks: the owner is a member by trigger, sharing sets roles, deletes cascade', async (t) => {
  const store = open();
  t.after(() => store.close());
  const owner = await store.createUser({ username: 'owner', password: 'owner-pass' });
  const friend = await store.createUser({ username: 'friend', password: 'friend-pass' });

  const nb = store.createNotebook(owner, { title: '  Trip plans  ' });
  assert.equal(nb.title, 'Trip plans');
  assert.match(nb.room, /^nb-[0-9a-f]{12}$/);
  assert.equal(store.roleIn(nb.id, owner), 'owner');
  assert.equal(store.notebook(nb.id).members, 1);

  store.addMember(nb.id, 'FRIEND', 'viewer', owner);
  assert.equal(store.roleIn(nb.id, friend), 'viewer');
  store.addMember(nb.id, 'friend', 'editor', owner);
  assert.equal(store.roleIn(nb.id, friend), 'editor', 'sharing again changes the role');
  assert.deepEqual(store.notebooksOf(friend).map((n) => [n.title, n.role, n.owner]), [['Trip plans', 'editor', 'owner']]);
  assert.throws(() => store.addMember(nb.id, 'ghost', 'editor', owner), /no user called/);
  assert.throws(() => store.addMember(nb.id, 'owner', 'viewer', owner), /owner already/);
  assert.throws(() => store.removeMember(nb.id, owner.id, owner), /owner cannot be removed/);

  const rooms = store.deleteUser(owner.id, null);
  assert.deepEqual(rooms, [nb.room]);
  assert.equal(store.notebook(nb.id), null, 'the owner\'s notebooks go with them');
  assert.deepEqual(store.notebooksOf(friend), [], 'and so do the memberships');
  assert.ok(store.audit().some((e) => e.action === 'notebook.share'), 'the audit log outlives the actor');
});

test('the sync authoriser follows sessions and memberships live', async (t) => {
  const store = open();
  t.after(() => store.close());
  const admin = await store.createUser({ username: 'admin', password: 'admin-pass', role: 'admin' });
  const owner = await store.createUser({ username: 'owner', password: 'owner-pass' });
  const reader = await store.createUser({ username: 'reader', password: 'reader-pass' });
  const stranger = await store.createUser({ username: 'stranger', password: 'stranger-pass' });
  const nb = store.createNotebook(owner, { title: 'Shared' });
  store.addMember(nb.id, 'reader', 'viewer', owner);

  const secret = 's'.repeat(32);
  const authorize = store.authorizer({ roomTokenSecret: secret });
  const tokenOf = async (name) => store.syncToken((await store.login({ username: name, password: `${name}-pass` })).sessionId);
  const ctx = (credential, writes, room = nb.room, action = 'sync') => ({ credential, writes, room, action });

  const ownerToken = await tokenOf('owner');
  const readerToken = await tokenOf('reader');
  const strangerToken = await tokenOf('stranger');
  const adminToken = await tokenOf('admin');

  assert.equal(authorize(ctx(ownerToken, true)), true);
  assert.equal(authorize(ctx(readerToken, false)), true);
  assert.throws(() => authorize(ctx(readerToken, true)), /read-only/);
  assert.throws(() => authorize(ctx(strangerToken, false)), /not a member/);
  assert.equal(authorize(ctx(adminToken, true)), true, 'admins can open any notebook');
  assert.throws(() => authorize(ctx(adminToken, false, 'nb-doesnotexist')), /not a member/, '…that exists');
  assert.throws(() => authorize(ctx(ownerToken, false, null, 'inspect')), /admins/);
  assert.equal(authorize(ctx(adminToken, false, null, 'inspect')), true);

  assert.throws(() => authorize(ctx(undefined, false)), /sign in/);
  assert.throws(() => authorize(ctx(`${ownerToken.slice(0, -2)}xx`, false)), /sign in/, 'a forged signature');

  // Room tokens still work alongside, for the Android daemon and the CLI.
  assert.equal(authorize(ctx(issueRoomToken(secret, { room: 'android-*' }), true, 'android-notes')), true);

  // Changes take effect on the very next request.
  store.removeMember(nb.id, reader.id, owner);
  assert.throws(() => authorize(ctx(readerToken, false)), /not a member/);
  store.updateUser(owner.id, { disabled: true }, admin);
  assert.throws(() => authorize(ctx(ownerToken, true)), /sign in/);
  assert.ok(stranger.id && reader.id);
});

test('a password change keeps this session and ends the others', async (t) => {
  const store = open();
  t.after(() => store.close());
  const user = await store.createUser({ username: 'mira', password: 'first-pass' });
  const here = await store.login({ username: 'mira', password: 'first-pass' });
  const there = await store.login({ username: 'mira', password: 'first-pass' });

  await assert.rejects(store.changePassword(user, 'wrong-pass', 'second-pass', here.sessionId), /current password/);
  await store.changePassword(user, 'first-pass', 'second-pass', here.sessionId);
  assert.ok(store.session(here.token));
  assert.equal(store.session(there.token), null);
  await assert.rejects(store.login({ username: 'mira', password: 'first-pass' }), AuthError);
  assert.ok(await store.login({ username: 'mira', password: 'second-pass' }));
});

test('the schema is introspectable, with row counts', async (t) => {
  const store = open();
  t.after(() => store.close());
  await store.ensureUser({ username: 'admin', password: 'admin-pass', role: 'admin' });
  assert.equal((await store.ensureUser({ username: 'admin', password: 'other-pass' })).created, false);
  const objects = store.schema();
  const names = objects.map((o) => `${o.type}:${o.name}`);
  for (const expected of ['table:users', 'table:sessions', 'table:notebooks', 'table:memberships',
    'table:audit_log', 'view:user_overview', 'view:notebook_overview', 'trigger:notebook_owner_is_member',
    'trigger:keep_an_admin_on_update', 'index:memberships_by_user']) {
    assert.ok(names.includes(expected), expected);
  }
  assert.equal(objects.find((o) => o.name === 'users').rows, 1);
  assert.equal(store.counts().admins, 1);
});

test('an account can be seeded from a password hash, never seeing the plaintext', async (t) => {
  const store = open();
  t.after(() => store.close());
  const hash = await hashPassword('seeded-secret');
  assert.equal(isPasswordHash(hash), true);
  assert.equal(isPasswordHash('scrypt$1$2$3$short$short'), false);
  assert.equal(isPasswordHash('seeded-secret'), false);

  const { user, created } = await store.ensureUser({ username: 'seeded', passwordHash: hash, role: 'admin' });
  assert.equal(created, true);
  assert.equal(user.role, 'admin');
  assert.ok(await store.login({ username: 'seeded', password: 'seeded-secret' }));
  await assert.rejects(store.ensureUser({ username: 'other', passwordHash: 'plaintext-oops' }), ValidationError);

  // Server code can open a session for an account it just seeded.
  const session = store.openSession(user, { record: 'seed' });
  assert.equal(store.session(session.token).user.username, 'seeded');
  assert.ok(store.audit().some((e) => e.action === 'seed'));
});
