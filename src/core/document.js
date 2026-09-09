/**
 * @file A document: one record, whose fields are independent CRDTs.
 *
 * Splitting a record into per-field CRDTs is what makes offline merging feel
 * reasonable to a user. Two people editing the same note concurrently -- one
 * retitling it, one adding a tag, one typing in the body -- produce operations
 * that never contend, so all three edits survive. Only writes to the *same*
 * field can conflict, and the field's declared type decides what happens then.
 *
 * Fields are created lazily on first write, so adding a field to the schema
 * does not require migrating existing documents.
 */

import { createCRDT } from '#core/crdt/index';
import { DELETED_FIELD } from '#core/schema';
import { opMeta } from '#core/op';

export class Document {
  /** @param {string} id @param {import('#core/schema').CollectionSchema} schema @param {object} [state] */
  constructor(id, schema, state) {
    this.id = id;
    this.schema = schema;
    /** @type {Map<string, import('#core/crdt/contract').CRDT>} */
    this.fields = new Map();
    if (state) {
      for (const [name, fieldState] of Object.entries(state)) {
        if (!schema.has(name)) continue; // field removed from the schema; ignore
        this.fields.set(name, createCRDT(schema.field(name).type, fieldState));
      }
    }
  }

  /** Get the CRDT backing `name`, creating it on first use. */
  crdt(name) {
    let c = this.fields.get(name);
    if (!c) {
      c = createCRDT(this.schema.field(name).type);
      this.fields.set(name, c);
    }
    return c;
  }

  /** @returns {boolean} whether the visible value changed */
  apply(op) {
    return this.crdt(op.field).apply(op.payload, opMeta(op));
  }

  /** Fold another replica's document state in, field by field. */
  merge(other) {
    let changed = false;
    for (const [name, crdt] of other.fields) {
      if (!this.schema.has(name)) continue;
      if (this.crdt(name).merge(crdt)) changed = true;
    }
    return changed;
  }

  /**
   * Value of one field, rendered per its schema declaration.
   *
   * The empty value must match the type's *rendered* form, not just its CRDT
   * kind. A text field that has never been written reads as `""`, the same as
   * one whose characters were all deleted -- otherwise two replicas holding
   * identical state would display differently depending on whether the field
   * happened to have been touched locally, and equality checks on the value
   * would disagree across replicas.
   */
  get(name) {
    const def = this.schema.field(name);
    const crdt = this.fields.get(name);
    if (crdt) return def.asText ? crdt.text : crdt.value;
    if (def.defaultValue !== undefined) return def.defaultValue;
    switch (def.type) {
      case 'counter': return 0;
      case 'set': return [];
      case 'seq': return def.asText ? '' : [];
      default: return null;
    }
  }

  /** Tombstoned documents stay in the store so the delete can still propagate. */
  get deleted() { return this.fields.get(DELETED_FIELD)?.value === true; }

  /**
   * Fields whose type kept concurrent values -- what a "review this conflict"
   * UI renders. Empty for the overwhelming majority of documents.
   */
  get conflicts() {
    const out = [];
    for (const [name, crdt] of this.fields) {
      if (crdt.hasConflict) out.push({ field: name, values: crdt.values, siblings: crdt.siblings });
    }
    return out;
  }

  /** Plain object view for the application. */
  value({ includeDeleted = false } = {}) {
    if (this.deleted && !includeDeleted) return null;
    /** @type {Record<string, any>} */
    const out = { id: this.id };
    for (const def of this.schema.userFields) out[def.name] = this.get(def.name);
    if (this.deleted) out[DELETED_FIELD] = true;
    return out;
  }

  /** Serialisable CRDT state (not the value) for snapshots. */
  toJSON() {
    /** @type {Record<string, any>} */
    const out = {};
    for (const name of [...this.fields.keys()].sort()) out[name] = this.fields.get(name).toJSON();
    return out;
  }

  /** Reclaim CRDT bookkeeping below a causally stable timestamp. */
  gc(stableTs) {
    let reclaimed = 0;
    for (const crdt of this.fields.values()) {
      if (typeof crdt.gc === 'function') reclaimed += crdt.gc(stableTs);
    }
    return reclaimed;
  }
}
