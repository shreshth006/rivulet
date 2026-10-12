import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncServer } from '#server/engine';
import { RivuletClient } from '#client/client';
import { LoopbackTransport } from '#client/transport';
import { MemoryAdapter } from '#storage/adapter';
import { VersionVector } from '#core/version-vector';
import { nodeIdFromLabel } from '#core/ids';
import { ProtocolError } from '#core/errors';
import { vectorDelta, applyVectorDelta, sync as syncMessage, validateMessage } from '#protocol/messages';
import { notebookSchema } from './helpers/fixtures.js';

const n = (label) => nodeIdFromLabel(label);
const vv = (obj) => VersionVector.fromJSON(obj);

test('a delta carries only what differs, including replicas the sender lacks', () => {
  const base = vv({ [n('a')]: 5, [n('b')]: 3, [n('c')]: 9 });
  const full = vv({ [n('a')]: 5, [n('b')]: 7, [n('d')]: 1 });
  const delta = vectorDelta(full, base);
  assert.deepEqual(delta, { [n('b')]: 7, [n('c')]: 0, [n('d')]: 1 });
  assert.deepEqual(applyVectorDelta(base, delta).toJSON(), full.toJSON());

  // Lower than the base is a real difference, not something to round up.
  const behind = vv({ [n('a')]: 2, [n('b')]: 3, [n('c')]: 9 });
  assert.deepEqual(applyVectorDelta(base, vectorDelta(behind, base)).toJSON(), behind.toJSON());
  assert.deepEqual(vectorDelta(base, base), {});
});

test('malformed deltas and base ids are protocol errors', () => {
  const base = vv({ [n('a')]: 1 });
  assert.throws(() => applyVectorDelta(base, { [n('a')]: -1 }), ProtocolError);
  assert.throws(() => applyVectorDelta(base, { 'not-a-node': 4 }), ProtocolError);
  assert.throws(() => applyVectorDelta(base, null), ProtocolError);
  const msg = syncMessage({ node: n('a'), room: 'r', have: base });
  assert.throws(() => validateMessage({ ...msg, bv: 7 }), ProtocolError);
  assert.throws(() => validateMessage({ ...msg, bv: 'x'.repeat(65) }), ProtocolError);
});

/**
 * A server whose room storage outlives the room, so closing a room forgets
 * its numbered frontiers -- as a restart does -- without losing operations.
 */
async function setup({ clients = 3, limit } = {}) {
  const adapters = new Map();
  const server = new SyncServer({
    schema: notebookSchema.fingerprint,
    storage: async (room) => {
      if (!adapters.has(room)) adapters.set(room, new MemoryAdapter({ name: room }));
      return adapters.get(room);
    },
  });
  /** Every sync request the server saw and its reply, per client. */
  const wire = [];
  const byNode = new Map();
  const handleSync = server.handleSync.bind(server);
  server.handleSync = async (msg, ctx) => {
    const reply = await handleSync(msg, ctx);
    byNode.get(msg.node)?.push({ msg, reply });
    return reply;
  };
  const members = [];
  for (let i = 0; i < clients; i++) {
    const node = n(`vd-${i}`);
    const log = [];
    wire.push(log);
    byNode.set(node, log);
    members.push(await RivuletClient.open({
      schema: notebookSchema, room: 'vd', node,
      storage: new MemoryAdapter({ name: `vd-${i}` }),
      transport: new LoopbackTransport(server, { node, room: 'vd' }),
      sync: { pollMs: 1e9, debounceMs: 1e9, ...(limit ? { batching: { initial: limit, max: limit, min: limit } } : {}) },
    }));
  }
  const settle = async () => {
    for (let pass = 0; pass < 3; pass++) for (const c of members) await c.syncUntilIdle();
  };
  return { server, clients: members, wire, settle, close: () => Promise.all(members.map((c) => c.close())) };
}

test('a caught-up replica exchanges empty frontiers, however many replicas there are', async (t) => {
  const s = await setup({ clients: 6 });
  t.after(() => s.close());
  s.clients.forEach((c, i) => c.mutate((tx) => tx.create('notes', { title: `from ${i}` })));
  await s.settle();

  const [a] = s.clients;
  s.wire[0].length = 0;
  await a.sync();
  const [{ msg, reply }] = s.wire[0];
  assert.equal(typeof msg.bv, 'string', 'the request names its base');
  assert.deepEqual(msg.have, {}, 'and carries no vector entries');
  assert.equal(reply.hd, msg.bv);
  assert.deepEqual(reply.have, {});
  assert.equal(a.list('notes').length, 6);
});

test('a forgotten base costs one round trip and loses nothing', async (t) => {
  const s = await setup({ clients: 2 });
  t.after(() => s.close());
  const [a, b] = s.clients;
  a.mutate((tx) => tx.create('notes', { title: 'before' }));
  await s.settle();

  // The server forgets every numbered frontier; operations survive.
  await s.server.closeRoom('vd');
  const id = b.mutate((tx) => tx.create('notes', { title: 'after' }));
  await b.syncUntilIdle();

  s.wire[0].length = 0;
  await a.syncUntilIdle();
  const [first, second] = s.wire[0];
  assert.ok(first.reply.more, 'the unknown base is answered with a retry');
  assert.equal(first.reply.pull, undefined);
  assert.equal(first.reply.hd, undefined, 'and the full frontier, not a delta');
  assert.equal(second.msg.bv, first.reply.hv, 'the retry uses the fresh id');
  assert.equal(a.get('notes', id).title, 'after');
});

test('a replica behind its base still receives everything, page by page', async (t) => {
  const s = await setup({ clients: 2, limit: 3 });
  t.after(() => s.close());
  const [a, b] = s.clients;
  for (let i = 0; i < 20; i++) b.mutate((tx) => tx.create('notes', { title: `n${i}` }));
  await b.syncUntilIdle();

  await a.syncUntilIdle();
  assert.equal(a.list('notes').length, 20);
  // Every round after the first is a delta, and some named a base ahead of us.
  const rounds = s.wire[0].filter((w) => w.msg.bv);
  assert.ok(rounds.length > 3);
  assert.ok(rounds.some((w) => Object.values(w.msg.have).some((seq) => seq < 20)));
});

test('a reply delta against a base the client did not send is refused', async (t) => {
  const s = await setup({ clients: 1 });
  t.after(() => s.close());
  const [a] = s.clients;
  await a.syncUntilIdle();

  const server = s.server;
  const original = server.handleSync.bind(server);
  server.handleSync = async (msg, ctx) => ({ ...(await original(msg, ctx)), hd: 'someone-else.0' });
  const result = await a.sync();
  assert.ok(result.error instanceof ProtocolError);
});
