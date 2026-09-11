# 3. HTTP with Server-Sent Events, not WebSockets

**Status:** accepted

## Context

The client needs to send operations and to learn promptly that something
changed. WebSockets are the reflexive choice for the second.

## Decision

`POST /v1/sync` for the protocol, and Server-Sent Events for change
notifications. No WebSocket.

## Why

The traffic is overwhelmingly client-initiated — a sync *is* a request — so a
socket's only real contribution is server-to-client notification, which SSE
provides over ordinary HTTP.

In exchange, everything keeps working behind the proxies, captive portals and
corporate middleboxes that routinely break WebSocket upgrades. That is not an
edge case for this project; it is the target environment.

## Consequences

- The stream is treated as a **hint**, never a delivery channel. A frame says
  "something changed" and carries a count; the client reacts by syncing through
  the normal path. A stream that dies silently degrades to polling and nothing
  is lost.
- SSE reconnects on its own, and comment-frame heartbeats keep aggressive
  proxies from closing an idle stream.
- The stream is parsed from a streaming `fetch` rather than `EventSource`,
  because `EventSource` does not exist in Node and cannot carry an
  `Authorization` header in either environment.
- No server-to-client request/response channel. Nothing currently needs one.
