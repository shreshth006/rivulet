/**
 * @file Transports: how a client actually reaches a server.
 *
 * The sync engine talks to this interface and nothing else, which is what lets
 * the same engine run against a real HTTP server, an in-process server in the
 * tests, and a simulated lossy link in the benchmarks -- with no conditional
 * code in the engine itself.
 *
 * Two capabilities, kept separate on purpose:
 *
 * - **request/response** is the load-bearing one. Sync is correct with nothing
 *   else: a client that only ever polls still converges.
 * - **push** is an optimisation. It makes changes arrive in ~one RTT instead of
 *   one poll interval, but it is allowed to be absent or to silently die, and
 *   the engine treats every stream message as a hint to sync rather than as
 *   data it must not miss. This is deliberate -- a stream that half-works is
 *   the normal condition behind a captive portal or a mobile NAT, and a design
 *   that depended on it would fail exactly where this project is aimed.
 */

import { Emitter } from '#core/util';
import { TransportError, AuthError, ProtocolError, LimitError } from '#core/errors';
import { packMessage, unpackMessage, Encoding, ByteMeter } from '#protocol/framing';

/**
 * @typedef {object} Transport
 * @property {(message: object) => Promise<object>} request
 * @property {(handler: (msg: object) => void) => Promise<() => void>} [subscribe]
 * @property {boolean} supportsPush
 * @property {ByteMeter} meter
 */

/**
 * Talks to a `SyncServer` object directly, with no serialisation.
 *
 * Used by the integration tests. Being able to run the complete client/server
 * protocol in one process, deterministically and in microseconds, is what makes
 * it practical to test partitions and reconnection storms at all -- those are
 * the cases that matter here and the ones that are hardest to reproduce
 * against a real network.
 */
export class LoopbackTransport extends Emitter {
  #server;
  #node;
  #compress;
  #unsubscribe = null;
  /** Optional hook used by the benchmarks to impose latency and loss. */
  #link;

  /**
   * @param {import('#server/engine').SyncServer} server
   * @param {object} opts
   * @param {string} opts.node client replica id
   * @param {string} [opts.room]
   * @param {(exchange: () => Promise<{reply: object, upBytes: number, downBytes: number}>, msg: object) => Promise<object>} [opts.link]
   *   wraps each request, so the benchmarks can impose latency, bandwidth,
   *   loss and partitions without the engine knowing anything about it. The
   *   exchange reports frame sizes, which is what lets a simulated link model
   *   transmission time rather than latency alone.
   */
  constructor(server, { node, room = 'default', link, compress = true } = {}) {
    super();
    this.#server = server;
    this.#node = node;
    this.room = room;
    this.#compress = compress;
    this.#link = link ?? (async (exchange) => (await exchange()).reply);
    this.meter = new ByteMeter();
    this.supportsPush = true;
  }

  async request(message) {
    return this.#link(async () => {
      // Round-trip through the codec even in-process, so the tests exercise
      // the same encode/decode path production uses -- and so byte accounting
      // in the benchmarks is real rather than assumed.
      const frame = await packMessage(message, { compress: this.#compress });
      this.meter.recordSend(frame);
      const sent = await unpackMessage(frame.bytes, frame.encoding);

      let reply;
      try {
        reply = sent.t === 'hello'
          ? await this.#server.handleHello(sent, { node: this.#node })
          : await this.#server.handleSync(sent, { node: this.#node });
      } catch (err) {
        throw this.#translate(err);
      }

      const back = await packMessage(reply, { compress: this.#compress });
      this.meter.recordReceive(back);
      return {
        reply: await unpackMessage(back.bytes, back.encoding),
        upBytes: frame.wireBytes,
        downBytes: back.wireBytes,
      };
    }, message);
  }

  async subscribe(handler) {
    const listener = (ops) => {
      // The stream is a hint, not a delivery guarantee: the engine reacts by
      // syncing, which is what makes a dropped stream message harmless.
      handler({ t: 'event', n: ops.length });
    };
    listener.node = this.#node;
    const { off } = await this.#server.subscribe(this.room, listener, { node: this.#node });
    this.#unsubscribe = off;
    return () => { off(); this.#unsubscribe = null; };
  }

  #translate(err) {
    if (err?.code === 'E_AUTH') return new AuthError(err.message, err.details);
    if (err?.code === 'E_LIMIT') return new LimitError(err.message, err.details);
    if (err?.code === 'E_PROTOCOL' || err?.code === 'E_VALIDATION') {
      return new ProtocolError(err.message, err.details);
    }
    return new TransportError(err?.message ?? 'loopback failure', { cause: String(err) });
  }

  async close() { this.#unsubscribe?.(); this.#unsubscribe = null; }
}

/**
 * HTTP transport: one POST per sync, plus Server-Sent Events for live push.
 *
 * SSE rather than WebSockets, on purpose. The traffic is overwhelmingly
 * client-initiated (a sync is a request), so the only thing a socket adds is
 * server-to-client notification -- which SSE does over plain HTTP. That means
 * it survives the proxies, captive portals and corporate middleboxes that
 * routinely break WebSocket upgrades, and it reconnects on its own. The
 * engine's correctness does not depend on the stream either way.
 */
export class HttpTransport extends Emitter {
  #base;
  #room;
  #node;
  #token;
  #fetch;
  #abort = null;
  #timeoutMs;

  /**
   * @param {object} opts
   * @param {string} opts.url server base URL
   * @param {string} opts.room
   * @param {string} opts.node
   * @param {string} [opts.token] bearer token
   * @param {typeof fetch} [opts.fetch] injectable, for tests
   * @param {number} [opts.timeoutMs]
   */
  constructor({ url, room, node, token, fetch: fetchImpl, timeoutMs = 30_000 }) {
    super();
    this.#base = url.replace(/\/+$/, '');
    this.#room = room;
    this.#node = node;
    this.#token = token;
    this.#fetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
    this.#timeoutMs = timeoutMs;
    this.meter = new ByteMeter();
    this.supportsPush = true;
    if (!this.#fetch) throw new TransportError('no fetch implementation available');
  }

  get room() { return this.#room; }

  async request(message) {
    const frame = await packMessage(message);
    this.meter.recordSend(frame);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response;
    try {
      response = await this.#fetch(`${this.#base}/v1/sync`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(frame.encoding === Encoding.DEFLATE ? { 'content-encoding': frame.encoding } : {}),
          'accept-encoding': 'deflate-raw',
          ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
        },
        body: frame.bytes,
      });
    } catch (err) {
      // Unreachable, DNS failure, timeout: all retryable, all the same to us.
      const timedOut = controller.signal.aborted;
      throw new TransportError(
        timedOut ? 'request timed out' : 'could not reach the server',
        { kind: timedOut ? 'timeout' : 'unreachable', url: this.#base, cause: String(err) },
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      throw new AuthError('server rejected the credentials', { status: response.status });
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      throw new LimitError('server is rate limiting this client', {
        status: 429, retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined,
      });
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new TransportError(`server returned ${response.status}`, {
        // 408 and 504 mean the request itself took too long.
        kind: response.status === 408 || response.status === 504 ? 'timeout' : 'unreachable',
        status: response.status, body: body.slice(0, 200),
      });
    }

    const buf = new Uint8Array(await response.arrayBuffer());
    const encoding = response.headers.get('content-encoding') === Encoding.DEFLATE
      ? Encoding.DEFLATE : Encoding.JSON;
    this.meter.recordReceive({ rawBytes: buf.length, wireBytes: buf.length });
    return unpackMessage(buf, encoding);
  }

  /**
   * Subscribe to the room's event stream.
   *
   * SSE is parsed from a streaming fetch rather than via `EventSource`, because
   * `EventSource` exists in browsers but not in Node, and cannot carry an
   * Authorization header in either.
   */
  async subscribe(handler) {
    this.#abort?.abort();
    const controller = new AbortController();
    this.#abort = controller;

    const url = `${this.#base}/v1/stream?room=${encodeURIComponent(this.#room)}&node=${this.#node}`;
    const response = await this.#fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'text/event-stream',
        ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
      },
    }).catch((err) => {
      throw new TransportError('could not open the event stream', { cause: String(err) });
    });

    if (!response.ok || !response.body) {
      throw new TransportError(`event stream refused (${response.status})`);
    }

    // Read in the background; a stream failure is reported, never thrown at
    // the caller, because losing the stream must not break syncing.
    (async () => {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by a blank line.
          let split;
          while ((split = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const data = frame.split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
              .join('');
            if (!data) continue;
            try { handler(JSON.parse(data)); } catch { /* ignore a malformed frame */ }
          }
        }
        this.emit('stream-closed', { reason: 'ended' });
      } catch (err) {
        if (!controller.signal.aborted) this.emit('stream-closed', { reason: String(err) });
      }
    })();

    return () => controller.abort();
  }

  async close() { this.#abort?.abort(); this.#abort = null; }
}
