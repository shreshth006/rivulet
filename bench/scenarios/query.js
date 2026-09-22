/**
 * @file How fast are local in-memory queries and filtering?
 *
 * Measures database query throughput for primary key reads, filtered scans,
 * projections, and sorting over varying working set sizes.
 */

import { makeDb } from '../../test/helpers/fixtures.js';
import { Report, fmt } from '#bench/lib/report';
import { makeRng, randInt } from '#core/util';

export async function run({ seed = 42, docCounts = [100, 500, 1000] } = {}) {
  const report = new Report('query',
    'Throughput of document queries, filtering, projection and sorting.');

  const rows = [];
  for (const count of docCounts) {
    const rng = makeRng(seed);
    const db = makeDb('query-bench');

    // Seed database
    const ids = [];
    for (let i = 0; i < count; i++) {
      const res = db.mutate((tx) => tx.create('notes', {
        title: `Note ${i.toString().padStart(4, '0')}`,
        body: `Body content for note ${i} with some extra text padding`,
        reads: randInt(rng, 0, 100),
        tags: [i % 2 === 0 ? 'even' : 'odd', `cat-${i % 5}`],
        pinned: i % 10 === 0,
      }));
      ids.push(res.result);
    }

    const iterations = 1000;

    // 1. Primary key lookup
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) {
      const id = ids[i % count];
      db.get('notes', id);
    }
    const pkUs = ((performance.now() - t0) / iterations) * 1000;

    // 2. Unfiltered list
    const t1 = performance.now();
    const listIter = Math.max(50, Math.floor(iterations / (count / 50)));
    for (let i = 0; i < listIter; i++) {
      db.list('notes');
    }
    const listMs = (performance.now() - t1) / listIter;

    // 3. Filtered query ($gt reads)
    const t2 = performance.now();
    for (let i = 0; i < listIter; i++) {
      db.list('notes', { where: { reads: { $gt: 50 } } });
    }
    const filterMs = (performance.now() - t2) / listIter;

    // 4. Projection
    const t3 = performance.now();
    for (let i = 0; i < listIter; i++) {
      db.list('notes', { select: ['title', 'reads'] });
    }
    const projectMs = (performance.now() - t3) / listIter;

    // 5. Sorted list
    const t4 = performance.now();
    for (let i = 0; i < listIter; i++) {
      db.list('notes', { sort: '-reads' });
    }
    const sortMs = (performance.now() - t4) / listIter;

    rows.push({
      count,
      pkLookupUs: pkUs,
      listMs,
      filterMs,
      projectMs,
      sortMs,
    });
  }

  report.add('Query latency across dataset sizes', {
    columns: [
      { key: 'count', label: 'Docs', format: fmt.int },
      { key: 'pkLookupUs', label: 'get(id)', format: (n) => `${n.toFixed(2)} µs` },
      { key: 'listMs', label: 'list()', format: (n) => `${n.toFixed(3)} ms` },
      { key: 'filterMs', label: 'filter $gt', format: (n) => `${n.toFixed(3)} ms` },
      { key: 'projectMs', label: 'project', format: (n) => `${n.toFixed(3)} ms` },
      { key: 'sortMs', label: 'sort desc', format: (n) => `${n.toFixed(3)} ms` },
    ],
    rows,
  }, 'All queries run purely in memory against materialised CRDT documents.');

  return report;
}

export const meta = { name: 'query', description: 'Query, filter, projection and sorting latency' };
