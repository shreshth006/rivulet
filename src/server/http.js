/**
 * @file HTTP transport for the sync server.
 *
 * Plain HTTP with Server-Sent Events, not WebSockets. Sync traffic is
 * overwhelmingly client-initiated -- a sync *is* a request -- so the only thing
 * a socket would add is server-to-client notification, which SSE already does
 * over ordinary HTTP. In exchange, everything keeps working behind the
 * proxies, captive portals and middleboxes that routinely break WebSocket
 * upgrades, which is the environment this project is aimed at. And because the
 * engine treats the stream as a hint rather than a delivery channel, a stream
 * that silently dies costs latency and nothing else.
 *
 * Two endpoints carry the protocol:
 *
 *   POST /v1/sync    push and pull in one round trip
 *   GET  /v1/stream  server-sent notifications that something changed
 *
 * The rest is operational: health, stats, and optional static hosting so the
 * demo is one command rather than two servers and a CORS problem.
 */

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, resolve, sep } from 'node:path';
import { SyncServer } from '#server/engine';
import { unpackMessage, packMessage, Encoding } from '#protocol/framing';
import { MessageType, PROTOCOL_VERSION } from '#protocol/messages';
import { CODEC_VERSION } from '#protocol/codec';
import { AuthError, ProtocolError } from '#core/errors';
import { roomTokens } from '#server/tokens';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Read a request body with a hard ceiling, so one client cannot exhaust RAM. */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new ProtocolError('request body too large', { maxBytes }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

export class HttpSyncServer {
  #engine;
  #server = null;
  #opts;
  /** @type {Set<import('node:http').ServerResponse>} open event streams */
  #streams = new Set();
  #heartbeat = null;

  /**
   * @param {object} opts
   * @param {SyncServer} opts.engine
   * @param {string} [opts.staticDir] serve a directory at `/`
   * @param {Record<string, string>} [opts.mounts] URL prefix -> directory,
   *   for serving the engine's own modules alongside a demo page
   * @param {string} [opts.token] one bearer token required on every request,
   *   for deployments that trust every client equally. For per-room access,
   *   give the engine an `authorize` hook (e.g. `roomTokens`) instead.
   * @param {string[]} [opts.origins] allowed CORS origins; '*' by default
   * @param {number} [opts.heartbeatMs] SSE keep-alive interval
   */
  constructor({ engine, staticDir, mounts, token, origins = ['*'], heartbeatMs = 25_000 }) {
    this.#engine = engine;
    // Longest prefix first, so '/src' is matched before '/'.
    const all = { ...(staticDir ? { '/': staticDir } : {}), ...mounts };
    this.#opts = {
      token, origins, heartbeatMs,
      mounts: Object.entries(all).sort((a, b) => b[0].length - a[0].length),
    };
  }

  get engine() { return this.#engine; }
  get address() { return this.#server?.address() ?? null; }
  get url() {
    const a = this.address;
    return a ? `http://127.0.0.1:${a.port}` : null;
  }

  /** @param {number} port @param {string} [host] */
  async listen(port = 0, host = '127.0.0.1') {
    this.#server = createServer((req, res) => {
      this.#handle(req, res).catch((err) => this.#fail(res, err));
    });
    // Long-polling clients on a slow link must not be cut off mid-request.
    this.#server.keepAliveTimeout = 65_000;
    this.#server.headersTimeout = 70_000;

    await new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, host, resolve);
    });

    // Comment frames keep proxies from closing an idle stream. Without this a
    // stream behind an aggressive NAT dies after a minute and every client
    // silently falls back to polling.
    this.#heartbeat = setInterval(() => {
      for (const res of this.#streams) res.write(': keep-alive\n\n');
    }, this.#opts.heartbeatMs);
    this.#heartbeat.unref?.();

    return this;
  }

  async close() {
    clearInterval(this.#heartbeat);
    for (const res of this.#streams) res.end();
    this.#streams.clear();
    await new Promise((resolve) => (this.#server ? this.#server.close(resolve) : resolve()));
    this.#server = null;
    await this.#engine.close();
  }

  /* ---------------------------------------------------------------- routing */

  async #handle(req, res) {
    this.#cors(req, res);
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    const url = new URL(req.url, 'http://localhost');
    switch (`${req.method} ${url.pathname}`) {
      case 'POST /v1/sync': return this.#sync(req, res);
      case 'GET /v1/stream': return this.#stream(req, res, url);
      case 'GET /v1/health': return this.#json(res, 200, { ok: true, node: this.#engine.node });
      case 'GET /v1/info':
        return this.#json(res, 200, {
          ok: true,
          node: this.#engine.node,
          protocolVersion: PROTOCOL_VERSION,
          codecVersion: CODEC_VERSION,
          limits: this.#engine.limits,
          rooms: this.#engine.roomCount,
        });
      case 'GET /v1/room': {
        const room = url.searchParams.get('name');
        if (!room) return this.#json(res, 400, { error: 'room name is required' });
        await this.#inspect(req, room);
        if (!this.#engine.hasRoom(room)) return this.#json(res, 404, { error: 'room not found' });
        return this.#json(res, 200, await this.#engine.roomStats(room));
      }
      case 'GET /v1/stats':
        // Lists every room, so it needs a credential covering all of them.
        await this.#inspect(req, null);
        return this.#json(res, 200, await this.#engine.stats());
      default:
        if (req.method === 'GET' && this.#opts.mounts.length) return this.#static(url, res);
        return this.#json(res, 404, { error: 'not found' });
    }
  }

  #cors(req, res) {
    const allowed = this.#opts.origins;
    const origin = req.headers.origin;
    const value = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : null);
    if (value) res.setHeader('access-control-allow-origin', value);
    res.setHeader('access-control-allow-headers', 'content-type, authorization, content-encoding');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('vary', 'origin');
  }

  /** The bearer credential, if any -- passed through to the engine's hook. */
  #credential(req) {
    const header = req.headers.authorization ?? '';
    return header.startsWith('Bearer ') ? header.slice(7) : null;
  }

  /** The deployment-wide token, compared in constant time. */
  #authorise(req) {
    if (!this.#opts.token) return;
    const supplied = Buffer.from(this.#credential(req) ?? '');
    const expected = Buffer.from(this.#opts.token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new AuthError('missing or invalid bearer token');
    }
  }

  #context(req) {
    return { ip: req.socket.remoteAddress, credential: this.#credential(req) };
  }

  /** Operational endpoints reveal room names and sizes; gate them like sync. */
  async #inspect(req, room) {
    this.#authorise(req);
    await this.#engine.authorize({ ...this.#context(req), action: 'inspect', room, writes: false });
  }

  /* ------------------------------------------------------------------ sync */

  async #sync(req, res) {
    this.#authorise(req);

    const body = await readBody(req, this.#engine.limits.maxBodyBytes);
    const encoding = req.headers['content-encoding'] === Encoding.DEFLATE
      ? Encoding.DEFLATE : Encoding.JSON;
    const message = await unpackMessage(body, encoding);

    const ctx = this.#context(req);
    const reply = message.t === MessageType.HELLO
      ? await this.#engine.handleHello(message, ctx)
      : await this.#engine.handleSync(message, ctx);

    // Compress the reply only if the client said it can decompress, and only
    // when it actually pays -- see `packMessage`.
    const wants = (req.headers['accept-encoding'] ?? '').includes('deflate-raw');
    const frame = await packMessage(reply, { compress: wants });

    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': frame.wireBytes,
      ...(frame.encoding === Encoding.DEFLATE ? { 'content-encoding': frame.encoding } : {}),
    });
    res.end(frame.bytes);
  }

  /* ---------------------------------------------------------------- stream */

  async #stream(req, res, url) {
    this.#authorise(req);
    const room = url.searchParams.get('room');
    const node = url.searchParams.get('node') ?? undefined;
    if (!room) return this.#json(res, 400, { error: 'room is required' });
    const listener = (ops, from) => {
      // Only a notification, never the operations themselves: the client pulls
      // through the normal path, so a missed frame costs latency, not data --
      // which is also why one arriving before the headers can simply be dropped.
      if (!res.headersSent) return;
      res.write(`data: ${JSON.stringify({ t: 'event', n: ops.length, from })}\n\n`);
    };

    // Subscribing throttles and authorises, and happens before the headers go
    // out, so a refusal is a status code rather than a stream that opens and dies.
    const { off, have } = await this.#engine.subscribe(room, listener, { node, ...this.#context(req) });

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Defeats proxy buffering, which otherwise holds events until the
      // response closes and makes the stream useless.
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    this.#streams.add(res);
    res.write(`data: ${JSON.stringify({ t: 'ready', have: have.toJSON() })}\n\n`);

    const cleanup = () => { off(); this.#streams.delete(res); };
    req.on('close', cleanup);
    req.on('error', cleanup);
  }

  /* ---------------------------------------------------------------- static */

  async #static(url, res) {
    const mount = this.#opts.mounts.find(([prefix]) =>
      url.pathname === prefix || url.pathname.startsWith(prefix === '/' ? '/' : `${prefix}/`));
    if (!mount) return this.#json(res, 404, { error: 'not found' });

    const [prefix, root] = mount;
    const relative = url.pathname.slice(prefix === '/' ? 0 : prefix.length) || '/';
    const requested = relative === '/' ? '/index.html' : relative;

    // Resolve, then confirm the result is still inside the root. Checking the
    // resolved path rather than the requested one is what makes `..`, encoded
    // separators and symlink-ish tricks all fail the same way.
    const target = resolve(root, `.${normalize(requested)}`);
    const rootResolved = resolve(root);
    if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
      return this.#json(res, 403, { error: 'forbidden' });
    }

    // Node resolves bare specifiers without an extension; browsers do not.
    // Trying `.js` lets the same source files load unmodified in both, so the
    // demo runs the engine itself rather than a bundled copy of it.
    for (const candidate of extname(target) ? [target] : [target, `${target}.js`]) {
      try {
        const info = await stat(candidate);
        if (!info.isFile()) continue;
        const body = await readFile(candidate);
        res.writeHead(200, {
          'content-type': MIME[extname(candidate)] ?? 'application/octet-stream',
          'content-length': body.length,
          'cache-control': 'no-cache',
        });
        return res.end(body);
      } catch { /* try the next candidate */ }
    }
    this.#json(res, 404, { error: 'not found' });
  }

  /* ----------------------------------------------------------------- utils */

  #json(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  }

  #fail(res, err) {
    if (res.headersSent) return res.end();
    const wait = err?.code === 'E_LIMIT' ? err.details?.retryAfterMs : undefined;
    if (Number.isFinite(wait)) res.setHeader('retry-after', String(Math.max(1, Math.ceil(wait / 1000))));
    this.#json(res, SyncServer.statusFor(err), SyncServer.toErrorMessage(err));
  }
}

/**
 * What `startServer` enforces unless told otherwise. A replica that is opening,
 * catching up and pushing a backlog makes a few dozen requests back to back,
 * then settles to one per poll; 40 covers the burst and 5/s is far above any
 * honest steady state. The per-IP budget assumes up to ~25 busy people behind
 * one address.
 */
export const DEFAULT_RATE_LIMIT = Object.freeze({
  perSecond: 5, burst: 40,
  perIp: Object.freeze({ perSecond: 125, burst: 1000 }),
});

/**
 * Convenience factory: a listening server with SQLite-backed rooms.
 * `rateLimit: false` turns limiting off.
 * @param {object} opts
 */
export async function startServer({
  port = 8787, host = '127.0.0.1', dataDir = './data', schema,
  token, secret, authorize, staticDir, mounts, origins, memory = false,
  rateLimit = DEFAULT_RATE_LIMIT,
} = {}) {
  const { SqliteAdapter } = await import('#storage/sqlite');
  const { MemoryAdapter } = await import('#storage/adapter');
  const { mkdir } = await import('node:fs/promises');
  if (!memory) await mkdir(dataDir, { recursive: true });

  const engine = new SyncServer({
    schema,
    // `secret` turns on room-scoped tokens; `authorize` is the general hook.
    authorize: authorize ?? (secret ? roomTokens(secret) : undefined),
    rateLimit: rateLimit || undefined,
    // One database file per room: rooms stay isolated, and a room can be
    // backed up, moved or deleted without touching the others.
    storage: async (room) => (memory
      ? new MemoryAdapter({ name: room })
      : new SqliteAdapter({ path: join(dataDir, `${room.replace(/[^\w.-]/g, '_')}.sqlite`) })),
  });

  return new HttpSyncServer({ engine, token, staticDir, mounts, origins }).listen(port, host);
}
