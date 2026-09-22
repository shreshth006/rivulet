/**
 * @file RGA -- Replicated Growable Array. The sequence type, used for text.
 *
 * Indices cannot be synchronised. If I insert at position 3 while you delete
 * position 1, my index means something different by the time my operation
 * reaches you. So no operation here ever mentions a position: an insert names
 * the *identity* of the element it goes after, and a delete names the identity
 * of its target. Identities never shift, so an operation means the same thing
 * whenever it arrives.
 *
 * ## The ordering rule
 *
 * Elements form a tree: each one points at the element it was inserted after.
 * Reading the document is a depth-first walk. The only real question is how to
 * order elements inserted after the *same* neighbour -- two people typing at
 * the same spot. RGA sorts those siblings by descending identity.
 *
 * Implemented, that is a forward scan skipping every element whose id is
 * greater than the new one. This works because ids are HLC timestamps and a
 * replica must have seen an element before inserting after it, so a child's id
 * always exceeds its parent's. An entire subtree therefore sits above its root
 * in id order, and one flat comparison skips the whole subtree at once.
 *
 * ## Out-of-order arrival
 *
 * An insert whose neighbour has not arrived cannot be placed yet, so it waits
 * in a pending table keyed by that neighbour and is replayed -- transitively --
 * the moment it shows up. This is the one type needing causal context, and it
 * resolves that itself so the sync layer never has to enforce causal delivery.
 *
 * ## Deletes
 *
 * Deleted elements become tombstones rather than disappearing, because a
 * concurrent insert may still name one as its neighbour. {@link RGA#gc} can
 * reclaim them once the sync layer proves no such operation can still arrive.
 */

import { registerType } from '#core/crdt/contract';
import { ZERO_TIMESTAMP } from '#core/hlc';
import { ValidationError } from '#core/errors';

/** Sentinel head. Inserting "after nothing" means inserting after this. */
const ROOT = ZERO_TIMESTAMP;

export class RGA {
  static type = 'seq';

  /** @type {Map<string, { id: string, v: any, del: boolean, next: string|null }>} */
  #nodes = new Map();
  /** @type {Map<string, Array<{payload: any, meta: any}>>} inserts waiting for a neighbour */
  #pending = new Map();
  /** @type {Set<string>} deletes that arrived before their target */
  #orphanDeletes = new Set();
  /** @type {Map<string, string>} garbage-collected id -> surviving predecessor */
  #redirect = new Map();
  /** @type {any[]|null} memoised materialisation */
  #cache = null;

  constructor(state) {
    this.#nodes.set(ROOT, { id: ROOT, v: null, del: true, next: null });
    if (state) {
      // Snapshots store the list already in document order, so rebuilding is a
      // linear relink rather than a replay of the insertion algorithm.
      let prev = ROOT;
      for (const [id, v, del] of state.n ?? []) {
        this.#nodes.set(id, { id, v, del: !!del, next: null });
        this.#nodes.get(prev).next = id;
        prev = id;
      }
      for (const [from, to] of state.rd ?? []) this.#redirect.set(from, to);
      for (const id of state.od ?? []) this.#orphanDeletes.add(id);
    }
  }

  // ---------------------------------------------------------------- reading

  /** Visible elements, in document order. */
  get elements() {
    if (this.#cache) return this.#cache;
    const out = [];
    for (let id = this.#nodes.get(ROOT).next; id !== null; id = this.#nodes.get(id).next) {
      const n = this.#nodes.get(id);
      if (!n.del) out.push(n.v);
    }
    this.#cache = out;
    return out;
  }

  get value() { return this.elements; }

  /** Visible elements joined into a string -- the text view. */
  get text() { return this.elements.join(''); }

  get length() { return this.elements.length; }
  get size() { return this.length; }
  get isEmpty() { return this.length === 0; }

  at(index) { return this.elements.at(index); }
  includes(val) { return this.elements.includes(val); }
  indexOf(val) { return this.elements.indexOf(val); }
  toArray() { return [...this.elements]; }

  /** Total nodes including tombstones; the benchmarks track the ratio. */
  get physicalLength() { return this.#nodes.size - 1; }

  get pendingCount() {
    let n = 0;
    for (const list of this.#pending.values()) n += list.length;
    return n;
  }

  /** Identities in document order, visible only. Needed to build local edits. */
  ids() {
    const out = [];
    for (let id = this.#nodes.get(ROOT).next; id !== null; id = this.#nodes.get(id).next) {
      if (!this.#nodes.get(id).del) out.push(id);
    }
    return out;
  }

  /**
   * Identity of the visible element at `index`, or ROOT for index -1.
   * This is how a local, index-based edit becomes a position-free operation.
   */
  idAtIndex(index) {
    if (index < 0) return ROOT;
    let i = 0;
    for (let id = this.#nodes.get(ROOT).next; id !== null; id = this.#nodes.get(id).next) {
      if (this.#nodes.get(id).del) continue;
      if (i === index) return id;
      i++;
    }
    throw new ValidationError('index out of range', { index, length: i });
  }

  // ------------------------------------------------------------ op builders

  /** Insert `value` after the element with id `afterId` (ROOT for the front). */
  static insertOp(value, afterId = ROOT) { return { i: value, p: afterId }; }

  /** Delete the element with id `targetId`. */
  static deleteOp(targetId) { return { x: targetId }; }

  /**
   * Translate an index-based local insert into a position-free operation.
   * @param {number} index insert so the new element lands at this index
   */
  insertAtOp(index, value) { return RGA.insertOp(value, this.idAtIndex(index - 1)); }

  /** Translate an index-based local delete. */
  deleteAtOp(index) { return RGA.deleteOp(this.idAtIndex(index)); }

  // ------------------------------------------------------------- applying

  apply(payload, meta) {
    const changed = 'i' in payload ? this.#insert(payload, meta) : this.#delete(payload.x);
    if (changed) this.#cache = null;
    return changed;
  }

  #insert(payload, meta) {
    const id = meta.ts;
    if (this.#nodes.has(id)) return false; // already applied

    let parent = payload.p ?? ROOT;
    // Follow redirects left behind by tombstone collection.
    while (this.#redirect.has(parent)) parent = this.#redirect.get(parent);

    if (!this.#nodes.has(parent)) {
      // Neighbour has not arrived. Park the operation; it replays when it does.
      if (!this.#pending.has(parent)) this.#pending.set(parent, []);
      this.#pending.get(parent).push({ payload, meta });
      return false;
    }

    // Walk past siblings (and their whole subtrees) that outrank this element.
    let prev = parent;
    let next = this.#nodes.get(prev).next;
    while (next !== null && next > id) {
      prev = next;
      next = this.#nodes.get(next).next;
    }

    const wasDeleted = this.#orphanDeletes.delete(id);
    this.#nodes.set(id, { id, v: payload.i, del: wasDeleted, next });
    this.#nodes.get(prev).next = id;

    this.#flushPending(id);
    return !wasDeleted;
  }

  /** Replay everything that was waiting on `id`, transitively. */
  #flushPending(id) {
    const queue = [id];
    while (queue.length) {
      const parent = queue.pop();
      const waiting = this.#pending.get(parent);
      if (!waiting) continue;
      this.#pending.delete(parent);
      for (const { payload, meta } of waiting) {
        this.#insert(payload, meta);
        queue.push(meta.ts);
      }
    }
  }

  #delete(targetId) {
    let id = targetId;
    while (this.#redirect.has(id)) id = this.#redirect.get(id);
    const node = this.#nodes.get(id);
    if (!node) {
      // Delete outran its target; remember so the insert lands pre-deleted.
      this.#orphanDeletes.add(id);
      return false;
    }
    if (node.del) return false;
    node.del = true;
    return true;
  }

  // ---------------------------------------------------------------- merging

  /**
   * Fold in another replica's whole state. Each of its elements is replayed as
   * an insert, which reuses the ordering rule and so lands identically no
   * matter which replica performs the merge.
   */
  merge(other) {
    let changed = false;
    for (const [from, to] of other.#redirect) this.#redirect.set(from, to);
    let prev = ROOT;
    for (let id = other.#nodes.get(ROOT).next; id !== null; id = other.#nodes.get(id).next) {
      const n = other.#nodes.get(id);
      if (!this.#nodes.has(id)) {
        if (this.#insert({ i: n.v, p: prev }, { ts: id })) changed = true;
      }
      if (n.del && this.#delete(id)) changed = true;
      prev = id;
    }
    for (const id of other.#orphanDeletes) if (this.#delete(id)) changed = true;
    for (const [parent, list] of other.#pending) {
      for (const item of list) {
        if (!this.#nodes.has(item.meta.ts)) {
          if (!this.#pending.has(parent)) this.#pending.set(parent, []);
          this.#pending.get(parent).push(item);
        }
      }
    }
    if (changed) this.#cache = null;
    return changed;
  }

  // --------------------------------------------------------------------- gc

  /**
   * Reclaim tombstones at or below `stableTs`, leaving a redirect so any
   * operation still naming one is rebased onto its surviving predecessor.
   *
   * Two-phase safety: `stableTs` must be causally stable -- every replica has
   * it -- so no replica can still be composing an operation against a newer
   * view. Redirects may themselves be dropped after a second stability round,
   * once every replica has collected the same tombstones.
   */
  gc(stableTs) {
    let removed = 0;
    let prev = this.#nodes.get(ROOT);
    let id = prev.next;
    while (id !== null) {
      const node = this.#nodes.get(id);
      const next = node.next;
      if (node.del && id <= stableTs) {
        prev.next = next;
        this.#nodes.delete(id);
        this.#redirect.set(id, prev.id === ROOT ? ROOT : prev.id);
        removed++;
      } else {
        prev = node;
      }
      id = next;
    }
    // Collapse redirect chains so a lookup is always one hop.
    for (const [from] of this.#redirect) {
      let to = this.#redirect.get(from);
      while (this.#redirect.has(to)) to = this.#redirect.get(to);
      this.#redirect.set(from, to);
    }
    if (removed) this.#cache = null;
    return removed;
  }

  /** Drop redirects once a second stability round proves nothing needs them. */
  dropRedirects() { const n = this.#redirect.size; this.#redirect.clear(); return n; }

  get stats() {
    let live = 0, tombstones = 0;
    for (const n of this.#nodes.values()) {
      if (n.id === ROOT) continue;
      if (n.del) tombstones++; else live++;
    }
    return { live, tombstones, pending: this.pendingCount, redirects: this.#redirect.size };
  }

  // ------------------------------------------------------------ persistence

  toJSON() {
    const n = [];
    for (let id = this.#nodes.get(ROOT).next; id !== null; id = this.#nodes.get(id).next) {
      const node = this.#nodes.get(id);
      n.push(node.del ? [id, node.v, 1] : [id, node.v]);
    }
    const out = { n };
    if (this.#redirect.size) out.rd = [...this.#redirect.entries()].sort();
    if (this.#orphanDeletes.size) out.od = [...this.#orphanDeletes].sort();
    return out;
  }

  static fromJSON(state) { return new RGA(state); }

  /** Build a sequence from plain items; test and seeding helper. */
  static from(items, clock) {
    const rga = new RGA();
    let after = ROOT;
    for (const item of items) {
      const ts = clock.now();
      rga.apply(RGA.insertOp(item, after), { ts, node: clock.node, seq: 0 });
      after = ts;
    }
    return rga;
  }
}

registerType(RGA.type, RGA);
