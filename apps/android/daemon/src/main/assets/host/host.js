/**
 * @file The engine side of the Rivulet Sync daemon.
 *
 * Kotlin drives this page through two channels:
 *
 *   Kotlin -> JS   `rivulet.handle(id, method, argsJson)` via evaluateJavascript
 *   JS -> Kotlin   `RivuletNative.reply(id, json)` with `{ ok, result | error }`
 *                  `RivuletNative.changed(room, collectionsJson)` after changes
 *                  `RivuletNative.status(room, status)` on sync status changes
 *
 * One RivuletClient per room. A room is opened with the schema its owning app
 * registered, so the daemon can host any app's data without knowing its shape.
 */

import { RivuletClient } from '#client/client';
import { HttpTransport } from '#client/transport';
import { defaultAdapter } from '#storage/index';
import { defineSchema } from '#core/schema';

const native = globalThis.RivuletNative;

/** room -> { client, config } */
const rooms = new Map();
/**
 * room -> promise of an open in progress. Two callers can ask for the same
 * room at once (an app registering it while the daemon reopens every room on
 * start); without this both would build a client over the same local store.
 */
const opening = new Map();

function need(room) {
  const entry = rooms.get(room);
  if (!entry) throw Object.assign(new Error(`room is not open: ${room}`), { code: 'E_NO_ROOM' });
  return entry.client;
}

/**
 * Change notifications are coalesced per tick: a transaction or a pulled batch
 * touches many documents, and the other app wants one "re-query" per burst,
 * not one per character.
 */
const pending = new Map();
function changed(room, collection) {
  if (!pending.has(room)) {
    pending.set(room, new Set());
    queueMicrotask(() => {
      const collections = [...pending.get(room)];
      pending.delete(room);
      native?.changed(room, JSON.stringify(collections));
    });
  }
  pending.get(room).add(collection);
}

/** Every write an app can make, as plain JSON. */
function applyAction(tx, a) {
  switch (a.op) {
    case 'create': return tx.create(a.collection, a.values ?? {}, ...(a.id ? [a.id] : []));
    case 'update': return tx.update(a.collection, a.id, a.values ?? {});
    case 'set': return tx.set(a.collection, a.id, a.field, a.value);
    case 'setText': return tx.setText(a.collection, a.id, a.field, a.text ?? '');
    case 'add': return tx.add(a.collection, a.id, a.field, a.element);
    case 'remove': return tx.remove(a.collection, a.id, a.field, a.element);
    case 'increment': return tx.increment(a.collection, a.id, a.field, a.delta ?? 1);
    case 'delete': return tx.delete(a.collection, a.id);
    case 'restore': return tx.restore(a.collection, a.id);
    default: throw Object.assign(new Error(`unknown action: ${a.op}`), { code: 'E_VALIDATION' });
  }
}

function reuse({ room, schema }) {
  const existing = rooms.get(room);
  if (JSON.stringify(existing.config.schema) !== JSON.stringify(schema)) {
    throw Object.assign(new Error('room is already open with a different schema'), { code: 'E_VALIDATION' });
  }
  return { node: existing.client.node, status: existing.client.status, reopened: true };
}

async function openRoom({ room, schema, url, token, key }) {
  const client = await RivuletClient.open({
    schema: defineSchema(schema),
    room,
    storage: await defaultAdapter({ name: `rivulet-sync:${room}` }),
    transport: url ? (node) => {
      const transport = new HttpTransport({ url, room, node, token: token || undefined });
      transport.on('stream-closed', (e) => console.log(`[${room}] stream ended: ${e?.reason}`));
      return transport;
    } : undefined,
    ...(key ? { encryption: { key } } : {}),
    // The service, not a timer in a backgrounded WebView, decides when to
    // sync: Android throttles hidden pages' timers unpredictably.
    sync: { pollMs: 60_000, debounceMs: 300 },
  });
  client.db.on('change', (e) => changed(room, e.collection));
  client.db.on('batch', () => {
    for (const name of client.schema.names) changed(room, name);
  });
  client.on('status', () => native?.status(room, client.status));
  // Visible in `adb logcat -s RivuletEngine`: the stream and sync rounds are
  // what to look at when live updates seem slow.
  client.engine?.on('stream-closed', () => console.log(`[${room}] stream closed; will reopen`));
  client.engine?.on('sync', (e) => console.log(`[${room}] sync pushed=${e.pushed} pulled=${e.pulled}`));
  rooms.set(room, { client, config: { schema, url, token, key } });
  // Opening already connected and synced, before the listeners above existed:
  // report where the room stands now, so status screens are not left stale.
  native?.status(room, client.status);
  for (const name of client.schema.names) changed(room, name);
  return { node: client.node, status: client.status, reopened: false };
}

const methods = {
  async open(args) {
    // Wait out any open in progress, then reuse what it built. A loop, so
    // that if it failed, only one waiter -- not all of them -- tries again:
    // nothing awaits between the check below and claiming the slot.
    while (opening.has(args.room)) await opening.get(args.room).catch(() => {});
    if (rooms.has(args.room)) return reuse(args);
    const pending = openRoom(args);
    opening.set(args.room, pending);
    try { return await pending; } finally { opening.delete(args.room); }
  },

  async close({ room }) {
    await opening.get(room)?.catch(() => {});
    const entry = rooms.get(room);
    if (entry) { await entry.client.close(); rooms.delete(room); }
    return { closed: Boolean(entry) };
  },

  async mutate({ room, actions }) {
    const client = need(room);
    if (!Array.isArray(actions) || actions.length === 0) {
      throw Object.assign(new Error('actions must be a non-empty array'), { code: 'E_VALIDATION' });
    }
    // One transaction: the whole batch lands, or none of it does.
    return client.mutate((tx) => actions.map((a) => applyAction(tx, a)) ?? null);
  },

  async get({ room, collection, id }) { return need(room).get(collection, id); },

  async list({ room, collection, where, sort, limit, offset, select }) {
    return need(room).list(collection, { where, sort, limit, offset, select });
  },

  async conflicts({ room, collection }) { return need(room).conflicts(collection); },

  async sync({ room }) {
    const targets = room ? [[room, need(room)]] : [...rooms.entries()].map(([r, e]) => [r, e.client]);
    const out = {};
    for (const [name, client] of targets) {
      const r = await client.sync();
      out[name] = { pushed: r.pushed, pulled: r.pulled, error: r.error?.message ?? null, status: client.status };
    }
    return out;
  },

  async status() {
    const out = {};
    for (const [name, { client, config }] of rooms) {
      out[name] = {
        status: client.status,
        node: client.node,
        pending: await client.pendingCount(),
        encrypted: Boolean(config.key),
        server: config.url ?? null,
      };
    }
    return out;
  },
};

globalThis.rivulet = {
  async handle(id, method, argsJson) {
    try {
      const fn = methods[method];
      if (!fn) throw Object.assign(new Error(`unknown method: ${method}`), { code: 'E_VALIDATION' });
      const result = await fn(JSON.parse(argsJson || '{}'));
      native?.reply(id, JSON.stringify({ ok: true, result: result ?? null }));
    } catch (err) {
      native?.reply(id, JSON.stringify({
        ok: false, error: { code: err?.code ?? 'E_INTERNAL', message: String(err?.message ?? err) },
      }));
    }
  },
};

native?.ready();
