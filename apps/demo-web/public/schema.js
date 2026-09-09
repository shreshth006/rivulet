/**
 * @file The demo's schema, shared by the browser app and the server.
 *
 * It lives under `public/` so the browser can fetch it at `/schema.js` and the
 * server can import it directly -- one definition, no duplication, and no
 * chance of the two drifting apart into a schema-mismatch error.
 *
 * Each field is a different merge strategy, chosen to be arguable rather than
 * obvious -- the point of the demo is that the choice is visible and has
 * consequences you can watch happen.
 */

import { defineSchema } from '#core/schema';

export const demoSchema = defineSchema({
  notes: {
    // A rename is atomic and the newest one is what the author meant.
    title: 'lww',
    // Two people typing in different paragraphs must both keep their work.
    body: 'text',
    // Offline tagging is common, and losing a tag to someone else's stale
    // delete is the kind of bug users never forgive.
    tags: 'set',
    // Concurrent votes must add up, not overwrite.
    votes: 'counter',
    // A silently discarded estimate is worse than asking, so keep both.
    estimate: 'mv',
    pinned: 'boolean',
  },
});

export const DEMO_ROOM = 'notebook';
