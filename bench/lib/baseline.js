/**
 * @file A deliberately naive encoding, for comparison.
 *
 * This is what a straightforward implementation sends: the operations, as
 * JSON, unchanged. Running it through the identical protocol, transport and
 * simulated link means the comparison measures the encoding and nothing else
 * -- no modelling, no estimated round trips, no assumption about what a
 * hypothetical baseline would have done.
 *
 * Pair it with `compress: false` on the transport for a fully naive stack, or
 * leave compression on to measure against the obvious cheap alternative of
 * "just turn on gzip".
 */

import { validateOp } from '#core/op';
import { ProtocolError } from '#core/errors';

export const naiveCodec = {
  encode: (ops) => ({ v: 0, plain: ops }),
  decode: (batch) => {
    if (!batch || !Array.isArray(batch.plain)) {
      throw new ProtocolError('malformed baseline batch', { batch });
    }
    return batch.plain.map(validateOp);
  },
};
