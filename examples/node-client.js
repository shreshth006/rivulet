#!/usr/bin/env node
/**
 * A durable Node client talking to a real server over HTTP.
 *
 *   # terminal 1 (--open-schema: this client has its own schema)
 *   node --experimental-sqlite apps/cli/serve.js --port 8787 --open-schema
 *
 *   # terminal 2
 *   node --experimental-sqlite examples/node-client.js
 *
 * State is kept in a SQLite file, so running it twice shows the restart path:
 * the replica keeps its identity, resumes its sequence numbering, and replays
 * its log rather than starting over.
 */

import { defineSchema } from '#core/schema';
import { RivuletClient } from '#client/client';
import { HttpTransport } from '#client/transport';
import { SqliteAdapter } from '#storage/sqlite';

const url = process.env.RIVULET_URL ?? 'http://127.0.0.1:8787';
const path = process.env.RIVULET_DB ?? './example-client.sqlite';

const schema = defineSchema({
  notes: { title: 'lww', body: 'text', tags: 'set', reads: 'counter' },
});

const client = await RivuletClient.open({
  schema,
  room: 'notebook',
  // A file, so the replica survives restarts. Identity, sequence numbers and
  // the clock all resume from here.
  storage: new SqliteAdapter({ path }),
  transport: (node) => new HttpTransport({ url, room: 'notebook', node }),
});

console.log(`replica ${client.node}`);
console.log(`storage  ${path}`);
console.log(`status   ${client.status}`);

const existing = client.list('notes');
if (existing.length) {
  console.log(`\nrestored ${existing.length} note(s) from the local log:`);
  for (const note of existing.slice(0, 5)) {
    console.log(`  ${note.title} — ${note.reads} read(s)`);
  }
} else {
  console.log('\nno local state; creating a note');
}

// A write returns immediately whether or not the server is reachable.
const id = existing[0]?.id ?? client.mutate((tx) => tx.create('notes', {
  title: `Note from ${client.node.slice(0, 6)}`, body: 'Written locally.', tags: ['example'],
}));
client.mutate((tx) => tx.increment('notes', id, 'reads', 1));

const result = await client.sync();
if (result.error) {
  console.log(`\nserver unreachable (${result.error.message}).`);
  console.log(`${await client.pendingCount()} operation(s) queued; run again once it is up.`);
} else {
  console.log(`\nsynced: pushed ${result.pushed}, pulled ${result.pulled}`);
  console.log(`pending: ${await client.pendingCount()}`);
}

const stats = await client.stats();
console.log(`wire:    ${stats.sync.bytes?.totalWire ?? 0} bytes this session`);

await client.close();
