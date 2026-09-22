import test from 'node:test';
import assert from 'node:assert/strict';
import { LWWRegister, MVRegister, PNCounter, ORSet, RGA } from '#core/crdt/index';
import { checkAllLaws, checkConvergence, replicas, assertConverged } from './helpers/crdt-laws.js';
import { randInt, pick } from '#core/util';

test('LWWRegister obeys the CRDT laws', () => {
  checkAllLaws({
    factory: () => new LWWRegister(),
    genOp: (_rep, rng) => LWWRegister.op(randInt(rng, 0, 5)),
  });
});

test('MVRegister obeys the CRDT laws', () => {
  checkAllLaws({
    factory: () => new MVRegister(),
    genOp: (rep, rng) => rep.crdt.op(randInt(rng, 0, 5)),
    project: (c) => c.values,
  });
});

test('PNCounter obeys the CRDT laws (idempotence is the op log\'s job)', () => {
  checkAllLaws({
    factory: () => new PNCounter(),
    genOp: (_rep, rng) => PNCounter.op(randInt(rng, -3, 5)),
    idempotent: false,
  });
});

test('ORSet obeys the CRDT laws', () => {
  checkAllLaws({
    factory: () => new ORSet(),
    genOp: (rep, rng) => {
      const el = pick(rng, ['a', 'b', 'c', 'd']);
      return rng() < 0.55 ? ORSet.op(el) : rep.crdt.op(el);
    },
  });
});

test('RGA converges under arbitrary delivery order', () => {
  checkConvergence({
    factory: () => new RGA(),
    replicas: 4,
    opsPerReplica: 10,
    trials: 30,
    genOp: (rep, rng) => {
      const ids = rep.crdt.ids();
      if (ids.length > 2 && rng() < 0.3) return RGA.deleteOp(pick(rng, ids));
      const after = ids.length && rng() < 0.8 ? pick(rng, ids) : undefined;
      return RGA.insertOp(pick(rng, [...'abcdefg']), after);
    },
    project: (c) => c.text,
  });
});

test('LWW keeps the highest timestamp regardless of arrival order', () => {
  const [a, b] = replicas(2, () => new LWWRegister());
  const early = a.emit(() => LWWRegister.op('first'));
  const late = b.emit(() => LWWRegister.op('second'));

  b.receive(early);
  a.receive(late);
  const winner = late.meta.ts > early.meta.ts ? 'second' : 'first';
  assert.equal(a.crdt.value, winner);
  assertConverged([a, b]);

  // A straggler older than what we hold is ignored outright.
  const stale = { payload: LWWRegister.op('stale'), meta: { ts: '000000000000-0000-' + '0'.repeat(16), node: a.node, seq: 99 } };
  assert.equal(a.crdt.apply(stale.payload, stale.meta), false);
  assert.equal(a.crdt.value, winner);
});

test('LWWRegister hasValue and isInitialized reflect content state', () => {
  const reg = new LWWRegister();
  assert.equal(reg.hasValue, false);
  assert.equal(reg.isInitialized, false);

  const [a] = replicas(1, () => reg);
  a.emit(() => LWWRegister.op('hello'));
  assert.equal(reg.hasValue, true);
  assert.equal(reg.isInitialized, true);
  assert.equal(reg.value, 'hello');
});

test('MVRegister surfaces concurrent writes and collapses once one is seen', () => {
  const [a, b] = replicas(2, () => new MVRegister());
  const wa = a.emit((c) => c.op('from-a'));
  const wb = b.emit((c) => c.op('from-b'));
  a.receive(wb); b.receive(wa);

  assert.ok(a.crdt.hasConflict, 'concurrent writes must both survive');
  assert.deepEqual(a.crdt.values.sort(), ['from-a', 'from-b']);
  assertConverged([a, b], (c) => c.values);

  // A resolving write, made after seeing both, replaces them.
  const resolve = a.emit((c) => c.op('resolved'));
  b.receive(resolve);
  assert.equal(a.crdt.hasConflict, false);
  assert.deepEqual(b.crdt.values, ['resolved']);
});

test('MVRegister size, isEmpty and hasValue reflect conflict state', () => {
  const reg = new MVRegister();
  assert.equal(reg.isEmpty, true);
  assert.equal(reg.size, 0);
  assert.equal(reg.hasValue('x'), false);

  const [a, b] = replicas(2, () => new MVRegister());
  const wa = a.emit((c) => c.op('first'));
  const wb = b.emit((c) => c.op('second'));
  a.receive(wb);

  assert.equal(a.crdt.size, 2);
  assert.equal(a.crdt.isEmpty, false);
  assert.equal(a.crdt.hasValue('first'), true);
  assert.equal(a.crdt.hasValue('second'), true);
  assert.equal(a.crdt.hasValue('third'), false);
});

test('PNCounter adds concurrent increments instead of overwriting', () => {
  const [a, b, c] = replicas(3, () => new PNCounter());
  const oa = a.emit(() => PNCounter.op(1));
  const ob = b.emit(() => PNCounter.op(1));
  const oc = c.emit(() => PNCounter.op(-3));

  for (const [rep, ops] of [[a, [ob, oc]], [b, [oa, oc]], [c, [oa, ob]]]) {
    for (const op of ops) rep.receive(op);
  }
  assert.equal(a.crdt.value, -1, 'two +1s and one -3 must total -1, not -3');
  assertConverged([a, b, c]);
  assert.equal(a.crdt.contributions.length, 3);
});

test('PNCounter resetOp cancels current value to zero', () => {
  const [a] = replicas(1, () => new PNCounter());
  assert.equal(a.crdt.isZero, true);

  a.emit(() => PNCounter.op(42));
  assert.equal(a.crdt.value, 42);
  assert.equal(a.crdt.isZero, false);

  a.emit((c) => c.resetOp());
  assert.equal(a.crdt.value, 0);
  assert.equal(a.crdt.isZero, true);
});

test('ORSet is add-wins and supports re-adding a removed element', () => {
  const [a, b] = replicas(2, () => new ORSet());
  const add = a.emit(() => ORSet.op('x'));
  b.receive(add);

  // Concurrent: a removes the tag it saw, b adds a fresh one.
  const rm = a.emit((c) => c.op('x'));
  const readd = b.emit(() => ORSet.op('x'));
  a.receive(readd); b.receive(rm);

  assert.ok(a.crdt.has('x'), 'an add the remover never saw must survive');
  assertConverged([a, b]);

  // Sequential remove after seeing everything does take effect.
  const rm2 = a.emit((c) => c.op('x'));
  b.receive(rm2);
  assert.equal(a.crdt.has('x'), false);
  assert.equal(b.crdt.has('x'), false);
});

test('ORSet handles object members by value', () => {
  const [a, b] = replicas(2, () => new ORSet());
  const add = a.emit(() => ORSet.op({ id: 1, tag: 'urgent' }));
  b.receive(add);
  assert.ok(b.crdt.has({ tag: 'urgent', id: 1 }), 'key order must not matter');
  const rm = b.emit((c) => c.op({ id: 1, tag: 'urgent' }));
  a.receive(rm);
  assert.equal(a.crdt.size, 0);
  assert.equal(a.crdt.isEmpty, true);
});

test('ORSet clearOps generates removes for all observed elements', () => {
  const [a] = replicas(1, () => new ORSet());
  assert.equal(a.crdt.isEmpty, true);

  a.receive(a.emit(() => ORSet.op('apple')));
  a.receive(a.emit(() => ORSet.op('banana')));
  assert.equal(a.crdt.size, 2);
  assert.equal(a.crdt.isEmpty, false);

  const clearOps = a.crdt.clearOps();
  assert.equal(clearOps.length, 2);
  for (const op of clearOps) {
    a.receive(a.emit(() => op));
  }
  assert.equal(a.crdt.size, 0);
  assert.equal(a.crdt.isEmpty, true);
});
