/**
 * @file What does an offline period cost when the network comes back?
 *
 * This is the scenario the whole design exists for. A group edits the same
 * documents while disconnected for minutes or hours, then reconnects. Three
 * questions decide whether the system is usable:
 *
 * 1. **Does it converge at all?** Every run is checked for byte-identical
 *    state across replicas, not merely for finishing without error.
 * 2. **How long does reconciliation take?** If a five-minute outage needs a
 *    five-minute catch-up, the system is unusable on a link that drops every
 *    few minutes -- catch-up must be far cheaper than the outage.
 * 3. **Is work lost?** Counted directly: every edit made offline is checked
 *    for in the converged state.
 */

import { buildCluster, converged } from '#bench/netsim/harness';
import { notebookSchema } from '../../test/helpers/fixtures.js';
import { Report, fmt } from '#bench/lib/report';
import { makeRng, randInt, pick } from '#core/util';

/**
 * Edit while disconnected, recording what must survive.
 *
 * Only edits with a *defined* survival requirement are recorded. A set add and
 * a text insertion must both be present in the converged state -- those are
 * the operations that exist so nothing is lost. A last-writer-wins title
 * write is deliberately excluded: one of two concurrent titles is supposed to
 * disappear, and counting that as loss would make the benchmark measure the
 * wrong thing. Counter increments are verified in aggregate instead, since
 * their guarantee is about the total, not about any one operation.
 */
function editOffline(client, ids, rng, edits) {
  const tags = [];      // must appear in the document's tag set
  const bodyMarks = []; // must appear in the document's text
  let increments = 0;

  for (let i = 0; i < edits; i++) {
    const id = pick(rng, ids);
    const mark = `${client.label}-${i}`;
    switch (randInt(rng, 0, 3)) {
      case 0:
        client.mutate((tx) => tx.add('notes', id, 'tags', mark));
        tags.push({ id, mark });
        break;
      case 1:
        client.mutate((tx) => tx.increment('notes', id, 'reads', 1));
        increments++;
        break;
      case 2:
        client.mutate((tx) => tx.setText('notes', id, 'body',
          `${client.get('notes', id)?.body ?? ''} ${mark}`));
        bodyMarks.push({ id, mark });
        break;
      default:
        client.mutate((tx) => tx.set('notes', id, 'title', `by ${mark}`));
        break;
    }
  }
  return { tags, bodyMarks, increments, total: edits };
}

async function runOnce({ profile, clients, documents, editsEach, seed }) {
  const rng = makeRng(seed);
  const cluster = await buildCluster({
    schema: notebookSchema, clients, profile, seed,
    sync: { batching: { initial: 64, max: 500 } },
  });

  try {
    // Seed a shared document set and get everyone onto the same base.
    const [author] = cluster.clients;
    const ids = [];
    for (let i = 0; i < documents; i++) {
      ids.push(author.mutate((tx) => tx.create('notes', {
        title: `doc ${i}`, body: 'base', tags: [], reads: 0,
      })));
    }
    await cluster.converge();

    // Everyone disconnects and works.
    for (const c of cluster.clients) c.link.setOffline(true);
    const expected = { tags: [], bodyMarks: [], increments: 0, total: 0 };
    for (const c of cluster.clients) {
      const made = editOffline(c, ids, rng, editsEach);
      expected.tags.push(...made.tags);
      expected.bodyMarks.push(...made.bodyMarks);
      expected.increments += made.increments;
      expected.total += made.total;
    }

    // Offline edits are local and instant; only reconnection costs anything.
    for (const c of cluster.clients) c.link.reset();
    const reconnectedAt = cluster.clock.now;
    for (const c of cluster.clients) c.link.setOffline(false);

    const result = await cluster.converge({ maxSimMs: 30 * 60_000 });
    const net = cluster.network;

    // Verify nothing that was supposed to survive was dropped.
    const [first] = cluster.clients;
    let lost = 0;
    for (const { id, mark } of expected.tags) {
      if (!first.get('notes', id)?.tags.includes(mark)) lost++;
    }
    for (const { id, mark } of expected.bodyMarks) {
      if (!first.get('notes', id)?.body.includes(mark)) lost++;
    }
    // Concurrent increments must add up, not overwrite one another.
    const reads = ids.reduce((sum, id) => sum + (first.get('notes', id)?.reads ?? 0), 0);
    const countersOk = reads === expected.increments;

    return {
      catchUpMs: cluster.clock.now - reconnectedAt,
      bytes: net.totalBytes,
      requests: net.requests,
      operations: (await first.stats()).storedOps,
      converged: result.converged && converged(cluster.clients, 'notes'),
      lost,
      countersOk,
      verified: expected.tags.length + expected.bodyMarks.length,
      edits: expected.total,
    };
  } finally {
    await cluster.close();
  }
}

export async function run({ seed = 3 } = {}) {
  const report = new Report('partition',
    'Cost of reconciling after every replica has worked offline.');

  /* ------------------------------- how much offline work, at fixed size */

  const byVolume = [];
  for (const editsEach of [5, 25, 100, 400]) {
    const r = await runOnce({
      profile: 'hostelWifi', clients: 4, documents: 10, editsEach, seed,
    });
    byVolume.push({
      editsEach,
      totalEdits: r.edits,
      operations: r.operations,
      catchUpMs: r.catchUpMs,
      bytes: r.bytes,
      bytesPerEdit: r.bytes / r.edits,
      requests: r.requests,
      verified: r.verified,
      lost: r.lost,
      ok: r.converged && r.countersOk,
    });
  }

  report.add('Four replicas, ten shared documents, varying offline work', {
    columns: [
      { key: 'editsEach', label: 'Edits each', format: fmt.int },
      { key: 'totalEdits', label: 'Total edits', format: fmt.int },
      { key: 'operations', label: 'Operations', format: fmt.int },
      { key: 'catchUpMs', label: 'Catch-up', format: fmt.ms },
      { key: 'bytes', label: 'Traffic', format: fmt.bytes },
      { key: 'bytesPerEdit', label: 'Bytes/edit', format: (n) => `${n.toFixed(0)} B` },
      { key: 'requests', label: 'Requests', format: fmt.int },
      { key: 'verified', label: 'Checked', format: fmt.int },
      { key: 'lost', label: 'Lost', format: fmt.int },
      { key: 'ok', label: 'Correct', format: (v) => (v ? 'yes' : 'NO') },
    ],
    rows: byVolume,
  }, 'On the hostel-wifi profile. Catch-up is simulated time from reconnection '
   + 'to convergence, and excludes the outage itself. "Checked" counts the '
   + 'edits with a defined survival requirement -- set additions and text '
   + 'insertions -- each verified individually in the converged state; '
   + '"Correct" also requires every concurrent counter increment to have '
   + 'been summed rather than overwritten.');

  /* ------------------------------------- the same work on worse networks */

  const byNetwork = [];
  for (const profile of ['broadband', 'mobile3g', 'hostelWifi', 'mobileEdge']) {
    const r = await runOnce({ profile, clients: 4, documents: 10, editsEach: 100, seed });
    byNetwork.push({
      profile,
      catchUpMs: r.catchUpMs,
      bytes: r.bytes,
      requests: r.requests,
      verified: r.verified,
      lost: r.lost,
      ok: r.converged && r.countersOk,
    });
  }

  report.add('The same offline work, reconciled over different links', {
    columns: [
      { key: 'profile', label: 'Profile', align: 'left' },
      { key: 'catchUpMs', label: 'Catch-up', format: fmt.ms },
      { key: 'bytes', label: 'Traffic', format: fmt.bytes },
      { key: 'requests', label: 'Requests', format: fmt.int },
      { key: 'verified', label: 'Checked', format: fmt.int },
      { key: 'lost', label: 'Lost', format: fmt.int },
      { key: 'ok', label: 'Correct', format: (v) => (v ? 'yes' : 'NO') },
    ],
    rows: byNetwork,
  }, 'Four replicas, 100 edits each, made entirely offline. The edge profile '
   + 'includes recurring outages during the catch-up itself.');

  return report;
}

export const meta = {
  name: 'partition',
  description: 'Reconciliation cost after offline editing',
};
