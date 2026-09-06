/**
 * @file Workload generators.
 *
 * Synthetic benchmarks are only as honest as their workloads. Measuring
 * compression on a stream of identical operations would produce a spectacular
 * ratio that says nothing. These are shaped to match what the engine actually
 * carries, and each one isolates a different cost:
 *
 * - `typing` is the dominant real pattern: long runs of single-character
 *   inserts chained onto each other, which is precisely what back-references
 *   are designed for. It is the best case, and labelled as such.
 * - `formFilling` is the opposite: scattered single writes to unrelated
 *   documents, with nothing to intern and nothing to chain. The worst case.
 * - `bulkImport` is a first sync, dominated by document identifiers.
 * - `collaborative` mixes all field types across several replicas, and is the
 *   closest thing here to an average.
 *
 * Reporting all four is the point. Quoting only `typing` would be choosing the
 * number that flatters the design.
 */

import { makeDb } from '../../test/helpers/fixtures.js';
import { makeRng, randInt, pick } from '#core/util';

const WORDS = ('the wifi drops every evening around nine and nobody knows why the router '
  + 'sits behind reception where nobody can reach it so we reset it from the app instead')
  .split(' ');

/** Sentence of roughly `words` words, deterministic given the generator. */
function sentence(rng, words = 12) {
  return Array.from({ length: words }, () => pick(rng, WORDS)).join(' ');
}

/**
 * @typedef {object} Workload
 * @property {string} name
 * @property {string} description
 * @property {object[]} ops
 * @property {object} db the database that produced them
 */

/** Sustained typing into one note: the pattern the codec is tuned for. */
export function typing({ chars = 400, seed = 1 } = {}) {
  const rng = makeRng(seed);
  const db = makeDb('typist');
  const id = db.mutate((tx) => tx.create('notes', { title: 'Meeting notes', body: '' })).result;

  const ops = [];
  let text = '';
  while (text.length < chars) {
    text += `${sentence(rng, randInt(rng, 6, 14))}. `;
    ops.push(...db.mutate((tx) => tx.setText('notes', id, 'body', text.slice(0, chars))).ops);
  }
  return { name: 'typing', description: 'Sustained typing into one note (best case)', ops, db };
}

/** Scattered single-field writes across many documents: nothing to exploit. */
export function formFilling({ documents = 60, seed = 2 } = {}) {
  const rng = makeRng(seed);
  const db = makeDb('forms');
  const ids = [];
  const ops = [];
  for (let i = 0; i < documents; i++) {
    const r = db.mutate((tx) => tx.create('notes', { title: `record ${i}` }));
    ids.push(r.result);
    ops.push(...r.ops);
  }
  // One isolated edit per document, in random order: no locality at all.
  for (const id of ids) {
    ops.push(...db.mutate((tx) => tx.set('notes', id, 'pinned', rng() < 0.5)).ops);
  }
  return {
    name: 'form-filling',
    description: 'Scattered single writes to unrelated documents (worst case)',
    ops, db,
  };
}

/** A first sync: many documents created at once. */
export function bulkImport({ documents = 200, seed = 3 } = {}) {
  const rng = makeRng(seed);
  const db = makeDb('importer');
  const ops = [];
  for (let i = 0; i < documents; i++) {
    ops.push(...db.mutate((tx) => tx.create('notes', {
      title: sentence(rng, 4),
      body: sentence(rng, randInt(rng, 10, 25)),
      tags: [pick(rng, ['infra', 'todo', 'idea', 'urgent'])],
    })).ops);
  }
  return { name: 'bulk-import', description: 'Initial import of a document set', ops, db };
}

/** Several replicas editing shared documents across every field type. */
export function collaborative({ documents = 20, edits = 300, replicas = 4, seed = 4 } = {}) {
  const rng = makeRng(seed);
  const dbs = Array.from({ length: replicas }, (_, i) => makeDb(`collab-${i}`));
  const [primary] = dbs;

  const ops = [];
  const ids = [];
  for (let i = 0; i < documents; i++) {
    const r = primary.mutate((tx) => tx.create('notes', {
      title: sentence(rng, 4), body: sentence(rng, 10), tags: ['shared'],
    }));
    ids.push(r.result);
    ops.push(...r.ops);
  }
  // Every replica starts from the same base, so later edits are genuinely
  // concurrent rather than trivially ordered.
  for (const db of dbs.slice(1)) db.applyAll(ops);

  for (let i = 0; i < edits; i++) {
    const db = pick(rng, dbs);
    const id = pick(rng, ids);
    const r = db.mutate((tx) => {
      switch (randInt(rng, 0, 5)) {
        case 0: return tx.set('notes', id, 'title', sentence(rng, 3));
        case 1: return tx.setText('notes', id, 'body', `${db.get('notes', id)?.body ?? ''} ${pick(rng, WORDS)}`);
        case 2: return tx.add('notes', id, 'tags', pick(rng, ['a', 'b', 'c', 'd', 'e']));
        case 3: return tx.increment('notes', id, 'reads', randInt(rng, 1, 3));
        case 4: return tx.set('notes', id, 'estimate', randInt(rng, 1, 500));
        default: return tx.set('notes', id, 'pinned', rng() < 0.5);
      }
    });
    ops.push(...r.ops);
  }
  return {
    name: 'collaborative',
    description: `${replicas} replicas editing ${documents} shared documents`,
    ops, db: primary, dbs, ids,
  };
}

/** Every workload, in reporting order. */
export function allWorkloads(opts = {}) {
  return [typing(opts), formFilling(opts), bulkImport(opts), collaborative(opts)];
}
