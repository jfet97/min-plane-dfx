# Pure Irregular Core Stage 1

## Decision

Retain the first pure-core extraction. It changes no placement, scoring,
archive, checkpoint, or terminal behavior. Its value is architectural: the
complete cached pairwise NFP operation can now run without an Effect runtime or
Schema-backed domain objects, which creates a concrete portable kernel seam.

## Implemented boundary

Source commit: `06c7280240a142b7fbbf302e4f1b7efa013e7310`.

The Effect-free import closure owns:

- structural point, polygon, and transform inputs;
- robust-predicate convex validation and structural hull construction;
- exact existing pairwise NFP cache-key serialization;
- cached-boundary validation and stale removal;
- reference and linear Minkowski boundary construction;
- fixed-piece translation and canonicalization;
- explicit success/failure outcomes.

`NfpIfpService` preserves the existing domain and typed-failure surface. Its
public compute operation defers the core with `Effect.suspend`, so constructing
or composing the Effect performs no validation, keying, cache, telemetry, or
geometry work. Candidate generation calls the core synchronously between its
unchanged pre-NFP and post-NFP checkpoints.

`GeometryCacheLive` creates one synchronous backing store. Both the pure route
and existing Effect methods delegate to it; telemetry remains in the store
implementation rather than entering the core.

## Failure and ordering evidence

Focused tests freeze the previous semantics:

- invalid polygons fail before cache access;
- cache miss, valid hit, and stale hit use the same get/remove/set order;
- construction overflow stores nothing;
- translation overflow after successful construction retains the relative
  boundary;
- public failures preserve `IrregularGeometryInputError`, operation
  `computeNfp`, and the exact diagnostic;
- a failing pre-NFP checkpoint prevents core execution;
- a core failure prevents the post-NFP checkpoint;
- success orders pre-checkpoint, cache/core work, then post-checkpoint;
- sync and Effect cache views share one instance and one telemetry ledger;
- the core-directory relative-import closure contains no Effect, Schema, or
  shared-domain dependency.

## Production evidence

`pnpm test` passed `858` tests with `17` intentional skips. Lint and both node
and renderer typechecks passed.

The strict sequential matrix command was:

```text
pnpm gate:compact-nine-baselines \
  --output-dir /private/tmp/min-plane-provenance/pure-irregular-core-06c7280
```

All nine fixtures and all 18 Compact/Short Side layouts passed. Every pinned
collision identity, fitted canonical hash, placed/unplaced partition,
scheduler chronology, focused reconstruction contract, and Short Side
directional contract remained exact. The manifest records one concurrent
algorithm process and strictly sequential execution.

The immutable raw run remains under
`/private/tmp/min-plane-provenance/pure-irregular-core-06c7280/`. Its portable
copy, including all JSON reports, SVGs, PNGs, manifest, and checksums, is
[`../artifacts/pure-irregular-core-stage1/`](../artifacts/pure-irregular-core-stage1/).

No speedup is claimed: this was not a paired performance experiment.

## Next bounded slice

Move IFP bounds and transformed-geometry cache resolution behind the same pure
store. Do not start candidate-state-machine extraction until that lower
geometry/cache boundary preserves the same failure, telemetry, and production
gates.
