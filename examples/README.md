# Examples

Both run with no setup and no dependencies.

## `two-replicas.js`

Two replicas, one server and a switchable link, all in one process. Shows what
actually happens to concurrent edits made while both sides are disconnected:
the text merges character by character, tags union, and counters sum.

```bash
node --experimental-sqlite examples/two-replicas.js
```

This is the shortest thing to read first — it is the whole model in about
eighty lines.

## `node-client.js`

A durable client over real HTTP, keeping its state in a SQLite file.

```bash
node --experimental-sqlite apps/cli/serve.js --port 8787   # terminal 1
node --experimental-sqlite examples/node-client.js --open-schema   # terminal 2
```

Run it twice. The second run demonstrates the restart path: the replica keeps
its identity, resumes sequence numbering, and replays its local log instead of
starting over. Stop the server and run it again to watch writes queue.

## The browser

```bash
node --experimental-sqlite apps/cli/serve.js --demo
```

Then open <http://127.0.0.1:8787> in two windows. Click **Go offline** in one,
edit the same note in both, and come back online.
