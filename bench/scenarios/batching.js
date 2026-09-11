/**
 * @file Does adapting the batch size actually beat picking a good constant?
 *
 * A fixed batch size has to be chosen for some assumed network, and the
 * assumption is wrong somewhere. Small batches waste round trips on a
 * high-latency link; large ones produce requests that a flaky link cannot
 * finish, so they time out and retry from the beginning.
 *
 * This runs the same bulk transfer at several fixed sizes and with the
 * adaptive controller, on networks that punish opposite mistakes. The
 * adaptive controller is not expected to beat the best constant for a given
 * network -- the interesting claim is weaker and more useful: it should come
 * close to the best on every network, without being told which one it is on.
 *
 * Every configuration is run over several seeds and reported as a median. On a
 * lossy profile a single run can be decided by whether one timeout happened to
 * land inside an outage window, and reporting that would be reporting noise.
 */

import { buildCluster, converged } from '#bench/netsim/harness';
import { notebookSchema } from '../../test/helpers/fixtures.js';
import { Report, fmt, median } from '#bench/lib/report';

async function runOnce({ profile, batching, seed, documents = 120 }) {
  const cluster = await buildCluster({
    schema: notebookSchema, clients: 2, profile, seed, sync: { batching },
  });

  try {
    const [author, receiver] = cluster.clients;
    for (let i = 0; i < documents; i++) {
      author.mutate((tx) => tx.create('notes', {
        title: `document ${i}`,
        body: 'a short paragraph of body text for this document',
        tags: ['bulk'],
      }));
    }

    const started = cluster.clock.now;
    const result = await cluster.converge({ maxSimMs: 30 * 60_000 });
    return {
      elapsedMs: cluster.clock.now - started,
      bytes: cluster.network.totalBytes,
      requests: cluster.network.requests,
      retries: cluster.network.lostUplink + cluster.network.lostDownlink
        + cluster.network.interrupted + cluster.network.timedOut + cluster.network.refused,
      finalBatch: author.engine.batchSize,
      ok: result.converged && converged([author, receiver], 'notes'),
    };
  } finally {
    await cluster.close();
  }
}

export async function run({ seed = 11, repeats = 5 } = {}) {
  const report = new Report('batching',
    'Adaptive batch sizing against fixed sizes, on networks that punish opposite mistakes.');

  const strategies = [
    ['fixed 8', { initial: 8, min: 8, max: 8 }],
    ['fixed 64', { initial: 64, min: 64, max: 64 }],
    ['fixed 512', { initial: 512, min: 512, max: 512 }],
    ['fixed 2000', { initial: 2000, min: 2000, max: 2000 }],
    ['adaptive', { initial: 64, min: 8, max: 2000 }],
  ];

  for (const profileName of ['satellite', 'mobileEdge', 'hostelWifi']) {
    const rows = [];
    for (const [label, batching] of strategies) {
      const runs = [];
      for (let i = 0; i < repeats; i++) {
        runs.push(await runOnce({ profile: profileName, batching, seed: seed + i * 1013 }));
      }
      const times = runs.map((r) => r.elapsedMs);
      rows.push({
        strategy: label,
        elapsedMs: median(times),
        spreadMs: Math.max(...times) - Math.min(...times),
        requests: Math.round(median(runs.map((r) => r.requests))),
        retries: Math.round(median(runs.map((r) => r.retries))),
        bytes: Math.round(median(runs.map((r) => r.bytes))),
        finalBatch: label === 'adaptive' ? Math.round(median(runs.map((r) => r.finalBatch))) : null,
        ok: runs.every((r) => r.ok),
      });
    }

    const fixed = rows.filter((r) => r.strategy !== 'adaptive');
    const best = Math.min(...fixed.map((r) => r.elapsedMs));
    const worst = Math.max(...fixed.map((r) => r.elapsedMs));
    const adaptive = rows.find((r) => r.strategy === 'adaptive');
    for (const row of rows) row.vsBest = row.elapsedMs / best;

    report.add(`Bulk transfer on ${profileName}`, {
      columns: [
        { key: 'strategy', label: 'Strategy', align: 'left' },
        { key: 'elapsedMs', label: 'Time (median)', format: fmt.ms },
        { key: 'spreadMs', label: 'Spread', format: fmt.ms },
        { key: 'vsBest', label: 'vs best fixed', format: fmt.ratio },
        { key: 'requests', label: 'Requests', format: fmt.int },
        { key: 'retries', label: 'Failed rounds', format: fmt.int },
        { key: 'bytes', label: 'Traffic', format: fmt.bytes },
        { key: 'finalBatch', label: 'Settled at', format: (n) => (n ? String(n) : '-') },
        { key: 'ok', label: 'Converged', format: (v) => (v ? 'yes' : 'NO') },
      ],
      rows,
    }, `Median of ${repeats} seeds. `
     + `Adaptive: ${fmt.ratio(adaptive.elapsedMs / best)} of the best fixed size `
     + `(which had to be chosen knowing the network), against ${fmt.ratio(worst / best)} `
     + 'for the worst fixed choice. The claim being tested is not that adapting '
     + 'beats a well-chosen constant -- it does not -- but that it stays close '
     + 'to the best on every network without being told which one it is on.');
  }

  return report;
}

export const meta = { name: 'batching', description: 'Adaptive versus fixed batch sizing' };
