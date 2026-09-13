#!/usr/bin/env node
/**
 * Two replicas, one partition, no lost work.
 *
 *   node --experimental-sqlite examples/two-replicas.js
 *
 * Everything runs in this process: two clients, one server, and a link that
 * can be switched off. The point is to show the shape of the API and what
 * actually happens to concurrent edits, without needing a network.
 */

import { defineSchema } from '#core/schema';
import { RivuletClient } from '#client/client';
import { LoopbackTransport } from '#client/transport';
import { SyncServer } from '#server/engine';
import { MemoryAdapter } from '#storage/adapter';
import { TransportError } from '#core/errors';

const schema = defineSchema({
  notes: {
    title: 'lww',       // newest rename wins
    body: 'text',       // character-level merge
    tags: 'set',        // add-wins
    reads: 'counter',   // increments add up
  },
});

const server = new SyncServer({
  storage: async () => new MemoryAdapter(),
  schema: schema.fingerprint,
});

/** A link we can switch off, standing in for a network that comes and goes. */
function makeLink() {
  const link = { up: true };
  link.hook = async (exchange) => {
    if (!link.up) throw new TransportError('offline', { kind: 'unreachable' });
    return (await exchange()).reply;
  };
  return link;
}

async function connect(label) {
  const link = makeLink();
  const client = await RivuletClient.open({
    schema,
    room: 'demo',
    storage: new MemoryAdapter({ name: label }),
    transport: (node) => new LoopbackTransport(server, { node, room: 'demo', link: link.hook }),
    sync: { pollMs: 1e9, debounceMs: 1e9 },
  });
  client.link = link;
  return client;
}

const alice = await connect('alice');
const bob = await connect('bob');

// ---- a shared starting point ------------------------------------------------

const id = alice.mutate((tx) => tx.create('notes', {
  title: 'Wifi', body: 'The wifi is down.', tags: ['infra'], reads: 0,
}));
await alice.syncUntilIdle();
await bob.syncUntilIdle();
console.log('both replicas start from:', JSON.stringify(bob.get('notes', id).body));

// ---- both go offline and edit the same note ---------------------------------

alice.link.up = false;
bob.link.up = false;

alice.mutate((tx) => tx.setText('notes', id, 'body', 'The hostel wifi is down.'));
alice.mutate((tx) => tx.increment('notes', id, 'reads', 2));

bob.mutate((tx) => tx.setText('notes', id, 'body', 'The wifi is down again.'));
bob.mutate((tx) => tx.add('notes', id, 'tags', 'urgent'));
bob.mutate((tx) => tx.increment('notes', id, 'reads', 3));

// Reads still work while disconnected -- that is the whole point.
console.log('alice sees offline:      ', JSON.stringify(alice.get('notes', id).body));
console.log('bob sees offline:        ', JSON.stringify(bob.get('notes', id).body));
console.log('alice has queued:        ', await alice.pendingCount(), 'operations');

// ---- reconnect --------------------------------------------------------------

alice.link.up = true;
bob.link.up = true;
for (let i = 0; i < 3; i++) {
  await alice.syncUntilIdle();
  await bob.syncUntilIdle();
}

const merged = alice.get('notes', id);
console.log('\nafter reconciliation:');
console.log('  body: ', JSON.stringify(merged.body));
console.log('  tags: ', merged.tags.join(', '));
console.log('  reads:', merged.reads, '(2 + 3, summed rather than overwritten)');
console.log('  identical on both replicas:',
  JSON.stringify(merged) === JSON.stringify(bob.get('notes', id)));

await alice.close();
await bob.close();
await server.close();
