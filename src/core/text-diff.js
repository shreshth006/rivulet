/**
 * @file Turn "the textarea now says X" into minimal sequence operations.
 *
 * UI frameworks hand you the whole new string, but sending a whole-string
 * replacement would delete and re-insert every character -- destroying
 * concurrent edits elsewhere in the document and burning bandwidth in exactly
 * the environment this engine targets.
 *
 * So we recover the edit: trim the common prefix and suffix, and treat the
 * middle as one delete plus one insert. For real typing that middle is a
 * character or two. It is not a minimal edit script for arbitrary rewrites
 * (a Myers diff would be), but a single contiguous change is what a caret
 * actually produces, and it costs one linear scan instead of O(n*d).
 */

/**
 * @param {string} before @param {string} after
 * @returns {{ index: number, removed: number, inserted: string }|null} null when unchanged
 */
export function diffText(before, after) {
  if (before === after) return null;

  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before[prefix] === after[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < max - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix++;

  return {
    index: prefix,
    removed: before.length - prefix - suffix,
    inserted: after.slice(prefix, after.length - suffix),
  };
}

/**
 * Resolve a text change into the identities a sequence edit needs.
 *
 * Deliberately stops short of building operations: each inserted character
 * must be anchored on the previous one, and that anchor is the previous
 * operation's HLC timestamp, which does not exist until the transaction stamps
 * it. So this returns the anchor for the *first* character and lets the
 * transaction chain the rest.
 *
 * The anchor is the last character before the edit that is **not** being
 * deleted. Anchoring on a character we are about to remove would leave the
 * insert hanging off a tombstone, which still converges but drifts away from
 * where the user's caret was when a concurrent edit lands nearby.
 *
 * @param {import('#core/crdt/rga').RGA} rga current state
 * @param {string} after desired text
 * @returns {{ deleteIds: string[], insertAfter: string|undefined, insert: string }|null}
 */
export function textEdit(rga, after) {
  const change = diffText(rga.text, after);
  if (!change) return null;

  const ids = rga.ids();
  return {
    deleteIds: ids.slice(change.index, change.index + change.removed),
    insertAfter: change.index > 0 ? ids[change.index - 1] : undefined,
    insert: change.inserted,
  };
}
