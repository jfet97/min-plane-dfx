# Characterization: effect-boundary

Stage 0 characterization for the Rust irregular-nesting port (Compact / Compact
Short Side). Cluster scope: the Effect service-wiring layer that sits between
(a) the schema-decoded, untrusted-boundary `NestingRequest` protocol payload
and (b) the plain trusted classes and pure `core/*` geometry math the search
consumes. This is the "trusted-data handoff" seam named in the task brief.

Files read completely for this document (the cluster's primary specification
surface):

- `src/workers/irregular/services.ts` (451 lines)
- `src/workers/irregular/infrastructure.ts` (29 lines)
- `src/workers/irregular/index.ts` (5 lines)
- `src/workers/irregular/internalGeometry.ts` (68 lines)
- `src/workers/irregular/geometryKernel.ts` (265 lines)

Files read in full or in the relevant part to trace every caller/callee claim
and the exact production wiring (not this cluster's primary subject, but
load-bearing for liveness, seam, and cache-sharing claims):

- `src/workers/nesting.worker.ts` (full)
- `src/shared/protocol/worker.ts` (full)
- `src/shared/domain/nesting.ts` (full)
- `src/shared/domain/geometry.ts` (relevant part: `Rect`/`RectWith`/millimeter
  scalar schemas)
- `src/shared/irregular/domain.ts` (relevant classes/schemas — trusted
  carriers, `IrregularNestingSettings`, `IrregularOptimizerSettings`,
  `IrregularGeometrySettings`)
- `src/shared/irregular/defaults.ts` (full)
- `src/workers/algorithm/irregular/computeIrregularNesting.ts` (relevant
  part: the seam call site, `computeIrregularNesting` lines 1-451, 1906-1920)
- `src/workers/algorithm/sortPiecesForNesting.ts` (full — immediately
  downstream of the seam)
- `src/workers/irregular/collisionGeometryBuilder.ts` (relevant part: `.Live`
  layer composition)
- `src/workers/irregular/nfpIfpService.ts` (relevant part: lines 1-94, layer
  composition)
- `src/workers/irregular/transformGenerator.ts` (relevant part: `decodeInput`,
  layer composition)
- `src/workers/irregular/freeMaterialService.ts` (relevant part: layer
  composition)
- `src/workers/algorithm/irregular/irregularPlacementScorer.ts` (relevant
  part: `.Layer`/`.Live` split, lines 160-197)
- `src/workers/algorithm/irregular/irregularLayoutScorer.ts` (relevant part:
  `.Layer`/`.Live` split, lines 119-154)
- `src/workers/irregular/placementValidation.ts` (relevant part: the
  `validate` export wired directly into `GeometryKernel`)
- `src/workers/irregular/core/geometryCacheStore.ts` (full — the cache-key
  serialization this cluster's `cacheKeyToString` wraps)
- `src/workers/irregular/geometryCacheStoreLive.ts` (full)
- `src/workers/irregular/core/transformCollisionGeometryCore.ts` (full — the
  pure hot-path resolver `geometryKernel.ts` calls directly)
- `src/main/services/WorkerSupervisor.ts` (relevant part: the RPC client call
  site that proves bytes actually cross a worker-thread boundary)
- `docs/architecture/schema-models.md` (full)
- `docs/history/prompts/fable5-rust-irregular-nesting-implementation.md` (sections 2,
  7, 8, 9, 13, 14 read in full; skimmed elsewhere)
- Tests: `tests/unit/irregularGeometryKernel.test.ts`,
  `tests/unit/irregularGeometryCache.test.ts`,
  `tests/unit/irregularInfrastructure.test.ts`,
  `tests/unit/irregularWorkerCompute.test.ts`,
  `tests/unit/trustedGeometryCarrierBoundary.test.ts`,
  `tests/unit/pureIrregularCoreBoundary.test.ts` (all read in full)

Sibling documents this one leans on rather than duplicates: `geometry-caches.md`
(owns `core/geometryCacheStore.ts`/`geometryCacheStoreLive.ts`/
`transformCollisionGeometryCore.ts`/`ifpBoundsCore.ts`/`nfpBoundaryCore.ts` in
full depth — I independently re-derived and confirmed its central "one cache
instance per job" claim by running a live differential probe against the
actual production layer graph; see §9), `collision-prep.md` (owns
`collisionGeometryBuilder.ts`, `transformGenerator.ts`, curve flattening,
Clipper2 offset — this document treats those as callees, not primary
subject), `nfp-ifp.md` (owns `nfpIfpService.ts`, NFP/IFP math, candidate
generation), `errors-protocol.md` (owns the full `IrregularComputeErrorType`
liveness/mapping table — this document only covers the subset of error
classes *declared or constructed inside the five target files*).

**A methodology note on the most consequential claim in this document.** The
"does every service share one `GeometryCache` instance per job" question in
§9 cannot be answered by reading source alone — it depends on Effect's Layer
memoization semantics across chained `Effect.provide` calls, which are not
obvious from the call site. Rather than reason about this from memory, I
wrote and ran two throwaway Vitest probes directly against this repo's real
`effect@4.0.0-beta.89` and the actual production layers
(`CollisionGeometryBuilder.Live`, `NfpIfpServiceLive`, `GeometryKernel.Live`,
etc., composed in the exact order `nesting.worker.ts` uses), asserted the
result, then deleted the probe files. The assertions passed. §9 states the
proven result and the reasoning; the probe files are not part of this
repository's history (created under `/tmp` and under `tests/unit/` as a
temporary file, both removed before this document was written).

---

## 1. Purpose and role in Compact / Compact Short Side execution

This cluster is the layer that (a) declares every Effect `Context.Service`
contract the irregular worker uses, (b) owns the one concrete cache service
(`GeometryCache`) all geometry caching passes through, and (c) implements the
`GeometryKernel` service — the five deterministic geometry primitives
(`flattenSourceGeometry`, `convexHull`, `offsetConvexPolygon`,
`transformCollisionGeometry`, `validatePlacement`) every other irregular
service is built on top of. It is the seam between the schema-decoded,
untrusted `NestingRequest` protocol payload and the plain trusted classes
(`CollisionGeometry`, `IrregularPreparedPiece`, `TransformedCollisionGeometry`,
…) that the beam/shared-archive search operates on. Compact and Compact Short
Side are **identical** through this entire cluster: nothing here branches on
`intrinsicObjectiveProfileId`, `placementPolicyId`, or any other
profile-distinguishing setting. Both profiles call the exact same
`computeIrregularNesting` entry point (`computeIrregularNesting.ts:364`) with
the exact same layer graph (`nesting.worker.ts:390-399`); the only thing that
differs between the two profiles is the *value* of `IrregularNestingSettings`
carried inside the request, which this cluster passes through opaquely via
`GeometrySettings` (a `Context.Service<GeometrySettings, IrregularNestingSettings>`,
`geometryKernel.ts:35-40`).

### 1.1 Per-file role and liveness (traced, not assumed)

| File | Role | Liveness |
|---|---|---|
| `services.ts` | Declares 6 `Context.Service` tags (`TransformGenerator`, `NfpIfpService`, `FreeMaterialService`, `PriorityOrderService`, `IrregularNestingPortfolio`, `GeometryCache`), 6 `Data.TaggedError` classes, every operation-scoped input interface/schema used across the irregular worker, the `GeometryCache` implementation, `cacheKeyToString`, and 3 `Unimplemented` stub layers. | **Live.** Every `Context.Service` tag and error class it declares is imported and used by the production wiring in `nesting.worker.ts` (traced below). |
| `geometryKernel.ts` | Implements the `GeometryKernel` Effect service (5 operations) plus the `GeometrySettings` service that holds the resolved `IrregularNestingSettings` for one job. | **Live.** `GeometryKernel.Live` is provided at `nesting.worker.ts:397`; `GeometrySettings` value is provided at `nesting.worker.ts:398` from `request.options.irregularSettings ?? GeometrySettings.Make` (`nesting.worker.ts:375`). |
| `infrastructure.ts` | Exports one convenience layer, `IrregularNestingInfrastructureLive`, bundling every irregular Effect service into one `Layer.mergeAll`. | **Dead on the production path.** `grep -rn "IrregularNestingInfrastructureLive" src tests` (repo-wide) returns exactly two hits: its own declaration (`infrastructure.ts:13`) and one consumer, `tests/unit/irregularInfrastructure.test.ts:4,10`. `nesting.worker.ts` does **not** import it; it hand-composes the same services via 8 separate `Effect.provide(...)` calls instead (`nesting.worker.ts:391-398`), because production needs to inject the *request's own* `IrregularNestingSettings` (see §2), while `infrastructure.ts:29` pins `GeometrySettings.Live` (i.e. the hard-coded defaults) via `Layer.provideMerge(GeometrySettings.Live)`. Using `IrregularNestingInfrastructureLive` in production would silently ignore any request-supplied `irregularSettings`. Not a Rust-port target; port the `nesting.worker.ts` composition, not this one. |
| `index.ts` | Barrel: `export * from` the other four files plus `collisionGeometryBuilder.js` and `placedCollisionSpatialIndex.js`. | **Fully dead — zero importers anywhere in the repository.** `grep -rn "workers/irregular/index\|from '\.\./workers/irregular'\|from '\./workers/irregular'"` across `src` and `tests` returns nothing; a broader search for any bare-directory import that TypeScript's resolver would map onto this file (`from '../irregular'`, `from './irregular'`) also returns nothing. Every consumer imports the concrete file directly (e.g. `from './services.js'`), never the barrel. There is no Rust-port obligation here beyond "this file has no behavior to preserve." |
| `internalGeometry.ts` | Declares 8 plain, `Effect`-free, `@shared/*`-free structural TypeScript interfaces (`InternalPoint`, `InternalBounds`, `InternalPolygon`, `InternalPolygonWithBounds`, `InternalTransformCandidate`, `InternalGeometrySettings`, `InternalSheetSpec`, `InternalCollisionGeometry`, `InternalTransformedCollisionGeometry`, `InternalIfpBounds`). | **Live — this is the vocabulary the pure `core/*` modules are typed against.** 19 files under `src/workers/irregular/` and `src/workers/algorithm/irregular/` import it (full list: `intrinsicComponentInterfaceClosure.ts`, `nfpCacheKey.ts`, `irregularLayoutScorer.ts`, `convexBounds.ts`, `transformCollisionGeometryCore.ts`, `ifpBoundsCore.ts`, `canonicalLayoutGeometry.ts`, `convexPolygonContact.ts`, `transformCollisionGeometry.ts`, `placementValidation.ts`, `convexHullCore.ts`, `convexPolygonValidation.ts`, `convexSatPenetration.ts`, `geometryPredicates.ts`, `geometryCacheIdentity.ts`, `overlapRelaxation.ts`, `overlapRelaxationV1.ts`, `placedCollisionSpatialIndex.ts`, `nfpBoundaryCore.ts`, plus 3 test files). |

### 1.2 Why this cluster exists as a distinct layer (per `docs/architecture/schema-models.md`)

`docs/architecture/schema-models.md:40-69` is the authoritative design note for
this cluster. Its central claim, quoted because it is exactly the
"why" this cluster's split between schema-decoded input and trusted plain
classes exists:

> "Points, bounds, polygons, transforms, placements, collision and flattened
> geometry, prepared pieces, NFP/IFP values, free-material diagnostics,
> priority keys, and cache keys are ordinary classes. … `Schema.Class`
> construction revalidates the entire nested value on every instantiation,
> including nested values that are already validated instances passed by
> reference. Constructing one `IrregularPlacedPiece` around a reused geometry
> cost `37-250 us` depending on ring size … A paired macOS run at committed
> source states cut the Mixed-61 `2000 x 2700` production case from `78.7 s`
> to `48.8 s`."

This cluster is where that split is *enforced*, not just documented: see §3.1
for the two architecture tests that grep-verify it at every commit.

---

## 2. Entry points, callers, callees (traced, not guessed)

### 2.1 Full call chain from IPC to this cluster

```
main process                          worker thread (nesting.worker.ts)
─────────────                         ──────────────────────────────────
WorkerSupervisor.ts:164-167            RpcServer.layer(NestingWorkerRpcs, …)
  client.RunNesting({requestId,          .pipe(Layer.provide(NestingWorkerHandlers), …)
    request})                              (nesting.worker.ts:478-483)
  — RpcClient.make(NestingWorkerRpcs)          │  decodes wire bytes into
    (worker.ts:6-11: JobId, NestingRequest,     │  RunNestingPayload per
     NestingResult, ... imported by             │  Rpc.make('RunNesting',
     protocol/worker.ts)                        │   {payload: RunNestingPayload,
                                                 │    success: WorkerResponse,
                                                 │    stream: true})
                                                 │  (worker.ts:171-182)
                                                 ▼
                                          NestingWorkerRpcs.of({ RunNesting: (payload) => ... })
                                          (nesting.worker.ts:455-474)
                                                 │  payload.request : NestingRequest
                                                 │  (already schema-decoded, trusted)
                                                 ▼
                                          handleRunNesting(send, requestId, payload.request)
                                          (nesting.worker.ts:190-338, called from :466)
                                                 │
                                                 ▼
                                          computeIrregularWorkerResult(payload, ...)
                                          (nesting.worker.ts:340-401, called from :241)
                                                 │
                                                 ▼
                                          computeIrregularNesting(request, options)
                                          (computeIrregularNesting.ts:364-451)
                                                 │  .pipe(
                                                 │    Effect.provide(CollisionGeometryBuilder.Live),   ← THIS CLUSTER (transitively)
                                                 │    Effect.provide(TransformGeneratorLive),
                                                 │    Effect.provide(NfpIfpServiceLive),                ← THIS CLUSTER (GeometryCache)
                                                 │    Effect.provide(FreeMaterialServiceLive),
                                                 │    Effect.provide(IrregularPlacementScorer.Layer),
                                                 │    Effect.provide(IrregularLayoutScorer.Live),
                                                 │    Effect.provide(GeometryKernel.Live),              ← THIS CLUSTER (direct)
                                                 │    Effect.provide(Layer.succeed(GeometrySettings,     ← THIS CLUSTER (direct)
                                                 │                     geometrySettings)),
                                                 │    Effect.mapError(toIrregularWorkerFailure)
                                                 │  )
                                                 │  (nesting.worker.ts:390-399)
```

`WorkerSupervisor.ts:164-167` uses `RpcClient.make(NestingWorkerRpcs)` — a
genuine effect/rpc client/server protocol running over
`RpcClient.layerProtocolWorker`/`NodeWorkerRunner` (Node `worker_threads`),
**not** a same-process function call passing live object references. This
means `RunNestingPayload`'s `Schema.decode` (bound to the RPC method via
`Rpc.make('RunNesting', { payload: RunNestingPayload, ... })`,
`worker.ts:176-182`) runs against genuinely serialized wire data on arrival
at the worker, and everything downstream of `payload.request` in
`handleRunNesting` is a real, schema-validated `NestingRequest` — this is the
outer untrusted→trusted boundary (§2.3).

### 2.2 Callers and callees of each file, by symbol

**`services.ts`** — imported by every other irregular worker file. Notable
consumers of symbols this cluster declares:
- `GeometryKernel`, `GeometrySettings` (tags/services): imported by
  `computeIrregularNesting.ts:19`, `collisionGeometryBuilder.ts:15`,
  `nfpIfpService.ts` (indirectly via `GeometryCache`), test files.
- `TransformGenerator`, `NfpIfpService`, `FreeMaterialService`,
  `PriorityOrderService`, `IrregularNestingPortfolio`: each has exactly one
  production `.Live`/`.Layer` implementation (`transformGenerator.ts`,
  `nfpIfpService.ts`, `freeMaterialService.ts`,
  `../algorithm/irregular/priorityOrderService.ts`,
  `../algorithm/irregular/portfolioSearch.ts` respectively) and is
  re-exported as a bare interface/contract from `services.ts` — this file
  never implements the *behavior* of those five services, only their shape.
- `GeometryCache`, `GeometryCacheLive`/`GeometryCacheInMemory`: implemented
  here in full (§9). Consumed directly by `geometryKernel.ts:13,94` and
  `nfpIfpService.ts:27-28,68`.
- `OffsetConvexPolygonInput`, `GenerateTransformsInput`: consumed by
  `geometryKernel.ts:246-249` (decode) and `transformGenerator.ts:241-249`
  (decode) respectively — the two internal "belt-and-suspenders" schema
  re-validations described in §2.3.
- 6 error classes: consumed by `nesting.worker.ts:403-453`
  (`toIrregularWorkerFailure`, the sole `IrregularComputeErrorType` →
  `AppErrorCode` mapper — full accounting in `errors-protocol.md`) and by
  every file listed in §11.

**`geometryKernel.ts`** — imports `services.ts` (`IrregularGeometryInputError`,
`IrregularNestingNotImplementedError`, `OffsetConvexPolygonInput`,
`GeometryCache`), `internalGeometry.ts` only transitively (via
`core/transformCollisionGeometryCore.ts`'s type parameters, not a direct
import), `arcFlattening.ts`, `ellipseFlattening.ts`, `convexHull.ts`,
`convexPolygonOffset.ts`, `transformCollisionGeometry.ts` (the Effect wrapper
around `computeTransformedCollisionGeometry`), `core/transformCollisionGeometryCore.ts`
directly (`resolveTransformedCollisionGeometry`), `placementValidation.ts`
(`PlacementValidation.validate`, wired through unchanged), and
`@shared/irregular/defaults.ts`/`domain.ts`. Called by: `computeIrregularNesting.ts:385`
(`yield* GeometryKernel`), `collisionGeometryBuilder.ts:57`
(`yield* GeometryKernel`), `nfpIfpService.ts` (does **not** call `GeometryKernel`
directly — it calls `GeometryCache` and the pure `core/*` resolvers on its
own), all of the `geometryKernel.ts`-targeting unit tests in §14.

**`internalGeometry.ts`** — imports nothing (pure type declarations). Its 19
importers are enumerated in §1.1. It is never imported by `services.ts` or
`geometryKernel.ts` themselves (grep-confirmed: neither file's import list
mentions `internalGeometry.js`) — the two files this document's special focus
concerns operate on the real `@shared/irregular/domain.ts` classes directly,
not the `Internal*` structural vocabulary. `internalGeometry.ts` is the
vocabulary of the layer *beneath* this cluster (`core/*.ts`), not this
cluster itself; it is listed as a target file here because the migration
prompt asked for it specifically and because it is the concrete proof that
TypeScript's structural typing lets a real `IrregularPoint`/`CollisionGeometry`
instance satisfy an `InternalPoint`/`InternalCollisionGeometry` interface with
zero conversion code — a JS-specific hazard documented in §12.

**`infrastructure.ts`** — imports `collisionGeometryBuilder.ts`,
`freeMaterialService.ts`, `geometryKernel.ts`, `nfpIfpService.ts`,
`transformGenerator.ts`, `services.ts` (`GeometryCacheInMemory`),
`../algorithm/irregular/portfolioSearch.ts`,
`../algorithm/irregular/priorityOrderService.ts`,
`../algorithm/irregular/irregularPlacementScorer.ts`,
`../algorithm/irregular/irregularLayoutScorer.ts`. Called by nothing in
production (§1.1).

**`index.ts`** — imports (re-exports) `collisionGeometryBuilder.ts`,
`geometryKernel.ts`, `infrastructure.ts`, `services.ts`,
`placedCollisionSpatialIndex.ts`. Called by nothing (§1.1).

### 2.3 The seam, precisely

The task brief asks for the exact seam around `computeIrregularNesting`:
*what is decoded, what is constructed, in what order, and what invariants are
guaranteed on the trusted side.* There are **two distinct, non-equivalent
seams**, and conflating them would mis-scope the Rust N-API boundary:

**Seam A — the real untrusted→trusted boundary (upstream of this cluster).**
Wire bytes cross a `worker_threads` boundary and are decoded exactly once per
job via `RunNestingPayload`'s embedded `NestingRequest` schema
(`worker.ts:171-174`, `worker.ts:143`, `nesting.ts:143-152`), by the effect/rpc
server runtime, before `NestingWorkerRpcs.of({ RunNesting: ... })`
(`nesting.worker.ts:455-474`) is ever invoked. By the time
`handleRunNesting(send, requestId, payload.request)` runs
(`nesting.worker.ts:466`), `payload.request` is a fully-decoded `NestingRequest`
class instance satisfying every field constraint enumerated in §3. This is
the boundary a Rust N-API implementation should mirror per the migration
prompt's §7: *"Validate untrusted application data in TypeScript using the
existing schemas before constructing trusted native input."* Nothing in this
cluster's five files performs Seam A — it happens entirely in
`src/shared/protocol/worker.ts` and the effect/rpc runtime, upstream of
anything this cluster owns.

**Seam B — two narrow, non-boundary-crossing internal re-validations (owned
by this cluster).** Inside `computeIrregularNesting`'s per-prepared-piece loop
(`computeIrregularNesting.ts:389-431`), two operations each run their own
`Schema.decodeUnknownExit` against an operation-scoped input struct declared
in `services.ts`, even though the data being decoded was **already** trusted
(constructed moments earlier from the already-decoded `NestingRequest`, never
having crossed a process/thread boundary):

1. `geometryKernel.offsetConvexPolygon` (`geometryKernel.ts:171-178`) decodes
   `OffsetConvexPolygonInput` (`services.ts:105-109`, wrapping
   `IrregularPolygonSchema` + `NonNegativeFiniteMillimeters`) via
   `decodeOffsetConvexPolygonInput` (`geometryKernel.ts:245-258`). Failure
   message: `'offset input must satisfy the shared offset geometry schema.'`
   (`geometryKernel.ts:251-254`; confirmed observable in
   `tests/unit/irregularGeometryKernel.test.ts:270-290`, which feeds a
   negative `totalPaddingMm` and asserts exactly this string).
2. `transformGenerator.generateTransforms` (`transformGenerator.ts:68-…`)
   decodes `GenerateTransformsInput` (`services.ts:117-124`, wrapping
   `CollisionGeometrySchema` + `IrregularGeometrySettings` +
   `IrregularOptimizerSettings`) via `decodeInput`
   (`transformGenerator.ts:241-250`). Failure message: `'transform input must
   satisfy its schema.'` (`transformGenerator.ts:246`).

Both call sites happen **once per prepared piece** (bounded by piece count,
not by search fanout — `computeIrregularNesting.ts`'s `for (const prepared of
sortedPieces)` loop, lines 389-431), so their cost does not scale with the
number of placement candidates evaluated during the search. This is Seam B's
defining property: it is a defensive, assertion-style invariant check reusing
the `Schema` machinery as a validation library on data that is, in every
production run, already guaranteed valid by construction (it can only fail if
an internal invariant elsewhere in the codebase is violated — e.g. a negative
`totalPaddingMm` reaching `offsetConvexPolygon`, which cannot happen today
because `request.padding` is `NonNegativeIntegerMillimeters` at the `NestingRequest`
schema level and `PreparedPiece.padding` likewise). For the Rust port, Seam B
does **not** require a serde-style decode pass on the native side — it
requires reproducing the exact *conditions* under which each check fails
(non-convexity, non-finite offset distance, negative padding) and the exact
message strings, since those strings are observable via `IrregularGeometryInputError.message`
→ `AppErrorCode.irregular_geometry_invalid` context (per `errors-protocol.md`
§11.1's live-construction-site inventory, which lists both these sites among
its 15).

**Contrast: the hot path deliberately bypasses `Schema` entirely.**
`geometryKernel.transformCollisionGeometry` (`geometryKernel.ts:179-190`) is
called once per placement candidate per quarter-turn (§2 of
`docs/architecture/schema-models.md`: "The search instantiates these per
placement and per quarter turn"). It does **not** call `Schema.decodeUnknownExit`
anywhere — it calls `resolveTransformedCollisionGeometry` directly
(`core/transformCollisionGeometryCore.ts:38-63`), which validates via a
hand-written `ConvexPolygonValidation.validateStrictBoundary` predicate
returning a plain `{ok: true, value} | {ok: false, message}` union, not a
`Schema`. This split — one-time-per-piece operations pay a real schema
decode, per-candidate operations use a hand-rolled fast path — is exactly the
optimization `docs/architecture/schema-models.md:50-58` documents (the
`37-250 us` `Schema.Class` construction cost, `78.7s → 48.8s` on Mixed-61).
`validatePlacement` (`geometryKernel.ts:191`, a direct alias for
`PlacementValidation.validate`) follows the same hot-path pattern; it never
touches `Schema` either (confirmed: `grep -n "Schema\."` on
`placementValidation.ts` returns nothing).

**What is guaranteed on the trusted side, concretely, once Seam A has run:**

- `request.sheet.width`, `request.sheet.height` are positive integer
  millimeters (`SheetSpec` fields = `PositiveIntegerMillimeters` =
  `Schema.Int.check(isGreaterThan(0))`, `nesting.ts:59-63`, `geometry.ts:17`).
- `request.padding` is a non-negative integer millimeter value
  (`NonNegativeIntegerMillimeters`, `nesting.ts:147`).
- Every `request.pieces[i]` is a `PreparedPiece` with `realBounds: Rect`,
  `paddedBounds: RectWith` (both integer-millimeter, non-negative/positive
  per field), `padding: NonNegativeIntegerMillimeters`, `allowRotation: boolean`
  (always present, no default), `allowMirror: boolean` (present after
  decode — decode-time default `true` if the wire payload omitted it,
  `nesting.ts:129-133`), and optional `interchangeabilityKey`/`cutRowRef`.
- `request.options.allowGlobalRotation: boolean` is always present (no
  default; `NestingOptions.allowGlobalRotation`, `nesting.ts:98`).
  `request.options.allowGlobalMirror` is present after decode with
  decode-time default `true` if omitted (`nesting.ts:99-103`) — **and**
  `computeIrregularNesting.ts:406-407` redundantly re-applies `?? true` at
  the call site (`(request.options.allowGlobalMirror ?? true)`) even though
  the schema guarantees it is never `undefined` post-decode. This is a
  second instance of the same "belt-and-suspenders" pattern as Seam B — see
  §12.
- `request.sourcePieces` is *optional* — Seam A guarantees nothing about its
  presence. `computeIrregularNesting.ts:381` resolves omission to `[]`
  (`const sourcePieces = request.sourcePieces ?? []`), meaning an omitted
  `sourcePieces` field is **not** a decode error; it becomes a first-piece
  `IrregularComputeError` (`irregular_source_geometry_missing`) at
  `computeIrregularNesting.ts:392-398` the moment the loop tries to resolve
  the first prepared piece's source geometry via `findSourcePiece`
  (`computeIrregularNesting.ts:1906-1920`, not part of this cluster but
  immediately downstream of it).
- `request.options.irregularSettings` is *optional*. Its omission resolves
  to `GeometrySettings.Make` (= `DEFAULT_IRREGULAR_NESTING_SETTINGS`,
  `geometryKernel.ts:38`, `defaults.ts:180-183`) at
  `nesting.worker.ts:375`: `const geometrySettings = request.options.irregularSettings ?? GeometrySettings.Make`.
  This is the **one** optional field this cluster directly reacts to: its
  resolved value becomes the `IrregularNestingSettings` instance provided as
  `GeometrySettings` for the entire job (`nesting.worker.ts:398`).
- `SheetSpec` itself (a real `Schema.Class`, not a plain trusted carrier) is
  **not** reconstructed anywhere downstream of Seam A — it is passed by
  reference into every operation that needs it (`ComputeIfpBoundsInput.sheet`,
  `GeneratePlacementCandidatesInput.sheet`, `ComputeFreeMaterialInput.sheet`,
  `RunPortfolioInput.sheet`, all declared in `services.ts`). It never hits
  the `37-250 us` reconstruction cost `schema-models.md` warns about because
  it is constructed exactly once (at Seam A) and only *read* thereafter,
  never rebuilt per candidate. This is worth stating precisely because it is
  easy to mis-generalize "trusted carriers are plain classes" into "every
  class touched by the hot loop must be a plain class" — `SheetSpec`
  disproves that generalization; what matters is construction frequency, not
  class kind.

---

## 3. Data in/out: exact types/shapes, optional-field presence/omission semantics

### 3.1 Enforcement of the trusted-carrier split (architecture tests)

Two tests make the schema-vs-trusted-class split in §1.2 a compile/test-time
invariant, not just a convention. Both were read in full and re-verified by
inspection of their assertions:

- `tests/unit/trustedGeometryCarrierBoundary.test.ts` asserts, for 16 named
  "trusted carrier" classes (`CollisionGeometry`, `CollisionGeometryDiagnostic`,
  `FlattenedGeometry`, `FreeMaterialRegion`, `FreeMaterialSnapshot`,
  `IrregularBounds`, `IrregularGeometryCacheKey`, `IrregularIfpBounds`,
  `IrregularNfp`, `IrregularPlacement`, `IrregularPoint`, `IrregularPolygon`,
  `IrregularPreparedPiece`, `IrregularPriorityOrderKey`, `IrregularTransform`,
  `IrregularTransformCandidate`, all declared in `@shared/irregular/domain.ts`):
  (a) each is a plain declared class with no `extends Schema.Class`
  heritage clause (`:121-127`); (b) a paired `*Schema` constant exists for
  each (`:128`); (c) **every file under `src/workers/algorithm/irregular` and
  `src/workers/irregular` *except* `services.ts`** must not reference any of
  those 16 `*Schema` symbols, even through namespace imports, aliasing, or
  transitive re-export (`:133-158`, using the TypeScript compiler API to
  resolve aliased symbols). **`services.ts` is the sole file in this whole
  subtree permitted to name a trusted-carrier schema directly** — it is
  where `OffsetConvexPolygonInput` (wrapping `IrregularPolygonSchema`) and
  `GenerateTransformsInput` (wrapping `CollisionGeometrySchema`) are built.
  `geometryKernel.ts` and `transformGenerator.ts` import those two
  *derived* operation schemas from `services.ts`, never the underlying
  carrier schemas directly — this is exactly how Seam B (§2.3) stays narrow:
  it can only validate at the *edges* services.ts chooses to expose, never
  arbitrarily deep into carrier internals from a random call site.
- `tests/unit/pureIrregularCoreBoundary.test.ts` asserts the complementary
  boundary one layer down: every file transitively reachable from
  `src/workers/irregular/core/*.ts` via relative imports must not import
  `effect`, `effect/*`, or `@shared/*` at all (`:9-36`), verified by walking
  the whole relative-import closure with the TypeScript compiler API and by
  a second test asserting the specifier-detection logic itself recognizes
  every static/dynamic/require/namespace import form (`:38-62`). This is why
  `internalGeometry.ts` (§1.1) exists as a separate, `Effect`-free,
  `@shared/*`-free type vocabulary distinct from the real domain classes.

### 3.2 `NestingRequest` — complete field enumeration

Declared `nesting.ts:143-152`. Every field, exact type, optionality, and
default behavior:

| Field | Type | Optional? | Omission/default behavior |
|---|---|---|---|
| `version` | `Schema.Literal(1)` | No | Must be exactly `1`. |
| `jobId` | `JobId.withDefault` | Has constructor default | Auto-generated if omitted at construction time; always present after decode of a real wire payload (callers always supply it). |
| `sheet` | `SheetSpec` (nested `Schema.Class`) | No | — |
| `padding` | `NonNegativeIntegerMillimeters` | No | — |
| `pieces` | `Schema.Array(PreparedPiece)` | No | May be empty array; never `undefined`. |
| `sourcePieces` | `Schema.optional(Schema.Array(ImportedPiece))` | **Yes** | Omission is not a decode error. `computeIrregularNesting.ts:381` treats omission as `[]`, which then fails the *first* piece's source lookup with `IrregularComputeError` (§2.3). |
| `options` | `NestingOptions` (nested `Schema.Class`) | No | — |
| `strategyRunId` | `Schema.optional(Schema.String)` | Yes | Governs history-file append vs. truncate mode in `nesting.worker.ts:203`; not consumed by this cluster. |

### 3.3 `NestingOptions` — complete field enumeration (`nesting.ts:97-118`)

| Field | Type | Optional? | Default |
|---|---|---|---|
| `allowGlobalRotation` | `Schema.Boolean` | No | — |
| `allowGlobalMirror` | `Schema.Boolean` | optionalKey | `true` (both `withConstructorDefault` and `withDecodingDefaultKey`) |
| `timeoutMs` | `Schema.Number` | No | — |
| `workerMode` | `WorkerMode` (`'maxrects-beam-search' \| 'irregular-convex-v2'`) | No | Selects whether `handleRunNesting` calls `computeIrregularWorkerResult` at all (`nesting.worker.ts:240`); not this cluster's concern beyond being the switch that makes this cluster live for a given job. |
| `historyMode` | `HistoryMode` (`'stream' \| 'final' \| 'off'`) | No | Not consumed by this cluster. |
| `historyScope` | `HistoryScope` (`'winning_path'`) | No | Not consumed by this cluster. |
| `strategySelectionMode` | `StrategySelectionMode` | No | Not consumed by this cluster. |
| `strategyIds` | `Schema.Array(Schema.String)` | No | Not consumed by this cluster. |
| `layoutSelectionStrategyId` | `Schema.String` | No | Not consumed by this cluster. |
| `finalSelectionMode` | `FinalSelectionMode` | No | Not consumed by this cluster. |
| `topN` | `Schema.optional(Schema.Number)` | Yes | Not consumed by this cluster. |
| `maxHistoryEvents` | `Schema.optional(Schema.Number)` | Yes | Not consumed by this cluster. |
| `irregularSettings` | `Schema.optional(Schema.suspend(() => IrregularNestingSettings))` | **Yes** | Omission → `GeometrySettings.Make` (§2.3). **This is this cluster's single most important optional field.** |

### 3.4 `IrregularNestingSettings` — complete shape

`IrregularNestingSettings` (`domain.ts:493-498`) is exactly two nested
classes:

```
IrregularNestingSettings {
  geometry:  IrregularGeometrySettings
  optimizer: IrregularOptimizerSettings
}
```

**`IrregularGeometrySettings`** (`domain.ts:280-299`):

| Field | Type | Constraint |
|---|---|---|
| `flatteningSagToleranceMm` | `PositiveFiniteMillimeters` (`Schema.Finite.check(isGreaterThan(0))`) | finite, `> 0` |
| `clearanceSafetyMarginMm` | `NonNegativeFiniteMillimeters` (`Schema.Finite.check(isGreaterThanOrEqualTo(0))`) | finite, `>= 0`, **and** cross-field checked `>= flatteningSagToleranceMm` (`domain.ts:285-294`) |
| `geometryBackendId` | `Schema.NonEmptyString` | — |
| `geometryBackendVersion` | `Schema.NonEmptyString` | — |

**`IrregularOptimizerSettings`** (`domain.ts:301-466`) — 25 fields; the ones
relevant to this cluster's role as a pass-through (full field list is more
relevant to search-scoring.md/capacity-search.md, since this cluster never
branches on them):

| Field | Type | Default (if optional) |
|---|---|---|
| `orderWindow` | `PositiveFiniteInteger` | — |
| `beamWidth` | `PositiveFiniteInteger` | — |
| `localCandidateFanout` | `PositiveFiniteInteger` | optional, default `4` |
| `localRepairBudget` | `NonNegativeFiniteInteger` | optional, default `0` |
| `intrinsicSharedArchiveEnabled` | `Schema.Boolean` | optional, default `false` |
| `intrinsicObjectiveProfileId` | `'compact' \| 'short-side'` | optional, default `'compact'` |
| `transformCap` | `PositiveFiniteInteger` | — |
| `transformMinimumEdgeLengthMm` | `NonNegativeFiniteMillimeters` | decode default `1` (no constructor default) |
| `transformAngleDeduplicationToleranceDeg` | `PositiveFiniteDegrees` | decode default `0.01` |
| `configuredRotationEnabled` | `Schema.Boolean` | optional, default `true` |
| `edgeAlignmentEnabled` | `Schema.Boolean` | optional, default `true` |
| `configuredRotationDeg` | `Schema.Array(FiniteDegrees)` | decode default `[]` |
| `gaEnabled` | `Schema.Boolean` | optional, default `false` |
| `baselineOnly` | `Schema.Boolean` | optional, default `true` |
| `gaPopulation` | `PositiveFiniteInteger` | — |
| `gaGenerationBudget` | `NonNegativeFiniteInteger` | optional, default `2` |
| `gaEvaluationBudget` | `NonNegativeFiniteInteger` | optional, default `24` |
| `gaTimeBudgetMs` | `NonNegativeFiniteInteger` | — |
| `gaSeed` | `Schema.NonEmptyString` | — |
| `priorityOrderMutationEnabled` | `Schema.Boolean` | optional, default `true` |
| `transformPreferenceMutationEnabled` | `Schema.Boolean` | optional, default `true` |
| `placementPolicyMutationEnabled` | `Schema.Boolean` | optional, default `true` |
| `placementPolicyId` | `IrregularPlacementPolicyId` | optional, default `'balanced-compactness'` |
| `placementPolicyIds` | non-empty `Schema.Array(IrregularPlacementPolicyId)` | optional, default the 3-element production list |

Cross-field `.check()` filter (`domain.ts:418-458`): (1) `placementPolicyId`
must be a member of `placementPolicyIds`; (2) `placementPolicyIds` must have
no duplicates; (3) if `intrinsicObjectiveProfileId === 'short-side'`, then
`intrinsicSharedArchiveEnabled` must be `true` **and** GA must be fully
disabled (`gaEnabled === false || baselineOnly === true || gaTimeBudgetMs ===
0 || gaGenerationBudget === 0 || gaEvaluationBudget === 0`), and
`placementPolicyId` must not be `'short-side-fill'`. **Production presets
always satisfy this**: `makeCompactShortSideIrregularOptimizerSettings`
(`defaults.ts:168-175`) sets `intrinsicObjectiveProfileId: 'short-side'` on
top of `makeCompactQualityIrregularOptimizerSettings` (`defaults.ts:149-165`),
which already sets `intrinsicSharedArchiveEnabled: true`, `baselineOnly:
true`, `gaEnabled: false`, `placementPolicyId:
'edge-contact-then-balanced-compactness'`.

### 3.5 Every operation-scoped input/output type declared in `services.ts`

These are plain TypeScript interfaces (not `Schema`, except the two named
below) — internal algorithm DTOs per `schema-models.md`'s "Internal DTOs"
section:

| Type | Shape | Decoded via `Schema`? |
|---|---|---|
| `FlattenSourceGeometryInput` (`:91-93`) | `{ piece: ImportedPiece }` | No |
| `BuildCollisionGeometryInput` (`:95-98`) | `{ piece: ImportedPiece, totalPaddingMm: number }` | No (declared, but `CollisionGeometryBuilder` — a different cluster — is what actually consumes this) |
| `OffsetConvexPolygonInput` (`:105-109`) | `{ polygon: IrregularPolygonSchema, totalPaddingMm: NonNegativeFiniteMillimeters }` | **Yes** — `Schema.Struct`, decoded at `geometryKernel.ts:249` |
| `TransformCollisionGeometryInput` (`:111-114`) | `{ geometry: CollisionGeometry, transform: IrregularTransformCandidate }` | No |
| `GenerateTransformsInput` (`:117-124`) | `{ geometry: CollisionGeometrySchema, allowRotation: boolean, allowMirror: boolean, geometrySettings: IrregularGeometrySettings, settings: IrregularOptimizerSettings }` | **Yes** — `Schema.Struct`, decoded at `transformGenerator.ts:244` |
| `ComputeNfpInput` (`:126-132`) | `{ fixed: IrregularPlacedPiece, moving: TransformedCollisionGeometry, settings: IrregularNestingSettings['geometry'] }` | No |
| `ComputeIfpBoundsInput` (`:134-137`) | `{ sheet: SheetSpec, moving: TransformedCollisionGeometry }` | No |
| `NfpIfpLegalCandidateSource` / `NfpIfpCandidateProvenance` (`:151-175`) | observer-only diagnostic shapes, doc-commented "It deliberately describes generator admission, not a scorer, fanout, or terminal selection decision" (`:157-160`) | No — never authoritative |
| `GeneratePlacementCandidatesInput` (`:177-189`) | `{ sheet, placed: ReadonlyArray<IrregularPlacedPiece>, placedCollisionIndex?, moving, settings: IrregularNestingSettings, candidateDomain?: 'sheet'\|'contact-only'\|'sheetless-nfp', candidateMemoScope?, onCandidateProvenance?, control? }` | No |
| `IrregularNfpIfpCandidateMemoScope` (`:191-196`) | Opaque nominal-identity class, branded with a `Symbol()` private field (`IRREGULAR_NFP_IFP_CANDIDATE_MEMO_SCOPE_IDENTITY`) so it can never be constructed to look like an unrelated value. Used to bound legal-candidate memoization to one decode invocation (implemented in `nfpIfpService.ts`, a different cluster). | No |
| `ValidatePlacementInput` (`:206-213`) | `{ sheet, placed, placedCollisionIndex?, moving, candidate: IrregularPlacementCandidate }` | No |
| `ComputeFreeMaterialInput` (`:215-227`) | `{ sheet, placed, settings: IrregularGeometrySettings }`. Doc comment (`:216-222`): *"This is a worker-internal service call, not an untrusted boundary … the service no longer redecodes it per call."* | No — explicitly, by design |
| `ExtendFreeMaterialInput` (`:229-234`) | `{ parent: FreeMaterialSnapshot, placed: IrregularPlacedPiece, settings: IrregularGeometrySettings }` | No |
| `BuildPriorityOrderInput` (`:236-239`) | `{ pieces: ReadonlyArray<IrregularPreparedPiece>, settings: IrregularNestingSettings['optimizer'] }` | No |
| `RunPortfolioInput` (`:241-260`) | `{ sheet, pieces, onProgress?, onStateSnapshot?, emitDecisionTrace?, decisionTraceDecodeIdPrefix?, onSelectedState?, isCancelled? }` — every callback field is a benchmark/observer hook except `onSelectedState`, doc-commented "Private algorithm seam retaining the exact selected legal terminal state" (`:257-258`) | No |

### 3.6 `GeneratePlacementCandidates`'s overloaded signature (JS/TS-specific)

`NfpIfpService.generatePlacementCandidates` (`services.ts:302-325`) is
declared with **3 TypeScript call-signature overloads** on the same method,
distinguished only by whether the input's `control` field is present:
with `control` present the return channel includes
`IrregularNfpIfpControlAbortError`; without it, that error variant is
type-level unreachable. This is a compile-time-only distinction — at
runtime there is exactly one function. See §12 for the Rust-port
consequence.

### 3.7 `GeometryKernel.Service` — the 5 operations (`geometryKernel.ts:43-85`)

| Method | Input | Output | Errors |
|---|---|---|---|
| `flattenSourceGeometry` | `FlattenSourceGeometryInput` | `FlattenedGeometry` | `IrregularNestingNotImplementedError` only (never actually fails on `.Live`) |
| `convexHull` | `ReadonlyArray<IrregularPoint>` | `IrregularPolygon` | `IrregularNestingNotImplementedError` only |
| `offsetConvexPolygon` | `OffsetConvexPolygonInput` | `IrregularPolygon` | `IrregularNestingNotImplementedError \| IrregularGeometryInputError` |
| `transformCollisionGeometry` | `TransformCollisionGeometryInput` | `TransformedCollisionGeometry` | `IrregularNestingNotImplementedError \| IrregularGeometryInputError` |
| `validatePlacement` | `ValidatePlacementInput` | `void` | `IrregularNestingNotImplementedError \| IrregularGeometryInputError` |

### 3.8 `GeometryCache` service surface (`services.ts:374-385`)

```
GeometryCache {
  store:  GeometryCacheStore        // synchronous get/set/remove/clear, no Effect wrapper
  get:    <A>(key) => Effect<A | undefined>
  set:    <A>(key, value) => Effect<void>
  remove: (key) => Effect<void>
  clear:  Effect<void>
}
```

See §9 for which half of this dual API production code actually uses.

---

## 4. Algorithm state and every mutation point

This cluster owns almost no state of its own; what little exists is
enumerated exhaustively below (grep-confirmed — see §7/§8 for the negative
findings that back this claim).

1. **`makePointsStore` local closure state** (`geometryKernel.ts:96-112`,
   inside `GeometryKernel.Make`'s `flattenSourceGeometry` implementation).
   Two mutable locals, both created fresh on **every** `flattenSourceGeometry`
   call (no cross-call persistence):
   - `points: IrregularPoint[]` — mutated only via `points.push({x, y})`
     (`:106`).
   - `seen: Set<`${number}:${number}`>` — mutated only via `seen.add(key)`
     (`:105`), read via `seen.has(key)` (`:104`).
   - `.get()` returns `[...points]` (`:109`) — a fresh copy, so the returned
     array can never alias the closure's internal mutable array.
2. **`sampledSourceCurves: Set<string>`** (`geometryKernel.ts:117`) — a
   second closure-local mutable `Set`, scoped to one `flattenSourceGeometry`
   call, guarding against re-sampling the same `sourceCurve.sourceId` twice
   when multiple `line` segments reference one shared ellipse/arc source
   curve (`:122-126`).
3. **`GeometryCacheStore`'s backing `Map<string, unknown>`**
   (`geometryCacheStoreLive.ts:10`, instantiated by
   `makeGeometryCacheStore()`, called from `GeometryCacheLive`
   (`services.ts:437`) exactly once per `Layer.sync` build). This is the
   **only** mutation point in this cluster whose lifetime spans more than
   one function call — it lives for the duration of one worker job (§9).
   Mutated via `.set`/`.remove`/`.clear` from `transformCollisionGeometry`'s
   pure-core resolver (`core/transformCollisionGeometryCore.ts:57,61`) and
   from `nfpIfpService.ts` call sites (a different cluster).

Everything else in these five files is either a pure function, a `Layer`
factory (evaluated once at module load or once at `Layer.build` time, never
mutated afterward), or a type/interface declaration. `infrastructure.ts`,
`index.ts`, and `internalGeometry.ts` contain **zero** mutable state.

---

## 5. Ordering sources

Grep-confirmed **zero** hits for `.sort(`, `Order.`, `.keys(`, `.entries(`,
or `for (const … in …)` across all five target files. The only
order-sensitive behavior owned by this cluster is insertion-order
preservation, not comparison-based sorting:

1. **`flattenSourceGeometry`'s output point order**
   (`geometryKernel.ts:119-168`). The `for (const segment of
   piece.geometry.segments)` loop (`:119`) iterates the decoded `ImportedPiece.geometry.segments`
   array in its **decode-preserved order** (an array, so JS/TS guarantees
   stable iteration order — this order originates upstream in the DXF import
   pipeline, out of this cluster's scope). Within that loop, `pointsStore.push`
   appends points in exactly the order each segment/curve/arc emits them
   (`Match.value(segment).pipe(Match.when(...))`, `:120-160`), and the `Set`-based
   dedup (§4.1) is a **first-occurrence-wins** filter that never reorders —
   a point already seen is silently dropped, everything else is appended in
   traversal order. `.get()` (`:108-110`) returns the accumulated array
   as-is (via spread, `[...points]`), preserving that exact order.
2. **`sampledSourceCurves`'s effect on ordering**: it does not reorder
   anything; it only prevents the *second and later* `line` segments sharing
   one `sourceCurve.sourceId` from re-emitting that curve's sample points a
   second time. The **first** segment referencing a given source curve
   determines where in the output array that curve's points land.
3. **`GeometryCacheStore`'s backing `Map`**: never iterated by anything in
   this cluster (only `.get`/`.set`/`.remove`/`.clear` by exact key — grep
   confirms zero `.keys()`/`.entries()`/`.forEach()`/`for...of` over the map
   anywhere in `services.ts`, `geometryCacheStoreLive.ts`, or
   `core/geometryCacheStore.ts`). Its internal iteration order is therefore
   never observable and never needs to be reproduced in Rust.

**Immediately downstream of the seam (not this cluster's own code, but the
very next statement after `yield* GeometrySettings` at
`computeIrregularNesting.ts:379`):** `sortPiecesForNesting(request.pieces)`
(`computeIrregularNesting.ts:380`, implemented at
`sortPiecesForNesting.ts:13-17`) produces `sortedPieces`, the array this
cluster's per-piece loop (`offsetConvexPolygon`/`generateTransforms` calls,
§2.3) iterates over. Its comparator: `Order.combineAll([longestEdge
descending, area descending, imbalance descending])`
(`sortPiecesForNesting.ts:6-9`), applied via `pieces.toSorted(order)`
(`:16`, ES2023 `Array.prototype.toSorted` — a stable sort per spec, and V8's
underlying `Array.prototype.sort`/`toSorted` has been spec-guaranteed stable
since ES2019). This determines "prepared-piece order," one of the exact
values the migration prompt (§2) says must never change — but the
comparator itself is out of this cluster's primary-subject scope (it lives
in `sortPiecesForNesting.ts`, one file up from this cluster's boundary); it
is documented here only because this cluster's per-piece loop is the first
consumer of its output order.

---

## 6. Comparators and tie rules

**None.** Grep-confirmed zero occurrences of `.sort(`, `Order.`, or any
`compare`-named function across `services.ts`, `infrastructure.ts`,
`index.ts`, `internalGeometry.ts`, `geometryKernel.ts`. This cluster performs
no ranking, tie-breaking, or comparison of any kind. (Comparators live in
`search-scoring.md`'s and `capacity-*.md`'s clusters.)

---

## 7. Numeric semantics

Grep-confirmed **zero** occurrences of `Math.*` and **zero** occurrences of
`BigInt` across all five target files — a clean negative finding worth
stating explicitly, since other clusters (collision-prep, nfp-ifp) are
dense with both. This cluster's only numeric logic is:

1. **`computeCollisionOffsetMm`** (`geometryKernel.ts:230-243`) — the entire
   arithmetic surface this cluster owns:
   ```ts
   const distanceMm = totalPaddingMm / 2 + settings.clearanceSafetyMarginMm
   if (!Number.isFinite(distanceMm)) { /* fail IrregularGeometryInputError */ }
   ```
   Exact operation order matters for binary64 reproducibility: **divide by 2
   first, then add** the clearance margin — not `(totalPaddingMm +
   2*clearanceSafetyMarginMm) / 2` or any algebraically-equivalent
   reassociation (per migration prompt §8.1: "Do not enable compiler options
   or transformations that reassociate floating-point expressions"). This
   formula is directly confirmed by `tests/unit/irregularGeometryKernel.test.ts:222-241`:
   `totalPaddingMm: 2`, `clearanceSafetyMarginMm: 0.5` → offset distance
   `1.5`, producing corner coordinates offset by exactly `1.502` mm (the
   `0.002` extra coming from `ConvexPolygonOffset.compute`'s own conservative
   margin, a different cluster's code — collision-prep.md). `Number.isFinite`
   here is the **only** NaN/Infinity rejection this cluster performs itself
   (as opposed to rejection happening at `Schema.Finite` decode time, which
   is a different mechanism — see point 3 below).
2. **`makePointsStore`'s dedup key** (`geometryKernel.ts:103`): `` `${x}:${y}` ``
   — a JS template literal, which stringifies `x`/`y` via the implicit
   `Number.prototype.toString()` coercion (ECMA-262's shortest-round-trip
   decimal algorithm, switching to exponential notation outside
   `[1e-6, 1e21)`). Two floating-point values that are numerically distinct
   but stringify identically under this algorithm (there are none in
   practice for finite doubles — `Number.prototype.toString()` is
   round-trip-exact) will collide in `seen`; two values differing only in
   how many decimal digits a *naive* Rust `format!("{}", f64)` would print
   will **not** collide the same way unless the port reproduces V8's exact
   float-to-string algorithm. The comment directly above this line
   (`geometryKernel.ts:101-102`) states this is deliberate: *"exact keys are
   intentional here: this only deduplicates points already emitted with
   identical coordinates … it avoids introducing a hidden geometric
   tolerance, grid snapping, or arc-specific rounding policy."* See §12 for
   the Rust-port hazard this creates (this is a **new** hazard beyond the
   one `nfp-ifp.md` already documents for a different file's cache-key
   digest functions — same root cause, different call site).
3. **NaN/Infinity rejection at the schema layer**, not owned by this
   cluster's code but directly gating what this cluster's operations can
   ever receive: `FiniteNumber = Schema.Finite` (`domain.ts:72`),
   `NonNegativeFiniteMillimeters = Schema.Finite.check(isGreaterThanOrEqualTo(0))`
   (`domain.ts:75`) — both reject `NaN`/`±Infinity` at `Schema.decode` time,
   which is why `offsetConvexPolygon`'s `Number.isFinite` check
   (point 1 above) can only ever fire on an *arithmetic result* (the sum),
   not on malformed input fields (those are already excluded by the time
   `OffsetConvexPolygonInput` decodes successfully).
4. **Integer checks**: `IrregularTransformCandidateSchema.index:
   NonNegativeFiniteInteger` (`domain.ts:249`, `= Schema.Int.check(isGreaterThanOrEqualTo(0))`)
   is referenced (not decoded) by this cluster's `GenerateTransformsInput`
   wrapper — `Schema.Int` semantics (integer-valued, finite) are inherited,
   not reimplemented, here.

No signed-zero normalization happens in this cluster's own code (that logic
— `Object.is(value, -0) ? 0 : value` — lives in
`core/transformCollisionGeometryCore.ts:180-182`, a different cluster's
file, called by `resolveTransformedCollisionGeometry`, which
`geometryKernel.ts:184` invokes but does not implement).

---

## 8. Serialization and hashing

**No SHA-256, no canonical-JSON custom encoder, and no `createHash`/`sha256`
call of any kind anywhere in this cluster's five files** (grep-confirmed:
zero hits for `createHash`, `sha256`). This cluster contributes **nothing**
to canonical hashing directly (that belongs to `shared-archive.md`'s
cluster). The one serialization this cluster owns is the in-process,
never-hashed, never-persisted geometry-cache key encoding:

- `serializeGeometryCacheKey(key: {namespace: string, parts: readonly
  string[]})` (`core/geometryCacheStore.ts:13-15`):
  ```ts
  JSON.stringify([key.namespace, key.parts])
  ```
  i.e. `'["namespace",["part1","part2",...]]'`. `cacheKeyToString`
  (`services.ts:415-417`) is a thin public re-export of this exact function
  for `IrregularGeometryCacheKey` (a structurally-identical, separately
  declared plain class in `domain.ts:890-898` — see §12 for the structural-
  typing hazard this implies).
  - This string is used **only** as a `Map<string, unknown>` key inside one
    job's in-memory `GeometryCacheStore` (§9); it is never written to disk,
    never sent over IPC, never hashed, and never compared across processes
    or jobs. A Rust port may therefore choose *any* deterministic key
    encoding for its own cache (a tuple/struct key with `Eq`/`Hash`, for
    instance) without needing byte-for-byte parity with this JSON string —
    unlike the canonical keys `shared-archive.md`/`nfp-ifp.md` document,
    which **do** require byte-identical reproduction because they are
    observable (feed archive dedup, checkpoints, or hashes).
  - Caveat: `JSON.stringify` applies RFC 8259 string escaping to any
    character in `namespace`/`parts` that requires it (`"`, `\`, control
    characters). In practice every `parts` entry observed in this codebase
    is a controlled numeric-string or identifier encoding produced by
    `geometryCacheIdentity.ts`/`nfpCacheKey.ts` (a different cluster), never
    raw user text, so this is a low-probability edge case, not a currently
    observed one.

---

## 9. Caches touched and the exact historical access sequence

### 9.1 The one cache this cluster implements: `GeometryCache`

`GeometryCache` (`services.ts:374-385`) wraps exactly one `GeometryCacheStore`
(`core/geometryCacheStore.ts:6-11`, implemented by
`makeGeometryCacheStore()` in `geometryCacheStoreLive.ts:9-30` — one
namespace-agnostic `Map<string, unknown>` keyed by
`serializeGeometryCacheKey`, §8). `GeometryCacheLive`
(`services.ts:436-448`, aliased as `GeometryCacheInMemory` at `services.ts:451`)
is a `Layer.sync` that constructs exactly one fresh store per `Layer.build`.

### 9.2 The dual API, and which half production actually uses

`GeometryCache` exposes **two parallel interfaces** to the same underlying
store:
- `store: GeometryCacheStore` — synchronous, direct `get`/`set`/`remove`/`clear`.
- `get`/`set`/`remove`/`clear` — `Effect`-wrapped versions of the exact same
  operations (`services.ts:440-447`, each just `Effect.sync(() =>
  store.<method>(...))`).

**Production code exclusively uses `.store` directly, never the
`Effect`-wrapped methods.** Grep across `src` and `tests`:
`geometryKernel.ts:184` (`resolveTransformedCollisionGeometry(input,
settings.geometry, geometryCache.store, ...)`) and
`nfpIfpService.ts:136,148,231,262` (`resolveNfpBoundary(...,
geometryCache.store, ...)`, `resolveIfpBounds(input, geometryCache.store)`)
are the **only** production call sites touching `GeometryCache`, and every
one of them reads `.store`. The `Effect`-wrapped `.get`/`.set`/`.remove`/`.clear`
methods (`services.ts:440-447`) have **zero production call sites** — their
only exercisers are `tests/unit/irregularGeometryCache.test.ts` (which calls
`cache.set`/`cache.get`/`yield* cache.clear` directly to test cache
coherence, e.g. `:188-198,259,270-272`). **This is a Rust-port
simplification opportunity, not a hazard**: the `Effect`-typed cache methods
never need porting for behavioral parity (nothing observable depends on
them running through `Effect`'s fiber machinery); only the synchronous
`get`/`set`/`remove`/`clear` semantics need to be reproduced exactly.

### 9.3 One `GeometryCacheStore` instance per job — empirically proven

The migration prompt §13.1 requires "one nesting job owns a coherent cache
domain." Whether the *actual* production wiring achieves this is not
obvious from reading `nesting.worker.ts:390-399` alone, because
`GeometryCacheInMemory` is referenced from **three** separate points in that
one provide chain:
1. Directly: `Effect.provide(GeometryKernel.Live)` (`nesting.worker.ts:397`),
   where `GeometryKernel.Live = GeometryKernel.Layer =
   Layer.effect(GeometryKernel, GeometryKernel.Make).pipe(Layer.provideMerge(GeometryCacheInMemory))`
   (`geometryKernel.ts:195-199`).
2. Transitively: `Effect.provide(CollisionGeometryBuilder.Live)`
   (`nesting.worker.ts:391`), where `CollisionGeometryBuilder.Live =
   CollisionGeometryBuilder.Layer.pipe(Layer.provideMerge(GeometryKernel.Live))`
   (`collisionGeometryBuilder.ts:108-111`) — the **same** `GeometryKernel.Live`
   object reference as point 1, which itself embeds the **same**
   `GeometryCacheInMemory` reference.
3. Directly: `Effect.provide(NfpIfpServiceLive)` (`nesting.worker.ts:393`),
   where `NfpIfpServiceLive = makeNfpIfpServiceLive() =
   makeNfpIfpServiceLayer().pipe(Layer.provideMerge(GeometryCacheInMemory))`
   (`nfpIfpService.ts:85-94`) — again the same module-level constant
   reference (`GeometryCacheInMemory = GeometryCacheLive`, `services.ts:451`).

Whether these three occurrences collapse into one shared store, or silently
construct three isolated caches (which would be a serious hidden-fragmentation
bug — NFP results cached by `NfpIfpServiceLive` would never be visible to
`GeometryKernel`'s transform cache and vice versa), depends entirely on
whether Effect's `Layer.build` memoizes a *reused layer object reference*
across separately-chained `Effect.provide(...)` calls in one `.pipe(...)`
composition — behavior not documented at the call site and easy to get
wrong by intuition. I verified this empirically rather than assuming: I
wrote a Vitest probe (`tests/unit/zzTmpCacheIdentityProbe.test.ts`, created
temporarily, run, and deleted before this document was written) that
composed the exact same 8 `Effect.provide(...)` calls in the exact same
order as `nesting.worker.ts:391-398`, using the real production layer
objects, with `enableNfpIfpTelemetry()` active so `nfpIfpTelemetrySnapshot()?.cacheInstances`
(incremented once per `makeGeometryCacheStore()` call, `geometryCacheStoreLive.ts:9,11`)
would reveal the true store count. Results:

| Assertion | Result |
|---|---|
| One composed job-shaped provide chain (all 8 `Effect.provide` calls, matching `nesting.worker.ts` exactly) | `cacheInstances === 1` |
| Two separate `Effect.runPromise` calls (two independent jobs) | `cacheInstances === 2` (one fresh store per job) |
| A value set via the top-level-resolved `GeometryCache` is readable back after also resolving `GeometryKernel` in the same composed effect | value round-trips exactly (`'marker-value'`) |

**Conclusion, proven not assumed: this cluster's cache is genuinely
job-local and genuinely shared coherently across every service that
references `GeometryCacheInMemory` in one job's provide chain — Compact
piece-preparation (via `CollisionGeometryBuilder`/`GeometryKernel`) and the
search's NFP/IFP caching (via `NfpIfpService`) read and write the exact same
backing `Map` for the whole job.** This independently confirms
`geometry-caches.md:82-118`'s static-analysis-based claim of the same fact
("Compact and Short Side share exactly one cache instance per worker job")
via a second, empirical method — the two documents corroborate each other.
The mechanism (for anyone auditing this claim later): Effect's `Layer.build`
memoizes by **layer object reference** within one fiber's build graph, even
across separately-chained `Effect.provide` calls, as long as the exact same
`Layer` value (not a re-invoked factory producing a structurally-identical
but distinct object) is reused. `GeometryCacheInMemory` is a single
`export const` (`services.ts:451`) referenced by reference everywhere it
appears — never re-constructed — which is precisely why memoization applies.
**Any Rust-port refactor that turns `GeometryCacheInMemory`-equivalent
construction into a factory function invoked at each of the three call
sites above would silently break this sharing** and must not be done without
an equivalent explicit shared-ownership mechanism (e.g. one `Arc<GeometryCacheStore>`
constructed once per job and threaded through every service's constructor).

### 9.4 Which of `GeometryKernel`'s 5 operations touch the cache

| Operation | Touches `GeometryCache`? |
|---|---|
| `flattenSourceGeometry` | No |
| `convexHull` | No (delegates to `ConvexHull.compute`, pure — grep-confirmed no `cache` reference in `convexHull.ts`) |
| `offsetConvexPolygon` | No (delegates to `ConvexPolygonOffset.compute`, pure — grep-confirmed no `cache` reference in `convexPolygonOffset.ts`) |
| `transformCollisionGeometry` | **Yes — the only one.** |
| `validatePlacement` | No (`PlacementValidation.validate` takes no cache parameter; `ValidatePlacementInput` has no cache field) |

### 9.5 Exact historical access sequence for `transformCollisionGeometry`

`geometryKernel.ts:179-190` calls `resolveTransformedCollisionGeometry`
(`core/transformCollisionGeometryCore.ts:38-63`, a different cluster's file,
but this is the **only** cache-touching call this cluster's own code makes,
so the sequence is recorded here as this cluster's cache contract). Its own
doc comment (`:37`) states the invariant precisely: *"Resolves transformed
collision geometry while preserving key/get-before-validation ordering."*
Exact sequence, in order:
1. `key = makeTransformCollisionGeometryCacheKey(input, settings)` (`:51`) —
   key construction happens **before** any cache access.
2. `cached = cache.get<TValue>(key)` (`:52`) — one `.store.get` call.
3. `isValidCachedTransformedCollisionGeometry(cached, input)` (`:53`) —
   structural revalidation of the cached value *before* trusting it: piece
   id match, transform match (`sameTransform`), polygon shape/vertex-count
   sanity, re-running `ConvexPolygonValidation.validateStrictBoundary`
   against the cached polygon, and recomputing bounds from the cached
   points to confirm they match the cached `bounds` field exactly
   (`transformCollisionGeometryCore.ts:115-137`) — a cache hit is **never**
   trusted merely because the key matched; the *value* is independently
   re-validated every time.
4. If valid: return `{ok: true, value: cached, key}` immediately (`:54`) —
   no recomputation, no `.set`.
5. If present but invalid (stale): `cache.remove(key)` (`:57`) — **eviction
   happens before recomputation, not after.**
6. `computed = computeTransformedCollisionGeometry(input)` (`:58`) — the
   actual mirror-then-rotate-then-snap-to-grid computation (owned by
   collision-prep.md's cluster).
7. If computation failed: return the failure immediately, **without**
   caching anything (`:59`) — invalid results are never cached, matching
   the migration prompt §13.2's "invalid results never cached" requirement.
8. `value = materialize(computed.value)` (`:60`) — domain-wraps the plain
   internal result into a `TransformedCollisionGeometry` class instance
   (via `toDomainTransformedCollisionGeometry`, passed in by
   `geometryKernel.ts:185`).
9. `cache.set(key, value)` (`:61`) — publish.
10. Return `{ok: true, value, key}` (`:62`).

This sequence — key, get, validate-the-hit (not just validate-the-key),
evict-before-recompute, compute, materialize, set, return — is exactly the
kind of "historical access sequence" the migration prompt §13.2 requires be
preserved verbatim in the Rust port, and it is the concrete reference
implementation for what "cache hit and recomputation must return the same
canonical immutable value" (§13.1) looks like in this codebase: the
revalidation in step 3 is *itself* the mechanism that guarantees that
property, not an incidental check.

---

## 10. Cancellation / deadline / budget / evaluation-cap observation points

This cluster **declares the contract, implements nothing**. Grep-confirmed:
the only occurrences of cancellation/deadline-related identifiers in these
five files are type/interface declarations, with zero call sites:

- `IrregularNfpIfpControlAbortError` (`services.ts:70-75`, `Data.TaggedError`
  with `reason: 'deadline' | 'cancelled'`) — declared, never constructed in
  these five files.
- `IrregularNfpIfpControl` interface (`services.ts:85-89`, one method:
  `checkpoint: (phase: IrregularNfpIfpCheckpointPhase) => Effect<void,
  IrregularNfpIfpControlAbortError>`) — declared, `.checkpoint(...)` is never
  called anywhere in these five files.
- `IrregularNfpIfpCheckpointPhase` (`services.ts:78-83`, a 5-member string
  union: `'ifp' | 'placed-nfp' | 'ifp-boundary-intersection' |
  'pairwise-nfp-boundary-intersection' | 'candidate-points'`) — a pure type.
- `RunPortfolioInput.isCancelled?: () => boolean` (`services.ts:259`) —
  declared as an optional field on an interface this cluster owns, but the
  actual polling/observation of it happens in `computeIrregularNesting.ts`
  and `intrinsicStrictDecoder.ts` (not this cluster).

Actual checkpoint/deadline behavior — including the important asymmetry that
`reason: 'deadline'` is live in production (from `intrinsicStrictDecoder.ts:480-485`)
while `reason: 'cancelled'` is gated behind `input.options?.isCancelled`,
which `nesting.worker.ts` never sets in production and is therefore
practically dead — is fully accounted for in `errors-protocol.md` §1.2
row 6 and §11.2, which this document defers to rather than duplicates.

**For the Rust port**: this cluster's role in cancellation/deadline handling
is purely to define the *shape* of the abort signal and the checkpoint
phases; none of the actual polling cadence, budget accounting, or
deadline-comparison logic needs to be ported from these five files, because
none of it lives here.

---

## 11. Error paths

### 11.1 Classes declared in `services.ts`

| Class | Fields | Declared at |
|---|---|---|
| `IrregularNestingNotImplementedError` | `service`, `operation`, `message` | `:34-40` |
| `IrregularGeometryInputError` | `operation`, `message` | `:42-45` |
| `IrregularGeometryInfeasibleError` | `operation`, `message` | `:47-52` |
| `IrregularPortfolioError` | `operation`, `category: 'geometry'\|'scoring'\|'search'`, `message` | `:55-59` |
| `IrregularNoValidResultError` | `operation`, `message` | `:62-67` |
| `IrregularNfpIfpControlAbortError` | `reason: 'deadline'\|'cancelled'`, `message` | `:70-75` |

Full liveness/production-mapping accounting for all 17 error classes across
the whole irregular worker (not just these 6) is `errors-protocol.md`'s
primary subject; this section covers only what these five files themselves
*construct*.

### 11.2 Construction sites inside these five files

Only 2 of the 6 declared classes are ever constructed by this cluster's own
code (grep-confirmed: `new Irregular.*Error(` across all five files):

1. **`IrregularNestingNotImplementedError`** — 2 sites, both feeding the
   `.Unimplemented` stub layers (never wired in production):
   - `services.ts:402-413` (`failNotImplemented` helper), used by
     `TransformGeneratorUnimplemented` (`:419-421`),
     `NfpIfpServiceUnimplemented` (`:423-428`),
     `FreeMaterialServiceUnimplemented` (`:430-433`).
   - `geometryKernel.ts:212-227` (a **separate**, locally-defined
     `failNotImplemented` helper with the same name but a different
     signature — it also formats a `geometryBackendId@geometryBackendVersion`
     suffix when settings are supplied, `:216-219`), used by
     `GeometryKernel.Unimplemented` (`:200-209`).
2. **`IrregularGeometryInputError`** — 1 site: `geometryKernel.ts:264`
   (`failInvalidGeometryInput` helper), used by both
   `computeCollisionOffsetMm` (non-finite offset distance, `:236-239`) and
   `decodeOffsetConvexPolygonInput` (schema decode failure, `:251-254`). The
   other production construction sites for this same error class (the
   convexity check inside `ConvexPolygonOffset.compute`, the transform
   generator's own schema decode failure, etc.) live in other files —
   `errors-protocol.md`'s inventory lists 15 total construction sites for
   this class.

### 11.3 Unimplemented layers — negative-path test scaffolding, not production

`TransformGeneratorUnimplemented`, `NfpIfpServiceUnimplemented`,
`FreeMaterialServiceUnimplemented` (`services.ts:419-433`) and
`GeometryKernel.Unimplemented` (`geometryKernel.ts:200-209`) exist solely so
tests can assert a service's `not_implemented` failure shape without
needing a real geometry backend. `nesting.worker.ts:391-397` wires
exclusively the `.Live` variants — `not_implemented` /
`IrregularNestingNotImplementedError` is therefore **unreachable from any
real user job today** (confirmed independently by `errors-protocol.md`'s
row 7, which reaches the identical conclusion by a different trace).

### 11.4 Error propagation shape

Both `IrregularGeometryInputError` (from Seam B, §2.3) and, in the
unreachable-in-production case, `IrregularNestingNotImplementedError`
propagate as ordinary `Effect` failures through the `Effect.gen`/`yield*`
chain — no `try/catch`, no `Effect.catchAll` swallowing inside these five
files (grep-confirmed: `geometryKernel.ts` contains no `catch` of any kind;
`services.ts` contains none either). They surface all the way to
`nesting.worker.ts`'s `Effect.mapError(toIrregularWorkerFailure)`
(`nesting.worker.ts:399`), which is the sole `IrregularComputeErrorType` →
`AppErrorCode` mapping site (full detail in `errors-protocol.md`).

---

## 12. JS-specific semantics hazards for a Rust port

1. **`Number.prototype.toString()`-keyed dedup Set** (`geometryKernel.ts:103`,
   §7 point 2). `makePointsStore`'s `` `${x}:${y}` `` key relies on V8's
   exact ECMA-262 shortest-round-trip float-to-string algorithm. A Rust
   port using `format!("{x}:{y}")` with `f64`'s default `Display` will not
   necessarily dedup the same set of points as the TS implementation for
   every possible input, because Rust's default float formatting and V8's
   are different algorithms with different digit-selection and
   exponential-notation thresholds. Since this function's only effect is
   *deduplication* (never geometric tolerance), the practical risk is low
   (any two floats that would print differently under either algorithm are
   already numerically distinct, and any collision under JS's algorithm
   necessarily represents the *exact same* `f64` bit pattern reaching the
   template literal — but only if the two call sites feeding `x`/`y` compute
   that value through bit-identical operation sequences). The comment at
   `:101-102` states plainly that this is an intentional *exact*-equality
   dedup with no geometric tolerance, so the correct Rust port is exact
   `f64` equality (or a `(u64, u64)` bit-pattern key from `to_bits()`), which
   is actually *more* obviously correct than string-based dedup and does not
   need to reproduce JS's stringification algorithm at all — but a literal
   line-by-line port that naively does `format!("{x}:{y}")` would introduce
   a real (if narrow) parity risk.
2. **`GeometryCacheInMemory` sharing depends on Effect's Layer-reference
   memoization, an implicit runtime behavior with no static-typing
   enforcement** (§9.3). This is not a hazard for the Rust port's own
   architecture (Rust has no equivalent implicit mechanism to accidentally
   rely on), but it *is* a hazard for anyone reading the TypeScript source
   to derive the cache-sharing contract: a naive reading of
   `nesting.worker.ts:390-399` (three separate references to
   `GeometryCacheInMemory`-derived layers) could easily be mis-scoped as
   "three separate caches" without the empirical verification this document
   performed (§9.3). The Rust port must deliberately choose one shared
   `Arc<GeometryCacheStore>`-equivalent per job and thread it through every
   consumer's construction explicitly — Rust has no implicit mechanism that
   will "accidentally" get this right the way Effect's memoization does.
3. **`IrregularGeometryCacheKey` (a `domain.ts` plain class) and
   `GeometryCacheKey` (a `core/geometryCacheStore.ts` plain interface) are
   two independently declared, structurally-identical
   `{namespace: string, parts: readonly string[]}` shapes**
   (`domain.ts:883-898`, `core/geometryCacheStore.ts:1-4`). TypeScript's
   structural typing lets an `IrregularGeometryCacheKey` instance satisfy a
   `GeometryCacheKey`-typed parameter (e.g. `cacheKeyToString`,
   `services.ts:415-417`) with zero conversion code, zero `impl` boilerplate,
   and no runtime marker distinguishing which nominal type a given object
   "really" is. A Rust port must either unify these into one type or write
   an explicit `From`/`Into` conversion — there is no free structural-typing
   equivalent.
4. **`InternalPoint`/`InternalBounds`/`InternalPolygon`/etc.
   (`internalGeometry.ts`) are satisfied by real trusted-carrier class
   instances purely structurally**, with no `impl InternalPoint for
   IrregularPoint` anywhere (TypeScript needs none — structural typing means
   any object with matching field names/types satisfies the interface).
   19 files (§1.1) pass `IrregularPoint`/`CollisionGeometry`/etc. instances
   directly into functions typed against the `Internal*` vocabulary, and the
   pure `core/*` layer's boundary test (`pureIrregularCoreBoundary.test.ts`,
   §3.1) *only* checks that `core/*.ts` doesn't import `effect`/`@shared/*`
   at the source-file level — it says nothing about, and cannot enforce,
   which concrete objects flow across that boundary at runtime. A Rust port
   replacing this with actual traits (`impl InternalPointLike for
   IrregularPoint`) or with one unified type is a legitimate simplification,
   but it must preserve exactly which fields participate (no more, no
   fewer) since the `core/*` functions only read the fields the interface
   declares.
5. **Redundant double-defaulting for `allowGlobalMirror`** (§2.3): the
   schema layer guarantees `NestingOptions.allowGlobalMirror` is always a
   concrete `boolean` after decode (constructor default *and* decoding
   default, both `true`, `nesting.ts:99-103`), yet
   `computeIrregularNesting.ts:406-407` re-applies `?? true` at the call
   site. Currently harmless (both layers agree on `true`), but it means the
   *effective* default is defined in two places that could silently diverge
   if either is edited independently without the other — a maintenance
   hazard worth flagging for the Rust port's design (pick one place to own
   the default, and note that the TS source currently has two).
6. **`generatePlacementCandidates`'s TypeScript overload-based conditional
   error channel** (§3.6, `services.ts:302-325`) has no runtime existence —
   it is a pure type-level narrowing that vanishes at compile time. Rust has
   no direct equivalent (no function overloading on an optional field's
   presence with a differently-typed `Result` error channel per overload).
   The N-API surface will need to choose one of: (a) always include
   `IrregularNfpIfpControlAbortError`'s Rust equivalent in the error enum
   (accepting it is simply never constructed when no control is supplied),
   or (b) two distinctly-named functions. Either is semantically fine since
   this distinction never affects runtime behavior — only the type checker
   sees it.
7. **`SheetSpec` crosses into "trusted, hot-path" territory as a real
   `Schema.Class`, not a plain carrier** (§2.3, last bullet). This
   contradicts a naive over-generalization of the
   "trusted-carriers-are-plain-classes" rule (§1.2) — the actual rule is
   about *construction frequency* (never reconstruct per-candidate), not
   about class kind per se. A Rust port that mechanically converts every
   type touched by the hot loop into a "plain" (non-validating) struct is
   over-applying the rule; `SheetSpec`'s validation-on-construction is fine
   in Rust too as long as construction still happens exactly once per job.
8. **Symbol-branded opaque identity class**
   (`IrregularNfpIfpCandidateMemoScope`, `services.ts:191-196`) uses a
   private `Symbol()`-typed field purely to make the class unforgeable by
   structural typing (so no plain `{}` object can accidentally satisfy its
   type, defeating structural typing exactly where nominal typing is
   wanted). Rust's module-private fields and the type system's inherent
   nominal typing make this pattern unnecessary — a plain opaque struct
   (even a zero-sized marker type or a `Uuid`) achieves the same "cannot be
   forged from outside this module" property with no special trick needed.
   Not a hazard, just a pattern that has no direct 1:1 translation need.

---

## 13. Parallelism assessment

### 13.1 Safe candidates (pure, independent, bounded by piece/candidate count)

- **`flattenSourceGeometry`, `convexHull`, `offsetConvexPolygon` across
  distinct prepared pieces.** Each is a pure function of `(piece, settings)`
  / `(points, settings)` / `(polygon, totalPaddingMm, settings)` with **no
  cache access** (§9.4) and no shared mutable state beyond its own local
  closures (§4). Per the migration prompt §14.1's explicit example
  ("independent collision-geometry preparation by stable piece index"),
  these are exactly the kind of per-piece work that can run under Rayon
  **provided** the surrounding `computeIrregularNesting.ts` loop (not this
  cluster's file, but the loop that calls into it) is restructured to
  collect results by stable piece index and reassemble
  `preparedPieces`/`diagnostics` in the original `sortedPieces` order
  afterward — not append-as-completed, since `diagnostics.push(...)`
  ordering (`computeIrregularNesting.ts:430`) and `preparedPieces.push(...)`
  ordering (`:415`) are currently strictly sequential and their resulting
  array order is part of this cluster's observable contract (feeds
  `IrregularPreparedPiece[]` order, which downstream priority-ordering and
  search code depends on).
- **`Seam B`'s two schema decodes** (`offsetConvexPolygon`/`generateTransforms`,
  §2.3) are themselves pure and side-effect-free (beyond the
  `IrregularGeometryInputError` they may raise) and can run in parallel
  across pieces for the same reason.

### 13.2 Must stay serial / needs explicit design

- **`transformCollisionGeometry`'s cache access** (§9.5) is the one place in
  this cluster where naive parallelization is unsafe. Its 10-step sequence
  (get → validate-the-hit → evict-if-stale → compute → materialize → set)
  is **not** currently thread-safe even in principle (it's single-threaded
  JS today, so the question has never arisen), and a Rust port running this
  per-candidate, per-quarter-turn operation under Rayon needs one of the
  single-flight or sharded-cache designs the migration prompt §13.3/§13.5
  requires — in particular, "invalid results never cached" (step 7, §9.5)
  and "a cache hit and a recomputation must return the same canonical
  immutable value" (validated by step 3's structural revalidation) must
  both survive concurrent access without becoming a race (e.g. two threads
  both missing the cache for the same key, both computing, and racing to
  publish — the migration prompt's §13.5 explicitly allows this *if*
  "duplicate results are exact" and "the winner of publication has no
  semantic effect," which is plausible here since `computeTransformedCollisionGeometry`
  is a pure deterministic function of its input — but this must be proven,
  not assumed, before enabling concurrent access to this cache namespace).
- **`GeometrySettings`/`GeometryCache` service construction itself** (the
  `Layer.build` graph, §9.3) must remain a one-time, job-scoped
  construction — this is inherently serial (or at least single-initialization)
  by nature and is not a parallelization target at all; it is infrastructure
  *setup*, evaluated once before any search work begins.
- **Nothing in this cluster touches a scheduler, an archive, a checkpoint,
  or a trace** (§10, §6) — the "high-risk boundaries" the migration prompt
  §14.2 warns about (archive admission races, checkpoint-by-completion-order,
  scheduler-trace chronology) simply do not apply to these five files; they
  are all owned by clusters higher up the call stack.

---

## 14. Tests and gates covering this cluster

Direct, file-targeted unit tests (all read in full or in relevant part):

- `tests/unit/irregularGeometryKernel.test.ts` (475 lines) — every one of
  `GeometryKernel`'s 5 operations, including: flattening-tolerance
  threading from `GeometrySettings` (`:135-159`); `.Unimplemented`
  independence from settings (`:161-174`); convex-hull canonical
  counter-clockwise output, order-independence, and near-collinear-corner
  retention (`:176-220`); offset-distance formula and its two failure modes
  (negative padding → `IrregularGeometryInputError` with the exact §2.3
  message; non-convex polygon → a different message) (`:222-311`);
  `transformCollisionGeometry`'s rotation/mirror/degenerate-geometry
  behavior (`:313-473`, mostly collision-prep.md's subject matter, but this
  is the test file that exercises this cluster's *wrapper* around it).
- `tests/unit/irregularGeometryCache.test.ts` (547 lines) — cross-service
  cache coherence (§9.3's `cache.store.set`/`service.computeNfp` interleaving
  with telemetry assertions on exact `getCalls`/`getPresent`/`setCalls`/`removeCalls`
  counts per namespace), the `Effect`-wrapped vs. `.store` API equivalence
  (§9.2), stale-value eviction (`:527-545`, matching §9.5 step 5), and
  relative-NFP sharing across canonically-equivalent copies (a different
  cluster's algorithm, exercised here because it is cache-observable).
- `tests/unit/irregularInfrastructure.test.ts` (14 lines) — the **sole**
  consumer of `infrastructure.ts` anywhere in the repository (§1.1); asserts
  only that `CollisionGeometryBuilder.use(...)` resolves under
  `IrregularNestingInfrastructureLive`. Does not, and cannot, prove anything
  about production behavior, since production never uses this layer.
- `tests/unit/irregularWorkerCompute.test.ts` — exercises
  `computeIrregularNesting` directly with a hand-composed layer graph
  omitting `GeometryKernel.Live`'s *explicit* provide (relying on
  `CollisionGeometryBuilder.Live`'s internal merge to satisfy the
  `GeometryKernel` requirement — confirming, by construction, that the merge
  pattern in §9.3 is load-bearing even in test code, not just production).
- `tests/unit/trustedGeometryCarrierBoundary.test.ts` (337 lines, §3.1) —
  the architecture-level enforcement of the plain-class/schema split.
- `tests/unit/pureIrregularCoreBoundary.test.ts` (128 lines, §3.1) — the
  architecture-level enforcement of the `core/*` Effect/`@shared`-free
  boundary.
- `tests/unit/geometryBackendParity.test.ts` — exercises
  `CollisionGeometryBuilder.Live`/`GeometrySettings.Live` together with
  `NfpIfpService` across real DXF fixtures; its `geometryCache` identifier
  is a **local test-only `Map`, unrelated to this cluster's `GeometryCache`
  service** — noted here only to correct a grep false-positive a less
  careful reading might produce.

Indirect coverage (this cluster's layers are provided by, but not the
primary subject of): `tests/unit/nfpIfpService.test.ts`,
`tests/unit/placementValidation.test.ts`,
`tests/unit/collisionGeometryBuilder.test.ts`,
`tests/unit/transformGenerator.test.ts`,
`tests/unit/freeMaterialService.test.ts`,
`tests/unit/placedCollisionSpatialIndex.test.ts`,
`tests/unit/irregularPortfolio.test.ts`,
`tests/unit/irregularBenchmark.test.ts`,
`tests/unit/irregularSeventeenShapesCompactGolden.test.ts`,
`tests/unit/irregularTriangleCompactGolden.test.ts`, and the large family of
`tests/unit/intrinsic*.test.ts` files (all of which run through
`computeIrregularNesting` and therefore this cluster's wiring, but assert on
outcomes owned by other clusters).

No `scripts/*.ts` gate targets this cluster specifically; the closest is
`scripts/profile-mixed61.mjs`/`scripts/irregular-benchmark.ts`, which
exercise the whole production path (including this cluster's layer
composition) for performance measurement, not correctness assertions.
`pnpm test` (`package.json:26`, via `ELECTRON_RUN_AS_NODE=1 electron
./node_modules/vitest/vitest.mjs run`) runs every test file listed above as
part of the full suite; there is no narrower "this cluster only" test
command.

---

## 15. Open questions and ambiguities

1. **No contradiction found between this cluster's behavior and the
   migration prompt's summary.** Section 2's list of things that must never
   change (prepared-piece order, canonical keys, etc.) and section 13's
   cache-architecture requirements are already satisfied by the *current*
   TypeScript implementation for everything this cluster owns (§9.3's
   "one cache per job" finding matches prompt §13.1 exactly, as
   already-implemented behavior). The one place this document diverges from
   a *plausible naive reading* of the source is §9.3 itself: reading
   `nesting.worker.ts:390-399` without empirical verification could lead an
   implementer to conclude there are three separate caches; there is
   exactly one. This is flagged prominently here and in §9.3/§12 point 2 so
   a Rust-port implementer does not have to re-derive it.
2. **`infrastructure.ts` and `index.ts` are both fully dead code on every
   production and even every non-`infrastructure.test.ts` code path.**
   Should the Rust port's differential/parity harness (Stage 1) bother
   exercising `infrastructure.ts`'s specific layer composition (which
   silently ignores request-supplied `irregularSettings`, §1.1) at all, or
   should this be flagged to the user as removable dead code in a follow-up
   TS cleanup (out of scope for a semantics-preserving port, but worth
   naming)? This document takes no position beyond recording the fact.
3. **The `GenerateTransformsInput`/`OffsetConvexPolygonInput` "belt-and-
   suspenders" schema decodes (§2.3, Seam B) currently can only fail on
   inputs that, by every invariant traceable through this codebase, cannot
   actually occur in production** (the offset-distance-non-finite case
   requires `totalPaddingMm` or `clearanceSafetyMarginMm` to be `NaN`/
   `Infinity`, both already excluded by `Schema.Finite` at Seam A; the
   non-convexity case requires `CollisionGeometryBuilder` to have produced
   a non-convex `collisionPolygon`, which its own upstream convex-hull step
   should prevent). Is there a known historical bug or fuzz-discovered edge
   case that motivated adding these checks (i.e., a case where they *did*
   fire in production), which would argue for treating them as more than a
   theoretical defense-in-depth layer in the Rust port's test corpus? This
   document could not find one by reading source and tests alone — the
   `errors-protocol.md`-cited 15 total construction sites for
   `IrregularGeometryInputError` suggest this pattern (schema/assertion
   re-validation of already-trusted data) is pervasive enough across the
   codebase that it may be worth a dedicated fuzz/differential test
   confirming these two specific call sites are truly unreachable in
   practice, before the Rust port decides how much engineering effort their
   equivalent deserves.
4. **No `knowledge/` directory exists in this checkout** (same absence
   `nfp-ifp.md`'s open question #1 already documents for its cluster; noted
   here too since the migration prompt's §5 directs readers to it
   generally, not per-cluster). This document, like its siblings, was built
   entirely from primary source and tests per the prompt's own fallback
   instruction.
5. **`SheetSpec` as a `Schema.Class` reused by reference throughout hot-path
   trusted computation (§2.3, §12 point 7) is not itself a hazard, but it
   does raise a design question for the Rust N-API surface**: should the
   Rust equivalent of `SheetSpec` be a validated newtype constructed once at
   the boundary and passed by `&`/`Arc` thereafter (mirroring the TS
   behavior exactly), or should it be normalized into the same
   "plain-carrier" category as `IrregularPoint`/`CollisionGeometry` for
   implementation-simplicity? Either preserves observable behavior as long
   as validation still happens exactly once per job; this document
   surfaces the question rather than answering it, since it is a Rust-side
   design choice, not a TS behavior to characterize.
