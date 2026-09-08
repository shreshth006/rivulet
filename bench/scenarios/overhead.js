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

  let ops = 0;
  let text = '';
  for (let i = 0; i < revisions; i++) {
    // Grow, then cut a chunk out of the middle: the pattern that produces
    // tombstones fastest.
    text += sentences[i % sentences.length];
    if (text.length > 120) {
      const at = randInt(rng, 0, Math.max(0, text.length - 60));
      text = text.slice(0, at) + text.slice(at + randInt(rng, 20, 60));
    }
    ops += db.mutate((tx) => tx.setText('notes', id, 'body', text)).ops.length;
  }

  const rga = db.document('notes', id).crdt('body');
  return { db, id, ops, rga, text };
}

export async function run({ seed = 7 } = {}) {
  const report = new Report('overhead',
    'Memory cost of convergence metadata, and what collection reclaims.');

  /* ------------------------------------------- tombstone accumulation */

  const rows = [];
  for (const revisions of [50, 200, 800, 3200]) {
    const { rga, ops, text } = heavyTextEditing({ revisions, seed });
    const stats = rga.stats;
    const stateBytes = jsonBytes(rga);

    rows.push({
      revisions,
      ops,
      live: stats.live,
      tombstones: stats.tombstones,
      ratio: stats.tombstones / Math.max(1, stats.live),
      stateBytes,
      perLiveChar: stateBytes / Math.max(1, text.length),
    });
  }

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
  }, 'A single text field rewritten repeatedly. The ratio is the honest cost '
   + 'of position-free editing: deleted characters must be retained while any '
   + 'replica might still anchor an insert on them.');

  /* ---------------------------------------------------- what gc recovers */

  const gcRows = [];
  for (const revisions of [200, 800, 3200]) {
    const { rga, db, id } = heavyTextEditing({ revisions, seed });
    const before = { bytes: jsonBytes(rga), ...rga.stats };

    // Everything this replica holds is causally stable in a single-replica
    // measurement; in a cluster the bound comes from the slowest peer.
    const stable = db.clock.peek();
    const reclaimed = rga.gc(stable);
    const dropped = rga.dropRedirects();
    const after = { bytes: jsonBytes(rga), ...rga.stats };

    gcRows.push({
      revisions,
      beforeBytes: before.bytes,
      afterBytes: after.bytes,
      reclaimed,
      saving: 1 - after.bytes / before.bytes,
      redirects: dropped,
      textIntact: db.document('notes', id).get('body').length === rga.text.length,
    });
  }

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

  /* ------------------------------------------- log versus materialised state */

  const compaction = [];
  for (const revisions of [200, 800, 3200]) {
    const { db, ops } = heavyTextEditing({ revisions, seed });
    const log = await db.list('notes');
    const allOps = [];
    // Re-derive the operation log size as the storage layer would hold it.
    const { ops: produced } = db.mutate((tx) => tx.set('notes', db.list('notes')[0].id, 'pinned', true));
    allOps.push(...produced);

    const snapshot = db.snapshot();
    compaction.push({
      revisions,
      operations: ops,
      logBytes: ops * (jsonBytes(encodeOps(allOps)) / Math.max(1, allOps.length)),
      snapshotBytes: jsonBytes(snapshot),
      documents: log.length,
    });
  }

  report.add('Operation log versus compacted snapshot', {
    columns: [
      { key: 'revisions', label: 'Revisions', format: fmt.int },
      { key: 'operations', label: 'Operations', format: fmt.int },
      { key: 'logBytes', label: 'Log (est.)', format: fmt.bytes },
      { key: 'snapshotBytes', label: 'Snapshot', format: fmt.bytes },
    ],
    rows: compaction,
  }, 'Why compaction exists: the log grows with every edit ever made, while a '
   + 'snapshot grows only with surviving state. A replica bootstrapping from a '
   + 'snapshot pays the second, not the first.');

  return report;
}

export const meta = { name: 'overhead', description: 'CRDT metadata cost and reclamation' };
