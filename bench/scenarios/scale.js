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
 * not. **Sync request size when idle** is the pure metadata cost: a version
 * vector grows linearly with replica count, and a replica that is fully caught
 * up sends nothing but that vector.
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

    // The pure metadata cost: what a fully caught-up replica still has to send.
    const idleFrame = await packMessage(syncMessage({
      node: author.node, room: 'bench', have: author.log.frontier(), limit: 500,
    }));

    return {
      elapsedMs: cluster.clock.now - started,
      bytes: net.totalBytes,
      bytesPerReplica: net.totalBytes / replicas,
      requests: net.requests,
      idleBytes: idleFrame.wireBytes,
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
      idleBytes: r.idleBytes,
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
      { key: 'idleBytes', label: 'Idle sync', format: (n) => `${n} B` },
      { key: 'requests', label: 'Requests', format: fmt.int },
      { key: 'ok', label: 'Converged', format: (v) => (v ? 'yes' : 'NO') },
    ],
    rows,
  }, '"Idle sync" is one request from a fully caught-up replica: version '
   + 'vector only, no operations. It is the per-replica metadata floor, and '
   + 'the number that would eventually limit how widely a document can be '
   + 'shared before polling alone becomes expensive.');

  return report;
}

export const meta = { name: 'scale', description: 'Cost as replica count grows' };
