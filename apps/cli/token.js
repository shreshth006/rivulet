#!/usr/bin/env node
/**
 * @file Issue a room-scoped access token for a server started with --room-tokens.
 *
 *   RIVULET_SECRET=... node apps/cli/token.js --room notebook --scope read --ttl 86400
 *
 * In production the service that already knows who a user is should call
 * `issueRoomToken` itself; this is for operators and for trying it out.
 */

import { issueRoomToken } from '#server/tokens';

const HELP = `
issue a rivulet room token (secret read from RIVULET_SECRET)

  node apps/cli/token.js --room <name> [options]

Options:
  --room <r>     room name, a prefix ending in '*', or '*' for every room
  --scope <s>    read | write | admin (default write)
  --node <id>    bind the token to one replica id
  --ttl <secs>   lifetime in seconds (default: no expiry)
  -h, --help     this message
`;

const opts = { scope: 'write' };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  switch (argv[i]) {
    case '--room': opts.room = argv[++i]; break;
    case '--scope': opts.scope = argv[++i]; break;
    case '--node': opts.node = argv[++i]; break;
    case '--ttl': opts.ttlSeconds = Number(argv[++i]); break;
    case '-h': case '--help': console.log(HELP); process.exit(0);
    default: throw new Error(`unknown argument: ${argv[i]}`);
  }
}
if (!opts.room) { console.error(HELP); process.exit(1); }
if (!process.env.RIVULET_SECRET) throw new Error('RIVULET_SECRET is not set');

console.log(issueRoomToken(process.env.RIVULET_SECRET, opts));
