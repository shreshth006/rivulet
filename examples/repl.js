#!/usr/bin/env node
/**
 * Interactive REPL for exploring Rivulet locally or connected to a sync server.
 *
 *   node --experimental-sqlite examples/repl.js
 */

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { defineSchema } from '#core/schema';
import { RivuletClient } from '#client/client';
import { MemoryAdapter } from '#storage/adapter';
import { SqliteAdapter } from '#storage/sqlite';
import { HttpTransport } from '#client/transport';

const schema = defineSchema({
  notes: { title: 'lww', body: 'text', tags: 'set', reads: 'counter' },
});

export async function startRepl({
  room = 'demo',
  serverUrl = null,
  dbPath = null,
  interactive = true,
} = {}) {
  const storage = dbPath ? new SqliteAdapter({ path: dbPath }) : new MemoryAdapter({ name: room });
  const transport = serverUrl ? (node) => new HttpTransport({ url: serverUrl, room, node }) : null;

  const client = await RivuletClient.open({
    schema,
    room,
    storage,
    transport,
  });

  console.log(`Rivulet REPL [room: ${room}, node: ${client.node.slice(0, 8)}, status: ${client.status}]`);
  console.log('Type "help" for a list of commands.\n');

  const rl = createInterface({ input, output });

  const printHelp = () => {
    console.log(`
Commands:
  create <title>        Create a new note with title
  list                  List all notes in the database
  find <term>           Search notes containing term in title
  get <id>              Show full note document
  append <id> <text>    Append text to note body
  tag <id> <tag>        Add a tag to note
  read <id>             Increment read count
  delete <id>           Delete note
  stats                 Display database and storage stats
  sync                  Force a sync round with server
  help                  Show this help message
  exit / quit           Close client and exit
`);
  };

  const handleCommand = async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return true;

    const [cmd, ...args] = trimmed.split(/\s+/);
    const argStr = args.join(' ');

    switch (cmd.toLowerCase()) {
      case 'help':
        printHelp();
        break;

      case 'create': {
        if (!argStr) { console.log('Usage: create <title>'); break; }
        const id = client.mutate((tx) => tx.create('notes', { title: argStr, body: '', tags: [] }));
        console.log(`Created note ${id}`);
        break;
      }

      case 'list': {
        const notes = client.list('notes');
        if (!notes.length) { console.log('(no notes)'); break; }
        for (const n of notes) {
          const tags = n.tags?.length ? ` [${n.tags.join(', ')}]` : '';
          console.log(`* ${n.id} | "${n.title}" | reads: ${n.reads}${tags}`);
        }
        break;
      }

      case 'find': {
        if (!argStr) { console.log('Usage: find <term>'); break; }
        const found = client.list('notes', { where: { title: { $regex: argStr } } });
        console.log(`Found ${found.length} note(s):`);
        for (const n of found) console.log(`  ${n.id}: "${n.title}"`);
        break;
      }

      case 'get': {
        if (!args[0]) { console.log('Usage: get <id>'); break; }
        const doc = client.get('notes', args[0]);
        if (!doc) console.log(`Note ${args[0]} not found`);
        else console.log(JSON.stringify(doc, null, 2));
        break;
      }

      case 'append': {
        const [id, ...textParts] = args;
        const text = textParts.join(' ');
        if (!id || !text) { console.log('Usage: append <id> <text>'); break; }
        const cur = client.get('notes', id);
        if (!cur) { console.log(`Note ${id} not found`); break; }
        client.mutate((tx) => tx.setText('notes', id, 'body', (cur.body ?? '') + text));
        console.log(`Updated body for ${id}`);
        break;
      }

      case 'tag': {
        const [id, tag] = args;
        if (!id || !tag) { console.log('Usage: tag <id> <tag>'); break; }
        client.mutate((tx) => tx.add('notes', id, 'tags', tag));
        console.log(`Added tag "${tag}" to ${id}`);
        break;
      }

      case 'read': {
        const id = args[0];
        if (!id) { console.log('Usage: read <id>'); break; }
        client.mutate((tx) => tx.increment('notes', id, 'reads', 1));
        console.log(`Incremented reads for ${id}`);
        break;
      }

      case 'delete': {
        const id = args[0];
        if (!id) { console.log('Usage: delete <id>'); break; }
        client.mutate((tx) => tx.delete('notes', id));
        console.log(`Deleted note ${id}`);
        break;
      }

      case 'stats': {
        const s = await client.stats();
        console.log(JSON.stringify(s, null, 2));
        break;
      }

      case 'sync': {
        const res = await client.sync();
        console.log(`Sync result: pushed ${res.pushed}, pulled ${res.pulled}`);
        break;
      }

      case 'exit':
      case 'quit':
        return false;

      default:
        console.log(`Unknown command: "${cmd}". Type "help" for options.`);
    }
    return true;
  };

  if (!interactive) {
    rl.close();
    await client.close();
    return client;
  }

  try {
    for (;;) {
      const line = await rl.question('rivulet> ');
      const cont = await handleCommand(line);
      if (!cont) break;
    }
  } finally {
    rl.close();
    await client.close();
    console.log('Goodbye!');
  }
  return client;
}

// Auto-run if executed directly as a script
if (process.argv[1]?.endsWith('repl.js')) {
  await startRepl();
}
