/**
 * @file The demo notebook.
 *
 * Plain DOM, no framework -- the point is to show what the engine does, and a
 * framework would only obscure which behaviour comes from where.
 *
 * Two things here are worth reading as guidance rather than demo code:
 *
 * 1. **Inputs send the whole value, not a diff.** `setText` recovers the edit
 *    by comparing with current state, so binding a `<textarea>` is a one-liner
 *    and still produces one operation per keystroke rather than a full replace.
 *
 * 2. **Re-rendering preserves the caret.** A remote edit arriving while you
 *    type must not move your cursor. The engine gives correct text; keeping
 *    the selection sane is the application's job, and getting it wrong is what
 *    makes collaborative editors feel broken.
 */

import { RivuletClient, Status } from '#client/client';
import { HttpTransport } from '#client/transport';
import { defaultAdapter } from '#storage/index';
import { generateRoomKey } from '#protocol/seal';
import { demoSchema, DEMO_ROOM } from '/schema.js';

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ offline */

/**
 * A fetch that can be switched off, so the offline story is demonstrable
 * without touching the browser's network settings. It fails exactly as an
 * unreachable server does -- the engine cannot tell the difference.
 */
let simulatedOffline = false;
const gatedFetch = (...args) => {
  if (simulatedOffline) return Promise.reject(new TypeError('Failed to fetch (simulated)'));
  return fetch(...args);
};

/* -------------------------------------------------------- encrypted rooms */

/**
 * An encrypted room lives entirely in the link: `#room=<name>&key=<key>`. The
 * fragment is never sent to the server, so sharing the link shares the key
 * with the people you send it to and with nobody else -- the server stores the
 * room's operations without ever being able to read them.
 */
const fragment = new URLSearchParams(location.hash.slice(1));
const roomKey = fragment.get('key');
const room = roomKey ? fragment.get('room') : DEMO_ROOM;
const canEncrypt = Boolean(globalThis.crypto?.subtle);

function newEncryptedRoom() {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
  location.hash = new URLSearchParams({ room: `sealed-${id}`, key: generateRoomKey() }).toString();
  location.reload();
}

/* ------------------------------------------------------------------- client */

if (roomKey && (!room || !canEncrypt)) {
  // WebCrypto needs a secure context: https, or localhost.
  document.body.textContent = !room
    ? 'This invite link is missing its room name.'
    : 'Encrypted rooms need a secure context: open this over https or on localhost.';
  throw new Error('cannot open the encrypted room');
}

const client = await RivuletClient.open({
  schema: demoSchema,
  room,
  // IndexedDB on a browser, so edits survive a reload and a closed laptop.
  storage: await defaultAdapter({ name: `rivulet-${room}` }),
  // A factory, because the replica id is restored from storage during open --
  // it does not exist yet at this point in the file.
  transport: (node) => new HttpTransport({
    url: location.origin, room, node, fetch: gatedFetch,
  }),
  sync: { pollMs: 10_000, debounceMs: 250 },
  ...(roomKey ? { encryption: { key: roomKey } } : {}),
});

/* --------------------------------------------------------------------- state */

let selectedId = null;

/* -------------------------------------------------------------------- render */

function renderList() {
  const notes = client.list('notes', {
    sort: (a, b) => (a.title || '').localeCompare(b.title || ''),
  });
  const list = $('note-list');
  list.replaceChildren(...notes.map((note) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-current', String(note.id === selectedId));
    button.onclick = () => select(note.id);

    const title = document.createElement('span');
    title.textContent = note.title || 'Untitled';
    const meta = document.createElement('span');
    meta.className = 'meta';
    const words = note.body.trim() ? note.body.trim().split(/\s+/).length : 0;
    meta.textContent = `${words} word${words === 1 ? '' : 's'}`
      + (note.tags.length ? ` · ${note.tags.length} tag${note.tags.length === 1 ? '' : 's'}` : '')
      + (note.votes ? ` · ${note.votes > 0 ? '+' : ''}${note.votes}` : '');

    button.append(title, meta);
    li.append(button);
    return li;
  }));

  if (selectedId && !client.get('notes', selectedId)) selectedId = null;
  $('editor').hidden = !selectedId;
  $('empty').hidden = !!selectedId;
}

/**
 * Write a value into an input without disturbing the caret.
 *
 * Replacing `.value` while someone is typing jumps the cursor to the end. That
 * is the single most common way a collaborative editor feels broken, and it is
 * an application bug, not a merge bug -- the incoming text is correct.
 */
function setPreservingCaret(el, next) {
  if (el.value === next) return;
  const active = document.activeElement === el;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  const before = el.value;
  el.value = next;

  if (!active) return;
  // Shift the caret by however much the text changed before it.
  const delta = next.length - before.length;
  const insertedBeforeCaret = start > 0 && before.slice(0, start) !== next.slice(0, start);
  const offset = insertedBeforeCaret ? delta : 0;
  const clamp = (n) => Math.max(0, Math.min(next.length, n + offset));
  el.setSelectionRange(clamp(start), clamp(end));
}

function renderEditor() {
  if (!selectedId) return;
  const note = client.get('notes', selectedId);
  if (!note) return;

  setPreservingCaret($('title'), note.title ?? '');
  setPreservingCaret($('body'), note.body ?? '');
  $('votes').textContent = String(note.votes);
  $('doc-id').textContent = note.id;

  const tags = $('tags');
  tags.replaceChildren(...note.tags.map((tag) => {
    const span = document.createElement('span');
    span.className = 'tag';
    span.append(tag);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = `Remove ${tag}`;
    remove.onclick = () => client.mutate((tx) => tx.remove('notes', selectedId, 'tags', tag));
    span.append(remove);
    return span;
  }));

  // Multi-value fields are the one case the user has to resolve. Everything
  // else merged silently and correctly.
  const conflicts = client.conflicts('notes')
    .find((c) => c.doc === selectedId && c.fields.some((f) => f.field === 'estimate'));
  const box = $('conflict');
  if (!conflicts) {
    box.hidden = true;
    if (document.activeElement !== $('estimate')) {
      $('estimate').value = note.estimate ?? '';
    }
  } else {
    box.hidden = false;
    const values = conflicts.fields.find((f) => f.field === 'estimate').values;
    box.replaceChildren(document.createTextNode(
      `Two devices set this concurrently. Both were kept — pick one:`));
    for (const value of values) {
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.textContent = String(value);
      pick.onclick = () => client.mutate((tx) => tx.set('notes', selectedId, 'estimate', value));
      box.append(pick);
    }
  }
}

async function renderStats() {
  const stats = await client.stats();
  $('stat-node').textContent = client.node.slice(0, 8);
  $('stat-pending').textContent = String(stats.pending);
  $('stat-ops').textContent = String(stats.storedOps);
  const wire = stats.sync.bytes?.totalWire ?? 0;
  $('stat-bytes').textContent = wire >= 1024 ? `${(wire / 1024).toFixed(1)} kB` : `${wire} B`;
  $('stat-batch').textContent = String(stats.sync.batching?.size ?? '–');
}

function renderStatus() {
  const status = simulatedOffline ? Status.OFFLINE : client.status;
  const dot = $('dot');
  dot.className = `dot ${status === Status.LIVE ? 'live'
    : status === Status.SYNCING ? 'syncing' : 'offline'}`;

  $('status-text').textContent = simulatedOffline ? 'offline (simulated)'
    : status === Status.LIVE ? 'synced'
      : status === Status.SYNCING ? 'syncing…'
        : status === Status.UNAUTHORISED ? (roomKey ? 'cannot decrypt: wrong room key?' : 'not authorised')
          : 'offline — edits are saved locally';

  $('offline-toggle').textContent = simulatedOffline ? 'Go online' : 'Go offline';
}

function renderAll() {
  renderList();
  renderEditor();
  renderStatus();
  renderStats();
}

/* ------------------------------------------------------------------- actions */

function select(id) {
  selectedId = id;
  renderAll();
  $('title').focus();
}

$('new-note').onclick = () => {
  const id = client.mutate((tx) => tx.create('notes', {
    title: 'Untitled', body: '', tags: [], votes: 0,
  }));
  select(id);
};

$('delete-note').onclick = () => {
  if (!selectedId) return;
  // A soft delete: it is an ordinary write, so it merges with concurrent
  // edits by timestamp and can be undone the same way.
  client.mutate((tx) => tx.delete('notes', selectedId));
  selectedId = null;
  renderAll();
};

$('title').oninput = (ev) => {
  if (selectedId) client.mutate((tx) => tx.set('notes', selectedId, 'title', ev.target.value));
};

$('body').oninput = (ev) => {
  // The whole string goes in; the engine works out which characters changed
  // and sends only those.
  if (selectedId) client.mutate((tx) => tx.setText('notes', selectedId, 'body', ev.target.value));
};

$('tag-input').onkeydown = (ev) => {
  if (ev.key !== 'Enter') return;
  const tag = ev.target.value.trim();
  if (!tag || !selectedId) return;
  client.mutate((tx) => tx.add('notes', selectedId, 'tags', tag));
  ev.target.value = '';
};

$('vote-up').onclick = () => selectedId
  && client.mutate((tx) => tx.increment('notes', selectedId, 'votes', 1));
$('vote-down').onclick = () => selectedId
  && client.mutate((tx) => tx.increment('notes', selectedId, 'votes', -1));

$('estimate').onchange = (ev) => {
  if (!selectedId) return;
  const value = ev.target.value === '' ? null : Number(ev.target.value);
  client.mutate((tx) => tx.set('notes', selectedId, 'estimate', value));
};

// Encrypted rooms: start one, or invite people to the one you are in.
const roomButton = $('room-button');
if (roomKey) {
  $('room-badge').hidden = false;
  roomButton.textContent = 'Copy invite link';
  roomButton.onclick = async () => {
    await navigator.clipboard?.writeText(location.href).catch(() => {});
    roomButton.textContent = 'Link copied';
    setTimeout(() => { roomButton.textContent = 'Copy invite link'; }, 1500);
  };
} else if (canEncrypt) {
  roomButton.onclick = newEncryptedRoom;
} else {
  roomButton.hidden = true;
}

$('offline-toggle').onclick = () => {
  simulatedOffline = !simulatedOffline;
  renderStatus();
  // Coming back: skip the backoff wait rather than making the user watch it.
  if (!simulatedOffline) client.resume();
};

/* -------------------------------------------------------------------- wiring */

client.on('change', renderAll);
client.on('batch', renderAll);
client.on('status', renderStatus);
client.on('sync', renderStats);

// The browser's own online/offline events are a hint worth acting on: they
// turn a reconnection from "wait out the backoff" into something immediate.
addEventListener('online', () => client.resume());
addEventListener('offline', renderStatus);

// A periodic tick keeps the byte and pending counters honest even when nothing
// local changes -- they move because of what the engine does in the background.
setInterval(renderStats, 1000);

renderAll();
await client.sync().catch(() => {});
renderAll();

// Handy when poking at it from the console.
Object.assign(globalThis, { client, demoSchema });
console.info('[rivulet] replica', client.node, '— `client` is available in the console');
