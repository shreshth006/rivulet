import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncServer } from '#server/engine';
import { RivuletClient } from '#client/client';
import { LoopbackTransport } from '#client/transport';
import { MemoryAdapter } from '#storage/adapter';
import { nodeIdFromLabel } from '#core/ids';
import { AuthError, ValidationError, TransportError } from '#core/errors';
import { OpSealer, generateRoomKey, importRoomKey, deriveRoomKey } from '#protocol/seal';
import { notebookSchema, makeDb } from './helpers/fixtures.js';

/** A server whose stored operations the test can read -- the attacker's view. */
function makeServer() {
  const adapters = new Map();
  const server = new SyncServer({
    schema: notebookSchema.fingerprint,
    storage: async (room) => {
      if (!adapters.has(room)) adapters.set(room, new MemoryAdapter({ name: room }));
      return adapters.get(room);
    },
  });
  const stored = async (room = 'secret') => adapters.get(room).readOps();
  return { server, stored };
}

async function client(server, label, { key, room = 'secret', limit, link } = {}) {
  const node = nodeIdFromLabel(label);
  return RivuletClient.open({
    schema: notebookSchema, room, node,
    storage: new MemoryAdapter({ name: label }),
    transport: new LoopbackTransport(server, { node, room, link }),
    sync: { pollMs: 1e9, debounceMs: 1e9, ...(limit ? { batching: { initial: limit, min: limit, max: limit } } : {}) },
    ...(key ? { encryption: { key } } : {}),
  });
}

test('encrypted replicas converge while the server holds only ciphertext', async (t) => {
  const { server, stored } = makeServer();
  const key = generateRoomKey();
  const a = await client(server, 'e2e-a', { key });
  const b = await client(server, 'e2e-b', { key });
  t.after(() => Promise.all([a.close(), b.close()]));

  const id = a.mutate((tx) => tx.create('notes', {
    title: 'payroll figures', body: 'the router password is hunter2', tags: ['confidential'],
  }));
  b.mutate((tx) => tx.create('folders', { name: 'private folder' }));
  await a.syncUntilIdle(); await b.syncUntilIdle(); await a.syncUntilIdle();

  assert.equal(b.get('notes', id).body, 'the router password is hunter2');
  assert.deepEqual(b.get('notes', id).tags, ['confidential']);
  assert.equal(a.list('folders')[0].name, 'private folder');

  const ops = await stored();
  assert.ok(ops.length > 0);
  const visible = JSON.stringify(ops);
  for (const secret of ['payroll', 'hunter2', 'confidential', 'private folder', 'notes', 'folders', 'title', id]) {
    assert.ok(!visible.includes(secret), `the server can read "${secret}"`);
  }
  assert.ok(ops.every((op) => op.collection === '~' && op.doc === '~' && op.field === '~'));
  assert.ok(ops.every((op) => typeof op.payload.$e === 'string' || Number.isInteger(op.payload.$r)));
});

test('a pull that stops part-way through a sealed run still delivers it', async (t) => {
  const { server } = makeServer();
  const key = generateRoomKey();
  const writer = await client(server, 'e2e-w', { key });
  const reader = await client(server, 'e2e-r', { key, limit: 3 });
  t.after(() => Promise.all([writer.close(), reader.close()]));

  // One push of 40 notes is one run; the reader pulls three operations at a time.
  for (let i = 0; i < 40; i++) writer.mutate((tx) => tx.create('notes', { title: `n${i}`, body: `body ${i}` }));
  await writer.syncUntilIdle();
  const result = await reader.syncUntilIdle();
  assert.equal(result.error, undefined);
  assert.equal(reader.list('notes').length, 40);
});

test('a retried push whose first attempt landed loses nothing', async (t) => {
  const { server } = makeServer();
  const key = generateRoomKey();
  let loseReply = false;
  const writer = await client(server, 'e2e-w', {
    key,
    // The request reaches the server and is stored; the reply never comes back.
    link: async (exchange) => {
      const { reply } = await exchange();
      if (loseReply) { loseReply = false; throw new TransportError('reply lost', { kind: 'timeout' }); }
      return reply;
    },
  });
  const reader = await client(server, 'e2e-r', { key });
  t.after(() => Promise.all([writer.close(), reader.close()]));
  const acks = [];
  const handleSync = server.handleSync.bind(server);
  server.handleSync = async (msg, ctx) => { const r = await handleSync(msg, ctx); acks.push(r); return r; };

  for (let i = 0; i < 5; i++) writer.mutate((tx) => tx.create('notes', { title: `first ${i}` }));
  loseReply = true;
  assert.ok((await writer.sync()).error, 'the first attempt looks failed to the writer');

  // More work queues behind it, so the retry is a longer run over the same start.
  for (let i = 0; i < 5; i++) writer.mutate((tx) => tx.create('notes', { title: `second ${i}` }));
  await writer.syncUntilIdle();
  assert.ok(acks.some((a) => a.dup > 0 && a.ok > 0), 'the retry overlapped what the server already held');
  const result = await reader.syncUntilIdle();
  assert.equal(result.error, undefined);
  assert.equal(reader.list('notes').length, 10);
});

test('a replica with the wrong key stops, and applies nothing', async (t) => {
  const { server } = makeServer();
  const a = await client(server, 'e2e-a', { key: generateRoomKey() });
  const intruder = await client(server, 'e2e-x', { key: generateRoomKey() });
  t.after(() => Promise.all([a.close(), intruder.close()]));

  a.mutate((tx) => tx.create('notes', { title: 'not for you' }));
  await a.syncUntilIdle();
  const result = await intruder.sync();
  assert.ok(result.error instanceof AuthError);
  assert.equal(intruder.status, 'unauthorised');
  assert.equal(intruder.list('notes').length, 0);
});

test('plaintext written into an encrypted room is refused, not applied', async (t) => {
  const { server } = makeServer();
  const a = await client(server, 'e2e-a', { key: generateRoomKey() });
  const plain = await client(server, 'e2e-p');
  t.after(() => Promise.all([a.close(), plain.close()]));

  plain.mutate((tx) => tx.create('notes', { title: 'injected by whoever runs the server' }));
  await plain.syncUntilIdle();
  const result = await a.sync();
  assert.ok(result.error instanceof AuthError);
  assert.equal(a.list('notes').length, 0);
});

test('payloads moved between operations or rooms do not open', async () => {
  const key = await importRoomKey(generateRoomKey());
  const sealer = new OpSealer({ key, room: 'secret' });
  const db = makeDb('a');
  const { ops } = db.mutate((tx) => {
    tx.create('notes', { title: 'one' });
    tx.create('notes', { title: 'two' });
  });
  const sealed = await sealer.seal(ops);
  assert.deepEqual(await sealer.open(sealed), JSON.parse(JSON.stringify(ops)), 'round trip is exact');

  // One transaction is one run: a single ciphertext on the last operation.
  const tail = sealed.at(-1);
  assert.equal(sealed.filter((op) => op.payload.$e).length, 1);
  assert.ok(sealed.slice(0, -1).every((op) => op.payload.$r === tail.seq));

  // The server moves the run's ciphertext onto another operation...
  const moved = sealed.map((op, i) => (i === 0 ? { ...op, payload: tail.payload } : op));
  await assert.rejects(() => sealer.open(moved.slice(0, 1)), /tampered/);
  // ...or renumbers it, or claims it starts somewhere else.
  await assert.rejects(() => sealer.open([{ ...tail, seq: tail.seq + 100 }]), /tampered/);
  await assert.rejects(() => sealer.open([{ ...tail, payload: { ...tail.payload, f: tail.payload.f + 1 } }]), /tampered/);
  // ...or replays it into another room that happens to share the key.
  await assert.rejects(() => new OpSealer({ key, room: 'other' }).open(sealed), /tampered/);
  // ...or flips a bit.
  const bytes = tail.payload.$e;
  const flipped = (bytes[20] === 'A' ? 'B' : 'A');
  await assert.rejects(
    () => sealer.open([{ ...tail, payload: { ...tail.payload, $e: bytes.slice(0, 20) + flipped + bytes.slice(21) } }]),
    /tampered/,
  );
  // ...or sends a pointer without its run.
  await assert.rejects(() => sealer.open(sealed.slice(0, 1)), /without its run/);
});

test('keys: generated, imported, and derived per room from a passphrase', async () => {
  await assert.rejects(() => importRoomKey('dG9vLXNob3J0'), ValidationError);
  await assert.rejects(() => deriveRoomKey('', 'r'), ValidationError);
  assert.throws(() => new OpSealer({ room: 'r' }), ValidationError);
  assert.notEqual(generateRoomKey(), generateRoomKey());

  const opts = { iterations: 1_000 }; // the default is deliberately slow
  const [k1, k2, other] = await Promise.all([
    deriveRoomKey('correct horse', 'r1', opts),
    deriveRoomKey('correct horse', 'r1', opts),
    deriveRoomKey('correct horse', 'r2', opts),
  ]);
  const [op] = makeDb('a').mutate((tx) => tx.create('notes', { title: 'x' })).ops;
  const sealed = await new OpSealer({ key: k1, room: 'r1' }).seal([op]);
  assert.deepEqual(await new OpSealer({ key: k2, room: 'r1' }).open(sealed), [JSON.parse(JSON.stringify(op))],
    'the same passphrase and room give the same key');
  await assert.rejects(() => new OpSealer({ key: other, room: 'r1' }).open(sealed), AuthError,
    'another room gives another key');
});
