/**
 * @file The public API.
 *
 * Everything an application needs, and nothing it does not. The internals are
 * reachable through the `#core/*`-style specifiers, but anything imported from
 * here is what the tests, the demo and the documentation treat as the
 * supported surface.
 */

// Defining data and writing to it.
export { defineSchema, Schema, CollectionSchema, DELETED_FIELD } from '#core/schema';
export { RivuletClient, Status } from '#client/client';
export { Database, Transaction } from '#core/database';

// Transports. `LoopbackTransport` is for tests and in-process servers.
export { HttpTransport, LoopbackTransport } from '#client/transport';

// Storage. `defaultAdapter` picks the right backend for the environment.
export { defaultAdapter, MemoryAdapter, IndexedDbAdapter, OpLog } from '#storage/index';

// Running a server.
export { SyncServer } from '#server/engine';
export { HttpSyncServer, startServer } from '#server/http';

// Errors, for branching on `code` rather than on message text.
export {
  RivuletError, ValidationError, ClockDriftError, ProtocolError,
  StorageError, TransportError, AuthError,
} from '#core/errors';

// Occasionally useful directly: building a replica id, or comparing timestamps.
export { newNodeId, isNodeId } from '#core/ids';
export { compareTimestamps, timestampWallMs } from '#core/hlc';
export { VersionVector } from '#core/version-vector';
