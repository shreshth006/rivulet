# Fuzzing and Correctness Guarantees

CRDT synchronization systems must guarantee strong eventual consistency: all replicas that have observed the same set of operations must converge to the exact same state, regardless of arrival order, network partitions, message duplication, or transport drops.

Rivulet tests these guarantees continuously through property-based fuzz testing and chaotic simulated network environments.

## CRDT Mathematical Laws

Every CRDT type in Rivulet (`LWWRegister`, `MVRegister`, `PNCounter`, `ORSet`, `RGA`) satisfies mathematical lattice properties tested in `test/crdt-laws.test.js`:

1. **Commutativity:** $A \star B = B \star A$
   Replicas applying operations in different orders arrive at the identical state.

2. **Associativity:** $(A \star B) \star C = A \star (B \star C)$
   Batch grouping does not affect the final converged document.

3. **Idempotence:** $A \star A = A$
   Duplicate delivery is safe (enforced at the OpLog layer for non-idempotent counters via deduplication and the contiguous frontier).

---

## Chaotic Network Simulation

`test/fuzz.test.js` exercises multi-replica clusters under extreme simulated network conditions:

### 1. Multi-Replica Partitions and Churn
Simulates 5 concurrent replicas performing hundreds of random mutations across notes, text fields, counters, and tags. The network randomly:
- Delivers operations out of order
- Drops or duplicates messages
- Partitions replicas into isolated islands
- Reconnects and reconciles all partitions

Once all operations are delivered, every replica's state is verified byte-for-byte against all other replicas.

### 2. Out-of-Order Operation Arrival
Tests operations delivered in reverse, interleaved, or permuted orders to verify that causal sequence tracking, HLC timestamp ordering, and RGA tree relinking resolve deterministically.

### 3. Byte Payload Corruption Fuzzing
Fuzzes the compact binary framing and wire codecs with:
- Random bit flips and truncated buffers
- Corrupted DEFLATE frames
- Malformed header fields and out-of-range back-references

The engine verifies that all corruptions fail safely with typed `ProtocolError` exceptions rather than unhandled crashes, memory leaks, or corrupted local storage.

---

## Running Fuzz Tests

To execute the fuzz test suite:

```bash
npm run test:fuzz
```
