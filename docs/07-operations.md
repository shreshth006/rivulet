# Running it

## Deployment shape

One process, one directory of SQLite files, one port. There is no cluster mode
and no external state — rooms are independent, so the only horizontal scaling
story is partitioning rooms across processes by name.

```bash
node --experimental-sqlite apps/cli/serve.js \
  --port 8787 --data /var/lib/rivulet --token "$SYNC_TOKEN"
```

Put a TLS terminator in front of it. The server speaks plain HTTP and has no
opinion about certificates.

## What to watch

`GET /v1/stats` reports, per room: operation count, replica count, live
connections, stored bytes and last activity.

The numbers that actually indicate trouble:

- **Operations growing while document count does not.** Editing churn. Expected,
  but it is what compaction exists for.
- **Replica count climbing without bound.** Every replica that ever synced has
  an entry in the version vector forever. Clients that mint a fresh identity on
  each launch — a storage bug, or private browsing — show up here, and each one
  permanently enlarges every sync request in that room.
- **`stored bytes` far exceeding the materialised state.** Tombstones. See below.

## Compaction

The log grows with every edit ever made. A snapshot grows only with surviving
state, and a new device should download the second.

Compaction is only safe up to a frontier **every** replica has, including one
that has been offline for a week. The server does not track that automatically;
deciding it is a deployment policy question — usually "every replica seen in the
last N days", accepting that a replica offline longer than N must resync from
scratch.

Even before tombstones are collected, a snapshot is roughly a fifth the size of
the encoded log, because it interns identifiers the same way the codec does.
Collection then takes it below 1% of the log.

## Storage sizing

Roughly 80 bytes per operation on disk. One character typed is one operation.
A note rewritten many times accumulates tombstones at up to several hundred
times its live size in the worst case; collection recovers 97–99.9%.

For a working estimate: a team of 20 writing a few thousand words a day each
produces on the order of tens of megabytes a year before collection.

## Backup

Stop writes or use `sqlite3 .backup`; a straight file copy of a WAL database
mid-write is not a consistent snapshot.

Losing the server is survivable in a way losing a normal database is not: every
client holds its own operations, so the union reassembles as clients resync. It
costs availability and any operation that reached *only* the server, which is
nothing, since operations always originate on a client.

## Upgrading the schema

The schema fingerprint is exchanged on connect, and a mismatch is refused with a
clear error. That is deliberate: the alternative is operations for a field the
other side does not know about, which silently do nothing.

Consequently, adding a field is not a rolling upgrade. Either:

- deploy the server with `--open-schema` so it accepts any client, upgrade the
  clients, then pin the new fingerprint; or
- accept a window in which old clients cannot sync.

Removing or retyping a field is worse: operations for it are ignored, so the
data stops converging. Treat a field's type as permanent once it has shipped.

## Rooms

One SQLite file per room, named after it. A room can be backed up, moved or
deleted independently. Room names are not secrets — anyone with the bearer token
can access any room they can name.

## Things that will bite

- **`--memory` is not durable.** It is for demos and tests.
- **No rate limiting.** A misbehaving client can sync in a tight loop.
- **SSE connections hold a socket each.** A room with many live viewers needs
  the file-descriptor limit raised.
- **`synchronous = NORMAL`** means an OS crash can lose recently committed
  operations. They are resent by the replicas that produced them, but a client
  that was itself wiped between sync and crash loses them.
