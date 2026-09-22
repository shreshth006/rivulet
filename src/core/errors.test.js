import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RivuletError, ValidationError, ClockDriftError, ProtocolError,
  StorageError, TransportError, AuthError, LimitError, invariant,
} from '#core/errors';

test('every error carries a stable code and its own name', () => {
  const cases = [
    [new ValidationError('x'), 'E_VALIDATION', 'ValidationError'],
    [new ClockDriftError('x'), 'E_CLOCK_DRIFT', 'ClockDriftError'],
    [new ProtocolError('x'), 'E_PROTOCOL', 'ProtocolError'],
    [new StorageError('x'), 'E_STORAGE', 'StorageError'],
    [new TransportError('x'), 'E_TRANSPORT', 'TransportError'],
    [new AuthError('x'), 'E_AUTH', 'AuthError'],
    [new LimitError('x'), 'E_LIMIT', 'LimitError'],
  ];
  for (const [err, code, name] of cases) {
    // Callers branch on `code`, never on message text, so that rewording an
    // error message cannot silently change behaviour somewhere else.
    assert.equal(err.code, code);
    assert.equal(err.name, name);
    assert.ok(err instanceof RivuletError);
    assert.ok(err instanceof Error);
    assert.ok(err.stack.includes(name));
  }
});

test('details travel with the error and default to an empty object', () => {
  const err = new ValidationError('bad seq', { seq: -1, node: 'abc' });
  assert.deepEqual(err.details, { seq: -1, node: 'abc' });
  assert.deepEqual(new StorageError('x').details, {});
  assert.equal(err.message, 'bad seq');
});

test('transport errors classify the failure they represent', () => {
  // The batch-size controller depends on this distinction: shrinking the batch
  // because a packet was dropped makes a lossy link slower, not faster.
  assert.equal(new TransportError('x', { kind: 'timeout' }).sizeRelated, true);
  assert.equal(new TransportError('x', { kind: 'lost' }).sizeRelated, false);
  assert.equal(new TransportError('x', { kind: 'unreachable' }).sizeRelated, false);
  assert.equal(new TransportError('x').kind, 'unreachable', 'the cautious default');
  assert.equal(new TransportError('x').retryable, true);
});

test('invariant throws a ValidationError only when the condition fails', () => {
  invariant(true, 'never thrown');
  invariant(1, 'truthy is fine');
  assert.throws(() => invariant(false, 'boom', { why: 'testing' }), (err) => {
    assert.ok(err instanceof ValidationError);
    assert.equal(err.message, 'boom');
    assert.deepEqual(err.details, { why: 'testing' });
    return true;
  });
  assert.throws(() => invariant(0, 'zero is falsy'), ValidationError);
});
