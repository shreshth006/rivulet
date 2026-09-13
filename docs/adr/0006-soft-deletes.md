# 6. Deletes are ordinary last-writer-wins tombstones

**Status:** accepted

## Context

Deleting a document has to merge with concurrent edits to it. A record could be
removed outright, flagged, or handled by a dedicated delete mechanism.

## Decision

A reserved `__deleted` field, typed last-writer-wins like any other. Deleting
sets it true; restoring sets it false. The document stays in the store.

## Why

Removing the record outright is not available: a replica that has not seen the
delete will re-send its edits, and with nothing to merge them into the record
reappears with partial content. Deletion has to be represented, not enacted.

Making it a normal field means it needs no special case anywhere. It merges by
timestamp exactly like a title change, so "delete versus concurrent edit"
resolves the same way "rename versus rename" does, with the later one winning.
Undelete is just a write.

## Consequences

- Deleted documents occupy space forever unless collected. `list()` filters
  them by default; `includeDeleted` reveals them.
- A delete that loses to a later edit leaves the document visible with the edit
  applied, which is the intended outcome — someone was still working on it.
- An edit that loses to a later delete is not destroyed, only hidden behind the
  tombstone, so a restore brings the content back rather than an empty record.
- Purging for real — a deletion request that must actually erase data — is not
  supported and would need a separate mechanism with its own stability rules.
