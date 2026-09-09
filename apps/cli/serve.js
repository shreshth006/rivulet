#!/usr/bin/env node
/**
 * @file Start a sync server, optionally with the demo app attached.
 *
 *   node --experimental-sqlite apps/cli/serve.js --demo
 *   node --experimental-sqlite apps/cli/serve.js --port 8080 --data ./data
 *   node --experimental-sqlite apps/cli/serve.js --token secret
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { startServer } from '#server/http';
import { demoSchema } from '../demo-web/public/schema.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const HELP = `
rivulet sync server

  node --experimental-sqlite apps/cli/serve.js [options]

Options:
  --port <n>     port to listen on (default 8787)
  --host <addr>  address to bind (default 127.0.0.1)
  --data <dir>   where room databases live (default ./data)
  --token <t>    require this bearer token
  --demo         also serve the demo app at /
  --memory       keep everything in memory; nothing survives a restart
  --open-schema  accept any client schema instead of pinning the demo's
  -h, --help     this message
`;

function parseArgs(argv) {
  const opts = {
    port: 8787, host: '127.0.0.1', data: './data',
    token: undefined, demo: false, memory: false, openSchema: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--port': opts.port = Number(argv[++i]); break;
      case '--host': opts.host = argv[++i]; break;
      case '--data': opts.data = argv[++i]; break;
      case '--token': opts.token = argv[++i]; break;
      case '--demo': opts.demo = true; break;
      case '--memory': opts.memory = true; break;
      case '--open-schema': opts.openSchema = true; break;
      case '-h': case '--help': opts.help = true; break;
      default: throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) { console.log(HELP); process.exit(0); }

const server = await startServer({
  port: opts.port,
  host: opts.host,
  dataDir: opts.data,
  memory: opts.memory,
  token: opts.token,
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
console.log(`  auth      ${opts.token ? 'bearer token required' : 'open'}`);
if (opts.demo) {
  console.log(`  demo      http://${opts.host}:${port}/`);
  console.log('\nOpen it in two windows to watch them sync.');
}

const shutdown = async (signal) => {
  console.log(`\n${signal}: shutting down`);
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
