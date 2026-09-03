/**
 * @file Schema: which CRDT backs each field.
 *
 * The merge strategy for a field is a product decision, not a technical one.
 * "Two people renamed this note offline" and "two people edited this note's
 * body offline" want completely different answers, and only the person
 * designing the feature knows which. The schema is where that choice is stated
 * once, explicitly, instead of being implied by whichever merge code runs.
 *
 *     const schema = defineSchema({
 *       notes: {
 *         title:   'lww',      // newest rename wins
 *         body:    'text',     // character-level merge, nothing lost
 *         tags:    'set',      // add-wins; offline adds survive
 *         reads:   'counter',  // concurrent increments add up
 *         price:   'mv',       // keep both, let the user decide
 *       },
 *     });
 */

import { FIELD_TYPES } from '#core/crdt/index';
import { ValidationError } from '#core/errors';

/** Marks a document deleted. Reserved, present on every collection. */
export const DELETED_FIELD = '__deleted';

/**
 * `text` is `seq` with a string view -- the common case deserves the obvious
 * name, and the two differ only in how the value is presented.
 */
const ALIASES = { text: 'seq', string: 'lww', number: 'lww', boolean: 'lww', json: 'lww' };

/**
 * @typedef {object} FieldDef
 * @property {string} name
 * @property {'lww'|'mv'|'counter'|'set'|'seq'} type
 * @property {boolean} asText render a `seq` field as a joined string
 * @property {any} [defaultValue]
 */

/** @param {string|object} def @param {string} name @returns {FieldDef} */
function normaliseField(def, name) {
  const raw = typeof def === 'string' ? { type: def } : { ...def };
  const declared = raw.type;
  const type = ALIASES[declared] ?? declared;

  if (!FIELD_TYPES.includes(type)) {
    throw new ValidationError('unknown field type', {
      field: name, given: declared, valid: [...FIELD_TYPES, ...Object.keys(ALIASES)],
    });
  }
  if (name.startsWith('__') && name !== DELETED_FIELD) {
    throw new ValidationError('field names starting with __ are reserved', { field: name });
  }
  return Object.freeze({
    name,
    type,
    asText: declared === 'text',
    defaultValue: raw.default,
  });
}

export class CollectionSchema {
  /** @param {string} name @param {Record<string, string|object>} fields */
  constructor(name, fields) {
    if (!name || typeof name !== 'string') throw new ValidationError('collection needs a name', { name });
    /** @type {Map<string, FieldDef>} */
    this.fields = new Map();
    for (const [fieldName, def] of Object.entries(fields)) {
      this.fields.set(fieldName, normaliseField(def, fieldName));
    }
    this.fields.set(DELETED_FIELD, normaliseField('lww', DELETED_FIELD));
    this.name = name;
    Object.freeze(this);
  }

  /** @returns {FieldDef} @throws if the field is not declared */
  field(fieldName) {
    const f = this.fields.get(fieldName);
    if (!f) {
      throw new ValidationError('unknown field', {
        collection: this.name, field: fieldName, known: [...this.fields.keys()],
      });
    }
    return f;
  }

  has(fieldName) { return this.fields.has(fieldName); }

  /** Declared fields, excluding reserved ones. */
  get userFields() { return [...this.fields.values()].filter((f) => f.name !== DELETED_FIELD); }
}

export class Schema {
  /** @param {Record<string, Record<string, string|object>>} definition */
  constructor(definition) {
    /** @type {Map<string, CollectionSchema>} */
    this.collections = new Map();
    for (const [name, fields] of Object.entries(definition)) {
      this.collections.set(name, new CollectionSchema(name, fields));
    }
    Object.freeze(this);
  }

  /** @returns {CollectionSchema} */
  collection(name) {
    const c = this.collections.get(name);
    if (!c) {
      throw new ValidationError('unknown collection', {
        collection: name, known: [...this.collections.keys()],
      });
    }
    return c;
  }

  has(name) { return this.collections.has(name); }
  get names() { return [...this.collections.keys()]; }

  /**
   * Stable fingerprint of the schema. Client and server compare these on
   * connect so a version skew is reported plainly instead of surfacing later
   * as an unexplained merge failure.
   */
  get fingerprint() {
    const parts = [];
    for (const name of [...this.collections.keys()].sort()) {
      const col = this.collections.get(name);
      const fields = [...col.fields.values()]
        .map((f) => `${f.name}:${f.type}${f.asText ? '/t' : ''}`).sort();
      parts.push(`${name}(${fields.join(',')})`);
    }
    return parts.join(';');
  }

  toJSON() {
    /** @type {Record<string, Record<string, string>>} */
    const out = {};
    for (const [name, col] of this.collections) {
      out[name] = {};
      for (const f of col.fields.values()) out[name][f.name] = f.asText ? 'text' : f.type;
    }
    return out;
  }
}

/** @param {Record<string, Record<string, string|object>>} definition */
export function defineSchema(definition) { return new Schema(definition); }
