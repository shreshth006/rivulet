import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCluster, assertSameView } from './helpers/cluster.js';
import { makeDb, notebookSchema, deliver } from './helpers/fixtures.js';
import { decodeOps, encodeOps } from '#protocol/codec';
import { unpackMessage, Encoding } from '#protocol/framing';
import { ProtocolError, ValidationError } from '#core/errors';
import { makeRng, randInt, pick, shuffled } from '#core/util';

test('fuzz: multi-replica chaotic sync converges under network partitions and churn', async (t) => {
  const c = await makeCluster({ clients: 3 });
  t.after(() => c.close());

  const rng = makeRng(1337);
  const [a, b, d] = c.clients;
  const clients = [a, b, d];

  // Seed with an initial shared document
  const id = a.mutate((tx) => tx.create('notes', {
    title: 'Shared Fuzz Note',
    body: 'Initial text.',
    tags: ['base'],
    reads: 0,
    pinned: false,
  }));

  await c.settle();

  const words = ['quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog'];
  const tagList = ['alpha', 'beta', 'gamma', 'delta', 'urgent'];

  // Run 35 steps of random chaos
  for (let step = 0; step < 35; step++) {
    const client = pick(rng, clients);
    const action = randInt(rng, 0, 5);

    switch (action) {
      case 0: {
        // Edit body (RGA text)
        const current = client.get('notes', id)?.body ?? '';
        const word = pick(rng, words);
        const insertAt = randInt(rng, 0, current.length);
        const next = current.slice(0, insertAt) + ' ' + word + current.slice(insertAt);
        client.mutate((tx) => tx.setText('notes', id, 'body', next.trim()));
        break;
      }
      case 1: {
        // Modify tags (ORSet)
        const tag = pick(rng, tagList);
        if (rng() < 0.6) client.mutate((tx) => tx.add('notes', id, 'tags', tag));
        else client.mutate((tx) => tx.remove('notes', id, 'tags', tag));
        break;
      }
      case 2: {
        // Counter increment / decrement (PNCounter)
        const delta = randInt(rng, -2, 5);
        client.mutate((tx) => tx.increment('notes', id, 'reads', delta));
        break;
      }
      case 3: {
        // Rename or toggle pin (LWW)
        if (rng() < 0.5) client.mutate((tx) => tx.set('notes', id, 'title', `Title ${step}`));
        else client.mutate((tx) => tx.set('notes', id, 'pinned', rng() < 0.5));
        break;
      }
      case 4: {
        // Network disruption: toggle partition on a random client
        if (rng() < 0.4) {
          if (client.link.partitioned) client.link.heal();
          else client.link.partition();
        }
        break;
      }
      case 5: {
        // Attempt an asynchronous sync
        try { await client.sync(); } catch { /* ignore network failure during partition */ }
        break;
      }
    }
  }

  // Heal all network links and let the cluster settle completely
  for (const client of clients) client.link.heal();
  await c.settle();

  // All replicas must converge to the exact same view
  assertSameView(clients, 'notes');
});

test('fuzz: out-of-order operation arrival converges across replicas', () => {
  const a = makeDb('a');
  const b = makeDb('b');
  const rng = makeRng(4242);

  // Generate a history of interleaved operations
  const seed = a.mutate((tx) => tx.create('notes', { title: 'Seed', body: 'ABC', tags: ['t1'], reads: 10 }));
  const id = seed.result;
  deliver(seed.ops, b);

  const opsA = a.mutate((tx) => {
    tx.setText('notes', id, 'body', 'AXBC');
    tx.add('notes', id, 'tags', 't2');
    tx.increment('notes', id, 'reads', 5);
  }).ops;

  const opsB = b.mutate((tx) => {
    tx.setText('notes', id, 'body', 'ABCY');
    tx.remove('notes', id, 'tags', 't1');
    tx.increment('notes', id, 'reads', -3);
    tx.set('notes', id, 'title', 'Renamed by B');
  }).ops;

  const allOps = [...seed.ops, ...opsA, ...opsB];

  // Permute operations into multiple randomized arrival sequences
  for (let trial = 0; trial < 10; trial++) {
    const replica1 = makeDb('r1');
    const replica2 = makeDb('r2');

    const perm1 = shuffled(rng, allOps);
    const perm2 = shuffled(rng, allOps);

    replica1.applyAll(perm1);
    replica2.applyAll(perm2);

    assert.deepEqual(
      replica1.get('notes', id),
      replica2.get('notes', id),
      `replicas must match despite different arrival orders in trial ${trial}`,
    );
  }
});

test('fuzz: corrupted byte payloads and malformed frames do not crash the engine', async () => {
  const rng = makeRng(9999);

  // 1. Random garbage byte buffers unframed
  for (let i = 0; i < 25; i++) {
    const len = randInt(rng, 0, 64);
    const bytes = new Uint8Array(len);
    for (let j = 0; j < len; j++) bytes[j] = randInt(rng, 0, 256);

    try {
      await unpackMessage(bytes, Encoding.DEFLATE);
    } catch (err) {
      assert.ok(
        err instanceof ProtocolError || err instanceof ValidationError || err instanceof SyntaxError,
        `expected protocol/validation/syntax error, got: ${err.name}: ${err.message}`,
      );
    }
  }

  // 2. Mutate valid encoded batch by corrupting fields
  const validBatch = [{
    collection: 'notes',
    doc: 'doc-1',
    field: 'title',
    ts: '000000000001-0000-0123456789abcdef',
    node: '0123456789abcdef',
    seq: 1,
    payload: { v: 'hello' },
  }];
  const encoded = encodeOps(validBatch);

  // Corrupt properties of the encoded batch structure
  for (let i = 0; i < 20; i++) {
    const corrupted = JSON.parse(JSON.stringify(encoded));
    const mutationType = randInt(rng, 0, 4);

    if (mutationType === 0 && corrupted.cols) {
      corrupted.cols.seq = 'not-an-array';
    } else if (mutationType === 1 && corrupted.cols) {
      corrupted.cols.field = [9999]; // Out-of-bounds index into strings table
    } else if (mutationType === 2) {
      corrupted.v = 999; // Unsupported codec version
    } else if (mutationType === 3 && corrupted.strings) {
      corrupted.strings = null;
    }

    try {
      decodeOps(corrupted);
    } catch (err) {
      assert.ok(
        err instanceof ProtocolError || err instanceof ValidationError,
        `corrupted batch must fail safely with ProtocolError/ValidationError, got ${err.name}`,
      );
    }
  }
});
