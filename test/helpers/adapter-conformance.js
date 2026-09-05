/**
 * @file One conformance suite, run against every storage adapter.
 *
 * Three adapters back the same engine in three environments. If they disagree
 * about anything -- how a duplicate append is counted, where a frontier stops,
 * whether a bounded pull is resumable -- the bug shows up as a sync failure on
 * one platform only, which is the worst kind to debug.
 *
 * So the behaviour is specified once, here, and each adapter is held to it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './fixtures.js';
import { makeRng, shuffled } from '#core/util';

/**
 * Build `count` operations from one replica, numbered 1..count.
 * Starting at 1 matters: the frontier is defined as the contiguous prefix from
 * 1, so a fixture that skipped the first sequence number would make every
 * adapter look like it had a permanent gap.
 */
function sampleOps(label, count) {
  const db = makeDb(label);
  const created = db.mutate((tx) => tx.create('notes', { title: 'seed' }));
  const ops = [...created.ops];
  let text = '';
  while (ops.length < count) {
    text += 'x';
    ops.push(...db.mutate((tx) => tx.setText('notes', created.result, 'body', text)).ops);
  }
  const slice = ops.slice(0, count);
  assert.deepEqual(slice.map((o) => o.seq), Array.from({ length: count }, (_, i) => i + 1));
  return { db, id: created.result, ops: slice };
}

/**
 * @param {string} name
 * @param {() => Promise<object>} factory fresh, unopened adapter
 * @param {{ compaction?: boolean }} [caps]
 */
export function runAdapterConformance(name, factory, { compaction = false } = {}) {
  const withAdapter = async (fn) => {
    const adapter = await factory();
    await adapter.open();
    try { await fn(adapter); } finally { await adapter.close(); }
  };

  test(`${name}: append returns how many operations were new`, async () => {
    await withAdapter(async (a) => {
      const { ops } = sampleOps('a', 10);
      assert.equal(await a.appendOps(ops), 10);
      assert.equal(await a.appendOps(ops), 0, 're-appending must be a no-op');
      assert.equal(await a.appendOps(ops.slice(0, 5)), 0);
      assert.equal(await a.countOps(), 10);
    });
  });

  test(`${name}: appends are order-independent and de-duplicate`, async () => {
    await withAdapter(async (a) => {
      const { ops } = sampleOps('a', 20);
      const rng = makeRng(4);
      // Deliver shuffled, in overlapping batches, as a flaky link would.
      for (let i = 0; i < 4; i++) await a.appendOps(shuffled(rng, ops).slice(0, 12));
      await a.appendOps(ops);
      assert.equal(await a.countOps(), 20);
      const stored = await a.readOps();
      assert.deepEqual(stored.map((o) => o.seq), ops.map((o) => o.seq).sort((x, y) => x - y));
    });
  });

  test(`${name}: operations round-trip with their payloads intact`, async () => {
    await withAdapter(async (a) => {
      const db = makeDb('a');
      const id = db.mutate((tx) => tx.create('notes', {
        title: 'round trip', body: 'hi', tags: ['x'], reads: 3, estimate: 42,
      })).result;
      const { ops } = db.mutate((tx) => tx.update('notes', id, { title: 'changed', tags: ['y'] }));
      await a.appendOps(ops);

      const stored = await a.readOps({ node: db.node, fromSeq: ops[0].seq - 1 });
      assert.deepEqual(stored.slice(0, ops.length), ops);
    });
  });

  test(`${name}: opsSince returns exactly what a peer is missing`, async () => {
    await withAdapter(async (a) => {
      const { db, ops } = sampleOps('a', 30);
      await a.appendOps(ops);

      const all = await a.opsSince({});
      assert.equal(all.ops.length, 30);
      assert.equal(all.more, false);

      const partial = await a.opsSince({ [db.node]: ops[9].seq });
      assert.equal(partial.ops.length, 20);
      assert.equal(partial.ops[0].seq, ops[10].seq);

      const caughtUp = await a.opsSince({ [db.node]: ops.at(-1).seq });
      assert.deepEqual(caughtUp, { ops: [], more: false });
    });
  });

  test(`${name}: a bounded pull is resumable and loses nothing`, async () => {
    await withAdapter(async (a) => {
      const { db, ops } = sampleOps('a', 47);
      await a.appendOps(ops);

      const collected = [];
      let cursor = {};
      let rounds = 0;
      for (;;) {
        const page = await a.opsSince(cursor, { limit: 10 });
        collected.push(...page.ops);
        // Advance the cursor the way a client does: by what it now holds.
        for (const op of page.ops) cursor[op.node] = Math.max(cursor[op.node] ?? 0, op.seq);
        rounds++;
        if (!page.more) break;
        assert.ok(rounds < 20, 'pull must terminate');
      }
      assert.equal(collected.length, 47);
      assert.equal(new Set(collected.map((o) => `${o.node}:${o.seq}`)).size, 47, 'no duplicates');
      assert.equal(rounds, 5);
    });
  });

  test(`${name}: opsSince can exclude a replica's own operations`, async () => {
    await withAdapter(async (a) => {
      const one = sampleOps('a', 6), two = sampleOps('b', 6);
      await a.appendOps([...one.ops, ...two.ops]);
      const { ops } = await a.opsSince({}, { exclude: one.db.node });
      assert.equal(ops.length, 6);
      assert.ok(ops.every((op) => op.node === two.db.node));
    });
  });

  test(`${name}: frontier stops at a gap; maxSeqs does not`, async () => {
    await withAdapter(async (a) => {
      const { db, ops } = sampleOps('a', 12);
      // Withhold one operation, as a truncated transfer would.
      await a.appendOps(ops.filter((op) => op.seq !== ops[4].seq));

      const frontier = await a.frontier();
      assert.equal(frontier[db.node], ops[3].seq, 'must not advertise past the hole');
      assert.equal((await a.maxSeqs())[db.node], ops.at(-1).seq);

      await a.appendOps([ops[4]]);
      assert.equal((await a.frontier())[db.node], ops.at(-1).seq, 'filling the gap advances the frontier');
    });
  });

  test(`${name}: seqRanges reports held sequences compactly`, async () => {
    await withAdapter(async (a) => {
      const { db, ops } = sampleOps('a', 10);
      const withHole = ops.filter((op) => op.seq !== ops[5].seq);
      await a.appendOps(withHole);

      const ranges = (await a.seqRanges())[db.node];
      assert.equal(ranges.length, 2, 'one hole means two ranges');
      assert.equal(ranges[0][1] + 2, ranges[1][0]);
    });
  });

  test(`${name}: several replicas are tracked independently`, async () => {
    await withAdapter(async (a) => {
      const one = sampleOps('a', 8), two = sampleOps('b', 5), three = sampleOps('c', 3);
      await a.appendOps([...two.ops, ...one.ops, ...three.ops]);
      assert.equal(await a.countOps(), 16);

      const frontier = await a.frontier();
      assert.equal(Object.keys(frontier).length, 3);

      const missing = await a.opsSince({ [one.db.node]: one.ops.at(-1).seq });
      assert.equal(missing.ops.length, 8);
      assert.ok(missing.ops.every((op) => op.node !== one.db.node));
    });
  });

  test(`${name}: hasOp answers precisely`, async () => {
    await withAdapter(async (a) => {
      const { db, ops } = sampleOps('a', 5);
      await a.appendOps(ops);
      assert.equal(await a.hasOp(db.node, ops[0].seq), true);
      assert.equal(await a.hasOp(db.node, ops.at(-1).seq + 1), false);
      assert.equal(await a.hasOp('0'.repeat(16), 1), false);
    });
  });

  test(`${name}: metadata persists, updates and deletes`, async () => {
    await withAdapter(async (a) => {
      assert.equal(await a.getMeta('missing'), undefined);
      await a.setMeta('cursor', { node: 'x', seq: 4 });
      assert.deepEqual(await a.getMeta('cursor'), { node: 'x', seq: 4 });
      await a.setMeta('cursor', 7);
      assert.equal(await a.getMeta('cursor'), 7);
      await a.setMeta('cursor', undefined);
      assert.equal(await a.getMeta('cursor'), undefined);
      await a.setMeta('flag', false);
      assert.equal(await a.getMeta('flag'), false, 'falsy values must survive');
    });
  });

  test(`${name}: clear empties the store`, async () => {
    await withAdapter(async (a) => {
      await a.appendOps(sampleOps('a', 5).ops);
      await a.setMeta('k', 1);
      await a.clear();
      assert.equal(await a.countOps(), 0);
      assert.equal(await a.getMeta('k'), undefined);
      assert.deepEqual(await a.frontier(), {});
    });
  });

  test(`${name}: rejects malformed operations before storing them`, async () => {
    await withAdapter(async (a) => {
      const { ops } = sampleOps('a', 2);
      await assert.rejects(() => a.appendOps([{ ...ops[0], seq: 0 }]), /positive integer/);
      await assert.rejects(() => a.appendOps([{ ...ops[0], node: 'nope' }]), /malformed node id/);
      assert.equal(await a.countOps(), 0, 'nothing partial is written');
    });
  });

  test(`${name}: using a closed adapter is an error, not a silent no-op`, async () => {
    const a = await factory();
    await a.open();
    await a.close();
    await assert.rejects(() => a.countOps(), /not open/);
  });

  if (compaction) {
    test(`${name}: compaction truncates the covered prefix and keeps the snapshot`, async () => {
      await withAdapter(async (a) => {
        const { db, ops } = sampleOps('a', 20);
        await a.appendOps(ops);
        const upTo = { [db.node]: ops[14].seq };

        await a.saveSnapshot({ hello: 'state' }, upTo);
        assert.equal(await a.truncateBelow(upTo), 15);
        assert.equal(await a.countOps(), 5);

        const snap = await a.latestSnapshot();
        assert.deepEqual(snap.state, { hello: 'state' });
        assert.deepEqual(snap.frontier, upTo);

        const rest = await a.opsSince(upTo);
        assert.equal(rest.ops.length, 5, 'operations after the snapshot are still servable');
      });
    });
  }
}
