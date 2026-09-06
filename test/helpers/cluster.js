/**
 * @file Spin up a server and a set of clients in one process.
 *
 * Every interesting property of this system is a property of several replicas
 * interacting badly: a partition, a reconnection storm, a push that half
 * lands. Reproducing those against a real network is slow and flaky, so the
 * whole stack -- client, codec, protocol, server -- runs in-process, driven by
 * a controllable link.
 *
 * The link is the important part. `partition()` makes requests fail exactly as
 * an unreachable server does, and `latency` delays them, so a test can ask
 * "what happens if two people edit the same note while both are offline?" as a
 * straight-line assertion.
 */

import { SyncServer } from '#server/engine';
import { RivuletClient } from '#client/client';
import { LoopbackTransport } from '#client/transport';
import { MemoryAdapter } from '#storage/adapter';
import { TransportError } from '#core/errors';
import { notebookSchema } from './fixtures.js';
import { nodeIdFromLabel } from '#core/ids';

/** A controllable link between one client and the server. */
export class Link {
  constructor({ latencyMs = 0 } = {}) {
    this.latencyMs = latencyMs;
    this.partitioned = false;
    this.requests = 0;
    this.failures = 0;
    /** Fail the next N requests, to exercise retry paths. */
    this.failNext = 0;
    /** Allow N more requests, then fail -- drops a link mid-transfer. */
    this.allowNext = null;
  }

  partition() { this.partitioned = true; return this; }
  heal() { this.partitioned = false; return this; }

  /** Wraps a transport request. */
  async carry(fn) {
    this.requests++;
    if (this.allowNext !== null) {
      if (this.allowNext > 0) this.allowNext--;
      else { this.failures++; throw new TransportError('link dropped mid-transfer'); }
    }
    if (this.partitioned || this.failNext > 0) {
      if (this.failNext > 0) this.failNext--;
      this.failures++;
      throw new TransportError('simulated network failure');
    }
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    return fn();
  }
}

/**
 * @param {object} [opts]
 * @param {number} [opts.clients]
 * @param {import('#core/schema').Schema} [opts.schema]
 * @param {boolean} [opts.autoStart]
 */
export async function makeCluster({
  clients = 2, schema = notebookSchema, room = 'test-room',
  autoStart = true, sync: syncOpts, serverOpts,
} = {}) {
  const server = new SyncServer({
    storage: async () => new MemoryAdapter(),
    schema: schema.fingerprint,
    node: nodeIdFromLabel('server'),
    ...serverOpts,
  });

  const links = [];
  const members = [];

  for (let i = 0; i < clients; i++) {
    const link = new Link();
    links.push(link);
    const node = nodeIdFromLabel(`client-${i}`);
    const transport = new LoopbackTransport(server, {
      node, room,
      link: (fn) => link.carry(fn),
    });
    const client = await RivuletClient.open({
      schema, room, transport, node,
      storage: new MemoryAdapter({ name: `client-${i}` }),
      autoStart,
      // Tests drive syncing explicitly; background timers would make
      // assertions depend on wall-clock scheduling.
      sync: { pollMs: 1e9, debounceMs: 1e9, ...syncOpts },
    });
    client.label = `client-${i}`;
    client.link = link;
    members.push(client);
  }

  return {
    server,
    clients: members,
    links,
    /** Sync every client until nothing is outstanding anywhere. */
    async settle({ rounds = 4 } = {}) {
      for (let i = 0; i < rounds; i++) {
        for (const c of members) await c.syncUntilIdle();
      }
    },
    async close() {
      for (const c of members) await c.close();
      await server.close();
    },
  };
}

/** Assert every client shows the same value for a collection. */
export function assertSameView(clients, collection, project = (v) => v) {
  const views = clients.map((c) =>
    JSON.stringify(c.list(collection, { sort: (a, b) => (a.id < b.id ? -1 : 1) }).map(project)));
  for (let i = 1; i < views.length; i++) {
    if (views[i] !== views[0]) {
      throw new Error(
        `replicas diverged on "${collection}"\n` +
        `  ${clients[0].label}: ${views[0]}\n  ${clients[i].label}: ${views[i]}`);
    }
  }
  return JSON.parse(views[0]);
}
