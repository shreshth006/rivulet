import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncServer } from '#server/engine';
import { HttpSyncServer } from '#server/http';
import { HttpTransport } from '#client/transport';
import { RivuletClient } from '#client/client';
import { MemoryAdapter } from '#storage/adapter';
import { nodeIdFromLabel } from '#core/ids';
import { createServer, request } from 'node:http';
import { notebookSchema } from './helpers/fixtures.js';

/**
 * The engine's side of the live stream: that a nudge actually leads to a sync,
 * and that a stream which drops -- routine on a phone -- comes back. Polling is
 * effectively off in every test here, so only the stream can deliver.
 */

/** A server whose rooms outlive it, so it can be restarted on the same port. */
function makeServer() {
  const adapters = new Map();
  let http = null;
  return {
    async start(port = 0) {
      const engine = new SyncServer({
        schema: notebookSchema.fingerprint,
        storage: async (room) => {
          if (!adapters.has(room)) adapters.set(room, new MemoryAdapter({ name: room }));
          const adapter = adapters.get(room);
          await adapter.open();
          return adapter;
        },
      });
      http = await new HttpSyncServer({ engine, heartbeatMs: 60_000 }).listen(port);
      return http;
    },
    get port() { return http.address.port; },
    get url() { return http.url; },
    async stop() { await http?.close(); http = null; },
  };
}

async function client(url, label, sync = {}) {
  const node = nodeIdFromLabel(label);
  return RivuletClient.open({
    schema: notebookSchema, room: 'live', node,
    storage: new MemoryAdapter({ name: label }),
    transport: new HttpTransport({ url, room: 'live', node, timeoutMs: 2000 }),
    sync: { pollMs: 1e9, debounceMs: 10, maxBackoffMs: 500, ...sync },
  });
}

/**
 * A proxy that buffers event streams, as some do (Cloudflare's quick tunnels,
 * corporate proxies): a stream's headers go through, its frames never do.
 * Everything else is forwarded untouched.
 */
function bufferingProxy(target) {
  const upstream = new URL(target);
  const held = new Set();
  const server = createServer((req, res) => {
    if (req.url.startsWith('/v1/stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      held.add(res);
      req.on('close', () => held.delete(res));
      return;
    }
    const forward = request({
      host: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: req.headers,
    }, (reply) => {
      res.writeHead(reply.statusCode, reply.headers);
      reply.pipe(res);
    });
    req.pipe(forward);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      for (const res of held) res.destroy();
      server.closeAllConnections();
      return new Promise((done) => server.close(done));
    },
  })));
}

async function waitFor(predicate, { timeoutMs = 8000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('a peer\'s write arrives without asking, even while an idle poll is pending', async (t) => {
  const server = makeServer();
  await server.start();
  t.after(() => server.stop());
  const a = await client(server.url, 'live-a');
  const b = await client(server.url, 'live-b');
  t.after(() => Promise.all([a.close(), b.close()]));

  const id = a.mutate((tx) => tx.create('notes', { title: 'pushed live' }));
  await waitFor(() => b.get('notes', id), { label: 'b to receive the note' });
  assert.equal(b.get('notes', id).title, 'pushed live');
});

test('streams come back after the server restarts', async (t) => {
  const server = makeServer();
  await server.start();
  const port = server.port;
  t.after(() => server.stop());
  const a = await client(server.url, 'restart-a');
  const b = await client(server.url, 'restart-b');
  t.after(() => Promise.all([a.close(), b.close()]));
  const closed = [];
  b.engine.on('stream-closed', () => closed.push(Date.now()));

  // Every stream drops with the server; it comes back on the same address.
  await server.stop();
  await waitFor(() => closed.length > 0, { label: 'b to notice the stream closed' });
  await server.start(port);

  // b has no poll to fall back on: only a reopened stream can tell it.
  await waitFor(async () => (await a.sync()).error === undefined, { label: 'a to reach the server again' });
  const id = a.mutate((tx) => tx.create('notes', { title: 'after the restart' }));
  await waitFor(() => b.get('notes', id), { label: 'b to receive the note over a reopened stream' });
});

test('a client that started with the server down gets a stream once it is up', async (t) => {
  const server = makeServer();
  await server.start();
  const port = server.port;
  const url = server.url;
  await server.stop();

  const b = await client(url, 'late-b');
  t.after(() => b.close());
  assert.equal(b.status, 'offline');

  await server.start(port);
  t.after(() => server.stop());
  await waitFor(async () => (await b.sync()).error === undefined, { label: 'b to connect' });

  const a = await client(url, 'late-a');
  t.after(() => a.close());
  const id = a.mutate((tx) => tx.create('notes', { title: 'b never asked for this' }));
  await waitFor(() => b.get('notes', id), { label: 'b to receive the note over its late stream' });
});

test('a stream whose frames never arrive does not slow polling down', async (t) => {
  // Behind a buffering proxy the stream "opens" but delivers nothing. The
  // engine must not trust it and idle at its long, stream-backed interval
  // (4 × pollMs, 2 s here); it keeps polling at pollMs until a frame arrives.
  const server = makeServer();
  await server.start();
  const proxy = await bufferingProxy(server.url);
  const a = await client(proxy.url, 'buffered-a', { pollMs: 500 });
  const b = await client(proxy.url, 'buffered-b', { pollMs: 500 });
  t.after(async () => {
    await Promise.all([a.close(), b.close()]);
    await proxy.close();
    await server.stop();
  });

  const id = a.mutate((tx) => tx.create('notes', { title: 'through a buffering proxy' }));
  await a.syncUntilIdle();
  await waitFor(() => b.get('notes', id), { timeoutMs: 1400, label: 'the note at b, by polling' });
});
