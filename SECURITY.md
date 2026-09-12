# Security

## What this does protect against

- **Forged history.** The server rejects operations attributed to a replica
  other than the sender. Without that check a client could fabricate another
  replica's operations, and — worse — occupy its sequence numbers so the real
  ones could never be accepted.
- **Malformed input.** Every inbound operation is validated at the edge before
  it reaches storage. A malformed operation written to the log would be
  replayed by every replica forever.
- **Resource exhaustion from one client.** Request bodies are bounded, pushes
  are capped, and pulls are paginated.
- **Path traversal.** Static file serving resolves the path first and confirms
  the result is inside the mount root, so `..`, percent-encoded separators and
  nested escapes all fail the same way.

## What this does *not* protect against

Stated plainly, because deploying this without knowing them would be a mistake:

- **The server reads everything.** Operations are plaintext. There is no
  end-to-end encryption.
- **Authorisation is one bearer token per deployment.** There is no per-user
  identity and no per-document access control. Anyone with the token can read
  and write every room they can name.
- **Room names are not secrets.** Knowing a room name and the token is
  sufficient access.
- **A malicious replica can write nonsense into shared documents.** CRDTs
  guarantee convergence, not good behaviour — every replica will converge on
  the nonsense. There is no moderation, revert or audit mechanism.
- **Clock manipulation affects last-writer-wins.** A replica reporting a
  timestamp inside the drift bound can win conflicts it should lose. The bound
  limits how far, not whether.
- **No rate limiting.** A client can sync as often as it likes.

These are appropriate for a trusted group sharing a deployment. They are not
appropriate for a multi-tenant service with untrusted users, and closing them
would mean per-user auth, per-room authorisation, and rate limiting at minimum.

## Reporting

Open an issue for anything that is not itself sensitive. For something that is,
say so in the issue without the details and a private channel can be arranged.
