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
 *
 * On a server started with `--accounts` the page belongs to a signed-in user:
 * it opens one of their notebooks (`?nb=<id>`), syncs with the session's sync
 * token, and offers notebook switching and sharing. Without accounts it is the
 * original single-room demo.
 */

import { RivuletClient, Status } from '#client/client';
import { HttpTransport } from '#client/transport';
import { defaultAdapter } from '#storage/index';
import { generateRoomKey } from '#protocol/seal';
import { demoSchema, DEMO_ROOM } from '/schema.js';
import { api, currentSession, signOut, h } from '/api.js';

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

/* ----------------------------------------------------------------- accounts */

/** `null` on a server without accounts; otherwise `{ user, syncToken }`. */
const session = await currentSession();
let notebooks = [];
let notebook = null;

if (session) {
  notebooks = (await api('GET', '/api/notebooks')).notebooks;
  if (!notebooks.length) notebooks = [(await api('POST', '/api/notebooks', { title: 'My notebook' })).notebook];
  const wanted = Number(new URLSearchParams(location.search).get('nb'));
  notebook = notebooks.find((n) => n.id === wanted) ?? null;
  // An admin may open anyone's notebook from the console.
  if (!notebook && wanted && session.user.role === 'admin') {
    const any = (await api('GET', '/api/admin/notebooks')).notebooks.find((n) => n.id === wanted);
    if (any) notebooks.push(notebook = { ...any, role: 'admin' });
  }
  notebook ??= notebooks[0];
}

const canWrite = !notebook || notebook.role !== 'viewer';

/* -------------------------------------------------------- encrypted rooms */

/**
 * An encrypted room lives entirely in the link: `#room=<name>&key=<key>`. The
 * fragment is never sent to the server, so sharing the link shares the key
 * with the people you send it to and with nobody else -- the server stores the
 * room's operations without ever being able to read them.
 *
 * With accounts the link is `/?nb=<id>#key=<key>`, and this browser remembers
 * the key so the notebook opens from the list next time.
 */
const fragment = new URLSearchParams(location.hash.slice(1));
const keyStore = {
  get: (r) => { try { return localStorage.getItem(`rivulet-key-${r}`); } catch { return null; } },
  set: (r, k) => { try { localStorage.setItem(`rivulet-key-${r}`, k); } catch { /* private mode */ } },
  forget: (r) => { try { localStorage.removeItem(`rivulet-key-${r}`); } catch { /* private mode */ } },
};
let roomKey;
let room;
if (notebook) {
  room = notebook.room;
  roomKey = notebook.encrypted ? (fragment.get('key') ?? keyStore.get(room)) : null;
  if (roomKey) keyStore.set(room, roomKey);
} else {
  roomKey = fragment.get('key');
  room = roomKey ? fragment.get('room') : DEMO_ROOM;
}
const canEncrypt = Boolean(globalThis.crypto?.subtle);
const inviteLink = () => `${location.origin}/?nb=${notebook.id}${roomKey ? `#key=${roomKey}` : ''}`;

function newEncryptedRoom() {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
  location.hash = new URLSearchParams({ room: `sealed-${id}`, key: generateRoomKey() }).toString();
  location.reload();
}

/* ------------------------------------------------------------------- client */

if (notebook?.encrypted && !roomKey) {
  document.body.replaceChildren(h('main', { className: 'auth' },
    h('h1', {}, `🔒 ${notebook.title}`),
    h('p', {}, 'This notebook is end-to-end encrypted, and this browser does not have its key. '
      + 'Open it from its invite link: the key is the part after #, which never reaches the server.'),
    h('p', {}, h('a', { href: '/' }, 'Back to your notebooks'))));
  throw new Error('no key for this encrypted notebook');
}

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
  // Per user as well as per room, so two accounts on one browser stay apart.
  storage: await defaultAdapter({ name: session ? `rivulet-u${session.user.id}-${room}` : `rivulet-${room}` }),
  // A factory, because the replica id is restored from storage during open --
  // it does not exist yet at this point in the file.
  transport: (node) => new HttpTransport({
    url: location.origin, room, node, fetch: gatedFetch, token: session?.syncToken,
  }),
  // Polling is the fallback when push cannot get through (a proxy that buffers
  // event streams); every few seconds keeps two windows feeling live even then.
  sync: { pollMs: 4_000, debounceMs: 250 },
  ...(roomKey ? { encryption: { key: roomKey } } : {}),
});

/* --------------------------------------------------------------------- state */

let selectedId = null;

/** Every edit goes through here; a read-only member's page makes none. */
const write = (fn) => (canWrite ? client.mutate(fn) : undefined);

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
    remove.hidden = !canWrite;
    remove.onclick = () => write((tx) => tx.remove('notes', selectedId, 'tags', tag));
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
      pick.onclick = () => write((tx) => tx.set('notes', selectedId, 'estimate', value));
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
        : status === Status.UNAUTHORISED ? (roomKey ? 'cannot decrypt: wrong room key?'
          : session ? 'not authorised: your access may have been removed' : 'not authorised')
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
  const id = write((tx) => tx.create('notes', {
    title: 'Untitled', body: '', tags: [], votes: 0,
  }));
  select(id);
};

$('delete-note').onclick = () => {
  if (!selectedId) return;
  // A soft delete: it is an ordinary write, so it merges with concurrent
  // edits by timestamp and can be undone the same way.
  write((tx) => tx.delete('notes', selectedId));
  selectedId = null;
  renderAll();
};

$('title').oninput = (ev) => {
  if (selectedId) write((tx) => tx.set('notes', selectedId, 'title', ev.target.value));
};

$('body').oninput = (ev) => {
  // The whole string goes in; the engine works out which characters changed
  // and sends only those.
  if (selectedId) write((tx) => tx.setText('notes', selectedId, 'body', ev.target.value));
};

$('tag-input').onkeydown = (ev) => {
  if (ev.key !== 'Enter') return;
  const tag = ev.target.value.trim();
  if (!tag || !selectedId) return;
  write((tx) => tx.add('notes', selectedId, 'tags', tag));
  ev.target.value = '';
};

$('vote-up').onclick = () => selectedId
  && write((tx) => tx.increment('notes', selectedId, 'votes', 1));
$('vote-down').onclick = () => selectedId
  && write((tx) => tx.increment('notes', selectedId, 'votes', -1));

$('estimate').onchange = (ev) => {
  if (!selectedId) return;
  const value = ev.target.value === '' ? null : Number(ev.target.value);
  write((tx) => tx.set('notes', selectedId, 'estimate', value));
};

// Encrypted rooms: start one, or invite people to the one you are in.
const roomButton = $('room-button');
if (session) {
  // With accounts, encryption is a choice made when creating a notebook.
  roomButton.hidden = true;
  $('room-badge').hidden = !roomKey;
} else if (roomKey) {
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

/* ------------------------------------------------------- notebooks & sharing */

function setupAccount() {
  const { user } = session;
  $('account').hidden = false;
  $('explain').hidden = true;
  $('explain-accounts').hidden = false;
  $('who').textContent = user.displayName || user.username;
  $('who').title = `signed in as ${user.username} (${user.role})`;
  $('admin-link').hidden = user.role !== 'admin';
  $('readonly-badge').hidden = canWrite;
  $('sign-out').onclick = () => signOut();
  document.title = `${notebook.title} · Rivulet`;

  if (!canWrite) {
    for (const id of ['new-note', 'delete-note', 'vote-up', 'vote-down']) $(id).hidden = true;
    for (const id of ['title', 'body', 'estimate', 'tag-input']) $(id).readOnly = true;
  }

  const select = $('notebook-select');
  select.replaceChildren(...notebooks.map((n) => h('option', {
    value: String(n.id), selected: n.id === notebook.id,
  }, `${n.encrypted ? '🔒 ' : ''}${n.title}${n.role === 'owner' ? '' : ` · ${n.owner}`}`)));
  select.onchange = () => { location.href = `/?nb=${select.value}`; };

  // New notebook.
  const dialog = $('new-dialog');
  const form = $('new-form');
  $('new-notebook').onclick = () => {
    form.reset();
    form.elements.encrypted.disabled = !canEncrypt;
    $('new-error').hidden = true;
    dialog.showModal();
    form.elements.title.select();
  };
  $('new-cancel').onclick = () => dialog.close();
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const encrypted = form.elements.encrypted.checked;
    try {
      const { notebook: created } = await api('POST', '/api/notebooks', { title: form.elements.title.value, encrypted });
      if (!encrypted) { location.href = `/?nb=${created.id}`; return; }
      const key = generateRoomKey();
      keyStore.set(created.room, key);
      location.href = `/?nb=${created.id}#key=${key}`;
    } catch (err) {
      $('new-error').textContent = err.message;
      $('new-error').hidden = false;
    }
  };

  $('share-button').onclick = openShare;
  $('share-close').onclick = () => $('share-dialog').close();
}

async function openShare() {
  const dialog = $('share-dialog');
  const error = $('share-error');
  error.hidden = true;
  const fail = (err) => { error.textContent = err.message; error.hidden = false; };

  const render = ({ members, role }) => {
    const manage = role === 'owner' || role === 'admin';
    $('share-title').textContent = notebook.title;
    $('rename-form').hidden = !manage;
    $('rename-form').elements.title.value = notebook.title;
    $('member-form').hidden = !manage;
    $('delete-notebook').hidden = !manage;
    $('leave-notebook').hidden = manage || role === null;
    $('share-hint').replaceChildren(notebook.encrypted
      ? h('span', {}, 'End-to-end encrypted: people you share with also need the invite link, which carries the key. ',
        h('button', { type: 'button', className: 'link', onclick: copyInvite }, 'Copy invite link'))
      : h('span', {}, manage
        ? 'Share by username. Editors can write; viewers can only read. Access is checked on every sync.'
        : `Shared with you by ${notebook.owner} as ${role}.`));
    $('members').replaceChildren(...members.map((m) => h('li', {},
      h('span', { className: 'member-name' }, m.displayName ? `${m.displayName} ` : '', h('code', {}, m.username)),
      h('span', { className: `role role-${m.role}` }, m.role),
      manage && m.role !== 'owner'
        ? h('button', {
          type: 'button', className: 'ghost small', title: `Remove ${m.username}`,
          onclick: () => api('DELETE', `/api/notebooks/${notebook.id}/members/${m.id}`).then((r) => render({ ...r, role })).catch(fail),
        }, 'Remove')
        : null)));
  };

  try {
    render(await api('GET', `/api/notebooks/${notebook.id}/members`));
  } catch (err) {
    fail(err);
  }

  $('member-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    try {
      const result = await api('POST', `/api/notebooks/${notebook.id}/members`, {
        username: f.elements.username.value.trim(), role: f.elements.role.value,
      });
      f.elements.username.value = '';
      error.hidden = true;
      render({ ...result, role: notebook.role === 'admin' ? 'admin' : 'owner' });
    } catch (err) { fail(err); }
  };

  $('rename-form').onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const { notebook: renamed } = await api('PATCH', `/api/notebooks/${notebook.id}`, { title: ev.target.elements.title.value });
      notebook.title = renamed.title;
      setupAccount();
      $('share-title').textContent = renamed.title;
    } catch (err) { fail(err); }
  };

  // Destructive actions take a second click rather than a blocking confirm().
  const twoStep = (button, label, action) => {
    button.textContent = label;
    button.onclick = () => {
      if (button.dataset.armed) return action().catch(fail);
      button.dataset.armed = '1';
      button.textContent = 'Click again to confirm';
      setTimeout(() => { delete button.dataset.armed; button.textContent = label; }, 4000);
    };
  };
  twoStep($('delete-notebook'), 'Delete notebook', async () => {
    await api('DELETE', `/api/notebooks/${notebook.id}`);
    keyStore.forget(notebook.room);
    location.href = '/';
  });
  twoStep($('leave-notebook'), 'Leave notebook', async () => {
    await api('DELETE', `/api/notebooks/${notebook.id}/members/${session.user.id}`);
    location.href = '/';
  });

  if (!dialog.open) dialog.showModal();
}

async function copyInvite(ev) {
  await navigator.clipboard?.writeText(inviteLink()).catch(() => {});
  ev.target.textContent = 'Link copied';
  setTimeout(() => { ev.target.textContent = 'Copy invite link'; }, 1500);
}

if (session) setupAccount();

/* -------------------------------------------------------------------- wiring */

client.on('change', renderAll);
client.on('batch', renderAll);
client.on('status', ({ status }) => {
  renderStatus();
  // Refused: find out whether the session ended (back to sign-in) or only
  // this notebook's access did (the status line says so).
  if (session && status === Status.UNAUTHORISED) currentSession().catch(() => {});
});
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
