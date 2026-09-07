/**
 * @file Builds a simulated cluster: one server, N clients, one link each,
 * all on a shared virtual clock.
 *
 * Every benchmark needs the same setup, and getting it subtly wrong -- a
 * client on real timers, a shared random stream between links -- silently
 * invalidates results. So it is written once, here.
 */

import { SyncServer } from '#server/engine';
import { RivuletClient } from '#client/client';
import { LoopbackTransport } from '#client/transport';
import { MemoryAdapter } from '#storage/adapter';
import { VirtualClock } from '#bench/netsim/clock';
import { SimulatedLink } from '#bench/netsim/link';
import { profile as getProfile } from '#bench/netsim/profiles';
import { nodeIdFromLabel } from '#core/ids';

/**
 * @param {object} opts
 * @param {import('#core/schema').Schema} opts.schema
 * @param {number} [opts.clients]
 * @param {string|object} [opts.profile] profile name or object
 * @param {number} [opts.seed]
 * @param {object} [opts.sync] sync engine options
 */
export async function buildCluster({
  schema, clients = 2, profile = 'lan', seed = 1, room = 'bench',
  sync: syncOpts, autoStart = false,
}) {
  const net = typeof profile === 'string' ? getProfile(profile) : profile;
  const clock = new VirtualClock();

  const server = new SyncServer({
    storage: async () => new MemoryAdapter(),
    schema: schema.fingerprint,
    node: nodeIdFromLabel('bench-server'),
  });

  const members = [];
  for (let i = 0; i < clients; i++) {
    // Each link gets its own generator, so adding a client does not perturb
    // the random stream the others see.
    const link = new SimulatedLink({ profile: net, clock, seed: seed * 1000 + i });
    const node = nodeIdFromLabel(`${room}-client-${i}`);
    const transport = new LoopbackTransport(server, { node, room, link: link.hook });

    const client = await RivuletClient.open({
      schema, room, node, transport,
      storage: new MemoryAdapter({ name: `bench-${i}` }),
      // Never during open: starting the engine performs a handshake over the
      // simulated link, which cannot complete until something drives the
      // clock -- and nothing can, while open() is still being awaited.
      autoStart: false,
      // The engine must use simulated time for backoff and polling, or the
      // benchmark would wait in real seconds for a simulated retry.
      physical: clock.readonly,
      sync: { timers: clock.timers, pollMs: 1e9, debounceMs: 1e9, ...syncOpts },
    });
    client.label = `c${i}`;
    client.link = link;
    members.push(client);
  }

  // Start every engine together, driving the clock so their handshakes can
  // complete against the simulated link.
  if (autoStart) {
    await clock.drive(Promise.all(members.map((c) => c.engine.start())));
  } else {
    // Engines must still be running for syncs to be attempted; start them
    // without the initial handshake round by marking them started and letting
    // the first explicit sync do the work.
    await clock.drive(Promise.all(members.map((c) => c.engine.start())));
  }

  return {
    clock, server, net,
    clients: members,
    links: members.map((c) => c.link),

    /** Total bytes moved across every link. */
    get bytes() {
      return members.reduce((total, c) => total + c.link.summary.totalBytes, 0);
    },

    /** Combined link statistics. */
    get network() {
      const out = { requests: 0, delivered: 0, lostUplink: 0, lostDownlink: 0, refused: 0, bytesUp: 0, bytesDown: 0 };
      for (const c of members) for (const k of Object.keys(out)) out[k] += c.link.stats[k];
      return { ...out, totalBytes: out.bytesUp + out.bytesDown };
    },

    /**
     * Drive every client to convergence, letting simulated time pass between
     * attempts so backoff and outages behave as they would in the field.
     * @returns {Promise<{converged: boolean, elapsedMs: number, rounds: number}>}
     */
    async converge({ maxSimMs = 10 * 60_000, quietPasses = 2 } = {}) {
      const started = clock.now;
      let rounds = 0;
      let quiet = 0;

      for (let attempt = 0; attempt < 500; attempt++) {
        // Clients sync in parallel, as they would in reality -- which is also
        // what exercises the server's concurrent-append path.
        const jobs = members.map((c) => c.syncUntilIdle({ maxRounds: 200 }));
        const results = await clock.drive(Promise.all(jobs), { budgetMs: maxSimMs });

        const idle = results.every((r) => !r.error && r.pushed === 0 && r.pulled === 0);
        rounds += results.reduce((n, r) => n + r.rounds, 0);

        // Two consecutive quiet passes, because one client's pull can create
        // work for another: a single quiet pass does not mean settled.
        quiet = idle ? quiet + 1 : 0;
        if (quiet >= quietPasses) {
          return { converged: true, elapsedMs: clock.now - started, rounds };
        }
        if (clock.now - started > maxSimMs) break;
        // Let simulated time move, so a link inside an outage window leaves it
        // and a backoff timer gets a chance to fire.
        await clock.advance(idle ? 1000 : 250);
      }
      return { converged: false, elapsedMs: clock.now - started, rounds };
    },

    async close() {
      for (const c of members) await c.close();
      await server.close();
    },
  };
}

/** True when every client shows byte-identical state for a collection. */
export function converged(clients, collection) {
  const view = (c) => JSON.stringify(
    c.list(collection, { sort: (a, b) => (a.id < b.id ? -1 : 1) }));
  const first = view(clients[0]);
  return clients.every((c) => view(c) === first);
}
