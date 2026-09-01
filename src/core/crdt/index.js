/**
 * @file Loads every CRDT implementation and re-exports the registry.
 * Importing this module is what makes `createCRDT('lww')` and friends resolve.
 */

export { createCRDT, knownTypes, registerType } from '#core/crdt/contract';
export { LWWRegister } from '#core/crdt/lww-register';
export { MVRegister } from '#core/crdt/mv-register';
export { PNCounter } from '#core/crdt/counter';
export { ORSet } from '#core/crdt/or-set';
export { RGA } from '#core/crdt/rga';

/** Wire tags in schema order, for docs and validation messages. */
export const FIELD_TYPES = Object.freeze(['lww', 'mv', 'counter', 'set', 'seq']);
