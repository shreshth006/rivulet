# API

Everything below is exported from `src/index.js`. Internals are reachable
through `#core/*`-style specifiers but are not the supported surface.

## Opening a client

```js
import { defineSchema, RivuletClient, HttpTransport, defaultAdapter } from './src/index.js';

const schema = defineSchema({
  notes: { title: 'lww', body: 'text', tags: 'set', reads: 'counter' },
});

const client = await RivuletClient.open({
  schema,
  room: 'notebook',
  storage: await defaultAdapter({ name: 'notebook' }),
  transport: (node) => new HttpTransport({ url: 'https://sync.example', room: 'notebook', node }),
});
```

| Option | Meaning |
|---|---|
| `schema` | required |
| `room` | synchronisation domain; rooms are isolated |
| `storage` | adapter; `defaultAdapter()` picks per environment |
| `transport` | omit for a purely local database. **A function** receives the replica id, which only exists after storage is opened |
| `autoStart` | start syncing during `open` (default true) |
| `sync` | `{ pollMs, debounceMs, maxBackoffMs, batching, timers }` |
| `node` | identity to mint on first run; a stored identity always wins |

## Reading

Reads are synchronous and always local.

```js
client.get('notes', id);                  // null when absent or deleted
client.exists('notes', id);               // boolean: present and not deleted
client.find('notes', { pinned: true });   // first matching document, or null
client.list('notes', { where, sort, limit, offset, includeDeleted });
client.count('notes', { where });
client.conflicts('notes');                // multi-value fields needing a choice

const off = client.subscribe('notes', (rows) => render(rows));
```

`where` accepts a predicate function `(value, doc) => boolean` or an object filter
matching primitives or collection membership (e.g. `{ tags: 'urgent', pinned: true }`).

`subscribe` fires once immediately and then on every local or remote change. It
re-reads rather than diffing: coarse, but it removes a whole class of stale-view
bugs at the scale one device's working set lives at.

## Writing

`mutate` applies the change locally and returns synchronously. Durability and
delivery are the engine's problem.

```js
const id = client.mutate((tx) => tx.create('notes', { title: 'Hello' }));

client.mutate((tx) => {
  tx.set('notes', id, 'title', 'Renamed');          // lww / mv
  tx.setText('notes', id, 'body', textarea.value);  // text — send the whole value
  tx.add('notes', id, 'tags', 'urgent');            // set
  tx.remove('notes', id, 'tags', 'draft');          // set
  tx.increment('notes', id, 'reads', 1);            // counter
  tx.splice('notes', id, 'items', 2, 1, ['new']);   // seq
  tx.update('notes', id, { title: 'x', tags: ['a'] });
  tx.delete('notes', id);                            // soft delete
  tx.restore('notes', id);
});
```

`setText` takes the **whole new string** and works out which characters changed,
so binding a `<textarea>` is a one-liner and still costs one operation per
keystroke rather than a full replacement.

Operations are validated against the schema at the call site, so writing a
counter with `set` throws immediately rather than merging strangely later.

## Sync

```js
await client.sync();            // one reconciliation, resolves when done
await client.syncUntilIdle();   // until nothing is outstanding either way
client.resume();                // device is back online; skip the backoff wait
await client.pendingCount();    // operations written but not yet acknowledged
await client.stats();
```

`client.status` is one of `offline`, `connecting`, `syncing`, `live`,
`unauthorised`. Only the last is terminal — everything else resolves itself.

Events: `change`, `batch`, `status`, `sync`, `sync-error`, `storage-error`.

## Running a server

```js
import { startServer } from './src/index.js';

const server = await startServer({
  port: 8787,
  dataDir: './data',        // one SQLite file per room
  schema: schema.fingerprint,  // pin it, so version skew is a clear error
  secret: process.env.RIVULET_SECRET,  // room-scoped tokens; or `token` for one shared token
});
```

Issue a token for each user and room, from whatever already authenticates them,
and hand it to the client's transport:

```js
import { issueRoomToken } from './src/index.js';

const token = issueRoomToken(secret, {
  room: 'notebook',      // or 'team-42/*', or '*'
  scope: 'write',        // 'read' | 'write' | 'admin'
  node: replicaId,       // optional: only this replica may use it
  ttlSeconds: 86_400,    // optional
});
new HttpTransport({ url, room: 'notebook', node: replicaId, token });
```

### End-to-end encryption

```js
import { generateRoomKey, deriveRoomKey } from './src/index.js';

const key = generateRoomKey();   // share it out of band, e.g. in a link's #fragment
const client = await RivuletClient.open({ schema, room, transport, encryption: { key } });

// Or from a passphrase people can type (slow on purpose: 600k PBKDF2 rounds).
const typed = await deriveRoomKey('correct horse battery staple', room);
```

Every replica in the room must use the same key. A replica with a different
key, or one receiving unencrypted operations, stops with status `unauthorised`
rather than applying anything. Local storage stays plaintext; only the wire and
the server see ciphertext. Needs a server at this version or later, which
completes partially pulled runs.

For any other policy, pass `authorize(ctx)` to `startServer` or `SyncServer`.
It sees `{ action, room, node, writes, credential, ip }` and may return false or
throw an `AuthError`.

Endpoints: `POST /v1/sync`, `GET /v1/stream` (SSE), `GET /v1/health`,
`GET /v1/info`, and, with admin access, `GET /v1/room` and `GET /v1/stats`.

Or use the CLI:

```bash
node --experimental-sqlite apps/cli/serve.js --port 8787 --data ./data --token secret
```

## Errors

Branch on `code`, never on message text.

| Code | Class | Meaning |
|---|---|---|
| `E_VALIDATION` | `ValidationError` | Bad arguments or schema violation |
| `E_PROTOCOL` | `ProtocolError` | Malformed or unsupported wire data |
| `E_STORAGE` | `StorageError` | Disk, quota, transaction abort |
| `E_TRANSPORT` | `TransportError` | Network failure; always retryable |
| `E_AUTH` | `AuthError` | Rejected credentials; do not retry |
| `E_CLOCK_DRIFT` | `ClockDriftError` | A remote clock is too far ahead |

`TransportError` carries a `kind` — `timeout`, `lost` or `unreachable` — and
`sizeRelated`, which is what the batch controller uses to tell congestion from
packet loss.
