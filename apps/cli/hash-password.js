#!/usr/bin/env node
/**
 * @file Hash a password for RIVULET_ADMIN_PASSWORD_HASH or
 * RIVULET_DEMO_PASSWORD_HASH, so a deployment's configuration holds a hash
 * instead of the plaintext.
 *
 *   node apps/cli/hash-password.js            then type the password and press enter
 *   printf %s "$PASSWORD" | node apps/cli/hash-password.js
 *
 * The password is read from standard input, never from the command line,
 * where it would show up in `ps` and in the shell's history.
 */

import { hashPassword } from '#server/accounts';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
if (password.length < 8) {
  console.error('a password is at least 8 characters');
  process.exit(1);
}
console.log(await hashPassword(password));
