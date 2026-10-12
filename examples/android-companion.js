#!/usr/bin/env node
/**
 * A laptop-side client for the Android Rivulet Notes app's notebook, so a demo
 * can show edits crossing between the phone and a computer.
 *
 *   node --experimental-sqlite examples/android-companion.js list
 *   node --experimental-sqlite examples/android-companion.js add "Title" "Body text"
 *   node --experimental-sqlite examples/android-companion.js append <id-prefix> " more text"
 *   node --experimental-sqlite examples/android-companion.js watch
 *
 * The phone's daemon names the room after the app that owns it:
 * `dev.rivulet.notes/notebook`. The schema must match the one Rivulet Notes
 * registers. RIVULET_URL picks the server (default http://127.0.0.1:8787).
 */

import { defineSchema } from '#core/schema';
import { RivuletClient } from '#client/client';
import { HttpTransport } from '#client/transport';
import { MemoryAdapter } from '#storage/adapter';

const url = process.env.RIVULET_URL ?? 'http://127.0.0.1:8787';
const room = 'dev.rivulet.notes/notebook';
// Must match apps/android/notes/.../Notebook.kt.
const schema = defineSchema({ notes: { title: 'lww', body: 'text', pinned: 'boolean' } });

const [command = 'list', ...args] = process.argv.slice(2);

const client = await RivuletClient.open({
  schema,
  room,
  storage: new MemoryAdapter({ name: 'android-companion' }),
  transport: (node) => new HttpTransport({ url, room, node }),
  sync: { pollMs: 1e9, debounceMs: 50 },
});

const show = () => {
  const notes = client.list('notes', { sort: '-pinned' });
  if (notes.length === 0) console.log('(no notes yet)');
  for (const n of notes) {
    console.log(`${n.id.slice(0, 8)}  ${n.pinned ? '📌 ' : ''}${n.title || 'Untitled'}`);
    if (n.body) console.log(`          ${n.body.replace(/\n/g, '\n          ')}`);
  }
};

const first = await client.syncUntilIdle();
if (first.error) {
  console.error(`could not reach ${url}: ${first.error.message}`);
  await client.close();
  process.exit(1);
}

switch (command) {
  case 'list':
    show();
    break;

  case 'add': {
    const [title = 'From the laptop', body = ''] = args;
    const id = client.mutate((tx) => tx.create('notes', { title, body }));
    await client.syncUntilIdle();
    console.log(`added ${id.slice(0, 8)}: ${title}`);
    break;
  }

  case 'append': {
    const [prefix, text = ''] = args;
    const note = client.list('notes').find((n) => n.id.startsWith(prefix ?? ''));
    if (!prefix || !note) { console.error('usage: append <id-prefix> <text>  (ids from `list`)'); break; }
    client.mutate((tx) => tx.setText('notes', note.id, 'body', note.body + text));
    await client.syncUntilIdle();
    console.log(`appended to ${note.id.slice(0, 8)}`);
    break;
  }

  case 'watch':
    // Re-print whenever the phone (or anyone) changes the notebook.
    console.log('watching for changes; Ctrl+C to stop');
    client.subscribe('notes', () => { console.log(`\n--- ${new Date().toLocaleTimeString()}`); show(); });
    await new Promise(() => {});
    break;

  default:
    console.error(`unknown command: ${command} (list | add | append | watch)`);
}

await client.close();
