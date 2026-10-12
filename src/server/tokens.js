/**
 * @file Room-scoped access tokens -- authorisation per shared document rather
 * than per deployment.
 *
 * A single bearer token for the whole server means everyone who can sync
 * anything can sync everything. A room is the unit people share (a notebook,
 * a project), so that is the unit a credential should name.
 *
 * Tokens are stateless and signed: `rv1.<claims>.<signature>`, both parts
 * base64url, the signature an HMAC-SHA256 of the claims under a server
 * secret. Nothing is stored server-side, so issuing one is a function call in
 * whatever service already knows who the user is, and checking one costs a
 * hash -- which matters on a server fanning out to many slow clients.
 *
 * Claims:
 *
 *   r  room pattern: an exact name, a prefix ending in `*` (`team-42/*`),
 *      or `*` for every room
 *   s  scope: `read` (pull and subscribe), `write` (also push), or `admin`
 *      (also the inspection endpoints)
 *   n  optional replica id the token is bound to, so a leaked token cannot be
 *      used to write under a different replica's name
 *   e  optional expiry, in seconds since the epoch
 *
 * Revocation is by expiry or by rotating the secret. A deployment that needs
 * per-token revocation should pass its own `authorize` to the engine instead;
 * this is the common case, not the only one.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuthError, ValidationError } from '#core/errors';

const PREFIX = 'rv1';
const SCOPES = ['read', 'write', 'admin'];
const MIN_SECRET_BYTES = 16;

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const sign = (secret, data) => createHmac('sha256', secret).update(data).digest();

function checkSecret(secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < MIN_SECRET_BYTES) {
    throw new ValidationError(`token secret must be at least ${MIN_SECRET_BYTES} bytes`);
  }
}

/**
 * Mint a token for one room (or room pattern).
 * @param {string} secret
 * @param {object} claims
 * @param {string} claims.room exact room, `prefix*`, or `*`
 * @param {'read'|'write'|'admin'} [claims.scope]
 * @param {string} [claims.node] bind to this replica id
 * @param {number} [claims.ttlSeconds] lifetime from now; omitted means no expiry
 * @param {number} [claims.now] ms since the epoch, for tests
 * @returns {string}
 */
export function issueRoomToken(secret, { room, scope = 'write', node, ttlSeconds, now = Date.now() }) {
  checkSecret(secret);
  if (typeof room !== 'string' || room.length === 0) throw new ValidationError('a token must name a room');
  if (!SCOPES.includes(scope)) throw new ValidationError('unknown token scope', { scope, known: SCOPES });

  const claims = { r: room, s: scope };
  if (node) claims.n = node;
  if (ttlSeconds !== undefined) claims.e = Math.floor(now / 1000) + ttlSeconds;
  const body = `${PREFIX}.${b64(JSON.stringify(claims))}`;
  return `${body}.${b64(sign(secret, body))}`;
}

/**
 * Check a token's signature and expiry and return its claims.
 * @returns {{ room: string, scope: string, node?: string, expires?: number }}
 */
export function verifyRoomToken(secret, token, { now = Date.now() } = {}) {
  checkSecret(secret);
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3 || parts[0] !== PREFIX) throw new AuthError('malformed access token');

  const expected = sign(secret, `${parts[0]}.${parts[1]}`);
  const supplied = Buffer.from(parts[2], 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new AuthError('access token signature is invalid');
  }

  let claims;
  try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); }
  catch { throw new AuthError('malformed access token'); }
  if (claims.e !== undefined && Math.floor(now / 1000) >= claims.e) {
    throw new AuthError('access token has expired', { expired: claims.e });
  }
  return { room: claims.r, scope: claims.s, node: claims.n, expires: claims.e };
}

/** Whether a room pattern from a token covers `room`. */
export function roomMatches(pattern, room) {
  if (pattern === '*') return true;
  if (typeof room !== 'string') return false;
  if (pattern.endsWith('*')) return room.startsWith(pattern.slice(0, -1));
  return pattern === room;
}

/** The scope an action needs. */
function requiredScope({ action, writes }) {
  if (action === 'inspect') return 'admin';
  return writes ? 'write' : 'read';
}

/**
 * An `authorize` hook for {@link SyncServer} that accepts room tokens.
 *
 * Inspection without a room (`/v1/stats`, which lists every room) needs an
 * admin token for `*`; inspecting one room needs admin on that room.
 *
 * @param {string} secret
 * @returns {(ctx: object) => boolean}
 */
export function roomTokens(secret) {
  checkSecret(secret);
  return (ctx) => {
    if (!ctx.credential) throw new AuthError('an access token is required');
    const claims = verifyRoomToken(secret, ctx.credential);

    const room = ctx.room ?? null;
    if (room === null ? claims.room !== '*' : !roomMatches(claims.room, room)) {
      throw new AuthError('access token does not cover this room', { room });
    }
    const needed = requiredScope(ctx);
    if (SCOPES.indexOf(claims.scope) < SCOPES.indexOf(needed)) {
      throw new AuthError(`access token is ${claims.scope}-only`, { needed });
    }
    if (claims.node && ctx.node !== claims.node) {
      throw new AuthError('access token is bound to a different replica');
    }
    return true;
  };
}
