/**
 * @file What does convergence cost in memory, and can it be reclaimed?
 *
 * CRDTs buy coordination-free merging with metadata. A deleted character is
 * not freed, it becomes a tombstone; a removed set member leaves a retired
 * tag. On a server that is an operational cost. On a phone it is the
 * difference between an app that stays usable for a year and one that has to
 * be reinstalled.
 *
 * Heavy editing is the case that matters, because that is where tombstones
 * accumulate fastest: a document rewritten many times can carry far more
 * deleted characters than live ones. So this measures the ratio directly, and
 * then measures what garbage collection actually recovers.
 *
 * No network is involved -- this is a property of the data structures.
 */

import { makeDb } from '../../test/helpers/fixtures.js';
import { Report, fmt } from '#bench/lib/report';
import { makeRng, randInt } from '#core/util';
import { encodeOps } from '#protocol/codec';

const jsonBytes = (v) => JSON.stringify(v).length;

/** Rewrite a note's body repeatedly, as a person revising a draft would. */
function heavyTextEditing({ revisions, seed }) {
  const rng = makeRng(seed);
  const db = makeDb('editor');
  const id = db.mutate((tx) => tx.create('notes', { title: 'draft', body: '' })).result;

  const sentences = [
    'the wifi drops every evening around nine. ',
    'nobody knows why the router is behind reception. ',
    'we reset it from the app instead. ',
    'the landlord says it is fine. ',
  ];

  const allOps = [];
  let text = '';
  for (let i = 0; i < revisions; i++) {
    // Grow, then cut a chunk out of the middle: the pattern that produces
    // tombstones fastest.
    text += sentences[i % sentences.length];
    if (text.length > 120) {
      const at = randInt(rng, 0, Math.max(0, text.length - 60));
      text = text.slice(0, at) + text.slice(at + randInt(rng, 20, 60));
    }
    allOps.push(...db.mutate((tx) => tx.setText('notes', id, 'body', text)).ops);
  }

  const rga = db.document('notes', id).crdt('body');
  return { db, id, ops: allOps.length, allOps, rga, text };
}

export async function run({ seed = 7, sizes = [50, 200, 800, 2000] } = {}) {
  const report = new Report('overhead',
    'Memory cost of convergence metadata, and what collection reclaims.');

  // Each rewrite walks the sequence, so generating a case is quadratic in the
  // number of revisions. Generate each one once and derive every table from it.
  const cases = sizes.map((revisions) => ({ revisions, ...heavyTextEditing({ revisions, seed }) }));

  /* ------------------------------------------- tombstone accumulation */

  const rows = cases.map(({ revisions, rga, ops, text }) => {
    const stats = rga.stats;
    const stateBytes = jsonBytes(rga);
    return {
      revisions,
      ops,
      live: stats.live,
      tombstones: stats.tombstones,
      ratio: stats.tombstones / Math.max(1, stats.live),
      stateBytes,
      perLiveChar: stateBytes / Math.max(1, text.length),
    };
  });

  report.add('Tombstone accumulation under repeated rewriting', {
    columns: [
      { key: 'revisions', label: 'Revisions', format: fmt.int },
      { key: 'ops', label: 'Operations', format: fmt.int },
      { key: 'live', label: 'Live chars', format: fmt.int },
      { key: 'tombstones', label: 'Tombstones', format: fmt.int },
      { key: 'ratio', label: 'Tomb/live', format: fmt.ratio },
      { key: 'stateBytes', label: 'State', format: fmt.bytes },
      { key: 'perLiveChar', label: 'Bytes/live char', format: (n) => `${n.toFixed(0)} B` },
    ],
    rows,
  }, 'A deliberately hostile workload: a short field rewritten over and over, '
   + 'so almost every character written is later deleted. It is an upper bound '
   + 'on tombstone growth, not a typical document. The ratio is the honest '
   + 'cost of position-free editing -- deleted characters must be retained '
   + 'while any replica might still anchor an insert on them -- and the row '
   + 'below shows what collection reclaims.');

  /* ---------------------------------------------------- what gc recovers */

  // Destructive, so it runs last -- the tables above measure the uncollected
  // state, which is what a replica actually carries between stability points.
  const gcRows = cases.map((c) => {
    const { revisions, rga, db, id } = c;
    const beforeBytes = jsonBytes(rga);
    const textBefore = rga.text;
    c.plainBefore = jsonBytes(db.snapshot({ compact: false }));
    c.snapshotBefore = jsonBytes(db.snapshot());

    // In a single-replica measurement everything held is causally stable; in a
    // cluster the bound comes from the slowest peer's frontier.
    const reclaimed = rga.gc(db.clock.peek());
    const redirects = rga.dropRedirects();
    const afterBytes = jsonBytes(rga);
    c.plainAfter = jsonBytes(db.snapshot({ compact: false }));
    c.snapshotAfter = jsonBytes(db.snapshot());

    return {
      revisions,
      beforeBytes,
      afterBytes,
      reclaimed,
      redirects,
      saving: 1 - afterBytes / beforeBytes,
      textIntact: db.document('notes', id).get('body') === textBefore,
    };
  });

  report.add('Garbage collection at a causally stable point', {
    columns: [
      { key: 'revisions', label: 'Revisions', format: fmt.int },
      { key: 'beforeBytes', label: 'Before', format: fmt.bytes },
      { key: 'afterBytes', label: 'After', format: fmt.bytes },
      { key: 'reclaimed', label: 'Tombstones freed', format: fmt.int },
      { key: 'saving', label: 'Reduction', format: fmt.pct },
      { key: 'textIntact', label: 'Text intact', format: (v) => (v ? 'yes' : 'NO') },
    ],
    rows: gcRows,
  }, 'Collection is only safe below a timestamp every replica has seen. '
   + 'Operations that still name a collected tombstone are rebased onto its '
   + 'surviving neighbour, so a late arrival converges rather than dangling.');

  /* -------------------------------- log versus compacted snapshot */

  const compaction = cases.map((c) => {
    const logBytes = jsonBytes(encodeOps(c.allOps));
    return {
      revisions: c.revisions,
      operations: c.ops,
      logBytes,
      plainBefore: c.plainBefore,
      snapshotBefore: c.snapshotBefore,
      snapshotAfter: c.snapshotAfter,
      vsLog: 1 - c.snapshotAfter / Math.max(1, logBytes),
      uncollectedVsLog: 1 - c.snapshotBefore / Math.max(1, logBytes),
    };
  });

  report.add('Bootstrap cost: operation log versus snapshot', {
    columns: [
      { key: 'revisions', label: 'Revisions', format: fmt.int },
      { key: 'operations', label: 'Operations', format: fmt.int },
      { key: 'logBytes', label: 'Encoded log', format: fmt.bytes },
      { key: 'plainBefore', label: 'Plain snapshot (uncollected)', format: fmt.bytes },
      { key: 'snapshotBefore', label: 'Snapshot (uncollected)', format: fmt.bytes },
      { key: 'uncollectedVsLog', label: 'vs log', format: fmt.pct },
      { key: 'snapshotAfter', label: 'Snapshot (collected)', format: fmt.bytes },
      { key: 'vsLog', label: 'Collected vs log', format: fmt.pct },
    ],
    rows: compaction,
  }, 'The plain snapshot stores every element identifier in full, so before '
   + 'collection it is no smaller than the encoded log -- slightly larger. The '
   + 'compact format interns those identifiers into one timestamp table and '
   + 'stores sequences as columns, which makes even an uncollected snapshot '
   + 'cheaper than the log. Collected, the snapshot is what a new device '
   + 'should download.');

  /* ------------------------------------------ what interning buys */

  report.add('Snapshot interning: plain versus compact', {
    columns: [
      { key: 'revisions', label: 'Revisions', format: fmt.int },
      { key: 'plainBefore', label: 'Plain (uncollected)', format: fmt.bytes },
      { key: 'snapshotBefore', label: 'Compact (uncollected)', format: fmt.bytes },
      { key: 'savingBefore', label: 'Saving', format: fmt.pct },
      { key: 'plainAfter', label: 'Plain (collected)', format: fmt.bytes },
      { key: 'snapshotAfter', label: 'Compact (collected)', format: fmt.bytes },
      { key: 'savingAfter', label: 'Saving', format: fmt.pct },
    ],
    rows: cases.map((c) => ({
      revisions: c.revisions,
      plainBefore: c.plainBefore,
      snapshotBefore: c.snapshotBefore,
      savingBefore: 1 - c.snapshotBefore / Math.max(1, c.plainBefore),
      plainAfter: c.plainAfter,
      snapshotAfter: c.snapshotAfter,
      savingAfter: 1 - c.snapshotAfter / Math.max(1, c.plainAfter),
    })),
  }, 'Both forms hold identical state and expand to the same CRDTs; the compact '
   + 'one is what `snapshot()` writes. Neither is DEFLATEd here, to match the '
   + 'log column above.');

  return report;
}

export const meta = { name: 'overhead', description: 'CRDT metadata cost and reclamation' };
