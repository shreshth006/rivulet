import test from 'node:test';
import assert from 'node:assert/strict';
import { OpLog } from '#storage/oplog';
import { MemoryAdapter } from '#storage/adapter';
import { SqliteAdapter } from '#storage/sqlite';
import { makeDb } from '../../test/helpers/fixtures.js';
import { makeRng, shuffled } from '#core/util';
import { newNodeId } from '#core/ids';

async function openLog(adapter = new MemoryAdapter()) {
  return new OpLog(adapter).open();
}

/** `count` operations from one replica, numbered 1..count. */
function sample(label, count) {
  const db = makeDb(label);
  const created = db.mutate((tx) => tx.create('notes', { title: 'seed' }));
  const ops = [...created.ops];
  let text = '';
  while (ops.length < count) {
    text += 'x';
    ops.push(...db.mutate((tx) => tx.setText('notes', created.result, 'body', text)).ops);
  }
  return { db, ops: ops.slice(0, count) };
}

test('append reports exactly which operations were new', async () => {
  const log = await openLog();
  const { ops } = sample('a', 10);

  const first = await log.append(ops);
  assert.equal(first.added, 10);
  assert.equal(first.fresh.length, 10);

  const again = await log.append(ops);
  assert.deepEqual({ added: again.added, fresh: again.fresh.length, dup: again.duplicates },
    { added: 0, fresh: 0, dup: 10 });

  const overlap = await log.append([...ops.slice(5), ...sample('b', 3).ops]);
  assert.equal(overlap.fresh.length, 3, 'only the genuinely new ones come back');
  assert.equal(overlap.duplicates, 5);
});

test('the fresh set is what makes non-idempotent CRDTs safe', async () => {
  const log = await openLog();
  const db = makeDb('a');
  const id = db.mutate((tx) => tx.create('notes', { title: 'counted' })).result;
  const { ops } = db.mutate((tx) => tx.increment('notes', id, 'reads', 5));
  await log.append(ops);

  // A replica receiving the same push three times must apply it once.
  const replica = makeDb('b');
  const replicaLog = await openLog();
  for (let i = 0; i < 3; i++) {
    const { fresh } = await replicaLog.append(ops);
    replica.applyAll(fresh);
  }
  assert.equal(replica.get('notes', id).reads, 5, 'a resend must not double-count');
});

test('the frontier advances only across contiguous sequences', async () => {
  const log = await openLog();
  const { db, ops } = sample('a', 12);

  await log.append(ops.filter((op) => op.seq !== 5));
  assert.equal(log.frontier().get(db.node), 4, 'must stop at the hole');
  assert.deepEqual(log.gaps()[db.node], [[5, 5]]);
  assert.equal(log.heads()[db.node], 12, 'heads still knows the highest held');
  assert.ok(log.stats.fragmented);

  await log.append([ops[4]]);
  assert.equal(log.frontier().get(db.node), 12);
  assert.deepEqual(log.gaps(), {});
  assert.equal(log.stats.fragmented, false);
});

test('delta returns what a peer lacks, and is resumable', async () => {
  const log = await openLog();
  const { db, ops } = sample('a', 25);
  await log.append(ops);

  const all = await log.delta(log.frontier().constructor.fromJSON({}));
  assert.equal(all.ops.length, 25);

  const cursor = {};
  const collected = [];
  for (;;) {
    const page = await log.delta(cursor, { limit: 7 });
    collected.push(...page.ops);
    for (const op of page.ops) cursor[op.node] = op.seq;
    if (!page.more) break;
  }
  assert.equal(collected.length, 25);
  assert.equal((await log.delta({ [db.node]: 25 })).ops.length, 0);
});

test('the outbox is derived from one watermark and survives a restart', async () => {
  const adapter = new SqliteAdapter({ path: ':memory:' });
  const log = await openLog(adapter);
  const { db, ops } = sample('a', 10);
  await log.append(ops);

  assert.equal((await log.outbox(db.node)).length, 10);
  assert.equal(await log.outboxSize(db.node), 10);

  await log.markPushed(6);
  assert.equal((await log.outbox(db.node)).length, 4);
  assert.equal((await log.outbox(db.node))[0].seq, 7);

  // A late or duplicated ack must never rewind the watermark.
  await log.markPushed(3);
  assert.equal(await log.pushedSeq(), 6);

  // Reopen against the same adapter: the watermark and the log both persist.
  const reopened = await new OpLog(adapter).open();
  assert.equal(await reopened.pushedSeq(), 6);
  assert.equal((await reopened.outbox(db.node)).length, 4);
  assert.equal(reopened.frontier().get(db.node), 10);
});

test('the frontier is rebuilt from the store, not from a cached summary', async () => {
  const adapter = new SqliteAdapter({ path: ':memory:' });
  const log = await openLog(adapter);
  const { db, ops } = sample('a', 9);
  // Write straight through the adapter, as a crashed process might have.
  await adapter.appendOps(ops.filter((op) => op.seq !== 4));

  const reopened = await new OpLog(adapter).open();
  assert.equal(reopened.frontier().get(db.node), 3, 'a gap on disk must be seen on restart');
  assert.deepEqual(reopened.gaps()[db.node], [[4, 4]]);
  await log.close();
});

test('identity is minted once and then reused', async () => {
  const adapter = new MemoryAdapter();
  const log = await openLog(adapter);
  const first = await log.identity(newNodeId);
  const second = await log.identity(() => { throw new Error('must not re-mint'); });
  assert.equal(first, second);

  const reopened = await new OpLog(adapter).open();
  assert.equal(await reopened.identity(newNodeId), first,
    're-minting would restart sequence numbers and orphan our own history');
});

test('resume points let a restart continue the clock and the counter', async () => {
  const adapter = new MemoryAdapter();
  const log = await openLog(adapter);
  const { db, ops } = sample('a', 6);
  await log.append(ops);
  await log.recordTimestamp(ops.at(-1).ts);
  await log.recordTimestamp(ops[0].ts); // older: must not lower the mark

  const reopened = await new OpLog(adapter).open();
  const point = await reopened.resumePoint(db.node);
  assert.equal(point.seq, 6);
  assert.equal(point.lastTs, ops.at(-1).ts);
});

test('schema changes are detected across restarts', async () => {
  const adapter = new MemoryAdapter();
  const log = await openLog(adapter);
  assert.equal(await log.checkSchema('v1'), 'first-run');
  assert.equal(await log.checkSchema('v1'), 'match');
  assert.equal(await log.checkSchema('v2'), 'changed');
  await log.acceptSchema('v2');
  assert.equal(await log.checkSchema('v2'), 'match');
});

test('the server frontier is remembered so idle syncs stay cheap', async () => {
  const log = await openLog();
  const { db, ops } = sample('a', 4);
  await log.append(ops);
  await log.setServerFrontier(log.frontier());
  assert.equal((await log.serverFrontier()).get(db.node), 4);
});

test('compaction snapshots the covered prefix and truncates it', async () => {
  const adapter = new SqliteAdapter({ path: ':memory:' });
  const log = await openLog(adapter);
  const { db, ops } = sample('a', 20);
  await log.append(ops);

  const events = [];
  log.on('compact', (e) => events.push(e));
  const removed = await log.compact({ state: 'materialised' }, { [db.node]: 12 });

  assert.equal(removed, 12);
  assert.equal(await log.count(), 8);
  assert.equal(events.length, 1);

  const snap = await log.latestSnapshot();
  assert.deepEqual(snap.state, { state: 'materialised' });

  // The log still knows it holds the truncated prefix, so it will not ask a
  // peer to resend its own history.
  assert.equal(log.frontier().get(db.node), 20);
  assert.equal((await log.delta({ [db.node]: 12 })).ops.length, 8);
});

test('compaction is refused by adapters that cannot do it', async () => {
  const log = await openLog(new MemoryAdapter());
  await assert.rejects(() => log.compact({}, {}), /does not support compaction/);
});

test('append emits the fresh operations for fan-out', async () => {
  const log = await openLog();
  const seen = [];
  log.on('append', ({ ops }) => seen.push(...ops));
  const { ops } = sample('a', 5);
  await log.append(ops);
  await log.append(ops);
  assert.equal(seen.length, 5, 'duplicates must not be re-broadcast');
});

test('shuffled, overlapping delivery converges on the same log', async () => {
  const rng = makeRng(77);
  const a = sample('a', 15), b = sample('b', 12), c = sample('c', 9);
  const everything = [...a.ops, ...b.ops, ...c.ops];

  const log = await openLog();
  for (let round = 0; round < 6; round++) {
    await log.append(shuffled(rng, everything).slice(0, 20));
  }
  await log.append(everything);

  assert.equal(await log.count(), 36);
  const f = log.frontier();
  assert.equal(f.get(a.db.node), 15);
  assert.equal(f.get(b.db.node), 12);
  assert.equal(f.get(c.db.node), 9);
  assert.deepEqual(log.gaps(), {});
});

test('a closed log refuses work instead of failing obscurely', async () => {
  const log = await openLog();
  await log.close();
  assert.throws(() => log.frontier(), /not open/);
  await assert.rejects(() => log.count(), /not open/);
});

test('vacuum delegates to adapter if supported and returns status', async () => {
  const memLog = await openLog(new MemoryAdapter());
  const memResult = await memLog.vacuum();
  assert.equal(memResult, false);

  const sqliteLog = await openLog(new SqliteAdapter({ path: ':memory:' }));
  const sqliteResult = await sqliteLog.vacuum();
  assert.equal(sqliteResult, true);
  await sqliteLog.close();
});

test('canCompact reflects adapter capabilities accurately', async () => {
  const memLog = await openLog(new MemoryAdapter());
  assert.equal(memLog.canCompact, false);

  const sqliteLog = await openLog(new SqliteAdapter({ path: ':memory:' }));
  assert.equal(sqliteLog.canCompact, true);
  await sqliteLog.close();
});

test('exportOps and importOps allow full round-trip of log history', async () => {
  const source = await openLog();
  const { ops } = sample('a', 8);
  await source.append(ops);

  const exported = await source.exportOps();
  assert.equal(exported.length, 8);
  assert.equal(exported[0].node, ops[0].node);

  const target = await openLog();
  const result = await target.importOps(exported);
  assert.equal(result.added, 8);
  assert.equal(await target.count(), 8);

  const dupe = await target.importOps(exported);
  assert.equal(dupe.added, 0);
  assert.equal(dupe.duplicates, 8);
});

test('deleteMeta and hasMeta manage custom metadata entries', async () => {
  const log = await openLog();
  assert.equal(await log.hasMeta('custom_key'), false);

  await log.setMeta('custom_key', { foo: 'bar' });
  assert.equal(await log.hasMeta('custom_key'), true);
  assert.deepEqual(await log.getMeta('custom_key'), { foo: 'bar' });

  await log.deleteMeta('custom_key');
  assert.equal(await log.hasMeta('custom_key'), false);
  assert.equal(await log.getMeta('custom_key'), undefined);
});

test('exportJson and importJson serialize and restore operations', async () => {
  const logA = await openLog();
  const { ops } = sample('a', 5);
  await logA.append(ops);

  const json = await logA.exportJson({ indent: 2 });
  assert.equal(typeof json, 'string');
  assert.ok(json.includes(ops[0].node));

  const logB = await openLog();
  const res = await logB.importJson(json);
  assert.equal(res.added, 5);
  assert.equal(await logB.count(), 5);

  // Rejects invalid JSON and non-arrays
  await assert.rejects(() => logB.importJson('{not valid json'), /invalid JSON/);
  await assert.rejects(() => logB.importJson('{"not": "array"}'), /must be an array/);
});





