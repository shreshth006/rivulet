import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncServer } from '#server/engine';
import { HttpSyncServer } from '#server/http';
import { HttpTransport } from '#client/transport';
import { RivuletClient } from '#client/client';
import { MemoryAdapter } from '#storage/adapter';
import { notebookSchema } from '../../test/helpers/fixtures.js';
import { AuthError, TransportError } from '#core/errors';
import { nodeIdFromLabel } from '#core/ids';
import { issueRoomToken, roomTokens } from '#server/tokens';

/** Start a real HTTP server on an ephemeral port. */
async function serve({ token, authorize, schema = notebookSchema } = {}) {
  const engine = new SyncServer({
    storage: async (room) => new MemoryAdapter({ name: room }),
    schema: schema.fingerprint,
    authorize,
  });
  return new HttpSyncServer({ engine, token }).listen(0);
}

/**
 * Poll until `predicate` holds. Sleeping a fixed interval and asserting makes
 * a test that passes on a quiet machine and fails on a busy one; waiting for
 * the condition itself is both faster and deterministic.
 */
async function waitFor(predicate, { timeoutMs = 3000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function connect(server, label, { token, room = 'http-room' } = {}) {
  const node = nodeIdFromLabel(label);
  return RivuletClient.open({
    schema: notebookSchema, room, node,
    storage: new MemoryAdapter({ name: label }),
    transport: new HttpTransport({ url: server.url, room, node, token }),
    sync: { pollMs: 1e9, debounceMs: 1e9 },
  });
}

test('two clients sync over real HTTP', async (t) => {
  const server = await serve();
  t.after(() => server.close());
  const a = await connect(server, 'http-a');
  const b = await connect(server, 'http-b');
  t.after(() => Promise.all([a.close(), b.close()]));

  const id = a.mutate((tx) => tx.create('notes', {
    title: 'over the wire', body: 'hello from a real socket', tags: ['net'],
  }));
  await a.syncUntilIdle();
  await b.syncUntilIdle();

  assert.equal(b.get('notes', id).title, 'over the wire');
  assert.deepEqual(b.get('notes', id).tags, ['net']);

  // And back the other way.
  b.mutate((tx) => tx.add('notes', id, 'tags', 'reply'));
  await b.syncUntilIdle();
  await a.syncUntilIdle();
  assert.deepEqual(a.get('notes', id).tags.sort(), ['net', 'reply']);
});

test('a large sync is compressed on the wire', async (t) => {
  const server = await serve();
  t.after(() => server.close());
  const a = await connect(server, 'big-a');
  t.after(() => a.close());

  const id = a.mutate((tx) => tx.create('notes', { title: 'bulk', body: '' }));
  a.mutate((tx) => tx.setText('notes', id, 'body', 'the quick brown fox jumps. '.repeat(50)));
  await a.syncUntilIdle();

  const meter = a.engine.stats.bytes;
  assert.ok(meter.sentWire < meter.sentRaw,
    `expected compression, sent ${meter.sentWire}B of ${meter.sentRaw}B raw`);
  assert.equal(await a.pendingCount(), 0);
});

test('the event stream notifies a peer that something changed', async (t) => {
  const server = await serve();
  t.after(() => server.close());
  const a = await connect(server, 'sse-a');
  const b = await connect(server, 'sse-b');
  t.after(() => Promise.all([a.close(), b.close()]));

  const room = 'http-room';
  const events = [];
  const transport = new HttpTransport({ url: server.url, room, node: b.node });
  const off = await transport.subscribe((msg) => events.push(msg));
  t.after(() => { off(); transport.close(); });

  // The first frame confirms the subscription is live before anything is
  // written, so the notification cannot be missed by subscribing too late.
  await waitFor(() => events[0]?.t === 'ready', { label: 'stream ready' });

  a.mutate((tx) => tx.create('notes', { title: 'notify me' }));
  await a.syncUntilIdle();

  const change = await waitFor(() => events.find((e) => e.t === 'event'),
    { label: 'change notification' });
  assert.equal(change.n, 1, 'the frame reports a count, not the operations');
});

test('a bearer token is enforced on both endpoints', async (t) => {
  const server = await serve({ token: 'secret' });
  t.after(() => server.close());

  const good = await connect(server, 'auth-ok', { token: 'secret' });
  t.after(() => good.close());
  good.mutate((tx) => tx.create('notes', { title: 'allowed' }));
  await good.syncUntilIdle();
  assert.equal(good.status, 'live');

  const bad = await connect(server, 'auth-bad', { token: 'wrong' });
  t.after(() => bad.close());
  assert.equal(bad.status, 'unauthorised', 'a bad token must not retry forever');

  const stream = new HttpTransport({ url: server.url, room: 'http-room', node: bad.node, token: 'wrong' });
  await assert.rejects(() => stream.subscribe(() => {}), TransportError);
});

test('an unauthorised client stops retrying instead of spinning', async (t) => {
  const server = await serve({ token: 'secret' });
  t.after(() => server.close());

  const node = nodeIdFromLabel('no-token');
  const transport = new HttpTransport({ url: server.url, room: 'http-room', node });
  await assert.rejects(() => transport.request({ t: 'sync', node, room: 'http-room', have: {} }), AuthError);
});

test('the deployment token also guards the inspection endpoints', async (t) => {
  const server = await serve({ token: 'secret' });
  t.after(() => server.close());
  assert.equal((await fetch(`${server.url}/v1/stats`)).status, 403);
  assert.equal((await fetch(`${server.url}/v1/room?name=x`)).status, 403);
  const ok = await fetch(`${server.url}/v1/stats`, { headers: { authorization: 'Bearer secret' } });
  assert.equal(ok.status, 200);
  assert.equal((await fetch(`${server.url}/v1/health`)).status, 200, 'health stays open for probes');
});

const SECRET = 'http-test-secret-0123456789';
const roomToken = (claims) => issueRoomToken(SECRET, claims);

test('room tokens: a writer and a read-only follower share a room', async (t) => {
  const server = await serve({ authorize: roomTokens(SECRET) });
  t.after(() => server.close());

  const writer = await connect(server, 'rt-writer', { token: roomToken({ room: 'http-room' }) });
  const reader = await connect(server, 'rt-reader', { token: roomToken({ room: 'http-room', scope: 'read' }) });
  t.after(() => Promise.all([writer.close(), reader.close()]));

  const id = writer.mutate((tx) => tx.create('notes', { title: 'shared read-only' }));
  await writer.syncUntilIdle();
  await reader.syncUntilIdle();
  assert.equal(reader.get('notes', id).title, 'shared read-only', 'a read token can pull');
  assert.equal(reader.status, 'live');

  // The follower writes anyway: the push is refused, and nothing reaches the room.
  reader.mutate((tx) => tx.create('notes', { title: 'should not land' }));
  await reader.sync().catch(() => {});
  assert.equal(reader.status, 'unauthorised');
  await writer.syncUntilIdle();
  assert.equal(writer.list('notes').length, 1);
});

test('room tokens: other rooms, other replicas and expired tokens are refused', async (t) => {
  const server = await serve({ authorize: roomTokens(SECRET) });
  t.after(() => server.close());

  const wrongRoom = await connect(server, 'rt-a', { token: roomToken({ room: 'elsewhere' }) });
  const wrongNode = await connect(server, 'rt-b', { token: roomToken({ room: 'http-room', node: nodeIdFromLabel('rt-x') }) });
  const expired = await connect(server, 'rt-c', { token: roomToken({ room: 'http-room', ttlSeconds: -1 }) });
  const none = await connect(server, 'rt-d');
  const prefixed = await connect(server, 'rt-e', { token: roomToken({ room: 'http-*' }) });
  t.after(() => Promise.all([wrongRoom, wrongNode, expired, none, prefixed].map((c) => c.close())));

  for (const client of [wrongRoom, wrongNode, expired, none]) {
    await client.sync().catch(() => {});
    assert.equal(client.status, 'unauthorised');
  }
  await prefixed.syncUntilIdle();
  assert.equal(prefixed.status, 'live', 'a prefix pattern covers the room');
});

test('room tokens: the stream is refused before it opens', async (t) => {
  const server = await serve({ authorize: roomTokens(SECRET) });
  t.after(() => server.close());
  const stream = (token) => fetch(`${server.url}/v1/stream?room=http-room`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

  assert.equal((await stream()).status, 403);
  assert.equal((await stream(roomToken({ room: 'elsewhere' }))).status, 403);
  const ok = await stream(roomToken({ room: 'http-room', scope: 'read' }));
  assert.equal(ok.status, 200);
  await ok.body.cancel();
});

test('room tokens: inspection needs admin scope, and stats needs it for every room', async (t) => {
  const server = await serve({ authorize: roomTokens(SECRET) });
  t.after(() => server.close());
  const get = (path, token) => fetch(`${server.url}${path}`, { headers: { authorization: `Bearer ${token}` } });

  const writer = await connect(server, 'rt-inspect', { token: roomToken({ room: 'http-room' }) });
  t.after(() => writer.close());
  await writer.sync();

  assert.equal((await get('/v1/room?name=http-room', roomToken({ room: 'http-room' }))).status, 403);
  assert.equal((await get('/v1/room?name=http-room', roomToken({ room: 'http-room', scope: 'admin' }))).status, 200);
  assert.equal((await get('/v1/stats', roomToken({ room: 'http-room', scope: 'admin' }))).status, 403);
  assert.equal((await get('/v1/stats', roomToken({ room: '*', scope: 'admin' }))).status, 200);
});

test('health and stats report the server state', async (t) => {
  const server = await serve();
  t.after(() => server.close());
  const a = await connect(server, 'stats-a');
  t.after(() => a.close());

  a.mutate((tx) => tx.create('notes', { title: 'counted' }));
  await a.syncUntilIdle();

  const health = await (await fetch(`${server.url}/v1/health`)).json();
  assert.equal(health.ok, true);

  const stats = await (await fetch(`${server.url}/v1/stats`)).json();
  assert.equal(stats.rooms.length, 1);
  assert.equal(stats.rooms[0].name, 'http-room');
  assert.ok(stats.rooms[0].operations >= 1);
});

test('info and room endpoints report server metadata and room stats', async (t) => {
  const server = await serve();
  t.after(() => server.close());

  const info = await (await fetch(`${server.url}/v1/info`)).json();
  assert.equal(info.ok, true);
  assert.equal(info.protocolVersion, 1);
  assert.equal(info.codecVersion, 2);
  assert.equal(typeof info.node, 'string');
  assert.equal(typeof info.limits, 'object');

  // Room not yet opened
  const missing = await fetch(`${server.url}/v1/room?name=http-room`);
  assert.equal(missing.status, 404);

  // Missing room param
  const badParam = await fetch(`${server.url}/v1/room`);
  assert.equal(badParam.status, 400);

  // Connect client to open room
  const a = await connect(server, 'info-a');
  t.after(() => a.close());
  await a.sync();

  const roomRes = await fetch(`${server.url}/v1/room?name=http-room`);
  assert.equal(roomRes.status, 200);
  const roomData = await roomRes.json();
  assert.equal(roomData.name, 'http-room');
});


test('unknown routes 404 rather than hanging', async (t) => {
  const server = await serve();
  t.after(() => server.close());
  const res = await fetch(`${server.url}/nope`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not found' });
});

test('an oversized body is refused', async (t) => {
  const server = await serve();
  t.after(() => server.close());

  const res = await fetch(`${server.url}/v1/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(5 * 1024 * 1024),
  }).catch((err) => ({ status: 0, err }));

  assert.ok(res.status === 400 || res.status === 0, `expected rejection, got ${res.status}`);
});

test('a malformed body produces a protocol error, not a crash', async (t) => {
  const server = await serve();
  t.after(() => server.close());

  const res = await fetch(`${server.url}/v1/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"t":"sync","node":"not-a-node-id","room":"r"}',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'E_PROTOCOL');

  // The server is still healthy afterwards.
  assert.equal((await (await fetch(`${server.url}/v1/health`)).json()).ok, true);
});

test('the stream endpoint requires a room', async (t) => {
  const server = await serve();
  t.after(() => server.close());
  const res = await fetch(`${server.url}/v1/stream`);
  assert.equal(res.status, 400);
});

test('an unreachable server surfaces as a retryable transport error', async () => {
  const node = nodeIdFromLabel('lonely');
  const transport = new HttpTransport({
    url: 'http://127.0.0.1:1', room: 'r', node, timeoutMs: 500,
  });
  await assert.rejects(
    () => transport.request({ t: 'sync', node, room: 'r', have: {} }),
    (err) => err instanceof TransportError && err.retryable === true,
  );
});

test('static mounts serve modules with Node-style extension resolution', async (t) => {
  const { HttpSyncServer } = await import('#server/http');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

  const engine = new SyncServer({ storage: async () => new MemoryAdapter() });
  const server = await new HttpSyncServer({
    engine, mounts: { '/src': join(root, 'src') },
  }).listen(0);
  t.after(() => server.close());

  // Browsers do not add `.js`; the engine's own imports rely on it.
  const extensionless = await fetch(`${server.url}/src/core/hlc`);
  assert.equal(extensionless.status, 200);
  assert.ok(extensionless.headers.get('content-type').startsWith('text/javascript'));
  assert.ok((await extensionless.text()).includes('HybridClock'));

  assert.equal((await fetch(`${server.url}/src/core/hlc.js`)).status, 200);
  assert.equal((await fetch(`${server.url}/src/core/nope`)).status, 404);
});

test('static serving refuses to escape its mount root', async (t) => {
  const { HttpSyncServer } = await import('#server/http');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

  const engine = new SyncServer({ storage: async () => new MemoryAdapter() });
  const server = await new HttpSyncServer({ engine, mounts: { '/src': join(root, 'src') } }).listen(0);
  t.after(() => server.close());

  for (const attempt of [
    '/src/../package.json',
    '/src/../../etc/passwd',
    '/src/%2e%2e/package.json',
    '/src/core/../../package.json',
  ]) {
    const res = await fetch(`${server.url}${attempt}`);
    assert.ok(res.status === 403 || res.status === 404,
      `${attempt} must not be served, got ${res.status}`);
    const body = await res.text();
    assert.ok(!body.includes('"name": "rivulet"'), `${attempt} leaked a file outside the root`);
  }
});

test('SyncServer room inspection, roomStats and closeRoom', async () => {
  const engine = new SyncServer({
    storage: async (room) => new MemoryAdapter({ name: room }),
  });

  assert.equal(engine.roomCount, 0);
  assert.equal(engine.hasRoom('test-room'), false);

  await engine.room('test-room');
  assert.equal(engine.roomCount, 1);
  assert.equal(engine.hasRoom('test-room'), true);
  assert.deepEqual(engine.roomNames, ['test-room']);

  const stats = await engine.roomStats('test-room');
  assert.equal(stats.name, 'test-room');
  assert.equal(stats.operations, 0);
  assert.equal(stats.connections, 0);

  const closed = await engine.closeRoom('test-room');
  assert.equal(closed, true);
  assert.equal(engine.roomCount, 0);
  assert.equal(engine.hasRoom('test-room'), false);

  assert.equal(await engine.closeRoom('nonexistent'), false);
  await engine.close();
});

test('SyncServer maxRooms ceiling rejects opening excess rooms', async () => {
  const { LimitError } = await import('#core/errors');
  const engine = new SyncServer({
    storage: async (room) => new MemoryAdapter({ name: room }),
    maxRooms: 2,
  });

  await engine.room('room-1');
  await engine.room('room-2');
  assert.equal(engine.roomCount, 2);

  // Accessing existing room is fine
  await engine.room('room-1');

  // Exceeding room limit throws LimitError
  await assert.rejects(() => engine.room('room-3'), LimitError);

  // Closing one room frees a slot
  await engine.closeRoom('room-1');
  assert.equal(engine.roomCount, 1);
  await engine.room('room-3');
  assert.equal(engine.roomCount, 2);

  await engine.close();
});


