/**
 * @file Typed error hierarchy. Every failure the engine can produce is one of
 * these, so callers can branch on `err.code` instead of matching message text.
 */

export class RivuletError extends Error {
  /** @param {string} code @param {string} message @param {Record<string,unknown>} [details] */
  constructor(code, message, details = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

/** Invalid arguments, malformed identifiers, schema violations. */
export class ValidationError extends RivuletError {
  constructor(message, details) { super('E_VALIDATION', message, details); }
}

/** A remote clock is further ahead than `maxDriftMs` allows. */
export class ClockDriftError extends RivuletError {
  constructor(message, details) { super('E_CLOCK_DRIFT', message, details); }
}

/** Wire payload could not be decoded, or used an unsupported version. */
export class ProtocolError extends RivuletError {
  constructor(message, details) { super('E_PROTOCOL', message, details); }
}

/** Storage adapter failure (disk, quota, transaction abort). */
export class StorageError extends RivuletError {
  constructor(message, details) { super('E_STORAGE', message, details); }
}

/**
 * Transport failure. Always retryable, but not all retries are equal.
 *
 * `kind` distinguishes the cases the batch-size controller must not confuse:
 *
 * - `timeout`     the request was too big to finish before the link died or
 *                 the client gave up. The size is implicated.
 * - `lost`        a packet went missing. Says nothing about size; shrinking
 *                 the batch on a lossy link only makes the transfer longer.
 * - `unreachable` no connection at all. Says nothing about size either.
 */
export class TransportError extends RivuletError {
  constructor(message, details = {}) { super('E_TRANSPORT', message, details); }
  get retryable() { return true; }
  /** @returns {'timeout'|'lost'|'unreachable'} */
  get kind() { return this.details.kind ?? 'unreachable'; }
  /** True when the failure suggests the request itself was too large. */
  get sizeRelated() { return this.kind === 'timeout'; }
}

/** Server rejected the request for auth reasons. Never retried blindly. */
export class AuthError extends RivuletError {
  constructor(message, details) { super('E_AUTH', message, details); }
}

/** @param {unknown} cond @param {string} msg @param {Record<string,unknown>} [details] */
export function invariant(cond, msg, details) {
  if (!cond) throw new ValidationError(msg, details);
}
