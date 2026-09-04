/**
 * @file The shared example domain: a shared notebook.
 *
 * Every field type earns its place here. `title` is last-writer-wins because a
 * rename is atomic and the newest one is the one people mean. `body` is text so
 * two people typing in different paragraphs both keep their work. `tags` is a
 * set because offline tagging is common and losing a tag to someone else's
 * stale delete is infuriating. `reads` is a counter because increments from
 * several devices must add up. `estimate` is multi-value because a silently
 * discarded number is worse than a question.
 */

import { defineSchema } from '#core/schema';
import { Database } from '#core/database';
import { nodeIdFromLabel } from '#core/ids';

export const notebookSchema = defineSchema({
  notes: {
    title: 'lww',
    body: 'text',
    tags: 'set',
    reads: 'counter',
    estimate: 'mv',
    pinned: 'boolean',
    checklist: 'seq',   // an ordered list of items, not text
  },
  folders: {
    name: 'lww',
    noteIds: 'set',
  },
});

/** A database whose replica id and clock are deterministic. */
export function makeDb(label, { schema = notebookSchema, start = 1_700_000_000_000 } = {}) {
  let t = start;
  const db = new Database({
    schema,
    node: nodeIdFromLabel(label),
    physical: () => t,
  });
  db.advance = (ms) => { t += ms; };
  db.label = label;
  return db;
}

/** Push every operation from `from` into `into`, as a sync round would. */
export function deliver(ops, ...targets) {
  for (const db of targets) db.applyAll(ops);
  return ops;
}

/** Exchange all operations between databases pairwise. */
export function syncAll(pairs) {
  for (const { db, ops } of pairs) {
    for (const other of pairs) {
      if (other.db !== db) other.db.applyAll(ops);
    }
  }
}
