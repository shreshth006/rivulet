# 7. The event stream carries hints, not data

**Status:** accepted

## Context

The server pushes notifications over SSE. It could send the operations
themselves, saving the client a request.

## Decision

A stream frame says only that something changed, with a count. The client reacts
by syncing through the normal path.

## Why

Sending operations over the stream would make the stream a delivery channel, and
therefore something whose failure loses data. Streams in this environment fail
constantly and quietly: a captive portal that buffers, a proxy that closes idle
connections, a mobile NAT that drops the socket without a FIN. A design that
notices these only by the absence of a message that was never going to arrive is
a design that silently stops syncing.

Treating the stream as an optimisation makes every failure mode benign. A
dropped frame costs latency. A dead stream degrades to polling. A duplicated
frame causes one redundant sync.

It also keeps one code path for applying operations — the same de-duplication,
the same frontier advance, the same watermark — rather than two that must agree.

## Consequences

- One extra round trip between "something changed" and having the change. On
  the target networks that is dominated by the sync itself.
- The client ignores the stream's opening frame, which only confirms the
  subscription; syncing on it would duplicate the round the connect already does.
- The server's broadcast excludes the sender, so a client never wakes itself up.
- Correctness is testable without a stream at all. Most tests run with polling.
