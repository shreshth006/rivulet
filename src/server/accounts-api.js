/**
 * @file The JSON API behind sign-in, notebooks, sharing and the admin console.
 *
 * Mounted under `/api` by {@link HttpSyncServer} when a deployment has
 * accounts. The sync protocol itself is untouched: a signed-in page asks
 * `GET /api/me` for a sync token and hands it to its transport as the bearer
 * credential, and the engine's `authorize` hook (`AccountStore#authorizer`)
 * checks it on every sync.
 *
 *   POST   /api/auth/register            create an account and sign in
 *   POST   /api/auth/login               sign in; sets the session cookie
 *   POST   /api/auth/logout              end this session
 *   GET    /api/me                       who am I (user null if signed out), plus a sync token
 *   POST   /api/me/password              change my password
 *   GET    /api/notebooks                notebooks I can open
 *   POST   /api/notebooks                create one
 *   PATCH  /api/notebooks/:id            rename (owner)
 *   DELETE /api/notebooks/:id            delete (owner or admin)
 *   GET    /api/notebooks/:id/members    who has access (members)
 *   POST   /api/notebooks/:id/members    share by username (owner)
 *   DELETE /api/notebooks/:id/members/:u unshare (owner), or leave (self)
 *   GET    /api/admin/overview           counts, storage and server health
 *   GET    /api/admin/users              every account
 *   POST   /api/admin/users              create an account with any role
 *   PATCH  /api/admin/users/:id          role, disabled, display name, password
 *   DELETE /api/admin/users/:id          delete an account and what it owns
 *   GET    /api/admin/notebooks          every notebook, with sync statistics
 *   DELETE /api/admin/notebooks/:id      delete any notebook
 *   GET    /api/admin/audit              the audit log
 *   GET    /api/admin/schema             the accounts database's schema
 *
 * Sessions are an HttpOnly, SameSite=Lax cookie holding a random token, of
 * which the database keeps only a hash. Every request that changes something
 * must be `application/json`, which a cross-site form cannot send without a
 * CORS preflight this API never grants, so cookies cannot be ridden from
 * another site.
 */

import { AuthError, ValidationError, RivuletError } from '#core/errors';
import { RateLimiter } from '#server/rate-limit';

const COOKIE = 'rv_session';
const MAX_BODY = 16 * 1024;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = req.headers['content-type'] ?? '';
    if (!type.startsWith('application/json')) {
      reject(new HttpError(415, 'requests that change something must be application/json'));
      return;
    }
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY) { reject(new HttpError(413, 'request body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!total) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'the body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
  }
  return out;
}

function send(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

/**
 * @param {object} opts
 * @param {import('#server/accounts').AccountStore} opts.store
 * @param {import('#server/engine').SyncServer} opts.engine
 * @param {boolean} [opts.signup] whether anyone may create an account
 * @param {(room: string) => Promise<void>} [opts.dropRoom] delete a room's
 *   operation log once its notebook is gone
 * @param {boolean} [opts.trustProxy] take the client address and scheme from
 *   X-Forwarded-For / X-Forwarded-Proto (behind a platform's load balancer)
 * @param {{ perSecond: number, burst: number } | false} [opts.loginRate]
 *   attempts per address at signing in and registering
 * @returns {(req, res, url: URL) => Promise<void>}
 */
export function accountsApi({
  store, engine, signup = true, dropRoom = async () => {}, trustProxy = false,
  loginRate = { perSecond: 1 / 6, burst: 10 },
}) {
  const limiter = loginRate ? new RateLimiter(loginRate) : null;
  const started = Date.now();

  const ip = (req) => (trustProxy && req.headers['x-forwarded-for']
    ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
    : req.socket.remoteAddress);
  const secure = (req) => Boolean(req.socket.encrypted)
    || (trustProxy && String(req.headers['x-forwarded-proto'] ?? '').startsWith('https'));

  const sessionCookie = (req, token, maxAgeSeconds) => [
    `${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`,
    ...(secure(req) ? ['Secure'] : []),
  ].join('; ');

  function throttle(req) {
    if (!limiter) return;
    const result = limiter.take(ip(req));
    if (!result.ok) {
      const err = new HttpError(429, 'too many attempts; wait a minute and try again');
      err.retryAfter = Math.ceil(result.retryAfterMs / 1000);
      throw err;
    }
  }

  function current(req) {
    return store.session(cookies(req)[COOKIE]);
  }

  function signedIn(req) {
    const live = current(req);
    if (!live) throw new HttpError(401, 'sign in first');
    return live;
  }

  function admin(req) {
    const live = signedIn(req);
    if (live.user.role !== 'admin') throw new HttpError(403, 'this needs an admin account');
    return live;
  }

  function notebookFor(id, user, { need = 'member' } = {}) {
    const notebook = store.notebook(id);
    const role = notebook && store.roleIn(id, user);
    const isAdmin = user.role === 'admin';
    if (!notebook || (!role && !isAdmin)) throw new HttpError(404, 'no such notebook');
    if (need === 'owner' && role !== 'owner' && !isAdmin) throw new HttpError(403, 'only the owner can do that');
    return { notebook, role };
  }

  async function signIn(req, res, username, password, status = 200) {
    const { user, token, sessionId, expiresAt } = await store.login({
      username, password, ip: ip(req), userAgent: req.headers['user-agent'],
    });
    const maxAge = Math.floor((expiresAt - Date.now()) / 1000);
    send(res, status, { user, syncToken: store.syncToken(sessionId) },
      { 'set-cookie': sessionCookie(req, token, maxAge) });
  }

  async function roomStats(room) {
    try {
      const s = await engine.roomStats(room);
      return { operations: s.operations, replicas: s.replicas, bytes: s.bytes, connections: s.connections, lastActivity: s.lastActivity ?? null };
    } catch {
      return null;
    }
  }

  /** [method, pattern, handler]; handlers get (req, res, params). */
  const routes = [
    ['POST', /^\/api\/auth\/register$/, async (req, res) => {
      throttle(req);
      if (!signup) throw new HttpError(403, 'sign-up is closed on this server; ask an admin for an account');
      const body = await readJson(req);
      const user = await store.createUser({
        username: body.username, password: body.password, displayName: body.displayName,
      });
      // A new account starts with somewhere to write.
      store.createNotebook(user, { title: 'My notebook' });
      await signIn(req, res, body.username, body.password, 201);
    }],

    ['POST', /^\/api\/auth\/login$/, async (req, res) => {
      throttle(req);
      const body = await readJson(req);
      await signIn(req, res, body.username, body.password);
    }],

    ['POST', /^\/api\/auth\/logout$/, async (req, res) => {
      const live = current(req);
      if (live) store.logout(live.sessionId);
      send(res, 200, { ok: true }, { 'set-cookie': sessionCookie(req, '', 0) });
    }],

    ['GET', /^\/api\/me$/, async (req, res) => {
      // Signed out is an answer, not an error: 200 with no user.
      const live = current(req);
      if (!live) return send(res, 200, { user: null, signup });
      send(res, 200, { user: live.user, syncToken: store.syncToken(live.sessionId), signup });
    }],

    ['POST', /^\/api\/me\/password$/, async (req, res) => {
      const live = signedIn(req);
      const body = await readJson(req);
      await store.changePassword(live.user, body.current, body.next, live.sessionId);
      send(res, 200, { ok: true });
    }],

    ['GET', /^\/api\/notebooks$/, async (req, res) => {
      const { user } = signedIn(req);
      send(res, 200, { notebooks: store.notebooksOf(user) });
    }],

    ['POST', /^\/api\/notebooks$/, async (req, res) => {
      const { user } = signedIn(req);
      const body = await readJson(req);
      send(res, 201, { notebook: store.createNotebook(user, { title: body.title, encrypted: Boolean(body.encrypted) }) });
    }],

    ['PATCH', /^\/api\/notebooks\/(\d+)$/, async (req, res, [id]) => {
      const { user } = signedIn(req);
      notebookFor(id, user, { need: 'owner' });
      const body = await readJson(req);
      send(res, 200, { notebook: store.renameNotebook(id, body.title, user) });
    }],

    ['DELETE', /^\/api\/notebooks\/(\d+)$/, async (req, res, [id]) => {
      const { user } = signedIn(req);
      notebookFor(id, user, { need: 'owner' });
      await dropRoom(store.deleteNotebook(id, user));
      send(res, 200, { ok: true });
    }],

    ['GET', /^\/api\/notebooks\/(\d+)\/members$/, async (req, res, [id]) => {
      const { user } = signedIn(req);
      const { role } = notebookFor(id, user);
      send(res, 200, { members: store.members(id), role: role ?? 'admin' });
    }],

    ['POST', /^\/api\/notebooks\/(\d+)\/members$/, async (req, res, [id]) => {
      const { user } = signedIn(req);
      notebookFor(id, user, { need: 'owner' });
      const body = await readJson(req);
      send(res, 200, { members: store.addMember(id, body.username, body.role ?? 'editor', user) });
    }],

    ['DELETE', /^\/api\/notebooks\/(\d+)\/members\/(\d+)$/, async (req, res, [id, member]) => {
      const { user } = signedIn(req);
      // Anyone may leave; only the owner may remove someone else.
      notebookFor(id, user, { need: member === user.id ? 'member' : 'owner' });
      send(res, 200, { members: store.removeMember(id, member, user) });
    }],

    ['GET', /^\/api\/admin\/overview$/, async (req, res) => {
      admin(req);
      const rooms = (await engine.stats()).rooms;
      const memory = process.memoryUsage();
      send(res, 200, {
        accounts: store.counts(),
        sync: {
          openRooms: rooms.length,
          operations: rooms.reduce((n, r) => n + r.operations, 0),
          bytes: rooms.reduce((n, r) => n + r.bytes, 0),
          replicas: rooms.reduce((n, r) => n + r.replicas, 0),
          connections: rooms.reduce((n, r) => n + r.connections, 0),
        },
        server: {
          node: engine.node,
          startedAt: started,
          uptimeSeconds: Math.round((Date.now() - started) / 1000),
          rssBytes: memory.rss,
          heapBytes: memory.heapUsed,
          nodeVersion: process.version,
          signup,
        },
      });
    }],

    ['GET', /^\/api\/admin\/users$/, async (req, res) => {
      admin(req);
      send(res, 200, { users: store.users() });
    }],

    ['POST', /^\/api\/admin\/users$/, async (req, res) => {
      const { user } = admin(req);
      const body = await readJson(req);
      const created = await store.createUser({
        username: body.username, password: body.password, displayName: body.displayName, role: body.role ?? 'user',
      }, user);
      store.createNotebook(created, { title: 'My notebook' });
      send(res, 201, { user: store.user(created.id) });
    }],

    ['PATCH', /^\/api\/admin\/users\/(\d+)$/, async (req, res, [id]) => {
      const { user } = admin(req);
      const body = await readJson(req);
      if (id === user.id && (body.disabled === true || (body.role !== undefined && body.role !== 'admin'))) {
        throw new HttpError(400, 'you cannot disable or demote the account you are signed in with');
      }
      if (body.password !== undefined) await store.setPassword(id, body.password, user);
      const updated = store.updateUser(id, {
        role: body.role, disabled: body.disabled, displayName: body.displayName,
      }, user);
      send(res, 200, { user: updated });
    }],

    ['DELETE', /^\/api\/admin\/users\/(\d+)$/, async (req, res, [id]) => {
      const { user } = admin(req);
      if (id === user.id) throw new HttpError(400, 'you cannot delete your own account while signed in to it');
      for (const room of store.deleteUser(id, user)) await dropRoom(room);
      send(res, 200, { ok: true });
    }],

    ['GET', /^\/api\/admin\/notebooks$/, async (req, res) => {
      admin(req);
      const notebooks = [];
      for (const notebook of store.notebooks()) notebooks.push({ ...notebook, sync: await roomStats(notebook.room) });
      send(res, 200, { notebooks });
    }],

    ['DELETE', /^\/api\/admin\/notebooks\/(\d+)$/, async (req, res, [id]) => {
      const { user } = admin(req);
      await dropRoom(store.deleteNotebook(id, user));
      send(res, 200, { ok: true });
    }],

    ['GET', /^\/api\/admin\/audit$/, async (req, res, _params, url) => {
      admin(req);
      send(res, 200, { events: store.audit(url.searchParams.get('limit') ?? 100) });
    }],

    ['GET', /^\/api\/admin\/schema$/, async (req, res) => {
      admin(req);
      send(res, 200, { objects: store.schema() });
    }],
  ];

  return async function handle(req, res, url) {
    try {
      for (const [method, pattern, handler] of routes) {
        const match = pattern.exec(url.pathname);
        if (!match) continue;
        if (req.method !== method) continue;
        return await handler(req, res, match.slice(1).map(Number), url);
      }
      const known = routes.some(([, pattern]) => pattern.test(url.pathname));
      send(res, known ? 405 : 404, { error: known ? 'method not allowed' : 'not found' });
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) {
        return send(res, err.status, { error: err.message },
          err.retryAfter ? { 'retry-after': String(err.retryAfter) } : {});
      }
      if (err instanceof AuthError) return send(res, 401, { error: err.message });
      if (err instanceof ValidationError) return send(res, 400, { error: err.message });
      if (err instanceof RivuletError) return send(res, 400, { error: err.message });
      console.error('[accounts]', err);
      send(res, 500, { error: 'internal server error' });
    }
  };
}
