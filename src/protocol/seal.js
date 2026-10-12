/**
 * @file End-to-end encryption of operations: the server stores and relays what
 * it cannot read.
 *
 * The server is already not authoritative about content -- it never merges and
 * never inspects a payload -- so it does not need to be able to read one. What
 * it does need is the envelope: which replica wrote an operation, its sequence
 * number and its timestamp. Those drive "what am I missing?", and they stay in
 * the clear. Everything else -- collection, document, field and value -- is
 * sealed with AES-256-GCM under a key the server never sees.
 *
 * ## Sealed runs
 *
 * Encrypting each operation on its own is simple and ruinous here: ciphertext
 * is incompressible and carries a nonce and tag apiece, so a keystroke that
 * costs ~6 bytes through the codec costs ~125 sealed. So a replica seals a
 * *run* -- its own consecutive operations, as it pushes them -- in one piece:
 * the run goes through the operation codec and DEFLATE first, and only then is
 * encrypted. Interning, back-references and compression all still apply.
 *
 * The ciphertext rides on the run's *last* operation; every other one carries
 * only `{ $r: <last seq> }`. Last, not first, because of retries: a push that
 * timed out may already be stored, and its retry can start with the same
 * operations and run further. Those leading operations are discarded as
 * duplicates. Were the ciphertext on the first one, it would be discarded with
 * it and the new operations behind it would be unreadable. The last operation
 * of a retry is always one the server does not yet hold.
 *
 *   { node, seq: 41, ..., collection: '~', doc: '~', field: '~', payload: { $r: 44 } }
 *   { node, seq: 44, ..., collection: '~', doc: '~', field: '~', payload: { $e: '...', f: 41 } }
 *
 * A pull can stop part-way through a run, so the server honours one structural
 * hint: when a page ends on an operation pointing at a later `$r`, it includes
 * that operation too (see `SyncServer#handleSync`). It never looks further
 * into a payload than that.
 *
 * ## What is authenticated
 *
 * The room, the replica, the run's first and last sequence numbers and the last
 * operation's timestamp are bound to the ciphertext as additional data, and
 * every operation inside is checked against them on opening. A server that
 * moves a run to another replica, renumbers it or replays it into another room
 * produces something that fails to open. A replica holding the key refuses
 * unsealed operations outright: accepting them would let whoever runs the
 * server write into the room.
 *
 * Sealing happens only at the wire. The local log and the in-memory database
 * hold plaintext, so reads, queries and snapshots are unchanged.
 *
 * WebCrypto only, so the same code runs in Node and in the browser.
 */

import { AuthError, ProtocolError, ValidationError } from '#core/errors';
import { encodeOps, decodeOps } from '#protocol/codec';
import { deflate, inflate, toBytes, fromBytes } from '#protocol/compress';

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new ValidationError('end-to-end encryption needs WebCrypto (crypto.subtle)');
  return s;
};

const SEALED = '~';
const IV_BYTES = 12;
const KEY_BYTES = 32;
/** OWASP's 2023 floor for PBKDF2-HMAC-SHA256. */
const PBKDF2_ITERATIONS = 600_000;

const encoder = new TextEncoder();

/* ---------------------------------------------------------------- base64url */

function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw new AuthError('malformed sealed payload');
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* --------------------------------------------------------------------- keys */

/**
 * A fresh random room key, as text to share out of band -- in an invite link's
 * fragment, say, which browsers never send to the server.
 * @returns {string}
 */
export function generateRoomKey() {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

/** @param {string} text a key from {@link generateRoomKey} @returns {Promise<CryptoKey>} */
export async function importRoomKey(text) {
  const raw = fromBase64Url(text);
  if (raw.length !== KEY_BYTES) throw new ValidationError('a room key is 32 bytes', { got: raw.length });
  return subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * A room key from a passphrase people can type. Salted with the room name so
 * one passphrase gives unrelated keys in different rooms. Only as strong as the
 * passphrase: prefer {@link generateRoomKey} where a link can carry the key.
 * @returns {Promise<CryptoKey>}
 */
export async function deriveRoomKey(passphrase, room, { iterations = PBKDF2_ITERATIONS } = {}) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new ValidationError('a passphrase is required');
  }
  const base = await subtle().importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(`rivulet-room-key:${room}`), iterations },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

/* ------------------------------------------------------------------ sealing */

/** Split operations into maximal runs of one replica's consecutive sequence numbers. */
function runsOf(ops) {
  const runs = [];
  for (const op of ops) {
    const run = runs.at(-1);
    if (run && run[0].node === op.node && run.at(-1).seq + 1 === op.seq) run.push(op);
    else runs.push([op]);
  }
  return runs;
}

const envelope = (op, payload) => ({
  node: op.node, seq: op.seq, ts: op.ts,
  collection: SEALED, doc: SEALED, field: SEALED,
  payload,
});

export class OpSealer {
  #key;
  #room;

  /**
   * @param {object} opts
   * @param {CryptoKey|string} opts.key a CryptoKey, or text from {@link generateRoomKey}
   * @param {string} opts.room bound into every seal
   */
  constructor({ key, room }) {
    if (!key) throw new ValidationError('a room key is required');
    this.#key = typeof key === 'string' ? importRoomKey(key) : Promise.resolve(key);
    // A bad key surfaces on first use; keep it from also being reported as an
    // unhandled rejection in the meantime.
    this.#key.catch(() => {});
    this.#room = room;
  }

  #aad(node, first, last, ts) {
    return encoder.encode(`rivulet-run:${this.#room}:${node}:${first}:${last}:${ts}`);
  }

  /** @param {object[]} ops plaintext, in sequence order per replica @returns {Promise<object[]>} */
  async seal(ops) {
    const key = await this.#key;
    const out = [];
    for (const run of runsOf(ops)) {
      const tail = run.at(-1);
      const first = run[0].seq;
      const plain = await deflate(toBytes(JSON.stringify(encodeOps(run))));
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const sealed = new Uint8Array(await subtle().encrypt(
        { name: 'AES-GCM', iv, additionalData: this.#aad(tail.node, first, tail.seq, tail.ts) }, key, plain));
      const bytes = new Uint8Array(IV_BYTES + sealed.length);
      bytes.set(iv);
      bytes.set(sealed, IV_BYTES);

      for (const op of run.slice(0, -1)) out.push(envelope(op, { $r: tail.seq }));
      out.push(envelope(tail, { $e: toBase64Url(bytes), f: first }));
    }
    return out;
  }

  /**
   * @param {object[]} ops as received
   * @returns {Promise<object[]>} plaintext -- every operation of every run that
   *   arrived, which may include some the caller already holds
   * @throws {AuthError} for an unsealed operation, or a run that does not open
   *   under this key: a wrong key, or tampering
   * @throws {ProtocolError} for a run pointer whose run did not arrive
   */
  async open(ops) {
    const key = await this.#key;
    const out = [];
    /** node -> [first, last] of each run opened, to account for the pointers */
    const covered = new Map();

    for (const tail of ops) {
      const p = tail.payload;
      if (typeof p?.$e !== 'string') continue;
      if (!Number.isInteger(p.f) || p.f < 1 || p.f > tail.seq) throw new AuthError('malformed sealed run', { op: `${tail.node}:${tail.seq}` });

      const bytes = fromBase64Url(p.$e);
      let plain;
      try {
        plain = await subtle().decrypt(
          { name: 'AES-GCM', iv: bytes.subarray(0, IV_BYTES), additionalData: this.#aad(tail.node, p.f, tail.seq, tail.ts) },
          key, bytes.subarray(IV_BYTES));
      } catch {
        throw new AuthError('operations do not decrypt under the room key -- wrong key, or tampered',
          { op: `${tail.node}:${tail.seq}` });
      }
      const run = decodeOps(JSON.parse(fromBytes(await inflate(new Uint8Array(plain)))));

      // The ciphertext is authentic; check it says what its envelope claims.
      const consistent = run.length === tail.seq - p.f + 1
        && run.every((op, i) => op.node === tail.node && op.seq === p.f + i)
        && run.at(-1).ts === tail.ts;
      if (!consistent) throw new AuthError('sealed run does not match its envelope', { op: `${tail.node}:${tail.seq}` });

      out.push(...run);
      if (!covered.has(tail.node)) covered.set(tail.node, []);
      covered.get(tail.node).push([p.f, tail.seq]);
    }

    for (const op of ops) {
      const p = op.payload;
      if (typeof p?.$e === 'string') continue;
      if (!Number.isInteger(p?.$r)) {
        throw new AuthError('refusing an unencrypted operation in an encrypted room', { op: `${op.node}:${op.seq}` });
      }
      const inRun = (covered.get(op.node) ?? []).some(([first, last]) => op.seq >= first && op.seq <= last);
      if (!inRun) throw new ProtocolError('a sealed operation arrived without its run', { op: `${op.node}:${op.seq}` });
    }
    return out;
  }
}
