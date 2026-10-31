import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncServer } from '#server/engine';
import { HttpSyncServer } from '#server/http';
import { AccountStore } from '#server/accounts';
import { accountsApi } from '#server/accounts-api';
import { HttpTransport } from '#client/transport';
import { RivuletClient } from '#client/client';
import { MemoryAdapter } from '#storage/adapter';
import { nodeIdFromLabel } from '#core/ids';
import { notebookSchema } from '../../test/helpers/fixtures.js';

async function serve(t, { signup = true } = {}) {
  const store = new AccountStore();
  await store.ensureUser({ username: 'admin', password: 'admin-pass', role: 'admin' });
  const dropped = [];
  const engine = new SyncServer({
    storage: async (room) => new MemoryAdapter({ name: room }),
    schema: notebookSchema.fingerprint,
    authorize: store.authorizer(),
  });
  const api = accountsApi({
    store, engine, signup, loginRate: false,
    dropRoom: async (room) => { dropped.push(room); await engine.closeRoom(room); },
  });
  const server = await new HttpSyncServer({ engine, api }).listen(0);
  t.after(async () => { await server.close(); store.close(); });
  return { server, store, dropped };
}

/** A browser stand-in: remembers its session cookie between requests. */
function browser(server) {
  let cookie = '';
  const call = async (method, path, body) => {
    const response = await fetch(`${server.url}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    return { status: response.status, body: await response.json(), setCookie: set };
  };
  return {
    get: (path) => call('GET', path),
    post: (path, body = {}) => call('POST', path, body),
    patch: (path, body = {}) => call('PATCH', path, body),
    del: (path) => call('DELETE', path),
    get cookie() { return cookie; },
  };
}

async function signUp(server, username) {
  const b = browser(server);
  const res = await b.post('/api/auth/register', { username, password: `${username}-pass` });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { b, me: res.body.user, syncToken: res.body.syncToken };
}

async function replica(server, label, room, token) {
  const node = nodeIdFromLabel(label);
  return RivuletClient.open({
    schema: notebookSchema, room, node,
    storage: new MemoryAdapter({ name: label }),
    transport: new HttpTransport({ url: server.url, room, node, token }),
    sync: { pollMs: 1e9, debounceMs: 1e9 },
  });
}

test('sign up, sign in, sign out', async (t) => {
  const { server } = await serve(t);
  const b = browser(server);
  assert.deepEqual((await b.get('/api/me')).body, { user: null, signup: true });

  const reg = await b.post('/api/auth/register', { username: 'neha', password: 'neha-pass', displayName: 'Neha' });
  assert.equal(reg.status, 201);
  assert.match(reg.setCookie, /rv_session=.+; Path=\/; HttpOnly; SameSite=Lax/);
  assert.match(reg.body.syncToken, /^rvs1\.\d+\./);

  const me = await b.get('/api/me');
  assert.equal(me.body.user.username, 'neha');
  assert.equal(me.body.user.role, 'user');
  assert.equal(me.body.user.passwordHash, undefined, 'no hash ever leaves the server');
  const notebooks = (await b.get('/api/notebooks')).body.notebooks;
  assert.deepEqual(notebooks.map((n) => [n.title, n.role]), [['My notebook', 'owner']], 'a first notebook comes with the account');

  assert.equal((await b.post('/api/auth/register', { username: 'NEHA', password: 'other-pass' })).status, 400);
  assert.equal((await b.post('/api/auth/logout')).status, 200);
  assert.equal((await b.get('/api/me')).body.user, null);
  assert.equal((await b.post('/api/auth/login', { username: 'neha', password: 'nope-nope' })).status, 401);
  assert.equal((await b.post('/api/auth/login', { username: 'neha', password: 'neha-pass' })).status, 200);
  assert.equal((await b.get('/api/me')).body.user.username, 'neha');
});

test('a form post from another site is refused: changes must be JSON', async (t) => {
  const { server } = await serve(t);
  const res = await fetch(`${server.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=admin-pass',
  });
  assert.equal(res.status, 415);
});

test('notebooks sync only for members, and viewers cannot write', async (t) => {
  const { server } = await serve(t);
  const owner = await signUp(server, 'owner');
  const friend = await signUp(server, 'friend');
  const stranger = await signUp(server, 'stranger');

  const created = await owner.b.post('/api/notebooks', { title: 'Lab journal' });
  assert.equal(created.status, 201);
  const { id, room } = created.body.notebook;

  // The owner writes and syncs.
  const a = await replica(server, 'owner-1', room, owner.syncToken);
  t.after(() => a.close());
  const doc = a.mutate((tx) => tx.create('notes', { title: 'Day 1', body: 'calibrated', tags: [] }));
  await a.syncUntilIdle();
  assert.equal(await a.pendingCount(), 0);

  // A stranger is turned away.
  const s = await replica(server, 'stranger-1', room, stranger.syncToken);
  t.after(() => s.close());
  const refused = await s.sync();
  assert.ok(refused.error, 'stranger sync fails');

  // Shared read-only: the friend can pull but not push.
  const share = await owner.b.post(`/api/notebooks/${id}/members`, { username: 'friend', role: 'viewer' });
  assert.deepEqual(share.body.members.map((m) => [m.username, m.role]), [['owner', 'owner'], ['friend', 'viewer']]);
  assert.equal((await friend.b.post(`/api/notebooks/${id}/members`, { username: 'stranger', role: 'editor' })).status, 403,
    'only the owner shares');

  const f = await replica(server, 'friend-1', room, friend.syncToken);
  t.after(() => f.close());
  await f.syncUntilIdle();
  assert.equal(f.get('notes', doc).title, 'Day 1');
  f.mutate((tx) => tx.set('notes', doc, 'title', 'Day 1 (edited)'));
  const pushed = await f.sync();
  assert.ok(pushed.error, 'a viewer cannot push');

  // Promoted to editor, the same pending write goes through.
  await owner.b.post(`/api/notebooks/${id}/members`, { username: 'friend', role: 'editor' });
  await f.syncUntilIdle();
  assert.equal(await f.pendingCount(), 0);
  await a.syncUntilIdle();
  assert.equal(a.get('notes', doc).title, 'Day 1 (edited)');

  // Leaving is allowed; then access ends on the next request.
  assert.equal((await friend.b.del(`/api/notebooks/${id}/members/${friend.me.id}`)).status, 200);
  assert.deepEqual((await friend.b.get('/api/notebooks')).body.notebooks.filter((n) => n.id === id), []);
  f.mutate((tx) => tx.set('notes', doc, 'title', 'after leaving'));
  assert.ok((await f.sync()).error);
});

test('only the owner renames or deletes, and a deleted notebook drops its log', async (t) => {
  const { server, dropped } = await serve(t);
  const owner = await signUp(server, 'owner');
  const other = await signUp(server, 'other');
  const { id, room } = (await owner.b.post('/api/notebooks', { title: 'Draft' })).body.notebook;

  assert.equal((await other.b.patch(`/api/notebooks/${id}`, { title: 'Mine now' })).status, 404, 'not even visible');
  assert.equal((await owner.b.patch(`/api/notebooks/${id}`, { title: 'Final' })).body.notebook.title, 'Final');
  assert.equal((await owner.b.patch(`/api/notebooks/${id}`, { title: '' })).status, 400);
  assert.equal((await owner.b.del(`/api/notebooks/${id}`)).status, 200);
  assert.deepEqual(dropped, [room]);
});

test('admin routes need an admin, and can manage accounts', async (t) => {
  const { server, dropped } = await serve(t);
  const user = await signUp(server, 'student');
  for (const path of ['/api/admin/overview', '/api/admin/users', '/api/admin/notebooks', '/api/admin/audit', '/api/admin/schema']) {
    assert.equal((await user.b.get(path)).status, 403, path);
  }
  assert.equal((await browser(server).get('/api/admin/users')).status, 401);

  const admin = browser(server);
  assert.equal((await admin.post('/api/auth/login', { username: 'admin', password: 'admin-pass' })).status, 200);

  const overview = (await admin.get('/api/admin/overview')).body;
  assert.equal(overview.accounts.users, 2);
  assert.equal(overview.accounts.admins, 1);
  assert.ok(overview.server.uptimeSeconds >= 0);

  const created = await admin.post('/api/admin/users', { username: 'tutor', password: 'tutor-password', role: 'admin' });
  assert.equal(created.status, 201);
  assert.equal(created.body.user.role, 'admin');

  const users = (await admin.get('/api/admin/users')).body.users;
  assert.deepEqual(users.map((u) => u.username), ['admin', 'student', 'tutor']);
  assert.equal(users.find((u) => u.username === 'student').notebooksOwned, 1);

  // Disable, then reset the password: the user is signed out and the old one stops working.
  const studentId = user.me.id;
  assert.equal((await admin.patch(`/api/admin/users/${studentId}`, { disabled: true })).body.user.disabled, true);
  assert.equal((await user.b.get('/api/me')).body.user, null, 'signed out by the disable');
  await admin.patch(`/api/admin/users/${studentId}`, { disabled: false, password: 'fresh-password' });
  assert.equal((await user.b.post('/api/auth/login', { username: 'student', password: 'student-pass' })).status, 401);
  assert.equal((await user.b.post('/api/auth/login', { username: 'student', password: 'fresh-password' })).status, 200);

  assert.equal((await admin.patch(`/api/admin/users/${(await admin.get('/api/me')).body.user.id}`, { role: 'user' })).status, 400,
    'no demoting yourself');

  const notebooks = (await admin.get('/api/admin/notebooks')).body.notebooks;
  assert.equal(notebooks.length, 2, 'the first notebooks of the student and the tutor');
  assert.ok(notebooks.every((n) => n.sync && n.sync.operations === 0));

  assert.equal((await admin.del(`/api/admin/users/${studentId}`)).status, 200);
  assert.equal(dropped.length, 1, "the student's notebook log is dropped");
  const events = (await admin.get('/api/admin/audit')).body.events.map((e) => e.action);
  for (const action of ['user.signup', 'user.create', 'user.disable', 'user.password-reset', 'user.delete']) {
    assert.ok(events.includes(action), action);
  }
  assert.ok((await admin.get('/api/admin/schema')).body.objects.some((o) => o.name === 'memberships'));
});

test('sign-up can be closed', async (t) => {
  const { server } = await serve(t, { signup: false });
  const b = browser(server);
  const res = await b.post('/api/auth/register', { username: 'late', password: 'late-pass' });
  assert.equal(res.status, 403);
  assert.equal((await b.get('/api/me')).body.signup, false);
});
