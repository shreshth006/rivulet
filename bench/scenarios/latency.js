/**
 * @file Time to converge on each network profile, against a naive baseline.
 *
 * Bytes saved only matter if they become time saved. This measures the
 * end-to-end question a user actually experiences: an edit is made on one
 * device -- how long until it is visible on another?
 *
 * The baseline is not modelled. It is the same engine, the same protocol, the
 * same simulated link, with the operation codec swapped for plain JSON. So the
 * difference between the two rows is attributable to the encoding and nothing
 * else.
 *
 * Two regimes show up, and they are the reason both parts of the design exist:
 *
 * - On a **high-bandwidth, high-latency** link (satellite), bytes barely
 *   matter and the win comes from carrying push and pull in one round trip.
 * - On a **bandwidth-capped** link (edge), transmission time dominates and the
 *   win comes almost entirely from the codec.
 */

import { buildCluster, converged } from '#bench/netsim/harness';
import { notebookSchema } from '../../test/helpers/fixtures.js';
import { naiveCodec } from '#bench/lib/baseline';
import { PROFILE_ORDER, PROFILES, formatBandwidth } from '#bench/netsim/profiles';
import { Report, fmt, median } from '#bench/lib/report';

/**
 * One run: replica 0 types a note, everyone converges.
 * @returns {Promise<{elapsedMs:number, bytes:number, requests:number, converged:boolean}>}
 */
async function runOnce({ profile, codec, compress, seed, chars = 300, clients = 2 }) {
  const cluster = await buildCluster({
    schema: notebookSchema, clients, profile, seed, codec, compress,
    sync: { batching: { initial: 64, max: 500 } },
  });

  try {
    const [author] = cluster.clients;
    const id = author.mutate((tx) => tx.create('notes', { title: 'Shared note', body: '' }));
    // Typed in bursts, as a person types: several operations per sync.
    let text = '';
    const burst = 'the wifi drops every evening around nine. ';
    while (text.length < chars) {
      text += burst;
      author.mutate((tx) => tx.setText('notes', id, 'body', text.slice(0, chars)));
    }

    const result = await cluster.converge({ maxSimMs: 15 * 60_000 });
    const net = cluster.network;
    return {
      elapsedMs: result.elapsedMs,
      bytes: net.totalBytes,
      requests: net.requests,
      rounds: result.rounds,
      converged: result.converged && converged(cluster.clients, 'notes'),
    };
  } finally {
    await cluster.close();
  }
}

export async function run({ seed = 1, chars = 300, repeats = 5 } = {}) {
  const report = new Report('latency',
    'Time for an edit on one device to become visible on another.');

  const rows = [];
  for (const name of PROFILE_ORDER) {
    const profile = PROFILES[name];
    const mine = [];
    const base = [];
    for (let i = 0; i < repeats; i++) {
      const s = seed + i * 1013;
      mine.push(await runOnce({ profile, seed: s, chars }));
      // The naive stack: plain JSON operations, no transport compression.
      base.push(await runOnce({ profile, seed: s, chars, codec: naiveCodec, compress: false }));
    }

    const mineMs = median(mine.map((r) => r.elapsedMs));
    const baseMs = median(base.map((r) => r.elapsedMs));
    const mineBytes = median(mine.map((r) => r.bytes));
    const baseBytes = median(base.map((r) => r.bytes));

    rows.push({
      profile: profile.name,
      rtt: profile.rttMs,
      bandwidth: formatBandwidth(profile.bandwidthBps),
      baseMs,
      mineMs,
      speedup: baseMs / Math.max(1, mineMs),
      baseBytes,
      mineBytes,
      byteSaving: 1 - mineBytes / baseBytes,
      requests: Math.round(median(mine.map((r) => r.requests))),
      ok: mine.every((r) => r.converged) && base.every((r) => r.converged),
    });
  }

  report.add('Convergence time and traffic, two replicas', {
    columns: [
      { key: 'profile', label: 'Profile', align: 'left' },
      { key: 'rtt', label: 'RTT', format: (n) => `${n} ms` },
      { key: 'bandwidth', label: 'Bandwidth', align: 'left' },
      { key: 'baseMs', label: 'Baseline', format: fmt.ms },
      { key: 'mineMs', label: 'This work', format: fmt.ms },
      { key: 'speedup', label: 'Speed-up', format: fmt.ratio },
      { key: 'baseBytes', label: 'Baseline B', format: fmt.bytes },
      { key: 'mineBytes', label: 'This work B', format: fmt.bytes },
      { key: 'byteSaving', label: 'Bytes saved', format: fmt.pct },
      { key: 'ok', label: 'Converged', format: (v) => (v ? 'yes' : 'NO') },
    ],
    rows,
  }, `Median of ${repeats} seeds. Baseline is the identical engine with `
   + 'plain-JSON operations and no compression, over the identical simulated '
   + 'link. Times are simulated, not wall-clock.');

  return report;
}

export const meta = {
  name: 'latency',
  description: 'Convergence time across network profiles, versus a naive baseline',
};
