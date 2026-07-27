# Pure Irregular Core

## Goal

Make deterministic irregular geometry and search internals plain TypeScript:
no Effect programs, Effect services, Schema classes, wall-clock reads, worker
APIs, or persistence DTOs inside the core. Effect remains the application
shell for boundary decoding, dependency construction, cooperative scheduling,
cancellation, tracing, and conversion of explicit core outcomes into typed
failures.

This is an architectural portability contract. A slice may be retained even
when its isolated runtime improvement is below five percent, provided exact
behavior is unchanged and the boundary becomes materially easier to port.

## Non-negotiable behavior

- One nesting job remains one sequential algorithm-worker execution.
- Compact complete and capacity cohorts retain their current protected,
  deterministic, resumable scheduling and separate archive semantics.
- Clipper2 and robust predicates remain geometry authority.
- Canonical layout identities, survivor ordering, evaluation ledgers,
  checkpoints, traces, and all 18 maintained Compact/Short Side layouts remain
  exact.
- Deadline and cancellation observations remain lazy. A pure call may execute
  only from inside the surrounding Effect program, never while constructing it.
- Schema decoding remains authoritative at IPC, worker-message, loaded JSON,
  replay, checkpoint, persistence, and exported-result boundaries.

## Target boundary

```text
Effect worker shell
  - decodes boundary data
  - owns services and process lifecycle
  - observes deadline/cancellation between deterministic quanta
  - emits/persists trace and converts core outcomes to typed errors
              |
              v
pure irregular core
  - plain readonly data and explicit discriminated outcomes
  - deterministic geometry/cache/search transitions
  - counted work budgets and resumable continuation state
  - trace events as plain data
```

Core modules must not import `effect`, `Schema`, or schema-backed shared domain
classes. Boundary adapters may structurally copy decoded values into core
records and construct exported domain values exactly once on return.
This restriction covers the complete import closure of the core directory, not
only direct imports in one entry module.

## First implementation slice

Extract the cached pairwise NFP boundary path as the first complete seam:

1. Introduce an Effect- and shared-domain-free synchronous geometry cache-store
   interface. `GeometryCacheLive` creates exactly one backing store and exposes
   both the store and its existing Effect methods; both routes delegate to that
   same store. Existing key serialization remains exactly
   `JSON.stringify([namespace, parts])`. Cache telemetry stays in the store
   implementation/decorator, outside the geometry core.
2. Move NFP input validation, NFP-specific key construction, cached-boundary
   validation, relative boundary construction, cache
   validation/removal/store, fixed-piece translation, and canonicalization into
   an Effect-free module over structural point/polygon/transform inputs.
   Structural convex-hull output and predicate inputs are included in this
   dependency closure; the core must not call the current schema-constructing
   `ConvexHull.compute` or import shared-domain types through
   `GeometryPredicates` or `geometryCacheKeys`.
3. Return an explicit success/failure union from the core. The current
   `NfpIfpService` adapter preserves `IrregularGeometryInputError`,
   `IrregularNfp`, and placement-candidate contracts.
4. Invoke the pure operation through `Effect.suspend` at the public-service
   adapter. Merely constructing or composing that Effect must perform no
   validation, key construction, cache access, cache telemetry, or geometry
   work. Candidate generation invokes the same pure operation only from inside
   its already-running generator, between the existing pre-NFP and post-NFP
   checkpoints. Do not adopt the rejected eager checkpoint fast path from PR
   #17.
5. Before replacing the implementation, freeze old-path expectations for
   output, serialized key, typed failure, ordered cache actions, telemetry, and
   checkpoint order. Differential tests cover cache miss, valid hit, stale hit
   removal, construction failure, translation failure, and reference/linear
   algorithm parity through both the public service and candidate-generation
   path. They assert:
   - validation failures perform no cache action;
   - a construction failure stores nothing;
   - translation failure after successful construction retains the cached
     relative boundary;
   - every failure preserves `_tag`, `operation`, and message;
   - a failing pre-NFP checkpoint prevents core execution, a core failure
     prevents the post-NFP checkpoint, and success preserves pre/core/post
     order;
   - telemetry-enabled and telemetry-disabled miss/hit/stale/clear sequences
     retain one cache instance and coherent sync/Effect views.
6. Add an import-closure test that rejects `effect`, `Schema`, and shared-domain
   dependencies anywhere reachable from the new core directory.

The slice is complete only when the public service no longer composes Effects
inside pairwise NFP cache resolution and the pure module can be called directly
without an Effect runtime.

## Completed second slice

IFP bounds and transformed-collision cache resolution now use the same pure
store boundary as NFP. Their distinct cache orders, exact keys, explicit
invalid/infeasible outcomes, lazy public adapters, and candidate-generation
checkpoint placement are frozen by an independent current-main oracle and the
strict sequential 18-layout gate.

## Completed third slice

Trusted geometry and search carriers are now ordinary TypeScript classes with
separately named boundary schemas. An AST gate rejects schema imports in the
trusted worker closure and proves the converted runtime classes do not extend
`Schema.Class`. The complete suite and exact 18-layout gate passed.

## Later slices

1. Convert candidate generation into a resumable pure state machine. The shell
   checks control and yields between deterministic counted quanta rather than
   injecting Effect checkpoints into inner loops.
2. Move beam transitions, comparators, deduplication, complete/capacity
   scheduler transitions, and archive updates behind explicit pure step
   functions.
3. Make trace production plain deterministic events, with Effect responsible
   only for streaming and persistence.

Each slice requires exact differential tests and the maintained production
gates before the next boundary moves.
