# Pure Irregular Core Stage 2

## Decision

Retain the pure IFP and transformed-collision cache extraction. The two
operations now execute over structural data and one synchronous cache store
without composing Effect inside cache resolution. Public services remain lazy
Effect adapters with the same typed failures.

Source commit: `82c679dd448ef396ef89f0dbc5f1a6c6c5eb4955`.

## Preserved asymmetric cache contracts

The extraction deliberately preserves two different historical orders:

- IFP validates the moving polygon before key construction or cache access;
- transformed geometry constructs its key and performs `get` first, then
  validates only after a miss or stale removal.

For both paths, a stale value is removed before recomputation, a failed
computation is never stored, and successful structural values enter the cache
before boundary adaptation. Direct tests freeze exact key bytes, ordered cache
actions, error `_tag`/operation/message, infeasible versus invalid IFP outcomes,
mirror/rotation/grid-snap behavior, lazy construction, and plain cached-value
prototypes.

Candidate generation invokes the pure IFP operation only inside its already
running generator between the unchanged IFP checkpoints. Sheetless generation
continues to skip IFP work.

## Evidence

The complete suite passed `870` tests with `17` intentional skips. Lint and
node/renderer typechecks passed.

The strict single-process matrix passed all nine fixture/sheet cases and all 18
Compact/Short Side layouts. Every pinned collision identity, fitted canonical
hash, placed/unplaced partition, scheduler chronology, focused reconstruction
contract, and Short Side directional contract remained exact.

Raw provenance:
`/private/tmp/min-plane-provenance/pure-irregular-core-stage2-82c679d/`.

Portable evidence:
[`../artifacts/pure-irregular-core-stage2/`](../artifacts/pure-irregular-core-stage2/).

No speedup is claimed; this is an architectural parity stage.

## Next stage

Introduce a genuinely plain trusted object graph for collision geometry,
transformed geometry, transform candidates, and prepared pieces. Decode
schema-backed payloads once at the worker/request boundary and keep schemas in
named IPC, replay, persistence, and export adapters only. Prove the boundary
with TypeScript symbol/import closure plus representative runtime prototype
assertions, then repeat the complete independent production gate.
