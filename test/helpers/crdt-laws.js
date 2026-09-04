/**
 * @file A harness for checking the algebraic laws every CRDT here must obey.
 *
 * The claim "this converges" is not something unit tests with hand-picked
 * interleavings can establish -- the interesting failures live in orderings
 * nobody thought to write down. So instead we generate operations, deliver
 * them in many random permutations, and assert every replica lands on the same
 * value. A failing seed is printed and replays exactly, which turns a flaky
 * distributed bug into a deterministic one.
 *
 * Laws checked:
 *   commutativity  apply(a) then apply(b)  ==  apply(b) then apply(a)
 *   associativity  grouping of merges does not matter
 *   idempotence    re-applying an operation changes nothing (all but PN-counter,
 *                  which the operation log de-duplicates instead)
 *   convergence    any delivery order of the same operation set agrees
 *   snapshot parity  merging states  ==  replaying operations
 */

import assert from 'node:assert/strict';
import { makeRng, shuffled, stableStringify } from '#core/util';
import { HybridClock } from '#core/hlc';
import { nodeIdFromLabel } from '#core/ids';

/**
 * One replica: a CRDT instance plus the clock that stamps its local writes.
 */
export class Replica {
  /** @param {string} label @param {() => any} factory */
  constructor(label, factory, { physical } = {}) {
    this.label = label;
    this.node = nodeIdFromLabel(label);
    this.clock = new HybridClock({ node: this.node, physical, maxDriftMs: Infinity });
    this.crdt = factory();
    this.seq = 0;
  }

  /**
   * Issue a local operation. `build` receives the replica's own CRDT so types
   * whose payload depends on current state (MV-register, OR-Set removes) can
   * capture it.
   * @returns {{ payload: any, meta: import('#core/crdt/contract').OpMeta }}
   */
  emit(build) {
    const payload = build(this.crdt);
    const meta = { ts: this.clock.now(), node: this.node, seq: ++this.seq };
    this.crdt.apply(payload, meta);
    return { payload, meta };
  }

  /** Receive a remote operation, keeping the clock causally informed. */
  receive(op) {
    this.clock.observe(op.meta.ts);
    return this.crdt.apply(op.payload, op.meta);
  }

  /** Canonical form of the *visible* value, for cross-replica comparison. */
  view(project = (c) => c.value) { return stableStringify(project(this.crdt)); }
}

/** Build `n` replicas labelled r0, r1, ... sharing one factory. */
export function replicas(n, factory, opts) {
  return Array.from({ length: n }, (_, i) => new Replica(`r${i}`, factory, opts));
}

/** Assert every replica shows the same value, with a readable diff on failure. */
export function assertConverged(reps, project, context = '') {
  const views = reps.map((r) => r.view(project));
  const [first] = views;
  for (let i = 1; i < views.length; i++) {
    assert.equal(
      views[i], first,
      `replicas diverged${context ? ` (${context})` : ''}\n` +
      `  ${reps[0].label}: ${first}\n  ${reps[i].label}: ${views[i]}`,
    );
  }
  return JSON.parse(first);
}

/**
 * The core property: generate operations across replicas, then deliver the
 * whole set to every replica in an independently shuffled order. All must agree.
 *
 * @param {object} cfg
 * @param {() => any} cfg.factory fresh CRDT instance
 * @param {(rep: Replica, rng: () => number, step: number) => any} cfg.genOp payload builder
 * @param {number} [cfg.replicas]
 * @param {number} [cfg.opsPerReplica]
 * @param {number} [cfg.trials]
 * @param {number} [cfg.seed]
 * @param {(c:any)=>any} [cfg.project]
 */
export function checkConvergence({
  factory, genOp, replicas: n = 3, opsPerReplica = 12, trials = 40, seed = 1, project,
}) {
  for (let trial = 0; trial < trials; trial++) {
    const rng = makeRng(seed + trial * 7919);
    const authors = replicas(n, factory);

    // Phase 1: each replica works in isolation -- the offline period.
    /** @type {Array<{payload:any, meta:any}>} */
    const ops = [];
    for (let step = 0; step < opsPerReplica; step++) {
      for (const rep of authors) {
        const payload = genOp(rep, rng, step);
        if (payload === undefined) continue;
        const meta = { ts: rep.clock.now(), node: rep.node, seq: rep.seq + 1 };
        rep.seq++;
        rep.crdt.apply(payload, meta);
        ops.push({ payload, meta });
      }
    }

    // Phase 2: everyone comes back online and receives everything, in an order
    // unique to them, as a real network would deliver it.
    const observers = replicas(n, factory);
    for (const obs of observers) {
      for (const op of shuffled(rng, ops)) obs.receive(op);
    }

    assertConverged(observers, project, `seed=${seed + trial * 7919} trial=${trial}`);

    // Phase 3: the replicas that authored operations must also match, once each
    // has seen every operation it did not write itself.
    for (const rep of authors) {
      for (const op of shuffled(rng, ops)) {
        if (op.meta.node !== rep.node) rep.receive(op);
      }
    }
    assertConverged([...authors, ...observers], project, `authors, seed=${seed + trial * 7919}`);
  }
}

/** apply(a);apply(b) must equal apply(b);apply(a) for every generated pair. */
export function checkCommutativity({ factory, genOp, trials = 60, seed = 2, project }) {
  for (let trial = 0; trial < trials; trial++) {
    const rng = makeRng(seed + trial * 104729);
    const [src] = replicas(1, factory);
    const a = src.emit((c) => genOp({ crdt: c }, rng, 0));
    const b = src.emit((c) => genOp({ crdt: c }, rng, 1));

    const ab = new Replica('ab', factory); ab.receive(a); ab.receive(b);
    const ba = new Replica('ba', factory); ba.receive(b); ba.receive(a);
    assertConverged([ab, ba], project, `commutativity seed=${seed + trial * 104729}`);
  }
}

/** Re-delivering an operation must not change the value. */
export function checkIdempotence({ factory, genOp, trials = 60, seed = 3, project }) {
  for (let trial = 0; trial < trials; trial++) {
    const rng = makeRng(seed + trial * 15485863);
    const [src] = replicas(1, factory);
    const ops = [src.emit((c) => genOp({ crdt: c }, rng, 0)), src.emit((c) => genOp({ crdt: c }, rng, 1))];

    const once = new Replica('once', factory);
    const twice = new Replica('twice', factory);
    for (const op of ops) once.receive(op);
    for (const op of ops) { twice.receive(op); twice.receive(op); }
    assertConverged([once, twice], project, `idempotence seed=${seed + trial * 15485863}`);
  }
}

/**
 * Merging whole states must agree with replaying operations, and must not care
 * how the merges are grouped. This is what makes snapshot compaction safe.
 */
export function checkSnapshotParity({ factory, genOp, trials = 30, seed = 4, project, replicas: n = 3 }) {
  for (let trial = 0; trial < trials; trial++) {
    const rng = makeRng(seed + trial * 32452843);
    const reps = replicas(n, factory);
    const ops = [];
    for (let step = 0; step < 8; step++) {
      for (const rep of reps) {
        const op = rep.emit((c) => genOp({ crdt: c }, rng, step));
        ops.push(op);
      }
    }

    // Path A: one replica receives every operation.
    const byOps = new Replica('ops', factory);
    for (const op of shuffled(rng, ops)) byOps.receive(op);

    // Path B: fold the replicas' states together, left to right...
    const left = new Replica('left', factory);
    for (const rep of reps) left.crdt.merge(rep.crdt);
    // ...and right to left, to check grouping does not matter.
    const right = new Replica('right', factory);
    for (const rep of [...reps].reverse()) right.crdt.merge(rep.crdt);

    // Path C: through a serialise/deserialise round trip.
    const revived = new Replica('revived', factory);
    for (const rep of reps) {
      revived.crdt.merge(rep.crdt.constructor.fromJSON(JSON.parse(JSON.stringify(rep.crdt))));
    }

    assertConverged([byOps, left, right, revived], project,
      `snapshot parity seed=${seed + trial * 32452843}`);
  }
}

/** Run the whole battery. `idempotent: false` skips that law (PN-counter). */
export function checkAllLaws(cfg) {
  checkConvergence(cfg);
  checkCommutativity(cfg);
  if (cfg.idempotent !== false) checkIdempotence(cfg);
  checkSnapshotParity(cfg);
}
