/**
 * @file How does cost grow with the number of replicas?
 *
 * The metadata a CRDT system carries is per-replica: a version vector has an
 * entry per replica, and every operation is attributed to one. So the honest
 * question is whether that metadata stays a rounding error as a document is
 * shared more widely, or starts to dominate.
 *
 * Two things are watched. **Traffic per replica** should stay roughly flat --
 * each replica sends its own work and receives everyone else's, so total
 * traffic grows with the number of replicas but the per-replica share should
 * not. **Sync size when idle** is the pure metadata cost: a version vector
 * grows linearly with replica count, and a replica that is fully caught up
 * sends nothing but its frontier. With vector deltas (see `#protocol/messages`)
 * it sends only how that frontier differs from the last one the server
 * numbered, so the full-vector request is measured alongside for comparison.
 */

import { buildCluster, converged } from '#bench/netsim/harness';
import { notebookSchema } from '../../test/helpers/fixtures.js';
import { Report, fmt } from '#bench/lib/report';
import { sync as syncMessage } from '#protocol/messages';
import { packMessage } from '#protocol/framing';
import { makeRng, pick, randInt } from '#core/util';

async function runOnce({ replicas, editsEach, documents, profile, seed }) {
  const rng = makeRng(seed);
  const cluster = await buildCluster({
    schema: notebookSchema, clients: replicas, profile, seed,
    sync: { batching: { initial: 64, max: 500 } },
  });

  try {
    const [author] = cluster.clients;
    const ids = [];
    for (let i = 0; i < documents; i++) {
      ids.push(author.mutate((tx) => tx.create('notes', { title: `doc ${i}`, body: '', tags: [] })));
    }
    await cluster.converge();
    for (const c of cluster.clients) c.link.reset();

    const started = cluster.clock.now;
    for (const c of cluster.clients) {
      for (let i = 0; i < editsEach; i++) {
        const id = pick(rng, ids);
        c.mutate((tx) => (rng() < 0.5
          ? tx.add('notes', id, 'tags', `${c.label}-${i}`)
          : tx.increment('notes', id, 'reads', randInt(rng, 1, 3))));
      }
    }

    const result = await cluster.converge({ maxSimMs: 30 * 60_000 });
    const net = cluster.network;

    // The pure metadata cost: one real sync round from a fully caught-up
    // replica, both directions, as the engine actually sends it...
    author.link.reset();
    await cluster.clock.drive(author.sync());
    const idle = author.link.stats;
    // ...and the same request with the whole vector, as before vector deltas.
    const fullFrame = await packMessage(syncMessage({
      node: author.node, room: 'bench', have: author.log.frontier(), limit: 500,
      schema: notebookSchema.fingerprint,
    }));

    return {
      elapsedMs: cluster.clock.now - started,
      bytes: net.totalBytes,
      bytesPerReplica: net.totalBytes / replicas,
      requests: net.requests,
      idleUp: idle.bytesUp,
      idleDown: idle.bytesDown,
      fullVectorBytes: fullFrame.wireBytes,
      converged: result.converged && converged(cluster.clients, 'notes'),
    };
  } finally {
    await cluster.close();
  }
}

export async function run({ seed = 5, editsEach = 40, documents = 8 } = {}) {
  const report = new Report('scale',
    'Traffic and metadata cost as the number of replicas grows.');

  const rows = [];
  for (const replicas of [2, 4, 8, 16, 32]) {
    const r = await runOnce({ replicas, editsEach, documents, profile: 'broadband', seed });
    rows.push({
      replicas,
      edits: replicas * editsEach,
      elapsedMs: r.elapsedMs,
      bytes: r.bytes,
      bytesPerReplica: r.bytesPerReplica,
      bytesPerEdit: r.bytes / (replicas * editsEach),
      idleUp: r.idleUp,
      idleDown: r.idleDown,
      fullVectorBytes: r.fullVectorBytes,
      requests: r.requests,
      ok: r.converged,
    });
  }

  report.add(`Replicas each making ${editsEach} edits to ${documents} shared documents`, {
    columns: [
      { key: 'replicas', label: 'Replicas', format: fmt.int },
      { key: 'edits', label: 'Edits', format: fmt.int },
      { key: 'elapsedMs', label: 'Converge', format: fmt.ms },
      { key: 'bytes', label: 'Total', format: fmt.bytes },
      { key: 'bytesPerReplica', label: 'Per replica', format: fmt.bytes },
      { key: 'bytesPerEdit', label: 'Per edit', format: (n) => `${n.toFixed(0)} B` },
      { key: 'idleUp', label: 'Idle request', format: (n) => `${n} B` },
      { key: 'idleDown', label: 'Idle reply', format: (n) => `${n} B` },
      { key: 'fullVectorBytes', label: 'Full-vector request', format: (n) => `${n} B` },
      { key: 'requests', label: 'Requests', format: fmt.int },
      { key: 'ok', label: 'Converged', format: (v) => (v ? 'yes' : 'NO') },
    ],
    rows,
  }, '"Idle request" and "Idle reply" are one sync round from a fully '
   + 'caught-up replica: no operations, only frontiers. That is the metadata '
   + 'floor every poll pays. With vector deltas both are sent relative to the '
   + 'last frontier the server numbered, so they stay flat as the room grows; '
   + '"Full-vector request" is the same request carrying the whole vector, '
   + 'which is what it cost before.');

  return report;
}

export const meta = { name: 'scale', description: 'Cost as replica count grows' };
