#!/usr/bin/env node
/**
 * @file Start a sync server, optionally with the demo app attached.
 *
 *   node --experimental-sqlite apps/cli/serve.js --demo
 *   node --experimental-sqlite apps/cli/serve.js --port 8080 --data ./data
 *   node --experimental-sqlite apps/cli/serve.js --token secret
 *   RIVULET_SECRET=... node --experimental-sqlite apps/cli/serve.js --room-tokens
 *   RIVULET_ADMIN_PASSWORD=... node --experimental-sqlite apps/cli/serve.js --demo --accounts
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { startServer, roomFile, DEFAULT_RATE_LIMIT } from '#server/http';
import { AccountStore } from '#server/accounts';
import { accountsApi } from '#server/accounts-api';
import { RivuletClient } from '#client/client';
import { HttpTransport } from '#client/transport';
import { MemoryAdapter } from '#storage/adapter';
import { demoSchema } from '../demo-web/public/schema.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const HELP = `
rivulet sync server

  node --experimental-sqlite apps/cli/serve.js [options]

Options:
  --port <n>     port to listen on (default 8787)
  --host <addr>  address to bind (default 127.0.0.1)
  --data <dir>   where room databases live (default ./data)
  --token <t>    require this one bearer token for everything
  --room-tokens  require a signed room token per request (see apps/cli/token.js);
                 the signing secret is read from RIVULET_SECRET
  --rate <n>     sustained sync requests per second per replica (default ${DEFAULT_RATE_LIMIT.perSecond},
                 burst ${DEFAULT_RATE_LIMIT.burst}); the per-address budget scales with it
  --no-rate-limit  turn rate limiting off
  --demo         also serve the demo app at /
  --memory       keep everything in memory; nothing survives a restart
  --open-schema  accept any client schema instead of pinning the demo's
  --accounts     user accounts: sign-in, notebooks shared by username, an admin
                 console at /admin.html. Accounts live in <data>/accounts.db.
                 Seeded from the environment on every start (existing accounts
                 are left alone):
                   RIVULET_ADMIN_USER / RIVULET_ADMIN_PASSWORD  (default user
                     'admin'; without a password one is generated and printed)
                   RIVULET_DEMO_USER / RIVULET_DEMO_PASSWORD    optional user
                     with a sample notebook
                 Instead of a *_PASSWORD, a *_PASSWORD_HASH from
                 apps/cli/hash-password.js keeps the plaintext out of the
                 platform's configuration.
                 Signed room tokens still work alongside when RIVULET_SECRET is set.
  --no-signup    with --accounts: only admins create accounts
  --trust-proxy  read the client address and https from X-Forwarded-* headers
                 (set this behind a platform load balancer, never on the open internet)
  -h, --help     this message

Flags in RIVULET_FLAGS (space-separated) are added to the command line, so a
hosting platform can configure the container image without rebuilding it.
`;

function parseArgs(argv) {
  const opts = {
    port: 8787, host: '127.0.0.1', data: './data',
    token: undefined, roomTokens: false, demo: false, memory: false, openSchema: false,
    rate: DEFAULT_RATE_LIMIT.perSecond, rateLimit: true,
    accounts: false, signup: true, trustProxy: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--port': opts.port = Number(argv[++i]); break;
      case '--host': opts.host = argv[++i]; break;
      case '--data': opts.data = argv[++i]; break;
      case '--token': opts.token = argv[++i]; break;
      case '--room-tokens': opts.roomTokens = true; break;
      case '--rate': opts.rate = Number(argv[++i]); break;
      case '--no-rate-limit': opts.rateLimit = false; break;
      case '--demo': opts.demo = true; break;
      case '--memory': opts.memory = true; break;
      case '--open-schema': opts.openSchema = true; break;
      case '--accounts': opts.accounts = true; break;
      case '--no-signup': opts.signup = false; break;
      case '--trust-proxy': opts.trustProxy = true; break;
      case '-h': case '--help': opts.help = true; break;
      default: throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return opts;
}

const envFlags = (process.env.RIVULET_FLAGS ?? '').split(/\s+/).filter(Boolean);
const opts = parseArgs([...process.argv.slice(2), ...envFlags]);
if (opts.help) { console.log(HELP); process.exit(0); }
// The secret comes from the environment, not argv: arguments show up in `ps`.
const secret = opts.roomTokens ? process.env.RIVULET_SECRET : undefined;
if (opts.roomTokens && !secret) throw new Error('--room-tokens needs RIVULET_SECRET set');
if (opts.roomTokens && opts.token) throw new Error('use --token or --room-tokens, not both');
if (opts.accounts && opts.token) throw new Error('use --token or --accounts, not both');
if (!(opts.rate > 0)) throw new Error('--rate must be a positive number');

// Scale the whole default policy, burst and per-address budget included.
const scale = opts.rate / DEFAULT_RATE_LIMIT.perSecond;
const rateLimit = opts.rateLimit && {
  perSecond: opts.rate,
  burst: Math.max(1, Math.round(DEFAULT_RATE_LIMIT.burst * scale)),
  perIp: {
    perSecond: DEFAULT_RATE_LIMIT.perIp.perSecond * scale,
    burst: Math.max(1, Math.round(DEFAULT_RATE_LIMIT.perIp.burst * scale)),
  },
};

/* ---------------------------------------------------------------- accounts */

let store = null;
let seeded = null;
if (opts.accounts) {
  if (!opts.memory) await mkdir(opts.data, { recursive: true });
  store = new AccountStore({ path: opts.memory ? ':memory:' : join(opts.data, 'accounts.db') });

  // A *_PASSWORD_HASH wins over a *_PASSWORD, so the plaintext need not be
  // in the environment at all.
  const secretFor = (prefix) => {
    const passwordHash = process.env[`${prefix}_PASSWORD_HASH`] || undefined;
    return passwordHash ? { passwordHash } : { password: process.env[`${prefix}_PASSWORD`] || undefined };
  };

  const adminName = process.env.RIVULET_ADMIN_USER || 'admin';
  if (!store.userByName(adminName)) {
    const secret = secretFor('RIVULET_ADMIN');
    const generated = !secret.password && !secret.passwordHash;
    if (generated) secret.password = randomBytes(9).toString('base64url');
    const { user } = await store.ensureUser({ username: adminName, role: 'admin', displayName: 'Administrator', ...secret });
    store.createNotebook(user, { title: 'Admin notes' });
    console.log(`created admin account "${adminName}"${generated ? ` with password ${secret.password}` : ''}`);
  }

  const demoName = process.env.RIVULET_DEMO_USER;
  const demoSecret = secretFor('RIVULET_DEMO');
  if (demoName && (demoSecret.password || demoSecret.passwordHash)) {
    const { user, created } = await store.ensureUser({ username: demoName, displayName: 'Demo user', ...demoSecret });
    if (created) {
      seeded = { user, notebook: store.createNotebook(user, { title: 'Getting started' }) };
      console.log(`created demo account "${demoName}"`);
    }
  }
}

// Removing a notebook's operation log once its notebook row is gone: close
// the room, then delete the file and its WAL companions.
async function dropRoom(room, engine) {
  await engine.closeRoom(room);
  if (opts.memory) return;
  const file = roomFile(opts.data, room);
  await Promise.all(['', '-wal', '-shm'].map((suffix) => rm(`${file}${suffix}`, { force: true })));
}

const server = await startServer({
  port: opts.port,
  host: opts.host,
  dataDir: opts.data,
  memory: opts.memory,
  token: opts.token,
  secret: store ? undefined : secret,
  authorize: store ? store.authorizer({ roomTokenSecret: process.env.RIVULET_SECRET || undefined }) : undefined,
  api: store ? (engine) => accountsApi({
    store, engine, signup: opts.signup, trustProxy: opts.trustProxy,
    dropRoom: (room) => dropRoom(room, engine),
  }) : undefined,
  rateLimit,
  // Pinning the schema turns a client/server version skew into a clear error
  // at connect time instead of operations that silently do nothing.
  schema: opts.openSchema ? undefined : demoSchema.fingerprint,
  mounts: opts.demo
    ? { '/': join(ROOT, 'apps', 'demo-web', 'public'), '/src': join(ROOT, 'src') }
    : undefined,
});

const { port } = server.address;
console.log(`rivulet sync server on http://${opts.host}:${port}`);
console.log(`  storage   ${opts.memory ? 'in memory (not durable)' : resolve(opts.data)}`);
console.log(`  auth      ${store ? `accounts (${opts.signup ? 'open sign-up' : 'admins create accounts'})${process.env.RIVULET_SECRET ? ' + room tokens' : ''}`
  : secret ? 'room tokens required' : opts.token ? 'bearer token required' : 'open'}`);
console.log(`  limits    ${rateLimit ? `${rateLimit.perSecond}/s per replica (burst ${rateLimit.burst}), ${rateLimit.perIp.perSecond}/s per address` : 'no rate limit'}`);
if (opts.demo) {
  console.log(`  demo      http://${opts.host}:${port}/`);
  if (store) console.log(`  admin     http://${opts.host}:${port}/admin.html`);
  console.log('\nOpen it in two windows to watch them sync.');
}

/**
 * A demo account starts with a few notes, written the way any client writes
 * them: a replica signs in, mutates locally and syncs over HTTP.
 */
if (seeded) {
  // The server's own session for the demo user; no password needed or kept.
  const { sessionId } = store.openSession(seeded.user, { record: 'seed' });
  const room = seeded.notebook.room;
  const client = await RivuletClient.open({
    schema: demoSchema, room,
    storage: new MemoryAdapter({ name: 'seed' }),
    transport: (node) => new HttpTransport({
      url: `http://127.0.0.1:${port}`, room, node, token: store.syncToken(sessionId),
    }),
    sync: { pollMs: 1e9, debounceMs: 1e9 },
  });
  const notes = [
    { title: 'Welcome to Rivulet', tags: ['start'], votes: 3, estimate: 1,
      body: 'Everything you type here is saved on this device first and synced when the network allows.\n\nTry it: open this notebook in two windows, click "Go offline" in one, edit the same note in both, then go back online.' },
    { title: 'Sharing a notebook', tags: ['sharing'], votes: 1,
      body: 'Use "Share" to give another user access by username, as an editor (can write) or a viewer (read-only). Access is checked on every sync, so removing someone takes effect immediately.' },
    { title: 'How merges work', tags: ['crdt', 'design'], votes: 2, estimate: 5,
      body: 'Each field has its own merge rule: the title is last-writer-wins, the body merges character by character, tags are an add-wins set, votes add up, and the estimate keeps both values when two people change it at once.' },
  ];
  for (const note of notes) client.mutate((tx) => tx.create('notes', note));
  await client.syncUntilIdle();
  await client.close();
  store.logout(sessionId);
  console.log(`  seeded    ${notes.length} notes into "${seeded.notebook.title}"`);
}

const shutdown = async (signal) => {
  console.log(`\n${signal}: shutting down`);
  await server.close();
  store?.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
